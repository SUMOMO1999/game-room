/** S1 only: synthetic actions exercise the real platform. Never register or publish this as a playable engine. */
import { CARDS, createDeck, CONTENT_VERSION, DIGITAL_RULE_VERSION } from '../content/definitions.mjs';
import { createHyakkiTiming, openHyakkiDecision, closeHyakkiDecision, transitionHyakkiLifecycle,
  hyakkiCommonActionProblem, changeHyakkiPause, hyakkiGameClock, hyakkiRetentionDeadline, hyakkiTimingProblem } from '../lifecycle.mjs';
import { createHyakkiEventStore } from '../../../../server/games/hyakki-trading/event-store.mjs';
const GAME_TYPE = 'hyakki-trading', clone = value => structuredClone(value);
const failure = error => ({ ok: false, error });
const allCopies = new Set(createDeck().map(card => card.id));
const cardIds = new Set(CARDS.map(card => card.id));
function record(state, events, now) {
  state.revision++; state.publicEventSequence++; state.lastPublicEvents = events; state.committedAt = now;
  return state;
}
function lifecycle(game, context) {
  const change = transitionHyakkiLifecycle(game, context);
  if (change.ok && change.changed && !change.checkpointOnly) {
    // Supplementary absence evidence while already capacity-suspended consumes
    // no additional public history budget. It still persists with the room CAS.
    if (!change.terminal && game.lifecycle.capacity && change.state.lifecycle.capacity) return change;
    const events = change.terminal ? [{ type: 'match-ended', reason: change.state.result.reason, winnerSeatId: change.state.result.winnerIds[0] ?? null }]
      : change.state.lifecycle.capacity && !game.lifecycle.capacity ? [{ type: 'suspended', reason: 'capacity' }]
        : change.roomPhase === 'playing' || game.lifecycle.capacity && !change.state.lifecycle.capacity ? [{ type: 'resumed' }]
          : [{ type: 'suspended', reason: context.reason === 'server-recovery' ? 'server-recovery' : 'disconnected' }];
    record(change.state, events, context.now);
  }
  return change;
}
function projection(game, playerId = null) {
  return { gameType: GAME_TYPE, ruleVersion: game.ruleVersion, contentVersion: game.contentVersion, status: game.status,
    revision: game.revision, turnPlayerId: game.turnPlayerId, round: game.round, result: clone(game.result),
    publicEventSequence: game.publicEventSequence, poolCount: game.deck.length,
    players: game.players.map(player => ({ id: player.id, silver: player.silver, handCount: player.hand.length })),
    ...(playerId ? { hand: clone(game.players.find(player => player.id === playerId).hand) } : {}),
    pending: game.pending ? { id: game.pending.id, actorId: game.pending.actorId,
      ...(game.pending.actorId === playerId ? { candidate: clone(game.pending.candidate), paid: game.pending.paid } : {}) } : null };
}
function stateProblem(game) {
  if (!game || game.ruleVersion !== DIGITAL_RULE_VERSION || game.contentVersion !== CONTENT_VERSION
      || !['playing', 'finished', 'aborted'].includes(game.status) || !Number.isSafeInteger(game.revision) || game.revision < 0
      || !Number.isSafeInteger(game.publicEventSequence) || game.publicEventSequence < 1
      || !Number.isSafeInteger(game.committedAt) || !Array.isArray(game.players) || game.players.length !== 2) return '测试合同状态无效。';
  const timeProblem = hyakkiTimingProblem(game); if (timeProblem) return timeProblem;
  const cards = [...game.deck, ...game.discard, ...game.players.flatMap(player => player.hand), ...(game.pending?.candidate ? [game.pending.candidate] : [])];
  if (cards.length !== 110 || new Set(cards.map(card => card.id)).size !== 110
      || cards.some(card => !allCopies.has(card.id) || !cardIds.has(card.definitionId) || !card.id.startsWith(card.definitionId + '#'))
      || game.players.some(player => !Number.isSafeInteger(player.silver) || player.silver < 0)) return '110张实体牌或银两不守恒。';
  return null;
}
export function createHyakkiContractAdapter({ maxSnapshotBytes = 256 * 1024 } = {}) {
  return {
    gameType: GAME_TYPE, minPlayers: 2, maxPlayers: 2, ruleVersions: [DIGITAL_RULE_VERSION], usesActionIntents: true,
    actionTypes: ['probe-peek', 'probe-response', 'probe-resolve', 'probe-step'], configurationFields: [],
    usesPresenceLifecycle: true, maxSnapshotBytes,
    createGame(players, options) {
      const deck = clone(createDeck());
      return { ruleVersion: DIGITAL_RULE_VERSION, contentVersion: CONTENT_VERSION, revision: 0,
        players: players.map(player => ({ id: player.id, silver: 20, hand: deck.splice(0, 5) })), deck, discard: [], pending: null,
        status: 'playing', result: null, round: 1, turnIndex: 0, turnPlayerId: players[0].id,
        ...createHyakkiTiming(players.map(player => player.id), players[0].id, options.now, options.presence),
        publicEventSequence: 1, lastPublicEvents: [{ type: 'match-started' }], committedAt: options.now };
    },
    gameOptions: (_room, options) => options, roomDefaults: () => ({ turnClock: null }), playersChanged() {},
    actionFields: type => type.startsWith('probe-') ? [] : null, validateAction: () => null,
    configurationSupportProblem: () => ({ status: 400, code: 'PROBE_ONLY', message: '合同测试不支持配置。' }), configure: () => ({}),
    roomView: () => ({ exitPolicy: 'resign' }), privateView: projection, spectatorView: game => projection(game),
    playerSummary: (view, id) => ({ handCount: view?.players.find(player => player.id === id)?.handCount ?? 0 }),
    playerResult: (result, id) => ({ outcome: result?.winnerIds?.length ? result.winnerIds.includes(id) ? 'win' : 'loss' : 'unscored', remainingPoints: null }),
    historyPlayerProblem: (status, player) => player.remainingPoints !== null || (status === 'completed' ? !['win', 'loss'].includes(player.outcome) : player.outcome !== 'unscored'),
    historyOutcomeProblem: (wins, draws, count) => wins !== 1 || draws !== 0 || count !== 2,
    stateProblem, snapshotSchema: () => 12,
    snapshotProblem: data => data.schemaVersion !== 12 || data.gameType !== GAME_TYPE,
    roomStateProblem(room) {
      if (!room.game) return room.phase !== 'waiting' || room.turnClock !== null ? '等待房间时钟无效。' : null;
      const issue = stateProblem(room.game); if (issue) return issue;
      if (room.matchStartedAt !== room.game.lifecycle.startedAt || room.matchParticipants?.length !== 2
          || room.matchParticipants.some((entry, index) => entry.playerId !== room.game.players[index].id)) return '冻结名单不一致。';
      const expected = hyakkiGameClock(room.game);
      const wanted = expected ? { version: 4, kind: expected.kind, id: expected.id, deadlineAt: expected.deadlineAt,
        remainingMs: expected.remainingMs, paused: expected.paused, label: expected.label, matchId: room.matchId } : null;
      if (JSON.stringify(room.turnClock) !== JSON.stringify(wanted)) return '房间与游戏时钟不一致。';
      if (expected && expected.paused !== (room.phase === 'paused')) return '挂起阶段不一致。';
      return null;
    },
    gameStatusForRoomPhase: phase => ['finished', 'aborted'].includes(phase) ? phase : 'playing',
    turnTimeoutMs: () => 0, gameClock: hyakkiGameClock, roomRetentionDeadline: hyakkiRetentionDeadline,
    commonActionProblem: (room, _id, action, context) => {
      const issue = hyakkiCommonActionProblem(room.game, action, context);
      return issue ? { status: 409, code: 'GAME_HELD', message: issue } : null;
    },
    onPhaseChanged(game, phase, now, context) {
      const change = changeHyakkiPause(game, phase, now, context);
      if (change.ok && JSON.stringify(change.state) !== JSON.stringify(game)) record(change.state, [{ type: phase === 'paused' ? 'paused' : 'resumed' }], now);
      return change;
    },
    lifecycleTransition: lifecycle,
    actionDeadline(room, action) {
      if (!room.game || room.game.status !== 'playing') return null;
      const life = room.game.lifecycle;
      const dates = [life.manual?.deadlineAt, life.absence?.deadlineAt,
        action.type.startsWith('probe-') ? hyakkiGameClock(room.game)?.deadlineAt : null].filter(Number.isSafeInteger);
      return dates.length ? Math.min(...dates) : null;
    },
    applyGameAction(game, actorId, action, { now }) {
      let next = clone(game);
      if (action.type === 'probe-step') {
        if (actorId !== game.turnPlayerId || game.pending) return failure('步骤已改变。');
        record(next, [{ type: 'draw-finished', actorSeatId: actorId }], now);
      } else if (['probe-peek', 'probe-response'].includes(action.type)) {
        if (actorId !== game.turnPlayerId || game.pending) return failure('步骤已改变。');
        const responder = action.type === 'probe-response';
        if (responder) {
          const choice = openHyakkiDecision(next, { id: `decision-${next.revision}`, actorId: next.players[1].id, label: '对方选牌', now });
          if (!choice.ok) return choice; next = choice.state; next.players[0].silver -= 2;
        }
        next.pending = { id: `pending-${next.revision}`, actorId: responder ? next.players[1].id : actorId,
          candidate: next.deck.shift(), paid: responder };
        record(next, [{ type: 'draw-peeked', actorSeatId: actorId }], now);
      } else if (action.type === 'probe-resolve') {
        if (next.pending?.actorId !== actorId) return failure('只有待选玩家可以确认。');
        next.players.find(player => player.id === actorId).hand.push(next.pending.candidate); next.pending = null;
        if (next.timing.decision) next = closeHyakkiDecision(next, now).state;
        record(next, [{ type: 'choice-resolved', actorSeatId: actorId }], now);
      } else return failure('未知的合同测试操作。');
      return { ok: true, state: next };
    },
    supportsTimeout: () => true,
    applyTimeout(game, _actorId, context = {}) {
      // Synthetic timeout explicitly discards; never trades or awards money.
      const now = context.now ?? hyakkiGameClock(game).deadlineAt;
      let next = clone(game);
      if (next.pending) { next.discard.push(next.pending.candidate); next.pending = null; }
      if (next.timing.decision) next = closeHyakkiDecision(next, now).state;
      else next.timing.active.deadlineAt = now + next.timing.active.remainingMs;
      record(next, [{ type: 'draw-finished', actorSeatId: game.turnPlayerId }], now);
      return { ok: true, state: next };
    },
    describeAction: () => '合同测试步骤已确认。', describeTimeout: () => '合同测试选择已关闭。',
  };
}

export function createHyakkiContractPreparers(storage, { now = Date.now, capacityBytes } = {}) {
  const store = createHyakkiEventStore({ storage, now, ...(capacityBytes === undefined ? {} : { capacityBytes }) });
  return new Map([[GAME_TYPE, store.transitionPreparer(({ previous, next }) => {
    const room = next?.snapshot, before = previous?.snapshot;
    if (!room?.game) {
      // Generic room expiry writes a tombstone. Its server-generated summary
      // is the terminal transition; commit that final event in the SAME CAS.
      const ended = next?.pendingRecords?.find(summary => summary.matchId === before?.matchId);
      if (!before?.game || before.game.status !== 'playing' || !ended) return null;
      return { match: { roomId: before.roomId, matchId: before.matchId, ruleVersion: before.game.ruleVersion,
        contentVersion: before.game.contentVersion, startedAt: before.matchStartedAt,
        participants: before.matchParticipants.map(player => ({ seatId: player.playerId, userKey: player.userKey })) },
        sequence: before.game.publicEventSequence + 1, commitId: `${before.matchId}-${before.game.publicEventSequence + 1}`,
        committedAt: ended.endedAt, mode: 'terminal', events: [{ type: 'match-ended', reason: ended.reason,
          winnerSeatId: ended.players.find(player => player.outcome === 'win')?.seatId ?? null }] };
    }
    if (room.game.publicEventSequence === before?.game?.publicEventSequence && room.matchId === before?.matchId) return null;
    const game = room.game;
    return { match: { roomId: room.roomId, matchId: room.matchId, ruleVersion: game.ruleVersion, contentVersion: game.contentVersion,
      startedAt: room.matchStartedAt, participants: room.matchParticipants.map(player => ({ seatId: player.playerId, userKey: player.userKey })) },
      sequence: game.publicEventSequence, commitId: `${room.matchId}-${game.publicEventSequence}`, committedAt: game.committedAt,
      mode: ['finished', 'aborted'].includes(game.status) ? 'terminal' : game.lifecycle.capacity && !before?.game?.lifecycle.capacity ? 'capacity'
        : !game.lifecycle.capacity && before?.game?.lifecycle.capacity ? 'resume' : 'normal', events: game.lastPublicEvents };
  })]]);
}
