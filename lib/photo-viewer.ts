import type { DownloadItem } from './download-folder';

const resolvedTiles = new WeakMap<HTMLElement, { account: string; name: string; identity: string }>();

export function readPhotoTiles(doc: Document) {
  const elements = [...doc.querySelectorAll<HTMLElement>('.photo__item[title]')];
  let account = '';
  for (const element of elements) {
    const src = element.querySelector('img')?.getAttribute('src');
    if (src) {
      try { account = new URL(src, 'https://disk.yandex.ru').searchParams.get('uid') ?? ''; } catch { /* Incomplete preview. */ }
    }
    if (/^\d+$/.test(account)) break;
  }
  if (!/^\d+$/.test(account)) return [];
  return elements.map((element) => {
    const name = element.getAttribute('title')!;
    const type = element.getAttribute('aria-label')?.startsWith('Видео ') ? 'video' as const : 'photo' as const;
    let identity = '';
    if (element.classList.contains('photo__item_photounlim')) identity = `/photounlim/${name}`;
    else {
      const src = element.querySelector('img')?.getAttribute('src');
      if (src) {
        try {
          const preview = new URL(src, 'https://disk.yandex.ru').pathname.match(/^\/preview\/([^/]+)/)?.[0];
          if (preview) identity = `${preview}/${name}`;
        } catch { /* Incomplete preview. */ }
      }
    }
    const resolved = resolvedTiles.get(element);
    if (resolved?.account === account && resolved.name === name) identity = resolved.identity;
    return { element, name, type, account, key: identity ? JSON.stringify([account, identity]) : '' };
  });
}

export function readPhotoInfo(doc: Document, href: string) {
  const id = new URL(href).searchParams.get('idDialog');
  const info = doc.querySelector('.ufo-resource-info-dropdown');
  if (!id?.startsWith('/') || !info) return undefined;
  const fields = new Map<string, string>();
  for (const title of info.querySelectorAll('.ufo-resource-info-dropdown__title')) {
    fields.set((title.textContent ?? '').trim().replace(/:$/, ''), title.nextElementSibling?.textContent?.trim() ?? '');
  }
  const name = fields.get('Имя');
  const created = fields.get('Создан');
  const modified = fields.get('Изменён') ?? fields.get('Изменен');
  if (!name || !created || !modified) return undefined;
  return { id, name, created, modified, sizeLabel: fields.get('Размер') };
}

export function createPhotoTraversal(doc: Document, win: Window) {
  let visited = new Set<string>();
  let account = '';
  const unresolved = new Map<HTMLElement, { name: string; error: string }>();
  let stopped = true;
  let photos = true;
  let videos = true;
  let scroll: HTMLElement;
  let lastVisibleTop = 0;
  let scrollRecoveries = 0;
  let waitingForPhotos = false;
  let selected: ReturnType<typeof readPhotoTiles>[number] | undefined;
  const delay = (ms: number) => new Promise<void>((resolve) => win.setTimeout(resolve, ms));
  const ensurePage = () => {
    if (stopped) throw new Error('Скачивание остановлено.');
    if (!/^\/client\/photo\/?$/.test(win.location.pathname)) throw new Error('Открыта другая страница. Вернитесь в раздел «Фото».');
  };
  async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
    const deadline = Date.now() + 30_000;
    do {
      ensurePage();
      const value = read();
      if (value !== undefined) return value;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error(message);
  }
  async function close() {
    const button = doc.querySelector<HTMLButtonElement>('.slider button[aria-label="Закрыть"]');
    button?.click();
    if (button) await waitFor(() => doc.querySelector('.slider') ? undefined : true, 'Не удалось закрыть просмотрщик.');
  }
  async function next(): Promise<DownloadItem | null> {
    ensurePage();
    await close();
    selected = undefined;
    let bottom = 0;
    let previousHeight = 0;
    let recoveryAttempts = 0;
    const emptyFeedMessage = 'Фотолента не загрузилась или в окне нет её элементов.';
    while (true) {
      let tiles: ReturnType<typeof readPhotoTiles>;
      try {
        tiles = await waitFor(() => {
          const items = readPhotoTiles(doc);
          if (!items.length) { waitingForPhotos = true; return undefined; }
          if (account && items[0]!.account !== account) throw new Error('Аккаунт Яндекса изменился. Скачивание остановлено.');
          account = items[0]!.account;
          waitingForPhotos = !items.some(item => {
            const rect = item.element.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < win.innerHeight;
          });
          if (waitingForPhotos) return undefined;
          return items;
        }, emptyFeedMessage);
      } catch (error) {
        ensurePage();
        if (!(error instanceof Error) || error.message !== emptyFeedMessage) throw error;
        recoveryAttempts++;
        scrollRecoveries++;
        bottom = 0; previousHeight = 0;
        scroll = (doc.scrollingElement ?? doc.documentElement) as HTMLElement;
        // A virtual grid can keep stale tiles outside the viewport; force a new scroll position.
        const restorePosition = recoveryAttempts % 2 === 1;
        const nudgeFromTop = Math.min(100, Math.max(0, scroll.scrollHeight - scroll.clientHeight));
        scroll.scrollTop = restorePosition
          ? lastVisibleTop > 0 ? Math.max(0, lastVisibleTop - scroll.clientHeight) : nudgeFromTop
          : 0;
        await delay(500);
        ensurePage();
        if (restorePosition) {
          scroll.scrollTop = lastVisibleTop;
          await delay(500);
        }
        continue;
      }
      if (tiles[0]!.account !== account) throw new Error('Аккаунт Яндекса изменился. Скачивание остановлено.');
      lastVisibleTop = scroll.scrollTop;
      const tile = tiles.find(item => item.key && !visited.has(item.key));
      if (tile) {
        visited.add(tile.key);
        if ((tile.type === 'photo' && !photos) || (tile.type === 'video' && !videos)) continue;
        selected = tile;
        return { key: tile.key, account, id: '', name: tile.name, type: tile.type };
      }
      const unknown = tiles.find(item => !item.key && unresolved.get(item.element)?.name !== item.name
        && ((item.type === 'photo' && photos) || (item.type === 'video' && videos)));
      if (unknown) {
        selected = unknown;
        const item = await open('');
        if (!item.error && item.key) { visited.add(item.key); return item; }
        const error = item.error ?? 'Не удалось определить файл по информации просмотрщика.';
        unresolved.set(unknown.element, { name: unknown.name, error });
        showDownloadMark(unknown.element, 'error', error);
        await close();
        continue;
      }
      const height = scroll.scrollHeight;
      const atBottom = scroll.scrollTop + scroll.clientHeight >= height - 2;
      bottom = atBottom && height === previousHeight ? bottom + 1 : 0;
      if (bottom >= 3) {
        if (unresolved.size) throw new Error(`Фотолента обработана, но не удалось определить ${unresolved.size} файлов. Подробности сохранены в журнале; повторите запуск для новой попытки.`);
        return null;
      }
      previousHeight = height;
      scroll.scrollTop = Math.min(height, scroll.scrollTop + Math.max(100, scroll.clientHeight * .7));
      await delay(atBottom ? 1000 : 500);
      ensurePage();
    }
  }
  async function open(key: string): Promise<DownloadItem> {
    ensurePage();
    const tile = selected;
    if (!tile || tile.key !== key || !readPhotoTiles(doc).some(current => current.element === tile.element && current.key === key && current.account === account)) {
      throw new Error('Фотолента изменилась. Повторите запуск скачивания.');
    }
    tile.element.click();
    const item: DownloadItem = { key: tile.key, account, id: '', name: tile.name, type: tile.type };
    try {
      await waitFor(() => doc.querySelector('.slider') && new URL(win.location.href).searchParams.get('idDialog') ? true : undefined,
        'Не удалось открыть файл.');
      item.id = new URL(win.location.href).searchParams.get('idDialog')!;
      if (!readPhotoInfo(doc, win.location.href)) {
        const info = await waitFor(() => doc.querySelector<HTMLButtonElement>('.slider button[aria-label="Информация"]') ?? undefined,
          'Кнопка информации недоступна.');
        info.click();
      }
      const metadata = await waitFor(() => {
        const value = readPhotoInfo(doc, win.location.href);
        return value?.name === tile.name ? value : undefined;
      }, 'Не удалось прочитать имя и даты файла.');
      if (!item.key) {
        resolvedTiles.set(tile.element, { account, name: tile.name, identity: metadata.id });
        item.key = JSON.stringify([account, metadata.id]);
      }
      return { ...item, ...metadata };
    } catch (error) {
      ensurePage();
      return { ...item, error: error instanceof Error ? error.message : 'Ошибка просмотрщика.' };
    }
  }

  return {
    async start(options: { photos: boolean; videos: boolean; account?: string; visited?: string[] } = { photos: true, videos: true }) {
      if (!stopped) throw new Error('В этой вкладке уже идёт скачивание.');
      stopped = false;
      visited = new Set(options.visited ?? []);
      account = options.account ?? '';
      unresolved.clear();
      lastVisibleTop = 0;
      scrollRecoveries = 0;
      waitingForPhotos = false;
      photos = options.photos;
      videos = options.videos;
      try {
        await close();
        scroll = (doc.scrollingElement ?? doc.documentElement) as HTMLElement;
        scroll.scrollTop = 0;
        return await next();
      } catch (error) { stopped = true; waitingForPhotos = false; throw error; }
    },
    next,
    diagnose() {
      const tiles = readPhotoTiles(doc);
      return { time: new Date().toISOString(), route: win.location.pathname, account, stopped, visited: visited.size, scrollRecoveries, waitingForPhotos,
        rendered: doc.querySelectorAll('.photo__item[title]').length, identified: tiles.filter(tile => tile.key).length,
        visible: tiles.filter(tile => { const rect = tile.element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < win.innerHeight; }).length,
        unresolved: [...unresolved.values()].slice(0, 50), unresolvedCount: unresolved.size,
        unidentified: tiles.filter(tile => !tile.key).slice(0, 10).map(tile => ({ name: tile.name, type: tile.type })),
        scroll: scroll && { top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.clientHeight },
        viewerOpen: !!doc.querySelector('.slider'), pendingDownload: doc.documentElement.hasAttribute('data-ypvd-download-pending') };
    },
    open,
    stop() {
      if (stopped) return;
      stopped = true;
      waitingForPhotos = false;
      doc.dispatchEvent(new (doc.defaultView?.Event ?? Event)('ypvd-stop'));
      doc.querySelector<HTMLButtonElement>('.slider button[aria-label="Закрыть"]')?.click();
    },
  };
}

export function showDownloadMark(element: HTMLElement, status: 'saving' | 'success' | 'error', text: string) {
  let mark = element.querySelector<HTMLElement>('[data-ypvd-mark]');
  if (!mark) {
    mark = element.ownerDocument.createElement('span');
    mark.dataset.ypvdMark = '';
    mark.style.cssText = 'position:absolute;right:7px;top:7px;z-index:3;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:bold 19px system-ui;color:white;pointer-events:none;box-shadow:0 1px 5px #0008;';
    element.append(mark);
  }
  const symbol = status === 'success' ? '✓' : status === 'error' ? '✕' : '…';
  const color = status === 'success' ? '#218a47' : status === 'error' ? '#c83240' : '#7662b7';
  if (mark.textContent !== symbol) mark.textContent = symbol;
  if (mark.dataset.status !== status) { mark.dataset.status = status; mark.style.background = color; }
  if (mark.title !== text) mark.title = text;
  if (mark.getAttribute('aria-label') !== text) mark.setAttribute('aria-label', text);
}
