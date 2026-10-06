import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_CELLS, ROAD_EDGES, RAIL_EDGES } from './army-board.mjs';
import { armyAssignmentText, armySideLabel, armyPoint, armyCellLabel, armyTargets, armyIntent, armyTransition, armyResultText, armyLastActionText, armyUsesFlagTransport, armyBaseSide, armyFlagMarks, armyPickups, armyRulePages, armyRuleModeLabel } from './army-presentation.mjs';
const game={status:'playing',turnPlayerId:'me',players:[{id:'me',side:'red'},{id:'friend',side:'black'}],board:[{cellId:'r0c0',piece:{hidden:false,side:'red',label:'工兵'}},{cellId:'r0c1',piece:{hidden:true}},{cellId:'r1c0',piece:null},{cellId:'r0c2',piece:{hidden:false,side:'black',label:'司令'}}],legalMoves:[{from:'r0c0',to:'r1c0'}],legalFlips:['r0c1']};
const view={selfId:'me',roomId:'room',matchId:'match',phase:'playing',revision:1,game:{...game,revision:1}};
test('logical board is transposed once into a complete landscape grid with engine topology unchanged',()=>{
  const points=BOARD_CELLS.map(armyPoint);assert.equal(new Set(points.map(p=>p.x)).size,12);assert.equal(new Set(points.map(p=>p.y)).size,5);
  assert.ok(points.every(p=>p.x>0&&p.x<1200&&p.y>0&&p.y<500));
  assert.equal(ROAD_EDGES.length,133);assert.equal(RAIL_EDGES.length,35);
});
test('each supported assignment has explicit distinct current-engine semantics',()=>{
  assert.match(armyAssignmentText('two-flips'),/自己连续两次翻到同色/);assert.match(armyAssignmentText('first-flip'),/首枚/);assert.notEqual(armyAssignmentText('two-flips'),armyAssignmentText('first-flip'));
});
test('accessible piece cells disclose only visible public identity and terrain meaning',()=>{
  const camp=BOARD_CELLS.find(c=>c.terrain==='camp');assert.match(armyCellLabel(camp,{hidden:true}),/营内免受攻击.*未翻暗子/);assert.equal(armyCellLabel(camp,{hidden:true}).includes('红方'),false);
  assert.match(armyCellLabel(BOARD_CELLS[0],{hidden:false,side:'red',label:'工兵'},{selected:true,target:true}),/红方 工兵.*已选中.*合法目标/);
  assert.notEqual(armySideLabel('red'),armySideLabel('black'));
});
test('selection, cancellation and exact legal move never infer additional destinations or hidden contents',()=>{
  assert.deepEqual([...armyTargets(game,'r0c0')],['r1c0']);assert.equal(armyIntent(view,null,'r0c0').type,'select');assert.equal(armyIntent(view,'r0c0','r0c0').type,'cancel');
  assert.deepEqual(armyIntent(view,'r0c0','r1c0'),{type:'move',from:'r0c0',to:'r1c0',selected:null});assert.equal(armyIntent(view,null,'r0c1').type,'flip');assert.equal(armyIntent(view,'r0c0','r0c2').type,'none');
  for(const denied of [{...view,phase:'paused'},{...view,game:{...game,turnPlayerId:'friend'}},{...view,game:{...game,status:'finished'}}])assert.equal(armyIntent(denied,null,'r0c0').type,'none');assert.equal(armyIntent(view,null,'r0c1',{active:false}).type,'none');
});
test('same-game metadata, reconnects and new matches do not replay cues; genuine turn and result changes do',()=>{
  const metadata={...view,revision:2};assert.deepEqual(armyTransition(view,metadata),{cue:null,changed:false});
  const next={...view,revision:2,game:{...game,revision:2,lastAction:{type:'flip'},turnPlayerId:'friend'}};assert.equal(armyTransition(view,next).cue,'draw');assert.equal(armyTransition(view,next,{baseline:true}).cue,null);
  assert.equal(armyTransition(view,{...next,matchId:'new'}).cue,null);
  const toMe={...next,revision:3,game:{...next.game,revision:3,turnPlayerId:'me'}};assert.equal(armyTransition(next,toMe).cue,'turn');
  assert.equal(armyTransition(view,{...next,phase:'finished',game:{...next.game,result:{tie:true}}}).cue,'draw-result');
});
test('army result text distinguishes agreed draws, resignation, flag and lack of actions',()=>{
  assert.match(armyResultText({reason:'draw-agreed',winnerIds:[],tie:true}),/双方同意和棋/);assert.match(armyResultText({reason:'resigned',winnerIds:['me'],tie:false}),/认输/);assert.match(armyResultText({reason:'flag-captured',winnerIds:['me'],tie:false}),/军旗/);assert.match(armyResultText({reason:'blocked',winnerIds:['me'],tie:false}),/无行动/);
  assert.match(armyResultText({aborted:true}),/不计输赢/);
});

test('public last-action feedback describes visible collision outcomes without recovering dark identities',()=>{
  assert.match(armyLastActionText({players:[{id:'friend',name:'伙伴'}],game:{lastAction:{type:'flip',playerId:'friend',side:'red',kind:'engineer'}}}),/伙伴翻开红方工兵/);
  assert.match(armyLastActionText({game:{lastAction:{type:'move',outcome:'mutual'}}}),/同归/);assert.equal(armyLastActionText({game:{lastAction:{type:'offer-draw'}}}), '');
  assert.match(armyResultText({reason:'assignment-exhausted',winnerIds:[],tie:true}),/全部暗子已翻开.*仍未分阵营/);
});

function transportGame() {
  return {...structuredClone(game),version:2,ruleVersion:'army-flip-v2',flagTokens:[{side:'black',carrierId:'engineer-public',cellId:null},{side:'red',carrierId:null,cellId:'r1c0'}],legalPickups:[],
    board:game.board.map(item=>item.cellId==='r0c0'?{...item,piece:{...item.piece,id:'engineer-public'}}:structuredClone(item))};
}
test('v2 marks the four fixed side bases and exposes only public ground flags or visible carriers',()=>{
  const next=transportGame(),before=structuredClone(next);
  assert.equal(armyUsesFlagTransport(next),true);assert.equal(armyBaseSide('r11c1'),'red');assert.equal(armyBaseSide('r11c3'),'red');assert.equal(armyBaseSide('r0c1'),'black');assert.equal(armyBaseSide('r0c3'),'black');assert.equal(armyBaseSide('r0c0'),null);
  assert.deepEqual(armyFlagMarks(next,'r0c0'),{baseSide:null,ground:[],carried:['black']});
  assert.deepEqual(armyFlagMarks(next,'r1c0'),{baseSide:null,ground:['red'],carried:[]});
  next.board[0].piece={hidden:true,id:'engineer-public',side:'red'};
  assert.deepEqual(armyFlagMarks(next,'r0c0').carried,[],'a malformed hidden identity is never used to infer a carrier');
  next.board[0]=before.board[0];assert.deepEqual(next,before,'public helpers never mutate the source board or flags');
  assert.deepEqual(armyFlagMarks({...next,ruleVersion:'army-flip-v1'},'r11c1'),{baseSide:null,ground:[],carried:[]});
});
test('v2 cell accessibility names base targets, carried and grounded flags and exact pickup permissions',()=>{
  const next=transportGame();next.legalPickups=[{cellId:'r1c0',flagSide:'red'}];
  assert.match(armyCellLabel(BOARD_CELLS.find(cell=>cell.cellId==='r11c1'),null,{game:next}),/红方基地.*敌旗运回这里获胜/);
  assert.match(armyCellLabel(BOARD_CELLS[0],next.board[0].piece,{game:next}),/携带黑方军旗/);
  assert.match(armyCellLabel(BOARD_CELLS.find(cell=>cell.cellId==='r1c0'),null,{game:next}),/地上有红方军旗.*可点按拾起红方军旗/);
  assert.equal(armyCellLabel(BOARD_CELLS[1],{hidden:true},{game:next}).includes('engineer-public'),false);
});
test('v2 pickup uses only the supplied legal action and selected dark targets move before flip',()=>{
  const next=transportGame();next.legalPickups=[{cellId:'r0c0',flagSide:'red'}];next.legalMoves.push({from:'r0c0',to:'r0c1'});
  const v={...view,game:next};
  assert.deepEqual(armyIntent(v,'r0c0','r0c0'),{type:'pickup',cellId:'r0c0',flagSide:'red',selected:null});
  assert.deepEqual(armyIntent(v,'r0c0','r0c1'),{type:'move',from:'r0c0',to:'r0c1',selected:null});
  assert.equal(armyIntent(v,null,'r0c1').type,'flip');
  assert.equal(armyIntent({...v,selfRole:'spectator'},null,'r0c0').type,'none');
  assert.equal(armyIntent({...v,game:{...next,turnPlayerId:'friend'}},null,'r0c0').type,'none');
  next.legalPickups=[];assert.equal(armyIntent(v,null,'r1c0').type,'none','a public ground flag does not confer pickup permission');
  next.legalPickups=[{cellId:'r0c0',flagSide:'red'}];next.ruleVersion='army-flip-v1';assert.equal(armyIntent(v,null,'r0c0').type,'select');assert.deepEqual(armyPickups(next,'r0c0'),[]);
});
test('two legal flags on one station require an explicit choice and a stale flag choice is rejected',()=>{
  const next=transportGame();next.legalPickups=[{cellId:'r0c0',flagSide:'black'},{cellId:'r0c0',flagSide:'red'}];const v={...view,game:next};
  const intent=armyIntent(v,null,'r0c0');assert.equal(intent.type,'choose-pickup');assert.deepEqual(intent.choices,next.legalPickups);
  assert.deepEqual(armyIntent(v,null,'r0c0',{flagSide:'red'}),{type:'pickup',cellId:'r0c0',flagSide:'red',selected:null});
  next.legalPickups=next.legalPickups.filter(item=>item.flagSide==='black');assert.equal(armyIntent(v,null,'r0c0',{flagSide:'red'}).type,'none');
  assert.equal(armyIntent(v,null,'r0c0',{flagSide:'forged'}).type,'none');
});
test('rule pages follow the saved version and practice replaces room exit claims without rewriting old games',()=>{
  const v1={ruleVersion:'army-flip-v1'},v2=transportGame();
  const old=armyRulePages(v1).flat().map(rule=>rule.text).join('');const current=armyRulePages(v2).flat().map(rule=>rule.text).join('');
  assert.match(old,/击败对方军旗/);assert.equal(old.includes('把敌旗运回'),false);assert.equal(armyRulePages(v1).length,3);assert.equal(armyRulePages(v2).length,4);
  assert.match(current,/拿到旗不会立即获胜/);assert.match(current,/未翻棋子也计入存活/);assert.match(current,/三枚地雷/);assert.match(current,/自己的旗.*不会赢/);
  assert.equal(armyRuleModeLabel(v1),'吃旗规则 v1');assert.equal(armyRuleModeLabel(v2),'运旗规则 v2');
  const practice=armyRulePages(v2,{practice:true}).flat().map(rule=>rule.text).join('');assert.match(practice,/返回大厅保存/);assert.equal(practice.includes('退出房间会中止'),false);
});
test('v2 public collision and flag events distinguish a pickup, protected reveal, drop, return and delivery',()=>{
  const text=(outcome,flagEvents=[])=>armyLastActionText({players:[{id:'me',name:'甲'}],game:{lastAction:{type:'move',playerId:'me',outcome,flagEvents}}});
  assert.match(text('friendly-reveal'),/同阵营暗子.*原地停留/);assert.match(text('protected-flag'),/三雷护旗.*原地停留/);assert.match(text('ineligible-flag'),/不能运旗.*原地停留/);
  assert.match(text('mutual',[{type:'drop',side:'black',cellId:'r1c0',carrierId:null}]),/同归.*黑方军旗掉在交战位置/);
  assert.match(text('move',[{type:'returned',side:'red',cellId:'r11c1',carrierId:null}]),/红方军旗已归位/);assert.equal(text('move',[{type:'returned',side:'red'}]).includes('获胜'),false);
  assert.match(armyLastActionText({game:{lastAction:{type:'pickup',flagSide:'black',flagEvents:[{type:'pickup',side:'black',cellId:null,carrierId:'public'}]}}}),/拾起军旗.*携带黑方军旗/);
  assert.match(armyResultText({reason:'flag-delivered',winnerIds:['me'],tie:false}),/敌方军旗.*运回己方基地.*获胜/);
});
