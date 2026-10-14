import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import './photo-button.test.mjs';
import './download-folder.test.mjs';
import './download-modes.test.mjs';
import './download-recovery.test.mjs';
import './save-download.test.mjs';
import './photo-viewer.test.mjs';
import './capture-download.test.mjs';
import './download-metadata.test.mjs';
import './download-diagnostics.test.mjs';

const output = new URL('../.output/chrome-mv3/', import.meta.url);
const background = readFileSync(new URL('background.js', output), 'utf8');

function loadBackground(openPanel = async () => {}, stored = {}) {
  const events = {};
  let handler;
  let behavior;
  runInNewContext(background, {
    chrome: {
      runtime: { id: 'test-extension', getManifest: () => ({ version: 'test' }), getURL: path => 'chrome-extension://test-extension/' + path.replace(/^\//, ''), onMessage: { addListener: (listener) => { handler = listener; } } },
      webRequest: Object.fromEntries(['onBeforeRequest', 'onResponseStarted', 'onCompleted', 'onErrorOccurred', 'onBeforeRedirect'].map(name => [name, { addListener(listener) { events[name] = listener; } }])),
      storage: { local: { async get() { return structuredClone(stored); }, async set(data) { Object.assign(stored, structuredClone(data)); } } },
      sidePanel: {
        setPanelBehavior: async (value) => { behavior = value.openPanelOnActionClick; },
        open: openPanel,
      },
    },
    console, setTimeout, clearTimeout, URL, Date,
  });
  return { handler, behavior, events, stored };
}

test('uses a native side panel and lets Chrome toggle it from the toolbar', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', output), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
  assert.ok(existsSync(new URL(manifest.side_panel.default_path, output)));
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(loadBackground().behavior, true);
});

test('Photos button opens the native panel in the same window without a popup or tab', async () => {
  let openedWindow;
  let result;
  const { handler } = loadBackground(async ({ windowId }) => { openedWindow = windowId; });
  assert.equal(handler('open-download-panel', { frameId: 0, tab: { id: 17, windowId: 4 }, url: 'https://disk.yandex.ru/client/photo' }, (value) => { result = value.ok; }), true);
  await Promise.resolve();
  assert.equal(openedWindow, 4);
  assert.equal(result, true);
});

test('panel failures are returned to the page', async () => {
  let result;
  const { handler } = loadBackground(async () => { throw new Error('Panel unavailable'); });
  handler('open-download-panel', { frameId: 0, tab: { id: 17, windowId: 4 }, url: 'https://disk.yandex.ru/client/photo' }, (value) => { result = value.ok; });
  await Promise.resolve();
  assert.equal(result, false);
});

test('ignores panel requests from other origins, routes and frames', () => {
  const { handler } = loadBackground(() => { assert.fail('Must not open the panel'); });
  for (const sender of [
    { frameId: 0, tab: { id: 17, windowId: 4 }, url: 'https://disk.yandex.ru.evil.example/client/photo' },
    { frameId: 0, tab: { id: 17, windowId: 4 }, url: 'https://disk.yandex.ru/client/disk' },
    { frameId: 1, tab: { id: 17, windowId: 4 }, url: 'https://disk.yandex.ru/client/photo' },
    { frameId: 0, url: 'https://disk.yandex.ru/client/photo' },
  ]) assert.equal(handler('open-download-panel', sender, () => {}), undefined);
});

test('failure diagnostics persist requests, isolate other tabs, redact credentials and survive restart', async () => {
  const bg = loadBackground();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/sidepanel.html' };
  const send = message => new Promise(resolve => bg.handler({ type: 'download-diagnostics', ...message }, sender, resolve));
  assert.equal((await send({ action: 'phase', tabId: 17, name: 'photo.HEIC', phase: 'capture-original-url' })).ok, true);
  const request = { tabId: 17, requestId: '1', timeStamp: Date.now(), method: 'POST', url: 'https://disk.yandex.ru/models-v2?m=mpfs/url&token=SECRET' };
  bg.events.onBeforeRequest(request);
  bg.events.onCompleted({ ...request, statusCode: 200 });
  bg.events.onCompleted({ ...request, tabId: 18, requestId: 'not-our-tab' });
  bg.events.onErrorOccurred({ ...request, tabId: -1, initiator: 'chrome-extension://test-extension', requestId: '2', url: 'https://downloader.disk.yandex.ru/disk/SECRET?filename=photo.HEIC', error: 'net::ERR_ABORTED' });
  await send({ action: 'failure', error: 'No original URL', details: { visible: 14, unidentified: 1 } });
  await send({ action: 'end' });
  const data = await send({ action: 'get' });
  assert.equal(data.failures.length, 1);
  assert.equal(data.failures[0].phase, 'capture-original-url');
  assert.equal(data.failures[0].requests.length, 3);
  assert.equal(data.failures[0].requests[1].status, 200);
  assert.ok(!JSON.stringify(data).includes('SECRET'));
  assert.ok(!JSON.stringify(data).includes('not-our-tab'));
  const restarted = loadBackground(undefined, bg.stored);
  const log = await new Promise(resolve => restarted.handler({ type: 'download-diagnostics', action: 'get' }, sender, resolve));
  assert.equal(log.failures.length, 1);
  assert.equal(bg.handler({ type: 'download-diagnostics', action: 'get' }, { id: 'test-extension', url: 'https://disk.yandex.ru/client/photo' }, () => assert.fail()), undefined);
});

test('a failed start in another panel does not end or attach to the active diagnostic session', async () => {
  const bg = loadBackground();
  const sender = { id: 'test-extension', url: 'chrome-extension://test-extension/sidepanel.html' };
  const send = message => new Promise(resolve => bg.handler({ type: 'download-diagnostics', ...message }, sender, resolve));
  await send({ action: 'phase', tabId: 17, runId: 'active-job', name: 'video.MOV', phase: 'transfer-and-save' });
  await send({ action: 'failure', runId: 'second-panel', error: 'Another window is already downloading' });
  await send({ action: 'end', runId: 'second-panel' });
  const data = await send({ action: 'get' });
  assert.equal(data.active.runId, 'active-job');
  assert.equal(data.failures[0].phase, undefined);
  assert.equal(data.failures[0].requests.length, 0);
  await send({ action: 'end', runId: 'active-job' });
});
