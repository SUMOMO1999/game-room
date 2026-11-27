import { newMatch, defaults, settings, applyMove, viewFor, step, dueAt } from '../../../app/games/last-hand/rules/match.mjs';
import { version, phaseMs } from '../../../app/games/last-hand/rules/table.mjs';
import { opponent } from '../../../app/games/last-hand/rules/opponent.mjs';
import { items } from '../../../app/games/last-hand/rules/catalog.mjs';
import { interactionProblem } from '../../../app/games/last-hand/rules/interactions.mjs';
export const gameType = 'last-hand';
const invalid = (message) => ({ status: 400, code: 'INVALID_ACTION', message });
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const previousHealthChoices = [3, 5, 8, 10, 12, 16, 20];
function needsNewSnapshot(room) {
  const health = room.tableOptions?.health ?? room.game?.settings?.health;
  return room.game?.scoreOnly === true || room.game?.interactionVersion === 1 ||
    (health != null && !previousHealthChoices.includes(health));
}
const fields = {
  avatar: ['ego'],
  eventPick:['slot'], eventTarget:['target'], eventPlay:['choice'],
  pick: ['item'],
  light: [],
  ledger: [],
  seal: ['kind', 'silver', 'gold', 'card', 'item'],
  peek: ['card'],
  submit: ['ids'],
  attack: ['target'],
  effect: ['item', 'card', 'second', 'rank', 'suit', 'other'],
};
function validate(a) {
  if (a.type !== 'tableMove') return null;
  const m = a.move;
  if (
    !/^[a-f0-9]{32}$/.test(a.matchId) ||
    !integer(a.seatRevision) ||
    !m ||
    typeof m.type !== 'string' ||
    !Object.hasOwn(fields, m.type) ||
    Object.keys(m).some((k) => k !== 'type' && !fields[m.type].includes(k))
  )
    return invalid('无效的牌桌操作');
  if (m.type === 'eventPick' && (!integer(m.slot) || m.slot > 2) ||
      m.type === 'eventTarget' && (typeof m.target !== 'string' || m.target.length > 128) ||
      m.type === 'eventPlay' && (typeof m.choice !== 'string' || m.choice.length > 128))
    return invalid('互动选择无效');
  if (
    m.ids !== undefined &&
    (!Array.isArray(m.ids) ||
      m.ids.length > 5 ||
      !m.ids.every((x) => typeof x === 'string' && x.length <= 32))
  )
    return invalid('主手选择无效');
  return null;
}
function tableState(saved) {
  if (!saved.seats) return saved;
  const { seats, ...rest } = saved;
  return { ...rest, players: seats };
}
function roomState(table) {
  const { players: seats, ...rest } = table;
  return { ...rest, seats, players: seats.filter((p) => !p.bot).map(({ id, name }) => ({ id, name })) };
}
function wrapResult(result) {
  return result.state ? { ...result, state: roomState(result.state) } : result;
}
export function stateProblem(saved) {
  const g = saved && tableState(saved);
  if (
    !g ||
    g.ruleVersion !== version ||
    (g.scoreOnly !== undefined && (g.scoreOnly !== true || g.settings?.mode !== 'score' ||
      ['attack','hit'].includes(g.phase) || g.attacker != null || g.hit != null || g.protected != null)) ||
    !integer(g.epoch) ||
    !integer(g.seq) ||
    !integer(g.rng) ||
    !Object.hasOwn(phaseMs, g.phase) ||
    !Array.isArray(g.players) ||
    g.players.length < 2 ||
    g.players.length > 6 ||
    g.settings?.seats !== g.players.length ||
    new Set(g.players.map((p) => p.id)).size !== g.players.length
  )
    return '存档中的牌桌结构无效';
  try {
    settings(g.settings, g.settings.health);
  } catch {
    return '存档中的设置无效';
  }
  if (g.settings.matchMinutes ? !integer(g.matchDeadline) : g.matchDeadline != null)
    return '整桌结束时间无效';
  if (g.pausedAt != null && !integer(g.pausedAt)) return '暂停时间无效';
  if (g.battleEndHp !== undefined && (g.phase !== 'growth' || !Array.isArray(g.battleEndHp) ||
      g.battleEndHp.length !== g.players.length || !g.battleEndHp.every(integer)))
    return '战末生命记录无效';
  if (
    g.players.some(
      (p) =>
        ![p.revision, p.gold, p.silver, p.bank, p.score, p.hp, p.maxHp].every(integer) ||
        p.hp > p.maxHp ||
        ![p.eventAttack ?? 0,p.eventShield ?? 0].every(n => integer(n) && n <= 2) ||
        !Array.isArray(p.hand) ||
        p.hand.length > 12 ||
        !Array.isArray(p.relics) ||
        !Array.isArray(p.tools) ||
        p.relics.some((id) => items[id]?.kind !== 'relic') ||
        p.tools.some((id) => items[id]?.kind !== 'tool') ||
        (p.boosts !== undefined &&
          (!Array.isArray(p.boosts) ||
            p.boosts.some((id) => items['once-' + id]?.duration !== 'battle') ||
            new Set(p.boosts).size !== p.boosts.length)),
    )
  )
    return '席位资源无效';
  if (
    g.status === 'finished'
      ? g.phase !== 'finish' || !g.result?.winnerIds?.length || g.deadline !== null
      : g.status !== 'playing' || !integer(g.deadline)
  )
    return '对局阶段无效';
  return interactionProblem(g);
}
export const adapter = {
  gameType,
  allowsSolo: true,
  minPlayers: 1,
  maxPlayers: 6,
  ruleVersions: [version],
  usesActionIntents: true,
  actionTypes: ['tableMove'],
  concurrentActionTypes: ['tableMove'],
  configurationFields: ['tableOptions'],
  roomDefaults: () => ({ tableOptions: { ...defaults } }),
  configurationSupportProblem: () => null,
  configure(room, a) {
    try {
      const s = settings(a.tableOptions, room.tableOptions?.health);
      if ((room.players?.length || 0) > s.seats) return { problem: invalid('已有玩家多于席数') };
      return { updates: { tableOptions: s }, text: '更新了竞拍牌桌设置' };
    } catch (e) {
      return { problem: invalid(e.message) };
    }
  },
  roomView: (r) => ({ tableOptions: r.tableOptions, pausedAt: r.game?.pausedAt ?? null }),
  participantLimits: (r) => ({
    waiting: { min: 1, max: r.tableOptions?.seats ?? 6 },
    playing: { min: 1, max: r.tableOptions?.seats ?? 6 },
  }),
  gameOptions: (r, c) => ({
    settings: r.tableOptions,
    previousHealth: r.tableOptions.health,
    seed: c.serverRandomInt(0x100000000),
    now: c.now,
    matchId: c.matchId,
  }),
  createGame: (p, c) => roomState(newMatch(p, c)),
  privateView: (g, id) => viewFor(tableState(g), id),
  spectatorView: (g) => viewFor(tableState(g), null),
  stateProblem,
  validateAction: validate,
  actionFields: (t) => (t === 'tableMove' ? ['matchId', 'seatRevision', 'move'] : null),
  applyGameAction: (g, id, a, ctx) => wrapResult(applyMove(tableState(g), id, a, ctx.now)),
  actionConcurrencyProblem: (r, id, a) =>
    r.matchId === a.matchId ? null : { status: 409, code: 'SEAT_CHANGED', message: '上一场已结束' },
  actionDeadline: (r, a) => (a.type === 'tableMove' ? r.game?.deadline : null),
  nextSystemStep: (g) =>
    g.status === 'playing'
      ? { matchId: g.matchId, seq: g.seq, epoch: g.epoch, deadline: dueAt(tableState(g)) }
      : null,
  applySystemStep: (g, s, c) => wrapResult(step(tableState(g), c.now, opponent)),
  describeSystemStep: () => null,
  onPhaseChanged(game, phase, now) {
    if (phase === 'paused' && game.pausedAt == null) return { ok: true, state: { ...game, pausedAt: now } };
    if (phase !== 'playing' || game.pausedAt == null) return { ok: true, state: game };
    const { pausedAt, ...state } = game;
    const elapsed = Math.max(0, now - pausedAt);
    for (const key of ['deadline', 'botAt', 'matchDeadline']) {
      if (state[key] != null) state[key] += elapsed;
    }
    return { ok: true, state };
  },
  playersChanged(r) {
    if (r.phase === 'waiting') for (const p of r.players) p.ready = false;
  },
  playerSummary: () => ({}),
  playerResult: (r, id) => ({
    outcome: !r ? 'unscored' : !r.winnerIds.includes(id) ? 'loss' : r.tie ? 'draw' : 'win',
    remainingPoints: null,
  }),
  historyPlayerProblem: (status, p) =>
    p.remainingPoints !== null ||
    !(status === 'completed' ? ['win', 'draw', 'loss'] : ['unscored']).includes(p.outcome),
  historyOutcomeProblem: (wins, draws, n) => n < 1 || n > 6 || wins > 1 || (wins && draws) || draws > n,
  describeAction: () => null,
  supportsTimeout: () => false,
  applyTimeout: () => ({ ok: false, error: '使用公共计时' }),
  describeTimeout: () => '',
  turnTimeoutMs: () => 0,
  snapshotSchema: room => needsNewSnapshot(room) ? 25 :
    room.tableOptions.sections > 4 || room.tableOptions.health > 10 || room.phase === 'paused' ? 24 : 23,
  snapshotProblem: (s) => ![23, 24, 25].includes(s.schemaVersion) || s.gameType !== gameType ||
    (s.schemaVersion === 25) !== needsNewSnapshot(s),
  roomStateProblem: (s, roles) =>
    !roles || !s.tableOptions || (s.game && s.game.matchId !== s.matchId) ? '房间与牌局不匹配' : null,
};
