import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { syncPhotoButton } from '../lib/photo-button';
import { createPhotoTraversal, readPhotoTiles, showDownloadMark } from '../lib/photo-viewer';

export default defineContentScript({
  matches: ['https://disk.yandex.ru/client/*'],
  main(ctx) {
    let scheduled = false;
    let readingMarks = false;
    let revision = 0;
    const marks = new Map<string, { status?: 'saving' | 'success' | 'error'; text: string }>();
    const traversal = createPhotoTraversal(document, window);
    const handleMessage = (message: { type?: string; action?: string; key?: string; photos?: boolean; videos?: boolean; account?: string; visited?: string[] }, sender: { id?: string }, sendResponse: (value: unknown) => void) => {
      if (sender.id !== browser.runtime.id || message?.type !== 'photo-traversal') return;
      if (message.action === 'diagnose') { sendResponse(traversal.diagnose()); return; }
      if (message.action === 'stop') { traversal.stop(); sendResponse({ ok: true }); return; }
      if (message.action === 'start' && ((message.account !== undefined && !/^\d+$/.test(message.account))
        || (message.visited !== undefined && (!Array.isArray(message.visited) || !message.visited.every(key => typeof key === 'string' && key.length < 4096))))) {
        sendResponse({ error: 'Некорректное состояние восстановления фотоленты.' }); return;
      }
      const operation = message.action === 'start'
        ? () => traversal.start({ photos: message.photos !== false, videos: message.videos !== false, account: message.account, visited: message.visited })
        : message.action === 'next' ? traversal.next
        : message.action === 'open' && typeof message.key === 'string' ? () => traversal.open(message.key!) : undefined;
      if (!operation) return;
      operation().then(item => sendResponse({ item }), error => sendResponse({ error: error instanceof Error ? error.message : 'Ошибка фотоленты.' }));
      return true;
    };
    browser.runtime.onMessage.addListener(handleMessage);
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'downloadRevision' in changes) { revision++; marks.clear(); sync(); }
    };
    browser.storage.onChanged.addListener(changed);
    async function syncMarks() {
      if (ctx.isInvalid || !/^\/client\/photo\/?$/.test(location.pathname)) return;
      const tiles = readPhotoTiles(document);
      for (const tile of tiles) {
        const mark = marks.get(tile.key);
        if (mark?.status) showDownloadMark(tile.element, mark.status, mark.text);
        else tile.element.querySelector('[data-ypvd-mark]')?.remove();
      }
      const keys = [...new Set(tiles.filter(tile => tile.key && !marks.has(tile.key)).map(tile => tile.key))].slice(0, 500);
      if (!keys.length || readingMarks) return;
      readingMarks = true;
      const currentRevision = revision;
      try {
        const response = await browser.runtime.sendMessage({ type: 'get-download-marks', keys });
        if (response?.error) throw new Error(response.error);
        if (currentRevision === revision) {
          for (const mark of response?.marks ?? []) marks.set(mark.key, mark);
          sync();
        }
      } catch (error) { console.error('Не удалось показать историю скачивания:', error); }
      finally { readingMarks = false; if (currentRevision !== revision) sync(); }
    }
    const openPanel = async () => {
      const response = await browser.runtime.sendMessage('open-download-panel');
      if (!response?.ok) throw new Error('Не удалось открыть панель.');
    };
    const sync = () => {
      if (scheduled || ctx.isInvalid) return;
      scheduled = true;
      ctx.requestAnimationFrame(() => {
        scheduled = false;
        syncPhotoButton(document, location.pathname, browser.runtime.getURL('/icon-48.png'), openPanel);
        void syncMarks();
      });
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'src', 'class'] });
    ctx.addEventListener(window, 'wxt:locationchange', sync);
    ctx.onInvalidated(() => {
      observer.disconnect();
      traversal.stop();
      browser.runtime.onMessage.removeListener(handleMessage);
      browser.storage.onChanged.removeListener(changed);
      document.getElementById('yandex-photo-downloader')?.remove();
    });
    sync();
  },
});
