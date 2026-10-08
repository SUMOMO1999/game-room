/** Browser-safe role projection and local selection hints. No shuffle, full game or account key. */
import { getCard, rankLabel } from './cards.mjs';
import { beatsPattern, classifyPattern, enumerateLegalPlays, chooseResponseCards } from './patterns.mjs';

const list = value => Array.isArray(value) ? value : [];
const cards = ids => list(ids).map(id => ({ ...getCard(typeof id === 'string' ? id : id.id) }));
const signed = value => `${value > 0 ? '+' : ''}${value}`;
const cancellation = reason => ({ disconnected: '有伙伴连续失联120秒，本局已取消，不计分。',
  'server-recovery': '服务恢复后，本局已取消，不计分。已保存的积分不受影响。',
  'room-expired': '房间长时间没有活动，本局已取消，不计分。' })[reason] || '本局已经取消，不计分。';

export function poker414PatternLabel(pattern) {
  if (!pattern) return '未组成牌型';
  const rank = rankLabel(pattern.rank);
  if (pattern.kind === 'rocket') return `${['', '杂色', '同花', '纯红桃'][pattern.rocketTier]}火箭`;
  if (pattern.kind === 'bomb') return `${pattern.count}张${rank}炸弹`;
  return ({ single: `${rank}单牌`, pair: `${rank}对子`, 'pair-small-jokers': '小王对', 'pair-large-jokers': '大王对',
    'mixed-joker-bomb': '大小王炸弹', straight: `${pattern.count}张顺子`, 'pair-straight': `${pattern.count / 2}连对` })[pattern.kind] || '未知牌型';
}

function scoreData(packet, room) {
  if (!packet || packet.accountGroup !== '4a4' || packet.roomId !== room.roomId || !Number.isSafeInteger(packet.roomRevision) || packet.roomRevision > room.revision || packet.matchId !== (room.matchId ?? room.lastMatchResult?.matchId ?? null)) return { readAt: null, totals: new Map(), settlement: null };
  return { readAt: packet.readAt ?? null, totals: new Map(list(packet.players).filter(player => Number.isSafeInteger(player.total))
    .map(player => [player.playerId, player.total])), settlement: packet.settlement?.matchId === (room.matchId ?? room.lastMatchResult?.matchId) ? packet.settlement : null };
}

export function toPoker414View(room, { scorePacket = null, pending = false, connection = 'online', canAct = true } = {}) {
  if (!room || room.gameType !== 'poker414-2' || !['player', 'spectator'].includes(room.selfRole)) throw new TypeError('需要当前414成员的投影。');
  const game = room.game, current = list(room.players), saved = list(room.matchPlayers), known = [...current, ...saved, ...list(room.resultParticipants).map(player => ({ id: player.playerId, name: player.name }))];
  const name = id => known.find(player => player.id === id)?.name || '已离席伙伴';
  const score = scoreData(scorePacket, room), selfRole = room.selfRole;
  const players = (game ? list(game.players) : current).map(player => {
    const member = current.find(entry => entry.id === player.id);
    // Even a malformed player projection cannot leak another hand through this mapper.
    const hand = selfRole === 'spectator' || player.id === room.selfId ? cards(player.hand) : [];
    return { id: player.id, name: name(player.id), ready: member?.ready === true,
      connected: member?.connected === true, count: game ? player.handCount ?? hand.length : 0, hand,
      total: score.totals.get(player.id) ?? null, present: !!member };
  });
  const rawOrder = game?.actionOrder ?? players.map(player => player.id);
  const actualOrder = list(rawOrder).filter(id => players.some(player => player.id === id));
  const own = actualOrder.indexOf(room.selfId);
  // Keep the true next-player relation while placing this player at the end.
  const actionOrder = own >= 0 ? [...actualOrder.slice(own + 1), ...actualOrder.slice(0, own + 1)] : actualOrder;
  const chains = new Map();
  for (const move of list(game?.moves)) {
    const group = chains.get(move.rootId) || { id: move.rootId, cards: [] };
    group.cards.push(...cards(move.cardIds)); group.ownerId = move.playerId;
    group.label = `${name(move.playerId)} · ${poker414PatternLabel(classifyPattern(group.cards.map(card => card.id)))}`;
    chains.set(move.rootId, group);
  }
  const target = game?.target ? { ...game.target, cards: cards(game.target.cardIds),
    label: `${name(game.target.ownerId)} · ${poker414PatternLabel(game.target.pattern)}` } : null;
  const result = game?.result ?? null;
  const settlement = score.settlement?.settlementVersion === result?.settlementVersion ? score.settlement : null;
  const balancesAfter = new Map(list(settlement?.balancesAfter).map(player => [player.playerId, player.total]));
  const resultRows = list(result?.deltas).map(delta => ({ playerId: delta.playerId, name: name(delta.playerId),
    delta: delta.points, balanceAfter: Number.isSafeInteger(balancesAfter.get(delta.playerId)) ? balancesAfter.get(delta.playerId) : null }));
  const scoreConfirmed = resultRows.length > 0 && resultRows.every(player => player.balanceAfter !== null);
  const phase = room.phase === 'playing' && game?.stage === 'dealing' ? 'dealing' : room.phase;
  const active = phase === 'playing' || phase === 'dealing', self = current.find(player => player.id === room.selfId);
  const enabled = canAct === true && connection === 'online' && !pending;
  return { roomCode: room.roomCode, roomId: room.roomId, revision: room.revision, matchId: room.matchId,
    phase, selfId: room.selfId, selfRole, hostId: room.hostId, players, spectators: list(room.spectators).map(player => ({ ...player })),
    seatOrder: game?.seatOrder ?? current.map(player => player.id), actionOrder,
    firstPlayerId: game?.firstPlayerId ?? null, turnPlayerId: game?.turnPlayerId ?? null,
    hand: selfRole === 'player' ? players.find(player => player.id === room.selfId)?.hand ?? [] : [],
    publicGroups: [...chains.values()], target, targetOwnerId: game?.target?.ownerId ?? null,
    response: game?.responseWindow ? { ...game.responseWindow } : null,
    roundId: game?.roundId ?? null, eventSeq: game?.eventSeq ?? 0, undealtCards: game?.deckCount ?? 108,
    serverTime: room.serverTime ?? null, connection, pending, canAct: enabled,
    canReady: enabled && phase === 'waiting' && selfRole === 'player', ready: self?.ready === true,
    canStart: enabled && phase === 'waiting' && room.hostId === room.selfId && current.length >= 3 && current.every(player => player.ready),
    canChangeRole: enabled && phase === 'waiting' && (selfRole === 'spectator' ? current.length < 8 : room.hostId !== room.selfId && list(room.spectators).length < (room.spectatorCapacity ?? 8)),
    canRematch: enabled && ['finished', 'aborted'].includes(phase) && room.hostId === room.selfId,
    transferCandidates: selfRole === 'player' && room.hostId === room.selfId ? current.filter(player => player.id !== room.selfId)
      .map(player => ({ id: player.id, name: player.name })) : [],
    canTakeOver: enabled && room.hostCanTakeOver === true, scoresReadAt: score.readAt,
    result: resultRows, resultRows, scoreConfirmed,
    resultTitle: result?.reason === 'emptied-hand' ? `${name(result.winnerId)}先出完了！`
      : result?.reason === 'voluntary-leave' ? `${name(result.responsiblePlayerId)}离开了，本局结束` : '本局已结束',
    resultNote: result?.reason === 'voluntary-leave' ? `离席者向其他参赛者每人赔5分。${scoreConfirmed ? '本局积分已保存。' : '正在核对已保存积分。'}`
      : scoreConfirmed ? '本局积分已保存，下列累计为本局结算时点。' : '本局已结束，正在核对已保存积分。',
    cancellationNote: room.lastMatchResult ? cancellation(room.lastMatchResult.reason) : '',
    leaveDescription: active && selfRole === 'player' ? `现在退出会结束本局，你扣${5 * (players.length - 1)}分，其他${players.length - 1}位参赛者各得5分。确认保存后才离开。`
      : '退出后可通过房间号再次加入，不扣分。',
    summaryText: resultRows.map(player => `${player.name} ${signed(player.delta)}`).join('，'),
  };
}

export function poker414Selection(view, selectedIds = [], { now = Date.now(), includeChoices = true } = {}) {
  const handIds = list(view?.hand).map(card => card.id), ids = [...selectedIds];
  const validSelection = new Set(ids).size === ids.length && ids.every(id => handIds.includes(id));
  const pattern = validSelection ? classifyPattern(ids) : null;
  const targetPattern = view?.target?.pattern ?? (view?.target ? classifyPattern(view.target.cards.map(card => card.id)) : null);
  const playing = view?.phase === 'playing' && view?.selfRole === 'player';
  const ownTurn = playing && view.turnPlayerId === view.selfId;
  const enabled = view?.canAct !== false && !view?.pending && (!view?.connection || view.connection === 'online');
  const choices = ownTurn && includeChoices ? enumerateLegalPlays(handIds, targetPattern) : [];
  const legal = !!pattern && beatsPattern(pattern, targetPattern);
  const response = view?.response;
  const responseRank = response?.rank ?? targetPattern?.rank;
  const available = playing && enabled && response && now < response.deadlineAt && view.targetOwnerId !== view.selfId;
  const canRespond = !!available && Number.isInteger(responseRank) && responseRank >= 3 && responseRank <= 15 && ['hook', 'fork'].includes(response.action) && !!chooseResponseCards(handIds, responseRank, response.action);
  let hint = ids.length ? !validSelection ? '选中的牌已改变，请重新选择。' : !pattern ? '这些牌不能组成合法牌型。'
    : !legal ? `${poker414PatternLabel(pattern)}不能压过当前目标。` : `${poker414PatternLabel(pattern)} · ${ids.length}张`
    : choices.length === 1 && ownTurn ? '只有一种可出牌型，确认选牌后出牌。'
      : ownTurn && includeChoices && choices.length === 0 ? '没有可压过的牌，可以选择不出。' : '点选上提，再点取消';
  if (view?.pending) hint = '正在核对原操作；结果未确认前不重复出牌。';
  return { ownTurn, pattern, choices, uniqueChoice: choices.length === 1 ? [...choices[0].cardIds] : null,
    canPlay: enabled && ownTurn && legal, canPass: enabled && ownTurn && !!view.target,
    canHook: canRespond && response.action === 'hook', canFork: canRespond && response.action === 'fork', hint };
}
