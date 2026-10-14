import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';

const { code } = await transformWithOxc(readFileSync(new URL('../lib/capture-download.ts', import.meta.url), 'utf8'), 'capture-download.ts');
const { captureDownloadUrl } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const original = 'https://downloader.disk.yandex.ru/disk/original?filename=video.MOV';

async function withPage(click, check) {
  class Frame {
    id = 'download-iframe';
    forwarded = [];
    get src() { return ''; }
    set src(value) { this.forwarded.push(value); }
    setAttribute(name, value) { this.forwarded.push([name, value]); }
  }
  const frame = new Frame();
  const doc = new EventTarget();
  doc.getElementById = () => frame;
  doc.querySelector = () => ({ disabled: false, click: () => click(frame) });
  const attributes = new Map();
  doc.documentElement = {
    hasAttribute: name => attributes.has(name), setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
  };
  const previous = { document: globalThis.document, location: globalThis.location, HTMLIFrameElement: globalThis.HTMLIFrameElement };
  Object.assign(globalThis, { document: doc, location: { href: 'https://disk.yandex.ru/client/photo?idDialog=%2Fphotounlim%2Fvideo.MOV' }, HTMLIFrameElement: Frame });
  try { await check(frame, doc); }
  finally { Object.assign(globalThis, previous); }
}

test('passes iframe reset, captures the native original and restores original properties', async () => {
  await withPage(frame => { frame.src = ''; frame.src = original; }, async frame => {
    assert.equal((await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV')).url, original);
    assert.deepEqual(frame.forwarded, ['']);
    assert.equal(Object.hasOwn(frame, 'src'), false);
    assert.equal(Object.hasOwn(frame, 'setAttribute'), false);
  });
});

test('captures setAttribute and refuses another filename without downloading it', async () => {
  await withPage(frame => frame.setAttribute('src', original), async () => {
    assert.match((await captureDownloadUrl('/photounlim/video.MOV', 'another.MOV')).error, /другой файл/);
  });
});

test('cancellation suppresses a late original, then restores manual downloading', async () => {
  await withPage(() => {}, async (frame, doc) => {
    const pending = captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
    doc.dispatchEvent(new Event('ypvd-stop'));
    assert.match((await pending).error, /остановлено/);
    frame.src = original;
    assert.deepEqual(frame.forwarded, []);
    assert.equal(doc.documentElement.hasAttribute('data-ypvd-download-pending'), false);
    frame.src = original;
    assert.deepEqual(frame.forwarded, [original]);
  });
});

test('original URL timeout requests page recovery and still suppresses a late native download', async ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  await withPage(() => {}, async (frame, doc) => {
    const pending = captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
    mock.timers.tick(30_000);
    const result = await pending;
    assert.equal(result.reloadRequired, true);
    assert.match(result.error, /30 секунд/);
    assert.equal((await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV')).reloadRequired, true);
    frame.src = original;
    assert.deepEqual(frame.forwarded, []);
    assert.equal(doc.documentElement.hasAttribute('data-ypvd-download-pending'), false);
  });
});

test('captures a newly created download iframe and leaves unrelated iframe navigations alone', async () => {
  await withPage(frame => {
    const unrelated = new frame.constructor(); unrelated.id = 'docviewer'; unrelated.src = original;
    assert.deepEqual(unrelated.forwarded, [original]);
    const newFrame = new frame.constructor();
    newFrame.src = original;
    assert.deepEqual(newFrame.forwarded, []);
  }, async () => {
    assert.equal((await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV')).url, original);
  });
});

test('records successful models response links without signed URLs and restores XHR hooks', async () => {
  class Xhr extends EventTarget {
    readyState = 0; status = 0; responseType = 'json';
    response = { data: { file: '//downloader.disk.yandex.ru/disk/SECRET?filename=video.MOV&fsize=42&token=SECRET', digest: 'https://downloader.disk.yandex.ru/disk/SECRET?filename=video.MOV' } };
    open() { this.readyState = 4; this.status = 200; }
  }
  const previous = globalThis.XMLHttpRequest;
  const originalOpen = Xhr.prototype.open;
  globalThis.XMLHttpRequest = Xhr;
  try {
    await withPage(frame => { new Xhr().open('POST', 'https://disk.yandex.ru/models-v2?m=mpfs/url'); frame.src = original; }, async () => {
      const result = await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
      assert.equal(result.trace[0].status, 200);
      assert.equal(result.trace[0].model, 'mpfs/url');
      assert.equal(result.trace[0].links.length, 2);
      assert.equal(result.trace[0].links[0].bytes, '42');
      assert.ok(!JSON.stringify(result.trace).includes('SECRET'));
      assert.equal(Xhr.prototype.open, originalOpen);
    });
  } finally { globalThis.XMLHttpRequest = previous; }
});

test('a models 200 response remains in the failure trace when no native download follows', async () => {
  class Xhr extends EventTarget {
    readyState = 0; status = 0; responseType = 'json';
    response = { data: { digest: 'https://downloader.disk.yandex.ru/disk/SECRET?filename=video.MOV' } };
    open() { this.readyState = 4; this.status = 200; }
  }
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Xhr;
  try {
    await withPage(() => {
      new Xhr().open('POST', 'https://disk.yandex.ru/models-v2?m=mpfs/url');
      document.dispatchEvent(new Event('ypvd-stop'));
    }, async () => {
      const result = await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
      assert.match(result.error, /остановлено/);
      assert.equal(result.trace[0].status, 200);
      assert.equal(result.trace[0].links[0].field, 'digest');
      assert.ok(!JSON.stringify(result.trace).includes('SECRET'));
    });
  } finally { globalThis.XMLHttpRequest = previous; }
});

async function withApi(body, click, check) {
  class Xhr extends EventTarget {
    readyState = 0; status = 200; responseType = 'json'; response = body;
    open() { this.readyState = 4; }
  }
  const previous = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Xhr;
  try {
    await withPage(frame => {
      const xhr = new Xhr();xhr.open('POST', 'https://disk.yandex.ru/models-v2?m=mpfs/url');
      xhr.dispatchEvent(new Event('loadend'));
      click?.(frame);
    }, check);
  } finally { globalThis.XMLHttpRequest = previous; }
}

test('API fallback prefers digest, accepts relative file URLs and suppresses a late native duplicate', async ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const digest = 'https://downloader.disk.yandex.ru/disk/digest?uid=1&filename=video.MOV';
  await withApi({ data: { file: '//downloader.disk.yandex.ru/disk/file?uid=1&filename=video.MOV', digest } }, undefined, async frame => {
    const pending = captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
    mock.timers.tick(1000);
    const result = await pending;
    assert.equal(result.url, digest);assert.equal(result.source, 'api');
    assert.ok(result.trace.some(event => event.event === 'api-fallback'));
    assert.equal(result.trace.at(-1).field, 'digest');
    frame.src = digest;frame.setAttribute('src', digest);
    assert.deepEqual(frame.forwarded, []);
    const unrelated = new frame.constructor();unrelated.id = 'docviewer';unrelated.src = digest;
    assert.deepEqual(unrelated.forwarded, [digest]);
  });
  await withApi({ data: { file: '//downloader.disk.yandex.ru/disk/file?filename=video.MOV' } }, undefined, async () => {
    const pending = captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');mock.timers.tick(1000);
    assert.equal((await pending).url, 'https://downloader.disk.yandex.ru/disk/file?filename=video.MOV');
  });
});

test('normal iframe capture wins over API fallback and stopping cancels the fallback timer', async ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const body = { data: { digest: original } };
  await withApi(body, frame => { frame.src = original; }, async () => {
    const result = await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
    assert.equal(result.url, original);assert.equal(result.source, undefined);mock.timers.tick(1000);
  });
  await withApi(body, undefined, async (_frame, doc) => {
    const pending = captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
    doc.dispatchEvent(new Event('ypvd-stop'));mock.timers.tick(1000);
    const result = await pending;assert.match(result.error, /остановлено/);assert.equal(result.url, undefined);
  });
});

test('API links for another file or an untrusted server cannot trigger the fallback', async ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  await withApi({ data: { digest: 'https://evil.test/file?filename=video.MOV', file: 'https://downloader.disk.yandex.ru/disk/file?filename=other.MOV' } }, undefined, async (_frame, doc) => {
    const pending = captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');mock.timers.tick(1000);
    doc.dispatchEvent(new Event('ypvd-stop'));
    const result = await pending;assert.equal(result.url, undefined);assert.match(result.error, /остановлено/);
  });
});

test('fallback duplicate guard does not prevent capturing and downloading the next file', async ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  let next = false;
  const first = 'https://downloader.disk.yandex.ru/disk/first?uid=1&filename=video.MOV';
  const second = 'https://downloader.disk.yandex.ru/disk/second?uid=1&filename=next.MOV';
  await withApi({ data: { digest: first } }, frame => { if (next) frame.src = second; }, async frame => {
    const pending = captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');mock.timers.tick(1000);
    assert.equal((await pending).source, 'api');
    next = true;location.href = 'https://disk.yandex.ru/client/photo?idDialog=%2Fphotounlim%2Fnext.MOV';
    const result = await captureDownloadUrl('/photounlim/next.MOV', 'next.MOV');
    assert.equal(result.url, second);assert.equal(result.source, undefined);
    frame.src = first;assert.deepEqual(frame.forwarded, []);
  });
});

test('early observer sees cached fetch and selects an alternative digest for native file links', async () => {
  const { code: observerCode } = await transformWithOxc(readFileSync(new URL('../lib/observe-download-api.ts', import.meta.url), 'utf8'), 'observe-download-api.ts');
  const { observeDownloadApi } = await import(`data:text/javascript;base64,${Buffer.from(observerCode).toString('base64')}`);
  const previous = { fetch: globalThis.fetch, XMLHttpRequest: globalThis.XMLHttpRequest };
  const key = Symbol.for('ypvd-download-api');
  class Xhr extends EventTarget { open() {} }
  globalThis.XMLHttpRequest = Xhr;
  const digest = 'https://downloader.disk.yandex.ru/disk/DIGESTSECRET?filename=video.MOV';
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { file: original, digest } }));
  observeDownloadApi();
  const cachedFetch = globalThis.fetch;
  try {
    await withPage(frame => { void cachedFetch('https://disk.yandex.ru/models-v2?m=mpfs/url', { method: 'POST' }).then(() => { frame.src = original; }); }, async () => {
      const result = await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
      assert.equal(result.alternateUrl, digest);
      assert.deepEqual(result.trace.at(-1), { event: 'selected-link', source: 'browser', field: 'file', apiObserved: true });
      assert.ok(!JSON.stringify(result.trace).includes('DIGESTSECRET'));
      assert.equal(globalThis[key].size, 0);
    });
  } finally { delete globalThis[key]; Object.assign(globalThis, previous); }
});

test('early XHR observer flushes API links even when native callback runs before its event listener', async () => {
  const { code: observerCode } = await transformWithOxc(readFileSync(new URL('../lib/observe-download-api.ts', import.meta.url), 'utf8'), 'observe-download-api.ts');
  const { observeDownloadApi } = await import(`data:text/javascript;base64,${Buffer.from(observerCode).toString('base64')}`);
  const previous = globalThis.XMLHttpRequest; const previousFetch = globalThis.fetch;
  const key = Symbol.for('ypvd-download-api');
  const digest = 'https://downloader.disk.yandex.ru/disk/digest?filename=video.MOV';
  class Xhr extends EventTarget {
    readyState = 0; status = 200; responseType = 'json'; response = { data: { file: original, digest } };
    open() { this.readyState = 4; }
  }
  globalThis.XMLHttpRequest = Xhr; observeDownloadApi();
  const cachedOpen = Xhr.prototype.open;
  try {
    await withPage(frame => { const xhr = new Xhr(); cachedOpen.call(xhr, 'POST', 'https://disk.yandex.ru/models-v2?m=mpfs/url'); frame.src = original; }, async () => {
      const result = await captureDownloadUrl('/photounlim/video.MOV', 'video.MOV');
      assert.equal(result.alternateUrl, digest);
      assert.equal(result.trace.at(-1).field, 'file');
      assert.equal(globalThis[key].size, 0);
    });
  } finally { delete globalThis[key]; globalThis.XMLHttpRequest = previous; globalThis.fetch = previousFetch; }
});
