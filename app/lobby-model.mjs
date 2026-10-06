const PHASES = new Set(['waiting', 'playing', 'paused', 'finished', 'aborted']);
const PHASE_LABELS = { waiting: '等待开局', playing: '正在游戏', paused: '暂停保存', finished: '本局已结束', aborted: '本局已中止' };

export function normalizeRecentRoom(entry) {
  if (!entry || !/^\d{6}$/.test(entry.roomCode) || typeof entry.playerId !== 'string' || !entry.playerId) return null;
  const result = { roomCode: entry.roomCode, playerId: entry.playerId,
    name: typeof entry.name === 'string' ? entry.name : '', phase: entry.phase, at: entry.at };
  for (const key of ['updatedAt', 'expiresAt']) if (Number.isFinite(entry[key]) && entry[key] > 0) result[key] = entry[key];
  for (const key of ['playersCount', 'connectedCount']) if (Number.isInteger(entry[key]) && entry[key] >= 0 && entry[key] <= 7) result[key] = entry[key];
  if (typeof entry.hostName === 'string') result.hostName = entry.hostName;
  if (['rummikub','army-flip'].includes(entry.gameType)) result.gameType=entry.gameType;
  if(['player','spectator'].includes(entry.selfRole))result.selfRole=entry.selfRole;
  if(Number.isInteger(entry.spectatorsCount) && entry.spectatorsCount>=0 && entry.spectatorsCount<=8)result.spectatorsCount=entry.spectatorsCount;
  return result;
}

export function roomPhaseLabel(phase) { return PHASE_LABELS[phase] || '原来的房间'; }
export function exitConsequence(phase,{role}={}) {
  if(role==='spectator')return '退出观战，不会中止玩家的牌局。';
  return ['playing', 'paused'].includes(phase)
    ? '退出会结束当前这一局，不计输赢。其他朋友可以留在房间重新开局。'
    : '退出后释放你的座位；最后一人退出时，房间会自动关闭。';
}
export function createExitRequest(view, requestId) {
  if (!view || !PHASES.has(view.phase) || !Number.isSafeInteger(view.revision) || view.revision < 0
      || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new TypeError('房间状态暂时无法确认，请重试。');
  return { type: 'leave', expectedRevision: view.revision, requestId };
}
export function historyOutcome(item) {
  if (item?.status === 'aborted') return '已中止 · 不计输赢';
  return ({ win: '胜', draw: '平', loss: '负', unscored: '不计分' })[item?.self?.outcome] || '本局已结束';
}
export function historyPoints(points) {
  return Number.isFinite(points) && points >= 0 ? `剩余手牌 ${points} 点` : '未计分';
}
