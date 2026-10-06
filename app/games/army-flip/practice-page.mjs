import { mountRoomAudioControls } from '../../platform/room-audio-controls.mjs';
import { mountGameViewport } from '../../platform/room-viewport.mjs';
import { entryBase, entryStorageKey } from '../../entry-path.mjs';
import { createPracticeSession, PRACTICE_SELF, PRACTICE_STORAGE_KEY, PRACTICE_V2_STORAGE_KEY, PRACTICE_LEGACY_STORAGE_KEY } from './practice-engine.mjs';
import { BOARD_CELLS, ROAD_EDGES, RAIL_EDGES } from './board.mjs';
import { armySideLabel, armyAssignmentText, armyCellLabel, armyTargets, armyIntent,
  armyTransition, armyResultText, armyLastActionText, armyUsesFlagTransport, armyFlagMarks, armyPickups, armyRulePages, armyRuleModeLabel } from './presentation.mjs';
import { createGameAudio } from '../../game-audio.mjs';
import { gameViewport } from '../../game-viewport.mjs';

const $ = id => document.getElementById(id);
const audio = createGameAudio();
const cellMap = new Map(BOARD_CELLS.map(cell => [cell.cellId, cell]));
let view = null, selected = null, portrait = false, boardSignature = '', rulePage = 0;
let leaving = false, resultDismissed = false, actionGesture = false, toastTimer;
let pickupDialog=null;
const available = () => !document.hidden && !leaving && !document.querySelector('dialog[open]');
const canAct = () => available() && view?.phase === 'playing' && view.game.turnPlayerId === PRACTICE_SELF;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
let storage = null;
try { storage = localStorage; } catch { /* Practice remains usable without saving. */ }
// Keep the published direct keys and locks. A mounted practice uses its own
// keys and lock, so switching entries cannot overwrite an unsubmitted local game.
if (storage && entryBase() === '/game/') {
  const original = storage;
  storage = { getItem: key => original.getItem(entryStorageKey(key)),
    setItem: (key, value) => original.setItem(entryStorageKey(key), value) };
}
const withLock = entryBase() === '/game/' && typeof navigator.locks?.request === 'function'
  ? callback => navigator.locks.request(entryStorageKey(PRACTICE_LEGACY_STORAGE_KEY), { mode: 'exclusive' }, callback) : undefined;
const session = await createPracticeSession({ storage, withLock, canRun: available, onChange: applySnapshot });

function turnText() {
  if (view?.phase === 'finished') return '练习已结束，可查看棋盘，或重新开始。';
  if (view?.game.turnPlayerId !== PRACTICE_SELF) return '练习对手正在行动，稍等一下。';
  if (view.game.players.some(player => !player.side)) {
    const last = view.game.players.find(player => player.id === PRACTICE_SELF)?.lastFlipSide;
    return last ? `你上次翻到${armySideLabel(last)}，再翻同色即可分色。` : '轮到你翻子；自己连续两次翻到同色，就分配阵营。';
  }
  return armyUsesFlagTransport(view.game)?'轮到你：翻子或选明子走棋、暗碰；点脚下标记拾旗，把敌旗运回己方基地。':'轮到你：翻一枚暗子，或点自己的明子，再点亮起的目标。';
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function applySnapshot(snapshot) {
  closePickupChoice();
  const previous = view;
  view = { roomId: 'army-local-practice', matchId: snapshot.matchId, selfId: PRACTICE_SELF,
    selfRole: 'player', phase: snapshot.game.status === 'finished' ? 'finished' : 'playing',
    revision: snapshot.game.revision, game: snapshot.game, players: snapshot.game.players };
  if (previous?.matchId !== view.matchId) resultDismissed = false;
  selected = null;
  render();
  $('practice-save-note').textContent = snapshot.storageAvailable
    ? '与自动对手练习 · 不计战绩 · 进度只保存在这个浏览器'
    : '与自动对手练习 · 不计战绩 · 当前无法保存，离开后进度可能丢失';
  const effects = armyTransition(previous, view, { baseline: snapshot.baseline || document.hidden });
  $('army-feedback').textContent = `${!snapshot.baseline && effects.changed ? armyLastActionText(view) : ''}${turnText()}`;
  const publicCue=effects.changed?audio.armyCue(view.game.lastAction):null;
  const cue=['draw','placement'].includes(effects.cue)?publicCue:effects.cue;
  if(publicCue && publicCue!==cue)audio.play(publicCue, { gesture: actionGesture });
  if (cue) audio.play(cue, { gesture: actionGesture });
}
function point(cell) {
  return portrait ? { x: (cell.column + .5) * 100, y: (cell.row + .5) * 100 }
    : { x: (cell.row + .5) * 100, y: (cell.column + .5) * 100 };
}
function drawRoads() {
  const line = (edges, name) => edges.map(([from, to]) => {
    const a = point(cellMap.get(from)), b = point(cellMap.get(to));
    return `<line class="${name}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
  }).join('');
  $('army-lines').setAttribute('viewBox', portrait ? '0 0 500 1200' : '0 0 1200 500');
  $('army-lines').innerHTML = line(ROAD_EDGES, 'army-road') + line(RAIL_EDGES, 'army-rail')
    + line(RAIL_EDGES, 'army-rail-line') + BOARD_CELLS.map(cell => {
      const { x, y } = point(cell), className = `army-terrain ${cell.terrain}`;
      return cell.terrain === 'camp' ? `<ellipse class="${className}" cx="${x}" cy="${y}" rx="31" ry="32"/>`
        : `<rect class="${className}" x="${x - 29}" y="${y - 26}" width="58" height="52" rx="${cell.terrain === 'headquarters' ? 3 : 8}"/>`;
    }).join('');
}
function fitBoard() {
  const bounds = $('army-board-stage').getBoundingClientRect(), columns = portrait ? 5 : 12, rows = portrait ? 12 : 5;
  const unit = Math.max(0, Math.min(bounds.width / columns, bounds.height / rows));
  $('army-board').style.width = `${unit * columns}px`; $('army-board').style.height = `${unit * rows}px`;
  $('army-board').style.setProperty('--army-unit', `${unit}px`);
}
function renderBoard() {
  if (!view) return;
  const game = view.game, active = canAct(), targets = active ? armyTargets(game, selected) : new Set();
  const signature = JSON.stringify([game.ruleVersion,game.board, game.lastAction,game.flagTokens,game.legalPickups,game.legalFlips,game.legalMoves, selected, active, portrait]);
  if (signature === boardSignature) return;
  boardSignature = signature;
  $('army-cells').replaceChildren(...game.board.map(item => {
    const cell = cellMap.get(item.cellId), p = point(cell), piece = item.piece,flags=armyFlagMarks(game,item.cellId),pickups=active?armyPickups(game,item.cellId):[];
    const button = element('button', `army-cell${piece ? ' has-piece' : ''}${flags.baseSide?' army-base '+flags.baseSide+'-base':''}${pickups.length?' pickup-ready':''}${selected === item.cellId ? ' selected' : ''}${targets.has(item.cellId) ? ' target' : ''}${[game.lastAction?.cellId, game.lastAction?.to].includes(item.cellId) ? ' last-action' : ''}`);
    button.type = 'button'; button.dataset.cellId = item.cellId;
    button.style.left = `${p.x / (portrait ? 5 : 12)}%`; button.style.top = `${p.y / (portrait ? 12 : 5)}%`;
    button.disabled = !active;
    button.setAttribute('aria-pressed', String(selected === item.cellId));
    button.setAttribute('aria-label', armyCellLabel(cell, piece, { selected: selected === item.cellId,
      target: targets.has(item.cellId), canFlip: active && game.legalFlips.includes(item.cellId),game }));
    if (piece) {
      const token = element('span', `army-piece ${piece.hidden ? 'hidden-piece' : piece.side}`);
      token.setAttribute('aria-hidden', 'true');
      if (!piece.hidden) token.append(element('span', '', piece.label), element('small', '', armySideLabel(piece.side)));
      button.append(token);
    } else if (cell.terrain === 'camp') button.append(element('span', 'army-empty-camp'));
    else if (cell.terrain === 'headquarters' && !flags.baseSide) button.append(element('span', 'army-empty-hq', '大本营'));
    if(flags.baseSide) button.append(element('span',`army-base-label ${flags.baseSide}`,flags.baseSide==='red'?'红基地':'黑基地'));
    if(flags.carried.length) button.append(element('span',`army-flag-mark carried ${flags.carried[0]}`,`携${flags.carried.map(side=>side==='red'?'红旗':'黑旗').join('/')}`));
    if(flags.ground.length) button.append(element('span',`army-flag-mark ground ${flags.ground[0]}${flags.ground.length>1?' both':''}`,flags.ground.length>1?`双旗${pickups.length?'·选':''}`:`${flags.ground[0]==='red'?'红旗':'黑旗'}${pickups.length?'·拾':''}`));
    button.addEventListener('click', () => clickCell(item.cellId));
    return button;
  }));
  $('army-cancel').disabled = !selected;
  requestAnimationFrame(fitBoard);
}
function closePickupChoice() { const dialog=pickupDialog;pickupDialog=null;if(dialog){dialog.close();dialog.remove();} }
function showPickupChoice(cellId,choices) {
  closePickupChoice();session.suspend();const dialog=element('dialog','army-dialog army-pickup-dialog');pickupDialog=dialog;
  dialog.setAttribute('aria-label','选择要拾取的军旗');dialog.append(element('h2','','拾哪一面旗？'),element('p','','脚下有两面军旗，选择本回合要携带的一面。'));
  const buttons=element('div','confirm-actions');
  for(const choice of choices) {
    const button=element('button','secondary-button',`拾起${armySideLabel(choice.flagSide)}军旗`);button.type='button';button.setAttribute('data-pickup-side',choice.flagSide);
    button.addEventListener('click',async()=>{closePickupChoice();await session.resume();await clickCell(cellId,{flagSide:choice.flagSide});});buttons.append(button);
  }
  const cancel=element('button','quiet-button','暂时不拾');cancel.type='button';cancel.addEventListener('click',async()=>{closePickupChoice();await session.resume();});dialog.append(buttons,cancel);
  dialog.addEventListener('close',()=>{if(pickupDialog===dialog)pickupDialog=null;dialog.remove();});document.body.append(dialog);dialog.showModal();
}
async function clickCell(cellId,{flagSide}={}) {
  const intent = armyIntent(view, selected, cellId, { active: canAct(),flagSide });
  if(intent.type==='choose-pickup'){showPickupChoice(cellId,intent.choices);return;}
  if (['flip','move','pickup'].includes(intent.type)) {
    actionGesture = true;
    const action = intent.type === 'flip' ? { type: 'flip', cellId } : intent.type==='pickup'?{type:'pickup',cellId:intent.cellId,flagSide:intent.flagSide}:{ type: 'move', from: intent.from, to: intent.to };
    const result = await session.act(action);
    if (!result.ok) { $('army-feedback').textContent = result.error; audio.play('invalid', { gesture: true }); }
    actionGesture = false;
    return;
  }
  if (['select', 'cancel'].includes(intent.type)) {
    selected = intent.selected; renderBoard();
    audio.play(intent.type==='select'?'select':'undo',{gesture:true});
    $('army-feedback').textContent = intent.type === 'cancel' ? turnText()
      : intent.targets.length ? `点亮起的目标，${armyUsesFlagTransport(view.game)?'走棋、吃子或暗碰':'走棋或吃子'}。` : '这枚棋子没有合法目标，可另选棋子或翻子。';
  } else if (intent.message) $('army-feedback').textContent = intent.message;
}
function render() {
  const game = view.game;
  $('room-players').replaceChildren(...game.players.map(player => {
    const active = game.status === 'playing' && game.turnPlayerId === player.id;
    const seat = element('div', `player-seat${active ? ' current' : ''}`);
    seat.append(element('span', `army-side ${player.side || 'unassigned'}`, armySideLabel(player.side)),
      element('strong', '', player.name), element('span', 'player-detail', game.status === 'finished' ? '本局结束'
        : `${active ? '正在行动' : '等待'}${!player.side && player.lastFlipSide ? ' · 上次' + armySideLabel(player.lastFlipSide) : ''}`));
    return seat;
  }));
  $('army-round').textContent = `第 ${game.round} 回合`;
  $('army-turn').textContent = game.status === 'finished' ? '练习结束' : game.turnPlayerId === PRACTICE_SELF ? '轮到你' : '对手的回合';
  $('room-result').hidden = game.status !== 'finished' || resultDismissed;
  if (game.status === 'finished') {
    $('result-title').textContent = game.result?.tie ? '这局练习和棋。' : game.winnerId === PRACTICE_SELF ? '你赢了这局练习。' : '练习对手赢了这一局。';
    $('result-reason').textContent = armyResultText(game.result);
  }
  renderBoard();
  if ($('army-captured-dialog').open) renderCaptured();
  requestAnimationFrame(fitBoard);
}
function renderCaptured() {
  $('army-captured-list').replaceChildren(...['red', 'black'].map(side => {
    const labels = view.game.capturedPieces.filter(piece => piece.side === side).map(piece => piece.label);
    return element('p', '', `${armySideLabel(side)}：${labels.length ? labels.join('、') : '暂无'}`);
  }));
}
function renderRules() {
  const pages=armyRulePages(view?.game,{practice:true});rulePage=Math.min(rulePage,pages.length-1);
  $('rules-title').textContent=`翻棋军棋练习 · ${armyRuleModeLabel(view?.game)}`;
  $('army-assignment-rule').textContent = armyAssignmentText(view?.game?.assignment || 'two-flips');
  $('army-rule-page').replaceChildren(...pages[rulePage].map(rule => {
    const section = element('section');
    section.append(element('h3', '', rule.title), element('p', '', rule.text)); return section;
  }));
  $('army-rules-page').textContent = `${rulePage + 1}/${pages.length}`;
  $('army-rules-prev').disabled = rulePage === 0; $('army-rules-next').disabled = rulePage === pages.length - 1;
}
function showDialog(id) { session.suspend(); selected = null; renderBoard(); $(id).showModal(); }
function syncViewport() {
  const v = gameViewport({ width: innerWidth, height: innerHeight, visual: window.visualViewport });
  document.body.style.setProperty('--army-viewport-height', `${v.height}px`);
  document.body.style.setProperty('--army-viewport-width', `${v.width}px`);
  const nextPortrait = v.height > v.width;
  if (nextPortrait !== portrait || !boardSignature) {
    portrait = nextPortrait; document.body.classList.toggle('portrait-board', portrait);
    drawRoads(); boardSignature = ''; renderBoard();
  }
  if (v.resetScroll) {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    for (const id of ['room-play', 'room-players', 'army-board-stage']) { $(id).scrollTop = 0; $(id).scrollLeft = 0; }
  }
  requestAnimationFrame(fitBoard);
}
function returnToPractice() { leaving = false; syncViewport(); if (!document.hidden && available()) session.resume(); }
document.addEventListener('visibilitychange', () => { if (document.hidden) {session.suspend();closePickupChoice();} else returnToPractice(); });
window.addEventListener('pagehide', () => { leaving = true; session.suspend();closePickupChoice(); });
window.addEventListener('pageshow', returnToPractice);
window.addEventListener('focus', returnToPractice);
window.addEventListener('storage', event => { if ([PRACTICE_STORAGE_KEY,PRACTICE_V2_STORAGE_KEY,PRACTICE_LEGACY_STORAGE_KEY].map(key => entryStorageKey(key)).includes(event.key) && available()) session.resume(); });
mountGameViewport({ window, document, sync: syncViewport });
$('exit-practice').addEventListener('click', () => { leaving = true; session.suspend(); });
$('army-cancel').addEventListener('click', () => { if(!selected)return;selected = null; renderBoard(); $('army-feedback').textContent = turnText();audio.play('undo',{gesture:true}); });
$('show-rules').addEventListener('click', () => { renderRules(); showDialog('rules-dialog'); });
for (const [id, delta] of [['army-rules-prev', -1], ['army-rules-next', 1]]) $(id).addEventListener('click', () => { rulePage += delta; renderRules(); });
for (const id of ['close-rules', 'start-playing']) $(id).addEventListener('click', () => $('rules-dialog').close());
for (const id of ['restart', 'result-restart']) $(id).addEventListener('click', () => showDialog('restart-dialog'));
for (const id of ['close-restart', 'cancel-restart']) $(id).addEventListener('click', () => $('restart-dialog').close());
$('confirm-restart').addEventListener('click', async () => { await session.restart(); $('restart-dialog').close();audio.play('start',{gesture:true}); });
$('result-close').addEventListener('click', () => { resultDismissed = true; $('room-result').hidden = true; });
$('army-captured').addEventListener('click', () => { renderCaptured(); showDialog('army-captured-dialog'); });
$('army-captured-close').addEventListener('click', () => $('army-captured-dialog').close());
document.addEventListener('close', () => { if (available()) session.resume(); }, true);
document.addEventListener('click', event => { if (event.target.closest?.('#app-install')) session.suspend(); }, true);
document.addEventListener('DOMContentLoaded', () => {
  const tip = document.querySelector('#app-install-dialog .dialog-tip');
  if (tip) tip.replaceChildren(element('strong', '', '练习只保存在这个浏览器'), element('p', '', '军棋练习不计战绩。不同浏览器或桌面入口可能使用不同的本机存档；朋友局仍可登录同一个账号恢复。'));
});

mountRoomAudioControls({ audio, document });
drawRoads(); syncViewport(); await session.resume();
