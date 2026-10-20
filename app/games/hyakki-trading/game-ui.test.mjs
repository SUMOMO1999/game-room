import test from 'node:test';
import assert from 'node:assert/strict';
import { drawingTestDOM } from '../../test-support/drawing-page-dom.mjs';
import { mountHyakkiPage } from './game-ui.mjs';
import { mountDigitalCatalog } from './digital-catalog.mjs';
import { createGame, applyGameAction, currentDecision } from './rules.mjs';
import { privateView, spectatorView } from './view.mjs';
import { DIGITAL_RULE_VERSION, GOODS, getCard } from './content/definitions.mjs';

const ids=['a'.repeat(32),'b'.repeat(32)],context={now:1000,randomInt:n=>n-1};
function fresh(){return createGame(ids,{...context,matchId:'c'.repeat(32),ruleVersion:DIGITAL_RULE_VERSION});}
function act(game,type,fields={},actor=game.turnPlayerId){
  const decision=currentDecision(game),result=applyGameAction(game,actor,{type,matchId:game.matchId,turnId:game.turnId,...(decision?{effectId:game.pending.id,decisionId:decision.id}:{}),...fields},context);
  assert.equal(result.ok,true,result.error);return result.state;
}
function give(game,code,owner=0){const id=`yousei.${code}#01`;for(const player of game.players)player.hand=player.hand.filter(item=>item!==id);game.deck=game.deck.filter(item=>item!==id);game.discard=game.discard.filter(item=>item!==id);game.players[owner].hand.push(id);return id;}
function room(game,{phase='playing',selfId=ids[0],pause=null,manual=false}={}){
  const projected=privateView(game,selfId);if(manual)projected.holds.manual=true;
  return {roomId:'room',roomCode:'123456',phase,selfId,selfRole:'player',hostId:ids[0],serverTime:context.now,pause,game:projected,
    players:ids.map((id,index)=>({id,name:index?'伙伴':'我',ready:true})),spectators:[],hyakkiConfig:{actionLimit:5,goodsPerType:6}};
}
function fixture(t,{onAction,onLeave,onHistory,practice=false}={}){
  const document=drawingTestDOM('<head></head><body><main id="hyakki-digital-root"></main></body>'),root=document.getElementById('hyakki-digital-root');
  const prototype=Object.getPrototypeOf(root),nativeQuery=prototype.querySelectorAll,nativeMatches=prototype.matches;
  // Extend the small shared lifecycle DOM only for APIs used by the real mount.
  const nativeSetAttribute=prototype.setAttribute,nativeRemoveAttribute=prototype.removeAttribute;
  prototype.setAttribute=function(name,value){nativeSetAttribute.call(this,name,value);if(name==='disabled')this.disabled=true;};
  prototype.removeAttribute=function(name){nativeRemoveAttribute.call(this,name);if(name==='disabled')this.disabled=false;};
  const nativeAppend=prototype.append;
  // The shared small DOM has no native selected-option behavior. Model that
  // form semantic here; browser layout and native select interaction are QA.
  prototype.append=function(...children){nativeAppend.apply(this,children);if(this.tagName==='SELECT'){const selected=this.children.find(node=>node.getAttribute('selected')!==null)??this.children[0];this.value=selected?.value??'';}};
  prototype.scrollIntoView=function(){};
  prototype.matches=function(selector){
    const entity=selector.match(/^\[data-entity-id="([^"]+)"\]$/u);
    return entity?this.dataset.entityId===entity[1]:nativeMatches.call(this,selector);
  };
  prototype.after=function(...children){const parent=this.parentNode,index=parent.children.indexOf(this)+1;for(const child of children){child.remove();child.parentNode=parent;}parent.children.splice(index,0,...children);};
  prototype.querySelectorAll=function(selector){
    if(selector.includes(','))return [...new Set(selector.split(',').flatMap(part=>this.querySelectorAll(part.trim())))];
    const parts=selector.trim().split(/\s+/u);if(parts.length===1)return nativeQuery.call(this,selector==='*'?'div,span,button,img':selector.replace(/:first-child/gu,''));
    let parents=[this];for(const part of parts)parents=parents.flatMap(parent=>nativeQuery.call(parent,part.replace(/:first-child/gu,'')));return [...new Set(parents)];
  };
  prototype.insertAdjacentHTML=function(position,markup){
    const holder=document.createElement('div');holder.innerHTML=markup;const children=[...holder.children];
    if(position==='afterend'||position==='beforebegin'){const parent=this.parentNode,index=parent.children.indexOf(this)+(position==='afterend'?1:0);for(const child of children){child.remove();child.parentNode=parent;}parent.children.splice(index,0,...children);}
    else if(position==='afterbegin'){const previous=[...this.children];this.replaceChildren(...children,...previous);}else this.append(...children);
  };
  prototype.cloneNode=function(){const copy=document.createElement(this.tagName.toLowerCase());for(const [name,value]of Object.entries(this.attributes))copy.setAttribute(name,value);copy.className=this.className;copy.style={...this.style};copy._text=this._text;copy.append(...this.children.map(child=>child.cloneNode(true)));return copy;};
  const animations=[];
  prototype.animate=function(){let resolve,reject;const finished=new Promise((yes,no)=>{resolve=yes;reject=no;});const animation={node:this,finished,resolve,cancel(){reject(new DOMException('cancelled','AbortError'));}};animations.push(animation);return animation;};
  const window=new EventTarget();Object.assign(window,{innerWidth:1512,innerHeight:827,navigator:{},visualViewport:null,
    setTimeout,clearTimeout,setInterval,clearInterval,scrollTo(){},performance:{now:()=>context.now},CSS:{escape:value=>value},matchMedia:()=>({matches:false}),
    ResizeObserver:class{observe(){}disconnect(){}},MutationObserver:class{observe(){}disconnect(){}},
    getComputedStyle:()=>({columnGap:'8px',paddingLeft:'3px',paddingRight:'3px',getPropertyValue:name=>name==='--hyakki-card-width'?'132px':'192px'})});
  document.defaultView=window;root.ownerDocument=document;
  const commands=[],exits=[],ui=mountHyakkiPage({root,practice,onHistory,onAction:(type,fields)=>{commands.push({type,fields});return onAction?onAction(type,fields):true;},onLeave:options=>{exits.push(structuredClone(options));return onLeave?onLeave(options):true;}});t.after(()=>ui.destroy());
  function click(node){const event=new Event('click');Object.defineProperty(event,'target',{value:node});root.dispatchEvent(event);}
  const hand=document.getElementById('yg-hand');let captured=null;
  hand.setPointerCapture=id=>{captured=id;};hand.hasPointerCapture=id=>captured===id;hand.releasePointerCapture=()=>{captured=null;};
  function pointer(type,cardId,x,y){
    const node=root.querySelector(`[data-entity-id="${cardId}"] .yousei-card`);assert.ok(node);
    const event=new Event(type,{cancelable:true});
    for(const [key,value]of Object.entries({target:node,isPrimary:true,button:0,pointerId:1,clientX:x,clientY:y}))Object.defineProperty(event,key,{value});
    (type==='pointerdown'?hand:window).dispatchEvent(event);
  }
  return {document,root,ui,commands,exits,click,pointer,animations,byId:id=>document.getElementById(id)};
}

test('room resume remains mounted outside each paused inline task while game actions stay disabled',t=>{
  const f=fixture(t),peek=act(fresh(),'peek');
  let benefit=fresh(),cardId=give(benefit,'c01');benefit=act(act(benefit,'peek'),'keep-peek');benefit=act(benefit,'play-character',{cardId});
  let response=fresh();cardId=give(response,'m01');give(response,'c07',1);response.players[1].goods.firearms=1;response.bankGoods.firearms--;response=act(act(response,'peek'),'keep-peek');response=act(response,'play-character',{cardId,params:{goodsId:'firearms'}});
  assert.ok(response.pending.response);
  for(const game of [peek,benefit,response]){
    f.ui.applyView(room(game,{phase:'paused',manual:true}));
    const control=f.byId('hy-room-control');assert.equal(control.hidden,false);assert.equal(control.disabled,false);assert.equal(control.dataset.hyAction,'resume');
    assert.ok(control.closest('.yg-header'));assert.equal(control.closest('#yg-scene-content'),null);
    const task=f.root.querySelector('.hy-table-work');assert.ok(task);
    for(const node of task.querySelectorAll('button').filter(node=>node.dataset.hyAction))assert.notEqual(node.getAttribute('disabled'),null,node.dataset.hyAction);
    f.click(control);assert.equal(f.commands.at(-1).type,'resume');
  }
});

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function readyCard(f,code='c03',extraRoom={}){
  let game=fresh();const cardId=give(game,code);game=act(act(game,'peek'),'keep-peek');
  f.ui.applyView({...room(game),...extraRoom});const card=privateView(game,ids[0]).players[0].hand.find(c=>c.cardId===cardId);f.ui.selectHandCard(card);
  return {game,cardId,card};
}
function actionControl(f,action){const n=f.root.querySelector(`[data-hy-action="${action}"]`);assert.ok(n);if(n.dataset.hyFields)n.setAttribute('data-hy-fields',n.dataset.hyFields.replace(/&quot;/gu,'"'));return n;}

test('complex local choices reserve actions outside the scrollable source description',t=>{
  const f=fixture(t);
  for(const code of ['c01','c06','m01','m08']){
    readyCard(f,code);
    const copy=f.root.querySelector('.hy-action-draft .hy-inline-copy');assert.ok(copy,code);
    const description=copy.querySelector('.hy-source-description'),actions=copy.querySelector('.hy-inline-actions');
    assert.ok(description,code);assert.ok(actions,code);
    assert.equal(description.parentNode,copy);assert.equal(actions.parentNode,copy);
    assert.ok(description.textContent.trim().length>0,code);
    assert.equal(description.querySelector('button'),null,code);
    assert.ok(actions.querySelector('[data-hy-action="cancel-card"]'),code);
    assert.equal(f.commands.length,0,code);
  }
});


function setupRoom(count,hyakkiConfig={actionLimit:5,goodsPerType:6,goodsSupplyMode:'recommended'}){
  return {roomId:'setup',roomCode:'654321',phase:'waiting',selfId:ids[0],selfRole:'player',hostId:ids[0],game:null,serverTime:1000,
    players:Array.from({length:count},(_,index)=>({id:index===0?ids[0]:String(index).repeat(32),name:index===0?'我':`伙伴${index}`,ready:false})),
    spectators:[{id:'viewer',name:'观众'}],hyakkiConfig};
}
function changeSetup(f,id,value){const input=f.byId(id);assert.ok(input,id);input.value=String(value);const event=new Event('change');Object.defineProperty(event,'target',{value:input});f.root.dispatchEvent(event);}
test('real waiting controls keep custom stock and restore recommendation without counting spectators',t=>{
  const f=fixture(t);f.ui.applyView(setupRoom(3));
  assert.equal(f.byId('hy-goods-limit').value,'9');assert.match(f.byId('yg-scene-content').textContent,/3人 · 主牌144张/);
  assert.equal(f.byId('hy-goods-limit').closest('label').querySelector('span').textContent,'每种公共货物');
  changeSetup(f,'hy-goods-limit',20);
  assert.deepEqual(f.commands.at(-1),{type:'configure',fields:{hyakkiConfig:{actionLimit:5,goodsPerType:20,goodsSupplyMode:'custom'}}});
  f.ui.applyView(setupRoom(6,{actionLimit:5,goodsPerType:20,goodsSupplyMode:'custom'}));
  assert.equal(f.byId('hy-goods-limit').value,'20');assert.match(f.byId('yg-scene-content').textContent,/6人 · 主牌246张/);assert.match(f.byId('yg-scene-content').textContent,/每种推荐18件/);
  changeSetup(f,'hy-action-limit',7);assert.equal(f.commands.at(-1).fields.hyakkiConfig.goodsSupplyMode,'custom');assert.equal(f.commands.at(-1).fields.hyakkiConfig.goodsPerType,20);
  f.click(actionControl(f,'setup-recommend'));
  assert.deepEqual(f.commands.at(-1).fields.hyakkiConfig,{actionLimit:7,goodsPerType:18,goodsSupplyMode:'recommended'});
  f.ui.applyView(setupRoom(6,{actionLimit:7,goodsPerType:18,goodsSupplyMode:'recommended'}));
  assert.equal(actionControl(f,'setup-recommend').disabled,true);
});
test('legacy setup stock remains custom and a spectator cannot configure through a synthetic control event',t=>{
  const f=fixture(t);f.ui.applyView(setupRoom(2,{actionLimit:5,goodsPerType:8}));assert.equal(f.byId('hy-goods-limit').value,'8');
  f.ui.applyView(setupRoom(5,{actionLimit:5,goodsPerType:8}));assert.equal(f.byId('hy-goods-limit').value,'8');assert.match(f.byId('yg-scene-content').textContent,/手选/);assert.equal(f.commands.length,0);
  const observer={...setupRoom(5),selfId:'viewer',selfRole:'spectator'};f.ui.applyView(observer);assert.equal(f.byId('hy-goods-limit'),null);
  const fake=f.document.createElement('select');fake.id='hy-goods-limit';fake.value='20';const event=new Event('change');Object.defineProperty(event,'target',{value:fake});f.root.dispatchEvent(event);assert.equal(f.commands.length,0);
});
test('practice setup follows recommendation, preserves manual stock across player changes and sends the mode',async t=>{
  const f=fixture(t,{practice:true}),initial=setupRoom(2);let options;
  f.ui.applyView(initial,{practiceSnapshot:{players:initial.players,configuration:initial.hyakkiConfig}});
  f.ui.configurePractice({onRestart:value=>{options=value;}});f.ui.openPracticeRestart();
  assert.equal(f.byId('hy-practice-goods').value,'6');
  changeSetup(f,'hy-practice-players',6);assert.equal(f.byId('hy-practice-goods').value,'18');assert.match(f.byId('hy-practice-profile').textContent,/主牌246张/);
  changeSetup(f,'hy-practice-goods',20);changeSetup(f,'hy-practice-players',3);assert.equal(f.byId('hy-practice-goods').value,'20');assert.match(f.byId('hy-practice-profile').textContent,/每种推荐9件.*手选/);
  f.ui.openPracticeRestart();assert.equal(f.byId('hy-practice-players').value,'3');assert.equal(f.byId('hy-practice-goods').value,'20','reopening a reader does not reset the setup draft');
  f.click(actionControl(f,'practice-recommend'));assert.equal(f.byId('hy-practice-goods').value,'9');
  changeSetup(f,'hy-practice-players',4);changeSetup(f,'hy-practice-limit',8);f.click(actionControl(f,'practice-confirm'));await flush();
  assert.deepEqual(options,{playerCount:4,actionLimit:8,goodsPerType:12,goodsSupplyMode:'recommended'});
});
test('restarting a restored legacy practice begins with its stock instead of silently switching to recommended',t=>{
  const f=fixture(t,{practice:true}),initial=setupRoom(4,{actionLimit:7,goodsPerType:8});
  f.ui.applyView(initial,{practiceSnapshot:{players:initial.players}});f.ui.openPracticeRestart();
  assert.equal(f.byId('hy-practice-goods').value,'8');assert.equal(f.byId('hy-practice-limit').value,'7');
  changeSetup(f,'hy-practice-players',6);assert.equal(f.byId('hy-practice-goods').value,'8');assert.match(f.byId('hy-practice-profile').textContent,/每种推荐18件.*手选/);
});
test('the mounted catalog identifies its double-player copy baseline, all new deck counts and adjustable stock',t=>{
  const f=fixture(t),catalog=f.document.createElement('section');f.document.body.append(catalog);const dispose=mountDigitalCatalog(catalog);t.after(dispose);
  assert.match(catalog.querySelector('h1').parentNode.textContent,/双人基准110张/);
  for(const label of ['2人110张','3人144张','4人178张','5人212张','6人246张','旧局保留原牌量与库存','每种推荐3×人数','手选4～20件'])assert.ok(catalog.textContent.includes(label),label);
  assert.equal(catalog.querySelector('[data-catalog-count]').textContent,'显示51种 · 110张副本');
  const face=catalog.querySelector('button[data-card-id]'),event=new Event('click');Object.defineProperty(event,'target',{value:face});catalog.dispatchEvent(event);
  assert.equal(catalog.querySelector('dialog').open,true);const detail=catalog.querySelector('[data-catalog-detail]').textContent,definition=getCard(face.dataset.cardId);assert.ok(detail.includes(definition.name));for(const paragraph of definition.details)assert.ok(detail.includes(paragraph));
  assert.equal(f.commands.length,0,'reading a catalog does not configure or restart a match');
});

test('home board always has five ordinary positions and a paid sixth, with separate permanent expansion boards',t=>{
  const f=fixture(t);
  for(const [stalls,count] of [[0,0],[0,5],[0,6],[1,6],[1,9],[5,21]]){
    const game=fresh(),self=game.players[0];self.stallCount=stalls;game.purchasedStalls=stalls;game.availableStalls=5-stalls;
    for(let i=0;i<count;i++){const id=GOODS[i%GOODS.length].id;self.goods[id]++;game.bankGoods[id]--;}
    self.temporaryOccupied=count>5+3*stalls;
    f.ui.applyView(room(JSON.parse(JSON.stringify(game))));
    const base=f.root.querySelector('.nm-base-stall'),baseSlots=base.querySelectorAll('.nm-stock-slot');
    assert.equal(baseSlots.length,6);assert.equal(baseSlots[5].dataset.stockKind,'temporary');
    assert.equal(baseSlots[5].querySelector('small').textContent,'临时');
    assert.match(f.byId('yg-shop-note').textContent,self.temporaryOccupied ? /临时格已占用，已付2两/u : /临时格空闲，每次2两/u);
    assert.equal(baseSlots.filter(node=>node.dataset.stockKind==='ordinary').length,5);
    assert.equal(f.root.querySelectorAll('.nm-expansion-stall').length,Math.max(1,stalls));
    assert.equal(f.root.querySelectorAll('.nm-stock-slot.is-locked').length,stalls===0?3:0);
    assert.equal(f.root.querySelectorAll('.nm-expansion-stall .nm-stock-slot').length,Math.max(1,stalls)*3);
    assert.equal(f.root.querySelectorAll('#yg-stock-slots .is-temporary').length,1);
    assert.equal(f.root.querySelectorAll('#yg-stock-slots .yg-owned-good').length,count);
    assert.equal(baseSlots[5].classList.contains('yg-owned-good'),self.temporaryOccupied);
    assert.match(f.byId('yg-shop-note').textContent,new RegExp(`普通${Math.min(count,5+stalls*3)}/${5+stalls*3}`));
    assert.equal(f.commands.length,0, 'displaying or restoring a shop never purchases a board or charges money');
  }
});

test('room refresh keeps expansion browsing through money-only and changed-goods views without submitting an action',t=>{
  const f=fixture(t),game=fresh();game.players[0].stallCount=5;game.purchasedStalls=5;game.availableStalls=0;
  f.ui.applyView(room(game));
  const stock=f.byId('yg-stock-slots'),base=f.root.querySelector('.nm-base-stall'),expansions=f.root.querySelector('.nm-stall-expansions');
  stock.scrollLeft=464;expansions.scrollLeft=380;
  const refreshed=JSON.parse(JSON.stringify(game));refreshed.players[0].silver--;
  f.ui.applyView(room(refreshed));
  assert.equal(f.byId('yg-stock-slots'),stock);
  assert.equal(f.root.querySelector('.nm-base-stall'),base,'an unrelated update must not replace the objects being browsed');
  assert.equal(stock.scrollLeft,464);assert.equal(f.commands.length,0);
  assert.equal(f.root.querySelector('.nm-stall-expansions'),expansions);
  assert.equal(expansions.scrollLeft,380);
  refreshed.players[0].goods.firearms++;refreshed.bankGoods.firearms--;
  f.ui.applyView(room(refreshed));
  assert.equal(f.root.querySelector('.nm-stall-expansions').scrollLeft,380,'receiving goods must keep the expansion board being browsed');
  assert.equal(f.commands.length,0);
});

test('real Hyakki leave busy distinguishes an in-flight confirmation from a failed or completed request',async t=>{
  let waiting=deferred();const f=fixture(t,{onLeave:()=>waiting.promise});f.ui.applyView(room(fresh()));
  f.click(actionControl(f,'leave'));const confirm=f.byId('yg-leave-confirm');
  assert.equal(confirm.getAttribute('aria-busy'),null);f.click(confirm);
  assert.equal(confirm.getAttribute('aria-busy'),'true');assert.equal(confirm.disabled,true);
  f.click(confirm);assert.deepEqual(f.exits,[{destination:'lobby'}]);assert.deepEqual(f.commands,[]);
  waiting.reject(new Error('退出未确认，保留原席位'));await flush();
  assert.equal(confirm.getAttribute('aria-busy'),null);assert.equal(confirm.disabled,false);assert.equal(f.byId('yg-leave').open,true);
  assert.match(f.byId('hy-leave-note').textContent,/保留原席位/);
  waiting=deferred();f.click(confirm);assert.equal(confirm.getAttribute('aria-busy'),'true');
  waiting.resolve(true);await flush();assert.equal(confirm.getAttribute('aria-busy'),null);assert.equal(confirm.disabled,false);
  assert.equal(f.exits.length,2);assert.deepEqual(f.commands,[]);
});

test('real Hyakki conceal and destruction clear pending leave paint without accepting late failure feedback',async t=>{
  for(const end of ['conceal','destroy']){
    const waiting=deferred(),f=fixture(t,{onLeave:()=>waiting.promise});f.ui.applyView(room(fresh()));
    f.click(actionControl(f,'leave'));const confirm=f.byId('yg-leave-confirm');f.click(confirm);
    assert.equal(confirm.getAttribute('aria-busy'),'true');assert.equal(f.exits.length,1);
    if(end==='conceal')f.ui.conceal({message:'正在核验新身份'});else f.ui.destroy();
    assert.equal(confirm.getAttribute('aria-busy'),null);const after=f.root.textContent;
    waiting.reject(new Error('原身份迟到退出失败'));await flush();
    assert.equal(confirm.getAttribute('aria-busy'),null);assert.equal(f.root.textContent,after);assert.deepEqual(f.commands,[]);
  }
});

test('free installation is explicit and retains cancel then one-confirm interaction', t => {
  const f=fixture(t), {game,card,cardId}=readyCard(f,'t02'), before=structuredClone(game);
  assert.equal(actionControl(f,'confirm-card').textContent,'确认安装 · 0行动');
  assert.match(f.byId('yg-scene-content').textContent,/装0步 · 用1步/);
  f.click(actionControl(f,'cancel-card'));assert.equal(f.commands.length,0);
  f.ui.selectHandCard(card);f.click(actionControl(f,'confirm-card'));
  assert.deepEqual(f.commands,[{type:'install-tool',fields:{cardId}}]);assert.deepEqual(game,before);
});

function fullToolReplacement(f){
  const game=act(act(fresh(),'peek'),'keep-peek');
  const installed=['t01','t02','t03'].map(code=>{
    const cardId=give(game,code);game.players[0].hand=game.players[0].hand.filter(id=>id!==cardId);
    game.players[0].tools.push({cardId,exhausted:false});return cardId;
  });
  const cardId=give(game,'t05'),otherCardId=give(game,'t06');f.ui.applyView(room(game));
  const self=privateView(game,ids[0]).players[0];
  f.ui.selectHandCard(self.hand.find(card=>card.cardId===cardId));
  f.ui.selectHandCard(self.tools.find(card=>card.cardId===installed[1]),true);
  return {game,cardId,otherCardId,installed};
}

test('authoritative free tool replacement before its receipt clears the old draft and leaves the next tool usable',async t=>{
  const waiting=deferred();let calls=0;
  const f=fixture(t,{onAction:()=>++calls===1?waiting.promise:true}),{game,cardId,installed}=fullToolReplacement(f);
  f.click(actionControl(f,'confirm-card'));
  assert.deepEqual(f.commands,[{type:'install-tool',fields:{cardId,replaceCardId:installed[1]}}]);
  const after=act(game,'install-tool',f.commands[0].fields);
  assert.equal(after.actionsUsed,game.actionsUsed,'free installation does not change the action counter');
  assert.equal(after.turnId,game.turnId);assert.equal(after.pending,null);
  assert.ok(after.discard.includes(installed[1]));
  assert.deepEqual(after.players[0].tools.map(tool=>tool.cardId),[installed[0],installed[2],cardId]);
  assert.doesNotThrow(()=>f.ui.applyView(room(after)),'authority may arrive while the HTTP receipt is still unresolved');
  assert.equal(f.root.querySelector('.hy-action-draft'),null,'an installed card can no longer remain a hand installation draft');
  assert.equal(f.root.getAttribute('aria-busy'),'true','the first command gate remains until its receipt');
  assert.equal(f.commands.length,1);
  waiting.resolve(true);await flush();
  assert.equal(f.root.getAttribute('aria-busy'),'false');
  const installedCard=privateView(after,ids[0]).players[0].tools.find(card=>card.cardId===cardId);
  f.ui.selectHandCard(installedCard,true);
  const activate=actionControl(f,'confirm-card');assert.equal(activate.disabled,false);f.click(activate);await flush();
  assert.equal(f.commands.length,2);assert.equal(f.commands[1].type,'activate-tool');assert.equal(f.commands[1].fields.cardId,cardId);
  const activated=act(after,f.commands[1].type,f.commands[1].fields);
  assert.equal(activated.players[0].tools.find(tool=>tool.cardId===cardId).exhausted,true,'subsequent interaction is a legal game action');
  assert.equal(activated.actionsUsed,after.actionsUsed+1);
});

test('unchanged heartbeat views preserve both the hand tool and its chosen replacement',t=>{
  const f=fixture(t),{game,cardId,installed}=fullToolReplacement(f),before=structuredClone(game);
  const selectedName=getCard('yousei.t05').name,replacedName=getCard('yousei.t02').name;
  for(const offset of [1000,5000,10000]){
    assert.doesNotThrow(()=>f.ui.applyView({...room(game),serverTime:context.now+offset}));
    assert.equal(f.root.querySelector('.hy-inline-card .yousei-card__name').textContent,selectedName);
    assert.ok(f.byId('yg-scene-content').textContent.includes(`将弃掉${replacedName}`));
    assert.equal(actionControl(f,'confirm-card').disabled,false);
    assert.deepEqual(f.commands,[],'heartbeat rendering is not a game submission');
  }
  f.click(actionControl(f,'confirm-card'));
  assert.deepEqual(f.commands,[{type:'install-tool',fields:{cardId,replaceCardId:installed[1]}}]);
  assert.deepEqual(game,before,'preselection and heartbeat do not mutate authoritative game state');
});

test('an invalidated replacement target requires reselection without submitting the vanished tool',t=>{
  const f=fixture(t),{game,cardId,otherCardId,installed}=fullToolReplacement(f);
  // A second client for the same seat installs a different tool first; the
  // locally selected source remains in hand, but its replacement has gone.
  const after=act(game,'install-tool',{cardId:otherCardId,replaceCardId:installed[1]});
  assert.equal(after.actionsUsed,game.actionsUsed);assert.equal(after.turnId,game.turnId);
  assert.doesNotThrow(()=>f.ui.applyView(room(after)));
  assert.equal(f.root.querySelector('.hy-inline-card .yousei-card__name').textContent,getCard('yousei.t05').name);
  assert.match(f.byId('yg-scene-content').textContent,/点现有装备，选择替换的一件/u);
  const confirm=actionControl(f,'confirm-card');assert.equal(confirm.disabled,true);f.click(confirm);
  assert.deepEqual(f.commands,[],'a stale replacement cannot be sent even if the disabled control receives a click');
  const target=privateView(after,ids[0]).players[0].tools.find(card=>card.cardId===otherCardId);
  f.ui.selectHandCard(target,true);assert.equal(actionControl(f,'confirm-card').disabled,false);
  f.click(actionControl(f,'confirm-card'));
  assert.deepEqual(f.commands,[{type:'install-tool',fields:{cardId,replaceCardId:otherCardId}}]);
  const replaced=act(after,'install-tool',f.commands[0].fields);
  assert.ok(replaced.players[0].tools.some(tool=>tool.cardId===cardId));assert.ok(replaced.discard.includes(otherCardId));
});

test('ordinary blur cancels the travelling copy while preserving the selected card until explicit confirmation',t=>{
  const f=fixture(t),{cardId}=readyCard(f),draft=f.root.querySelector('.hy-action-draft');
  assert.ok(f.root.querySelector('.hy-table-motion'));
  f.document.defaultView.dispatchEvent(new Event('blur'));
  assert.equal(f.root.querySelector('.hy-table-motion'),null);
  assert.ok(f.root.querySelector('.hy-action-draft')===draft);
  assert.equal(f.root.querySelector('.hy-inline-card .yousei-card').style.visibility??'','');
  assert.deepEqual(f.commands,[]);
  f.click(actionControl(f,'confirm-card'));
  assert.deepEqual(f.commands,[{type:'play-character',fields:{cardId,params:{}}}]);
});

test('a new authority phase and conceal still clear a card draft preserved through blur',t=>{
  const f=fixture(t),{game,card}=readyCard(f);
  f.document.defaultView.dispatchEvent(new Event('blur'));
  assert.ok(f.root.querySelector('.hy-action-draft'));
  f.ui.applyView(room(game,{phase:'paused',manual:true}));
  assert.equal(f.root.querySelector('.hy-action-draft'),null);
  f.ui.applyView(room(game));f.ui.selectHandCard(card);
  f.document.defaultView.dispatchEvent(new Event('blur'));f.ui.conceal();
  assert.equal(f.root.querySelector('.hy-action-draft'),null);assert.deepEqual(f.commands,[]);
});

test('T03 selected material survives member and card reading, then the same visible confirmation activates once',t=>{
  const f=fixture(t);let game=fresh();const toolId=give(game,'t03'),paymentId=give(game,'g01');
  game.players[0].hand=game.players[0].hand.filter(id=>id!==toolId);game.players[0].tools.push({cardId:toolId,exhausted:false});
  game=act(act(game,'peek'),'keep-peek');const before=structuredClone(game);
  f.ui.applyView(room(game));f.click(f.root.querySelectorAll('.yg-equipped').find(node=>node.dataset.toolId===toolId));
  const handCard=f.root.querySelector(`[data-entity-id="${paymentId}"]`);f.click(handCard.querySelector('button[data-card-id]'));
  const confirm=actionControl(f,'confirm-card'),draft=f.root.querySelector('.hy-action-draft');
  assert.equal(f.root.querySelector(`[data-entity-id="${paymentId}"]`).classList.contains('is-selected'),true);
  f.click(f.byId('yg-shop-detail'));assert.equal(f.byId('yg-inspector').open,true);
  f.click(f.byId('yg-inspector-close'));assert.equal(f.byId('yg-inspector').open,false);
  f.click(f.root.querySelector('.hy-inline-card [data-hy-detail]'));assert.equal(f.byId('hy-card-reader').open,true);
  f.click(f.byId('hy-reader-close'));assert.equal(f.byId('hy-card-reader').open,false);
  f.document.defaultView.innerWidth=1490;f.document.defaultView.dispatchEvent(new Event('resize'));
  assert.ok(f.root.querySelector('.hy-action-draft')===draft,'same-profile resizing leaves the original selected work visible');
  assert.ok(actionControl(f,'confirm-card')===confirm);assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  f.click(confirm);
  assert.deepEqual(f.commands,[{type:'activate-tool',fields:{cardId:toolId,params:{cardIds:[paymentId]}}}]);
  game=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(game.pending,null);assert.equal(game.actionsUsed,before.actionsUsed+1);
  assert.equal(game.players[0].tools.find(tool=>tool.cardId===toolId).exhausted,true);
});

test('a pending T03 material draft remains selected after reading and submits only its explicit choice',t=>{
  const f=fixture(t);let game=fresh();const toolId=give(game,'t03'),paymentId=give(game,'g01');
  game.players[0].hand=game.players[0].hand.filter(id=>id!==toolId);game.players[0].tools.push({cardId:toolId,exhausted:false});
  game=act(act(game,'peek'),'keep-peek');game=act(game,'activate-tool',{cardId:toolId});const actionsUsed=game.actionsUsed;
  f.ui.applyView(room(game));f.click(f.root.querySelector(`[data-entity-id="${paymentId}"] button[data-card-id]`));
  assert.equal(f.root.querySelector(`[data-entity-id="${paymentId}"]`).classList.contains('is-selected'),true);
  f.click(f.byId('yg-shop-detail'));f.click(f.byId('yg-inspector-close'));
  f.click(f.root.querySelector('.hy-work-face [data-detail-id]'));assert.equal(f.byId('hy-card-reader').open,true);
  f.click(f.byId('hy-reader-close'));assert.deepEqual(f.commands,[]);
  f.click(actionControl(f,'native-confirm'));
  assert.deepEqual(f.commands,[{type:'choose-effect',fields:{selection:{cardIds:[paymentId]}}}]);
  game=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(game.pending,null);assert.equal(game.actionsUsed,actionsUsed,'returning from reading cannot activate or charge the tool twice');
});

test('auction lot cards open the existing reader without changing the amount or submitting a bid',t=>{
  const f=fixture(t);let game=fresh();const source=give(game,'c12');
  game=act(act(game,'peek'),'keep-peek');game=act(game,'play-character',{cardId:source});const before=structuredClone(game);
  assert.ok(game.pending.data.auction);f.ui.applyView(room(game));
  const input=f.byId('hy-native-bid-amount'),amount=Number(input.getAttribute('min'))+2;input.value=String(amount);
  const event=new Event('input');Object.defineProperty(event,'target',{value:input});f.root.dispatchEvent(event);
  const lot=f.root.querySelectorAll('.hy-material-card[data-material-card]');assert.equal(lot.length,3);
  for(const card of lot){
    assert.equal(card.tagName,'BUTTON','each public lot card is an actionable reader entry');
    assert.match(card.getAttribute('aria-label'),/^阅读.+完整牌文$/u);assert.ok(card.dataset.detailId);
    assert.equal(card.dataset.hyAction,undefined,'reading a public lot is never a bid or selection command');
    f.click(card);assert.equal(f.byId('hy-card-reader').open,true);
    assert.equal(f.byId('hy-reader-body').querySelector('.yousei-card').dataset.cardId,card.dataset.detailId);
    f.click(f.byId('hy-reader-close'));assert.equal(f.byId('hy-card-reader').open,false);
    assert.equal(f.byId('hy-native-bid-amount').value,String(amount));assert.deepEqual(f.commands,[]);
  }
  f.ui.applyView(room(game));assert.equal(f.byId('hy-native-bid-amount').value,String(amount));
  assert.deepEqual(game,before);assert.deepEqual(f.commands,[]);
  f.click(actionControl(f,'native-bid'));assert.deepEqual(f.commands,[{type:'bid',fields:{amount}}]);
  game=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(game.players[0].silver,before.players[0].silver,'an unsettled bid does not charge the bidder');
  assert.equal(game.actionsUsed,before.actionsUsed);
});

test('public discard browsing starts with the latest cards and keeps original references across pages', t => {
  const f=fixture(t), game=fresh();
  for(let i=1;i<=9;i++) {
    const id=give(game,`g${String(i).padStart(2,'0')}`);
    game.players[0].hand=game.players[0].hand.filter(card=>card!==id);game.discard.push(id);
  }
  const before=structuredClone(game), projected=room(game,{selfId:ids[1]}), projectedBefore=structuredClone(projected.game.discard);
  f.ui.applyView(projected);f.click(f.byId('yg-discard-pile'));
  const body=f.byId('yg-inspector-body'), newest=[...projectedBefore].reverse();
  assert.deepEqual(body.querySelectorAll('[data-definition-id]').map(node=>node.dataset.definitionId),newest.slice(0,6).map(card=>card.definitionId));
  assert.deepEqual(body.querySelectorAll('[data-hy-detail]').map(node=>node.dataset.hyDetail),newest.slice(0,6).map(card=>card.ref));
  const next=body.querySelectorAll('[data-hy-action="discard-page"]').find(node=>node.textContent==='下一页');
  next.setAttribute('data-hy-fields',next.dataset.hyFields.replace(/&quot;/gu,'"'));f.click(next);
  assert.deepEqual(body.querySelectorAll('[data-definition-id]').map(node=>node.dataset.definitionId),newest.slice(6).map(card=>card.definitionId));
  assert.deepEqual(game,before);assert.deepEqual(projected.game.discard,projectedBefore);assert.equal(f.commands.length,0);
  const reading=body.querySelector('.hy-dialog-content'),strip=body.querySelector('.hy-public-discard');
  reading.scrollTop=35;strip.scrollLeft=120;
  const peek=act(game,'peek');f.ui.applyView(room(peek,{selfId:ids[1]}));
  assert.match(body.textContent,/第2\/2页/u,'another player entering a decision does not reset the discard page');
  assert.equal(body.querySelector('.hy-public-discard'),strip);assert.equal(reading.scrollTop,35);assert.equal(strip.scrollLeft,120);
  const discarded=act(peek,'discard-peek');f.ui.applyView(room(discarded,{selfId:ids[1]}));
  assert.match(body.textContent,/第2\/2页/u,'new public discards keep the reading page');
  assert.equal(body.querySelector('.hy-dialog-content'),reading);assert.equal(body.querySelector('.hy-public-discard'),strip);
  assert.equal(reading.scrollTop,35);assert.equal(strip.scrollLeft,120);
  const reduced=structuredClone(discarded);reduced.deck.push(...reduced.discard.splice(0,reduced.discard.length-3));
  f.ui.applyView(room(reduced,{selfId:ids[1]}));
  assert.equal(body.querySelectorAll('.hy-discard-card').length,3,'a removed last page clamps to the remaining pile');
  assert.deepEqual(f.commands,[]);
});

test('discard copies use complete original faces and one whole-card reader without selecting or consuming materials',t=>{
  const f=fixture(t),{game,card}=readyCard(f,'t02');
  for(const id of ['yousei.g08#01','yousei.g08#02']){
    game.deck=game.deck.filter(item=>item!==id);for(const player of game.players)player.hand=player.hand.filter(item=>item!==id);game.discard.push(id);
  }
  f.ui.applyView(room(game));f.ui.selectHandCard(card);f.click(f.byId('yg-discard-pile'));
  const copies=f.byId('yg-inspector-body').querySelectorAll('.hy-discard-card');assert.equal(copies.length,2);
  assert.notEqual(copies[0].dataset.hyDetail,copies[1].dataset.hyDetail);
  for(const node of copies){assert.ok(node.querySelector('.yousei-card__prices'));assert.ok(node.querySelector('.yousei-card__goods'));assert.equal(node.querySelectorAll('button').length,0);assert.doesNotMatch(node.querySelector('.yousei-card__name').textContent,/G08/u);}
  f.click(copies[0]);assert.equal(f.byId('hy-card-reader').open,true);assert.equal(f.byId('yg-inspector').open,true);
  f.click(f.byId('hy-reader-close'));f.click(f.byId('yg-inspector-close'));
  assert.ok(actionControl(f,'confirm-card'));assert.deepEqual(f.commands,[]);
});

const historyGroup=(sequence,event,turn=null)=>({schemaVersion:turn?2:1,sequence,committedAt:1000+sequence,events:[event],...(turn?{turn,sourceCardId:null,changes:[],discard:{beforeCount:0,afterCount:0,removed:[],added:[]}}:{})});
function historyPacket(groups,after,limit=50){const items=groups.filter(group=>group.sequence>after).slice(0,limit);return {groups:items,nextAfter:items.at(-1)?.sequence??after,headSequence:groups.at(-1)?.sequence??0,hasMore:(items.at(-1)?.sequence??after)<(groups.at(-1)?.sequence??0)};}
function battleControl(f,action,choose=()=>true){const node=f.root.querySelectorAll(`[data-hy-battle="${action}"]`).find(choose);assert.ok(node,action);if(node.dataset.hyBattleFields)node.setAttribute('data-hy-battle-fields',node.dataset.hyBattleFields.replace(/&quot;/gu,'"'));return node;}
async function reportSettled(f){for(let i=0;i<100;i++){await new Promise(resolve=>setTimeout(resolve,10));if(!f.byId('yg-inspector-body')?.textContent.includes('正在读取本局战况'))return;}assert.fail('battle history did not settle');}
function setHistoryTurn(game,sequence,number=1){Object.assign(game,{publicEventSequence:sequence,revision:sequence-1,turnId:`turn-${number}`,turnNumber:number,turnIndex:(number-1)%2,turnPlayerId:ids[(number-1)%2],round:Math.ceil(number/2)});Object.assign(game.timing.active,{id:game.turnId,actorId:game.turnPlayerId});return game;}

test('mounted battle report reads more than 50 committed groups into one actual turn and public card reading never submits',async t=>{
  const groups=Array.from({length:57},(_,i)=>historyGroup(i+1,i?{type:'trade-sold',actorSeatId:ids[0],cardId:'yousei.g08',goods:{foreign:2},silver:11}:{type:'match-started'}));
  const requests=[],f=fixture(t,{onHistory:options=>{requests.push(options);return historyPacket(groups,options.after,options.limit);}}),game=fresh();game.publicEventSequence=57;game.revision=56;
  f.ui.applyView(room(game));f.click(actionControl(f,'history'));await reportSettled(f);
  assert.deepEqual(requests,[{after:7,limit:50},{after:0,limit:50}]);
  assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,57);
  assert.match(f.byId('yg-inspector-body').textContent,/第1回合/u);
  assert.equal(battleControl(f,'page',node=>node.textContent==='下一回合').disabled,true);
  const reader=f.byId('yg-inspector-body').querySelector('[data-hy-read-card]');f.click(reader);assert.equal(f.byId('hy-card-reader').open,true);
  f.click(f.byId('hy-reader-close'));assert.equal(f.byId('yg-inspector').open,true);assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,57);
  assert.deepEqual(f.commands,[]);
});

test('battle tabs and one-player turn paging retain manual page and reading position across new authority events',async t=>{
  const groups=[historyGroup(1,{type:'match-started'}),historyGroup(2,{type:'trade-sold',actorSeatId:ids[0],cardId:'yousei.g01',goods:{firearms:3},silver:10}),historyGroup(3,{type:'turn-ended',actorSeatId:ids[0]}),historyGroup(4,{type:'response-played',actorSeatId:ids[0],cardId:'yousei.c07'}),historyGroup(5,{type:'turn-ended',actorSeatId:ids[1]}),historyGroup(6,{type:'draw-peeked',actorSeatId:ids[0]})];
  const f=fixture(t,{onHistory:({after,limit})=>historyPacket(groups,after,limit)}),game=fresh();Object.assign(game,{publicEventSequence:6,revision:5,turnId:'turn-3',turnNumber:3,turnPlayerId:ids[0],round:2});game.timing.active.id='turn-3';
  f.ui.applyView(room(game));f.click(actionControl(f,'history'));await flush();
  assert.match(f.byId('yg-inspector-body').textContent,/我 · 第2回合/u);
  f.click(battleControl(f,'player',node=>node.textContent==='伙伴'));
  assert.deepEqual(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').map(node=>node.dataset.historySequence),['4','5']);
  assert.match(f.byId('yg-inspector-body').textContent,/我以锦衣卫回应/u,'other players responses stay on the active owner turn');
  const scroll=f.byId('yg-inspector-body').querySelector('[data-hy-battle-scroll]');scroll.scrollTop=123;
  const read=f.byId('yg-inspector-body').querySelector('[data-hy-read-card]');f.click(read);f.click(f.byId('hy-reader-close'));assert.equal(scroll.scrollTop,123);
  groups.push(historyGroup(7,{type:'turn-ended',actorSeatId:ids[0]}));const next=structuredClone(game);Object.assign(next,{publicEventSequence:7,revision:6,turnId:'turn-4',turnNumber:4,turnPlayerId:ids[1],turnIndex:1});next.timing.active.id='turn-4';next.timing.active.actorId=ids[1];
  f.ui.applyView(room(next));await flush();
  assert.match(f.byId('yg-inspector-body').textContent,/伙伴 · 第1回合/u);assert.equal(f.byId('yg-inspector-body').querySelector('[data-hy-battle-scroll]').scrollTop,123);
  assert.match(f.byId('yg-inspector-body').textContent,/有新的战况/u);
  f.click(battleControl(f,'current'));assert.match(f.byId('yg-inspector-body').textContent,/伙伴 · 第2回合/u);assert.match(f.byId('yg-inspector-body').textContent,/本回合尚未行动/u);assert.deepEqual(f.commands,[]);
});

test('late battle requests cannot reopen a closed inspector, overwrite another inspector, or survive conceal and account generations',async t=>{
  for(const end of ['close','members','conceal','match','destroy']){
    const waiting=deferred(),f=fixture(t,{onHistory:()=>waiting.promise}),game=fresh();game.publicEventSequence=2;game.revision=1;
    f.ui.applyView(room(game));f.click(actionControl(f,'history'));assert.equal(f.byId('yg-inspector').open,true);
    if(end==='close')f.click(f.byId('yg-inspector-close'));
    if(end==='members')f.click(actionControl(f,'members'));
    if(end==='conceal'){f.ui.conceal();f.ui.applyView(room(game,{selfId:ids[1]}));}
    if(end==='match'){const next=structuredClone(game);next.matchId='d'.repeat(32);f.ui.applyView(room(next));}
    if(end==='destroy')f.ui.destroy();
    const before=f.root.textContent;waiting.resolve(historyPacket([historyGroup(1,{type:'match-started'}),historyGroup(2,{type:'character-played',actorSeatId:ids[0],cardId:'yousei.m01'})],0));await flush();
    assert.equal(f.root.textContent,before,end);assert.deepEqual(f.commands,[]);
  }
});

test('partial battle load failure preserves its 50 confirmed groups, retries from the cursor, and return to table keeps the play draft',async t=>{
  const groups=Array.from({length:52},(_,i)=>historyGroup(i+1,i?{type:'draw-peeked',actorSeatId:ids[0]}:{type:'match-started'}));
  let fail=true;const requests=[],f=fixture(t,{onHistory:({after,limit})=>{requests.push(after);if(after===50&&fail)throw new Error('网络中断');return historyPacket(groups,after,after===2?48:limit);}}),{game,card}=readyCard(f,'t02');
  game.publicEventSequence=52;game.revision=51;f.ui.applyView(room(game));f.ui.selectHandCard(card);f.click(actionControl(f,'history'));await reportSettled(f);
  assert.match(f.byId('yg-inspector-body').textContent,/网络中断/u);assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,48);
  fail=false;f.click(battleControl(f,'retry'));await reportSettled(f);assert.deepEqual(requests,[2,50,50,0]);assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,52);
  f.click(f.byId('yg-inspector-close'));assert.ok(actionControl(f,'confirm-card'));assert.deepEqual(f.commands,[]);
});

test('new-format long matches load the tail and complete only requested turns instead of re-reading a thousand groups',async t=>{
  const groups=Array.from({length:1000},(_,index)=>{
    const sequence=index+1,number=Math.ceil(sequence/100),ownerSeatId=ids[(number-1)%2];
    const event=sequence===1?{type:'match-started'}:sequence%100===0&&number<10?{type:'turn-ended',actorSeatId:ownerSeatId}:{type:'draw-peeked',actorSeatId:ownerSeatId};
    return historyGroup(sequence,event,{id:`turn-${number}`,number,round:Math.ceil(number/2),ownerSeatId});
  });
  const requests=[],f=fixture(t,{onHistory:({after,limit})=>{requests.push(after);return historyPacket(groups,after,limit);}}),game=setHistoryTurn(fresh(),1000,10);
  f.ui.applyView(room(game));f.click(actionControl(f,'history'));await reportSettled(f);
  assert.deepEqual(requests,[950,900,850]);assert.match(f.byId('yg-inspector-body').textContent,/伙伴 · 第5回合/u);
  assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,100);
  assert.doesNotMatch(f.byId('yg-inspector-body').textContent,/本页含未完整/u);
  f.click(battleControl(f,'player',node=>node.textContent==='我'));await reportSettled(f);
  assert.match(f.byId('yg-inspector-body').textContent,/我 · 第5回合/u);assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,100);
  f.click(battleControl(f,'page',node=>node.textContent==='上一回合'));await reportSettled(f);
  assert.match(f.byId('yg-inspector-body').textContent,/我 · 第4回合/u);
  assert.deepEqual(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').map(node=>Number(node.dataset.historySequence)),Array.from({length:100},(_,i)=>601+i));
  assert.ok(requests.every(after=>after>=550));assert.equal(new Set(requests).size,requests.length);assert.deepEqual(f.commands,[]);
});

test('battle report freezes its public upper bound then appends one confirmed tail without duplicate steps or stealing upward reading',async t=>{
  const turn={id:'turn-1',number:1,round:1,ownerSeatId:ids[0]},groups=Array.from({length:6},(_,i)=>historyGroup(i+1,i?{type:'draw-peeked',actorSeatId:ids[0]}:{type:'match-started'},turn));
  const requests=[],f=fixture(t,{onHistory:({after,limit})=>{requests.push(after);return historyPacket(groups,after,limit);}}),game=setHistoryTurn(fresh(),5);
  f.ui.applyView(room(game));f.click(actionControl(f,'history'));await reportSettled(f);
  assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,5,'an ahead provider cannot reveal a step not confirmed by the room projection');
  let scroll=f.byId('yg-inspector-body').querySelector('[data-hy-battle-scroll]');scroll.scrollHeight=1000;scroll.scrollTop=500;
  let event=new Event('scroll');Object.defineProperty(event,'target',{value:scroll});f.root.dispatchEvent(event);
  scroll.scrollTop=120;event=new Event('scroll');Object.defineProperty(event,'target',{value:scroll});f.root.dispatchEvent(event);
  f.ui.applyView(room(setHistoryTurn(structuredClone(game),6)));await reportSettled(f);
  assert.equal(f.byId('yg-inspector-body').querySelector('[data-hy-battle-scroll]'),scroll,'upward reading and an appended tail preserve the native gesture owner');
  assert.equal(scroll.scrollTop,120);
  scroll.scrollTop=40;event=new Event('scroll');Object.defineProperty(event,'target',{value:scroll});f.root.dispatchEvent(event);
  scroll.scrollTop=180;event=new Event('scroll');Object.defineProperty(event,'target',{value:scroll});f.root.dispatchEvent(event);
  assert.equal(f.byId('yg-inspector-body').querySelector('[data-hy-battle-scroll]'),scroll,'repeated up/down reading never detaches the container');
  assert.equal(scroll.scrollTop,180);
  assert.equal(f.byId('yg-inspector-body').querySelectorAll('[data-history-sequence]').length,6);assert.deepEqual(requests,[0,5]);
  assert.ok(battleControl(f,'current'));assert.deepEqual(f.commands,[]);
});

test('discard provenance reuses the public report cache by exact positions and refuses to bridge an unread newer commit',async t=>{
  const turn={id:'turn-1',number:1,round:1,ownerSeatId:ids[0]},groups=[historyGroup(1,{type:'match-started'},turn),historyGroup(2,{type:'draw-discarded',actorSeatId:ids[0],cardId:'yousei.g08'},turn),historyGroup(3,{type:'choice-resolved',actorSeatId:ids[1]},turn)];
  groups[1].discard={beforeCount:0,afterCount:1,removed:[],added:[{index:0,cardId:'yousei.g08',actorSeatId:ids[0],reason:'draw-discarded',sourceCardId:null}]};
  groups[2].discard={beforeCount:1,afterCount:2,removed:[],added:[{index:1,cardId:'yousei.g08',actorSeatId:ids[1],reason:'payment',sourceCardId:'yousei.t10'}]};
  const requests=[],f=fixture(t,{onHistory:({after,limit})=>{requests.push(after);return historyPacket(groups,after,limit);}}),game=setHistoryTurn(fresh(),3);
  for(const id of ['yousei.g08#01','yousei.g08#02']){game.deck=game.deck.filter(item=>item!==id);for(const player of game.players)player.hand=player.hand.filter(item=>item!==id);game.discard.push(id);}
  f.ui.applyView(room(game));f.click(f.byId('yg-discard-pile'));assert.deepEqual(requests,[],'opening the pile must not fetch the entire match');assert.match(f.byId('yg-inspector-body').textContent,/来源尚未载入/u);
  f.click(actionControl(f,'history'));await reportSettled(f);f.click(f.byId('yg-inspector-close'));f.click(f.byId('yg-discard-pile'));
  assert.deepEqual(f.byId('yg-inspector-body').querySelectorAll('.hy-discard-origin').map(node=>node.textContent),['伙伴 · 作为费用 · 贪嘴泥翁','我 · 摸看后弃置']);
  const next=setHistoryTurn(structuredClone(game),4),removed=next.discard.pop();next.deck.push(removed);f.ui.applyView(room(next));
  assert.equal(f.byId('yg-inspector-body').querySelectorAll('.hy-discard-card').length,1);assert.match(f.byId('yg-inspector-body').textContent,/来源尚未载入/u);
  groups.push(historyGroup(4,{type:'choice-resolved',actorSeatId:ids[1]},turn));groups[3].discard={beforeCount:2,afterCount:1,removed:[{index:1,cardId:'yousei.g08'}],added:[]};
  f.click(actionControl(f,'history'));await reportSettled(f);f.click(f.byId('yg-inspector-close'));f.click(f.byId('yg-discard-pile'));
  assert.deepEqual(requests,[0,3],'reopening report appends only its missing public tail');assert.match(f.byId('yg-inspector-body').textContent,/我 · 摸看后弃置/u);assert.deepEqual(f.commands,[]);
});

test('battle is read-only while a rule confirmation is pending and does not release the one-command gate',async t=>{
  const waiting=deferred(),f=fixture(t,{onAction:()=>waiting.promise,onHistory:()=>historyPacket([historyGroup(1,{type:'match-started'})],0)});
  readyCard(f,'t02');f.click(actionControl(f,'confirm-card'));assert.equal(f.commands.length,1);
  const history=actionControl(f,'history');assert.equal(history.disabled,false);f.click(history);await reportSettled(f);assert.equal(f.byId('yg-inspector').open,true);
  f.click(f.byId('yg-inspector-close'));assert.equal(actionControl(f,'confirm-card').disabled,true);assert.equal(f.commands.length,1);
  waiting.resolve(false);await flush();assert.equal(actionControl(f,'confirm-card').disabled,false);
});

test('slow save locks repeated confirmation and cancellation until its single request completes',async t=>{
  const waiting=deferred(),f=fixture(t,{onAction:()=>waiting.promise});readyCard(f);
  const confirm=actionControl(f,'confirm-card'),cancel=actionControl(f,'cancel-card');
  f.click(confirm);f.click(confirm);f.click(cancel);
  assert.equal(f.commands.length,1);assert.equal(f.root.getAttribute('aria-busy'),'true');
  assert.equal(confirm.disabled,true);assert.equal(cancel.disabled,true);assert.match(f.byId('hy-connection-text').textContent,/正在结算/u);
  assert.ok(f.root.querySelector('.hy-action-draft'),'queued cancellation cannot clear an unacknowledged operation');
  waiting.resolve(true);await flush();
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.equal(f.root.querySelector('.hy-action-draft'),null);
});

for(const failure of ['false','reject'])test(`slow ${failure} save releases the gate and keeps the card draft for a retry`,async t=>{
  const waiting=deferred();let attempts=0;const f=fixture(t,{onAction:()=>++attempts===1?waiting.promise:false});const {cardId}=readyCard(f);
  f.click(actionControl(f,'confirm-card'));
  if(failure==='reject')waiting.reject(Error('本地保存失败'));else waiting.resolve(false);
  await flush();
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.ok(f.root.querySelector('.hy-action-draft'));
  const retry=actionControl(f,'confirm-card');assert.equal(retry.disabled,false);f.click(retry);await flush();
  assert.equal(f.commands.length,2);assert.deepEqual(f.commands.map(c=>c.fields.cardId),[cardId,cardId]);
});

for(const outcome of ['true','false','reject'])test(`static practice settings survive repeated in-flight views and the ${outcome} receipt`,async t=>{
  const waiting=deferred(),f=fixture(t,{practice:true,onAction:()=>waiting.promise}),{game}=readyCard(f);
  const restart=actionControl(f,'practice-restart'),members=actionControl(f,'members'),unavailable=f.byId('hy-practice-reload');
  unavailable.disabled=true;
  f.click(actionControl(f,'confirm-card'));f.ui.settings.open();
  assert.equal(f.byId('yg-options').open,true);assert.equal(restart.disabled,true);assert.equal(members.disabled,true);
  f.click(restart);assert.equal(f.byId('yg-inspector').open,false,'settings cannot act during a save');
  f.ui.applyView(room(game));f.ui.applyView(room(game));
  assert.equal(actionControl(f,'practice-restart'),restart,'settings keep their mounted nodes');
  assert.equal(restart.disabled,true);assert.equal(unavailable.disabled,true);assert.equal(f.commands.length,1);
  if(outcome==='reject')waiting.reject(Error('保存未成功'));else waiting.resolve(outcome==='true');
  await flush();
  assert.equal(restart.disabled,false);assert.equal(members.disabled,false);assert.equal(unavailable.disabled,true,'an earlier disabled control must remain disabled');
  assert.equal(f.root.getAttribute('aria-busy'),'false');f.ui.settings.open();f.click(restart);
  assert.equal(f.byId('yg-inspector-title').textContent,'开始新的练习');assert.equal(f.commands.length,1);
});

test('synchronous authoritative applyView is recomputed before the save gate is released',async t=>{
  const waiting=deferred();let f,game;
  f=fixture(t,{onAction:(type,fields)=>{game=act(game,type,fields);f.ui.applyView(room(game),{canAct:false});return waiting.promise;}});
  ({game}=readyCard(f));const members=actionControl(f,'members');f.click(actionControl(f,'confirm-card'));
  assert.equal(f.root.getAttribute('aria-busy'),'true');assert.equal(members.disabled,true);
  waiting.resolve(true);await flush();
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.equal(members.disabled,false);
  assert.equal(f.byId('hy-room-control').disabled,true,'authority still prevents saving');
  assert.equal(f.root.querySelector('[data-hy-action="confirm-card"]'),null);assert.equal(f.root.querySelector('[data-hy-action="end-turn"]'),null);
  assert.equal(f.commands.length,1);
});

for(const transition of ['paused','cannot-save','spectator'])test(`releasing a save gate preserves ${transition} authority`,async t=>{
  const waiting=deferred(),f=fixture(t,{onAction:()=>waiting.promise}),peek=act(fresh(),'peek');
  f.ui.applyView(room(peek));const members=actionControl(f,'members');f.click(actionControl(f,'keep-peek'));
  if(transition==='paused')f.ui.applyView(room(peek,{phase:'paused',manual:true}));
  else if(transition==='cannot-save')f.ui.applyView(room(peek),{canAct:false});
  else f.ui.applyView({...room(peek),selfId:'d'.repeat(32),selfRole:'spectator',hostId:ids[1],game:spectatorView(peek)});
  waiting.resolve(true);await flush();
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.equal(members.disabled,false);
  if(transition==='spectator'){
    assert.equal(f.byId('hy-pause').hidden,true);assert.equal(f.root.querySelector('[data-hy-action="keep-peek"]'),null);
    assert.equal(f.root.querySelector('.hy-work-face .yousei-card').classList.contains('yousei-card--back'),true,'spectators only see the card back');
    assert.equal(f.root.querySelector('.hy-work-face .yousei-card__name'),null);
  }else{
    const keep=actionControl(f,'keep-peek');assert.notEqual(keep.getAttribute('disabled'),null);
    f.click(keep);assert.equal(f.commands.length,1,'settling cannot re-enable an unauthorized game action');
    assert.equal(f.byId('hy-room-control').disabled,transition==='cannot-save');
  }
});

test('destroy releases temporary node state and ignores a late failed receipt',async t=>{
  const waiting=deferred(),f=fixture(t,{onAction:()=>waiting.promise});readyCard(f);
  const members=actionControl(f,'members');f.click(actionControl(f,'confirm-card'));assert.equal(members.disabled,true);
  f.ui.destroy();const after=f.root.textContent;
  assert.equal(members.disabled,false);assert.equal(f.root.getAttribute('aria-busy'),'false');
  waiting.reject(Error('已销毁页面的迟到错误'));await flush();
  assert.equal(f.root.textContent,after);assert.equal(f.commands.length,1);
});

test('an old scope completion cannot clear the next room draft or unlock its active save',async t=>{
  const old=deferred(),next=deferred();let attempt=0;const f=fixture(t,{onAction:()=>++attempt===1?old.promise:next.promise});readyCard(f);
  f.click(actionControl(f,'confirm-card'));
  const selected=readyCard(f,'c02',{roomId:'another-room'});f.click(actionControl(f,'confirm-card'));
  old.resolve(true);await flush();
  assert.equal(f.commands.length,2);assert.equal(f.root.getAttribute('aria-busy'),'true');
  assert.ok(f.root.querySelector('.hy-action-draft'));assert.match(f.byId('yg-scene-content').textContent,/卦师/u);
  next.resolve(false);await flush();
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.ok(f.root.querySelector('.hy-action-draft'));assert.equal(f.commands[1].fields.cardId,selected.cardId);
});

test('conceal isolates a pending completion from the next visible room draft',async t=>{
  const waiting=deferred(),f=fixture(t,{onAction:()=>waiting.promise});readyCard(f);f.click(actionControl(f,'confirm-card'));
  const members=actionControl(f,'members');assert.equal(members.disabled,true);
  f.ui.conceal();assert.equal(members.disabled,false);assert.equal(f.root.getAttribute('aria-busy'),'false');
  readyCard(f,'c02');waiting.resolve(true);await flush();
  assert.equal(members.disabled,false);
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.ok(f.root.querySelector('.hy-action-draft'));assert.match(f.byId('yg-scene-content').textContent,/卦师/u);
});

test('hand selections cannot replace the source draft while a confirmation is saving',async t=>{
  const waiting=deferred(),f=fixture(t,{onAction:()=>waiting.promise}),{game,cardId}=readyCard(f);
  const other=privateView(game,ids[0]).players[0].hand.find(card=>card.cardId!==cardId);assert.ok(other);
  f.click(actionControl(f,'confirm-card'));f.ui.selectHandCard(other);
  assert.equal(f.commands.length,1);assert.match(f.byId('yg-scene-content').textContent,/书算/u);
  assert.equal(f.root.querySelector('.hy-inline-card .yousei-card__name').textContent,'书算');
  waiting.resolve(false);await flush();
  assert.equal(f.root.querySelector('.hy-inline-card .yousei-card__name').textContent,'书算');
});

for(const outcome of ['resolve','reject'])test(`synchronous scope switch inside onAction ignores the old ${outcome} promise`,async t=>{
  const waiting=deferred();let f;
  f=fixture(t,{onAction:()=>{readyCard(f,'c02',{roomId:'synchronously-replaced-room'});return waiting.promise;}});
  readyCard(f);f.click(actionControl(f,'confirm-card'));
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.match(f.byId('yg-scene-content').textContent,/卦师/u);
  if(outcome==='resolve')waiting.resolve(true);else waiting.reject(Error('旧房间迟到的错误'));
  await flush();
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.ok(f.root.querySelector('.hy-action-draft'));assert.match(f.byId('yg-scene-content').textContent,/卦师/u);
  assert.equal(f.root.textContent.includes('旧房间迟到的错误'),false);
});

test('a synchronous old-scope throw does not write its error into the replacement room',t=>{
  let f;f=fixture(t,{onAction:()=>{readyCard(f,'c02',{roomId:'synchronously-replaced-room'});throw Error('旧房间同步错误');}});
  readyCard(f);f.click(actionControl(f,'confirm-card'));
  assert.equal(f.root.getAttribute('aria-busy'),'false');assert.ok(f.root.querySelector('.hy-action-draft'));assert.match(f.byId('yg-scene-content').textContent,/卦师/u);
  assert.equal(f.root.textContent.includes('旧房间同步错误'),false);
});

test('pending inline task keeps pause agreement and withdrawal available without submitting its choice',t=>{
  const f=fixture(t),game=act(fresh(),'peek');
  f.ui.applyView(room(game,{pause:{requestedBy:ids[1],agreedIds:[ids[1]]}}));
  const control=f.byId('hy-room-control');assert.equal(control.hidden,false);assert.match(control.textContent,/同意暂停/u);f.click(control);
  assert.deepEqual(f.commands.at(-1),{type:'pause',fields:{agree:true}});
  f.ui.applyView(room(game,{pause:{requestedBy:ids[0],agreedIds:[ids[0]]}}));f.click(control);
  assert.deepEqual(f.commands.at(-1),{type:'pause',fields:{agree:false}});
  assert.equal(f.commands.some(command=>command.type==='keep-peek'||command.type==='choose-effect'),false);
});

test('private hand reading stays independent while opponents act and make a pending choice',t=>{
  const f=fixture(t),viewer=ids[1],initial=fresh(),privateId=give(initial,'c01',1),tradeId=give(initial,'g01');
  const active=act(act(initial,'peek'),'keep-peek');f.ui.applyView(room(active,{selfId:viewer}));
  const bought=act(active,'buy',{cardId:tradeId});f.ui.applyView(room(bought,{selfId:viewer}));
  const publicBefore=f.byId('yg-scene-content').textContent;
  const card=privateView(bought,viewer).players.find(player=>player.id===viewer).hand.find(item=>item.cardId===privateId);
  f.ui.selectHandCard(card);
  assert.equal(f.byId('hy-card-reader').open,true);assert.match(f.byId('hy-reader-title').textContent,/把戏人/);
  assert.equal(f.byId('yg-scene-content').textContent,publicBefore);assert.equal(f.root.querySelector('.hy-action-draft'),null);assert.deepEqual(f.commands,[]);
  f.ui.applyView(room(bought,{selfId:viewer}));assert.equal(f.byId('hy-card-reader').open,true);
  f.click(f.byId('hy-reader-close'));assert.equal(f.byId('yg-scene-content').textContent,publicBefore);
  const pending=act(fresh(),'peek'),otherCard=privateView(pending,viewer).players.find(player=>player.id===viewer).hand[0];
  f.ui.applyView(room(pending,{selfId:viewer}));const pendingBefore=f.byId('yg-scene-content').textContent;
  f.ui.selectHandCard(otherCard);assert.equal(f.byId('hy-card-reader').open,true);assert.equal(f.byId('yg-scene-content').textContent,pendingBefore);assert.deepEqual(f.commands,[]);
  f.ui.applyView(room(act(pending,'keep-peek'),{selfId:viewer}));assert.equal(f.byId('hy-card-reader').open,true,'opponent step transitions do not dismiss a private reader');
});

test('another player committed action never animates the viewer private selected card',async t=>{
  const f=fixture(t),initial=fresh(),viewer=ids[1],privateId=give(initial,'c01',1),tradeId=give(initial,'g01');
  const active=act(act(initial,'peek'),'keep-peek');f.ui.applyView(room(active,{selfId:viewer}));
  const card=privateView(active,viewer).players.find(player=>player.id===viewer).hand.find(item=>item.cardId===privateId);f.ui.selectHandCard(card);
  const before=f.animations.length,bought=act(active,'buy',{cardId:tradeId});f.ui.applyView(room(bought,{selfId:viewer}));
  const flights=f.animations.slice(before).filter(animation=>animation.node.querySelector('.yousei-card'));
  assert.equal(flights.length,1,'the new opponent public action has a lawful card-back flight');
  assert.doesNotMatch(flights[0].node.textContent,/把戏人/,'the viewer private selected face never enters the flight');
  assert.match(f.root.querySelector('.hy-peer-played').textContent,/我买入/);
  for(let n=0;n<3;n++){f.animations.at(-1).resolve();await flush();}
  assert.equal(f.root.querySelector('.hy-peer-played .yousei-card')?.style.visibility??'','');
  assert.equal(f.byId('yg-discard-art').querySelector('.yousei-card')?.style.visibility??'','');
});

test('a committed card from another local client must match the selected face before it can move',t=>{
  const f=fixture(t),initial=fresh(),selectedId=give(initial,'c01'),tradeId=give(initial,'g01');
  const active=act(act(initial,'peek'),'keep-peek');f.ui.applyView(room(active));
  const card=privateView(active,ids[0]).players[0].hand.find(item=>item.cardId===selectedId);f.ui.selectHandCard(card);
  const before=f.animations.length,bought=act(active,'buy',{cardId:tradeId});f.ui.applyView(room(bought));
  assert.equal(f.animations.slice(before).filter(animation=>animation.node.querySelector('.yousei-card')).length,0,'matching actor alone does not authorize moving a different selected face; public economy feedback is allowed');
  assert.equal(f.byId('yg-discard-art').querySelector('.yousei-card')?.style.visibility??'','');
});

test('conceal removes the controller owned private work face and material area',t=>{
  const f=fixture(t),peek=act(fresh(),'peek');
  f.ui.applyView(room(peek));assert.ok(f.byId('yg-scene-content').querySelector('.yousei-card'));
  f.ui.conceal();
  assert.equal(f.byId('yg-scene-content').children.length,0);
  assert.equal(f.byId('hy-task-material-cards').children.length,0);
});

test('short response uses a concise confirmation while the free cost and discarded faces stay explicit',t=>{
  const f=fixture(t);Object.assign(f.document.defaultView,{innerWidth:844,innerHeight:390});
  let game=fresh();const source=give(game,'m01');give(game,'c07',1);game.players[1].goods.firearms=1;game.bankGoods.firearms--;
  game=act(act(game,'peek'),'keep-peek');game=act(game,'play-character',{cardId:source,params:{goodsId:'firearms'}});
  const view=privateView(game,ids[1]);f.ui.applyView(room(game,{selfId:ids[1]}));f.ui.selectHandCard(view.pending.response.cards[0]);
  assert.equal(f.root.querySelector('[data-hy-action="respond"]').textContent,'确认反制');
  assert.match(f.byId('yg-scene-content').textContent,/回应不花行动和银两/u);
  assert.match(f.byId('yg-scene-content').textContent,/阻止对方拿走火器×1/u);
  assert.match(f.byId('yg-scene-content').textContent,/锦衣卫和梁上君子弃置/u);
});

test('dragging a legal response only preselects it and blur keeps the explicit confirmation',t=>{
  const f=fixture(t);let game=fresh();const source=give(game,'m01'),responseId=give(game,'c07',1),otherId=give(game,'c03',1);
  game.players[1].goods.firearms=1;game.bankGoods.firearms--;
  game=act(act(game,'peek'),'keep-peek');game=act(game,'play-character',{cardId:source,params:{goodsId:'firearms'}});
  f.ui.applyView(room(game,{selfId:ids[1]}));
  f.pointer('pointerdown',otherId,300,350);f.pointer('pointermove',otherId,300,180);f.pointer('pointerup',otherId,300,180);
  assert.equal(f.root.querySelector('[data-hy-action="respond"]'),null);
  f.pointer('pointerdown',responseId,300,350);f.pointer('pointermove',responseId,300,180);
  assert.ok(f.root.querySelector('.hy-hand-ghost'));
  assert.match(f.root.querySelector('.hy-hand-drop').textContent,/回应/u);
  f.pointer('pointerup',responseId,300,180);
  assert.equal(f.root.querySelector('.hy-hand-ghost'),null);assert.deepEqual(f.commands,[]);
  assert.equal(f.root.querySelector(`[data-entity-id="${responseId}"]`).classList.contains('is-selected'),true);
  const confirm=actionControl(f,'respond');f.document.defaultView.dispatchEvent(new Event('blur'));
  assert.ok(actionControl(f,'respond')===confirm);assert.deepEqual(f.commands,[]);
  f.click(f.byId('yg-shop-detail'));assert.equal(f.byId('yg-inspector').open,true);f.click(f.byId('yg-inspector-close'));
  f.click(f.root.querySelector('.hy-work-face [data-detail-id]'));assert.equal(f.byId('hy-card-reader').open,true);f.click(f.byId('hy-reader-close'));
  assert.ok(actionControl(f,'respond')===confirm);assert.deepEqual(f.commands,[],'reading neither declines nor commits the selected response');
  f.click(confirm);assert.deepEqual(f.commands,[{type:'respond',fields:{cardId:responseId}}]);
  game=act(game,'respond',{cardId:responseId},ids[1]);f.ui.applyView(room(game,{selfId:ids[1]}));
  assert.equal(f.root.querySelector('[data-hy-action="respond"]'),null);
});

test('paused response cannot be dragged and blurring an unfinished legal response drag submits nothing',t=>{
  const f=fixture(t);let game=fresh();const source=give(game,'m01'),responseId=give(game,'c07',1);
  game.players[1].goods.firearms=1;game.bankGoods.firearms--;
  game=act(act(game,'peek'),'keep-peek');game=act(game,'play-character',{cardId:source,params:{goodsId:'firearms'}});
  f.ui.applyView(room(game,{selfId:ids[1],phase:'paused',manual:true}));
  f.pointer('pointerdown',responseId,300,350);f.pointer('pointermove',responseId,300,180);f.pointer('pointerup',responseId,300,180);
  assert.equal(f.root.querySelector('.hy-hand-ghost'),null);assert.equal(f.root.querySelector('[data-hy-action="respond"]'),null);
  f.ui.applyView(room(game,{selfId:ids[1]}));
  f.pointer('pointerdown',responseId,300,350);f.pointer('pointermove',responseId,300,180);
  assert.ok(f.root.querySelector('.hy-hand-ghost'));
  f.document.defaultView.dispatchEvent(new Event('blur'));f.pointer('pointerup',responseId,300,180);
  assert.equal(f.root.querySelector('.hy-hand-ghost'),null);assert.equal(f.root.querySelector('[data-hy-action="respond"]'),null);
  assert.deepEqual(f.commands,[]);
});

test('wish well prepares cancellable local materials then settles one complete authority command',t=>{
  const f=fixture(t);let game=fresh();const cardId=give(game,'t02');
  game.players[0].hand=game.players[0].hand.filter(id=>id!==cardId);
  game.players[0].tools.push({cardId,exhausted:false});
  game.players[0].goods.firearms=1;game.bankGoods.firearms--;
  game.players[0].goods.curios=1;game.bankGoods.curios--;
  game.players[1].goods.imports=1;game.bankGoods.imports--;
  game.players[1].goods.beasts=1;game.bankGoods.beasts--;
  game=act(act(game,'peek'),'keep-peek');const before=structuredClone(game);
  f.ui.applyView(room(game));f.ui.selectHandCard(privateView(game,ids[0]).players[0].tools[0],true);
  const control=action=>f.root.querySelector(`[data-hy-action="${action}"]`);
  const decodedFields=node=>node.dataset.hyFields.replace(/&quot;/gu,'"');
  const choose=(field,id)=>{const node=f.root.querySelectorAll('[data-hy-action="native-select"]').find(node=>{const value=JSON.parse(decodedFields(node));return value.type==='exchange'&&value.field===field&&value.id===id;});assert.ok(node,`${field} is shown before committing the tool`);node.setAttribute('data-hy-fields',decodedFields(node));f.click(node);};
  choose('ownGoodId','firearms');choose('otherGoodId','imports');
  assert.equal(f.root.querySelectorAll('.hy-material-step').length,2);
  assert.match(f.byId('yg-scene-content').textContent,/交出火器1件.*(?:换取|换入)番货1件/u);
  choose('ownGoodId','curios');choose('otherGoodId','beasts');
  assert.match(f.byId('yg-scene-content').textContent,/交出奇物1件.*(?:换取|换入)异兽1件/u);
  f.click(control('cancel-card'));
  assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  assert.equal(game.players[0].tools[0].exhausted,false);
  assert.equal(f.root.querySelectorAll('.hy-material-step').length,0);
  f.ui.selectHandCard(privateView(game,ids[0]).players[0].tools[0],true);choose('ownGoodId','firearms');choose('otherGoodId','imports');
  choose('ownGoodId','curios');choose('otherGoodId','beasts');
  const confirm=control('confirm-card');confirm.setAttribute('data-hy-fields',decodedFields(confirm));f.click(confirm);
  assert.deepEqual(f.commands,[{type:'activate-tool',fields:{cardId,params:{ownGoodId:'curios',otherGoodId:'beasts'}}}]);
  game=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(game.actionsUsed,before.actionsUsed+1);assert.equal(game.pending,null);
  assert.equal(game.players[0].tools[0].exhausted,true);
  assert.equal(game.players[0].goods.curios,0);assert.equal(game.players[0].goods.beasts,1);
  assert.equal(game.players[1].goods.curios,1);assert.equal(game.players[1].goods.beasts,0);
  assert.equal(game.players[0].goods.firearms,1);assert.equal(game.players[1].goods.imports,1);
});

test('T10 goods and payment stay local until one confirmation; cancel preserves all three equipment cards',t=>{
  const f=fixture(t);let game=fresh();
  const toolId=give(game,'t10'),wellId=give(game,'t02'),bagId=give(game,'t01'),paymentId=give(game,'c07');
  for(const cardId of [toolId,wellId,bagId]){game.players[0].hand=game.players[0].hand.filter(id=>id!==cardId);game.players[0].tools.push({cardId,exhausted:false});}
  game=act(act(game,'peek'),'keep-peek');const before=structuredClone(game),view=privateView(game,ids[0]),tool=view.players[0].tools.find(c=>c.cardId===toolId),payment=view.players[0].hand.find(c=>c.cardId===paymentId);
  const control=action=>f.root.querySelector(`[data-hy-action="${action}"]`),decodedFields=node=>node.dataset.hyFields.replace(/&quot;/gu,'"');
  const chooseGood=id=>{const node=f.root.querySelectorAll('[data-hy-action="native-select"]').find(n=>{const fields=JSON.parse(decodedFields(n));return fields.type==='good'&&fields.id===id;});assert.ok(node);node.setAttribute('data-hy-fields',decodedFields(node));f.click(node);};
  f.ui.applyView(room(game));f.ui.selectHandCard(tool,true);chooseGood('firearms');f.ui.selectHandCard(payment);
  assert.deepEqual(f.commands,[],'selecting payment must not play its character effect or charge activation');
  f.click(control('cancel-card'));assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);assert.equal(game.players[0].tools.length,3);
  f.ui.selectHandCard(tool,true);chooseGood('imports');f.ui.selectHandCard(payment);
  const draft=f.root.querySelector('.hy-action-draft');f.document.defaultView.dispatchEvent(new Event('blur'));
  assert.ok(f.root.querySelector('.hy-action-draft')===draft,'ordinary blur preserves both the tool and its selected good/payment');
  assert.deepEqual(f.commands,[]);
  const confirm=control('confirm-card');confirm.setAttribute('data-hy-fields',decodedFields(confirm));f.click(confirm);
  assert.deepEqual(f.commands,[{type:'activate-tool',fields:{cardId:toolId,params:{goodId:'imports',payment:{zone:'hand',cardId:paymentId}}}}]);
  game=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(game.actionsUsed,before.actionsUsed+1);assert.equal(game.pending,null);assert.equal(game.players[0].goods.imports,before.players[0].goods.imports+1);
  assert.equal(game.players[0].tools.length,3);assert.equal(game.players[0].tools.find(t=>t.cardId===toolId).exhausted,true);
  assert.equal(game.players[0].hand.includes(paymentId),false);assert.ok(game.discard.includes(paymentId));
});

test('M08 borrowed wish well keeps target and grouped materials local until one complete confirmation',t=>{
  const f=fixture(t),players=['a','b','c'].map(letter=>letter.repeat(32));
  let game=createGame(players,{...context,matchId:'f'.repeat(32)});
  game.deck.push(...game.players.flatMap(player=>player.hand));game.players.forEach(player=>{player.hand=[];});
  game.stage='use';game.drawStarted=true;
  const sourceId=give(game,'m08'),toolId=give(game,'t02',1);
  game.players[1].hand=[];game.players[1].tools.push({cardId:toolId,exhausted:false});
  for(const [index,goods] of [[0,['firearms','curios']],[1,['antiques']],[2,['imports','beasts']]])for(const good of goods){game.players[index].goods[good]++;game.bankGoods[good]--;}
  game=act(game,'play-character',{cardId:sourceId,params:{targetId:players[1],toolCardId:toolId}});
  assert.equal(game.pending.choice.kind,'borrow-tool');const before=structuredClone(game);
  f.ui.applyView({...room(game),players:players.map((id,index)=>({id,name:index?`伙伴${index}`:'我',ready:true,connected:true}))});
  const choose=(type,predicate)=>{
    const node=f.root.querySelectorAll(`[data-hy-action="${type}"]`).find(node=>predicate(JSON.parse(node.dataset.hyFields.replace(/&quot;/gu,'"'))));
    assert.ok(node,`${type} choice is available`);node.setAttribute('data-hy-fields',node.dataset.hyFields.replace(/&quot;/gu,'"'));f.click(node);
  };
  choose('native-select',fields=>fields.type==='option'&&game.pending.choice.options[fields.index]?.borrow===true);
  assert.equal(f.byId('hy-task-materials').classList.contains('hy-grouped-selection'),true);
  assert.equal(actionControl(f,'native-confirm').disabled,true);
  choose('native-borrow-target',fields=>fields.targetId===players[2]);
  choose('native-select',fields=>fields.borrowPart===0&&fields.field==='ownGoodId'&&fields.id==='firearms');
  choose('native-select',fields=>fields.borrowPart===0&&fields.field==='otherGoodId'&&fields.id==='imports');
  assert.equal(actionControl(f,'native-confirm').disabled,false);
  choose('native-borrow-target',fields=>fields.targetId===players[1]);
  assert.equal(actionControl(f,'native-confirm').disabled,true,'changing the borrowed target clears incompatible material choices');
  choose('native-borrow-target',fields=>fields.targetId===players[2]);
  choose('native-select',fields=>fields.borrowPart===0&&fields.field==='ownGoodId'&&fields.id==='curios');
  choose('native-select',fields=>fields.borrowPart===0&&fields.field==='otherGoodId'&&fields.id==='beasts');
  f.document.defaultView.dispatchEvent(new Event('blur'));
  assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  assert.equal(actionControl(f,'native-confirm').disabled,false);
  f.click(actionControl(f,'native-confirm'));
  assert.deepEqual(f.commands,[{type:'choose-effect',fields:{selection:{borrow:true,params:{ownGoodId:'curios',otherGoodId:'beasts',targetId:players[2]}}}}]);
  const after=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(after.pending,null);assert.equal(after.actionsUsed,before.actionsUsed);
  assert.equal(after.players[0].goods.curios,0);assert.equal(after.players[0].goods.beasts,1);
  assert.equal(after.players[2].goods.curios,1);assert.equal(after.players[2].goods.beasts,0);
  assert.deepEqual(after.players[1].goods,before.players[1].goods,'the dismantled-tool owner is not the chosen exchange recipient');
});


test('landscape tabletop keeps a portrait rotation gate and returns without a business action',t=>{
  const f=fixture(t),game=fresh();Object.assign(f.document.defaultView,{innerWidth:390,innerHeight:844});
  f.ui.applyView(room(game));
  assert.equal(f.byId('yg-rotation').hidden,false);assert.equal(f.byId('yg-playfield').inert,true);
  assert.equal(f.byId('yg-settings').disabled,false);assert.match(f.byId('yg-room-code').textContent,/123456/);
  Object.assign(f.document.defaultView,{innerWidth:844,innerHeight:390});f.ui.applyView(room(game));
  assert.equal(f.byId('yg-rotation').hidden,true);assert.equal(f.byId('yg-playfield').inert,false);
  assert.deepEqual(f.commands,[]);assert.equal(game.revision,0);
});

test('night market economy feedback only follows a new confirmed same-match action, never initial or repeated snapshots',t=>{
  const f=fixture(t),initial=fresh(),cardId=give(initial,'g01'),active=act(act(initial,'peek'),'keep-peek'),bought=act(active,'buy',{cardId});
  f.ui.applyView(room(active));
  assert.equal(f.animations.filter(a=>a.node.className==='nm-silver-change').length,0);
  f.ui.applyView(room(bought));
  assert.equal(f.animations.filter(a=>a.node.className==='nm-silver-change'&&a.node.textContent.endsWith('两')).length,1);
  f.ui.applyView(room(bought));
  assert.equal(f.animations.filter(a=>a.node.className==='nm-silver-change'&&a.node.textContent.endsWith('两')).length,1);
  const restored=fixture(t);restored.ui.applyView(room(bought));
  assert.equal(restored.animations.filter(a=>a.node.className==='nm-silver-change').length,0);
  assert.equal(f.commands.length,0,'presentation cannot send a business action');
  f.ui.conceal();
  assert.equal(f.root.querySelector('.nm-silver-change'),null,'private conceal removes transient economy effects too');
});

test('hidden night market accepts authority state without replaying economy effects on return',t=>{
  const f=fixture(t),initial=fresh(),cardId=give(initial,'g01'),active=act(act(initial,'peek'),'keep-peek'),bought=act(active,'buy',{cardId});
  f.ui.applyView(room(active));f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));
  const count=f.animations.length;f.ui.applyView(room(bought));
  assert.equal(f.animations.length,count);
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));f.ui.applyView(room(bought));
  assert.equal(f.animations.length,count);
  assert.match(f.byId('yg-silver').textContent,new RegExp(String(bought.players[0].silver)));
  assert.equal(f.commands.length,0);
});

test('game gesture zoom is scoped and released while ordinary wheel browsing and room actions remain untouched',t=>{
  const f=fixture(t);f.ui.applyView(room(fresh()));
  const wheel=ctrlKey=>{const event=new Event('wheel',{cancelable:true});Object.defineProperty(event,'ctrlKey',{value:ctrlKey});return event;};
  const ordinary=wheel(false);f.root.dispatchEvent(ordinary);assert.equal(ordinary.defaultPrevented,false,'ordinary local scrolling is preserved');
  const pinch=wheel(true);f.root.dispatchEvent(pinch);assert.equal(pinch.defaultPrevented,true,'trackpad gesture zoom is blocked on the table');
  for(const type of ['gesturestart','gesturechange']){const gesture=new Event(type,{cancelable:true});f.root.dispatchEvent(gesture);assert.equal(gesture.defaultPrevented,true);}
  const external=wheel(true);f.document.body.dispatchEvent(external);assert.equal(external.defaultPrevented,false,'outside game is unaffected');
  assert.deepEqual(f.commands,[]);f.ui.destroy();
  const after=wheel(true);f.root.dispatchEvent(after);assert.equal(after.defaultPrevented,false,'unmount releases the listener');
});

test('actual room and practice mounts share the background picker without replacing a selected play draft or sending a rule action',t=>{
  for(const practice of [false,true]){
    const f=fixture(t,{practice}),{game}=readyCard(f),before=structuredClone(game);
    const draft=f.root.querySelector('.hy-action-draft'),confirm=actionControl(f,'confirm-card');
    assert.ok(draft);assert.equal(f.root.querySelectorAll('[data-nm-background]').length,3);
    const probes=[];
    f.document.defaultView.Image=class extends EventTarget{constructor(){super();this.complete=false;probes.push(this);}set src(value){this.url=value;}removeAttribute(){this.url=null;}};
    const choices=f.root.querySelector('.nm-background-options'),input=choices.querySelector('[data-nm-background="rain"]');
    input.checked=true;const event=new Event('change');Object.defineProperty(event,'target',{value:input});choices.dispatchEvent(event);
    probes[0].dispatchEvent(new Event('load'));
    assert.equal(f.root.dataset.nightMarketBackground,'rain');
    assert.equal(f.root.querySelector('.hy-action-draft'),draft);assert.equal(actionControl(f,'confirm-card'),confirm);
    assert.ok(f.root.querySelector('.yg-hand-card.is-selected'));
    assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  }
});

for(const count of [2,3,6])for(const code of ['m01','m08'])test(`${code} ${count} seats: select opponent then show objects without preceding target buttons`,t=>{
  const f=fixture(t),players=Array.from({length:count},(_,i)=>String.fromCharCode(97+i).repeat(32));
  let game=createGame(players,{...context,matchId:'f'.repeat(32)});
  game.stage='use';game.drawStarted=true;
  const cardId=give(game,code);
  game.players[1].goods.firearms=1;game.bankGoods.firearms--;
  if(code==='m08'){
    const toolId=give(game,'t05',1);game.players[1].hand=game.players[1].hand.filter(id=>id!==toolId);
    game.players[1].tools.push({cardId:toolId,exhausted:false});
  }
  const view={...room(game),players:players.map((id,i)=>({id,name:i?`伙伴${i}`:'我',ready:true,connected:true}))};
  f.ui.applyView(view);
  const card=view.game.players[0].hand.find(c=>c.cardId===cardId);f.ui.selectHandCard(card);
  const choose=()=>{
    if(count>2){const target=actionControl(f,'draft-value');f.click(target);}
    assert.equal(f.root.querySelectorAll('.hy-material-player').length,0);
    assert.match(f.byId('hy-task-material-title').textContent,new RegExp(`选择伙伴1的1件${code==='m01'?'货物':'装备'}`));
    assert.ok(f.root.querySelector(code==='m01'?'.hy-material-good':'.hy-material-card'));
  };
  choose();
  const object=actionControl(f,'draft-value');f.click(object);
  assert.equal(actionControl(f,'confirm-card').getAttribute('disabled'),null);
  if(count>2){f.click(f.byId('hy-material-rechoose'));assert.equal(actionControl(f,'confirm-card').getAttribute('disabled')!==null,true);assert.equal(f.root.querySelectorAll('.hy-material-player').length,count-1);choose();}
  assert.equal(f.commands.length,0,'selection and changing target never submit an economic action');
});

for(const count of [2,3,6])test(`C08 ${count} seats: effect first, target only for discard, reselect never submits`,t=>{
  const f=fixture(t),players=Array.from({length:count},(_,i)=>String.fromCharCode(97+i).repeat(32));
  const game=createGame(players,{...context,matchId:'f'.repeat(32)});game.stage='use';game.drawStarted=true;
  const cardId=give(game,'c08');game.deck.push(...game.players[0].hand.filter(id=>id!==cardId));game.players[0].hand=[cardId];
  const view={...room(game),players:players.map((id,i)=>({id,name:i?`伙伴${i}`:'我',ready:true,connected:true}))};
  f.ui.applyView(view);f.ui.selectHandCard(view.game.players[0].hand.find(card=>card.cardId===cardId));
  assert.equal(f.root.querySelectorAll('.hy-material-player').length,0,'self draw does not require an irrelevant target');
  const chooseBranch=index=>{const node=f.root.querySelectorAll('.hy-material-branch')[index];node.setAttribute('data-hy-fields',node.dataset.hyFields.replace(/&quot;/gu,'"'));f.click(node);};
  chooseBranch(0);assert.equal(actionControl(f,'confirm-card').getAttribute('disabled'),null);assert.match(f.byId('hy-task-material-title').textContent,/自己补牌/);
  f.click(f.byId('hy-material-rechoose'));chooseBranch(1);
  if(count>2){assert.equal(actionControl(f,'confirm-card').getAttribute('disabled')!==null,true);f.click(actionControl(f,'draft-value'));}
  assert.equal(actionControl(f,'confirm-card').getAttribute('disabled'),null);assert.match(f.byId('hy-task-material-title').textContent,/伙伴1弃牌至3张/);
  assert.match(f.byId('hy-task-material-cards').textContent,/自行选择弃牌/);assert.equal(f.commands.length,0);
});

function c06NativeControl(f,type,id){
  const node=f.byId('hy-task-material-cards').querySelectorAll('[data-hy-action="native-select"]').find(node=>{
    const fields=JSON.parse(node.dataset.hyFields.replace(/&quot;/gu,'"'));
    return fields.type===type&&(id===undefined||node.dataset.materialGood===id);
  });
  assert.ok(node,`C06 ${type} ${id??''}`);node.setAttribute('data-hy-fields',node.dataset.hyFields.replace(/&quot;/gu,'"'));return node;
}
function c06Ready(f){
  const game=createGame(ids,{...context,matchId:'c'.repeat(32),ruleVersion:DIGITAL_RULE_VERSION,goodsPerType:6}),cardId=give(game,'c06');game.stage='use';game.drawStarted=true;
  game.players[0].goods.firearms=2;game.bankGoods.firearms-=2;
  game.players[0].goods.curios=2;game.bankGoods.curios-=2;
  // The opponent legally holds five beasts; one remains in the public supply.
  game.players[1].goods.beasts=5;game.bankGoods.beasts-=5;
  const view=room(game),card=view.game.players[0].hand.find(card=>card.cardId===cardId);
  f.ui.applyView(view);f.ui.selectHandCard(card);return {game,cardId,card};
}
test('C06 actual mount uses two steps, keeps a readable blocked target and cancels without a command',t=>{
  const f=fixture(t),{game,card}=c06Ready(f),before=structuredClone(game);
  assert.equal(f.byId('hy-task-materials').classList.contains('hy-exchange-selection'),true);
  assert.equal(f.byId('hy-task-material-cards').querySelectorAll('.hy-material-good').length,2);
  assert.match(f.byId('hy-task-material-title').textContent,/先选交出/u);
  assert.notEqual(actionControl(f,'confirm-card').getAttribute('disabled'),null);
  f.click(c06NativeControl(f,'exchange-source','firearms'));
  assert.match(f.byId('hy-task-material-title').textContent,/再选换入/u);
  assert.equal(f.byId('hy-task-material-cards').querySelectorAll('.hy-material-good').length,6);
  const blocked=c06NativeControl(f,'option','beasts');assert.notEqual(blocked.getAttribute('disabled'),null);assert.match(blocked.textContent,/公库1件 · 不足2件/u);
  f.click(blocked);assert.notEqual(actionControl(f,'confirm-card').getAttribute('disabled'),null);
  f.click(c06NativeControl(f,'option','imports'));
  assert.equal(actionControl(f,'confirm-card').getAttribute('disabled'),null);
  assert.match(f.byId('yg-scene-content').textContent,/交回全部火器2件 → 换入番货2件/u);
  f.click(c06NativeControl(f,'exchange-back'));
  assert.notEqual(actionControl(f,'confirm-card').getAttribute('disabled'),null);
  f.click(c06NativeControl(f,'exchange-source','curios'));
  assert.notEqual(actionControl(f,'confirm-card').getAttribute('disabled'),null,'changing source invalidates the old pair');
  f.click(actionControl(f,'cancel-card'));assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  assert.equal(f.byId('hy-task-materials').hidden,true);assert.equal(f.byId('hy-task-materials').classList.contains('hy-exchange-selection'),false);
  f.ui.selectHandCard(card);assert.match(f.byId('hy-task-material-title').textContent,/先选交出/u);
});

test('C06 actual mount preserves selected materials across reading and blur, then submits one complete pair',t=>{
  const f=fixture(t),{game,cardId}=c06Ready(f),before=structuredClone(game);
  f.click(c06NativeControl(f,'exchange-source','firearms'));f.click(c06NativeControl(f,'option','imports'));
  f.click(f.root.querySelector('.hy-source-reader[data-hy-detail]'));
  assert.equal(f.byId('hy-card-reader').open,true);f.click(f.byId('hy-reader-close'));
  f.document.defaultView.dispatchEvent(new Event('blur'));
  assert.equal(actionControl(f,'confirm-card').getAttribute('disabled'),null);
  assert.match(f.byId('yg-scene-content').textContent,/番货0→2件/u);assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  f.click(actionControl(f,'confirm-card'));
  assert.deepEqual(f.commands,[{type:'play-character',fields:{cardId,params:{initialChoices:[{kind:'exchange',selection:{fromGoodsId:'firearms',toGoodsId:'imports'}}]}}}]);
  const after=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(after.pending,null);assert.equal(after.actionsUsed,before.actionsUsed+1);assert.equal(after.players[0].silver,before.players[0].silver);
  assert.equal(after.players[0].goods.firearms,0);assert.equal(after.players[0].goods.imports,2);assert.equal(after.players[0].goods.curios,2);
});

test('C06 restored pending mounts the staged selector and only its final choice is sent',t=>{
  const f=fixture(t),setup=c06Ready(f);f.click(actionControl(f,'cancel-card'));
  const pending=act(setup.game,'play-character',{cardId:setup.cardId});f.ui.applyView(room(JSON.parse(JSON.stringify(pending))));
  assert.equal(f.byId('hy-task-materials').classList.contains('hy-exchange-selection'),true);
  assert.match(f.byId('hy-task-material-title').textContent,/先选交出/u);
  f.click(c06NativeControl(f,'exchange-source','curios'));f.click(c06NativeControl(f,'option','imports'));
  assert.deepEqual(f.commands,[]);f.click(actionControl(f,'native-confirm'));
  assert.deepEqual(f.commands,[{type:'choose-effect',fields:{selection:{fromGoodsId:'curios',toGoodsId:'imports'}}}]);
  const after=act(pending,f.commands[0].type,f.commands[0].fields);
  assert.equal(after.actionsUsed,pending.actionsUsed);assert.equal(after.pending,null);
});


test('peek, public response and primary benefit tasks keep descriptions outside their persistent actions',t=>{
  const f=fixture(t),peek=act(fresh(),'peek');
  let benefit=fresh(),cardId=give(benefit,'c01');benefit=act(act(benefit,'peek'),'keep-peek');benefit=act(benefit,'play-character',{cardId});
  let response=fresh();cardId=give(response,'m01');give(response,'c07',1);response.players[1].goods.firearms=1;response.bankGoods.firearms--;response=act(act(response,'peek'),'keep-peek');response=act(response,'play-character',{cardId,params:{goodsId:'firearms'}});
  for(const game of [peek,benefit,response]){
    f.ui.applyView(room(game,{selfId:game.pending.actorId}));
    const copy=f.root.querySelector('.hy-table-work .hy-work-copy');assert.ok(copy);
    const description=copy.querySelector('.hy-work-description'),actions=copy.querySelector('.hy-work-actions');
    assert.ok(description);assert.ok(description.textContent.trim());assert.equal(description.parentNode,copy);
    if(actions){assert.equal(actions.parentNode,copy);assert.equal(actions.closest('.hy-work-description'),null);}
  }
  assert.equal(f.commands.length,0);
});


test('restored C01 branch choices belong to materials and preserve original selection and commit commands',t=>{
  const f=fixture(t);let game=fresh();const cardId=give(game,'c01');game=act(act(game,'peek'),'keep-peek');game=act(game,'play-character',{cardId});
  assert.equal(game.pending.choice.kind,'benefit-branch');const used=game.actionsUsed;
  f.ui.applyView(room(game));
  assert.equal(f.byId('hy-task-materials').hidden,false);
  assert.equal(f.byId('hy-task-materials').classList.contains('hy-benefit-selection'),true);
  assert.equal(f.byId('hy-task-materials').classList.contains('hy-object-expanded'),true);
  assert.equal(f.root.querySelector('.hy-work-description').querySelector('[data-hy-action="inline-option"]'),null);
  const branch=index=>f.byId('hy-task-material-cards').querySelectorAll('[data-hy-action="inline-option"]').find(node=>JSON.parse(node.dataset.hyFields.replace(/&quot;/gu,'"')).index===index);
  assert.ok(branch(0));assert.ok(branch(1));
  for(const index of [0,1]){const control=branch(index);control.setAttribute('data-hy-fields',control.dataset.hyFields.replace(/&quot;/gu,'"'));f.click(control);assert.equal(branch(index).getAttribute('aria-pressed'),'true');assert.equal(f.commands.length,0);}
  f.click(actionControl(f,'inline-rechoose'));assert.equal(branch(0).getAttribute('aria-pressed'),'false');assert.equal(branch(1).getAttribute('aria-pressed'),'false');
  const selected=branch(1);selected.setAttribute('data-hy-fields',selected.dataset.hyFields.replace(/&quot;/gu,'"'));f.click(selected);f.click(actionControl(f,'inline-confirm'));
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].type,'choose-effect');
  const expected=game.pending.choice.options[1].branch;assert.equal(f.commands[0].fields.selection.branch,expected);
  const next=act(game,f.commands[0].type,f.commands[0].fields);assert.equal(next.actionsUsed,used);
});


test('expansion R15 private candidate stays selected through render and submits exactly that candidate',async t=>{
  const {fixture:configuredFixture,run:configuredAct,ids:configuredIds}=await import('./configured/test-support/fixture.mjs');
  const {privateView:configuredView}=await import('./configured/view.mjs');
  let game=configuredFixture(['R15','R12']);
  game=configuredAct(game,'peek',{inspect:true});
  const selfId=configuredIds[0],projected=configuredView(game,selfId),f=fixture(t);
  const players=game.players.map((p,i)=>({id:p.id,name:i?'伙伴':'我',ready:true}));
  f.ui.applyView({roomId:'room',roomCode:'123456',phase:'playing',selfId,selfRole:'player',hostId:selfId,serverTime:1001,
    players,matchPlayers:players,spectators:[],game:projected,hyakkiConfig:{packId:'six-trades-v1',actionLimit:5,goodsPerType:6,goodsSupplyMode:'recommended',closingTarget:60}});
  const confirm=()=>f.root.querySelector('[data-ex-command="pending-confirm"]');
  assert.equal(confirm().disabled,true);
  const option=f.root.querySelector('[data-ex-command="option"]');assert.ok(option);option.setAttribute('data-ex-fields',option.dataset.exFields.replace(/&quot;/gu,'"'));f.click(option);
  assert.equal(confirm().disabled,false);
  f.document.defaultView.innerWidth=568;f.document.defaultView.innerHeight=320;
  f.document.defaultView.dispatchEvent(new Event('resize'));
  assert.equal(confirm().disabled,false,'rotation and resize preserve the private selected candidate');
  assert.deepEqual(f.commands,[],'resize cannot submit a choice or charge the player');
  const expected=projected.pending.choice.options[0];f.click(confirm());
  assert.deepEqual(f.commands,[{type:'choose-effect',fields:{selection:expected}}]);
});

test('expansion overflow receipt shows named goods and sends the actual retained vector through the real rule',async t=>{
  const {fixture:make,run,move,use,ids}=await import('./configured/test-support/fixture.mjs');
  const {privateView}=await import('./configured/view.mjs');
  let game=use(make(['R10','R12']));
  game.players[0].goods.timber=6;game.bankGoods.timber-=6;
  game=run(game,'play-character',{cardId:move(game,'XC01'),params:{goods:{firearms:2}}});
  assert.equal(game.pending.choice.kind,'retain-goods');
  const f=fixture(t),players=game.players.map((p,i)=>({id:p.id,name:i?'伙伴':'我',ready:true}));
  f.ui.applyView({roomId:'room',roomCode:'123456',phase:'playing',selfId:ids[0],selfRole:'player',hostId:ids[0],serverTime:1001,
    players,matchPlayers:players,spectators:[],game:privateView(game,ids[0]),hyakkiConfig:{packId:'six-trades-v1',actionLimit:5,goodsPerType:6,goodsSupplyMode:'recommended',closingTarget:60}});
  assert.match(f.root.textContent,/选择保留的货物/);assert.doesNotMatch(f.root.textContent,/\[object Object\]/);
  const confirm=f.root.querySelector('[data-ex-command="pending-confirm"]');assert.equal(confirm.disabled,false);
  f.click(confirm);assert.equal(f.commands.length,1);
  const selection=f.commands[0].fields.selection;
  assert.deepEqual(selection,game.pending.choice.defaultSelection);assert.equal(selection.combined,undefined);
  const after=run(game,'choose-effect',{selection});assert.equal(after.pending,null);
  assert.equal(Object.values(after.players[0].goods).reduce((a,b)=>a+b,0),7);
});
