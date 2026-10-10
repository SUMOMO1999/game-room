// Local-only S0 UI acceptance; requires existing Playwright and Chrome, installs nothing.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DIGITAL_SCENES,digitalFixture} from '../app/games/hyakki-trading/test-support/digital-preview-fixtures.mjs';
import {getCard} from '../app/games/hyakki-trading/content/definitions.mjs';
const origin=process.env.HYAKKI_PREVIEW_ORIGIN||'http://127.0.0.1:4385';
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/u);
if(!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the existing Playwright index.mjs.');
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href);
const out=resolve(process.env.HYAKKI_AUDIT_OUT||'ops/hyakki-step0-v2-2026-10-10/ui');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
page.setDefaultTimeout(8000);
const checks=[],failures=[],errors=[],measurements=[];let current='';
page.on('pageerror',e=>errors.push({check:current,error:e.message}));
async function check(name,fn){if(process.env.HYAKKI_AUDIT_MATCH&&!new RegExp(process.env.HYAKKI_AUDIT_MATCH).test(name))return;current=name;try{await fn();checks.push(name);console.log('PASS',name);}catch(error){failures.push({name,error:String(error.stack||error)});await page.screenshot({path:resolve(out,`failed-${failures.length}.png`)}).catch(()=>{});console.log('FAIL',name,error.message);}}
async function images(){await page.locator('img').evaluateAll(async images=>{await Promise.all(images.map(e=>e.decode().catch(()=>{})));});}
async function ready(scene='active',prefix=''){await page.goto(`${origin}${prefix}/hyakki-preview.html?enter=1&scene=${scene}`,{waitUntil:'networkidle'});await page.locator('#yg-settings').waitFor();assert.equal(await page.locator('#hyakki-digital-root').getAttribute('data-scene'),scene);await images();}
async function shot(name){await images();await page.screenshot({path:resolve(out,name+'.png')});}
async function geometry(){
 const data=await page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const boxes=Object.fromEntries(['.yg-header','.yg-table','.yg-lower','#yg-feedback'].filter(s=>visible(document.querySelector(s))).map(s=>[s,rect(document.querySelector(s))]));
  const zones=Object.fromEntries(['#yg-public-stock','#yg-personal','#yg-tool-zone'].filter(s=>visible(document.querySelector(s))).map(s=>[s,rect(document.querySelector(s))]));
  const controls=['#chat-toggle','#yg-settings','#yg-exit'].map(s=>{const e=document.querySelector(s),r=rect(e),c=getComputedStyle(e);return{selector:s,...r,radius:c.borderRadius,align:c.alignItems,justify:c.justifyContent};});
  const handElement=document.querySelector('#yg-hand');
  const hand=handElement.getClientRects().length?{...rect(handElement),scrollWidth:handElement.scrollWidth,clientWidth:handElement.clientWidth,overflowX:getComputedStyle(handElement).overflowX}:null;
  const cards=[...document.querySelectorAll('#yg-hand .yousei-card')].filter(e=>e.getClientRects().length).map(e=>({...rect(e),id:e.dataset.cardId,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,imageCount:e.querySelectorAll('img').length,decoded:[...e.querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth>0&&i.getBoundingClientRect().width>0&&i.getBoundingClientRect().height>0)}));
  return{boxes,zones,publicGoodIcons:document.querySelectorAll('#yg-public-stock .yousei-good-icon').length,toolsInLower:!!document.querySelector('#yg-tool-zone')?.closest('.yg-lower'),controls,cards,hand,summaryCount:document.querySelectorAll('#yg-hand .yg-hand-summary').length,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scene:document.querySelector('#hyakki-digital-root').dataset.scene};
 });
 assert(data.scrollWidth<=data.width+1,'page overflows horizontally');
 for(const[s,r]of Object.entries(data.boxes)) assert(r.x>=-1&&r.y>=-1&&r.right<=data.width+1&&r.bottom<=data.height+1,`${s} outside viewport: ${JSON.stringify(r)}`);
 const b=data.boxes;assert(b['.yg-header'].bottom<=b['.yg-table'].y+1,'header/table overlap');assert(b['.yg-table'].bottom<=b['.yg-lower'].y+1,'table/personal overlap');
 assert.equal(data.publicGoodIcons,6,'public stock must show all six goods icons');
 if(data.zones['#yg-personal'])assert(data.zones['#yg-personal'].y>=data.zones['#yg-public-stock'].bottom-1,'personal goods overlap public stock');
 if(data.zones['#yg-tool-zone'])assert(data.toolsInLower,'equipped tools are not in the bottom zone');
 for(const c of data.controls){assert(c.width>=43.9&&c.height>=43.9,`small tool ${c.selector}`);assert(parseFloat(c.radius)>=8,`square tool ${c.selector}`);}
 for(let i=1;i<data.controls.length;i++){const gap=data.controls[i].x-data.controls[i-1].right;assert(gap>=5.9&&gap<=10.1,`tool gap ${gap}`);}
 assert.equal(data.summaryCount,0,'hand replaced illustrated cards with text summaries');
 if(data.hand){assert(['auto','scroll'].includes(data.hand.overflowX),'hand has no independent horizontal scroll');assert(data.hand.x>=-1&&data.hand.right<=data.width+1,'hand viewport overflows page');}
 for(const r of data.cards){assert(r.width>=89.9&&r.height>=144.9,`unreadable card ${r.id}: ${r.width}×${r.height}`);assert(r.imageCount>0&&r.decoded,`missing hand artwork ${r.id}`);assert(r.scrollWidth<=r.clientWidth+1&&r.scrollHeight<=r.clientHeight+1,`card face content overflows ${r.id}`);assert(r.y>=data.hand.y-1&&r.bottom<=data.hand.bottom+1,`hand image clipped vertically ${r.id}`);}
 measurements.push(data);return data;
}
try{
 await check('catalog all 51 faces,39 assets and five complete filters',async()=>{
  await page.goto(origin+'/hyakki-catalog.html',{waitUntil:'networkidle'});await images();
  assert.equal(await page.locator('[data-catalog-cards] .yousei-card').count(),51);
  const missing=await page.locator('[data-catalog-cards] img').evaluateAll(es=>es.filter(e=>!e.complete||!e.naturalWidth).map(e=>e.src));assert.deepEqual(missing,[]);
  for(const[id,count]of [['goods',19],['stall_permit',1],['ordinary_character',13],['monitored_character',8],['tool',10]]){await page.selectOption('[data-catalog-category]',id);assert.equal(await page.locator('[data-catalog-cards] .yousei-card').count(),count);}
  await page.selectOption('[data-catalog-category]','goods');await page.fill('[data-catalog-search]','G19');assert.equal(await page.locator('[data-catalog-cards] .yousei-card').count(),1);assert.match(await page.locator('[data-catalog-count]').innerText(),/4/);
  await page.locator('[data-catalog-reset]').click();await shot('catalog-desktop');
 });
 await check('catalog portrait, long text, missing-art fallback and type art sheets',async()=>{
  await page.goto(origin+'/hyakki-catalog.html');await page.setViewportSize({width:390,height:844});
  await page.selectOption('[data-catalog-category]','goods');await page.fill('[data-catalog-search]','G19');await page.locator('[data-catalog-cards] .yousei-card').click();assert(await page.locator('dialog[open]').isVisible());
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await shot('catalog-portrait-detail');await page.locator('[data-catalog-close]').click();
  await page.setViewportSize({width:667,height:375});await page.selectOption('[data-catalog-category]','tool');await page.fill('[data-catalog-search]','貔貅袋');await page.locator('[data-catalog-cards] .yousei-card').click();
  assert.match(await page.locator('[data-catalog-detail]').innerText(),/每张候选|最多查看一次/);assert((await page.locator('[data-catalog-close]').boundingBox()).height>=44);await shot('catalog-long-text');await page.locator('[data-catalog-close]').click();
  await page.locator('[data-catalog-missing]').click();assert.equal(await page.locator('[data-catalog-missing]').getAttribute('aria-pressed'),'true');await shot('catalog-fallback');
  await page.setViewportSize({width:1440,height:1080});await page.goto(origin+'/hyakki-catalog.html');
  for(const type of ['ordinary_character','monitored_character','tool']){await page.selectOption('[data-catalog-category]',type);await page.locator('[data-catalog-cards]').scrollIntoViewIfNeeded();await shot('art-'+type);}
 });
 await check('main table and personal area at seven risk viewports',async()=>{
  await ready();for(const[w,h]of [[667,375],[844,390],[1024,768],[1440,900],[1512,650],[1512,827],[1180,680]]){await page.setViewportSize({width:w,height:h});await page.waitForTimeout(180);await geometry();await shot(`active-${w}x${h}`);}
 });
 await check('all 20 scenes retain settings and exit with no phantom private hand',async()=>{
  await page.setViewportSize({width:1440,height:900});
  for(const[id]of DIGITAL_SCENES){await ready(id);await geometry();await page.locator('#yg-settings').click();assert(await page.locator('#yg-options').isVisible());await page.locator('#yg-options-close').click();await page.locator('#yg-exit').click();assert(await page.locator('#yg-leave').isVisible());await page.locator('#yg-stay').click();if(id==='spectator')assert.equal(await page.locator('#yg-hand .yousei-card').count(),0);}
 });
 await check('waiting room visible code, invite, ready and start',async()=>{
  await ready('waiting');assert.match(await page.locator('#yg-room-code').innerText(),/610036/);assert(await page.locator('#yg-waiting-invite').isVisible());
  const start=page.locator('[data-preview-action="start"]');assert(await start.isDisabled());await page.locator('[data-preview-action="ready"]').click();assert.equal(await start.isDisabled(),false);await start.click();assert.equal(await page.locator('#hyakki-digital-root').getAttribute('data-scene'),'active');
 });
 await check('committed decisions retain choices after closing, details and rotation',async()=>{
  for(const scene of ['oracle','lamp','hand-draft','goods-draft','tools-draft']){
   await ready(scene);await page.locator('#yg-decision-open').click();const choice=page.locator('[data-choice]').first();await choice.click();const selected=await page.locator('[data-choice][aria-pressed="true"]').getAttribute('data-choice');
   await page.locator('#yg-decision-close').click();await page.locator('#yg-decision-open').click();assert.equal(await page.locator('[data-choice][aria-pressed="true"]').getAttribute('data-choice'),selected);
   if(scene==='oracle'){await page.locator('[data-detail-id]').first().click();assert(await page.locator('#yg-inspector').isVisible());await page.locator('#yg-inspector-close').click();assert(await page.locator('#yg-decision').isVisible());assert.equal(await page.locator('[data-choice][aria-pressed="true"]').getAttribute('data-choice'),selected);}
   await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);await page.setViewportSize({width:844,height:390});await page.waitForTimeout(150);assert.equal(await page.locator('[data-choice][aria-pressed="true"]').getAttribute('data-choice'),selected);await shot('decision-'+scene);await page.locator('#yg-decision-close').click();
  }
 });
 await check('peek, two responses and both auction lots are readable',async()=>{
  await page.setViewportSize({width:667,height:375});
  for(const scene of ['peek','guard','trader','goods-auction','cards-auction']){await ready(scene);await page.locator('#yg-decision-open').click();assert(await page.locator('#yg-decision-body').isVisible());if(scene==='cards-auction')assert.equal(await page.locator('#yg-decision-body .yg-candidate').count(),3);if(scene==='goods-auction')assert.equal(await page.locator('#yg-decision-body .yg-candidate').count(),2);await shot('short-'+scene);
   if(scene==='cards-auction'){
    for(const detail of await page.locator('#yg-decision-body [data-detail-id]').all()){
     await detail.click();assert(await page.locator('#yg-inspector').isVisible());assert.match(await page.locator('#yg-inspector-body').innerText(),/./);await page.locator('#yg-inspector-close').click();
    }
    await page.locator('#yg-bid').fill('7');await page.locator('[data-detail-id]').first().click();await page.locator('#yg-inspector-close').click();assert.equal(await page.locator('#yg-bid').inputValue(),'7','bid draft lost after details');
   }
   await page.locator('#yg-decision-close').click();}
 });
 await check('dense image hand stays mounted, scrolls independently and retains installed tool state',async()=>{
  await page.setViewportSize({width:844,height:390});
  await ready('dense');
  const expected=digitalFixture('dense').hand;
  assert.deepEqual(await page.locator('#yg-hand .yg-hand-card').evaluateAll(es=>es.map(e=>e.dataset.entityId)),expected.map(card=>card.id),'not all hand cards mounted');
  assert.equal(await page.locator('#yg-hand-prev,#yg-hand-next,#yg-hand-page,#yg-hand .yg-hand-summary').count(),0,'obsolete pagination or text hand remains');
  const before=await geometry();assert(before.hand.scrollWidth>before.hand.clientWidth,'dense hand does not create its own scroll range');
  await page.locator('#yg-hand').evaluate(e=>{e.scrollLeft=e.scrollWidth;});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const reached=await page.locator('#yg-hand').evaluate(e=>{const hand=e.getBoundingClientRect(),last=e.lastElementChild.getBoundingClientRect();return{scrollLeft:e.scrollLeft,right:last.right,handRight:hand.right,top:last.top,handTop:hand.top};});
  assert(reached.scrollLeft>0&&reached.right<=reached.handRight+1,'last hand card cannot be reached by scrolling');
  assert.deepEqual(await page.locator('#yg-hand .yg-hand-card').evaluateAll(es=>es.map(e=>e.dataset.entityId)),expected.map(card=>card.id),'scrolling replaces the hand with another page');
  await page.locator('#yg-hand .yousei-card').last().click();assert(await page.locator('#yg-inspector').isVisible());assert.equal(await page.locator('#yg-inspector-body .yousei-card').getAttribute('data-card-id'),expected.at(-1).definitionId);await page.locator('#yg-inspector-close').click();
  await shot('dense-hand-scrolled');
  assert.equal(await page.locator('#yg-hand-filter').isVisible(),false,'hand classification should live in settings');
  await page.locator('#yg-settings').click();await page.selectOption('#yg-hand-filter','goods');await page.locator('#yg-options-close').click();await images();
  assert.deepEqual(await page.locator('#yg-hand .yg-hand-card').evaluateAll(es=>es.map(e=>e.dataset.entityId)),expected.filter(card=>getCard(card.definitionId).category==='goods').map(card=>card.id),'settings filter loses or invents hand cards');
  assert.equal(await page.locator('#yg-hand').evaluate(e=>e.scrollLeft),0,'new filter should start at the first matching card');
  await ready('tools');assert.equal(await page.locator('#yg-tools [data-tool-id]').count(),3);assert(await page.locator('#yg-tools .is-tapped').count()>0);await geometry();
  for(const tool of await page.locator('#yg-tools [data-tool-id]').all()){assert(await tool.isVisible());assert.equal(await tool.locator('img').count(),1);await tool.click();assert(await page.locator('#yg-inspector').isVisible());assert.match(await page.locator('#yg-inspector-body').innerText(),/道具/);await page.locator('#yg-inspector-close').click();}
  await page.locator('#yg-tools .is-tapped').first().click();assert.match(await page.locator('#yg-inspector-body').innerText(),/横置/);await shot('tools-detail');
 });
 await check('six themes real controls and text colors',async()=>{
  await ready('active');await page.setViewportSize({width:844,height:390});
  for(const theme of ['classic','midnight','wine','slate','sand','blueprint']){await page.locator('#yg-settings').click();await page.locator(`[data-theme-choice="${theme}"]`).click();assert.equal(await page.locator('html').getAttribute('data-game-theme'),theme);await shot('settings-'+theme);await page.locator('#yg-options-close').click();await geometry();}
 });
 await check('self chat, peer unread, draft rotation and pending-decision escape',async()=>{
  await ready('oracle');await page.locator('#chat-toggle').click();const input=page.locator('#chat-input');await input.fill('我这张先留着');await page.locator('#chat-send').click();assert.match(await page.locator('#room-chat').innerText(),/我这张先留着/);
  await input.fill('还没发送的草稿');await page.setViewportSize({width:390,height:844});await page.waitForTimeout(180);assert.equal(await input.inputValue(),'还没发送的草稿');await page.setViewportSize({width:844,height:390});await page.waitForTimeout(180);assert.equal(await input.inputValue(),'还没发送的草稿');
  await shot('chat-draft-response');assert(await page.locator('#yg-chat-decision-open').isVisible());await page.locator('#yg-chat-decision-open').click();assert(await page.locator('#yg-decision').isVisible());
 });
 await check('portrait tools and mounted path keep reachable exits',async()=>{
  await page.setViewportSize({width:390,height:844});await ready('peek','/game');assert(await page.locator('#yg-rotation').isVisible());assert(await page.locator('#yg-settings').isVisible());await page.locator('#yg-portrait-decision-open').click();assert(await page.locator('#yg-decision').isVisible());await shot('portrait-decision');await page.locator('#yg-decision-close').click();await page.locator('#yg-exit').click();await page.locator('#yg-leave-confirm').click();assert(!page.url().includes('hyakki-preview.html'));
 });
 await check('private decision DOM clears after changing to spectator',async()=>{
  await page.setViewportSize({width:1440,height:900});await ready('oracle');await page.locator('#yg-decision-open').click();await page.locator('[data-detail-id]').first().click();await page.locator('#yg-inspector-close').click();await page.locator('#yg-decision-close').click();
  await page.locator('#yg-settings').click();await page.selectOption('#yg-scene','spectator');
  assert.equal(await page.locator('#yg-decision-body [data-card-id],#yg-inspector-body [data-card-id],#yg-hand [data-card-id]').count(),0,'private faces survived role change');
 });
 await check('exit replaces history entry instead of reviving the preview',async()=>{
  await page.goto(origin+'/');await page.goto(origin+'/hyakki-catalog.html');await page.goto(origin+'/hyakki-preview.html?enter=1');await page.locator('#yg-exit').click();await page.locator('#yg-leave-confirm').click();await page.waitForURL(origin+'/');await page.goBack();assert.equal(new URL(page.url()).pathname,'/hyakki-catalog.html');
 });
 await check('no browser runtime errors',async()=>assert.deepEqual(errors,[]));
}finally{
 await writeFile(resolve(out,'result.json'),JSON.stringify({origin,environment:'local Chrome simulated viewports; synthetic state, not playable engine',checks,failures,errors,measurements},null,2));await browser.close();
}
console.log(JSON.stringify({checks:checks.length,failures:failures.length,output:out}));if(failures.length)process.exitCode=1;
