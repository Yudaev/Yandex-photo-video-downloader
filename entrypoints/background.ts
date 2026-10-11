import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { diagnosticUrl, diagnosticError } from '../lib/download-diagnostics';
import { getDownloadResult } from '../lib/download-folder';

export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Не удалось настроить боковую панель:', error));

  type Context = { runId?: string; tabId: number; phase: string; name?: string; time: string; requests: unknown[]; details?: unknown };
  let context: Context | undefined;
  let failures: unknown[] = [];
  let last: Context | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = browser.storage.local.get('downloadDiagnostics').then(({ downloadDiagnostics: saved }) => {
    const savedLog = saved as { failures?: unknown[]; active?: Context; last?: Context } | undefined;
    failures = Array.isArray(savedLog?.failures) ? savedLog.failures!.slice(-50) : [];
    last = savedLog?.active ?? savedLog?.last;
  }).catch(error => console.error('Не удалось прочитать журнал:', error));
  const persist = () => browser.storage.local.set({ downloadDiagnostics: {
    format: 'yandex-download-diagnostics', version: 1, extensionVersion: browser.runtime.getManifest().version,
    failures, active: context, last,
  } });
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      queue = queue.then(persist).catch(error => console.error('Не удалось сохранить журнал:', error));
    }, 500);
  };
  const filter = { urls: ['https://disk.yandex.ru/*', 'https://*.downloader.disk.yandex.ru/*', 'https://*.storage.yandex.net/*'] };
  const observe = (event: string) => (request: {
    tabId: number; initiator?: string; url: string; method: string; requestId: string; timeStamp: number;
    statusCode?: number; error?: string; fromCache?: boolean; redirectUrl?: string;
    responseHeaders?: { name: string; value?: string }[];
  }) => {
    if (!context || (request.tabId !== context.tabId && !(request.tabId === -1 && request.initiator === browser.runtime.getURL('').replace(/\/$/, '')))) return;
    context.requests.push({ event, id: request.requestId, time: new Date(request.timeStamp).toISOString(),
      url: diagnosticUrl(request.url), method: request.method, status: request.statusCode,
      error: request.error?.slice(0, 256), cached: request.fromCache,
      redirect: request.redirectUrl ? diagnosticUrl(request.redirectUrl) : undefined,
      headers: request.responseHeaders?.filter(header => ['content-type', 'content-length', 'retry-after'].includes(header.name.toLowerCase())).map(header => ({ name: header.name, value: header.value?.slice(0, 256) })),
    });
    context.requests = context.requests.slice(-120);
    schedule();
    return undefined;
  };
  browser.webRequest.onBeforeRequest.addListener(observe('request'), filter);
  browser.webRequest.onResponseStarted.addListener(observe('response'), filter, ['responseHeaders']);
  browser.webRequest.onCompleted.addListener(observe('completed'), filter);
  browser.webRequest.onErrorOccurred.addListener(observe('network-error'), filter);
  browser.webRequest.onBeforeRedirect.addListener(observe('redirect'), filter);

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'download-diagnostics' && sender.id === browser.runtime.id
      && sender.url === browser.runtime.getURL('/sidepanel.html')) {
      queue = queue.then(async () => {
        if (message.action === 'get') { await persist(); return (await browser.storage.local.get('downloadDiagnostics')).downloadDiagnostics; }
        if (message.action === 'end') { if (context?.runId === message.runId) { last = context; context = undefined; } }
        else if (message.action === 'phase' && Number.isInteger(message.tabId)) {
          const name = typeof message.name === 'string' ? message.name.slice(0, 256) : undefined;
          if (!context || context.runId !== message.runId || context.tabId !== message.tabId || context.name !== name) {
            context = { runId: message.runId, tabId: message.tabId, phase: '', name, time: new Date().toISOString(), requests: [] };
          }
          context.phase = String(message.phase).slice(0, 100);
        } else if (message.action === 'failure') {
          const ownContext = context?.runId === message.runId ? context : undefined;
          failures.push({ ...ownContext, requests: [...(ownContext?.requests ?? [])], time: new Date().toISOString(), error: diagnosticError(message.error),
            details: message.details, trace: message.trace });
          failures = failures.slice(-50);
        }
        await persist();
        return { ok: true };
      });
      queue.then(result => sendResponse(result), error => sendResponse({ error: diagnosticError(error) }));
      queue = queue.catch(() => {});
      return true;
    }
    if (message?.type === 'get-download-marks' && sender.frameId === 0
      && /^https:\/\/disk\.yandex\.ru\/client\/photo\/?(?:[?#]|$)/.test(sender.url ?? '')
      && Array.isArray(message.keys) && message.keys.length <= 500
      && message.keys.every((key: unknown) => typeof key === 'string' && key.length < 4096)) {
      Promise.all(message.keys.map(async (key: string) => {
        const result = await getDownloadResult(key);
        return { key, status: result?.status, text: result?.status === 'success'
          ? `Сохранён: ${result.savedName} (${result.folder.name})`
          : result?.error ?? 'Скачивание выполняется или было прервано.' };
      })).then((marks) => sendResponse({ marks }), () => sendResponse({ error: 'Не удалось прочитать историю скачивания.' }));
      return true;
    }
    if (message !== 'open-download-panel' || sender.frameId !== 0 || sender.tab?.windowId === undefined
      || !/^https:\/\/disk\.yandex\.ru\/client\/photo\/?(?:[?#]|$)/.test(sender.url ?? '')) return;
    browser.sidePanel.open({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  });
});
