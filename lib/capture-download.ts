// Serialized into MAIN world: keep this function independent of module imports.
export function captureDownloadUrl(expectedId: string, expectedName: string): Promise<{ url?: string; error?: string; reloadRequired?: boolean; trace?: unknown[]; source?: 'api'; alternateUrl?: string }> {
  const trace: unknown[] = [];
  let usedApi = false;
  let selectedUrl: string | undefined;
  const apiLinks = new Map<string, URL>();
  let restoreNetwork = () => {};
  let reloadRequired = false;
  return new Promise<string>((resolve, reject) => {
    const prototype = HTMLIFrameElement.prototype;
    const button = document.querySelector<HTMLButtonElement>('.slider button[aria-label="Скачать"]');
    const guardKey = Symbol.for('ypvd-api-download-guard');
    const guarded = prototype as unknown as Record<symbol, Set<string>>;
    if (!guarded[guardKey]) {
      const nativeSrc = Object.getOwnPropertyDescriptor(prototype, 'src');
      if (nativeSrc?.get && nativeSrc.set) {
        const blocked = new Set<string>();
        Object.defineProperty(prototype, guardKey, { value: blocked });
        const suppress = (frame: HTMLIFrameElement, value: string) => {
          try {
            const url = new URL(value, location.href);
            return frame.id === 'download-iframe' && url.protocol === 'https:' && url.hostname === 'downloader.disk.yandex.ru'
              && blocked.has(JSON.stringify([url.searchParams.get('uid'), url.searchParams.get('filename')]));
          } catch { return false; }
        };
        const nativeAttribute = prototype.setAttribute;
        Object.defineProperty(prototype, 'src', { ...nativeSrc, configurable: true,
          get() { return nativeSrc.get!.call(this); },
          set(value: string) { if (!suppress(this, String(value))) nativeSrc.set!.call(this, value); },
        });
        prototype.setAttribute = function (name, value) {
          if (name.toLowerCase() !== 'src' || !suppress(this, value)) nativeAttribute.call(this, name, value);
        };
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'src');
    if (!button || button.disabled || !descriptor?.get || !descriptor.set
      || new URL(location.href).searchParams.get('idDialog') !== expectedId) {
      reject(new Error('Просмотрщик изменился или кнопка скачивания недоступна.'));
      return;
    }
    if (document.documentElement.hasAttribute('data-ypvd-download-pending')) {
      reloadRequired = true;
      reject(new Error('Предыдущий запрос Яндекса ещё не завершён. Обновите страницу перед повторным запуском.'));
      return;
    }
    document.documentElement.setAttribute('data-ypvd-download-pending', '');
    let cancelled = false;
    let settled = false;
    let apiTimer: ReturnType<typeof setTimeout> | undefined;
    let apiUrl: URL | undefined;
    const originalFetch = globalThis.fetch;
    const xhrPrototype = typeof XMLHttpRequest === 'undefined' ? undefined : XMLHttpRequest.prototype;
    const originalOpen = xhrPrototype?.open;
    const requests = new Map<XMLHttpRequest, { method: string; url: string }>();
    const logged = new Set<XMLHttpRequest>();
    const isModels = (value: string) => {
      try { const url = new URL(value, location.href); return url.origin === 'https://disk.yandex.ru' && url.pathname === '/models-v2'; }
      catch { return false; }
    };
    const safeLink = (value: string) => {
      try {
        const url = new URL(value, location.href);
        return { host: url.hostname, filename: url.searchParams.get('filename'), bytes: url.searchParams.get('fsize'),
          contentType: url.searchParams.get('content_type'), https: url.protocol === 'https:' };
      } catch { return { invalid: true }; }
    };
    const record = (method: string, url: string, status: number, body: unknown) => {
      const links: unknown[] = [];
      let nodes = 0;
      let hasError = false;
      const candidates = new Map<string, URL>();
      const walk = (value: unknown, depth: number) => {
        if (++nodes > 100 || depth > 5 || !value || typeof value !== 'object') return;
        for (const [key, field] of Object.entries(value)) {
          if (key === 'error' && field) hasError = true;
          if ((key === 'file' || key === 'digest') && typeof field === 'string') {
            links.push({ field: key, ...safeLink(field) });
            try {
              const link = new URL(field, location.href);
              if (link.protocol === 'https:' && link.hostname === 'downloader.disk.yandex.ru' && link.searchParams.get('filename') === expectedName) { candidates.set(key, link); apiLinks.set(key, link); }
            } catch { /* Invalid API link. */ }
          }
          else if (typeof field === 'object') walk(field, depth + 1);
        }
      };
      walk(body, 0);
      trace.push({ time: new Date().toISOString(), method, endpoint: '/models-v2', model: new URL(url, location.href).searchParams.get('m'), status, hasError, links });
      if (trace.length > 20) trace.shift();
      if (!settled && !cancelled && status >= 200 && status < 300 && !hasError
        && new URL(url, location.href).searchParams.get('m')?.split(',').includes('mpfs/url')) {
        apiUrl = candidates.get('digest') ?? candidates.get('file') ?? apiUrl;
        if (apiUrl && apiTimer === undefined) apiTimer = setTimeout(useApi, 1000);
      }
    };
    const readXhr = () => {
      for (const [xhr, request] of requests) {
        if (xhr.readyState !== 4 || logged.has(xhr)) continue;
        logged.add(xhr);
        let body: unknown;
        try { body = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText); } catch { /* Non-JSON response. */ }
        record(request.method, request.url, xhr.status, body);
      }
    };
    const observers = (globalThis as unknown as Record<symbol, Set<typeof record> & { flush?: () => void }>)[Symbol.for('ypvd-download-api')];
    observers?.add(record);
    if (!observers && xhrPrototype && originalOpen) {
      xhrPrototype.open = function (method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
        if (isModels(String(url))) {
          requests.set(this, { method, url: String(url) });
          this.addEventListener('loadend', readXhr, { once: true });
        }
        return originalOpen.call(this, method, url, async, username, password);
      };
    }
    if (!observers && originalFetch) globalThis.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (isModels(url)) {
        void response.clone().json().then(body => record(args[1]?.method ?? 'GET', url, response.status, body), () => record(args[1]?.method ?? 'GET', url, response.status, undefined));
      }
      return response;
    };
    let networkRestored = false;
    restoreNetwork = () => {
      if (networkRestored) return;
      networkRestored = true;
      readXhr();
      observers?.flush?.();
      observers?.delete(record);
      if (!observers && originalFetch) globalThis.fetch = originalFetch;
      if (!observers && xhrPrototype && originalOpen) xhrPrototype.open = originalOpen;
      for (const xhr of requests.keys()) xhr.removeEventListener('loadend', readXhr);
    };
    const ownSetAttribute = Object.getOwnPropertyDescriptor(prototype, 'setAttribute');
    const originalSetAttribute = prototype.setAttribute;
    const cleanup = () => {
      settled = true;
      clearTimeout(apiTimer);
      clearTimeout(timer);
      restoreNetwork();
      document.removeEventListener('ypvd-stop', cancel);
      document.documentElement.removeAttribute('data-ypvd-download-pending');
      Object.defineProperty(prototype, 'src', descriptor);
      if (ownSetAttribute) Object.defineProperty(prototype, 'setAttribute', ownSetAttribute); else Reflect.deleteProperty(prototype, 'setAttribute');
    };
    function useApi() {
      if (settled || cancelled || !apiUrl) return;
      if (new URL(location.href).searchParams.get('idDialog') !== expectedId) { cleanup(); reject(new Error('Во время скачивания выбран другой файл.')); return; }
      guarded[guardKey]!.add(JSON.stringify([apiUrl.searchParams.get('uid'), expectedName]));
      usedApi = true;
      selectedUrl = apiUrl.href;
      trace.push({ event: 'api-fallback', ...safeLink(apiUrl.href) });
      cleanup();
      resolve(apiUrl.href);
    }
    // Keep suppressing a late native download after cancellation until its callback arrives or the page unloads.
    const cancel = () => { cancelled = true; clearTimeout(apiTimer); clearTimeout(timer); restoreNetwork(); reject(new Error('Скачивание остановлено.')); };
    const timer = setTimeout(() => {
      if (apiUrl) { useApi(); return; }
      cancelled = true;
      reloadRequired = true;
      clearTimeout(apiTimer);
      restoreNetwork();
      reject(new Error('Яндекс не выдал адрес оригинала за 30 секунд. Обновите страницу перед повторным запуском.'));
    }, 30_000);
    const intercept = (value: string) => {
      let url: URL;
      try { url = new URL(value, location.href); } catch { return false; }
      if (url.protocol !== 'https:' || url.hostname !== 'downloader.disk.yandex.ru') return false;
      if (cancelled && url.searchParams.get('filename') !== expectedName) return false;
      cleanup();
      if (cancelled) return true;
      if (url.searchParams.get('filename') !== expectedName
        || new URL(location.href).searchParams.get('idDialog') !== expectedId) {
        reject(new Error('Во время скачивания выбран другой файл.'));
      } else { selectedUrl = url.href; resolve(url.href); }
      return true;
    };
    document.addEventListener('ypvd-stop', cancel, { once: true });
    try {
      // Yandex creates the iframe on the first download; scope the hook by its id.
      Object.defineProperty(prototype, 'src', {
        configurable: true,
        get() { return descriptor.get!.call(this); },
        set(value: string) { if (this.id !== 'download-iframe' || !intercept(String(value))) descriptor.set!.call(this, value); },
      });
      prototype.setAttribute = function (name, value) {
        if (this.id !== 'download-iframe' || name.toLowerCase() !== 'src' || !intercept(value)) originalSetAttribute.call(this, name, value);
      };
      button.click();
    } catch (error) { cleanup(); reject(error); }
  }).then(url => {
    const field = [...apiLinks].find(([, link]) => link.href === selectedUrl)?.[0] ?? 'unknown';
    const digest = apiLinks.get('digest');
    trace.push({ event: 'selected-link', source: usedApi ? 'api' : 'browser', field, apiObserved: apiLinks.size > 0 });
    return { url, ...(digest && digest.href !== url ? { alternateUrl: digest.href } : {}), ...(usedApi ? { source: 'api' as const } : {}), trace };
  }, error => ({ error: error instanceof Error ? error.message : 'Ошибка кнопки скачивания.', ...(reloadRequired ? { reloadRequired: true } : {}), ...(trace.length ? { trace } : {}) }));
}
