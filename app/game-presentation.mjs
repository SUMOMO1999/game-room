import { validateMeld, ruleVersionOf } from './rules.mjs';

/** Presentation only: page a dense/unfinished group without changing game data. */
export function inspectorPages(board, rack, mode, pageSize = 14) {
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 14;
  const groups = mode === 'board' ? (Array.isArray(board) ? board : []) : [Array.isArray(rack) ? rack : []];
  return groups.flatMap((tiles, groupIndex) => {
    if (!Array.isArray(tiles) || !tiles.length) return [];
    const parts = Math.ceil(tiles.length / size);
    return Array.from({ length: parts }, (_, part) => ({
      tiles: tiles.slice(part * size, (part + 1) * size), groupIndex, part, parts,
      selectionIds: tiles.map(tile => tile.id),
    }));
  });
}

/** A reconnect/current snapshot establishes a baseline and never replays cues. */
export function roomTransition(previous, current, { baseline = false } = {}) {
  const none = { cue: null, boardChanged: false, arrivedIds: [], turnToSelf: false };
  if (baseline || !previous?.game || !current?.game || previous.phase !== 'playing'
    || !['playing', 'finished'].includes(current.phase)
    || previous.roomId !== current.roomId || previous.selfId !== current.selfId
    || previous.matchId && current.matchId && previous.matchId!==current.matchId
    || !Number.isSafeInteger(previous.revision) || !Number.isSafeInteger(current.revision) || current.revision <= previous.revision
    || current.game.round < previous.game.round) return none;
  const before = previous.game, after = current.game;
  const beforeBoard = Array.isArray(before.board) ? before.board : [];
  const afterBoard = Array.isArray(after.board) ? after.board : [];
  const oldIds = new Set(beforeBoard.flat().map(tile => tile.id));
  const arrivedIds = afterBoard.flat().filter(tile => !oldIds.has(tile.id)).map(tile => tile.id);
  const boardChanged = JSON.stringify(beforeBoard) !== JSON.stringify(afterBoard);
  const turnToSelf = current.phase === 'playing' && before.turnPlayerId !== after.turnPlayerId
    && after.turnPlayerId === current.selfId;
  let cue = null;
  if (current.phase === 'finished' && after.status === 'finished' && !after.result?.aborted) {
    cue=current.selfRole==='spectator' || after.result?.tie?'draw-result':Array.isArray(after.result?.winnerIds) && !after.result.winnerIds.includes(current.selfId)?'loss':'win';
  }
  else if (turnToSelf) cue = 'turn';
  else if (before.turnPlayerId !== previous.selfId && after.round > before.round) {
    if (boardChanged) cue = 'commit';
    else {
      const actorBefore = before.players?.find(player => player.id === before.turnPlayerId);
      const actorAfter = after.players?.find(player => player.id === before.turnPlayerId);
      if (actorBefore && actorAfter && actorAfter.rackCount > actorBefore.rackCount) cue = 'draw';
    }
  }
  return { cue, boardChanged, arrivedIds, turnToSelf };
}

export function roomExitExplanation(phase) {
  return ['playing', 'paused'].includes(phase)
    ? '退出会中止这一局，所有人都不计输赢。你的席位会释放，其他朋友可以重新开局。'
    : '退出后会释放你的席位。棋牌账号继续登录，其他朋友留在房间。';
}

/** Room-only votes/host changes must not invalidate an unchanged private game draft. */
export function roomDraftMatches(saved, view) {
  if (!saved || !view?.game || view.phase === 'aborted') return false;
  if (typeof saved.matchId === 'string' && Number.isSafeInteger(saved.gameRevision)) {
    return saved.matchId === view.matchId && saved.gameRevision === view.game.revision;
  }
  return Number.isSafeInteger(saved.revision) && saved.revision === view.revision;
}

/** Public feedback is a short sentence, never a browser/server diagnostic dump. */
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

/** Keep the real engine cycle anchored to the match's first player, never a nickname or the current turn. */
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

/** elapsedMs is monotonic time since receipt; serverTime is sampled only when a real view is sent. */
export function turnClockDisplay(view, elapsedMs = 0) {
  const clock = view?.turnClock;
  if (!clock || !['playing', 'paused'].includes(view.phase) || !Number.isFinite(view.serverTime)) return { visible: false, expired: false };
  const paused = view.phase === 'paused';
  const remainingMs = paused ? clock.remainingMs : Math.max(0, clock.deadlineAt - view.serverTime - Math.max(0, elapsedMs));
  const expired = !paused && remainingMs <= 0, seconds = Math.ceil(remainingMs / 1000);
  const time = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  const action = paused ? '已暂停' : expired ? '正在换人' : view.gameType === 'army-flip' ? '超时跳过' : '超时摸牌';
  const hint = view.gameType === 'army-flip' ? '时间到后自动跳过当前回合' : '时间到后自动摸一张牌；牌池空时按过牌规则处理';
  return { visible: true, expired, paused, remainingMs, time, action,
    label: `${paused ? '已暂停，剩余' : '本回合剩余'} ${time}，${hint}。` };
}

/** Opening displays count only complete legal groups made entirely from this player's hand. */
export function openingProgress(committed, draft, options = {}) {
  if (!committed || !draft || committed.opened) return null;
  const owned = new Set(committed.rack.map(tile => tile.id));
  const ruleVersion = ruleVersionOf(committed);
  const config = { ...options, ruleVersion, ...(committed.jokerConfig === undefined ? {} : { jokerConfig: committed.jokerConfig }) };
  const ownGroups = draft.board.filter(group => group.length && group.every(tile => owned.has(tile.id)));
  const points = ownGroups.reduce((sum, group) => {
    const result = validateMeld(group, config);
    return sum + (result.valid ? result.points : 0);
  }, 0);
  const missing = Math.max(0, 30 - points);
  const hasMirror = (committed.jokerConfig?.mirror ?? 0) > 0;
  const mirrorNote = hasMirror ? ruleVersion === 'friends-v4' ? '镜像计对应数字' : '镜像自身计 0 点' : '';
  return { points, missing, ownGroups: ownGroups.length, mirrorNote,
    label: `开局 ${points} / 30 点`,
    detail: `开局 ${points} / 30 点 · ${missing ? `还差 ${missing} 点` : '点数已达标'}${mirrorNote ? ` · ${mirrorNote}` : ''}` };
}
