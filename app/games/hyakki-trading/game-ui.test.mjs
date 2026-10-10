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
function fixture(t){
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
  const commands=[],ui=mountHyakkiPage({root,onAction:(type,fields)=>{commands.push({type,fields});return true;}});t.after(()=>ui.destroy());
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
  game.players[1].goods.imports=1;game.bankGoods.imports--;
  game=act(act(game,'peek'),'keep-peek');const before=structuredClone(game);
  f.ui.applyView(room(game));f.ui.selectHandCard(privateView(game,ids[0]).players[0].tools[0],true);
  const control=action=>f.root.querySelector(`[data-hy-action="${action}"]`);
  const decodedFields=node=>node.dataset.hyFields.replace(/&quot;/gu,'"');
  const choose=(field,id)=>{const node=f.root.querySelectorAll('[data-hy-action="draft-value"]').find(node=>{const value=JSON.parse(decodedFields(node));return value.field===field&&value.id===id;});node.setAttribute('data-hy-fields',decodedFields(node));f.click(node);};
  f.click(control('prepare-exchange'));choose('ownGoodId','firearms');choose('otherGoodId','imports');
  assert.equal(f.root.querySelectorAll('.hy-material-group').length,2);
  assert.match(f.byId('yg-scene-content').textContent,/交出火器1件.*(?:换取|换入)番货1件/u);
  f.click(control('cancel-exchange'));
  assert.deepEqual(f.commands,[]);assert.deepEqual(game,before);
  assert.equal(game.players[0].tools[0].exhausted,false);
  assert.equal(f.root.querySelectorAll('.hy-material-group').length,0);
  f.click(control('prepare-exchange'));choose('ownGoodId','firearms');choose('otherGoodId','imports');
  const confirm=control('confirm-card');confirm.setAttribute('data-hy-fields',decodedFields(confirm));f.click(confirm);
  assert.deepEqual(f.commands,[{type:'activate-tool',fields:{cardId,params:{ownGoodId:'firearms',otherGoodId:'imports'}}}]);
  game=act(game,f.commands[0].type,f.commands[0].fields);
  assert.equal(game.actionsUsed,before.actionsUsed+1);assert.equal(game.pending,null);
  assert.equal(game.players[0].tools[0].exhausted,true);
  assert.equal(game.players[0].goods.firearms,0);assert.equal(game.players[0].goods.imports,1);
  assert.equal(game.players[1].goods.firearms,1);assert.equal(game.players[1].goods.imports,0);
});
