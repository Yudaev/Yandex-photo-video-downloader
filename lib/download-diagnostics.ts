export function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value, 'https://disk.yandex.ru');
    const path = url.pathname === '/models-v2' ? '/models-v2'
      : url.pathname.startsWith('/preview/') ? '/preview/[redacted]'
      : url.hostname === 'disk.yandex.ru' && /^\/client\/photo\/?$/.test(url.pathname) ? '/client/photo'
      : '/[redacted]';
    const safe = new URL(url.origin + path);
    for (const name of ['m', 'filename', 'fsize', 'content_type', 'media_type', 'disposition']) {
      const field = url.searchParams.get(name);
      if (field) safe.searchParams.set(name, field.slice(0, 256));
    }
    return safe.href;
  } catch { return '[invalid URL]'; }
}

export function diagnosticError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/https?:\/\/[^\s"'<>]+/g, diagnosticUrl).slice(0, 2000);
}

export function createDiagnosticsFile(folder: FileSystemDirectoryHandle, runId: string) {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(runId)) throw new Error('Некорректный идентификатор журнала.');
  const name = `yandex-download-errors-${runId}.json`;
  let previousText: string | undefined;
  return {
    name,
    async save(log: unknown) {
      if (!log || typeof log !== 'object' || !('format' in log) || log.format !== 'yandex-download-diagnostics') {
        throw new Error('Фон расширения не вернул журнал.');
      }
      let handle: FileSystemFileHandle;
      try {
        handle = await folder.getFileHandle(name);
        if (previousText === undefined || await (await handle.getFile()).text() !== previousText) {
          throw new Error(`${name} уже существует или изменён другой программой. Он не будет перезаписан.`);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        handle = await folder.getFileHandle(name, { create: true });
        previousText = '';
      }
      const text = JSON.stringify({ ...log, runId }, null, 2) + '\n';
      const writer = await handle.createWritable();
      try { await writer.write(text); await writer.close(); previousText = text; }
      catch (error) { await writer.abort().catch(() => {}); throw error; }
    },
  };
}
