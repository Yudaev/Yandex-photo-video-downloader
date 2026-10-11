import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
const { code } = await transformWithOxc(readFileSync(new URL('../lib/download-diagnostics.ts', import.meta.url), 'utf8'), 'download-diagnostics.ts');
const { diagnosticUrl, diagnosticError, createDiagnosticsFile } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('diagnostics remove signed paths and credentials but retain useful file and model fields', () => {
  const url = diagnosticUrl('https://downloader.disk.yandex.ru/disk/SECRET?uid=123&filename=photo.HEIC&fsize=42&tknv=SECRET&hash=SECRET');
  assert.ok(!url.includes('SECRET'));assert.ok(!url.includes('123'));
  assert.ok(url.includes('filename=photo.HEIC'));assert.ok(url.includes('fsize=42'));
  assert.equal(diagnosticUrl('https://disk.yandex.ru/models-v2?m=mpfs/url&token=SECRET'), 'https://disk.yandex.ru/models-v2?m=mpfs%2Furl');
  assert.ok(!diagnosticError(Error('Failure: https://disk.yandex.ru/private/SECRET?token=SECRET')).includes('SECRET'));
});

function directory() {
  const files = new Map();
  let fail = false;
  let aborted = false;
  return { files, fail() { fail = true; }, get aborted() { return aborted; }, folder: {
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        files.set(name, '');
      }
      return {
        async getFile() { return new Blob([files.get(name)]); },
        async createWritable() { let text; return {
          async write(value) { text = value; },
          async close() { if (fail) throw Error('Disk full'); files.set(name, text); },
          async abort() { aborted = true; },
        }; },
      };
    },
  } };
}
const log = { format: 'yandex-download-diagnostics', version: 1, failures: [{ error: 'HTTP 500' }] };
test('automatic error log is written beside media and updated without creating another file', async () => {
  const d = directory();const file = createDiagnosticsFile(d.folder, 'test-run');
  await file.save(log);
  assert.equal(JSON.parse(d.files.get(file.name)).failures.length, 1);
  await file.save({ ...log, failures: [...log.failures, { error: 'Timeout' }] });
  assert.equal(d.files.size, 1);
  assert.equal(JSON.parse(d.files.get(file.name)).failures.length, 2);
});
test('automatic logs preserve foreign and externally changed files', async () => {
  const d = directory();const file = createDiagnosticsFile(d.folder, 'test-run');
  d.files.set(file.name, 'foreign file');
  await assert.rejects(file.save(log), /не будет перезаписан/);
  assert.equal(d.files.get(file.name), 'foreign file');
  d.files.delete(file.name);
  await file.save(log);
  d.files.set(file.name, 'edited outside extension');
  await assert.rejects(file.save(log), /не будет перезаписан/);
  assert.equal(d.files.get(file.name), 'edited outside extension');
});
test('failed automatic log update preserves the last completed log and aborts its writer', async () => {
  const d = directory();const file = createDiagnosticsFile(d.folder, 'test-run');
  await file.save(log);const old = d.files.get(file.name);
  d.fail();await assert.rejects(file.save({ ...log, failures: [] }), /Disk full/);
  assert.equal(d.files.get(file.name), old);assert.equal(d.aborted, true);
  assert.throws(() => createDiagnosticsFile(d.folder, '../unsafe'));
  await assert.rejects(file.save(undefined), /не вернул журнал/);
});
