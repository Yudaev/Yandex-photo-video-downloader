import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, statSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';

const save = await transformWithOxc(readFileSync(new URL('../lib/save-download.ts', import.meta.url), 'utf8'), 'save-download.ts');
const saveUrl = `data:text/javascript;base64,${Buffer.from(save.code).toString('base64')}`;
let source = readFileSync(new URL('../lib/download-metadata.ts', import.meta.url), 'utf8');
source = source.replace("'./save-download'", JSON.stringify(saveUrl));
source = source.replace(/import (\w+) from '\.\/date-scripts\/([^']+)\?raw';/g, (_, name, file) => `const ${name} = ${JSON.stringify(readFileSync(new URL('../lib/date-scripts/'+file, import.meta.url), 'utf8'))};`);
const transformed = await transformWithOxc(source, 'download-metadata.ts');
const { prepareDownloadMetadata, dateInstructions, linuxDateScript } = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`);

function directory() {
  const files = new Map();
  let fail = false;
  const folder = {
    async isSameEntry(other) { return other === folder; },
    async getFileHandle(name, options) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('Missing', 'NotFoundError');
        files.set(name, '');
      }
      return {
        async getFile() { return { text: async()=>files.get(name), size:files.get(name).length, lastModified:123 }; },
        async createWritable() {
          let data;
          return { async write(text) { data = text; }, async close() { if(fail) throw Error('Disk full'); files.set(name,data); }, async abort() {} };
        },
      };
    },
  };
  return { folder, files, fail() { fail=true; } };
}
function record(folder, fields={}) {
  return {key:'["account","/photounlim/photo.heic"]',account:'account',id:'/photounlim/photo.heic',name:'photo.heic',savedName:'photo (2).heic',type:'photo',bytes:3,localModified:123,created:'19.09.2026 15:23',modified:'19.09.2026 15:24',folder,status:'success',...fields};
}

test('writes original metadata for old successful downloads and excludes other folders; never serializes handles', async()=>{
  const d=directory();d.files.set('photo (2).heic','abc');
  const metadata=await prepareDownloadMetadata(d.folder,'linux',[record(d.folder),record(directory().folder,{key:'other'})]);
  const data=JSON.parse(d.files.get('yandex-downloads.json'));
  assert.equal(data.files.length,1);
  assert.equal(data.files[0].savedName,'photo (2).heic');
  assert.equal(data.files[0].created,'19.09.2026 15:23');
  assert.equal(data.files[0].createdAt,new Date(2026,8,19,15,23).toISOString());
  assert.equal('folder' in data.files[0],false);
  assert.equal(metadata.find(data.files[0].key).folder,d.folder);
  assert.ok(d.files.get('yandex-apply-dates.sh').includes('touch -c -m'));
});
test('incremental JSON survives restart, recovers history and merges missing files without duplication',async()=>{
  const d=directory();const first=await prepareDownloadMetadata(d.folder,'linux',[]);
  const item=record(d.folder);await first.remember(item);
  const second=await prepareDownloadMetadata(d.folder,'linux',[]);
  assert.equal(second.find(item.key).status,'success');
  await second.remember(item);
  await second.remember(record(d.folder,{key:'next',savedName:'next.heic',name:'next.heic'}));
  assert.equal(JSON.parse(d.files.get('yandex-downloads.json')).files.length,2);
});
test('does not overwrite foreign, malformed or externally changed metadata and scripts',async()=>{
  for(const content of ['broken',JSON.stringify({files:[]}),JSON.stringify({format:'yandex-photo-video-downloader',version:1,files:[{savedName:'../escape'}]})]) {
    const d=directory();d.files.set('yandex-downloads.json',content);
    await assert.rejects(prepareDownloadMetadata(d.folder,'linux',[]));
    assert.equal(d.files.get('yandex-downloads.json'),content);
  }
  const d=directory();d.files.set('yandex-apply-dates.sh','user script');
  await assert.rejects(prepareDownloadMetadata(d.folder,'linux',[]),/Чужой/);
  assert.equal(d.files.get('yandex-apply-dates.sh'),'user script');
  const other=directory();const metadata=await prepareDownloadMetadata(other.folder,'linux',[]);
  other.files.set('yandex-downloads.json','external update');
  await assert.rejects(metadata.remember(record(other.folder)),/другой программой/);
  assert.equal(other.files.get('yandex-downloads.json'),'external update');
});
test('JSON write errors propagate without reporting successful metadata',async()=>{
  const d=directory();const metadata=await prepareDownloadMetadata(d.folder,'linux',[]);d.fail();
  await assert.rejects(metadata.remember(record(d.folder)),/Disk full/);
  assert.equal(JSON.parse(d.files.get('yandex-downloads.json')).files.length,0);
});
test('OS commands read data instead of interpolating media names and unsupported OS gets no wrong command',()=>{
  assert.match(dateInstructions('win').command,/powershell/);
  assert.match(dateInstructions('mac').command,/osascript/);
  assert.match(dateInstructions('linux').command,/sh/);
  assert.equal(dateInstructions('cros'),undefined);
  assert.ok(!dateInstructions('win').command.includes('Bypass'));
});
test('Linux script actually applies UTC modification dates, preserves content, rejects missing/changed files and symlinks',()=>{
  const root=mkdtempSync(join(tmpdir(),'yandex-dates-'));
  try {
    const name="фото ' $(test);.heic";
    writeFileSync(join(root,name),'abc');
    writeFileSync(join(root,'outside'),'xyz');
    symlinkSync(join(root,'outside'),join(root,'linked'));
    const initial=statSync(join(root,'outside')).mtimeMs;
    const entry={savedName:name,bytes:3,createdAt:'2026-09-19T12:23:00.000Z',modifiedAt:'2026-09-19T12:24:00.000Z'};
    writeFileSync(join(root,'yandex-apply-dates.sh'),linuxDateScript([entry]));
    writeFileSync(join(root,'yandex-downloads.json'),JSON.stringify({format:'yandex-photo-video-downloader',version:1,files:[entry]}));
    const result=spawnSync('sh',[join(root,'yandex-apply-dates.sh')],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(statSync(join(root,name)).mtimeMs,Date.parse(entry.modifiedAt));
    assert.equal(readFileSync(join(root,name),'utf8'),'abc');
    writeFileSync(join(root,'yandex-downloads.json'),JSON.stringify({format:'yandex-photo-video-downloader',version:1,files:[{...entry,savedName:'linked'},{...entry,savedName:'missing'},{...entry,bytes:5},{...entry,savedName:'../escape'}]}));
    writeFileSync(join(root,'yandex-apply-dates.sh'),linuxDateScript([{...entry,savedName:'linked'},{...entry,savedName:'missing'},{...entry,bytes:5}]));
    assert.throws(()=>linuxDateScript([{...entry,savedName:'../escape'}]));
    const failed=spawnSync('sh',[join(root,'yandex-apply-dates.sh')],{encoding:'utf8'});
    assert.equal(failed.status,1);assert.equal(statSync(join(root,'outside')).mtimeMs,initial);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('old successful history with missing or changed originals is not exported as a saved file',async()=>{
  const d=directory();d.files.set('changed.heic','wrong size');
  await prepareDownloadMetadata(d.folder,'linux',[record(d.folder),record(d.folder,{key:'changed',savedName:'changed.heic'})]);
  assert.equal(JSON.parse(d.files.get('yandex-downloads.json')).files.length,0);
});
