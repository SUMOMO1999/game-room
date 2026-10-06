// Rummikub-only inspection, tile transitions and opening-score presentation.
import { validateMeld, ruleVersionOf } from './rules.mjs';

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
