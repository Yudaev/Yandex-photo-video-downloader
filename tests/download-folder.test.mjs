import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { indexedDB } from 'fake-indexeddb';

globalThis.indexedDB = indexedDB;
const source = readFileSync(new URL('../lib/download-folder.ts', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source, 'download-folder.ts');
const { getDownloadFolder, setDownloadFolder, getDownloadResult, setDownloadResult, getUnfinishedDownloads, matchesDownloadStatus } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('download modes select only previous errors or files without any status', () => {
  for (const [status, retry, fresh] of [
    [undefined, false, true],
    ['error', true, false],
    ['success', false, false],
    ['saving', false, false],
  ]) {
    assert.equal(matchesDownloadStatus(status, 'error'), retry, `retry: ${status}`);
    assert.equal(matchesDownloadStatus(status, 'new'), fresh, `new: ${status}`);
  }
});

test('persists the selected directory reference across database connections and replaces it', async () => {
  assert.equal(await getDownloadFolder(), undefined);
  const first = { kind: 'directory', name: 'Photos', token: 'first-directory' };
  await setDownloadFolder(first);
  assert.deepEqual(await getDownloadFolder(), first);
  const second = { kind: 'directory', name: 'Videos', token: 'second-directory' };
  await setDownloadFolder(second);
  assert.deepEqual(await getDownloadFolder(), second);
});

test('failed persistence rejects instead of reporting successful selection', async () => {
  await assert.rejects(setDownloadFolder({ kind: 'directory', name: 'Invalid', uncloneable: () => {} }));
  assert.equal((await getDownloadFolder()).name, 'Videos');
});

test('download outcomes use their own store and remain distinct between accounts', async () => {
  const folder = { kind: 'directory', name: 'Photos' };
  const first = { key: '["42","/photounlim/photo.heic"]', account: '42', id: '/photounlim/photo.heic', name: 'photo.heic', type: 'photo', status: 'success', folder, bytes: 3 };
  const second = { ...first, key: '["43","/photounlim/photo.heic"]', account: '43', status: 'error', error: 'Write failed' };
  await setDownloadResult(first);
  await setDownloadResult(second);
  assert.deepEqual(await getDownloadResult(first.key), first);
  assert.deepEqual(await getDownloadResult(second.key), second);
  assert.equal((await getDownloadFolder()).name, 'Videos');
});

test('recovers interrupted records without confusing successful or failed downloads', async () => {
  const result = { key: 'interrupted', status: 'saving', name: 'video.mov', folder: { name: 'Videos' } };
  await setDownloadResult(result);
  assert.deepEqual(await getUnfinishedDownloads(), [result]);
  await setDownloadResult({ ...result, status: 'error' });
  assert.deepEqual(await getUnfinishedDownloads(), []);
});

test('upgrading the old folder-only database preserves the selected directory', async () => {
  await new Promise((resolve, reject) => {
    const removal = indexedDB.deleteDatabase('yandex-photo-downloader');
    removal.onsuccess = resolve; removal.onerror = () => reject(removal.error);
  });
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('yandex-photo-downloader', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('settings');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put({ kind: 'directory', name: 'Existing folder' }, 'downloadFolder');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
  assert.equal((await getDownloadFolder()).name, 'Existing folder');
  await setDownloadResult({ key: 'post-upgrade', status: 'saving', folder: { name: 'Existing folder' } });
  assert.equal((await getUnfinishedDownloads())[0].key, 'post-upgrade');
});
