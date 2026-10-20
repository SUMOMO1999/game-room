import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLayoutRelease, validateLayoutEvidence, layoutContractFingerprint, layoutSourceFingerprint, screenshotDimensions } from './check-layout-release.mjs';
const fingerprint = 'a'.repeat(64);
function fixture() {
  const contract = { schema:'game-room.layout-contract.v1', viewports:[{width:844,height:390,family:'phone'}],
    surfaces:[{id:'reader',families:['phone']}], visualFamilies:['phone'] };
  const report = { schema:'game-room.layout-evidence.v1', status:'PASS', sourceFingerprint:fingerprint, executor:'root', unresolved:[],limitations:['CSS viewport, not physical iPhone'],
    cases:[{id:'reader-phone',surface:'reader',family:'phone',matrix:true,status:'PASS',requested:{width:844,height:390},actual:{width:844,height:390},
      metrics:{documentOverflowX:0,documentOverflowY:0,clippedCritical:[],overlappingCritical:[],unreachableActions:[],missingRequired:[]}}],
    artifacts:[{path:'phone.png',sha256:fingerprint,kind:'screenshot',family:'phone',caseId:'reader-phone'},{path:'review.json',sha256:fingerprint,kind:'independent-review'}],
    independentReview:{status:'PASS',sourceFingerprint:fingerprint,reviewer:'independent-agent',blockers:[],path:'review.json'} };
  report.contractFingerprint=layoutContractFingerprint(contract);
  for(const item of report.cases){item.sourceFingerprint=fingerprint;item.contractFingerprint=report.contractFingerprint;}
  return {contract,report};
}
const reviewFile=()=>({status:'PASS',sourceFingerprint:fingerprint,contractFingerprint:fixture().report.contractFingerprint,reviewer:'independent-agent',blockers:[],reviewedArtifacts:[{caseId:'reader-phone',path:'phone.png',sha256:fingerprint}]});
const verifyFile=artifact=>artifact.kind==='screenshot'?{width:844,height:390}:true;
const check = (contract,report,verifyArtifact=verifyFile,readReview=reviewFile) => validateLayoutEvidence(contract,report,fingerprint,{verifyArtifact,readReview});
test('complete candidate-bound evidence passes without claiming physical acceptance',()=>{const f=fixture();assert.equal(check(f.contract,f.report).physicalAcceptance,false);});
test('stale source, incomplete status and missing dimensions block publication',()=>{
  for(const mutate of [r=>r.sourceFingerprint='b'.repeat(64),r=>r.status='PENDING',r=>r.cases[0].actual.width=843,r=>r.cases[0].matrix=false]){
    const f=fixture();mutate(f.report);assert.throws(()=>check(f.contract,f.report),/LAYOUT_RELEASE_BLOCKED/);
  }
});
test('review file FAIL, stale source, blockers and unreviewed screenshots cannot be relabeled PASS',()=>{
  for(const mutate of [r=>r.status='FAIL',r=>r.sourceFingerprint='b'.repeat(64),r=>r.blockers=['bad card'],r=>r.reviewedArtifacts=[]]){
    const f=fixture(),review=reviewFile();mutate(review);assert.throws(()=>check(f.contract,f.report,verifyFile,()=>review),/independent review file/);
  }
});
test('replacing an image under the same case identity invalidates its old visual review',()=>{
  const f=fixture();f.report.artifacts[0].sha256='b'.repeat(64);
  assert.throws(()=>check(f.contract,f.report),/independent review file/);
});
test('device labels, screenshot pixel dimensions and empty coverage cannot bypass the gate',()=>{
  const f=fixture();f.report.cases[0].family='desktop';assert.throws(()=>check(f.contract,f.report),/device family/);
  const g=fixture();assert.throws(()=>check(g.contract,g.report,artifact=>artifact.kind==='screenshot'?{width:1512,height:982}:true),/screenshot\/measurement/);
  for(const mutate of [c=>c.visualFamilies=[],c=>c.surfaces[0].families=[]]){const f=fixture();mutate(f.contract);assert.throws(()=>check(f.contract,f.report),/LAYOUT_RELEASE_BLOCKED/);}
});
test('shrinking a contract and reusing old capture/review bindings blocks release',()=>{
  const f=fixture();f.contract.surfaces.push({id:'auction',families:['phone']});assert.throws(()=>check(f.contract,f.report),/acceptance contract/);
  const g=fixture();g.report.cases[0].sourceFingerprint='b'.repeat(64);assert.throws(()=>check(g.contract,g.report),/stale capture/);
});
test('card text clipping, occluded controls and whole-page growth block publication',()=>{
  for(const mutate of [m=>m.clippedCritical.push('card cost'),m=>m.overlappingCritical.push('card name/effect'),m=>m.unreachableActions.push('cancel'),m=>m.documentOverflowY=3]){
    const f=fixture();mutate(f.report.cases[0].metrics);assert.throws(()=>check(f.contract,f.report),/LAYOUT_RELEASE_BLOCKED/);
  }
});
test('changed artifact, absent surface, missing screenshots and self-review fail closed',()=>{
  const f=fixture();assert.throws(()=>check(f.contract,f.report,()=>false),/artifact changed/);
  for(const mutate of [r=>r.cases[0].surface='other',r=>r.artifacts[0].family='tablet',r=>r.independentReview.reviewer='root',r=>r.independentReview.blockers.push('unreadable card')]){
    const f=fixture();mutate(f.report);assert.throws(()=>check(f.contract,f.report),/LAYOUT_RELEASE_BLOCKED/);
  }
});
test('one good screen per family cannot substitute the full state and viewport matrix',()=>{
  const f=fixture();f.contract.viewports.push({width:568,height:320,family:'phone'});f.contract.surfaces.push({id:'auction',families:['phone']});
  const row=(id,surface,width,height)=>({...structuredClone(f.report.cases[0]),id,surface,requested:{width,height},actual:{width,height}});
  f.report.cases.push(row('dense-short','hand-dense',568,320),row('auction-phone','auction',844,390));
  f.report.contractFingerprint=layoutContractFingerprint(f.contract);for(const item of f.report.cases)item.contractFingerprint=f.report.contractFingerprint;
  const review={...reviewFile(),contractFingerprint:f.report.contractFingerprint};
  assert.throws(()=>check(f.contract,f.report,verifyFile,()=>review),/missing surface reader\/phone\/568x320/);
  f.report.cases.push(row('reader-short','reader',568,320),row('auction-short','auction',568,320));
  assert.equal(check(f.contract,f.report,verifyFile,()=>review).status,'PASS');
});

// Encoded 17x9 RGB fixtures, not header-only stand-ins. JPEG was encoded by macOS sips.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABEAAAAJCAIAAABbilBbAAAAE0lEQVR4nGNQKIohFTGM6hnUegDqM44/wwlJzAAAAABJRU5ErkJggg==','base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEaADAAQAAAABAAAACQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACQARAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAv/aAAwDAQACEQMRAD8A+W6KKK7D+YwooooA/9k=','base64');
const artifactHash = bytes => createHash('sha256').update(bytes).digest('hex');

function encodedEvidence(bytes, filename, exercise) {
  const directory = mkdtempSync(resolve(tmpdir(),'layout-image-evidence-'));
  const source = resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const {contract,report} = fixture();
  const size = {width:17,height:9};
  contract.viewports[0] = {...size,family:'phone'};
  report.sourceFingerprint = layoutSourceFingerprint(source);
  report.contractFingerprint = layoutContractFingerprint(contract);
  Object.assign(report.cases[0],{requested:{...size},actual:{...size},sourceFingerprint:report.sourceFingerprint,contractFingerprint:report.contractFingerprint});
  Object.assign(report.artifacts[0],{path:filename,sha256:artifactHash(bytes)});
  report.independentReview.sourceFingerprint = report.sourceFingerprint;
  const review = {...reviewFile(),sourceFingerprint:report.sourceFingerprint,contractFingerprint:report.contractFingerprint,
    reviewedArtifacts:[{caseId:'reader-phone',path:filename,sha256:artifactHash(bytes)}]};
  const contractPath = resolve(directory,'contract.json'),reportPath = resolve(directory,'report.json');
  const save = () => {
    const reviewBytes = Buffer.from(JSON.stringify(review));
    report.artifacts[1].sha256 = artifactHash(reviewBytes);
    writeFileSync(resolve(directory,filename),bytes);
    writeFileSync(resolve(directory,'review.json'),reviewBytes);
    writeFileSync(contractPath,JSON.stringify(contract));writeFileSync(reportPath,JSON.stringify(report));
  };
  try { save();exercise({run:()=>checkLayoutRelease(source,contractPath,reportPath),save,contract,report,review}); }
  finally { rmSync(directory,{recursive:true,force:true}); }
}

test('real PNG and JPEG screenshot bytes retain pixel dimensions regardless of filename',()=>{
  for (const bytes of [png,jpeg]) assert.deepEqual(screenshotDimensions(bytes),{width:17,height:9});
  for (const [bytes,name] of [[png,'phone.png'],[jpeg,'phone.jpg'],[jpeg,'misnamed.png']])
    encodedEvidence(bytes,name,({run})=>assert.equal(run().status,'PASS'));
});
test('JPEG truncation, incomplete segments and malformed SOF cannot supply trusted dimensions',()=>{
  for (let end=0;end<jpeg.length;end++) assert.equal(screenshotDimensions(jpeg.subarray(0,end)),null,`truncated byte ${end}`);
  const sof = jpeg.indexOf(Buffer.from([0xff,0xc0]));assert.ok(sof>0);
  for (const corrupt of [
    bytes=>bytes.writeUInt16BE(0xffff,4),
    bytes=>bytes.writeUInt16BE(8,sof+2),
    bytes=>bytes.writeUInt16BE(0,sof+5),
    bytes=>bytes.writeUInt16BE(0,sof+7),
    bytes=>bytes[sof+9]=4,
    bytes=>bytes[sof+13]=bytes[sof+10],
    bytes=>bytes[sof+11]=0,
  ]) {const bytes=Buffer.from(jpeg);corrupt(bytes);assert.equal(screenshotDimensions(bytes),null);}
  assert.equal(screenshotDimensions(png.subarray(0,24)),null);
  assert.equal(screenshotDimensions(png.subarray(0,png.length-1)),null);
});
test('JPEG support cannot bypass screenshot hash, measured pixel size or complete encoded data',()=>{
  encodedEvidence(jpeg,'phone.jpg',({run,save,report})=>{
    report.artifacts[0].sha256='b'.repeat(64);save();assert.throws(run,/artifact changed/);
  });
  encodedEvidence(jpeg,'phone.jpg',({run,save,contract,report,review})=>{
    contract.viewports[0].width=18;report.cases[0].actual.width=18;report.cases[0].requested.width=18;
    report.contractFingerprint=layoutContractFingerprint(contract);report.cases[0].contractFingerprint=report.contractFingerprint;review.contractFingerprint=report.contractFingerprint;
    save();assert.throws(run,/screenshot\/measurement mismatch/);
  });
  encodedEvidence(jpeg.subarray(0,jpeg.length-2),'phone.jpg',({run})=>assert.throws(run,/artifact changed/));
});
