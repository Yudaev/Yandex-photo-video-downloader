import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { getDownloadFolder, setDownloadFolder, getDownloadResult, setDownloadResult, getUnfinishedDownloads, getSuccessfulDownloads, matchesDownloadStatus, type DownloadItem, type DownloadResult } from '../../lib/download-folder';
import { captureDownloadUrl } from '../../lib/capture-download';
import { canReuseDownload, saveDownload } from '../../lib/save-download';
import { prepareDownloadMetadata, dateInstructions } from '../../lib/download-metadata';
import { diagnosticError, createDiagnosticsFile } from '../../lib/download-diagnostics';
import './style.css';

declare global {
  interface Window {
    showDirectoryPicker(options: {
      id: string;
      mode: 'readwrite';
      startIn: FileSystemDirectoryHandle | 'downloads';
    }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemDirectoryHandle {
    requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  }
}

function FolderPicker() {
  const [folder, setFolder] = useState<FileSystemDirectoryHandle>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [photos, setPhotos] = useState(true);
  const [videos, setVideos] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [os, setOs] = useState('');
  const [datesReady, setDatesReady] = useState(false);
  const [logStatus, setLogStatus] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const instructions = dateInstructions(os);
  const [counts, setCounts] = useState({ saved: 0, failed: 0, skipped: 0 });
  const active = useRef<{ tabId: number; controller: AbortController } | undefined>(undefined);
  const starting = useRef(false);

  useEffect(() => {
    Promise.all([
      browser.runtime.getPlatformInfo().then(platform => setOs(platform.os)),
      getDownloadFolder().then(setFolder),
      navigator.locks.request('yandex-photo-download', { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        const interrupted = await getUnfinishedDownloads();
        for (const result of interrupted) await setDownloadResult({ ...result, status: 'error', error: 'Предыдущее скачивание было прервано. Запустите повторно.' });
        if (interrupted.length) await browser.storage.local.set({ downloadRevision: crypto.randomUUID() });
      }),
    ])
      .catch(() => setStatus('Не удалось прочитать сохранённую папку.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const stop = () => {
      active.current?.controller.abort();
      if (active.current) void browser.tabs.sendMessage(active.current.tabId, { type: 'photo-traversal', action: 'stop' }).catch(() => {});
    };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, []);

  function stopDownload() {
    active.current?.controller.abort();
    if (active.current) void browser.tabs.sendMessage(active.current.tabId, { type: 'photo-traversal', action: 'stop' }).catch(() => {});
    setStatus('Останавливаю скачивание…');
  }

  async function exportDiagnostics() {
    try {
      const log = await browser.runtime.sendMessage({ type: 'download-diagnostics', action: 'get' });
      if (log?.error) throw new Error(log.error);
      if (!log || log.format !== 'yandex-download-diagnostics') throw new Error('Фон расширения не ответил. Перезагрузите расширение и обновите вкладку Яндекса.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(log ?? { failures: [], note: 'Скачивание ещё не запускалось.' }, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `yandex-download-debug-${new Date().toISOString().replaceAll(':', '-')}.json`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setLogStatus('Журнал сохранён. Он содержит имена файлов, но не cookies и подписанные ссылки.');
    } catch (error) { setLogStatus(`Не удалось сохранить журнал: ${diagnosticError(error)}`); }
  }

  async function startDownload(mode: 'error' | 'new') {
    if (!folder || starting.current || (!photos && !videos)) return;
    starting.current = true;
    setRunning(true);
    setStatus('');
    setDatesReady(false);
    setCopyStatus('');
    const totals = { saved: 0, failed: 0, skipped: 0 };
    setCounts({ ...totals });
    let tabId: number | undefined;
    const controller = new AbortController();
    const runId = crypto.randomUUID();
    const logFile = createDiagnosticsFile(folder, runId);
    let hasFailures = false;
    let currentName: string | undefined;
    let trace: unknown[] | undefined;
    let reportedError: unknown;
    async function diagnostic(action: string, fields: Record<string, unknown> = {}) {
      try {
        const result = await browser.runtime.sendMessage({ type: 'download-diagnostics', action, runId, tabId, name: currentName, ...fields });
        if (result?.error) throw new Error(result.error);
        if (!result?.ok) throw new Error('Фон расширения не ответил. Перезагрузите расширение и обновите вкладку Яндекса.');
        return true;
      } catch (error) { setLogStatus(`Журнал не записан: ${diagnosticError(error)}`); return false; }
    }
    const phase = (name: string) => diagnostic('phase', { phase: name });
    async function saveLogFile() {
      try {
        const log = await browser.runtime.sendMessage({ type: 'download-diagnostics', action: 'get' });
        if (log?.error) throw new Error(log.error);
        await logFile.save(log);
        setLogStatus(`Журнал автоматически сохранён в выбранной папке: ${logFile.name}`);
      } catch (error) { setLogStatus(`Не удалось записать журнал в папку. Он остаётся в расширении: ${diagnosticError(error)}`); }
    }
    async function failure(error: unknown) {
      if (reportedError === error) return;
      reportedError = error;
      let details: unknown;
      if (tabId !== undefined) {
        details = await browser.tabs.sendMessage(tabId, { type: 'photo-traversal', action: 'diagnose' }).catch(() => ({ unavailable: true }));
      }
      if (await diagnostic('failure', { error: diagnosticError(error), details: { view: details, counts: { ...totals }, online: navigator.onLine }, trace })) {
        hasFailures = true;
        await saveLogFile();
      }
    }
    try {
      // Request directly from the button gesture, before other awaits.
      if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет разрешения на запись в выбранную папку.');
      await navigator.locks.request('yandex-photo-download', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('Скачивание уже запущено в другом окне Chrome.');
        try {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
          if (tab?.id === undefined || !/^https:\/\/disk\.yandex\.ru\/client\/photo\/?(?:[?#]|$)/.test(tab.url ?? '')) {
            throw new Error('Откройте раздел «Фото» Яндекс Диска в этой вкладке.');
          }
          tabId = tab.id;
          active.current = { tabId, controller };
          async function next(action: 'start' | 'next' | 'open', key?: string): Promise<DownloadItem | null> {
            controller.signal.throwIfAborted();
            const result = await browser.tabs.sendMessage(tabId!, { type: 'photo-traversal', action, key, photos, videos });
            if (result?.error) throw new Error(result.error);
            if (!result || !('item' in result)) throw new Error('Обновите страницу Яндекс Диска после установки расширения.');
            return result.item;
          }
          async function remember(result: DownloadResult) {
            await setDownloadResult(result);
            await browser.storage.local.set({ downloadRevision: crypto.randomUUID() });
          }
          await phase('metadata-prepare');
          setProgress('Подготавливаю JSON и команду для дат…');
          const metadata = await prepareDownloadMetadata(folder, os, await getSuccessfulDownloads());
          setDatesReady(true);
          await phase('traversal-start');
          let item = await next('start');
          while (item) {
            controller.signal.throwIfAborted();
            currentName = item.name; trace = undefined;
            await phase('local-file-check');
            setProgress(item.name);
            if ((item.type === 'photo' && photos) || (item.type === 'video' && videos)) {
              let previous = await getDownloadResult(item.key);
              if (!matchesDownloadStatus(previous?.status ?? metadata.find(item.key)?.status, mode)) {
                await phase('traversal-next');
                item = await next('next');
                continue;
              }
              let recoveredFromJson = false;
              let alreadySaved = await canReuseDownload(folder, { ...previous, ...item, id: item.id || previous?.id || '', created: item.created ?? previous?.created, modified: item.modified ?? previous?.modified }, previous);
              if (!alreadySaved) {
                const exported = metadata.find(item.key);
                if (await canReuseDownload(folder, { ...exported, ...item, id: item.id || exported?.id || '', created: item.created ?? exported?.created, modified: item.modified ?? exported?.modified }, exported)) { previous = exported; alreadySaved = true; recoveredFromJson = true; }
              }
              if (alreadySaved) {
                if (!metadata.find(item.key)) await metadata.remember(previous!);
                if (recoveredFromJson) {
                  await remember(metadata.find(item.key)!);
                }
                totals.skipped++;
              }
              else {
                await remember({ ...item, status: 'saving', folder });
                let successful: DownloadResult | undefined;
                try {
                  await phase('viewer-info');
                  const opened = item.id ? item : await next('open', item.key);
                  if (!opened) throw new Error('Не удалось открыть файл.');
                  item = opened;
                  await remember({ ...item, status: 'saving', folder });
                  if (item.error) throw new Error(item.error);
                  setProgress(`${item.name} — получение адреса оригинала…`);
                  await phase('capture-original-url');
                  const injected = await browser.scripting.executeScript({
                    target: { tabId }, world: 'MAIN', func: captureDownloadUrl, args: [item.id, item.name],
                  });
                  const capture = injected[0]?.result;
                  trace = capture?.trace;
                  if (capture?.error) throw new Error(capture.error);
                  const url = capture?.url;
                  if (typeof url !== 'string') throw new Error('Не удалось получить оригинал кнопкой Яндекса.');
                  let lastProgress = 0;
                  const name = item.name;
                  setProgress(`${name} — ожидание данных Яндекса (до 30 секунд)…`);
                  await phase('transfer-and-save');
                  const saved = await saveDownload(folder, name, url, controller.signal, fetch, (bytes, total) => {
                    if (Date.now() - lastProgress < 250) return;
                    lastProgress = Date.now();
                    setProgress(`${name} — ${(bytes / 1048576).toFixed(1)} МБ${total ? ` из ${(total / 1048576).toFixed(1)} МБ` : ''}`);
                  }, event => {
                    (trace ??= []).push(event);
                    if (event.event === 'api-retry') setProgress(`${name} — повторная попытка по ссылке digest…`);
                  }, capture?.alternateUrl);
                  const recovered = trace?.find(event => (event as { event?: string }).event === 'api-retry-succeeded') as { initialStatus?: number } | undefined;
                  if (recovered) await failure(new Error(`HTTP ${recovered.initialStatus}: файл сохранён повторной попыткой по digest.`));
                  setProgress(`${name} — сохранён, обновляю историю и JSON…`);
                  await phase('history-save');
                  successful = { ...item, ...saved, status: 'success', folder };
                  await remember(successful);
                  if (saved.reused) totals.skipped++;
                  else totals.saved++;
                } catch (error) {
                  if (!controller.signal.aborted) await failure(error);
                  const message = controller.signal.aborted ? 'Скачивание остановлено.' : error instanceof Error ? error.message : 'Не удалось сохранить файл.';
                  await remember({ ...item, status: 'error', folder, error: message });
                  totals.failed++;
                  setCounts({ ...totals });
                  if (controller.signal.aborted || !navigator.onLine || /HTTP (429|401|403)|Обновите страницу перед повторным/.test(message)
                    || (error instanceof DOMException && ['NotAllowedError', 'SecurityError', 'QuotaExceededError', 'UnknownError'].includes(error.name))) throw error;
                  setStatus(`Не сохранён ${item.name}: ${message}`);
                }
                if (successful) {
                  try { await phase('metadata-save'); await metadata.remember(successful); }
                  catch (error) {
                    setDatesReady(false);
                    throw new Error(`Файл сохранён, но JSON не обновлён: ${error instanceof Error ? error.message : 'ошибка записи'}. Повторный запуск восстановит JSON без повторного скачивания.`);
                  }
                  await remember(metadata.find(item.key)!);
                }
              }
            }
            setCounts({ ...totals });
            await phase('traversal-next');
            item = await next('next');
          }
          setStatus(totals.failed ? 'Фотолента обработана. Неудачные файлы отмечены крестиком; нажмите «Повторить файлы с ошибкой».' : 'Фотолента обработана. Загрузка выбранных файлов завершена.');
        } finally {
          if (tabId !== undefined) await browser.tabs.sendMessage(tabId, { type: 'photo-traversal', action: 'stop' }).catch(() => {});
        }
      });
    } catch (error) {
      if (!controller.signal.aborted) await failure(error);
      setStatus(controller.signal.aborted ? 'Скачивание остановлено. Сохранённые результаты запомнены.'
        : error instanceof Error ? error.message : 'Не удалось начать скачивание.');
    } finally {
      await diagnostic('end');
      if (hasFailures) await saveLogFile();
      active.current = undefined;
      starting.current = false;
      setRunning(false);
      setProgress('');
    }
  }

  async function chooseFolder() {
    setBusy(true);
    setStatus('');
    try {
      const selected = await window.showDirectoryPicker({
        id: 'yandex-download-folder', mode: 'readwrite', startIn: folder ?? 'downloads',
      });
      await setDownloadFolder(selected);
      setFolder(selected);
      setDatesReady(false);
      setCopyStatus('');
      await browser.storage.local.set({ downloadFolderName: selected.name });
      setStatus('Папка сохранена.');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setStatus('Не удалось выбрать или сохранить папку. Попробуйте ещё раз.');
        console.error('Ошибка выбора папки:', error);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header><img src="/icon-48.png" alt="" /><h1>Скачать все видео и фото</h1></header>
      <p>Для скачивания используется текущий вход в открытой вкладке Яндекс Диска.</p>
      <h2>Настройки</h2>
      <label htmlFor="folder">Выбранная папка</label>
      <input id="folder" value={folder?.name ?? ''} placeholder="Не выбрана" readOnly />
      <button type="button" disabled={busy || loading || running} onClick={chooseFolder}>Выбрать папку…</button>
      <p role="status">{status}</p>
      <p className="hint">После перезапуска Chrome может запросить разрешение на запись повторно.</p>
      <fieldset disabled={running}>
        <legend>Что скачать</legend>
        <label><input type="checkbox" checked={photos} onChange={event => setPhotos(event.target.checked)} /> Фото</label>
        <label><input type="checkbox" checked={videos} onChange={event => setVideos(event.target.checked)} /> Видео</label>
      </fieldset>
      <h2>Загрузка</h2>
      <p>Сохранено: {counts.saved}. Ошибок: {counts.failed}. Уже в папке: {counts.skipped}.</p>
      <p className="progress" aria-live="polite">{progress}</p>
      {running ? <button type="button" onClick={stopDownload}>Остановить скачивание</button>
        : <div className="download-actions">
          <button type="button" disabled={!folder || busy || loading || (!photos && !videos)} onClick={() => startDownload('error')}>Повторить файлы с ошибкой</button>
          <button type="button" disabled={!folder || busy || loading || (!photos && !videos)} onClick={() => startDownload('new')}>Скачать файлы без статуса</button>
        </div>}
      <p className="hint">Во время скачивания оставьте вкладку и панель открытыми. Закрытие панели останавливает загрузку. Существующие файлы не перезаписываются.</p>
      <p className="hint">«Повторить файлы с ошибкой» скачивает только файлы с крестиком. «Скачать файлы без статуса» скачивает только файлы без результата в истории или JSON. Успешные файлы пропускаются в обоих режимах, даже при смене папки. Прерванные загрузки после открытия панели считаются ошибками.</p>
      <p className="hint">Имя и даты Яндекса сохраняются в истории и в yandex-downloads.json рядом с файлами. Время Яндекса трактуется в часовом поясе браузера; JSON также хранит даты в UTC.</p>
      <section aria-label="Диагностика">
        <h2>Диагностика</h2>
        <button type="button" onClick={exportDiagnostics}>Сохранить журнал ошибок</button>
        <p className="hint">Последние 50 ошибок: этап, файл, состояние ленты и до 120 связанных сетевых событий. Журнал сохраняется в расширении и автоматически в выбранной папке при ошибке; cookies и подписанные ссылки исключены.</p>
        <p role="status">{logStatus}</p>
      </section>
      {datesReady && !running && <section aria-label="Применение дат">
        <h2>Применить даты файлов</h2>
        {instructions ? <>
          <p>Система: {instructions.label}. Чтобы применить даты, откройте терминал в выбранной папке «{folder?.name}» и выполните команду:</p>
          <pre><code>{instructions.command}</code></pre>
          <button type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(instructions.command); setCopyStatus('Команда скопирована.'); }
            catch { setCopyStatus('Не удалось скопировать. Выделите команду вручную.'); }
          }}>Скопировать команду</button>
          <p role="status">{copyStatus}</p>
          <p className="hint">{instructions.hint}</p>
          <p className="hint">Запускайте команду после остановки скачивания. Обрабатываются только файлы из JSON с совпадающим размером; остальные файлы в папке не меняются.</p>
        </> : <p>Эта ОС пока не поддерживается командой. Исходные даты сохранены в JSON.</p>}
      </section>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<FolderPicker />);
