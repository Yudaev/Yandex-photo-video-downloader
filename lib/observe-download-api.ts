type ApiListener = (method: string, url: string, status: number, body: unknown) => void;

// Install before Yandex can cache fetch/XHR methods; retain no response bodies between captures.
export function observeDownloadApi() {
  const key = Symbol.for('ypvd-download-api');
  const scope = globalThis as unknown as Record<symbol, Set<ApiListener>>;
  if (scope[key]) return;
  const listeners = scope[key] = new Set<ApiListener>();
  const matches = (value: string) => {
    try { const url = new URL(value, location.href); return url.origin === 'https://disk.yandex.ru' && url.pathname === '/models-v2' && !!url.searchParams.get('m')?.split(',').includes('mpfs/url'); }
    catch { return false; }
  };
  const notify = (method: string, url: string, status: number, body: unknown) => {
    for (const listener of listeners) { try { listener(method, url, status, body); } catch { /* Do not break the host page. */ } }
  };
  const requests = new Map<XMLHttpRequest, { method: string; url: string; completed: () => void }>();
  const flush = () => {
    for (const [xhr, request] of requests) {
      if (xhr.readyState !== 4) continue;
      requests.delete(xhr);
      xhr.removeEventListener('readystatechange', request.completed);
      if (!listeners.size) continue;
      let body: unknown;
      try { body = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText); } catch { /* Non-JSON response. */ }
      notify(request.method, request.url, xhr.status, body);
    }
  };
  Object.assign(listeners, { flush });
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
    if (matches(String(url))) {
      requests.set(this, { method, url: String(url), completed: flush });
      this.addEventListener('readystatechange', flush);
    }
    return open.call(this, method, url, async, username, password);
  };
  const fetchPage = globalThis.fetch;
  globalThis.fetch = async function (...args) {
    const response = await fetchPage.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
    if (listeners.size && matches(url)) {
      // Deliver the API links before the host page starts its native download callback.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clone = response.clone();
      try {
        const body = await Promise.race([clone.json(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('API response timeout')), 2000); })]);
        notify(args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET'), url, response.status, body);
      } catch { notify(args[1]?.method ?? 'GET', url, response.status, undefined); }
      finally { clearTimeout(timer); void clone.body?.cancel().catch(() => {}); }
    }
    return response;
  };
}
