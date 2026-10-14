import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { parseHTML } from 'linkedom';

const { code } = await transformWithOxc(readFileSync(new URL('../lib/photo-viewer.ts', import.meta.url), 'utf8'), 'photo-viewer.ts');
const { readPhotoTiles, readPhotoInfo, showDownloadMark, createPhotoTraversal } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function fixture(account = '42') {
  return parseHTML(`<html><body><div class="photo__item photo__item_photounlim" title="video.MOV" aria-label="Видео video.MOV"><img src="//1.downloader.disk.yandex.ru/preview/hash/inf/token?uid=${account}" /></div>
    <div class="photo__item photo__item_photounlim" title="missing.HEIC" aria-label="Фото missing.HEIC"></div>
    <div class="photo__item" title="normal.JPG" aria-label="Фото normal.JPG"><img src="//downloader.disk.yandex.ru/preview/normal-hash/inf/token?uid=${account}" /></div>
    <div class="ufo-resource-info-dropdown">
    <div><span class="ufo-resource-info-dropdown__title">Имя: </span><span>video.MOV</span></div>
    <div><span class="ufo-resource-info-dropdown__title">Создан: </span><span>19.09.2026 15:23</span></div>
    <div><span class="ufo-resource-info-dropdown__title">Изменён: </span><span>19.09.2026 15:24</span></div>
    <div><span class="ufo-resource-info-dropdown__title">Размер: </span><span>77,4 МБ</span></div>
    </div></body></html>`).document;
}

test('identifies unlimited files even without a preview image and separates account histories', () => {
  const tiles = readPhotoTiles(fixture());
  assert.equal(tiles.length, 3);
  assert.equal(tiles[0].type, 'video');
  assert.equal(tiles[1].key, JSON.stringify(['42', '/photounlim/missing.HEIC']));
  assert.equal(tiles[2].key, JSON.stringify(['42', '/preview/normal-hash/normal.JPG']));
  assert.notEqual(tiles[0].key, readPhotoTiles(fixture('43'))[0].key);
});

test('reads real info rows, not preview errors; refuses incomplete metadata', () => {
  const doc = fixture();
  const href = 'https://disk.yandex.ru/client/photo?dialog=slider&idDialog=%2Fphotounlim%2Fvideo.MOV';
  assert.deepEqual(readPhotoInfo(doc, href), { id: '/photounlim/video.MOV', name: 'video.MOV', created: '19.09.2026 15:23', modified: '19.09.2026 15:24', sizeLabel: '77,4 МБ' });
  doc.querySelector('.ufo-resource-info-dropdown').lastElementChild.previousElementSibling.remove();
  assert.equal(readPhotoInfo(doc, href), undefined);
});

test('marks unloaded thumbnails once, changes failure to success, and preserves selection controls', () => {
  const tile = readPhotoTiles(fixture())[1].element;
  showDownloadMark(tile, 'error', 'Не сохранён');
  showDownloadMark(tile, 'success', 'Сохранён');
  assert.equal(tile.querySelectorAll('[data-ypvd-mark]').length, 1);
  assert.equal(tile.querySelector('[data-ypvd-mark]').textContent, '✓');
  assert.equal(tile.querySelector('[data-ypvd-mark]').style.pointerEvents, 'none');
});

function traversalPage() {
  const doc = parseHTML('<html><body><div id="tiles"></div></body></html>').document;
  const win = { location: { href: 'https://disk.yandex.ru/client/photo', pathname: '/client/photo' }, innerHeight: 500,
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 4)) };
  const opened = [];
  function addTile(name, type = 'photo') {
    const tile = doc.createElement('div');
    tile.className = 'photo__item photo__item_photounlim';
    tile.title = name;
    tile.setAttribute('aria-label', `${type === 'video' ? 'Видео' : 'Фото'} ${name}`);
    tile.innerHTML = '<img src="//downloader.disk.yandex.ru/preview/hash/inf/token?uid=42">';
    tile.getBoundingClientRect = () => ({ top: 10, bottom: 110 });
    tile.addEventListener('click', () => {
      opened.push(name);
      win.location.href = `https://disk.yandex.ru/client/photo?idDialog=${encodeURIComponent(`/photounlim/${name}`)}`;
      const slider = doc.createElement('div'); slider.className = 'slider';
      slider.innerHTML = '<button aria-label="Информация"></button><button aria-label="Закрыть"></button>';
      slider.querySelector('[aria-label="Информация"]').addEventListener('click', () => {
        const info = doc.createElement('div'); info.className = 'ufo-resource-info-dropdown';
        info.innerHTML = [['Имя', name], ['Создан', '19.09.2026 15:23'], ['Изменён', '19.09.2026 15:23']]
          .map(([title, value]) => `<div><span class="ufo-resource-info-dropdown__title">${title}:</span><span>${value}</span></div>`).join('');
        doc.body.append(info);
      });
      slider.querySelector('[aria-label="Закрыть"]').addEventListener('click', () => {
        slider.remove(); doc.querySelector('.ufo-resource-info-dropdown')?.remove();
        win.location.href = 'https://disk.yandex.ru/client/photo';
      });
      doc.body.append(slider);
    });
    doc.getElementById('tiles').append(tile);
    return tile;
  }
  addTile('first.HEIC');
  let top = 0; let appended = false;
  Object.defineProperties(doc.documentElement, {
    scrollHeight: { get: () => 800 }, clientHeight: { get: () => 500 },
    scrollTop: { configurable: true, get: () => top, set: value => {
      top = Math.min(value, 300);
      if (top > 0 && !appended) { appended = true; setTimeout(() => addTile('late.MOV', 'video'), 1); }
    } },
  });
  return { doc, win, opened, traversal: createPhotoTraversal(doc, win) };
}

test('traverses delayed virtual-grid items exactly once and finishes only at a stable bottom', async () => {
  const { traversal, opened } = traversalPage();
  const first = await traversal.start();
  assert.equal(first.name, 'first.HEIC');
  assert.deepEqual(opened, []);
  assert.equal((await traversal.open(first.key)).created, '19.09.2026 15:23');
  const second = await traversal.next();
  assert.equal(second.name, 'late.MOV');
  await traversal.open(second.key);
  assert.equal(await traversal.next(), null);
  assert.deepEqual(opened, ['first.HEIC', 'late.MOV']);
  traversal.stop();
  await assert.rejects(traversal.next(), /остановлено/);
});

test('recovers an empty visible grid after scrolling without returning visited files again', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, 0);
  const scroll = doc.documentElement;
  const position = Object.getOwnPropertyDescriptor(scroll, 'scrollTop');
  const first = doc.querySelector('.photo__item');
  let blank = false; let failedOnce = false; let top = 0;
  first.getBoundingClientRect = () => blank ? { top: -300, bottom: -200 } : { top: 10, bottom: 110 };
  Object.defineProperty(scroll, 'scrollTop', {
    get: () => top,
    set(value) {
      top = Math.min(value, 300);
      if (value > 0 && !failedOnce) { failedOnce = true; blank = true; return; }
      if (value === 0) blank = false;
      position.set(value);
    },
  });
  assert.equal((await traversal.start()).name, 'first.HEIC');
  assert.equal((await traversal.next()).name, 'late.MOV');
  assert.equal(await traversal.next(), null);
  assert.equal(traversal.diagnose().scrollRecoveries, 1);
  traversal.stop();
});

test('waits through repeated empty-grid timeouts and continues when the feed returns', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  await traversal.start();
  const first = doc.querySelector('.photo__item');
  first.getBoundingClientRect = () => ({ top: -300, bottom: -200 });
  let showedWaiting = false;
  win.setTimeout = (callback, ms) => timer(() => {
    time += ms;
    showedWaiting ||= traversal.diagnose().waitingForPhotos === true;
    for (const tile of doc.querySelectorAll('.photo__item')) {
      tile.getBoundingClientRect = () => time > 125_000 ? { top: 10, bottom: 110 } : { top: -300, bottom: -200 };
    }
    callback();
  }, 0);
  assert.equal((await traversal.next()).name, 'late.MOV');
  assert.ok(traversal.diagnose().scrollRecoveries >= 4);
  assert.equal(showedWaiting, true);
  assert.equal(traversal.diagnose().waitingForPhotos, false);
  assert.equal(traversal.diagnose().visited, 2);
  traversal.stop();
});

test('an initially empty feed waits beyond 30 seconds and can be stopped', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  doc.getElementById('tiles').replaceChildren();
  win.setTimeout = (callback, ms) => timer(() => {
    time += ms;
    doc.getElementById('tiles').replaceChildren();
    if (time > 95_000) traversal.stop();
    callback();
  }, 0);
  await assert.rejects(traversal.start(), /остановлено/);
  assert.ok(time > 95_000);
  assert.equal(traversal.diagnose().waitingForPhotos, false);
});

test('recovery at the top changes scroll position to wake the virtual grid', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  await traversal.start();
  const first = doc.querySelector('.photo__item');
  first.getBoundingClientRect = () => ({ top: -300, bottom: -200 });
  const scroll = doc.documentElement;
  const position = Object.getOwnPropertyDescriptor(scroll, 'scrollTop');
  let moved = false;
  Object.defineProperty(scroll, 'scrollTop', {
    get: position.get,
    set(value) {
      position.set(value);
      if (value > 0) { moved = true; first.getBoundingClientRect = () => ({ top: 10, bottom: 110 }); }
    },
  });
  win.setTimeout = (callback, ms) => timer(() => {
    time += ms;
    if (time > 125_000) traversal.stop();
    callback();
  }, 0);
  assert.equal((await traversal.next()).name, 'late.MOV');
  assert.equal(moved, true);
  assert.equal(traversal.diagnose().scrollRecoveries, 1);
  traversal.stop();
});

test('falls back to the top when restoring the last visible position does not repair the grid', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, 0);
  assert.equal((await traversal.start()).name, 'first.HEIC');
  assert.equal((await traversal.next()).name, 'late.MOV');
  const scroll = doc.documentElement;
  const position = Object.getOwnPropertyDescriptor(scroll, 'scrollTop');
  for (const tile of doc.querySelectorAll('.photo__item')) tile.getBoundingClientRect = () => ({ top: -300, bottom: -200 });
  let returnsToTop = 0;
  Object.defineProperty(scroll, 'scrollTop', {
    get: position.get,
    set(value) {
      position.set(value);
      if (value === 0 && ++returnsToTop === 2) {
        const tile = doc.querySelector('.photo__item').cloneNode(true);
        tile.title = 'recovered.HEIC';
        tile.getBoundingClientRect = () => ({ top: 10, bottom: 110 });
        doc.getElementById('tiles').append(tile);
      }
    },
  });
  assert.equal((await traversal.next()).name, 'recovered.HEIC');
  assert.equal(traversal.diagnose().visited, 3);
  assert.equal(traversal.diagnose().scrollRecoveries, 2);
  assert.equal(await traversal.next(), null);
  traversal.stop();
});

test('an account change with no visible tiles halts without recovery', async () => {
  const { traversal, doc } = traversalPage();
  await traversal.start();
  const tile = doc.querySelector('.photo__item');
  tile.querySelector('img').src = '//downloader.disk.yandex.ru/preview/hash/inf/token?uid=43';
  tile.getBoundingClientRect = () => ({ top: -300, bottom: -200 });
  await assert.rejects(traversal.next(), /Аккаунт Яндекса изменился/);
  assert.equal(traversal.diagnose().scrollRecoveries, 0);
  traversal.stop();
});

test('stopping while waiting for an empty grid prevents recovery scrolling', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  await traversal.start();
  doc.querySelector('.photo__item').getBoundingClientRect = () => ({ top: -300, bottom: -200 });
  win.setTimeout = (callback, ms) => timer(() => { time += ms; traversal.stop(); callback(); }, 0);
  await assert.rejects(traversal.next(), /остановлено/);
  assert.equal(traversal.diagnose().scrollRecoveries, 0);
  assert.equal(doc.documentElement.scrollTop, 0);
});

test('filters excluded types without opening them', async () => {
  const { traversal, opened } = traversalPage();
  assert.equal((await traversal.start({ photos: false, videos: true })).name, 'late.MOV');
  assert.equal(await traversal.next(), null);
  assert.deepEqual(opened, []);
  traversal.stop();
});

test('account changes halt traversal instead of sharing another account history', async () => {
  const { traversal, doc } = traversalPage();
  await traversal.start();
  doc.querySelector('.photo__item img').src = '//downloader.disk.yandex.ru/preview/hash/inf/token?uid=43';
  await assert.rejects(traversal.next(), /Аккаунт Яндекса изменился/);
  traversal.stop();
});

test('stopping an idle integration leaves a manually opened viewer alone', () => {
  const { traversal, doc } = traversalPage();
  const slider = doc.createElement('div'); slider.className = 'slider';
  slider.innerHTML = '<button aria-label="Закрыть"></button>';
  let closed = false;
  slider.querySelector('button').addEventListener('click', () => { closed = true; });
  doc.body.append(slider);
  traversal.stop();
  assert.equal(closed, false);
});

test('already saved candidates can be skipped without opening any viewer', async () => {
  const { traversal, opened } = traversalPage();
  const first = await traversal.start();
  assert.equal(first.name, 'first.HEIC');
  const second = await traversal.next();
  assert.equal(second.name, 'late.MOV');
  assert.equal(await traversal.next(), null);
  assert.deepEqual(opened, []);
  traversal.stop();
});

test('resuming after reload skips previously attempted files and retains the original account', async () => {
  const { traversal } = traversalPage();
  assert.equal((await traversal.start({ photos: true, videos: true, account: '42', visited: [JSON.stringify(['42', '/photounlim/first.HEIC'])] })).name, 'late.MOV');
  assert.equal(await traversal.next(), null);
  traversal.stop();
  await assert.rejects(traversal.start({ photos: true, videos: true, account: '43', visited: [] }), /Аккаунт Яндекса изменился/);
});

test('refuses to open a different candidate than the one being checked', async () => {
  const { traversal, opened } = traversalPage();
  await traversal.start();
  await assert.rejects(traversal.open('another-file'), /Фотолента изменилась/);
  assert.deepEqual(opened, []);
  traversal.stop();
});

test('diagnostics retain traversal and viewport state without preview URLs', async () => {
  const { traversal } = traversalPage();
  await traversal.start();
  const state = traversal.diagnose();
  assert.equal(state.visited, 1);
  assert.equal(state.account, '42');
  assert.equal(state.identified, 1);
  assert.equal(state.visible, 1);
  assert.equal(state.viewerOpen, false);
  assert.ok(!JSON.stringify(state).includes('https://'));
  traversal.stop();
});

test('an ordinary file without preview no longer blocks known tiles and is identified from viewer information', async () => {
  const { traversal, doc, opened } = traversalPage();
  const unknown = doc.querySelector('.photo__item');
  unknown.classList.remove('photo__item_photounlim');
  unknown.querySelector('img').src = '//downloader.disk.yandex.ru/broken?uid=42';
  const known = unknown.cloneNode(true);
  known.title = 'known.HEIC'; known.classList.add('photo__item_photounlim');
  known.getBoundingClientRect = () => ({ top: 120, bottom: 220 });
  doc.getElementById('tiles').append(known);
  assert.equal((await traversal.start()).name, 'known.HEIC');
  const recovered = await traversal.next();
  assert.equal(recovered.name, 'first.HEIC');
  assert.equal(recovered.key, JSON.stringify(['42', '/photounlim/first.HEIC']));
  assert.equal(recovered.created, '19.09.2026 15:23');
  assert.equal(readPhotoTiles(doc).find(tile => tile.element === unknown).key, recovered.key);
  assert.deepEqual(opened, ['first.HEIC']);
  assert.equal((await traversal.next()).name, 'late.MOV');
  assert.equal(await traversal.next(), null);
  traversal.stop();
});

test('an unidentifiable file is marked and reported after the rest of the feed, not at its position', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, ms);
  const unknown = doc.createElement('div'); unknown.className = 'photo__item'; unknown.title = 'broken.MOV';
  unknown.setAttribute('aria-label', 'Видео broken.MOV');
  unknown.getBoundingClientRect = () => ({ top: 120, bottom: 220 });
  doc.getElementById('tiles').append(unknown);
  assert.equal((await traversal.start()).name, 'first.HEIC');
  assert.equal((await traversal.next()).name, 'late.MOV');
  await assert.rejects(traversal.next(), /Фотолента обработана, но не удалось определить 1 файлов/);
  assert.equal(unknown.querySelector('[data-ypvd-mark]').dataset.status, 'error');
  assert.equal(traversal.diagnose().unresolved[0].name, 'broken.MOV');
  traversal.stop();
});
