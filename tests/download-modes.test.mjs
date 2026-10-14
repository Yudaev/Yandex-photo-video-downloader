import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';

const source = readFileSync(new URL('../entrypoints/sidepanel/main.tsx', import.meta.url), 'utf8');
const start = source.slice(source.indexOf('  async function startDownload('), source.indexOf('  async function chooseFolder('));
const { code } = await transformWithOxc(start, 'download-start.ts');
const { code: folderCode } = await transformWithOxc(readFileSync(new URL('../lib/download-folder.ts', import.meta.url), 'utf8'), 'download-folder.ts');
const { matchesDownloadStatus } = await import(`data:text/javascript;base64,${Buffer.from(folderCode).toString('base64')}`);

for (const [mode, expected] of [['error', ['error']], ['new', ['new']]]) {
  test(`${mode} mode leaves all other download records untouched`, async () => {
    const folder = { async requestPermission() { return 'granted'; } };
    const items = ['new', 'error', 'success', 'saving', 'json'].map(key => ({
      key, id: key, account: '42', type: 'photo', name: `${key}.jpg`, error: 'Fixture failure',
    }));
    const history = new Map(items.slice(1, 4).map(item => [item.key, { ...item, status: item.key, folder }]));
    const before = [...history].map(([key, record]) => [key, { ...record }]);
    const writes = [];
    const timers = new Set();
    const progress = [];
    let index = 0;
    let counts;
    let delayDiagnostic = false;
    let finishDiagnostic;
    const context = {
      folder, photos: true, videos: true, os: 'linux',
      starting: { current: false }, active: { current: undefined },
      AbortController, DOMException, crypto, navigator: { onLine: true, locks: { async request(_name, _options, callback) { await callback({}); } } },
      setInterval(callback) { timers.add(callback); return callback; },
      clearInterval(callback) { timers.delete(callback); },
      matchesDownloadStatus,
      async getDownloadResult(key) { return history.get(key); },
      async setDownloadResult(result) { writes.push(result); history.set(result.key, result); },
      async getSuccessfulDownloads() { return []; },
      async canReuseDownload() { return false; },
      async prepareDownloadMetadata() {
        return { find(key) { return key === 'json' ? { ...items[4], status: 'success', folder } : undefined; } };
      },
      createDiagnosticsFile() { return { name: 'log.json', async save() {} }; },
      diagnosticError(error) { return error.message; },
      browser: {
        runtime: { async sendMessage() { return { ok: true }; } },
        storage: { local: { async set() {} } },
        tabs: {
          async query() { return [{ id: 17, url: 'https://disk.yandex.ru/client/photo' }]; },
          async sendMessage(_tab, { action }) {
            if (action === 'diagnose') {
              if (delayDiagnostic) return new Promise(resolve => { finishDiagnostic = resolve; });
              return { waitingForPhotos: true };
            }
            if (action === 'start') {
              for (const callback of timers) callback();
              await Promise.resolve();
              return { item: items[index] };
            }
            if (action === 'next') {
              if (index === items.length - 1) {
                delayDiagnostic = true;
                for (const callback of timers) callback();
              }
              return { item: items[++index] ?? null };
            }
            return {};
          },
        },
      },
      setCounts(value) { counts = value; },
      ...Object.fromEntries(['setRunning', 'setStatus', 'setDatesReady', 'setCopyStatus', 'setProgress', 'setLogStatus'].map(name => [name, () => {}])),
      setProgress(value) { progress.push(value); },
    };
    const download = runInNewContext(`${code}\nstartDownload`, context);
    await download(mode);
    assert.deepEqual([...new Set(writes.map(result => result.key))], expected);
    assert.ok(writes.some(result => result.status === 'error'));
    for (const [key, record] of before) if (!expected.includes(key)) assert.deepEqual(history.get(key), record);
    assert.equal(counts.failed, 1);
    assert.equal(index, items.length);
    assert.equal(context.starting.current, false);
    assert.ok(progress.some(value => value.includes('Жду загрузки фотоленты')));
    assert.equal(timers.size, 0);
    finishDiagnostic({ waitingForPhotos: true });
    await Promise.resolve();
    assert.equal(progress.at(-1), '', 'late waiting diagnostics cannot replace completed progress');
  });
}
