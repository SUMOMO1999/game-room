import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { drawingTestDOM } from '../../test-support/drawing-page-dom.mjs';
import { mountNightMarket } from './night-market-ui.mjs';

// This tests the actual rearrangement/reading owner. Physical device geometry is
// deliberately left to the independent browser check of the mounted product.
function fixture(t,{width=1512,height=911,auction=false}={}) {
  const document=drawingTestDOM(`<head></head><body><main id="hyakki-digital-root">
    <header class="yg-header"><div class="yg-brand"><strong>商人</strong><span>本机</span></div><div class="room-toolbar"><div class="room-toolbar-actions"><button id="yg-exit">退出</button></div></div></header>
    <div id="yg-playfield" class="yg-playfield"><section class="yg-table"><aside class="yg-piles"></aside><main class="yg-centre"><div class="yg-stage"><h1>经营</h1><span id="yg-room-code">123456</span><div class="yg-time">时间</div></div><div id="yg-track"></div><div id="yg-scene-content">${auction?'<section class="hy-table-work" data-step-kind="auction"></section>':''}</div><section id="hy-task-materials"><div class="yg-hand-heading"><strong>整组拍品</strong></div><div id="hy-task-material-cards">${auction?[0,1,2].map(i=>`<button data-auction-card-index="${i}">拍品${i}</button>`).join(''):''}</div></section></main><aside id="yg-peer"></aside><aside class="yg-storage"><section id="yg-public-stock"><strong>公共货物</strong></section><section id="yg-personal"><button id="yg-shop-detail"><span class="yg-personal-heading"><strong>我的货物</strong><b id="yg-silver">20两</b></span><span id="yg-stock-slots"></span></button></section></aside></section>
    <div class="yg-lower"><section id="yg-tool-zone"></section><section id="yg-hand-section"><div id="yg-hand"></div></section><p id="yg-shop-note"></p></div><p id="yg-feedback"></p></div><section id="yg-rotation"><h2></h2><p></p></section></main></body>`);
  const root=document.getElementById('hyakki-digital-root'),prototype=Object.getPrototypeOf(root);
  prototype.after=function(...nodes){const parent=this.parentNode,at=parent.children.indexOf(this)+1;for(const node of nodes){node.remove();node.parentNode=parent;}parent.children.splice(at,0,...nodes);};
  prototype.insertAdjacentHTML=function(position,markup){const holder=document.createElement('div');holder.innerHTML=markup;const nodes=[...holder.children];if(position==='afterbegin')this.replaceChildren(...nodes,...this.children);else this.append(...nodes);};
  const observers=[],window=new EventTarget();Object.assign(window,{innerWidth:width,innerHeight:height,visualViewport:null,matchMedia:query=>({get matches(){return query.includes('max-width:1150px')&&window.innerWidth<=1150&&window.innerHeight<=500&&window.innerWidth>window.innerHeight;}}),MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}},ResizeObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}});
  document.defaultView=window;root.ownerDocument=document;
  const night=mountNightMarket({root});t.after(()=>night.destroy());
  const view={phase:'playing',selfRole:'player',selfId:'self',players:[{id:'self',name:'我',silver:20,goods:[],ordinaryCapacity:5,tools:[],handCount:0,temporaryOccupied:false}],hand:[],currentPlayerId:'self'};
  night.render(view);night.syncActions();
  return {document,root,window,night,observers,view,byId:id=>document.getElementById(id)};
}

test('one near-edge owner orders equipment, hand and stall while keeping public piles/stock on the table',t=>{
  const f=fixture(t),zone=f.root.querySelector('.nm-self-zone'),shop=f.root.querySelector('.nm-own-shop');
  assert.deepEqual(zone.children.map(node=>node.id||node.className),['yg-tool-zone','yg-hand-section','nm-own-shop']);
  assert.equal(f.byId('yg-silver').closest('.nm-own-shop'),shop);assert.equal(f.byId('yg-stock-slots').closest('.nm-own-shop'),shop);
  assert.ok(f.byId('yg-public-stock').closest('.yg-table'));assert.ok(f.root.querySelector('.yg-piles').closest('.yg-table'));
  assert.equal(f.root.querySelector('.nm-footer'),null);
});

test('the same two event controls stay before a later voice host, without duplicating history or removing exit',t=>{
  const f=fixture(t),toolbar=f.root.querySelector('.room-toolbar-actions'),members=toolbar.querySelector('[data-hy-action="members"]'),history=toolbar.querySelector('[data-hy-action="history"]');
  const voice=f.document.createElement('span');voice.className='room-voice-toolbar';toolbar.insertBefore(voice,toolbar.firstElementChild);f.night.syncActions();
  assert.deepEqual(toolbar.children.slice(0,3),[members,history,voice]);assert.equal(history.textContent,'战况');
  assert.equal(toolbar.querySelectorAll('[data-hy-action="members"]').length,1);assert.equal(toolbar.querySelectorAll('[data-hy-action="history"]').length,1);
  assert.ok(toolbar.contains(f.byId('yg-exit')));
});

test('phone auction stays on the tabletop with its hand, public stock and header seats live',t=>{
  const f=fixture(t,{width:568,height:320,auction:true});
  assert.equal(f.root.classList.contains('nm-auction-focus'),false);assert.equal(f.root.querySelector('.nm-self-zone').inert,false);
  assert.equal(f.byId('yg-public-stock').inert,false);assert.notEqual(f.root.querySelector('.yg-header').inert,true);
  assert.equal(f.byId('yg-peer').parentNode,f.root.querySelector('.yg-header'));
  f.byId('yg-scene-content').replaceChildren();f.night.syncActions();
  assert.equal(f.root.classList.contains('nm-auction-focus'),false);assert.equal(f.root.querySelector('.nm-self-zone').inert,false);
});

test('a tablet auction uses the same focused task owner and restores furniture when wide space returns',t=>{
  const f=fixture(t,{width:1024,height:768,auction:true});
  assert.ok(f.root.classList.contains('nm-auction-focus'));
  assert.equal(f.root.querySelector('.nm-self-zone').inert,true);
  assert.equal(f.byId('yg-public-stock').inert,true);
  assert.notEqual(f.root.querySelector('.yg-header').inert,true);
  f.window.innerWidth=768;f.window.innerHeight=1024;f.night.syncActions();
  assert.equal(f.root.classList.contains('nm-auction-focus'),false);
  assert.equal(f.root.querySelector('.nm-self-zone').inert,false);
  f.window.innerWidth=1024;f.window.innerHeight=768;f.night.syncActions();
  assert.equal(f.root.classList.contains('nm-auction-focus'),true);
  f.window.innerWidth=1512;f.night.syncActions();
  assert.equal(f.root.classList.contains('nm-auction-focus'),false);
  assert.equal(f.root.querySelector('.nm-self-zone').inert,false);
  assert.equal(f.byId('yg-public-stock').inert,false);
});

test('the same peer list moves between phone header and larger table without replacing seats or losing scroll',t=>{
  const f=fixture(t,{width:844,height:390}),peers=f.byId('yg-peer'),header=f.root.querySelector('.yg-header');
  peers.scrollLeft=125;assert.equal(peers.parentNode,header);
  f.window.innerWidth=1024;f.window.innerHeight=768;f.window.dispatchEvent(new Event('resize'));
  assert.equal(peers.parentNode,f.byId('yg-playfield'));assert.equal(peers.scrollLeft,125);
  f.window.innerWidth=1040;f.window.innerHeight=480;f.window.dispatchEvent(new Event('resize'));
  assert.equal(peers.parentNode,header);assert.equal(peers.scrollLeft,125);
  assert.equal(f.root.querySelectorAll('#yg-peer').length,1);
});

test('three-card auction browsing reaches last and first with native button/keyboard controls and no rule callback',t=>{
  const f=fixture(t,{auction:true}),row=f.byId('hy-task-material-cards'),cards=row.querySelectorAll('[data-auction-card-index]');
  row.scrollLeft=0;Object.defineProperty(row,'clientWidth',{value:180});Object.defineProperty(row,'scrollWidth',{value:346});
  row.getBoundingClientRect=()=>({left:0,right:180,width:180});
  cards.forEach((card,i)=>{card.getBoundingClientRect=()=>({left:i*118-row.scrollLeft,right:i*118-row.scrollLeft+110,width:110});});
  row.scrollTo=({left})=>{row.scrollLeft=Math.min(166,Math.max(0,left));row.dispatchEvent(new Event('scroll'));};
  f.night.syncActions();const controls=f.root.querySelector('.nm-auction-browse'),buttons=controls.querySelectorAll('button');
  assert.equal(buttons[0].disabled,true);buttons[1].dispatchEvent(new Event('click'));buttons[1].dispatchEvent(new Event('click'));
  assert.equal(row.scrollLeft,166);assert.equal(buttons[1].disabled,true);assert.match(controls.textContent,/3\/3/);
  for(let i=0;i<2;i++){const event=new Event('keydown',{cancelable:true});Object.defineProperty(event,'key',{value:'ArrowLeft'});row.dispatchEvent(event);}
  assert.equal(row.scrollLeft,0);assert.equal(buttons[0].disabled,true);assert.match(controls.textContent,/1\/3/);
});

test('destroy releases its resize/gesture/scroll handlers and both observers',t=>{
  const f=fixture(t,{auction:true}),row=f.byId('hy-task-material-cards');
  assert.ok(getEventListeners(f.window,'resize').length>0);assert.equal(getEventListeners(row,'scroll').length,1);
  f.night.destroy();
  assert.equal(getEventListeners(f.window,'resize').length,0);assert.equal(getEventListeners(row,'scroll').length,0);
  for(const type of ['gesturestart','gesturechange','wheel'])assert.equal(getEventListeners(f.root,type).length,0);
  assert.ok(f.observers.every(observer=>observer.disconnected));
  for(const observer of f.observers)observer.callback();
  assert.equal(f.root.style.getPropertyValue('--nm-header-bottom'),'');
});

test('auction position announces the complete visible range when the last viewport contains two cards',t=>{
  const f=fixture(t,{auction:true}),row=f.byId('hy-task-material-cards'),cards=row.querySelectorAll('[data-auction-card-index]');
  row.scrollLeft=30;Object.defineProperty(row,'clientWidth',{value:322});Object.defineProperty(row,'scrollWidth',{value:352});
  row.getBoundingClientRect=()=>({left:0,right:322,width:322});
  cards.forEach((card,i)=>{card.getBoundingClientRect=()=>({left:i*118-row.scrollLeft,right:i*118-row.scrollLeft+110,width:110});});
  f.night.syncActions();const controls=f.root.querySelector('.nm-auction-browse');
  assert.match(controls.textContent,/2–3\/3/);assert.equal(controls.querySelectorAll('button')[1].disabled,true);
});

test('unstarted history is disabled while a finished game stays readable and a zero-card player keeps its anchor',t=>{
  const f=fixture(t),history=f.root.querySelector('[data-hy-action="history"]'),zone=f.root.querySelector('.nm-self-zone');
  f.night.render({...f.view,phase:'waiting'});assert.equal(history.disabled,true);
  f.night.render({...f.view,phase:'finished'});assert.equal(history.disabled,false);assert.equal(zone.hidden,false);
  f.night.render({...f.view,selfRole:'spectator',selfId:null});assert.equal(zone.hidden,true);
  f.night.render(f.view);assert.equal(zone.hidden,false);assert.equal(f.byId('yg-hand').children.length,0);
});
