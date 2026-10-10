import test from 'node:test';
import assert from 'node:assert/strict';
import { drawingTestDOM } from '../../test-support/drawing-page-dom.mjs';
import { mountHyakkiPage } from './game-ui.mjs';
import { createGame, applyGameAction, currentDecision } from './rules.mjs';
import { privateView } from './view.mjs';
import { DIGITAL_RULE_VERSION } from './content/definitions.mjs';

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
function fixture(t,{onAction}={}){
  const document=drawingTestDOM('<head></head><body><main id="hyakki-digital-root"></main></body>'),root=document.getElementById('hyakki-digital-root');
  const prototype=Object.getPrototypeOf(root),nativeQuery=prototype.querySelectorAll;
  // Extend the small shared lifecycle DOM only for APIs used by the real mount.
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
  const commands=[],ui=mountHyakkiPage({root,onAction:(type,fields)=>{commands.push({type,fields});return onAction?onAction(type,fields):true;}});t.after(()=>ui.destroy());
  function click(node){const event=new Event('click');Object.defineProperty(event,'target',{value:node});root.dispatchEvent(event);}
  return {document,root,ui,commands,click,animations,byId:id=>document.getElementById(id)};
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
  f.ui.conceal();readyCard(f,'c02');waiting.resolve(true);await flush();
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

test('another player committed action never animates the viewer private selected card',t=>{
  const f=fixture(t),initial=fresh(),viewer=ids[1],privateId=give(initial,'c01',1),tradeId=give(initial,'g01');
  const active=act(act(initial,'peek'),'keep-peek');f.ui.applyView(room(active,{selfId:viewer}));
  const card=privateView(active,viewer).players.find(player=>player.id===viewer).hand.find(item=>item.cardId===privateId);f.ui.selectHandCard(card);
  const before=f.animations.length,bought=act(active,'buy',{cardId:tradeId});f.ui.applyView(room(bought,{selfId:viewer}));
  assert.equal(f.animations.length,before,'opponent trade cannot start a second flight with the private face');
  assert.equal(f.root.querySelector('.hy-work-face .yousei-card')?.style.visibility??'','');
  assert.equal(f.byId('yg-discard-art').querySelector('.yousei-card')?.style.visibility??'','');
});

test('a committed card from another local client must match the selected face before it can move',t=>{
  const f=fixture(t),initial=fresh(),selectedId=give(initial,'c01'),tradeId=give(initial,'g01');
  const active=act(act(initial,'peek'),'keep-peek');f.ui.applyView(room(active));
  const card=privateView(active,ids[0]).players[0].hand.find(item=>item.cardId===selectedId);f.ui.selectHandCard(card);
  const before=f.animations.length,bought=act(active,'buy',{cardId:tradeId});f.ui.applyView(room(bought));
  assert.equal(f.animations.length,before,'matching actor alone does not authorize moving a different selected face');
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
  const f=fixture(t);f.document.defaultView.matchMedia=()=>({matches:true});
  let game=fresh();const source=give(game,'m01');give(game,'c07',1);game.players[1].goods.firearms=1;game.bankGoods.firearms--;
  game=act(act(game,'peek'),'keep-peek');game=act(game,'play-character',{cardId:source,params:{goodsId:'firearms'}});
  const view=privateView(game,ids[1]);f.ui.applyView(room(game,{selfId:ids[1]}));f.ui.selectHandCard(view.pending.response.cards[0]);
  assert.equal(f.root.querySelector('[data-hy-action="respond"]').textContent,'确认反制');
  assert.match(f.byId('yg-scene-content').textContent,/回应不花行动和银两/u);
  assert.match(f.byId('yg-scene-content').textContent,/阻止对方拿走火器×1/u);
  assert.match(f.byId('yg-scene-content').textContent,/锦衣卫和梁上君子弃置/u);
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
  assert.equal(f.root.querySelectorAll('.hy-material-group').length,2);
  assert.match(f.byId('yg-scene-content').textContent,/交出火器1件.*(?:换取|换入)番货1件/u);
  choose('ownGoodId','curios');choose('otherGoodId','beasts');
  assert.match(f.byId('yg-scene-content').textContent,/交出奇物1件.*(?:换取|换入)异兽1件/u);
  f.click(control('cancel-card'));
  assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  assert.equal(game.players[0].tools[0].exhausted,false);
  assert.equal(f.root.querySelectorAll('.hy-material-group').length,0);
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
  const confirm=control('confirm-card');confirm.setAttribute('data-hy-fields',decodedFields(confirm));f.click(confirm);
  assert.deepEqual(f.commands,[{type:'activate-tool',fields:{cardId:toolId,params:{goodId:'imports',payment:{zone:'hand',cardId:paymentId}}}}]);
  game=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(game.actionsUsed,before.actionsUsed+1);assert.equal(game.pending,null);assert.equal(game.players[0].goods.imports,before.players[0].goods.imports+1);
  assert.equal(game.players[0].tools.length,3);assert.equal(game.players[0].tools.find(t=>t.cardId===toolId).exhausted,true);
  assert.equal(game.players[0].hand.includes(paymentId),false);assert.ok(game.discard.includes(paymentId));
});
