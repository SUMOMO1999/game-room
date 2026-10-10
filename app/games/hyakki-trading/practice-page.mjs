import { mountHyakkiPage } from './game-ui.mjs';
import { createHyakkiPracticeSession, PRACTICE_SELF, PRACTICE_STORAGE_KEY } from './practice-engine.mjs';
import { chooseHyakkiPracticeAction } from './practice-bot.mjs';
import { hyakkiCues } from './presentation.mjs';
import { getCard } from './content/definitions.mjs';
import { entryStorageKey } from '../../entry-path.mjs';
import { replacePracticeWithLobby } from '../../platform/practice-navigation.mjs';

const root = document.getElementById('hyakki-digital-root');
let session, snapshot, destroyed = false, leaving = false, running = false;
const removers = [];
const ui = mountHyakkiPage({ root, practice: true, onAction: action, onLeave: leave });
const listen = (node, event, fn) => { node.addEventListener(event, fn); removers.push(() => node.removeEventListener(event, fn)); };
const report = error => { if (!destroyed) { ui.feedback(error?.message || '本机练习暂时无法继续。'); ui.audio.play('invalid'); } };
const task = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(report);

// Local practice owns a virtual clock and a single saved game. Opening a
// reading panel suspends it; neither room presence nor account state is created.
function syncActivity() {
  if (!session || destroyed) return;
  const active = !leaving && !document.hidden && !root.querySelector('dialog[open]');
  if (active === running) return;
  running = active; session.setActive(active).catch(report);
}
async function action(type, fields = {}) {
  if (!session || destroyed || leaving || document.hidden) return;
  if (type === 'rematch') return ui.openPracticeRestart?.();
  // Own decision dialogs pause computer timers, but an explicit choice remains
  // valid. The session serializes and saves it before any next computer task.
  await session.action(type, fields);
}
async function leave() {
  if (leaving) return false;
  leaving = true; running = false;
  try { await session?.setActive(false); await session?.destroy(); }
  catch (error) { report(error); }
  finally { dispose(); replacePracticeWithLobby(window.location); }
  return true;
}
function hint() {
  if (!snapshot?.game || snapshot.conflict || snapshot.requiresRestart) return;
  const command = chooseHyakkiPracticeAction(snapshot.game, PRACTICE_SELF, { now: snapshot.logicalNow, allowPaused: true });
  if (!command) { ui.feedback('现在由电脑行动。你可以查看自己的牌文和公开货摊。'); return; }
  const labels = { peek: '看一张牌', 'keep-peek': '留下这张，进入用牌', 'discard-peek': '弃掉这张，继续挑选',
    'finish-draw': '结束取牌，开始用牌', 'end-turn': '结束回合', buy: '买入这组货物', sell: '卖出这组货物',
    'buy-stall': '购买扩摊', 'play-character': '使用人物牌', 'install-tool': '放置道具',
    'activate-tool': '使用道具', respond: '打出回应牌', 'decline-response': '放弃回应',
    'choose-effect': '完成当前选择', bid: `报价${command.amount}两`, 'pass-bid': '放弃竞价' };
  const card = command.cardId && getCard(command.cardId.split('#')[0]);
  ui.feedback(`建议：${card ? `${card.name} · ` : ''}${labels[command.type] || '按提示完成当前步骤'}。这只是建议，由你确认操作。`);
}
function applySnapshot(next) {
  if (destroyed) return;
  const before = snapshot; snapshot = next;
  const players = next.players.map(player => ({ ...player, ready: true, connected: true }));
  const game = next.game;
  const room = { gameType: 'hyakki-trading', roomId: 'hyakki-local-practice', roomCode: '',
    matchId: next.matchId, revision: game?.revision ?? 0, selfId: PRACTICE_SELF, selfRole: 'player', hostId: PRACTICE_SELF,
    phase: game ? ['finished', 'aborted'].includes(game.status) ? game.status : 'playing' : 'waiting',
    players, matchPlayers: players, spectators: [], game, hyakkiConfig: { actionLimit: game?.actionLimit ?? 5 },
    turnClock: game?.clock ? { ...game.clock, version: 4, matchId: next.matchId } : null, serverTime: next.logicalNow };
  ui.applyView(room, { connection: 'online', pending: false,
    canAct: !!game && !next.conflict && !next.requiresRestart, practiceSnapshot: next });
  if (!next.storageAvailable || next.conflict || next.requiresRestart) ui.feedback(next.storageNote);
  if (before?.game && next.active && !document.hidden) {
    for (const cue of hyakkiCues(before.game, game, PRACTICE_SELF)) ui.audio.play(cue);
  }
}
ui.configurePractice({
  onRestart: task(async options => { await session.restart(options); ui.audio.play('start'); syncActivity(); }),
  onReload: task(async () => { await session.reload(); syncActivity(); }), onHint: hint,
});
const observer = new MutationObserver(syncActivity);
observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['open'] });
listen(document, 'visibilitychange', syncActivity);
listen(window, 'pageshow', syncActivity);
listen(window, 'pagehide', event => {
  running = false; void session?.setActive(false).catch(report);
  if (!event.persisted) { void session?.destroy().catch(report); dispose(); }
});
function dispose() {
  if (destroyed) return;
  destroyed = true; observer.disconnect(); removers.forEach(remove => remove()); ui.destroy();
}
try {
  session = await createHyakkiPracticeSession({ key: entryStorageKey(PRACTICE_STORAGE_KEY), onChange: applySnapshot });
  applySnapshot(session.snapshot()); syncActivity();
} catch (error) {
  report(error);
  ui.conceal({ message: '练习暂时未能启动，请返回大厅后重新进入。' });
}
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
