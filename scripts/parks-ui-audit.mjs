// Local Step 0 browser audit. Requires Playwright + Chrome already installed.
// Start scripts/parks-preview.mjs first; never use against a public server.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SCENES } from '../app/games/parks/preview-fixtures.mjs';
const origin=process.env.PARKS_PREVIEW_ORIGIN||'http://127.0.0.1:4383';
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
const dependency=process.env.PLAYWRIGHT_MODULE;
if(!dependency)throw new Error('Set PLAYWRIGHT_MODULE to your installed Playwright index.mjs; no installation is performed.');
const {chromium}=await import(pathToFileURL(resolve(dependency)).href);
const out=resolve(process.env.PARKS_AUDIT_OUT||'ops/parks-step0-2026-10-09/ui');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1512,height:827}}),page=await context.newPage();
page.setDefaultTimeout(8000);
const failures=[],checks=[],errors=[];let current='';
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${r.url()}`);});
async function check(name,fn){if(process.env.PARKS_AUDIT_MATCH&&!new RegExp(process.env.PARKS_AUDIT_MATCH).test(name))return;current=name;await fn();checks.push(name);console.log('PASS',name);}
async function ready(scene='active',prefix=''){await page.goto(`${origin}${prefix}/parks-preview.html?enter=1&scene=${scene}`,{waitUntil:'networkidle'});await page.locator('#chat-toggle').waitFor({state:'visible'});}
async function closeDetail(){await page.locator('#pk-detail-close').click();}
async function shot(name){await page.screenshot({path:resolve(out,name+'.png')});}
function rgb(v){const a=v.match(/[\d.]+/g)?.slice(0,3).map(Number);assert.equal(a?.length,3,v);return a.map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);}
function contrast(a,b){const x=rgb(a),y=rgb(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
async function geometry(){
 const result=await page.evaluate(()=>{
  const r=s=>{const e=document.querySelector(s),b=e.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};
  const selectors=['.pk-header','.pk-board','.pk-personal','.pk-action-bar'];const boxes=Object.fromEntries(selectors.map(s=>[s,r(s)]));
  const buttons=['#chat-toggle','#pk-settings','#pk-exit','#pk-hiker-1','#pk-hiker-2','#pk-market-next',...Array.from({length:9},(_,i)=>`.pk-site:nth-child(${i+1})`)];
  return {boxes,buttons:buttons.map(s=>[s,r(s)]),w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};
 });
 assert.equal(result.overflow,false);
 for(const[s,b]of Object.entries(result.boxes)){assert(b.x>=-1&&b.y>=-1&&b.right<=result.w+1&&b.bottom<=result.h+1,`${s} outside ${JSON.stringify(b)}`);}
 const b=result.boxes;assert(b['.pk-header'].bottom<=b['.pk-board'].y);assert(b['.pk-board'].bottom<=b['.pk-personal'].y);assert(b['.pk-personal'].bottom<=b['.pk-action-bar'].y);
 for(const[s,b]of result.buttons){assert(b.width>=43.9&&b.height>=43.9,`target ${s}: ${b.width}x${b.height}`);assert(b.x>=0&&b.right<=result.w&&b.bottom<=result.h,`hidden target ${s}`);}
 const card=await page.locator('#pk-market .pk-card').first().evaluate(e=>{const c=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return {bottom:c.bottom,parentBottom:p.bottom,parts:[...e.querySelectorAll('.pk-card-name,.pk-card-bottom,.pk-card-effect')].map(n=>({text:n.textContent,rect:n.getBoundingClientRect().toJSON()}))};});
 assert(card.bottom<=card.parentBottom+1,'market cuts card costs/effect');return result;
}
try{
 await check('representative viewport geometry and both hikers',async()=>{
  await ready();for(const[w,h]of [[667,375],[844,390],[1024,768],[1512,827],[1180,680]]){
   await page.setViewportSize({width:w,height:h});await page.waitForTimeout(300);await geometry();
   await page.locator('#pk-hiker-2').click();assert.equal(await page.locator('#pk-hiker-2').getAttribute('aria-pressed'),'true');
   await page.locator('[data-site="site.forest"]').click();await page.locator('#pk-move').click();assert.match(await page.locator('#pk-detail').innerText(),/徒步者2/);await closeDetail();await shot(`active-${w}x${h}`);
  }
 });
 await check('all fixed scenes keep working settings and exit',async()=>{
  for(const[id]of SCENES){await ready(id);await page.locator('#pk-settings').click();assert(await page.locator('#pk-options').isVisible());await page.locator('#pk-options-close').click();await page.locator('#pk-exit').click();await page.locator('#pk-stay').click();}
 });
 await check('prepare cancel and start',async()=>{
  await ready('waiting');assert(await page.locator('#pk-start').isDisabled());await page.locator('#pk-ready').click();assert.equal(await page.locator('#pk-start').isDisabled(),false);await page.locator('#pk-ready').click();assert(await page.locator('#pk-start').isDisabled());await page.locator('#pk-ready').click();await page.locator('#pk-start').click();assert.equal(await page.locator('#parks-root').getAttribute('data-scene'),'active');
 });
 await check('three canteen rows and reduced capacity project',async()=>{
  await page.setViewportSize({width:667,height:375});await page.locator('#pk-personal-detail').click();await page.locator('[data-personal="canteen.mountain"]').last().click();assert.equal(await page.locator('.pk-canteen-rows>section').count(),3);assert.equal(await page.locator('.pk-canteen-rows .pk-card,.pk-empty-slot').count(),6);await closeDetail();await page.locator('#pk-personal-detail').click();await page.locator('#pk-detail #pk-project').click();assert.match(await page.locator('#pk-detail').innerText(),/每购买1件装备/);await closeDetail();assert.equal(await page.locator('#pk-capacity').textContent(),'10 / 10');
 });
 await check('camp sides, payment detail, passion, Teddy and real season reward',async()=>{
  await ready('camping');await page.locator('#pk-camps').click();const a=await page.locator('[data-camp]').first().getAttribute('data-camp');assert.equal(await page.locator('[data-camp]').count(),4);await page.locator('#pk-flip-camp').click();assert.notEqual(await page.locator('[data-camp]').first().getAttribute('data-camp'),a);await page.locator('[data-camp]').last().click();assert.match(await page.locator('#pk-detail').innerText(),/外层|内部/);await closeDetail();
  await ready('passion');await page.locator('[data-passion]').first().click();assert.match(await page.locator('#pk-detail').innerText(),/能力|终局/);await page.locator('#pk-confirm-choice').click();
  await ready('teddy');await page.locator('[data-teddy="1"]').click();assert.match(await page.locator('#pk-feedback').textContent(),/第2组/);
  await ready('season');await page.locator('#pk-season-choice').click();await page.locator('[data-reserve]').first().click();assert.match(await page.locator('#pk-detail').innerText(),/游览仍需支付/);await closeDetail();
 });
 await check('project payment, empty pool and portrait status',async()=>{
  await ready('payment');assert.match(await page.locator('.pk-payment').innerText(),/项目附费/);assert.equal(await page.locator('.pk-payment>div').count(),4);await shot('payment');await page.locator('#pk-payment-rules').click();assert.match(await page.locator('#pk-detail').innerText(),/额外支付/);await closeDetail();
  await ready('empty-pool');assert(await page.locator('#pk-unavailable-payment').isDisabled());await page.locator('[data-card-id="camp.face.1.slot.3"]').click();assert.match(await page.locator('#pk-detail').innerText(),/太阳/);await closeDetail();await shot('empty-pool');
  await ready('paused');await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);assert.match(await page.locator('#pk-portrait-state').innerText(),/已暂停/);await shot('portrait-paused');await page.setViewportSize({width:1512,height:827});
 });
 await check('missing art preserves price points and card details',async()=>{
  await ready('missing');assert.equal(await page.locator('#pk-market img').count(),0);await page.locator('[data-card-id="grand-teton"]').click();assert.match(await page.locator('#pk-detail').innerText(),/步道骰/);assert.match(await page.locator('#pk-detail').innerText(),/3/);await closeDetail();
 });
 await check('actual image decode failure and room arrangement controls',async()=>{
  await page.route('**/assets/parks/v1/*.png',route=>route.fulfill({status:200,contentType:'image/png',body:'broken preview image'}));await ready();await page.locator('#pk-market img').first().waitFor({state:'hidden'});assert.match(await page.locator('#pk-market').innerText(),/插画未能加载/);await page.unroute('**/assets/parks/v1/*.png');await ready();
  await page.locator('#pk-settings').click();await page.locator('#pk-role').click();assert.equal(await page.locator('#parks-root').getAttribute('data-scene'),'spectator');assert.equal(await page.locator('#pk-personal').isVisible(),false);await page.locator('#pk-settings').click();await page.locator('#pk-role').click();assert.equal(await page.locator('#parks-root').getAttribute('data-scene'),'waiting');
  await page.locator('#pk-settings').click();await page.locator('#pk-host').click();assert.match(await page.locator('#pk-detail').innerText(),/合成演示/);await page.locator('#pk-confirm-choice').click();await page.locator('#pk-settings').click();await page.locator('#pk-pause').click();await page.locator('#pk-resume').click();assert.equal(await page.locator('#parks-root').getAttribute('data-scene'),'active');
 });
 await check('six themes real controls contrast focus and screenshots',async()=>{
  await ready();await page.setViewportSize({width:1024,height:768});
  for(const theme of ['classic','midnight','wine','slate','sand','blueprint']){
   await page.locator('#pk-settings').click();await page.locator(`[data-theme-choice="${theme}"]`).click();await page.waitForTimeout(250);assert.equal(await page.locator('html').getAttribute('data-game-theme'),theme);
   const colors=await page.locator('#pk-options-close').evaluate(e=>{const s=getComputedStyle(e);return {ink:s.color,background:s.backgroundColor,radius:parseFloat(s.borderRadius)};});assert(contrast(colors.ink,colors.background)>=4.5,JSON.stringify(colors));assert(colors.radius>0);
   await page.keyboard.press('Tab');await page.locator('#pk-options-close').focus();assert(await page.locator('#pk-options-close').evaluate(e=>e.matches(':focus-visible')));const title=await page.locator('#pk-options .dialog-heading').evaluate(e=>({ink:getComputedStyle(e.querySelector('h2')).color,background:getComputedStyle(e).backgroundColor}));assert(contrast(title.ink,title.background)>=4.5,`settings title ${theme}`);await page.locator('#pk-options').evaluate(e=>e.scrollTop=0);await shot(`settings-${theme}`);await page.locator('#pk-options-close').click();await geometry();
  }
 });
 await check('portrait cold entry and rotation retain selected hiker and destination',async()=>{
  await page.setViewportSize({width:390,height:844});await ready();assert(await page.locator('.pk-portrait').isVisible());await page.locator('#pk-settings').click();await page.locator('#pk-options-close').click();await shot('portrait-cold');
  await page.setViewportSize({width:844,height:390});await page.waitForTimeout(300);await page.locator('#pk-hiker-2').click();await page.locator('[data-site="site.forest"]').click();await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);await page.setViewportSize({width:844,height:390});await page.waitForTimeout(300);assert.equal(await page.locator('#pk-hiker-2').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-site="site.forest"]').getAttribute('aria-pressed'),'true');await geometry();
 });
 await check('two real browser members HTTP/SSE chat, own receipt and peer bubble',async()=>{
  await ready();const peer=await context.newPage();await peer.goto(origin+'/parks-preview.html?enter=1&member=b',{waitUntil:'networkidle'});const text='PARKS双端验证-'+Date.now();await page.locator('#chat-toggle').click();await page.locator('#chat-input').fill(text);await page.locator('#chat-send').click();await page.locator('#chat-status').filter({hasText:'已发送'}).waitFor();await peer.locator('#room-chat-notice').filter({hasText:text}).waitFor();await page.locator('#chat-close').click();assert(await page.locator('#room-chat-own-notice').isVisible());await peer.locator('#room-chat-notice button').first().click();assert.match(await peer.locator('#chat-messages').innerText(),new RegExp(text));await peer.close();
  await page.setViewportSize({width:667,height:375});await page.locator('#chat-toggle').click();await page.locator('#chat-input').fill('键盘挤压验证：末行文字可见');await page.locator('#chat-input').focus();await shot('chat-short');const box=await page.locator('#chat-input').boundingBox();assert(box.y>=0&&box.y+box.height<=375);assert(await page.locator('#chat-send').isVisible());await page.locator('#chat-close').click();
 });
 await check('catalog 245 definitions, every category, portrait scroll and long-name detail',async()=>{
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/parks-catalog.html',{waitUntil:'networkidle'});const kinds=await page.locator('#pk-filter option').evaluateAll(es=>es.map(e=>e.value));let total=0;
  for(const kind of kinds){await page.locator('#pk-filter').selectOption(kind);total+=Number((await page.locator('#pk-count').textContent()).match(/\d+/)[0]);assert(await page.locator('.pk-card').count()>0);await page.locator('.pk-card').first().click();assert((await page.locator('#pk-detail-content').innerText()).length>15);await closeDetail();}assert.equal(total,245);
  await page.locator('#pk-filter').selectOption('park');await page.locator('#pk-next').scrollIntoViewIfNeeded();assert(await page.evaluate(()=>scrollY>500));await page.locator('#pk-next').click();assert.equal(await page.locator('#pk-page').textContent(),'2 / 3');await page.locator('#pk-search').fill('black-canyon');await page.locator('#pk-catalog-grid .pk-card').click();assert.match(await page.locator('#pk-detail').innerText(),/甘尼森黑峡谷国家公园/);await shot('catalog-portrait-detail');await closeDetail();
 });
 await check('mounted route and exit/history return do not silently re-enter',async()=>{
  await page.setViewportSize({width:1512,height:827});await ready();await page.goto(origin+'/parks-catalog.html',{waitUntil:'networkidle'});await ready('waiting','/game');await page.locator('#pk-ready').click();await page.locator('#pk-exit').click();await page.locator('#pk-leave-confirm').click();await page.waitForURL(origin+'/game/');await page.goBack({waitUntil:'domcontentloaded'});assert(!page.url().includes('parks-preview'));await page.goBack({waitUntil:'domcontentloaded'});await page.waitForURL(origin+'/');assert(!page.url().includes('parks-preview'));await ready();
 });
 assert.deepEqual(errors,[]);await shot('final-desktop');
}catch(error){failures.push({check:current,error:error.stack});console.error(error);await shot('failure').catch(()=>{});}
finally{await browser.close();await writeFile(resolve(out,'audit.json'),JSON.stringify({at:new Date().toISOString(),scope:'local synthetic Step0, Chrome emulation; not physical iPhone or game-engine acceptance',checks,failures,errors},null,2)+'\n');}
if(failures.length||errors.length)process.exitCode=1;
