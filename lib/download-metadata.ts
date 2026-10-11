import type { DownloadResult } from './download-folder';
import { parseYandexDate, canReuseDownload } from './save-download';
import windowsScript from './date-scripts/apply-dates.ps1?raw';
import macScript from './date-scripts/apply-dates.js?raw';

export const metadataName = 'yandex-downloads.json';
const format = 'yandex-photo-video-downloader';
type MetadataFile = Omit<DownloadResult, 'folder' | 'status' | 'error'> & { savedName: string; bytes: number; localModified: number; createdAt: string; modifiedAt: string };

export function dateInstructions(os: string) {
  if (os === 'win') return { name: 'yandex-apply-dates.ps1', script: '\ufeff' + windowsScript, label: 'Windows', command: 'powershell.exe -NoProfile -File .\\yandex-apply-dates.ps1', hint: 'Применяются даты создания и изменения. Если политика PowerShell запрещает запуск, команда сообщит об этом; настройки безопасности не изменяются.' };
  if (os === 'mac') return { name: 'yandex-apply-dates.js', script: macScript, label: 'macOS', command: 'osascript -l JavaScript ./yandex-apply-dates.js "$PWD/yandex-downloads.json"', hint: 'Применяются даты создания и изменения, если файловая система их поддерживает.' };
  if (os === 'linux') return { name: 'yandex-apply-dates.sh', script: '', label: 'Linux', command: 'sh ./yandex-apply-dates.sh', hint: 'Используются системные команды touch и stat. Применяется только дата изменения; дату создания обычными средствами Linux установить нельзя.' };
  return undefined;
}

async function readText(folder: FileSystemDirectoryHandle, name: string): Promise<string | undefined> {
  try { return await (await folder.getFileHandle(name)).getFile().then(file => file.text()); }
  catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return undefined; throw error; }
}

function validFile(file: MetadataFile): boolean {
  return typeof file?.key === 'string' && typeof file.account === 'string' && typeof file.id === 'string'
    && typeof file.name === 'string' && (file.type === 'photo' || file.type === 'video')
    && typeof file.savedName === 'string' && !!file.savedName && !/[\\/\x00-\x1f]/.test(file.savedName) && !['.', '..', metadataName, 'yandex-apply-dates.sh', 'yandex-apply-dates.ps1', 'yandex-apply-dates.js'].includes(file.savedName)
    && Number.isSafeInteger(file.bytes) && file.bytes > 0 && Number.isFinite(file.localModified)
    && typeof file.created === 'string' && typeof file.modified === 'string'
    && typeof file.createdAt === 'string' && typeof file.modifiedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(file.createdAt) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(file.modifiedAt)
    && Number.isFinite(Date.parse(file.createdAt)) && Number.isFinite(Date.parse(file.modifiedAt));
}

export async function prepareDownloadMetadata(folder: FileSystemDirectoryHandle, os: string, history: DownloadResult[]) {
  let previousText = await readText(folder, metadataName);
  const files = new Map<string, MetadataFile>();
  if (previousText !== undefined) {
    let data;
    try { data = JSON.parse(previousText); } catch { throw new Error(`${metadataName} повреждён. Сохраните его копию и выберите другую папку.`); }
    if (data?.format !== format || data.version !== 1 || !Array.isArray(data.files) || !data.files.every(validFile)) {
      throw new Error(`${metadataName} имеет неизвестный формат. Чужой файл не будет перезаписан.`);
    }
    for (const file of data.files as MetadataFile[]) files.set(file.key, file);
  }
  function add(result: DownloadResult) {
    if (result.status !== 'success' || !result.savedName || !result.bytes || result.localModified === undefined) return;
    const old = files.get(result.key);
    const sameDates = old?.created === result.created && old?.modified === result.modified;
    const createdAt = result.createdAt ?? (sameDates ? old?.createdAt : undefined) ?? new Date(parseYandexDate(result.created)).toISOString();
    const modifiedAt = result.modifiedAt ?? (sameDates ? old?.modifiedAt : undefined) ?? new Date(parseYandexDate(result.modified)).toISOString();
    const entry = { key: result.key, account: result.account, id: result.id, name: result.name, type: result.type,
      created: result.created, modified: result.modified, sizeLabel: result.sizeLabel,
      savedName: result.savedName, bytes: result.bytes, localModified: result.localModified, createdAt, modifiedAt };
    if (!validFile(entry)) throw new Error('Не удалось подготовить даты сохранённого файла.');
    files.set(result.key, entry);
  }
  for (const result of history) if (await canReuseDownload(folder, result, result)) add(result);
  const instructions = dateInstructions(os);
  async function write(name: string, text: string) {
    const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
    try { await writer.write(text); await writer.close(); }
    catch (error) { await writer.abort().catch(() => {}); throw error; }
  }
  const scriptHeader = '#!/bin/sh\n# Generated by Yandex Photo & Video Downloader.\n';
  if (instructions) {
    const oldScript = await readText(folder, instructions.name);
    if (oldScript !== undefined && (os === 'linux' ? !oldScript.startsWith(scriptHeader) : oldScript !== instructions.script)) throw new Error(`${instructions.name} уже существует и отличается. Чужой файл не будет перезаписан.`);
    if (os !== 'linux' && oldScript === undefined) await write(instructions.name, instructions.script);
  }
  async function flush() {
    if (await readText(folder, metadataName) !== previousText) throw new Error(`${metadataName} изменён другой программой. Скачивание остановлено, чтобы не потерять данные.`);
    const text = JSON.stringify({ format, version: 1, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, files: [...files.values()] }, null, 2) + '\n';
    await write(metadataName, text);
    previousText = text;
    if (os === 'linux') await write('yandex-apply-dates.sh', linuxDateScript([...files.values()]));
  }
  await flush();
  return {
    instructions,
    find(key: string): DownloadResult | undefined {
      const file = files.get(key);
      return file && { ...file, status: 'success', folder };
    },
    async remember(result: DownloadResult) { add(result); await flush(); },
  };
}

export function linuxDateScript(files: Pick<MetadataFile, 'savedName' | 'bytes' | 'modifiedAt'>[]) {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const commands = files.map(file => {
    if (!file.savedName || /[\\/\x00-\x1f]/.test(file.savedName) || ['.', '..'].includes(file.savedName)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !Number.isFinite(Date.parse(file.modifiedAt))) throw new Error('Недопустимая запись для команды дат.');
    const seconds = Date.parse(file.modifiedAt) / 1000;
    return `file=${quote(file.savedName)}
if [ -f "$file" ] && [ ! -L "$file" ] && [ "$(stat -c %s -- "$file")" = ${quote(String(file.bytes))} ]; then
  if touch -c -m -d ${quote('@' + seconds)} -- "$file" && [ "$(stat -c %Y -- "$file")" = ${quote(String(Math.floor(seconds)))} ]; then
    printf '%s\\n' "OK: $file"
  else
    printf '%s\\n' "ERROR: $file: cannot apply date" >&2
    failed=1
  fi
else
  printf '%s\\n' "ERROR: $file: missing, changed or not a regular file" >&2
  failed=1
fi`;
  }).join('\n');
  return `#!/bin/sh
# Generated by Yandex Photo & Video Downloader.
CDPATH= cd -- "$(dirname -- "$0")" || exit 1
failed=0
${commands}
printf '%s\\n' 'Only modification dates were applied. Linux creation dates are unchanged.'
exit "$failed"
`;
}
