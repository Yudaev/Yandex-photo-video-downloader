import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { parseHTML } from 'linkedom';

const source = readFileSync(new URL('../lib/photo-button.ts', import.meta.url), 'utf8');
const { code: compiled } = await transformWithOxc(source, 'photo-button.ts');
const { syncPhotoButton } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function page() {
  return parseHTML('<html><body><aside><button id="upload"><span>Загрузить</span></button><button>Создать</button></aside></body></html>').document;
}
const sync = (doc, path = '/client/photo') => syncPhotoButton(doc, path, 'icon.png', async () => {});

test('inserts one branded button above Upload and restores it after sidebar replacement', () => {
  const doc = page();
  sync(doc);
  sync(doc);
  assert.equal(doc.querySelectorAll('#yandex-photo-downloader').length, 1);
  assert.equal(doc.getElementById('upload').previousElementSibling.id, 'yandex-photo-downloader');
  assert.equal(doc.getElementById('yandex-photo-downloader').shadowRoot.querySelector('button').textContent.trim(), 'Скачать все');
  doc.querySelector('aside').innerHTML = '<button id="upload">Загрузить</button>';
  sync(doc);
  assert.equal(doc.getElementById('upload').previousElementSibling.id, 'yandex-photo-downloader');
});

test('opens the native panel through the supplied callback without injecting an overlay', async () => {
  const doc = page();
  let opened = 0;
  syncPhotoButton(doc, '/client/photo', 'icon.png', async () => { opened++; });
  const root = doc.getElementById('yandex-photo-downloader').shadowRoot;
  assert.equal(root.querySelector('aside'), null);
  root.querySelector('button').click();
  await Promise.resolve();
  assert.equal(opened, 1);
});

test('reports failure to open the panel and permits retry', async () => {
  const doc = page();
  syncPhotoButton(doc, '/client/photo', 'icon.png', async () => { throw new Error('Unavailable'); });
  const root = doc.getElementById('yandex-photo-downloader').shadowRoot;
  root.querySelector('button').click();
  await Promise.resolve();
  assert.match(root.querySelector('[role="status"]').textContent, /Не удалось/);
  assert.equal(root.querySelector('button').disabled, false);
});

test('only displays on Photos and handles late arrival of Upload', () => {
  const doc = page();
  sync(doc, '/client/disk');
  assert.equal(doc.getElementById('yandex-photo-downloader'), null);
  sync(doc);
  sync(doc, '/client/albums');
  assert.equal(doc.getElementById('yandex-photo-downloader'), null);
  doc.querySelector('aside').innerHTML = '';
  sync(doc);
  assert.equal(doc.getElementById('yandex-photo-downloader'), null);
  doc.querySelector('aside').innerHTML = '<button id="upload">Загрузить</button>';
  sync(doc);
  assert.ok(doc.getElementById('yandex-photo-downloader'));
});
