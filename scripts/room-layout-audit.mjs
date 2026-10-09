// Real page/layout audit against owned, loopback-only rooms. Upstream identity
// is synthetic; no production credentials, accounts or database are loaded.
// Playwright and a browser are development tools, not application dependencies.
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readSettings } from '../server/config.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { MockProvider } from '../server/auth.mjs';
import { gamePresentations } from '../app/games/catalog.mjs';
import { GAME_THEMES } from '../app/platform/game-theme.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Layout audit is local only.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) throw new Error('Usage: node scripts/room-layout-audit.mjs [--output directory]');
const output = resolve(args[1] || join(tmpdir(), `game-room-layout-${Date.now()}`));
const modulePath = process.env.GAME_ROOM_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)).href : 'playwright');
await mkdir(output, { recursive: true });
const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_DRAWING_ENABLED: '1',
  GAME_ROOM_POKER414_ENABLED: '1', GAME_ROOM_STORE_KEY: randomBytes(32).toString('base64url') });
const provider = new MockProvider(settings);
provider.complete = async () => ({ issuer: 'urn:room-layout-audit', sub: provider.member,
  accessToken: 'synthetic-only', expiresAt: Date.now() + 3600000 });
provider.check = async identity => ({ sub: identity.sub });
const runtime = createRuntime(settings, { provider });
const server = createUnifiedServer(runtime);
const results = [], errors = [], themeChecks = [], states = [], controlStates = [];
let browser;
const viewports = [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 800 }];

function measureToolbar() {
  const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  const box = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
  const toolbar = document.querySelector('.room-toolbar');
  const buttons = [...(toolbar?.querySelectorAll('.room-toolbar-action') || [])].filter(visible);
  const controls = buttons.map(node => ({ id:node.id, exit:node.classList.contains('room-toolbar-exit'), label:node.getAttribute('aria-label') || node.textContent.trim(),
    ...box(node), radius:getComputedStyle(node).borderRadius }));
  const issues = [];
  if (!visible(toolbar) || controls.length < 2) issues.push('missing persistent toolbar');
  for (const c of controls) {
    if (c.width < 43.5 || c.height < 43.5) issues.push(`${c.id}: target below 44px`);
    if (Math.abs(c.height - 44) > 1) issues.push(`${c.id}: toolbar height is not 44px`);
    if (parseFloat(c.radius) < 8) issues.push(`${c.id}: missing rounded shape`);
    if (c.x < -.5 || c.y < -.5 || c.right > innerWidth+.5 || c.bottom > innerHeight+.5) issues.push(`${c.id}: outside viewport`);
  }
  for (let i=1; i<controls.length; i++) {
    const previous=controls[i-1], current=controls[i], gap=current.x-previous.right;
    if (Math.abs(current.y-previous.y)>1) issues.push('toolbar wraps or has unequal alignment');
    if (gap<5.5 || gap>(current.exit?10.5:8.5)) issues.push(`un-grouped controls: ${previous.id} → ${current.id} gap ${gap.toFixed(1)}`);
  }
  if(controls.length && !controls.at(-1).exit) issues.push('exit is not the last action');
  if(controls.some(c=>c.id==='chat-toggle') && controls[0]?.id!=='chat-toggle') issues.push('chat is not the first action');
  const group = toolbar?.querySelector('.room-toolbar-actions');
  if (visible(group) && controls.length && Math.abs(controls.at(-1).right-box(toolbar).right)>2) issues.push('actions are not anchored to the trailing edge');
  const status=toolbar?.querySelector('.room-toolbar-status');
  if (visible(status) && controls.length && box(status).right>controls[0].x+.5) issues.push('status overlaps actions');
  const install=document.querySelector('#app-shell-tools');
  if(visible(status) && visible(install)) {
    const a=box(status),b=box(install);
    if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)issues.push('install/fullscreen tools overlap connection status');
  }
  const header=document.querySelector('.room-header'), stage=document.querySelector('.drawing-stage-bar');
  if(visible(header) && visible(stage) && box(header).bottom>box(stage).y+.5)issues.push('header overlaps game stage');
  if (document.documentElement.scrollWidth>innerWidth+1) issues.push('page horizontal overflow');
  if (document.documentElement.scrollHeight>innerHeight+2) issues.push('page vertical overflow');
  return { viewport:{width:innerWidth,height:innerHeight}, controls, issues };
}

try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  settings.origin=base; settings.callback=base+'/auth/callback'; settings.postLogout=base+'/';
  async function request(path, member={}, body) {
    const response=await fetch(base+path,{redirect:'manual',signal:AbortSignal.timeout(8000),
      method:body===undefined?'GET':'POST',headers:{...(member.cookie?{cookie:member.cookie}:{}),
        ...(body===undefined?{}:{origin:base,'content-type':'application/json','x-csrf-token':member.csrf})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();
    if(response.status>=400)throw new Error(`${path}: ${response.status} ${text}`);
    return {response,body:text?JSON.parse(text):null};
  }
  async function member(sub) {
    provider.member=sub;
    const start=await request('/auth/login'), callback=new URL(start.response.headers.get('location'));
    const finish=await request(callback.pathname+callback.search,{cookie:start.response.headers.getSetCookie()[0].split(';')[0]});
    const cookie=finish.response.headers.getSetCookie().find(value=>value.startsWith(settings.cookieName+'=')).split(';')[0];
    const state=(await request('/api/state',{cookie})).body;
    return {cookie,csrf:state.csrf,userKey:state.userKey};
  }
  browser=await chromium.launch({channel:process.env.GAME_ROOM_BROWSER_CHANNEL || 'chrome',headless:true});
  const cases=[];
  for(const game of gamePresentations()) {
    const members=[];
    for(let i=0;i<game.minPlayers+1;i++) members.push(await member(`${game.gameType}-${i}`));
    const created=await runtime.rooms.createRoom(members[0].userKey,'很长的中文昵称与オウ',randomUUID(),game.gameType);
    for(let i=1;i<members.length;i++) await runtime.rooms.joinRoom(created.roomCode,members[i].userKey,
      i===members.length-1?'旁观伙伴':'一起玩的朋友',randomUUID(),i===members.length-1?'spectator':'player');
    const action=async(index,type,fields={})=>{
      const view=await runtime.rooms.getView(created.roomCode,members[index].userKey);
      return runtime.rooms.action(created.roomCode,members[index].userKey,{type,requestId:randomUUID(),expectedRevision:view.revision,...fields});
    };
    cases.push({game,members,created,action});
  }
  async function pageFor(member) {
    const context=await browser.newContext({viewport:viewports[0],deviceScaleFactor:1,serviceWorkers:'block'});
    if(member) {const at=member.cookie.indexOf('=');await context.addCookies([{name:member.cookie.slice(0,at),value:member.cookie.slice(at+1),url:base}]);}
    const page=await context.newPage();page.setDefaultTimeout(10000);
    page.on('pageerror',error=>errors.push(error.message));
    return {context,page};
  }
  async function settle(page) {
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.waitForFunction(()=>!document.getAnimations().some(animation=>animation.constructor.name==='CSSTransition' && animation.playState==='running'));
  }
  async function enterRoom(page,item,phase,role='player') {
    const {game,created}=item;
    const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/rooms/${created.roomCode}` && response.request().method()==='GET');
    await page.goto(`${base}/${game.page}?code=${created.roomCode}`);
    const response=await responsePromise;
    if(response.status()!==200)throw new Error(`${game.gameType}: room request failed ${response.status()}`);
    const data=await response.json(),view=data.view||data;
    if(view.roomCode!==created.roomCode || view.gameType!==game.gameType || view.phase!==phase || view.selfRole!==role)throw new Error(`${game.gameType}: wrong room/phase/role`);
    const prefix={'rummikub':'room','army-flip':'room','flying-chess':'flying','draw-and-guess':'drawing','poker414-2':'p414'}[game.gameType];
    const selector=phase==='waiting'?`#${prefix}-waiting`:['finished','aborted'].includes(phase)?`#${prefix}-result`:
      prefix==='room'?'#room-play':prefix==='flying'?'#flying-live':prefix==='drawing'?'#drawing-canvas':'#p414-playing';
    await page.locator(selector).waitFor();
    await page.locator('#chat-toggle').waitFor();
    states.push({game:game.gameType,roomCode:created.roomCode,phase,role,selector});
  }
  const settingsButton = page => page.locator('.room-toolbar-action').filter({hasText:/^设置$/});
  async function openSettings(page) {
    await settingsButton(page).click();
    const dialog=page.locator('dialog.game-settings-dialog[open]');await dialog.waitFor();return dialog;
  }
  async function closeSettings(dialog) {
    await dialog.locator('.dialog-heading button[aria-label]').first().click();
    await dialog.waitFor({state:'hidden'});
  }
  async function recordControlState(page,name,theme,state,control=settingsButton(page)) {
    await settle(page);
    const sample=await control.evaluate(node=>{
      const css=getComputedStyle(node), canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const context=canvas.getContext('2d');
      const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data];};
      const color=rgba(css.color),background=rgba(css.backgroundColor);
      const luminance=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const a=luminance(color),b=luminance(background),contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      return {color,background,contrast,opacity:css.opacity,outline:css.outlineStyle,outlineWidth:css.outlineWidth,expanded:node.getAttribute('aria-expanded')};
    });
    controlStates.push({name,theme,state,...sample});
    if(state!=='disabled' && sample.color[3]===255 && sample.background[3]===255 && sample.contrast<4.5)throw new Error(`${name}/${theme}/${state}: text contrast ${sample.contrast.toFixed(2)}`);
  }
  async function inspectThemes(page,name) {
    const baseline=new Map();
    await page.waitForFunction(()=>[...document.querySelectorAll('link[data-game-theme-styles]')].some(link=>link.sheet?.cssRules.length));
    for(const theme of GAME_THEMES) {
      const dialog=await openSettings(page);
      await dialog.locator(`[data-theme-choice="${theme.id}"]`).click();
      if(await page.locator('html').getAttribute('data-game-theme')!==theme.id)throw new Error('Theme picker did not apply');
      await recordControlState(page,name,theme.id,'expanded');
      await closeSettings(dialog);
      await page.mouse.move(1,1);await settingsButton(page).evaluate(node=>node.blur());
      await recordControlState(page,name,theme.id,'normal');
      await settingsButton(page).focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
      await recordControlState(page,name,theme.id,'keyboard-focus');
      if(!await settingsButton(page).evaluate(node=>node.matches(':focus-visible') && parseFloat(getComputedStyle(node).outlineWidth)>=2))throw new Error('Keyboard focus is not visible');
      // The disabled sample tests CSS only; it does not submit an application action.
      await settingsButton(page).evaluate(node=>{node.blur();node.disabled=true;});
      await recordControlState(page,name,theme.id,'disabled');
      await settingsButton(page).evaluate(node=>{node.disabled=false;});
      if(name.endsWith('-waiting')) {
        const chat=page.locator('#chat-toggle');await chat.click();await page.locator('#room-chat').waitFor();
        await recordControlState(page,name,theme.id,'chat-expanded',chat);
        await page.screenshot({path:join(output,`${name}-${theme.id}-chat.png`)});
        await page.locator('.chat-close').click();await page.mouse.move(1,1);
      }
      for(const [index,size] of viewports.entries()) {
        await page.setViewportSize(size);
        await settle(page);
        const measured=await page.evaluate(measureToolbar);
        const geometry=JSON.stringify(measured.controls.map(({id,x,y,width,height,radius})=>({id,x,y,width,height,radius})));
        if(!baseline.has(index))baseline.set(index,geometry);
        else if(baseline.get(index)!==geometry)measured.issues.push('theme changes toolbar geometry');
        themeChecks.push({...measured,name,theme:theme.id});
        if(index<2)await page.screenshot({path:join(output,`${name}-${theme.id}-${size.width}x${size.height}.png`)});
      }
      await page.setViewportSize(viewports[0]);
      const themedDialog=await openSettings(page);
      await page.screenshot({path:join(output,`${name}-${theme.id}-settings.png`)});
      await closeSettings(themedDialog);
    }
    const dialog=await openSettings(page);await dialog.locator('[data-theme-choice="classic"]').click();await closeSettings(dialog);
  }
  async function inspect(page,name,{panels=false,code=null}={}) {
    console.log(`Checking ${name}`);
    await page.locator('.room-toolbar').waitFor();
    // Exercise both directions, keeping the same page and any device-private layout.
    for(const [index,size] of [...viewports,viewports[0]].entries()) {
      await page.setViewportSize(size);
      await settle(page);
      const measured=await page.evaluate(measureToolbar);measured.name=name;measured.rotationStep=index;
      if(code && name.endsWith('-waiting') && !await page.getByText(code,{exact:false}).filter({visible:true}).count()) measured.issues.push('waiting room code is not visible');
      results.push(measured);
      if(index<2) await page.screenshot({path:join(output,`${name}-${size.width}x${size.height}.png`)});
    }
    if(panels) {
      const dialog=await openSettings(page);
      await page.screenshot({path:join(output,`${name}-settings.png`)});
      // Audio's "关闭声音" is a different action, not a dialog dismissal.
      await closeSettings(dialog);
      const chat=page.locator('#chat-toggle'),practice=name.endsWith('-practice');
      if(await chat.isVisible()===practice)throw new Error(`${name}: incorrect chat availability`);
      if(!practice) {
        await chat.click();await page.locator('#room-chat').waitFor();
        const input=page.locator('#chat-input');if(await input.count())await input.fill('布局检查草稿，不发送');
        await page.screenshot({path:join(output,`${name}-chat.png`)});
        await page.locator('.chat-close').click();
      }
    }
  }
  for(const item of cases) {
    const {game,members,created,action}=item, {context,page}=await pageFor(members[0]);
    await enterRoom(page,item,'waiting');
    await settingsButton(page).waitFor();
    await page.getByText(created.roomCode,{exact:false}).filter({visible:true}).first().waitFor();
    await inspect(page,game.gameType+'-waiting',{panels:true,code:created.roomCode});
    await inspectThemes(page,game.gameType+'-waiting');
    for(let i=0;i<game.minPlayers;i++)await action(i,'ready',{ready:true});
    await action(0,'start');await enterRoom(page,item,'playing');
    await inspect(page,game.gameType+'-playing');
    const watcher=await pageFor(members.at(-1));await enterRoom(watcher.page,item,'playing','spectator');
    await inspect(watcher.page,game.gameType+'-spectator');await watcher.context.close();
    await action(1,'leave');
    const ended=await runtime.rooms.getView(created.roomCode,members[0].userKey);
    if(!['finished','aborted'].includes(ended.phase))throw new Error('Room did not end after departure');
    await enterRoom(page,item,ended.phase);
    await inspect(page,game.gameType+'-aborted');await context.close();
    const practice=await pageFor();await practice.page.goto(`${base}/${game.practicePage}`);
    const content={'rummikub':'#rack .tile','army-flip':'#army-cells button','flying-chess':'#flying-die','draw-and-guess':'#drawing-canvas','poker414-2':'#p414-hand button'}[game.gameType];
    await practice.page.locator(content).first().waitFor();
    await inspect(practice.page,game.gameType+'-practice',{panels:true});
    await inspectThemes(practice.page,game.gameType+'-practice');await practice.context.close();
  }
} catch(error) {
  errors.push(error.stack || error.message);
} finally {
  await browser?.close();server.closeAllConnections();await server.shutdown();
  const failures=[...results,...themeChecks].filter(result=>result.issues.length);
  const report={at:new Date().toISOString(),environment:'local Chromium; synthetic identities; real page modules and memory room service',
    screenshotReview:'REQUIRED_SEPARATELY',realDevice:false,production:false,checks:results.length,themeChecks:themeChecks.length,failures:failures.length,errors,states,controlStates,results,themes:themeChecks};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,checks:results.length,themeChecks:themeChecks.length,failures:failures.length,errors},null,2));
  if(failures.length || errors.length || !results.length)process.exitCode=1;
}
