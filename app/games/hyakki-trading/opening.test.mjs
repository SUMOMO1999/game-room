import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createOpening,openingProblem,applyOpeningAction,expireOpening,setOpeningManualPause,openingView} from './opening.mjs';
import {waitingConfiguration} from './opening-configuration.mjs';
import {expansionPartitionProblem} from './content/expansion-one.mjs';

const ids=Array.from({length:6},(_,i)=>(i+1).toString(16).repeat(32));
const matchId='f'.repeat(32),initialNow=1000;
const ctx=now=>({now,randomInt:limit=>limit-1});
const fresh=n=>createOpening(ids.slice(0,n),{openingId:matchId,hostId:ids[0],...ctx(initialNow),
  configuration:waitingConfiguration({},{playerCount:n,newRoom:true})});
const confirm=(state,id,role=state.candidates[id][0])=>({type:'confirm-role',openingId:state.openingId,
  candidateId:openingView(state,id).self.candidateId,roleId:role});
function accepted(result){assert.equal(result.ok,true,result.error);assert.equal(openingProblem(result.state),null);return result.state;}

for(const n of [2,3,4,5,6])test(`${n}席分别私选，一次公开后才产生本人数的实际发牌`,()=>{
  let state=fresh(n);const baseline=JSON.stringify(state);
  assert.equal(state.deal,null);assert.equal(state.clock.deadlineAt,61_000);
  const candidates=Object.values(state.candidates).flat();assert.equal(candidates.length,3*n);assert.equal(new Set(candidates).size,3*n);
  for(let i=0;i<n;i++){
    const id=ids[i],action=confirm(state,id);
    state=accepted(applyOpeningAction(state,id,action,ctx(initialNow+i+1)));
    if(i<n-1){assert.equal(state.status,'selecting');assert.equal(state.deal,null);assert.ok(!openingView(state).roles);}
  }
  assert.equal(state.status,'completed');assert.equal(state.deal.players.length,n);
  const all=[...state.deal.deck,...state.deal.players.flatMap(p=>p.hand)];
  assert.equal(all.length,180+45*(n-2));assert.equal(expansionPartitionProblem(all,n),null);
  assert.equal(openingView(state).roles.length,n);assert.ok(!openingView(state,ids[0]).self);
  assert.equal(state.deal.unusedRoles.length,24-n);
  assert.equal(fresh(n).deal,null);assert.notEqual(JSON.stringify(state),baseline);
});
test('每人只看自己的候选，旁观者和公共投影不泄露未选角色或牌序',()=>{
  const state=fresh(6),publicText=JSON.stringify(openingView(state));
  for(const candidate of Object.values(state.candidates).flat())assert.equal(publicText.includes(candidate),false);
  assert.ok(!('deck' in openingView(state)));assert.ok(!('deal' in openingView(state)));
  const mine=JSON.stringify(openingView(state,ids[0]));
  for(const candidate of state.candidates[ids[1]])assert.equal(mine.includes(candidate),false);
  const before=JSON.stringify(state);const mineView=openingView(state,ids[0]);mineView.self.candidates[0]='tampered';
  assert.equal(JSON.stringify(state),before);
});
test('选角严格校验本人候选、开局代际、越权及白名单，失败不抽随机',()=>{
  const state=fresh(2),before=JSON.stringify(state);let calls=0;const context={now:1001,randomInt:()=>{calls++;return 0;}};
  const cases=[
    [ids[2],confirm(state,ids[0]),'WRONG_ACTOR'],
    [ids[0],{...confirm(state,ids[0]),openingId:'e'.repeat(32)},'STALE_OPENING'],
    [ids[0],{...confirm(state,ids[0]),candidateId:openingView(state,ids[1]).self.candidateId},'STALE_CANDIDATE'],
    [ids[0],confirm(state,ids[0],state.candidates[ids[1]][0]),'INVALID_ROLE'],
    [ids[0],{...confirm(state,ids[0]),silver:999},'STALE_CANDIDATE'],
  ];
  for(const [id,action,code] of cases){const result=applyOpeningAction(state,id,action,context);assert.equal(result.ok,false);assert.equal(result.code,code);}
  assert.equal(calls,0);assert.equal(JSON.stringify(state),before);
});
test('一席重复确认幂等，别席确认不改变本人的候选代际，确认后不能换',()=>{
  let state=fresh(3);const a=confirm(state,ids[0]),b=confirm(state,ids[1]);
  state=accepted(applyOpeningAction(state,ids[0],a,ctx(1001)));
  const repeat=applyOpeningAction(state,ids[0],a,ctx(1002));assert.equal(repeat.ok,true);assert.equal(repeat.changed,false);assert.equal(repeat.state,state);
  assert.equal(applyOpeningAction(state,ids[0],{...a,roleId:state.candidates[ids[0]][1]},ctx(1002)).code,'ROLE_LOCKED');
  state=accepted(applyOpeningAction(state,ids[1],b,ctx(1003)));assert.equal(state.choices[ids[1]],b.roleId);
});
test('到期使用原候选首张，不重抽；截止前与截止后的最后确认有明确边界',()=>{
  let state=fresh(2);const a=confirm(state,ids[0],state.candidates[ids[0]][2]);state=accepted(applyOpeningAction(state,ids[0],a,ctx(1001)));
  assert.equal(expireOpening(state,ctx(60_999)).changed,false);
  assert.equal(applyOpeningAction(state,ids[1],confirm(state,ids[1]),ctx(61_000)).code,'OPENING_EXPIRED');
  const result=expireOpening(state,ctx(61_000));const finished=accepted(result);
  assert.equal(finished.choices[ids[0]],a.roleId);assert.equal(finished.choices[ids[1]],state.candidates[ids[1]][0]);
  const again=expireOpening(finished,ctx(61_001));assert.equal(again.changed,false);assert.equal(again.state,finished);
  assert.equal(applyOpeningAction(finished,ids[1],confirm(state,ids[1]),ctx(61_001)).code,'OPENING_CLOSED');
});
test('26两初始角色只发一次，不能重新确认领钱或重新洗牌',()=>{
  let state=fresh(4);
  for(const id of ids.slice(0,4))state=accepted(applyOpeningAction(state,id,confirm(state,id,state.candidates[id].find(r=>r.endsWith('r12'))??state.candidates[id][0]),ctx(1001+ids.indexOf(id))));
  assert.equal(state.deal.players.find(p=>p.roleId.endsWith('r12')).silver,26);
  assert.equal(state.deal.players.filter(p=>!p.roleId.endsWith('r12')).every(p=>p.silver===20),true);
  const before=JSON.stringify(state);
  assert.equal(applyOpeningAction(state,ids[0],{type:'cancel-opening',openingId:matchId},ctx(1009)).code,'OPENING_CLOSED');
  assert.equal(JSON.stringify(state),before);
});
test('取消、明确离席和最后确认竞争只服从已接受状态，不制造发牌或胜负',()=>{
  let state=fresh(2);const originalAction=confirm(state,ids[1]);state=accepted(applyOpeningAction(state,ids[0],confirm(state,ids[0]),ctx(1001)));
  assert.equal(applyOpeningAction(state,ids[1],{type:'cancel-opening',openingId:matchId},ctx(1002)).code,'WRONG_ACTOR');
  const cancelled=accepted(applyOpeningAction(state,ids[0],{type:'cancel-opening',openingId:matchId},ctx(1002)));
  assert.equal(cancelled.deal,null);assert.ok(!('result' in cancelled));assert.equal(cancelled.cancellationReason,'host-cancelled');
  assert.equal(applyOpeningAction(cancelled,ids[1],originalAction,ctx(1003)).code,'OPENING_CLOSED');
  const completed=accepted(applyOpeningAction(state,ids[1],originalAction,ctx(1002)));
  assert.equal(applyOpeningAction(completed,ids[0],{type:'leave-opening',openingId:matchId},ctx(1003)).code,'OPENING_CLOSED');
  const left=accepted(applyOpeningAction(state,ids[1],{type:'leave-opening',openingId:matchId},ctx(1002)));
  assert.equal(left.deal,null);assert.equal(left.cancellationReason,'player-left');
});
test('手动暂停保存剩余时间，断线不重置时限，暂停中仍能明确离席',()=>{
  const state=fresh(2);let paused=accepted(setOpeningManualPause(state,true,{now:11_000}));
  assert.deepEqual(paused.clock,{paused:true,remainingMs:50_000,deadlineAt:null});
  assert.equal(expireOpening(paused,ctx(200_000)).changed,false);
  assert.equal(applyOpeningAction(paused,ids[0],confirm(paused,ids[0]),ctx(200_000)).code,'OPENING_PAUSED');
  const resumed=accepted(setOpeningManualPause(paused,false,{now:200_000}));assert.equal(resumed.clock.deadlineAt,250_000);
  assert.deepEqual(resumed.candidates,state.candidates);
  assert.equal(openingView(resumed,null,{now:210_000}).clock.remainingMs,40_000);
  assert.equal(setOpeningManualPause(resumed,true,{now:250_000}).code,'OPENING_EXPIRED');
  const left=accepted(applyOpeningAction(paused,ids[1],{type:'leave-opening',openingId:matchId},ctx(200_000)));
  assert.equal(left.status,'cancelled');assert.equal(left.deal,null);
});
test('篡改角色池、候选、冻结人数和初始牌实体被恢复校验拒绝',()=>{
  const initial=fresh(2);
  for(const mutate of [
    s=>{s.candidates[ids[0]][0]=s.candidates[ids[1]][0];},
    s=>{s.choices[ids[0]]=s.candidates[ids[1]][0];},
    s=>{s.configuration.playerCount=6;},
    s=>{s.clock.deadlineAt=null;},
    s=>{s.extra=true;},
  ]){const bad=structuredClone(initial);mutate(bad);assert.notEqual(openingProblem(bad),null);}
  const completed=accepted(expireOpening(initial,ctx(61_000)));const bad=structuredClone(completed);
  bad.deal.deck[0]=bad.deal.players[0].hand[0];assert.notEqual(openingProblem(bad),null);
});
test('独立文件与全新进程恢复部分确认后到期，候选不变且守恒',async()=>{
  let state=fresh(6);state=accepted(applyOpeningAction(state,ids[0],confirm(state,ids[0]),ctx(1001)));
  const dir=await mkdtemp(join(tmpdir(),'merchant-opening-')),file=join(dir,'opening.json');
  const moduleUrl=new URL('./opening.mjs',import.meta.url).href;
  try{
    await writeFile(file,JSON.stringify(state));
    const script=`import{readFileSync}from'node:fs';import{openingProblem,expireOpening}from${JSON.stringify(moduleUrl)};const s=JSON.parse(readFileSync(process.argv[1],'utf8'));if(openingProblem(s))throw Error('restore rejected');const r=expireOpening(s,{now:61000,randomInt:n=>n-1});if(!r.ok||openingProblem(r.state))throw Error('completion failed');process.stdout.write(JSON.stringify(r.state));`;
    const restored=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,file],{encoding:'utf8',maxBuffer:1_000_000}));
    assert.deepEqual(restored.candidates,state.candidates);assert.equal(restored.choices[ids[0]],state.choices[ids[0]]);assert.equal(restored.status,'completed');
    assert.equal(restored.deal.deck.length,330);assert.equal(new Set([...restored.deal.deck,...restored.deal.players.flatMap(p=>p.hand)]).size,360);
  }finally{await unlink(file);await rmdir(dir);}
});
