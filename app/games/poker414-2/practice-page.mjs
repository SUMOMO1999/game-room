import { mountPoker414Page } from './page-ui.mjs';
import { toPoker414View, poker414Cues } from './presentation.mjs';
import { choosePoker414BotAction } from './practice-bot.mjs';
import { createPoker414PracticeSession, PRACTICE_STORAGE_KEY, PRACTICE_SELF } from './practice-engine.mjs';
import { entryStorageKey } from '../../entry-path.mjs';
import { replacePracticeWithLobby } from '../../platform/practice-navigation.mjs';

const root = document.getElementById('poker414-root');
let session, snapshot, leaving = false, destroyed = false, running = false, busy = false;
const ui = mountPoker414Page({ root, practice: true, onAction: action, onLeave: leave });
const $ = id => document.getElementById(id);
const removers = [];
function listen(node, event, callback) {
  node.addEventListener(event, callback); removers.push(() => node.removeEventListener(event, callback));
}
function report(error) { if (!destroyed) { ui.feedback(error?.message || '练习暂时无法继续，请读取保存进度或重新开始。'); ui.audio.play('invalid'); } }
function task(callback) { return (...args) => { Promise.resolve().then(() => callback(...args)).catch(report); }; }

// Practice owns only local storage and a virtual clock. No RoomClient, identity,
// chat transport or permanent-score endpoint is created by this page.
root.insertAdjacentHTML('beforeend', `<dialog id="p414-practice-confirm" class="p414-dialog"><div class="dialog-heading"><h2>重新开始练习？</h2><button id="p414-practice-cancel-x" class="close-button" aria-label="取消重新开始">×</button></div><p>这会替换本机保存的这一局，重新洗牌。正式房间和账号积分不受影响。</p><div class="p414-dialog-actions"><button id="p414-practice-cancel">继续这局</button><button id="p414-practice-confirm-start" class="p414-primary">重新开始</button></div></dialog>`);
const hint = document.createElement('button'); hint.type = 'button'; hint.id = 'p414-practice-hint'; hint.textContent = '提示';
$('p414-hand-label').parentElement.insertBefore(hint, $('p414-clear'));
function openRestart() { ui.settings.close(); $('p414-practice-confirm').showModal(); syncActivity(); }
listen($('p414-practice-restart'), 'click', openRestart);
for (const id of ['p414-practice-cancel', 'p414-practice-cancel-x']) listen($(id), 'click', () => $('p414-practice-confirm').close());
listen($('p414-practice-confirm-start'), 'click', task(async () => {
  if (busy) return;
  busy = true; $('p414-practice-confirm-start').disabled = true;
  try {
    await session.restart({ playerCount: Number($('p414-practice-count').value) });
    $('p414-practice-confirm').close(); ui.audio.play('start'); syncActivity();
  } finally { busy = false; $('p414-practice-confirm-start').disabled = false; }
}));
listen($('p414-practice-reload'), 'click', task(async () => {
  await session.reload(); ui.settings.close(); syncActivity();
}));
listen(hint, 'click', () => {
  if (!snapshot?.game || !snapshot.active) return;
  const suggestion = choosePoker414BotAction(snapshot.game, PRACTICE_SELF, { now: snapshot.logicalNow });
  if (suggestion?.type === 'play') { ui.selectCards(suggestion.cardIds); ui.feedback('已选出一组可出的牌；确认后点「出牌」。'); }
  else if (suggestion?.type === 'hook' || suggestion?.type === 'fork') ui.feedback(`现在可以${suggestion.type === 'hook' ? '勾' : '叉'}，点击对应按钮即可。`);
  else ui.feedback(snapshot.game.turnPlayerId !== PRACTICE_SELF ? '还没轮到你；留意随时出现的勾叉机会。' : '没有能压过的牌，可以点「不出」。');
});
async function action(type, fields) {
  if (type === 'rematch') { openRestart(); return; }
  if (!['play', 'pass', 'hook', 'fork'].includes(type)) return;
  await session.action(type, fields);
}
async function leave() {
  leaving = true; running = false;
  try { await session?.setActive(false); }
  catch (error) { report(error); }
  finally {
    try { await session?.destroy(); }
    catch (error) { report(error); }
    finally { dispose(); replacePracticeWithLobby(window.location); }
  }
  return true;
}
function syncActivity() {
  if (!session || destroyed) return;
  const active = !leaving && !document.hidden && !document.querySelector('dialog[open]');
  if (active === running) return;
  running = active;
  session.setActive(active).catch(report);
}
function applySnapshot(next) {
  if (destroyed) return;
  const previous = snapshot; snapshot = next;
  const players = next.players.map(player => ({ ...player, ready: true, connected: true }));
  const room = { gameType: 'poker414-2', roomId: 'poker414-local-practice', roomCode: '',
    matchId: next.matchId, revision: next.game?.revision ?? 0, selfId: PRACTICE_SELF, selfRole: 'player',
    hostId: PRACTICE_SELF, phase: next.game?.status === 'finished' ? 'finished' : next.game ? 'playing' : 'waiting',
    players, matchPlayers: players, spectators: [], game: next.game, serverTime: next.logicalNow };
  const view = toPoker414View(room, { canAct: !!next.game && !next.requiresRestart && !next.conflict && next.active });
  Object.assign(view, { transferCandidates: [], canTakeOver: false, canRematch: true, canChangeRole: false,
    canReady: false, canStart: false, clockPaused: !next.active,
    resultNote: '本局练习分，不计入账号积分或正式战绩。',
    leaveDescription: next.conflict || next.requiresRestart ? '现有存档会保留；本窗口未保存的进度不会覆盖它。返回不影响正式房间或积分。' : next.storageAvailable ? '返回大厅会保留本机练习进度；下次从414练习继续。不扣正式积分。' : '当前浏览器无法保存。返回后本局新进度可能丢失，不影响正式房间或积分。' });
  ui.applyView(view);
  root.classList.add('p414-practice');
  root.style.setProperty('--p414-practice-players', Math.max(3, players.length));
  hint.disabled = !view.canAct || view.phase !== 'playing';
  $('p414-practice-save').textContent = next.storageNote;
  $('p414-practice-reload').hidden = !next.conflict;
  if (!previous || previous.matchId !== next.matchId) $('p414-practice-count').value = String(players.length || 3);
  if (!next.game) {
    $('p414-waiting').querySelector('h1').textContent = '继续练习前，请确认存档';
    $('p414-ready-description').textContent = next.storageNote;
    $('p414-start-reason').textContent = '打开设置，读取保存进度，或确认重新开始。';
    for (const id of ['p414-ready', 'p414-start', 'p414-role']) $(id).hidden = true;
  }
  if (!next.storageAvailable || next.conflict || next.requiresRestart) ui.feedback(next.storageNote);
  else if (previous?.game?.revision !== next.game?.revision || previous?.active !== next.active || !previous) {
    ui.feedback(next.active ? '本机保存 · 不计正式积分 · 电脑只看自己的手牌与公牌' : '练习已暂停，回来后继续。');
  }
  if (previous && previous.matchId === next.matchId && next.active && !document.hidden) {
    for (const cue of poker414Cues(previous.game, next.game, PRACTICE_SELF)) ui.audio.play(cue);
  }
}
function dispose() {
  if (destroyed) return;
  destroyed = true; observer.disconnect(); removers.forEach(remove => remove()); ui.destroy();
}
const observer = new MutationObserver(syncActivity);
observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['open'] });
listen(document, 'visibilitychange', syncActivity);
listen(window, 'pageshow', syncActivity);
listen(window, 'pagehide', event => {
  running = false;
  void session?.setActive(false).catch(report);
  if (!event.persisted) { void session?.destroy().catch(report); dispose(); }
});
try {
  session = await createPoker414PracticeSession({ key: entryStorageKey(PRACTICE_STORAGE_KEY), onChange: applySnapshot });
  applySnapshot(session.snapshot()); syncActivity();
} catch (error) {
  report(error);
  root.querySelector('.p414-table').textContent = '练习暂时未能启动，请返回大厅后重新进入。';
}
