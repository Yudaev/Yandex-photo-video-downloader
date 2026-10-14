import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';

const source = readFileSync(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.slice(source.indexOf('  async function startDownload('), source.indexOf('  async function chooseFolder(')), 'download-start.ts');

async function run(mode, { offline = false, stop = false, changedAccount = false, quota = false, grid = false } = {}) {
  const folder = { async requestPermission() { return 'granted'; } };
  const items = ['timeout', 'good', 'broken', 'last'].map(key => ({ key, account: '42', id: key, name: key, type: 'photo' }));
  const history = new Map(mode === 'error' ? items.map(item => [item.key, { ...item, status: 'error', folder }]) : []);
  const metadata = new Map();
  const attempted = []; const progress = []; const statuses = []; const resumptions = [];
  let index = 0; let reloads = 0; let connectionFailures = 0; let counts;
  let time = 0; let waitingReply;
  const polls = new Set();
  const context = {
    folder, photos: true, videos: true, os: 'linux', starting: { current: false }, active: { current: undefined },
    AbortController, DOMException, crypto, fetch,
    Date: class extends Date { static now() { return time; } },
    setInterval(callback) { polls.add(callback); return callback; }, clearInterval(callback) { polls.delete(callback); },
    setTimeout(callback) {
      queueMicrotask(() => {
        if (stop) context.active.current?.controller.abort();
        if (offline) context.navigator.onLine = true;
        callback();
      });
      return 1;
    }, clearTimeout() {},
    navigator: { onLine: true, locks: { async request(_name, _options, callback) { await callback({}); } } },
    matchesDownloadStatus(status, selected) { return selected === 'error' ? status === 'error' : status === undefined; },
    async getDownloadResult(key) { return history.get(key); },
    async setDownloadResult(result) { history.set(result.key, result); },
    async getSuccessfulDownloads() { return []; },
    async canReuseDownload() { return false; },
    async prepareDownloadMetadata() { return { find(key) { return metadata.get(key); }, async remember(result) { metadata.set(result.key, result); } }; },
    createDiagnosticsFile() { return { name: 'log.json', async save() {} }; },
    diagnosticError(error) { return error.message; }, captureDownloadUrl() {},
    async saveDownload(_folder, name) {
      if (name === 'broken') {
        if (offline) context.navigator.onLine = false;
        throw quota ? new DOMException('Disk full', 'QuotaExceededError') : new Error('network error');
      }
      return { savedName: name, bytes: 3, localModified: 1 };
    },
    browser: {
      runtime: { async sendMessage() { return { ok: true }; } },
      storage: { local: { async set() {} } },
      scripting: { async executeScript({ args }) {
        const name = args[1]; attempted.push(name);
        return [{ result: name === 'timeout' ? { error: 'Яндекс не выдал адрес оригинала за 30 секунд. Обновите страницу перед повторным запуском.', reloadRequired: true } : { url: 'https://downloader.disk.yandex.ru/file' } }];
      } },
      tabs: {
        async query() { return [{ id: 17, url: 'https://disk.yandex.ru/client/photo' }]; },
        async get() { return { id: 17, status: 'complete', url: 'https://disk.yandex.ru/client/photo' }; },
        async reload() { reloads++; connectionFailures = 2; },
        async sendMessage(_tab, message) {
          if (message.action === 'diagnose') return { account: '42', waitingForPhotos: grid && !reloads };
          if (message.action === 'stop' && waitingReply) { waitingReply({ error: 'Скачивание остановлено.' }); waitingReply = undefined; }
          if (message.action === 'start') {
            if (grid && !reloads) {
              const pending = new Promise(resolve => { waitingReply = resolve; });
              for (const callback of polls) callback();
              for (let tick = 0; tick < 5; tick++) await Promise.resolve();
              time = 181_000;
              for (const callback of polls) callback();
              return pending;
            }
            if (reloads && connectionFailures-- > 0) throw new Error('Could not establish connection. Receiving end does not exist.');
            if (reloads) resumptions.push(message);
            index = items.findIndex(item => !message.visited?.includes(item.key));
            const item = items[index] ?? null;
            return { item: item && changedAccount && reloads ? { ...item, account: '43' } : item };
          }
          if (message.action === 'next') return { item: items[++index] ?? null };
          return { ok: true };
        },
      },
    },
    setCounts(value) { counts = value; }, setProgress(value) { progress.push(value); }, setStatus(value) { statuses.push(value); },
    ...Object.fromEntries(['setRunning', 'setDatesReady', 'setCopyStatus', 'setLogStatus'].map(name => [name, () => {}])),
  };
  await runInNewContext(`${code}\nstartDownload`, context)(mode);
  return { attempted, progress, statuses, resumptions, counts, history, reloads, context };
}

for (const mode of ['new', 'error']) {
  test(`${mode} mode reloads after a URL timeout, waits for reconnection and reaches the end after another file fails`, async () => {
    const result = await run(mode, { offline: true });
    assert.deepEqual(result.attempted, ['timeout', 'good', 'broken', 'last']);
    assert.equal(result.reloads, 1);
    assert.deepEqual(Array.from(result.resumptions[0].visited), ['timeout']);
    assert.equal(result.resumptions[0].account, '42');
    assert.equal(result.history.get('last').status, 'success');
    assert.equal(result.counts.saved, 2);
    assert.equal(result.counts.failed, 2);
    assert.ok(result.progress.some(text => text.includes('сети')));
  });
}

test('Stop during page recovery does not reload or attempt another file', async () => {
  const result = await run('error', { stop: true });
  assert.deepEqual(result.attempted, ['timeout']);
  assert.equal(result.reloads, 0);
  assert.equal(result.context.starting.current, false);
});

test('a grid stuck for three minutes reloads automatically and the download still reaches the end', async () => {
  const result = await run('error', { grid: true });
  assert.deepEqual(result.attempted, ['timeout', 'good', 'broken', 'last']);
  assert.equal(result.reloads, 2);
  assert.equal(result.history.get('last').status, 'success');
});

test('a changed account after reload cannot download another account files', async () => {
  const result = await run('error', { changedAccount: true });
  assert.deepEqual(result.attempted, ['timeout']);
  assert.ok(result.statuses.some(text => text.includes('Аккаунт')));
});

test('an account recognized before the first visible file survives automatic grid reload', async () => {
  const result = await run('error', { grid: true, changedAccount: true });
  assert.deepEqual(result.attempted, []);
  assert.equal(result.resumptions[0].account, '42');
  assert.ok(result.statuses.some(text => text.includes('Аккаунт')));
});

test('disk quota failure still stops without touching the next file', async () => {
  const result = await run('error', { quota: true });
  assert.deepEqual(result.attempted, ['timeout', 'good', 'broken']);
  assert.equal(result.history.get('last').status, 'error');
});
