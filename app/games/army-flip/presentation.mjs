import { PIECE_LABELS } from './board.mjs';
/** Public presentation only; hidden pieces never acquire a client-side identity. */
export const ARMY_ASSIGNMENT_TEXT = {
  'two-flips': '双方轮流翻子；某玩家自己连续两次翻到同色，该色归他，另一色归对方。炸弹也计入分色。',
  'first-flip': '首枚翻开的颜色归先翻者，另一方归另一色；之后轮到另一方。',
};
export function armySideLabel(side) { return side === 'red' ? '红方' : side === 'black' ? '黑方' : '未分阵营'; }
export function armyAssignmentText(assignment) { return ARMY_ASSIGNMENT_TEXT[assignment] || '开局后按本房间的分色方式确定阵营。'; }
export function armyUsesFlagTransport(game) { return ['army-flip-v2', 'army-flip-v3'].includes(game?.ruleVersion); }
export function armyBaseSide(cellId) {
  return ['r11c1','r11c3'].includes(cellId) ? 'red' : ['r0c1','r0c3'].includes(cellId) ? 'black' : null;
}
export function armyPickups(game,cellId) {
  return armyUsesFlagTransport(game) ? (game.legalPickups || []).filter(item=>item.cellId===cellId && ['red','black'].includes(item.flagSide)) : [];
}
export function armyFlagMarks(game,cellId) {
  if(!armyUsesFlagTransport(game)) return {baseSide:null,ground:[],carried:[]};
  const piece=game.board?.find(item=>item.cellId===cellId)?.piece;
  const flags=(game.flagTokens || []).filter(flag=>['red','black'].includes(flag.side));
  return {baseSide:armyBaseSide(cellId),
    ground:flags.filter(flag=>flag.carrierId===null && flag.cellId===cellId).map(flag=>flag.side),
    carried:piece && !piece.hidden && piece.id ? flags.filter(flag=>flag.carrierId===piece.id).map(flag=>flag.side) : []};
}
export function armyPoint(cell) { return { x: (cell.row + .5) * 100, y: (cell.column + .5) * 100 }; }
export function armyPieceLabel(piece) {
  return !piece ? '空位' : piece.hidden ? '未翻暗子' : `${armySideLabel(piece.side)} ${piece.label || '棋子'}`;
}
export function armyCellLabel(cell, piece, { selected = false, target = false, canFlip = false, game = null } = {}) {
  const flags=armyFlagMarks(game,cell.cellId);
  const terrain = cell.terrain === 'camp' ? '行营，营内免受攻击' : flags.baseSide ? `${armySideLabel(flags.baseSide)}基地，将敌旗运回这里获胜` : cell.terrain === 'headquarters' ? '大本营，本玩法按普通站点' : '兵站';
  const flagText=[...flags.ground.map(side=>`地上有${armySideLabel(side)}军旗`),...flags.carried.map(side=>`携带${armySideLabel(side)}军旗`),...armyPickups(game,cell.cellId).map(item=>`可点按拾起${armySideLabel(item.flagSide)}军旗`)].join('，');
  return `${cell.row + 1}行${cell.column + 1}列，${terrain}，${armyPieceLabel(piece)}${flagText?'，'+flagText:''}${selected ? '，已选中' : ''}${target ? '，合法目标' : ''}${canFlip ? '，可翻开' : ''}`;
}
export function armyTargets(game, selected) {
  return new Set((game?.legalMoves || []).filter(move => move.from === selected && typeof move.to === 'string').map(move => move.to));
}
export function armyIntent(view, selected, cellId, { active = true, flagSide } = {}) {
  if (!active || view?.selfRole==='spectator' || view?.phase !== 'playing' || view.game?.status !== 'playing' || view.game.turnPlayerId !== view.selfId) return { type: 'none', selected: null };
  const game = view.game, item = game.board?.find(cell => cell.cellId === cellId);
  if (!item) return { type: 'none', selected };
  if (selected && armyTargets(game, selected).has(cellId)) return { type: 'move', from: selected, to: cellId, selected: null };
  const pickups=armyPickups(game,cellId);
  if(flagSide!==undefined) {
    const pickup=pickups.find(item=>item.flagSide===flagSide);
    return pickup?{type:'pickup',cellId,flagSide:pickup.flagSide,selected:null}:{type:'none',selected,message:'这枚军旗当前不能拾取，请按最新棋盘继续。'};
  }
  if(pickups.length>1) return {type:'choose-pickup',cellId,choices:pickups.map(item=>({...item})),selected};
  if(pickups.length===1) return {type:'pickup',cellId,flagSide:pickups[0].flagSide,selected:null};
  if (item.piece?.hidden && game.legalFlips?.includes(cellId)) return { type: 'flip', cellId, selected: null };
  if (selected === cellId) return { type: 'cancel', selected: null };
  const mine = game.players?.find(player => player.id === view.selfId)?.side;
  if (!item.piece?.hidden && item.piece?.side === mine && mine) {
    return { type: 'select', selected: cellId, targets: [...armyTargets(game, cellId)] };
  }
  return { type: 'none', selected, message: item.piece?.hidden ? '这枚暗子当前不能翻开。' : item.piece ? '请选择自己的棋子，或翻开一枚暗子。' : '点选自己的棋子后，再点亮起的目标。' };
}
export function armyTransition(previous, current, { baseline = false } = {}) {
  if (baseline || !previous?.game || !current?.game || previous.roomId !== current.roomId || previous.matchId !== current.matchId || previous.selfId !== current.selfId || previous.phase !== 'playing' || current.revision <= previous.revision) return { cue: null, changed: false };
  const changed = previous.game.revision !== current.game.revision;
  if (!changed) return { cue: null, changed: false };
  if (current.phase === 'finished' && !current.game.result?.aborted) { const result=current.game.result; const cue=current.selfRole==='spectator' || result?.tie?'draw-result':!result?'win':(result.winnerIds || [current.game.winnerId]).includes(current.selfId)?'win':'loss';return {cue,changed:true}; }
  if (current.phase === 'playing' && previous.game.turnPlayerId !== current.game.turnPlayerId && current.game.turnPlayerId === current.selfId) return { cue: 'turn', changed: true };
  return { cue: current.game.lastAction?.type === 'flip' ? 'draw' : 'placement', changed: true };
}
export function armyResultText(result, players = []) {
  if (result?.aborted) return '有朋友退出房间，本局中止，不计输赢。';
  if (result?.tie || result?.winnerId === null || (result?.winnerIds?.length === 0 && result?.reason)) return ({ 'draw-agreed': '双方同意和棋。', 'assignment-exhausted': '全部暗子已翻开，仍未分阵营，本局和棋，可再来一局。' })[result?.reason] || '本局和棋。';
  const reasons = { 'flag-captured': '军旗被攻占。', 'flag-delivered':'敌方军旗已运回己方基地，运旗一方获胜。', blocked: '一方已无行动可走。', resigned: '一方认输。' };
  return reasons[result?.reason] || '这一局已经结束。';
}
export const ARMY_RULE_PAGES = [
  [{title:'随机翻棋',text:'双方各25枚棋子随机扣在50个兵站上，10个行营起初空置。每回合翻一枚暗子，或移动、攻击一次自己的明子。没有倒计时。'}, {title:'阵营与目标',text:'阵营确定前只翻子；分色方式见本房间说明。击败对方军旗，或令对方无行动可走获胜。无需翻开所有暗子。若所有暗子翻完仍未分色，自动和棋。'}],
  [{title:'移动与行营',text:'公路走一步；铁路可沿直线走多个空站，工兵可沿连续铁路转弯。棋子挡路不能越过；不能走入暗子所在站点。行营内的棋子免受攻击。'}, {title:'大本营与固定棋子',text:'本项目翻棋把大本营作为普通兵站，入营仍可离开。地雷和军旗不能移动；普通棋子可以主动攻击更大的明子并被吃掉。'}],
  [{title:'大小与特殊棋子',text:'司令＞军长＞师长＞旅长＞团长＞营长＞连长＞排长＞工兵。同级同归。炸弹与可攻击目标同归；工兵能挖地雷，其他普通子不能攻击地雷。'}, {title:'护旗与结束',text:'对方三枚地雷全部被移除后才能攻击军旗，未翻地雷也算护旗。司令阵亡不自动亮旗。双方可提议和棋或确认认输；退出房间会中止本局，不计输赢。'}],
];

const ARMY_TRANSPORT_RULE_PAGES = [
  [{title:'随机翻棋',text:'双方各25枚棋子随机扣在50个兵站上，10个行营起初空置。每回合翻一枚暗子、移动或攻击一次明子，也可按合法提示拾起脚下军旗。没有倒计时。'}, {title:'阵营与目标',text:'阵营确定前只翻子；分色方式见本房间说明。新版需要把敌旗运回己方基地，或使对方无行动可走获胜；拿到旗不会立即获胜。红方基地在棋盘红端的两个大本营，黑方基地在黑端。自己的旗归位不算获胜。若暗子全翻开仍未分色，自动和棋。'}],
  [{title:'移动与暗碰',text:'公路走一步；铁路可沿直线走多个空站，工兵可沿连续铁路转弯。已选明子可点亮起的暗格进行暗碰，目标先翻开再判定；若同阵营，攻子停在原处，仍用掉一回合。不能越过有棋子的站点。'}, {title:'行营与基地',text:'行营内的棋子免受攻击；基地仍是普通站点，入内可以离开。携旗后的公路、铁路走法保持不变。基地有红黑文字标记，将敌旗带到自己的任一基地获胜。'}],
  [{title:'大小与特殊棋子',text:'司令＞军长＞师长＞旅长＞团长＞营长＞连长＞排长＞工兵。同级同归。炸弹与可攻击目标同归；工兵能挖地雷。已翻地雷只可由工兵或炸弹攻击，其他普通子暗碰敌雷会阵亡。'}, {title:'三雷护旗',text:'对方三枚地雷全部被移除后，才可以夺取对方军旗，未翻地雷也算护旗。司令阵亡不自动亮旗。暗碰受保护的旗或当前不能运的旗，只翻开并留在原处，仍用掉一回合。必须运回敌旗才获胜。'}],
  [{title:'拾旗与携旗',text:'工兵可以运旗。某方工兵全部阵亡后，该方最小存活官阶才可运旗，未翻棋子也计入存活。每枚棋子只携一面旗，可点脚下提示拾旗；同格双旗可明确选择，走入双旗格优先拾敌旗。携旗棋子带旗角标。'}, {title:'落旗与归位',text:'携旗棋子被吃或同归，旗掉在交战位置，可再次拾取。携自己的旗回己方基地只会归位，不会赢；敌旗运回才获胜。双方可提和或确认认输；退出房间会中止本局，不计输赢。'}],
];
export function armyRulePages(game,{practice=false}={}) {
  const pages=armyUsesFlagTransport(game)?ARMY_TRANSPORT_RULE_PAGES:ARMY_RULE_PAGES;
  return pages.map(page=>page.map(rule=>{
    let text=rule.text;
    if(game?.ruleVersion==='army-flip-v3' && rule.title==='大小与特殊棋子') text='司令＞军长＞师长＞旅长＞团长＞营长＞连长＞排长＞工兵。同级同归。工兵无损排雷，炸弹与目标同归。本方所有工兵阵亡后，最小存活官阶可与敌雷同归排雷；同级最小官阶均可。未翻工兵和更小官阶也计入存活。其他普通子暗碰敌雷只会阵亡，地雷仍保留。';
    return {title:rule.title,text:practice?text.replace('双方可提议和棋或确认认输；退出房间会中止本局，不计输赢。','练习可随时返回大厅保存，重新开始会清空这一局。').replace('双方可提和或确认认输；退出房间会中止本局，不计输赢。','练习可随时返回大厅保存，重新开始会清空这一局。'):text};
  }));
}
export function armyRuleModeLabel(game) { return game?.ruleVersion==='army-flip-v3'?'牺牲排雷 · 运旗 v3':armyUsesFlagTransport(game)?'运旗规则 v2':'吃旗规则 v1'; }

export function armyLastActionText(view) {
  const action=view?.game?.lastAction;if(!action)return '';
  const name=view.players?.find(player=>player.id===action.playerId)?.name || '朋友';
  if(action.type==='timeout') return `${name}本回合时间已到，自动跳过。`;
  if(action.type==='flip') return `${name}翻开${armySideLabel(action.side)}${PIECE_LABELS[action.kind] || '棋子'}。`;
  if(action.type==='move' || action.type==='pickup') {
    const description=action.type==='pickup'?'拾起军旗':({move:'走了一步',capture:'吃掉对方棋子','attacker-lost':'的攻子被吃掉',mutual:'与对方棋子同归','mine-sacrifice':'以最小存活官阶与敌方地雷同归，排除了地雷',flag:'攻占军旗','friendly-reveal':'翻开同阵营暗子，原地停留','protected-flag':'翻开军旗，三雷护旗尚未解除，原地停留','ineligible-flag':'翻开军旗，该棋子当前不能运旗，原地停留','flag-pickup':'拾起军旗','flag-delivered':'把敌旗运回己方基地，获胜','flag-returned':'将自己的旗送回基地归位'})[action.outcome] || '完成走棋';
    const events=(action.flagEvents || []).filter(event=>['red','black'].includes(event.side)).map(event=>({drop:`${armySideLabel(event.side)}军旗掉在交战位置。`,pickup:`携带${armySideLabel(event.side)}军旗。`,returned:`${armySideLabel(event.side)}军旗已归位。`,delivered:`${armySideLabel(event.side)}军旗已运回基地。`})[event.type]).filter(Boolean).join('');
    return `${name}${description}。${events}`;
  }
  return '';
}
