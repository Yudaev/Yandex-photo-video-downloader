export interface SavedFile {
  savedName: string;
  bytes: number;
  localModified: number;
  reused?: boolean;
}

export async function canReuseDownload(folder: FileSystemDirectoryHandle, item: DownloadItem, previous?: DownloadResult): Promise<boolean> {
  if (item.error || previous?.status !== 'success' || !previous.savedName || previous.key !== item.key || previous.id !== item.id || previous.name !== item.name || previous.account !== item.account || previous.type !== item.type
    || previous.created !== item.created || previous.modified !== item.modified || !await folder.isSameEntry(previous.folder)) return false;
  const existing = await folder.getFileHandle(previous.savedName).then(handle => handle.getFile()).catch(error => {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  });
  return existing !== undefined && existing.size === previous.bytes && (existing.lastModified === previous.localModified || existing.lastModified === (previous.modifiedAt ? Date.parse(previous.modifiedAt) : parseYandexDate(previous.modified)));
}

export async function saveDownload(
  folder: FileSystemDirectoryHandle, name: string, url: string, signal: AbortSignal,
  fetchFile: typeof fetch = fetch,
  onProgress: (bytes: number, total?: number) => void = () => {},
  onDiagnostic: (event: Record<string, unknown>) => void = () => {},
  alternateUrl?: string,
): Promise<SavedFile> {
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) throw new Error('Недопустимое имя файла.');
  const source = new URL(url);
  if (source.protocol !== 'https:' || source.hostname !== 'downloader.disk.yandex.ru' || !source.pathname.startsWith('/disk/') || source.username || source.password) {
    throw new Error('Неизвестный адрес оригинала.');
  }
  signal.throwIfAborted();
  const request = new AbortController();
  const transferSignal = AbortSignal.any([signal, request.signal]);
  async function waitForData<T>(operation: () => Promise<T>): Promise<T> {
    transferSignal.throwIfAborted();
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(transferSignal.reason);
      transferSignal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => request.abort(new Error('Яндекс не передаёт данные 30 секунд.')), 30_000);
    try { return await Promise.race([operation(), cancelled]); }
    finally { clearTimeout(timer); transferSignal.removeEventListener('abort', onAbort); }
  }
  let savedName = name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let handle: FileSystemFileHandle | undefined;
  let writer: FileSystemWritableFileStream | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  try {
    const response = await waitForData(() => fetchFile(url, { signal: transferSignal, credentials: 'omit' }));
    if (response.url) {
      const final = new URL(response.url);
      if (final.protocol !== 'https:' || (final.hostname !== 'downloader.disk.yandex.ru' && !final.hostname.endsWith('.storage.yandex.net'))) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Оригинал перенаправлен на неизвестный сервер.');
      }
    }
    if (!response.ok || !response.body || /(?:text\/|json|xml)/i.test(response.headers.get('content-type') ?? '')) {
      let body = '';
      let bodyError: string | undefined;
      if (response.body && /(?:text\/|json|xml)/i.test(response.headers.get('content-type') ?? '')) {
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          while (body.length < 2048) {
            const chunk = await waitForData(() => reader!.read());
            if (chunk.done) break;
            body += decoder.decode(chunk.value.subarray(0, 2048), { stream: true });
          }
        } catch { bodyError = 'Не удалось прочитать текст ошибки.'; }
        finally { void reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined; }
      } else void response.body?.cancel().catch(() => {});
      const responseDetails = {
        event: 'original-response-error', status: response.status, credentials: 'omit',
        host: response.url ? new URL(response.url).hostname : source.hostname,
        contentType: response.headers.get('content-type'),
        body: body.replace(/(?:https?:)?\/\/[^\s"'<>]+/g, '[redacted URL]')
          .replace(/((?:token|tknv|uid|owner_uid|authorization|cookie|signature|hash|secret|key)\s*["']?\s*[:=]\s*["']?)[^\s,"';<>]+/gi, '$1[redacted]').replace(/[A-Za-z0-9_%=-]{32,}/g, '[redacted value]').slice(0, 2048),
        ...(bodyError ? { bodyError } : {}),
      };
      onDiagnostic(responseDetails);
      throw Object.assign(new Error(`Яндекс не вернул оригинал (HTTP ${response.status}).`), { responseDetails });
    }
    const encoding = response.headers.get('content-encoding');
    const length = encoding && encoding.toLowerCase() !== 'identity' ? null : response.headers.get('content-length');
    const total = length === null ? undefined : Number(length);
    const existing = await folder.getFileHandle(name).then(file => file.getFile()).catch(error => {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
      throw error;
    });
    let matchesExisting = existing !== undefined && (total === undefined || existing.size === total);
    reader = response.body.getReader();
    for (let suffix = 2; ; suffix++) {
      transferSignal.throwIfAborted();
      try { await folder.getFileHandle(savedName); }
      catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        break;
      }
      savedName = `${stem} (${suffix})${extension}`;
    }
    handle = await folder.getFileHandle(savedName, { create: true });
    writer = await handle.createWritable();
    let bytes = 0;
    while (true) {
      transferSignal.throwIfAborted();
      const chunk = await waitForData(() => reader!.read());
      if (chunk.done) break;
      if (matchesExisting) {
        const local = new Uint8Array(await existing!.slice(bytes, bytes + chunk.value.byteLength).arrayBuffer());
        matchesExisting = local.length === chunk.value.byteLength && local.every((value, index) => value === chunk.value[index]);
      }
      await writer.write(chunk.value);
      bytes += chunk.value.byteLength;
      onProgress(bytes, total);
    }
    transferSignal.throwIfAborted();
    if (bytes === 0 || (total !== undefined && bytes !== total)) throw new Error('Оригинал получен не полностью.');
    await writer.close();
    writer = undefined;
    const file = await handle.getFile();
    if (file.size !== bytes) throw new Error('Размер сохранённого файла не совпадает с оригиналом.');
    if (matchesExisting && existing!.size === bytes) {
      const current = await (await folder.getFileHandle(name)).getFile();
      if (current.size === existing!.size && current.lastModified === existing!.lastModified) {
        await folder.removeEntry(savedName);
        return { savedName: name, bytes, localModified: current.lastModified, reused: true };
      }
    }
    return { savedName, bytes, localModified: file.lastModified };
  } catch (error) {
    await writer?.abort().catch(() => {});
    if (handle) {
      const file = await handle.getFile().catch(() => undefined);
      if (file?.size === 0) await folder.removeEntry(savedName).catch(() => {});
    }
    const status = (error as { responseDetails?: { status?: number } }).responseDetails?.status;
    if (!signal.aborted && alternateUrl && alternateUrl !== url && status && status >= 500) {
      onDiagnostic({ event: 'api-retry', field: 'digest', reason: `HTTP ${status}` });
      const saved = await saveDownload(folder, name, alternateUrl, signal, fetchFile, onProgress, onDiagnostic);
      onDiagnostic({ event: 'api-retry-succeeded', field: 'digest', initialStatus: status });
      return saved;
    }
    throw error;
  } finally {
    request.abort();
    // A stalled server must not block the next file while cancellation completes.
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
import type { DownloadItem, DownloadResult } from './download-folder';


export function parseYandexDate(value?: string): number {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? '');
  if (!match) return NaN;
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] ?? 0);
  const date = new Date(year, month - 1, day, hour, minute, Number(second));
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== Number(second)) return NaN;
  return date.getTime();
}
