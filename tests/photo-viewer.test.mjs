import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';
import { parseHTML } from 'linkedom';

const { code } = await transformWithOxc(readFileSync(new URL('../lib/photo-viewer.ts', import.meta.url), 'utf8'), 'photo-viewer.ts');
const { readPhotoTiles, readPhotoInfo, showDownloadMark, createPhotoTraversal, isPhotoPosition } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

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

test('repeated recovery stays near the last working position instead of restarting the feed', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, doc, win } = traversalPage();
  const timer = win.setTimeout;
  win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, 0);
  assert.equal((await traversal.start()).name, 'first.HEIC');
  assert.equal((await traversal.next()).name, 'late.MOV');
  const scroll = doc.documentElement;
  const position = Object.getOwnPropertyDescriptor(scroll, 'scrollTop');
  for (const tile of doc.querySelectorAll('.photo__item')) tile.getBoundingClientRect = () => ({ top: -300, bottom: -200 });
  let nudges = 0;
  const positions = [];
  Object.defineProperty(scroll, 'scrollTop', {
    get: position.get,
    set(value) {
      position.set(value);
      positions.push(value);
      if (value !== 300 && ++nudges === 2) {
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
  assert.ok(positions.every(top => top > 0), 'recovery must not send an old feed back to the beginning');
  assert.equal(await traversal.next(), null);
  traversal.stop();
});

function addTimeline({ doc, win }, onJump = () => {}) {
  const timeline = doc.createElement('div');
  timeline.className = 'desktop-fast-scroll__inner';
  timeline.innerHTML = '<div class="desktop-fast-scroll__month" data-month="8-2026"></div><div class="desktop-fast-scroll__month" data-month="3-2022"></div><div class="desktop-fast-scroll__month" data-month="2-2022"></div><div class="desktop-fast-scroll__scroll-pointer"></div>';
  doc.body.append(timeline);
  timeline.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 900, width: 20, height: 400 });
  const months = timeline.querySelectorAll('[data-month]');
  [100, 300, 350].forEach((top, index) => { months[index].getBoundingClientRect = () => ({ top }); });
  let pointerTop = 320;
  timeline.querySelector('.desktop-fast-scroll__scroll-pointer').getBoundingClientRect = () => ({ top: pointerTop });
  doc.defaultView.MouseEvent = class extends doc.defaultView.Event {
    constructor(type, options) { super(type, options); Object.assign(this, options); }
  };
  win.dispatchEvent = event => doc.dispatchEvent(event);
  const jumps = [];
  timeline.addEventListener('mousedown', event => {
    assert.equal(event.button, 0);
    jumps.push(event.clientY);
    pointerTop = event.clientY;
    onJump();
  });
  return { timeline, jumps, setPointer(top) { pointerTop = top; } };
}

test('position validation rejects malformed checkpoints from extension messages', () => {
  assert.equal(isPhotoPosition({ top: 900, month: '3-2022' }), true);
  assert.equal(isPhotoPosition({ top: 0 }), true);
  for (const value of [null, [], {}, { top: -1 }, { top: Infinity }, { top: '900' }, { top: 1, month: '12-2022' }, { top: 1, month: '<script>' }, { top: 1, anchor: 42 }, { top: 1, anchor: '' }, { top: 1, anchor: 'x'.repeat(4096) }]) {
    assert.equal(isPhotoPosition(value), false);
  }
});

test('resumes through the timeline before returning a file from the reloaded page', async () => {
  const page = traversalPage();
  const { traversal, doc } = page;
  const { jumps } = addTimeline(page, () => {
    const tile = doc.querySelector('.photo__item');
    tile.title = 'april.HEIC';
  });
  const item = await traversal.start({ photos: true, videos: true, account: '42', position: { top: 90000, month: '3-2022' } });
  assert.equal(item.name, 'april.HEIC');
  assert.equal(jumps.length, 1);
  assert.ok(jumps[0] <= 300 && jumps[0] >= 299, 'land before the month boundary to avoid skipping its first files');
  traversal.stop();
});

test('a timeline click ignored during page initialization is repeated before giving up', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const page = traversalPage();
  let clicks = 0;
  const { jumps } = addTimeline(page, () => {
    if (++clicks === 3) page.doc.querySelector('.photo__item').title = 'recovered.HEIC';
  });
  const timer = page.win.setTimeout;
  page.win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, 0);
  const item = await page.traversal.start({ photos: true, videos: true, account: '42', position: { top: 90000, month: '3-2022' } });
  assert.equal(item.name, 'recovered.HEIC');
  assert.equal(jumps.length, 3);
  page.traversal.stop();
});

test('an error retry can explicitly start at the top of the whole timeline', async () => {
  const page = traversalPage();
  page.doc.documentElement.scrollTop = 300;
  const { jumps } = addTimeline(page, () => { page.doc.querySelector('.photo__item').title = 'newest.HEIC'; });
  const item = await page.traversal.start({ photos: true, videos: true, position: { top: 0 } });
  assert.equal(item.name, 'newest.HEIC');
  assert.deepEqual(jumps, [100]);
  page.traversal.stop();
});

test('starting at the top also works for a short feed without a timeline', async () => {
  const page = traversalPage();
  page.doc.documentElement.scrollTop = 300;
  await page.traversal.start({ photos: true, videos: true, position: { top: 0 } });
  assert.equal(page.doc.documentElement.scrollTop, 0);
  page.traversal.stop();
});

test('a checkpoint without a month recovers by its scroll position and visible file, then adopts the restored timeline', async () => {
  const original = traversalPage();
  original.doc.documentElement.scrollTop = 300;
  const first = await original.traversal.start();
  const saved = original.traversal.diagnose().position;
  assert.equal(saved.anchor, first.key);
  original.traversal.stop();
  const page = traversalPage();
  addTimeline(page);
  const resumed = await page.traversal.start({ photos: true, videos: true, account: '42', position: saved });
  assert.equal(resumed.key, first.key);
  assert.equal(page.doc.documentElement.scrollTop, 300);
  assert.equal(page.traversal.diagnose().position.month, '3-2022');
  page.traversal.stop();
});

test('scroll fallback waits for the grid height and reapplies a position initially clamped to zero', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const page = traversalPage();
  let top = 0; let height = 100;
  const scroll = { clientHeight: 100, get scrollHeight() { return height; }, get scrollTop() { return top; }, set scrollTop(value) { top = Math.min(value, height - 100); } };
  Object.defineProperty(page.doc, 'scrollingElement', { value: scroll });
  const tile = page.doc.querySelector('.photo__item');
  const anchor = readPhotoTiles(page.doc)[0].key;
  tile.getBoundingClientRect = () => top === 300 ? { top: 10, bottom: 110 } : { top: -300, bottom: -200 };
  const timer = page.win.setTimeout;
  page.win.setTimeout = (callback, ms) => timer(() => { time += ms; if (time >= 1000) height = 500; callback(); }, 0);
  const item = await page.traversal.start({ photos: true, videos: true, account: '42', position: { top: 300, anchor } });
  assert.equal(item.key, anchor);
  assert.equal(scroll.scrollTop, 300);
  page.traversal.stop();
});

test('a scroll fallback cannot resume on different thumbnails', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const page = traversalPage();
  const timer = page.win.setTimeout;
  page.win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, 0);
  await assert.rejects(page.traversal.start({ photos: true, videos: true, account: '42', position: { top: 300, anchor: 'missing-file' } }), error => error.cause === 'page-recovery');
  assert.equal(page.traversal.diagnose().visited, 0);
});

test('an empty grid returns through its saved month and keeps the checkpoint while waiting', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const page = traversalPage();
  const { traversal, doc, win } = page;
  const tile = doc.querySelector('.photo__item');
  let blank = false;
  const { jumps } = addTimeline(page, () => { blank = false; tile.title = 'recovered.HEIC'; });
  tile.getBoundingClientRect = () => blank ? { top: -300, bottom: -200 } : { top: 10, bottom: 110 };
  const timer = win.setTimeout;
  win.setTimeout = (callback, ms) => timer(() => { time += ms; if (time > 100_000) traversal.stop(); callback(); }, 0);
  await traversal.start();
  const position = traversal.diagnose().position;
  assert.equal(position.month, '3-2022');
  blank = true;
  assert.deepEqual(traversal.diagnose().position, position);
  assert.equal((await traversal.next()).name, 'recovered.HEIC');
  assert.equal(jumps.length, 1);
  assert.equal(traversal.diagnose().scrollRecoveries, 1);
  traversal.stop();
});

test('a missing timeline stops resumption instead of downloading from the beginning', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const { traversal, win, opened } = traversalPage();
  const timer = win.setTimeout;
  win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, 0);
  await assert.rejects(traversal.start({ photos: true, videos: true, account: '42', position: { top: 90000, month: '3-2022' } }), /таймлайн/i);
  assert.deepEqual(opened, []);
});

test('a changed account cannot navigate the timeline during resumption', async () => {
  const page = traversalPage();
  const { jumps } = addTimeline(page);
  await assert.rejects(page.traversal.start({ photos: true, videos: true, account: '43', position: { top: 90000, month: '3-2022' } }), /Аккаунт/);
  assert.deepEqual(jumps, []);
});

test('a manual restart preserves the position chosen by the user on the timeline', async () => {
  const { traversal, doc } = traversalPage();
  doc.documentElement.scrollTop = 300;
  await traversal.start();
  assert.equal(doc.documentElement.scrollTop, 300);
  traversal.stop();
});

test('a sparse timeline falls back to a newer month rather than skipping past the checkpoint', async () => {
  const page = traversalPage();
  const { timeline, jumps } = addTimeline(page, () => { page.doc.querySelector('.photo__item').title = 'older.HEIC'; });
  timeline.querySelector('[data-month="3-2022"]').dataset.month = '4-2022';
  await page.traversal.start({ photos: true, videos: true, account: '42', position: { top: 90000, month: '3-2022' } });
  assert.deepEqual(jumps, [299]);
  page.traversal.stop();
});

test('moving the timeline pointer alone cannot resume while old thumbnails remain visible', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const page = traversalPage();
  addTimeline(page);
  const timer = page.win.setTimeout;
  page.win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, 0);
  await assert.rejects(page.traversal.start({ photos: true, videos: true, account: '42', position: { top: 90000, month: '3-2022' } }), /таймлайн/i);
  assert.equal(page.traversal.diagnose().visited, 0);
});

test('stopping while waiting for a reloaded timeline prevents navigation and downloads', async () => {
  const page = traversalPage();
  const timer = page.win.setTimeout;
  page.win.setTimeout = (callback, ms) => timer(() => { page.traversal.stop(); callback(); }, 0);
  await assert.rejects(page.traversal.start({ photos: true, videos: true, account: '42', position: { top: 90000, month: '3-2022' } }), /остановлено/);
  assert.equal(page.traversal.diagnose().visited, 0);
  assert.deepEqual(page.opened, []);
});

test('the chosen month survives a feed that is empty from the start', async () => {
  const page = traversalPage();
  addTimeline(page);
  page.doc.getElementById('tiles').replaceChildren();
  const timer = page.win.setTimeout;
  let saved;
  page.win.setTimeout = (callback, ms) => timer(() => { saved = page.traversal.diagnose().position; page.traversal.stop(); callback(); }, 0);
  await assert.rejects(page.traversal.start(), /остановлено/);
  assert.equal(saved?.month, '3-2022');
});

test('failed timeline refreshes keep waiting so the panel can reload after three minutes', async ({ mock }) => {
  let time = 0; mock.method(Date, 'now', () => time);
  const page = traversalPage();
  const tile = page.doc.querySelector('.photo__item');
  const { jumps } = addTimeline(page);
  await page.traversal.start();
  tile.getBoundingClientRect = () => ({ top: -300, bottom: -200 });
  const timer = page.win.setTimeout;
  page.win.setTimeout = (callback, ms) => timer(() => {
    time += ms;
    if (time >= 181_000) page.traversal.stop();
    callback();
  }, 0);
  await assert.rejects(page.traversal.next(), /остановлено/);
  assert.ok(time >= 181_000);
  assert.ok(jumps.length >= 2);
  assert.equal(page.traversal.diagnose().position.month, '3-2022');
});

test('content messages validate incoming checkpoints and return the new checkpoint to the panel', async () => {
  const source = readFileSync(new URL('../entrypoints/photo.content.ts', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.slice(source.indexOf('    const handleMessage ='), source.indexOf('    browser.runtime.onMessage')), 'photo-message.ts');
  const calls = [];
  const position = { top: 100, month: '3-2022' };
  const handler = runInNewContext(`${code}\nhandleMessage`, {
    browser: { runtime: { id: 'extension' } }, isPhotoPosition,
    traversal: { async start(options) { calls.push(options); return { name: 'photo.HEIC' }; }, diagnose() { return { position }; } },
  });
  let response;
  for (const input of [{ top: -1 }, { top: 100, month: '12-2022' }]) {
    handler({ type: 'photo-traversal', action: 'start', account: '42', position: input }, { id: 'extension' }, result => { response = result; });
    assert.match(response.error, /Некорректное/);
  }
  handler({ type: 'photo-traversal', action: 'start', position, visited: ['already-processed'] }, { id: 'extension' }, result => { response = result; });
  assert.match(response.error, /Некорректное/);
  assert.equal(calls.length, 0);
  handler({ type: 'photo-traversal', action: 'start', account: '42', position }, { id: 'extension' }, result => { response = result; });
  await Promise.resolve();
  assert.equal(calls[0].position.month, '3-2022');
  assert.equal(response.position.month, '3-2022');
  assert.equal(response.item.name, 'photo.HEIC');
  handler({ type: 'photo-traversal', action: 'start', visited: [], position }, { id: 'extension' }, result => { response = result; });
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(response.item.name, 'photo.HEIC');
});

test('content messages distinguish recoverable traversal failures from account and cancellation errors', async () => {
  const source = readFileSync(new URL('../entrypoints/photo.content.ts', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('    const handleMessage ='), source.indexOf('    browser.runtime.onMessage.addListener'));
  const { code } = await transformWithOxc(start, 'content-message.ts');
  const position = { top: 90000, month: '3-2022' };
  for (const cause of ['page-recovery', undefined]) {
    const handler = runInNewContext(`${code}\nhandleMessage`, {
      Error, browser: { runtime: { id: 'extension' } }, isPhotoPosition,
      traversal: { async next() { throw new Error('Fixture error', { cause }); }, diagnose() { return { position, unresolvedCount: 1, unresolvedPosition: position }; } },
    });
    let response;
    handler({ type: 'photo-traversal', action: 'next' }, { id: 'extension' }, result => { response = result; });
    await Promise.resolve();
    assert.equal(response.retryable, cause === 'page-recovery');
    assert.equal(response.unresolvedCount, 1);
    assert.deepEqual(response.unresolvedPosition, position);
    assert.deepEqual(response.position, position);
  }
});

test('an initially empty run can restore its month before the account was identified', async () => {
  const page = traversalPage();
  addTimeline(page, () => { page.doc.querySelector('.photo__item').title = 'april.HEIC'; });
  const item = await page.traversal.start({ photos: true, videos: true, visited: [], position: { top: 90000, month: '3-2022' } });
  assert.equal(item.name, 'april.HEIC');
  assert.equal(item.account, '42');
  page.traversal.stop();
  await assert.rejects(page.traversal.start({ photos: true, videos: true, visited: ['already-processed'], position: { top: 90000, month: '3-2022' } }), /Некорректное/);
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
  const page = traversalPage();
  const { traversal, doc, win } = page;
  const { setPointer } = addTimeline(page);
  const timer = win.setTimeout;
  win.setTimeout = (callback, ms) => timer(() => { time += ms; callback(); }, ms);
  const unknown = doc.createElement('div'); unknown.className = 'photo__item'; unknown.title = 'broken.MOV';
  unknown.setAttribute('aria-label', 'Видео broken.MOV');
  unknown.getBoundingClientRect = () => ({ top: 120, bottom: 220 });
  doc.getElementById('tiles').append(unknown);
  assert.equal((await traversal.start()).name, 'first.HEIC');
  assert.equal((await traversal.next()).name, 'late.MOV');
  setPointer(360);
  assert.equal(await traversal.next(), null);
  assert.equal(traversal.diagnose().unresolvedCount, 1);
  assert.equal(traversal.diagnose().unresolvedPosition.month, '3-2022', 'next pass must include the first unidentified file');
  assert.equal(unknown.querySelector('[data-ypvd-mark]').dataset.status, 'error');
  assert.equal(traversal.diagnose().unresolved[0].name, 'broken.MOV');
  traversal.stop();
});
