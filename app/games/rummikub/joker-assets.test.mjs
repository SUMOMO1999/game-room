import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gamePresentation } from '../catalog.mjs';
import { publicAssetPaths } from '../../../server/public-assets.mjs';
import { createServer } from '../../server.mjs';
import { readSettings } from '../../../server/config.mjs';
import { createRuntime } from '../../../server/runtime.mjs';
import { createUnifiedServer } from '../../../server/unified-http.mjs';
import { MockProvider } from '../../../server/auth.mjs';
import { EncryptedStore, MemoryAdapter } from '../../../server/storage.mjs';
import { buildRelease, releaseSources } from '../../../scripts/build-release.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const paths=['normal','mirror','color-change','double'].map(type=>`assets/joker-${type}-v2.png`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

// Decode the shipped RGBA scanlines, including all PNG row filters. A valid
// header alone would miss truncated data, empty artwork or opaque backgrounds.
function rgbaPixels(bytes) {
  assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal(bytes.toString('ascii',12,16),'IHDR');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  assert.equal(width,height);assert.ok(width>=256 && width<=2048);
  assert.equal(bytes[24],8);assert.equal(bytes[25],6,'RGBA artwork preserves transparency');
  assert.equal(bytes[28],0,'non-interlaced PNG');
  const chunks=[];let offset=8,ended=false;
  while(offset<bytes.length) {
    const length=bytes.readUInt32BE(offset),kind=bytes.toString('ascii',offset+4,offset+8);
    assert.ok(offset+length+12<=bytes.length,'complete PNG chunk');
    if(kind==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+length));
    offset+=length+12;if(kind==='IEND'){ended=true;break;}
  }
  assert.equal(ended,true,'PNG contains IEND');
  assert.equal(offset,bytes.length,'PNG ends at IEND');
  const raw=inflateSync(Buffer.concat(chunks)),stride=width*4;
  assert.equal(raw.length,(stride+1)*height);
  const pixels=Buffer.alloc(stride*height);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb && pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++) {
    const filter=raw[y*(stride+1)];assert.ok(filter<=4);
    for(let x=0;x<stride;x++) {
      const i=y*stride+x,left=x>=4?pixels[i-4]:0,up=y?pixels[i-stride]:0,corner=y && x>=4?pixels[i-stride-4]:0;
      pixels[i]=(raw[y*(stride+1)+1+x]+[0,left,up,Math.floor((left+up)/2),paeth(left,up,corner)][filter])&255;
    }
  }
  return pixels;
}

test('four separately shipped joker illustrations are nonempty transparent PNGs in the public catalog',()=>{
  const digests=[];
  for(const path of paths) {
    assert.ok(gamePresentation('rummikub').assets.includes(path),path);
    assert.ok(publicAssetPaths().includes(path),path);
    const bytes=readFileSync(join(root,'app',path)),pixels=rgbaPixels(bytes),alpha=[];
    for(let i=3;i<pixels.length;i+=4)alpha.push(pixels[i]);
    assert.ok(alpha.some(value=>value===0),`${path}: transparent background`);
    assert.ok(alpha.some(value=>value>0),`${path}: visible artwork`);
    digests.push(hash(pixels));
  }
  assert.equal(new Set(digests).size,4,'distinct filenames cannot conceal four copies of one illustration');
});

function request(base,path,host) {
  return new Promise((resolve,reject)=>{
    const outgoing=http.get(base+path,{headers:{Host:host}},incoming=>{
      const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));
      incoming.on('end',()=>resolve({status:incoming.statusCode,headers:incoming.headers,bytes:Buffer.concat(chunks)}));
    });outgoing.on('error',reject);
  });
}
for(const mode of ['legacy','unified'])test(`${mode} HTTP serves exact independent joker bytes and refuses unregistered resource paths`,async t=>{
  let server,entries;
  if(mode==='legacy')server=createServer({settings:readSettings({GAME_ROOM_AUTH_MODE:'legacy'})});
  else {
    const settings=readSettings({GAME_ROOM_AUTH_MODE:'mock',GAME_ROOM_ORIGIN:'http://127.0.0.1:39071'});
    const runtime=createRuntime(settings,{storage:new EncryptedStore(new MemoryAdapter(),randomBytes(32)),provider:new MockProvider(settings),roomOptions:{pollIntervalMs:0}});
    entries=[{id:'direct',origin:settings.origin,basePath:'/'},{id:'agora',origin:'http://127.0.0.1:39072',basePath:'/game/'}];
    server=createUnifiedServer({...runtime,entries});
  }
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.shutdown?server.shutdown():new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base=`http://127.0.0.1:${server.address().port}`;
  entries??=[{origin:base,basePath:'/'}];
  for(const entry of entries) {
    const host=new URL(entry.origin).host;
    for(const path of [...paths,'assets/joker-mark.png']) {
      const response=await request(base,entry.basePath+path,host);
      assert.equal(response.status,200,path);assert.equal(response.headers['content-type'],'image/png');
      assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');
      assert.deepEqual(response.bytes,readFileSync(join(root,'app',path)),entry.basePath+path);
    }
    for(const path of ['assets/joker-unknown-v2.png','assets/private/joker-normal-v2.png','games/rummikub/joker-assets.test.mjs'])
      assert.equal((await request(base,entry.basePath+path,host)).status,404,path);
  }
});

test('the real release archive includes each independent illustration byte for byte',t=>{
  const directory=mkdtempSync(join(tmpdir(),'game-joker-release-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const sources=releaseSources(root),release=buildRelease({projectRoot:root,outputRoot:directory});
  const manifest=JSON.parse(execFileSync('tar',['-xOzf',release.artifact,'release-manifest.json'],{encoding:'utf8'}));
  for(const path of paths) {
    const file='app/'+path;assert.ok(sources.includes(file),file);
    const entry=manifest.sourceFiles.find(entry=>entry.file===file);
    assert.equal(entry.sha256,hash(readFileSync(join(root,file))),file);
    const bytes=execFileSync('tar',['-xOzf',release.artifact,file]);
    assert.deepEqual(bytes,readFileSync(join(root,file)),file);
  }
  assert.equal(sources.includes('app/games/rummikub/joker-assets.test.mjs'),false);
});
