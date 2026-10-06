// Shared room presentation; no game engine or private state is imported.
import { gamePresentation } from '../games/catalog.mjs';

export function roomExitExplanation(phase) {
  return ['playing', 'paused'].includes(phase)
    ? '退出会中止这一局，所有人都不计输赢。你的席位会释放，其他朋友可以重新开局。'
    : '退出后会释放你的席位。棋牌账号继续登录，其他朋友留在房间。';
}

export function roomDraftMatches(saved, view) {
  if (!saved || !view?.game || view.phase === 'aborted') return false;
  if (typeof saved.matchId === 'string' && Number.isSafeInteger(saved.gameRevision)) {
    return saved.matchId === view.matchId && saved.gameRevision === view.game.revision;
  }
  return Number.isSafeInteger(saved.revision) && saved.revision === view.revision;
}

export function gameErrorMessage(error = {}) {
  const message=typeof error.message==='string'?error.message.trim():'';
  if(message && /[\u3400-\u9fff]/u.test(message) && Array.from(message).length<=100
    && !/[\r\n]|node_modules|\bat \S+\(|https?:\/\//i.test(message)) return message;
  if(error.status===401) return '登录已过期，请重新登录后继续。';
  if(error.status===403) return '这次操作暂不可用，请确认你的房间席位。';
  if(error.status===404) return '这个房间或席位已关闭，可以返回大厅。';
  if(error.status===409) return '房间有更新，请稍后再试。';
  if(error.status===503) return '服务暂时不可用，未确认的整理会保留。';
  return '连接暂时不可用，请稍后重试。';
}

export function orderedRoomPlayers(view) {
  const members = Array.isArray(view?.players) ? view.players : [];
  const cycle = Array.isArray(view?.game?.players) ? view.game.players.map(player => player.id) : [];
  if (!cycle.length) return members.map(player => ({ ...player }));
  const first = cycle.indexOf(view.turnClock?.firstPlayerId), start = first >= 0 ? first : 0;
  const ids = [...cycle.slice(start), ...cycle.slice(0, start)];
  const current = cycle.indexOf(view.game.turnPlayerId), next = current < 0 ? null : cycle[(current + 1) % cycle.length];
  return ids.map((id, index) => {
    const player = members.find(member => member.id === id);
    return player ? { ...player, turnOrder: index + 1, isCurrent: view.phase === 'playing' && id === view.game.turnPlayerId,
      isNext: view.phase === 'playing' && id === next } : null;
  }).filter(Boolean);
}

export function turnClockDisplay(view, elapsedMs = 0) {
  const clock = view?.turnClock;
  if (!clock || !['playing', 'paused'].includes(view.phase) || !Number.isFinite(view.serverTime)) return { visible: false, expired: false };
  const paused = view.phase === 'paused';
  const remainingMs = paused ? clock.remainingMs : Math.max(0, clock.deadlineAt - view.serverTime - Math.max(0, elapsedMs));
  const expired = !paused && remainingMs <= 0, seconds = Math.ceil(remainingMs / 1000);
  const time = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  const action = paused ? '已暂停' : expired ? '正在换人' : gamePresentation(view.gameType).timeout.action;
  const hint = gamePresentation(view.gameType).timeout.hint;
  return { visible: true, expired, paused, remainingMs, time, action,
    label: `${paused ? '已暂停，剩余' : '本回合剩余'} ${time}，${hint}。` };
}
