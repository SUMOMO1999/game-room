import test from 'node:test';
import assert from 'node:assert/strict';
import {CARDS,GOODS,ROLES,createExpansionDeck} from './content/expansion-one.mjs';
import {expansionPublicMetadataProblem,encodeExpansionPublicMetadata,decodeExpansionPublicMetadata} from './expansion-public-history.mjs';
import {publicBattleMetadataProblem as legacyMetadataProblem} from './battle-public-metadata.mjs';

const ids=Array.from({length:6},(_,i)=>(i+1).toString(16).repeat(32));
const context=n=>({contentVersion:'yousei-content-v3',participantIds:ids.slice(0,n)});
const turn=n=>({anchor:{kind:'turn',id:`turn-${n}`,number:n,round:Math.ceil(n/6),ownerSeatId:ids[(n-1)%6]},
  source:null,rolesRevealed:[],changes:[],discard:{beforeCount:0,afterCount:0,removed:[],added:[]}});
const size=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
export function capacityFixture(){
  const cards=createExpansionDeck(6),source={kind:'role',roleId:'yousei.role.r23',actorSeatId:ids[0]},metadata=turn(123456);
  const tools=CARDS.filter(c=>c.category==='tool').slice(0,3).map(c=>c.id);
  metadata.source=source;
  metadata.changes=ids.map(seatId=>({seatId,silver:-123456789,goods:GOODS.map(g=>({id:g.id,delta:20})),handCount:360,toolsAdded:tools,toolsRemoved:tools}));
  // Conservative public-delta ceiling: all 360 positions reset, every new
  // position carrying the longest role provenance; not a full gameplay trace.
  metadata.discard={beforeCount:360,afterCount:360,removed:cards.map((c,index)=>({index,definitionId:c.definitionId})),
    added:cards.map((c,index)=>({index,definitionId:c.definitionId,actorSeatId:ids[5],reason:'draw-discarded',source}))};
  return {metadata,context:context(6),faces:cards.map(c=>c.definitionId)};
}
test('公开定义、固定席位和效源可精确往返；无实体、候选或未来牌序',()=>{
  const metadata=turn(1);metadata.source={kind:'role',roleId:'yousei.role.r23',actorSeatId:ids[0]};
  metadata.changes=[{seatId:ids[1],silver:-2,goods:[{id:'timber',delta:-1}],handCount:0,toolsAdded:[],toolsRemoved:[]}];
  metadata.discard={beforeCount:0,afterCount:1,removed:[],added:[{index:0,definitionId:'yousei.c07',actorSeatId:ids[1],reason:'response',source:metadata.source}]};
  const encoded=encodeExpansionPublicMetadata(metadata,context(6));
  assert.deepEqual(encoded.data[0],[1,1,1,0]);
  assert.deepEqual(encoded.data[1],[2,22,0]);
  assert.deepEqual(decodeExpansionPublicMetadata(JSON.parse(JSON.stringify(encoded)),context(6)),metadata);
  assert.equal(JSON.stringify(encoded).includes('#'),false);
  assert.equal(JSON.stringify(encoded).includes('candidates'),false);
  assert.equal(JSON.stringify(encoded).includes('role.r23'),false,'索引只引用冻结公开目录，解码恢复真实角色');
});
test('开局事实独立于普通回合，必须同时公开全体选角且不公开未选身份',()=>{
  for(let n=2;n<=6;n++){
    const metadata={...turn(1),anchor:{kind:'opening'},rolesRevealed:ids.slice(0,n).map((seatId,i)=>({seatId,roleId:ROLES[i].id}))};
    assert.deepEqual(decodeExpansionPublicMetadata(encodeExpansionPublicMetadata(metadata,context(n)),context(n)),metadata);
    assert.match(expansionPublicMetadataProblem({...metadata,rolesRevealed:metadata.rolesRevealed.slice(1)},context(n)),/完整公开/);
    assert.ok(expansionPublicMetadataProblem({...metadata,candidates:ROLES.map(r=>r.id)},context(n)));
    assert.ok(expansionPublicMetadataProblem({...metadata,source:{kind:'card',definitionId:'yousei.g01'}},context(n)));
  }
});
test('360弃牌重排及十二货／六席变化的容量原型不提高旧32KiB上限',t=>{
  const f=capacityFixture(),encoded=encodeExpansionPublicMetadata(f.metadata,f.context);
  assert.deepEqual(decodeExpansionPublicMetadata(encoded,f.context),f.metadata);
  const group={schemaVersion:4,kind:'group',roomId:'a'.repeat(32),matchId:'b'.repeat(32),sequence:123456,commitId:'c'.repeat(128),
    committedAt:1800000000000,mode:'normal',contentVersion:'yousei-content-v3',playerCount:6,
    events:[{type:'cards-revealed',actorSeatId:ids[0],cardIds:f.faces}],metadata:encoded,fingerprint:'d'.repeat(64)};
  assert.ok(size(group)<32768,`proposed group measured ${size(group)} bytes`);
  assert.ok(size(f.metadata)>32768,'原逐项长字段在相同数据下确实超过旧上限');
  assert.ok(size(encoded)<size(f.metadata)/3);
  t.diagnostic(JSON.stringify({metadataBytes:size(f.metadata),encodedMetadataBytes:size(encoded),proposedGroupBytes:size(group),groupLimitBytes:32768,
    scope:'conservative metadata ceiling; not an executed whole-game/event-store trace'}));
  // Neither representation contains the physical IDs that distinguish copies.
  assert.equal(JSON.stringify(group).includes('#01'),false);
});
test('错人数、内容版本、复制角色、未知字段和实体来源明确拒绝',()=>{
  const f=capacityFixture(),metadata=f.metadata;
  assert.ok(expansionPublicMetadataProblem(metadata,context(2)));
  assert.ok(expansionPublicMetadataProblem(metadata,{...f.context,contentVersion:'latest'}));
  assert.ok(expansionPublicMetadataProblem({...metadata,source:{kind:'card',definitionId:'yousei.role.r01'}},f.context));
  assert.ok(expansionPublicMetadataProblem({...metadata,source:{kind:'card',definitionId:'yousei.g01#01'}},f.context));
  assert.ok(expansionPublicMetadataProblem({...metadata,source:{kind:'role',roleId:'yousei.role.r23',actorSeatId:ids[0],hand:[]}},f.context));
  const changed=structuredClone(metadata);changed.discard.added[0].source={kind:'role',roleId:'yousei.role.r25',actorSeatId:ids[0]};
  assert.ok(expansionPublicMetadataProblem(changed,f.context));
});
test('畸形压缩元组、越界字典、重复位置、幽灵副本和错误回合不得解码',()=>{
  const f=capacityFixture(),encoded=encodeExpansionPublicMetadata(f.metadata,f.context);
  for(const mutate of [
    x=>x.data.push([]),x=>x.data[0][2]++,x=>x.data[1][1]=24,
    x=>x.data[4][2][0][1]=102,x=>x.data[4][3][0][2]=6,
    x=>x.data[4][3][0][4]=[2,0,0,0],x=>x.data[4][3][1][0]=0,
    x=>x.data[4][3].forEach(row=>{row[1]=0;}),x=>{x.privateCards=[];},x=>x.format='latest',
  ]){
    const changed=structuredClone(encoded);mutate(changed);assert.throws(()=>decodeExpansionPublicMetadata(changed,f.context),RangeError);
  }
});
test('旧六货／旧事件组的验证器仍拒绝扩展材料，不静默升级旧记录',()=>{
  const metadata=turn(1);
  assert.ok(legacyMetadataProblem(metadata,ids,{contentVersion:'yousei-content-v3',playerCount:6}));
  const old={turn:{id:'turn-1',number:1,round:1,ownerSeatId:ids[0]},sourceCardId:null,
    changes:[{seatId:ids[0],silver:0,goods:[{id:'timber',delta:1}],handCount:0,toolsAdded:[],toolsRemoved:[]}],
    discard:{beforeCount:0,afterCount:0,removed:[],added:[]}};
  assert.ok(legacyMetadataProblem(old,ids,{contentVersion:'yousei-content-v2',playerCount:6}));
  old.changes[0].goods[0].id='firearms';assert.equal(legacyMetadataProblem(old,ids,{contentVersion:'yousei-content-v2',playerCount:6}),null);
});
