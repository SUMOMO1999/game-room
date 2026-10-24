import test from 'node:test';
import assert from 'node:assert/strict';
import {ids,fixture,move,stripResponse,run,use} from './test-support/fixture.mjs';
import {applyGameAction,applyTimeout,gameProblem} from './rules.mjs';
import {privateView,spectatorView} from './view.mjs';
import {projectConfiguredPublicMetadata} from './public-metadata.mjs';
import {EXPANSION_CONTENT_VERSION as current,LEGACY_EXPANSION_CONTENT_VERSION as legacy,
  expansionProfile,createExpansionDeck,expansionDefinitionForCopy,cardsForExpansion,getRole,getExpansionCard} from '../content/expansion-one.mjs';
import {materialForConfiguration} from '../opening-configuration.mjs';
import {encodeExpansionPublicMetadata,decodeExpansionPublicMetadata,expansionPublicMetadataProblem} from '../expansion-public-history.mjs';
import {history4EventProblem} from '../public-history-v4.mjs';
import {renderCard,renderCardDetails} from '../digital-card-ui.mjs';
const oldTotals=[180,225,270,315,360];
for(let n=2;n<=6;n++)test(`${n}人内容版隔离：新六货大单恰加3张，旧局实体及副本上限保持`,()=>{
  const old=createExpansionDeck(n,legacy),fresh=createExpansionDeck(n,current);
  assert.equal(old.length,oldTotals[n-2]);assert.equal(fresh.length,oldTotals[n-2]+3);
  assert.deepEqual(fresh.filter(c=>!c.id.startsWith('yousei.xg21#')),old);
  assert.deepEqual(fresh.filter(c=>c.definitionId==='yousei.xg21').map(c=>c.id),['yousei.xg21#01','yousei.xg21#02','yousei.xg21#03']);
  assert.equal(cardsForExpansion(legacy).length,102);assert.ok(Object.isFrozen(cardsForExpansion(legacy)));assert.equal(cardsForExpansion(current).length,103);
  assert.equal(expansionDefinitionForCopy('yousei.xg21#01',n,legacy),null);
  assert.equal(expansionDefinitionForCopy('yousei.xg21#03',n,current),'yousei.xg21');
  assert.equal(expansionDefinitionForCopy('yousei.xg21#04',n,current),null);
  assert.equal(expansionProfile(n,legacy).copiesByCode.XG21,undefined);
});
test('冻结旧配置仍合法；不把旧存档静默升级或允许混入新实体',()=>{
  for(const version of [legacy,current]){
    const g=fixture(['R15','R12'],{closingTarget:100},{contentVersion:version});
    assert.equal(materialForConfiguration(g.configuration).contentVersion,version);
    assert.equal(gameProblem(JSON.parse(JSON.stringify(g))),null);
    assert.equal(g.players[1].silver,version===legacy?26:32);
    const bad=structuredClone(g);bad.configuration.contentVersion='latest';assert.ok(gameProblem(bad));
    if(version===legacy){const mixed=structuredClone(g);mixed.deck[0]='yousei.xg21#01';assert.ok(gameProblem(mixed));}
  }
});
test('票号东家30～200各目标冻结实际初始值；普通玩家20、旧版始终26',()=>{
  for(let closingTarget=30;closingTarget<=200;closingTarget+=10){
    const expected=20+Math.round((closingTarget-20)*.15),g=fixture(['R12','R01'],{closingTarget});
    assert.equal(g.players[0].silver,expected);assert.equal(g.players[1].silver,20);
    const role=getRole('yousei.role.r12',g.configuration);assert.equal(role.initialSilver,expected);
    assert.equal(role.compactText,`开局${expected}两`);assert.match(role.summary,new RegExp(`${closingTarget}两收市`));
    const print=renderCard(role,{configuration:g.configuration});assert.match(print,new RegExp(`${expected}两开局`));
    const details=renderCardDetails(role,{configuration:g.configuration});assert.match(details,new RegExp(`开局银两为${expected}两`));
    const old=fixture(['R12','R01'],{closingTarget},{contentVersion:legacy});assert.equal(old.players[0].silver,26);
    assert.equal(getRole('yousei.role.r12',old.configuration).compactText,'开局26两');
  }
});
test('新鉴牌师三选一，两张公开弃牌有角色来源；所选仍私有，保存后留牌只结算一次',()=>{
  let g=fixture(['R15','R12']);const hand=g.players[0].hand.length,[first,second,third,fourth]=g.deck;
  g=run(g,'peek',{inspect:true});assert.deepEqual(g.pending.poolCards,[first,second,third]);assert.equal(g.players[0].silver,19);assert.equal(g.actionsUsed,1);
  for(const v of [privateView(g,ids[1]),spectatorView(g)]){
    const text=JSON.stringify(v);for(const id of [first,second,third])assert.equal(text.includes(id),false);
    assert.equal(v.pending.choice.options,undefined);
  }
  const before=JSON.parse(JSON.stringify(g));g=run(before,'choose-effect',{selection:{cardId:second}});
  assert.deepEqual(g.discard,[first,third]);assert.equal(g.deck[0],fourth);assert.deepEqual(g.pending.poolCards,[second]);
  assert.equal(g.players[0].silver,19);assert.equal(g.actionsUsed,1);
  const metadata=projectConfiguredPublicMetadata(before,g),context={contentVersion:current,participantIds:ids.slice(0,2)};
  assert.deepEqual(metadata.source,{kind:'role',roleId:'yousei.role.r15',actorSeatId:ids[0]});
  assert.equal(metadata.discard.added.length,2);assert.ok(metadata.discard.added.every(c=>c.actorSeatId===ids[0]&&c.reason==='draw-discarded'&&c.source.roleId==='yousei.role.r15'));
  assert.deepEqual(decodeExpansionPublicMetadata(encodeExpansionPublicMetadata(metadata,context),context),metadata);
  for(const e of g.lastPublicEvents)assert.equal(history4EventProblem(e,context),null);
  assert.equal(JSON.stringify(metadata).includes(second),false);
  g=run(JSON.parse(JSON.stringify(g)),'keep-peek');assert.equal(g.players[0].hand.length,hand+1);assert.ok(g.players[0].hand.includes(second));assert.equal(g.pending,null);
  assert.equal(g.players[0].silver,19);assert.equal(g.actionsUsed,1);
  const snapshot=structuredClone(g),again=applyGameAction(g,ids[0],{type:'keep-peek',matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});
  assert.equal(again.ok,false);assert.deepEqual(g,snapshot);
});
test('三选一后仍可弃所选继续正常摸；每回合首次鉴牌机会不重开',()=>{
  let g=run(fixture(['R15','R12']),'peek',{inspect:true});const chosen=g.pending.poolCards[1];
  g=run(g,'choose-effect',{selection:{cardId:chosen}});g=run(g,'discard-peek');assert.equal(g.discard.length,3);assert.equal(g.stage,'draw');
  const bad=applyGameAction(g,ids[0],{type:'peek',inspect:true,matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});assert.equal(bad.ok,false);
  g=run(run(g,'peek'),'keep-peek');assert.equal(g.actionsUsed,2);assert.equal(g.players[0].silver,19);
});
test('只有两张可抽的新局不能付费鉴牌；普通摸牌仍可用，旧局可二选一',()=>{
  for(const version of [legacy,current]){
    let g=fixture(['R15','R12'],{},{contentVersion:version});const pair=g.deck.splice(0,2);
    g.players[0].hand.push(...g.deck,...g.players[1].hand);g.deck=pair;g.players[1].hand=[];assert.equal(gameProblem(g),null);
    const before=structuredClone(g),r=applyGameAction(g,ids[0],{type:'peek',inspect:true,matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});
    assert.equal(r.ok,version===legacy);
    if(version===current){assert.deepEqual(g,before);g=run(run(g,'peek'),'keep-peek');assert.equal(g.players[0].silver,20);}
  }
});
test('新鉴牌三选一超时与选后超时都不重抽、不二次扣费，未选仍弃',()=>{
  for(const afterSelect of [false,true]){
    let g=run(fixture(['R15','R12']),'peek',{inspect:true});const [first,second,third]=g.pending.poolCards;
    if(afterSelect)g=run(g,'choose-effect',{selection:{cardId:first}});
    const r=applyTimeout(JSON.parse(JSON.stringify(g)),ids[0],{now:g.timing.active.deadlineAt,randomInt:()=>{throw Error('must not redraw');}});
    assert.equal(r.ok,true,r.error);assert.equal(gameProblem(r.state),null);assert.equal(r.state.turnPlayerId,ids[1]);
    assert.equal(r.state.players[0].silver,19);assert.ok(r.state.players[0].hand.includes(first));assert.deepEqual(r.state.discard,[second,third]);
  }
});
test('新六货大单原样买卖、仓栈六普通格不另付临时费，原G19保持老六货',()=>{
  let g=fixture(['R10','R12']);stripResponse(g);const buy=move(g,'XG21'),sell=move(g,'XG21');g=use(g);
  g=run(g,'buy',{cardId:buy});assert.equal(g.players[0].silver,10);assert.equal(g.players[0].temporaryOccupied,false);
  assert.deepEqual(g.players[0].goods,{firearms:0,imports:0,curios:0,beasts:0,antiques:0,'salt-iron':0,mechanism:1,silk:1,pearl:1,herb:1,painting:1,timber:1});
  const context={contentVersion:current,participantIds:ids.slice(0,2)};
  assert.equal(history4EventProblem(g.lastPublicEvents[0],context),null);
  g=run(g,'sell',{cardId:sell});assert.equal(g.players[0].silver,28);assert.ok(Object.values(g.players[0].goods).every(n=>n===0));
  assert.equal(getExpansionCard('yousei.g19').goods.firearms,1);assert.equal(getExpansionCard('yousei.g19').goods.mechanism,undefined);
  const print=renderCard('yousei.xg21');assert.equal((print.match(/<image /g)||[]).length,6);assert.equal((print.match(/×1/g)||[]).length,6);assert.match(print,/>10<\/text>/);assert.match(print,/>18<\/text>/);
});
test('普通五格买六件仍须付临时费；支付不起整笔拒绝',()=>{
  let g=fixture(['R09','R12']);stripResponse(g);const card=move(g,'XG21');g=use(g);g.players[0].silver=11;
  const before=structuredClone(g),r=applyGameAction(g,ids[0],{type:'buy',cardId:card,matchId:g.matchId,turnId:g.turnId},{now:g.committedAt+1,randomInt:m=>m-1});assert.equal(r.ok,false);assert.deepEqual(g,before);
  g.players[0].silver=12;g=run(g,'buy',{cardId:card});assert.equal(g.players[0].silver,0);assert.equal(g.players[0].temporaryOccupied,true);
});
test('公开压缩目录只在新版接受XG21索引；旧版逐字节往返并拒绝新脸和幽灵副本',()=>{
  const metadata={anchor:{kind:'turn',id:'turn-1',number:1,round:1,ownerSeatId:ids[0]},source:{kind:'card',definitionId:'yousei.xg21'},rolesRevealed:[],changes:[],
    discard:{beforeCount:0,afterCount:1,removed:[],added:[{index:0,definitionId:'yousei.xg21',actorSeatId:ids[0],reason:'used',source:{kind:'card',definitionId:'yousei.xg21'}}]}};
  const context={contentVersion:current,participantIds:ids.slice(0,2)},encoded=encodeExpansionPublicMetadata(metadata,context);
  assert.deepEqual(decodeExpansionPublicMetadata(encoded,context),metadata);
  assert.throws(()=>decodeExpansionPublicMetadata(encoded,{...context,contentVersion:legacy}),RangeError);
  assert.ok(expansionPublicMetadataProblem(metadata,{...context,contentVersion:legacy}));
  const excess=structuredClone(metadata);excess.discard.afterCount=4;excess.discard.added=Array.from({length:4},(_,index)=>({...metadata.discard.added[0],index}));assert.ok(expansionPublicMetadataProblem(excess,context));
  const old=structuredClone(metadata);old.source.definitionId='yousei.g01';old.discard.added[0].definitionId='yousei.g01';old.discard.added[0].source.definitionId='yousei.g01';
  const oldContext={...context,contentVersion:legacy},packet=encodeExpansionPublicMetadata(old,oldContext);
  assert.deepEqual(encodeExpansionPublicMetadata(decodeExpansionPublicMetadata(packet,oldContext),oldContext),packet);
  assert.deepEqual(encodeExpansionPublicMetadata(old,context),packet,'既有牌面位置不能漂移');
});
