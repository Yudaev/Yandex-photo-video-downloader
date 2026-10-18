import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';

const source = readFileSync(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.slice(source.indexOf('  async function startDownload('), source.indexOf('  async function chooseFolder(')), 'download-start.ts');

async function run(mode, { offline = false, stop = false, changedAccount = false, quota = false, grid = false, initialAccountUnknown = false, restoreFailures = 0, failures = 1, stopAfterRetries = 0, disconnectNext = false, changedRoute = false, unresolvedPasses = 0, unresolvedBeforeReload = false } = {}) {
  const folder = { async requestPermission() { return 'granted'; } };
  const items = ['timeout', 'good', 'broken', 'last'].map(key => ({ key, account: '42', id: key, name: key, type: 'photo' }));
  const history = new Map(mode === 'error' ? items.map(item => [item.key, { ...item, status: 'error', folder }]) : []);
  const metadata = new Map();
  const attempted = []; const progress = []; const statuses = []; const resumptions = [];
  let index = 0; let reloads = 0; let connectionFailures = 0; let counts;
  let time = 0; let waitingReply; let pendingUnknown = false;
  const polls = new Set();
  const delays = []; const starts = []; let retries = 0;
  const context = {
    folder, photos: true, videos: true, os: 'linux', starting: { current: false }, active: { current: undefined },
    AbortController, DOMException, crypto, fetch,
    Date: class extends Date { static now() { return time; } },
    setInterval(callback) { polls.add(callback); return callback; }, clearInterval(callback) { polls.delete(callback); },
    setTimeout(callback, ms) {
      delays.push(ms);
      if (ms === 60_000) retries++;
      queueMicrotask(() => {
        if (stop || (stopAfterRetries && retries >= stopAfterRetries)) context.active.current?.controller.abort();
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
      if (name === 'broken' && attempted.filter(value => value === name).length <= failures) {
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
        return [{ result: name === 'timeout' && attempted.filter(value => value === name).length <= failures ? { error: 'Яндекс не выдал адрес оригинала за 30 секунд. Обновите страницу перед повторным запуском.', reloadRequired: true } : { url: 'https://downloader.disk.yandex.ru/file' } }];
      } },
      tabs: {
        async query() { return [{ id: 17, url: 'https://disk.yandex.ru/client/photo' }]; },
        async get() { return { id: 17, status: 'complete', url: changedRoute && reloads ? 'https://disk.yandex.ru/client/disk' : 'https://disk.yandex.ru/client/photo' }; },
        async reload() { reloads++; connectionFailures = 2; pendingUnknown = false; },
        async sendMessage(_tab, message) {
          if (message.action === 'diagnose') return { account: initialAccountUnknown && !reloads ? '' : '42', waitingForPhotos: grid && !reloads, position: { top: 90000, month: pendingUnknown ? '2-2022' : '3-2022' }, ...(pendingUnknown ? { unresolvedCount: 1, unresolvedPosition: { top: 80000, month: '3-2022' } } : {}) };
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
            starts.push(message);
            if (reloads) resumptions.push(message);
            if (reloads && restoreFailures-- > 0) return { error: 'Не удалось вернуться к сохранённому месяцу по таймлайну.', retryable: true, position: message.position };
            index = items.findIndex(item => !message.visited?.includes(item.key));
            const item = items[index] ?? null;
            if (!item && unresolvedPasses-- > 0) return { item, position: { top: 90000, month: '3-2022' }, unresolvedCount: 1, unresolvedPosition: { top: 90000, month: '3-2022' } };
            return { item: item && changedAccount && reloads ? { ...item, account: '43' } : item, position: { top: 90000, month: '3-2022' } };
          }
          if (message.action === 'next') {
            if (disconnectNext && index === 1) { disconnectNext = false; pendingUnknown = unresolvedBeforeReload; throw new Error('The message port closed before a response was received.'); }
            const item = items[++index] ?? null;
            return { item, position: { top: 90000, month: '3-2022' }, ...(!item && unresolvedPasses-- > 0 ? { unresolvedCount: 1, unresolvedPosition: { top: 90000, month: '3-2022' } } : {}) };
          }
          return { ok: true };
        },
      },
    },
    setCounts(value) { counts = value; }, setProgress(value) { progress.push(value); }, setStatus(value) { statuses.push(value); },
    ...Object.fromEntries(['setRunning', 'setDatesReady', 'setCopyStatus', 'setLogStatus'].map(name => [name, () => {}])),
  };
  await runInNewContext(`${code}\nstartDownload`, context)(mode);
  return { attempted, progress, statuses, resumptions, counts, history, reloads, context, starts, delays };
}

for (const mode of ['new', 'error']) {
  test(`${mode} mode reloads after a URL timeout, waits for reconnection and reaches the end after another file fails`, async () => {
    const result = await run(mode, { offline: true });
    assert.deepEqual(result.attempted, mode === 'error' ? ['timeout', 'good', 'broken', 'last', 'timeout', 'broken'] : ['timeout', 'good', 'broken', 'last']);
    assert.equal(result.reloads, 1);
    assert.deepEqual(Array.from(result.resumptions[0].visited), ['timeout']);
    assert.equal(result.resumptions[0].account, '42');
    assert.equal(result.resumptions[0].position?.month, '3-2022');
    assert.equal(result.resumptions[0].position?.top, 90000);
    assert.equal(result.history.get('last').status, 'success');
    assert.equal(result.counts.saved, mode === 'error' ? 4 : 2);
    assert.equal(result.counts.failed, mode === 'error' ? 0 : 2);
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
  const result = await run('new', { grid: true });
  assert.deepEqual(result.attempted, ['timeout', 'good', 'broken', 'last']);
  assert.equal(result.reloads, 2);
  assert.equal(result.resumptions[0].position?.month, '3-2022');
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

test('initially empty feed passes its month through reload without inventing an account or visited files', async () => {
  const result = await run('new', { grid: true, initialAccountUnknown: true });
  assert.equal(result.resumptions[0].account, undefined);
  assert.equal(result.resumptions[0].visited.length, 0);
  assert.equal(result.resumptions[0].position.month, '3-2022');
  assert.equal(result.resumptions[1].account, '42');
  assert.equal(result.history.get('last').status, 'success');
});

test('disk quota failure still stops without touching the next file', async () => {
  const result = await run('error', { quota: true });
  assert.deepEqual(result.attempted, ['timeout', 'good', 'broken']);
  assert.equal(result.history.get('last').status, 'error');
});


test('repeated timeline failures preserve the checkpoint and recover without a retry limit', async () => {
  const result = await run('new', { restoreFailures: 4 });
  assert.equal(result.reloads, 5);
  assert.equal(result.history.get('last').status, 'success');
  assert.ok(result.resumptions.every(start => start.position.month === '3-2022' && start.visited.includes('timeout')));
});

test('a disconnected content script during traversal resumes from the checkpoint', async () => {
  const result = await run('new', { disconnectNext: true });
  assert.equal(result.history.get('last').status, 'success');
  assert.equal(result.reloads, 2);
  assert.equal(result.attempted.filter(name => name === 'good').length, 1);
});

test('error mode starts at the top, retries only failures across multiple passes and finishes with no remaining errors', async () => {
  const result = await run('error', { failures: 3 });
  assert.equal(result.starts[0].position.top, 0);
  assert.equal(result.starts[0].position.month, undefined);
  for (const name of ['timeout', 'broken']) assert.equal(result.attempted.filter(value => value === name).length, 4);
  for (const name of ['good', 'last']) assert.equal(result.attempted.filter(value => value === name).length, 1);
  assert.equal(result.counts.failed, 0);
  assert.equal(result.counts.saved, 4);
  assert.ok([...result.history.values()].every(result => result.status === 'success'));
  assert.equal(result.delays.filter(ms => ms === 60_000).length, 3);
  assert.ok(!result.statuses.at(-1).includes('нажмите'));
});

test('permanent file errors keep retrying with a delay until Stop is pressed', async () => {
  const result = await run('error', { failures: Infinity, stopAfterRetries: 3 });
  assert.equal(result.attempted.filter(name => name === 'broken').length, 3);
  assert.equal(result.history.get('good').status, 'success');
  assert.match(result.statuses.at(-1), /остановлено/);
  assert.equal(result.counts.failed, 2);
  assert.equal(result.context.starting.current, false);
});

test('navigation away during recovery stops without another download', async () => {
  const result = await run('new', { changedRoute: true });
  assert.deepEqual(result.attempted, ['timeout']);
  assert.match(result.statuses.at(-1), /другая страница/);
});


test('unidentified files do not starve known failures or allow completion before identification succeeds', async () => {
  const result = await run('error', { unresolvedPasses: 3 });
  assert.equal(result.attempted.filter(name => name === 'broken').length, 2);
  assert.equal(result.history.get('broken').status, 'success');
  assert.equal(result.delays.filter(ms => ms === 60_000).length, 3);
  assert.match(result.statuses.at(-1), /завершена/);
});


test('unknown files discovered before a lost response survive reload through diagnostics and get another pass', async () => {
  const result = await run('new', { failures: 0, disconnectNext: true, unresolvedBeforeReload: true });
  assert.equal(result.reloads, 1);
  assert.equal(result.resumptions[0].position.month, '2-2022', 'recovery resumes traversal progress');
  assert.equal(result.delays.filter(ms => ms === 60_000).length, 1);
  assert.equal(result.starts.at(-1).position.month, '3-2022', 'next pass returns to the earlier unidentified file');
  assert.equal(result.starts.at(-1).position.top, 80000);
  assert.deepEqual(result.attempted, ['timeout', 'good', 'broken', 'last']);
  assert.match(result.statuses.at(-1), /завершена/);
});
