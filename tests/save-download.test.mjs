import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';

const { code } = await transformWithOxc(readFileSync(new URL('../lib/save-download.ts', import.meta.url), 'utf8'), 'save-download.ts');
const { saveDownload, canReuseDownload, parseYandexDate } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function directory() {
  const files = new Map();
  let aborted = false;
  let failClose = false;
  const folder = {
    async isSameEntry(other) { return other === folder; },
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { return Object.assign(new Blob([files.get(name)]), { lastModified: 123 }); },
        async createWritable() {
          const chunks = [];
          return {
            async write(chunk) { chunks.push(chunk); },
            async close() { if (failClose) throw Error('Disk full'); files.set(name, new Uint8Array(chunks.flatMap(c => [...c]))); },
            async abort() { aborted = true; },
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
  return { folder, files, get aborted() { return aborted; }, fail() { failClose = true; } };
}
const url = 'https://downloader.disk.yandex.ru/disk/original?filename=photo.heic';
const fetcher = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3', 'content-type': 'image/heic' } });

test('streams original and reports success only after closing and checking the saved file', async () => {
  const d = directory();
  const result = await saveDownload(d.folder, 'photo.heic', url, new AbortController().signal, fetcher);
  assert.equal(result.bytes, 3);
  assert.equal(result.savedName, 'photo.heic');
  assert.deepEqual([...d.files.get('photo.heic')], [1, 2, 3]);
});

test('does not overwrite existing names', async () => {
  const d = directory();
  d.files.set('photo.heic', new Uint8Array([9]));
  const result = await saveDownload(d.folder, 'photo.heic', url, new AbortController().signal, fetcher);
  assert.equal(result.savedName, 'photo (2).heic');
  assert.deepEqual([...d.files.get('photo.heic')], [9]);
});

test('failed close aborts and removes its empty placeholder', async () => {
  const d = directory(); d.fail();
  await assert.rejects(saveDownload(d.folder, 'photo.heic', url, new AbortController().signal, fetcher), /Disk full/);
  assert.equal(d.aborted, true);
  assert.equal(d.files.has('photo.heic'), false);
});

test('rejects error documents, invalid filenames, untrusted URLs and truncated bodies', async () => {
  const d = directory();
  const signal = new AbortController().signal;
  await assert.rejects(saveDownload(d.folder, '../photo.heic', url, signal, fetcher));
  await assert.rejects(saveDownload(d.folder, 'photo.heic', 'https://evil.test/original', signal, fetcher));
  await assert.rejects(saveDownload(d.folder, 'photo.heic', url, signal, async () => new Response('<html>Error</html>', { headers: { 'content-type': 'text/html' } })));
  await assert.rejects(saveDownload(d.folder, 'photo.heic', url, signal, async () => new Response(new Uint8Array([1]), { headers: { 'content-length': '3' } })));
  assert.equal(d.files.size, 0);
});

test('cancelled jobs cannot produce a successful file', async () => {
  const d = directory(); const controller = new AbortController(); controller.abort();
  await assert.rejects(saveDownload(d.folder, 'photo.heic', url, controller.signal, fetcher), { name: 'AbortError' });
  assert.equal(d.files.size, 0);
});

test('reuse requires the same source metadata, folder and an unchanged existing file', async () => {
  const d = directory();
  d.files.set('photo.heic', new Uint8Array([1, 2, 3]));
  const item = { id: '/photounlim/photo.heic', created: '01.01.2020 10:00', modified: '01.01.2020 10:00' };
  const previous = { ...item, status: 'success', folder: d.folder, savedName: 'photo.heic', bytes: 3, localModified: 123 };
  assert.equal(await canReuseDownload(d.folder, item, previous), true);
  assert.equal(await canReuseDownload(directory().folder, item, previous), false);
  assert.equal(await canReuseDownload(d.folder, { ...item, key: 'another' }, previous), false);
  assert.equal(await canReuseDownload(d.folder, { ...item, modified: '02.01.2020 10:00' }, previous), false);
  assert.equal(await canReuseDownload(d.folder, item, { ...previous, localModified: 124 }), false);
  d.files.delete('photo.heic');
  assert.equal(await canReuseDownload(d.folder, item, previous), false);
});

test('encoded response length does not falsely reject a decompressed original', async () => {
  const d = directory();
  const result = await saveDownload(d.folder, 'photo.heic', url, new AbortController().signal,
    async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '10', 'content-encoding': 'gzip' } }));
  assert.equal(result.bytes, 3);
});

test('applying exported modification date does not redownload a verified original; invalid dates are rejected', async () => {
  const item={id:'/photounlim/photo.heic', name:'photo.heic', account:'account', type:'photo', created:'19.09.2026 15:23',modified:'19.09.2026 15:24'};
  const folder={async isSameEntry(other){return folder===other;},async getFileHandle(){return {async getFile(){return {size:3,lastModified:parseYandexDate(item.modified)};}};}};
  const previous={...item,status:'success',folder,savedName:'photo.heic',bytes:3,localModified:123};
  assert.equal(await canReuseDownload(folder,item,previous),true);
  assert.equal(await canReuseDownload(folder,{...item, name:'other.heic'},previous),false);
  assert.ok(Number.isNaN(parseYandexDate('31.02.2026 15:00')));
  assert.ok(Number.isNaN(parseYandexDate('not a date')));
});

test('stalled response headers time out without aborting the whole job', async ({mock}) => {
  mock.timers.enable({apis:['setTimeout']});
  const d=directory();const job=new AbortController();let failure;let requestSignal;
  const pending=saveDownload(d.folder,'stalled.heic',url,job.signal,async (_url,options)=>{
    requestSignal=options.signal;
    return new Promise(()=>{});
  }).catch(error=>{failure=error;});
  mock.timers.tick(30_000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(failure?.message ?? '',/30 секунд/);
  assert.equal(requestSignal.aborted,true);
  assert.equal(job.signal.aborted,false);
  assert.equal(d.files.size,0);
  await pending;
});

test('stalled stream times out, removes incomplete file and permits the next file even if stream cancellation hangs', async ({mock}) => {
  mock.timers.enable({apis:['setTimeout']});
  const d=directory();const job=new AbortController();let failure;
  const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));},cancel(){return new Promise(()=>{});}});
  const pending=saveDownload(d.folder,'stalled.heic',url,job.signal,async()=>new Response(body)).catch(error=>{failure=error;});
  await new Promise(resolve=>setImmediate(resolve));
  mock.timers.tick(30_000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(failure?.message ?? '',/30 секунд/);
  assert.equal(d.aborted,true);
  assert.equal(d.files.has('stalled.heic'),false);
  await pending;
  const next=await saveDownload(d.folder,'next.heic',url,job.signal,fetcher);
  assert.equal(next.bytes,3);
});

test('stop interrupts a stalled response immediately', async () => {
  const d=directory();const job=new AbortController();let failure;
  const pending=saveDownload(d.folder,'stalled.heic',url,job.signal,async()=>new Promise(()=>{})).catch(error=>{failure=error;});
  job.abort();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(failure?.name,'AbortError');
  assert.equal(d.files.size,0);
  await pending;
});

test('continuous data may take longer than 30 seconds without timing out', async ({mock}) => {
  mock.timers.enable({apis:['setTimeout']});
  const d=directory();let stream;let failure;
  const body=new ReadableStream({start(controller){stream=controller;}});
  const pending=saveDownload(d.folder,'slow.heic',url,new AbortController().signal,async()=>new Response(body)).catch(error=>{failure=error;});
  await new Promise(resolve=>setImmediate(resolve));
  for(let n=0;n<3;n++) {
    mock.timers.tick(20_000);
    stream.enqueue(new Uint8Array([n]));
    await new Promise(resolve=>setImmediate(resolve));
  }
  stream.close();
  const result=await pending;
  assert.equal(failure,undefined);
  assert.equal(result.bytes,3);
});

test('an existing identical original is adopted without leaving a duplicate', async () => {
  const d = directory();
  d.files.set('photo.heic', new Uint8Array([1, 2, 3]));
  const result = await saveDownload(d.folder, 'photo.heic', url, new AbortController().signal, fetcher);
  assert.equal(result.reused, true);
  assert.equal(result.savedName, 'photo.heic');
  assert.equal(d.files.size, 1);
  assert.deepEqual([...d.files.get('photo.heic')], [1, 2, 3]);
});

test('an unrelated existing file of the same size is preserved and is not adopted', async () => {
  const d = directory();
  d.files.set('photo.heic', new Uint8Array([9, 2, 3]));
  const result = await saveDownload(d.folder, 'photo.heic', url, new AbortController().signal, fetcher);
  assert.equal(result.reused, undefined);
  assert.equal(result.savedName, 'photo (2).heic');
  assert.deepEqual([...d.files.get('photo.heic')], [9, 2, 3]);
  assert.deepEqual([...d.files.get(result.savedName)], [1, 2, 3]);
});

test('records a bounded sanitized HTTP error body without writing a file', async () => {
  const d = directory(); const trace = [];
  await assert.rejects(saveDownload(d.folder, 'photo.heic', url, new AbortController().signal,
    async () => new Response('Storage unavailable https://host/disk/SECRET?token=SECRET token=SECRET ' + 'x'.repeat(5000), { status: 500, headers: { 'content-type': 'text/plain' } }),
    () => {}, event => trace.push(event)), /HTTP 500/);
  assert.equal(trace[0].status, 500);
  assert.match(trace[0].body, /Storage unavailable/);
  assert.ok(!JSON.stringify(trace).includes('SECRET'));
  assert.ok(trace[0].body.length <= 2048);
  assert.equal(d.files.size, 0);
});

test('native HTTP 500 retries a distinct digest once and saves the original', async () => {
  const d = directory(); const trace = []; const requests = [];
  const digest = 'https://downloader.disk.yandex.ru/disk/digest?filename=photo.heic';
  const result = await saveDownload(d.folder, 'photo.heic', url, new AbortController().signal,
    async link => { requests.push(link); return link === url ? new Response('Storage error', { status: 500, headers: { 'content-type': 'text/plain' } }) : fetcher(); },
    () => {}, event => trace.push(event), digest);
  assert.deepEqual(requests, [url, digest]);
  assert.equal(result.bytes, 3);
  assert.deepEqual(trace.map(event => event.event), ['original-response-error', 'api-retry', 'api-retry-succeeded']);
});

test('failed digest retains both HTTP responses and never loops or writes an error document', async () => {
  const d = directory(); const trace = []; let requests = 0;
  await assert.rejects(saveDownload(d.folder, 'photo.heic', url, new AbortController().signal,
    async () => { requests++; return new Response('Unavailable', { status: 500, headers: { 'content-type': 'text/plain' } }); },
    () => {}, event => trace.push(event), 'https://downloader.disk.yandex.ru/disk/digest?filename=photo.heic'), /HTTP 500/);
  assert.equal(requests, 2);
  assert.equal(trace.filter(event => event.event === 'original-response-error').length, 2);
  assert.equal(d.files.size, 0);
});

test('disk failures do not retry and untrusted digest cannot be requested', async () => {
  const d = directory(); d.fail(); let requests = 0;
  const digest = 'https://downloader.disk.yandex.ru/disk/digest?filename=photo.heic';
  await assert.rejects(saveDownload(d.folder, 'photo.heic', url, new AbortController().signal,
    async () => { requests++; return fetcher(); }, () => {}, () => {}, digest), /Disk full/);
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(saveDownload(directory().folder, 'photo.heic', url, new AbortController().signal,
    async () => { requests++; return new Response('Unavailable', { status: 500 }); }, () => {}, () => {}, 'https://evil.test/disk/file'), /Неизвестный адрес/);
  assert.equal(requests, 1);
});
