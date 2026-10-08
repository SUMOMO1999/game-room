import { createHmac, timingSafeEqual } from 'node:crypto';
import { RoomError } from '../app/rooms.mjs';
import { defaultGameRegistry } from '../app/game-registry.mjs';

export const HISTORY_RETENTION_DAYS = 180;
export const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const CURSOR_LIFETIME_MS = 15 * 60 * 1000;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const fields = new Set(['matchId', 'roomId', 'roomCode', 'game', 'ruleVersion', 'startedAt', 'endedAt', 'status', 'reason', 'players', 'legacy']);
const playerFields = new Set(['userKey', 'seatId', 'nickname', 'outcome', 'remainingPoints']);
const order = (a, b) => b.endedAt - a.endedAt || b.matchId.localeCompare(a.matchId);
const fail = (code, message = '战绩暂时无法读取，请稍后重试。', status = 503) => { throw new RoomError(status, code, message); };
const text = (value, max) => typeof value === 'string' && value === value.normalize('NFC').trim()
  && [...value].length > 0 && [...value].length <= max && !/\p{Cc}/u.test(value);

/** Server-only archival contract. Reject extra fields so private racks cannot enter a summary. */
export function validateMatchSummary(summary, { gameRegistry = defaultGameRegistry } = {}) {
  let adapter;
  try { adapter = gameRegistry.gameAdapter(summary?.game); }
  catch { throw new Error('Invalid match history summary'); }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)
      || Object.keys(summary).some((key) => !fields.has(key))
      || !HEX32.test(summary.matchId ?? '') || !HEX32.test(summary.roomId ?? '') || !/^\d{6}$/.test(summary.roomCode ?? '')
      || summary.game !== adapter.gameType || !adapter.ruleVersions.includes(summary.ruleVersion)
      || summary.legacy !== undefined && typeof summary.legacy !== 'boolean'
      || (summary.legacy === true ? summary.startedAt !== null : !Number.isSafeInteger(summary.startedAt) || summary.startedAt < 0)
      || !Number.isSafeInteger(summary.endedAt) || summary.endedAt < 0
      || summary.startedAt !== null && summary.endedAt < summary.startedAt || summary.endedAt > Number.MAX_SAFE_INTEGER - HISTORY_RETENTION_MS
      || !['completed', 'aborted'].includes(summary.status) || !text(summary.reason, 80)
      || !Array.isArray(summary.players) || summary.players.length < adapter.minPlayers || summary.players.length > adapter.maxPlayers
      || new Set(summary.players.map((player) => player?.userKey)).size !== summary.players.length
      || new Set(summary.players.map((player) => player?.seatId)).size !== summary.players.length
      || summary.players.some((player) => !player || typeof player !== 'object' || Array.isArray(player)
        || Object.keys(player).some((key) => !playerFields.has(key) && !adapter.historyPlayerFields?.includes(key))
        || !HEX64.test(player.userKey ?? '') || !HEX32.test(player.seatId ?? '') || !text(player.nickname, 16)
        || !['win', 'draw', 'loss', 'unscored'].includes(player.outcome)
        || adapter.historyPlayerProblem(summary.status, player))) {
    throw new Error('Invalid match history summary');
  }
  if (summary.status === 'completed') {
    const wins = summary.players.filter((player) => player.outcome === 'win').length;
    const draws = summary.players.filter((player) => player.outcome === 'draw').length;
    if (adapter.historyOutcomeProblem(wins, draws, summary.players.length)) throw new Error('Invalid match outcome');
  }
  return summary;
}

export function validateHistoryRecord(value, options) {
  if (![1, 2].includes(value?.schemaVersion) || Object.keys(value).some((key) => !['schemaVersion', 'summary'].includes(key))) throw new Error('Invalid history record');
  validateMatchSummary(value.summary, options);
  if (value.schemaVersion !== ((options?.gameRegistry || defaultGameRegistry).gameAdapter(value.summary.game).historySchemaVersion ?? 1)) throw new Error('Invalid history record version');
  return value;
}

export function validateHistoryIndex(value) {
  if (value?.schemaVersion !== 1 || !HEX64.test(value.userKey ?? '')
      || Object.keys(value).some((key) => !['schemaVersion', 'userKey', 'entries'].includes(key))
      || !Array.isArray(value.entries) || new Set(value.entries.map((entry) => entry?.matchId)).size !== value.entries.length
      || value.entries.some((entry) => !entry || Object.keys(entry).some((key) => !['matchId', 'endedAt'].includes(key))
        || !HEX32.test(entry.matchId ?? '') || !Number.isSafeInteger(entry.endedAt) || entry.endedAt < 0
        || entry.endedAt > Number.MAX_SAFE_INTEGER - HISTORY_RETENTION_MS)) throw new Error('Invalid history index');
  return value;
}

export function historyQuery(params) {
  for (const key of params.keys()) if (!['limit', 'cursor'].includes(key) || params.getAll(key).length !== 1) fail('INVALID_HISTORY_QUERY', '战绩分页参数无效。', 400);
  const rawLimit = params.get('limit');
  if (rawLimit !== null && !/^(?:[1-9]|[12]\d|30)$/.test(rawLimit)) fail('INVALID_HISTORY_QUERY', '每页可查看1～30局。', 400);
  const cursor = params.get('cursor');
  if (cursor !== null && (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512)) fail('INVALID_HISTORY_QUERY', '战绩分页已失效，请重新打开。', 400);
  return { limit: rawLimit === null ? 30 : Number(rawLimit), ...(cursor === null ? {} : { cursor }) };
}

/** Only call from a committed room outbox. Partial index writes are repaired by replaying the same match. */
export function createMatchHistory({ storage, now = Date.now, maxCasAttempts = 100, gameRegistry = defaultGameRegistry } = {}) {
  if (!storage?.read || !storage?.replaceCAS || !storage?.putIfAbsent || !Buffer.isBuffer(storage.key)
      || !Number.isSafeInteger(maxCasAttempts) || maxCasAttempts < 1) throw new TypeError('History requires atomic encrypted storage.');
  const signature = (userKey, payload) => createHmac('sha256', storage.key).update('game-room-history-cursor:v1\0').update(userKey).update('\0').update(payload).digest('base64url');
  function encodeCursor(userKey, entry) {
    const payload = Buffer.from(JSON.stringify({ v: 1, endedAt: entry.endedAt, matchId: entry.matchId, until: now() + CURSOR_LIFETIME_MS })).toString('base64url');
    return `${payload}.${signature(userKey, payload)}`;
  }
  function decodeCursor(userKey, cursor) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const [payload, mac] = cursor.split('.'), expected = signature(userKey, payload);
      if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new Error();
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (value.v !== 1 || !HEX32.test(value.matchId ?? '') || !Number.isSafeInteger(value.endedAt)
          || !Number.isSafeInteger(value.until) || value.until <= now()) throw new Error();
      return value;
    } catch { fail('INVALID_HISTORY_CURSOR', '战绩分页已失效，请重新打开。', 400); }
  }
  async function archive(input) {
    validateMatchSummary(input, { gameRegistry });
    const summary = structuredClone(input), expiresAt = summary.endedAt + HISTORY_RETENTION_MS;
    // Replaying an expired outbox acknowledges it without resurrecting its record or retention period.
    if (expiresAt <= now()) return { matchId: summary.matchId, expired: true };
    if (summary.endedAt > now()) throw new Error('Match cannot end in the future');
    await storage.putIfAbsent('game-history', summary.matchId, { schemaVersion: gameRegistry.gameAdapter(summary.game).historySchemaVersion ?? 1, summary }, expiresAt);
    const archived = await storage.read('game-history', summary.matchId);
    if (!archived || archived.expiresAt !== expiresAt) fail('HISTORY_CORRUPT');
    validateHistoryRecord(archived.value, { gameRegistry });
    // Canonical fixed-field serialization avoids treating harmless object key order as a different result.
    const canonical = (value) => JSON.stringify([value.matchId, value.roomId, value.roomCode, value.game, value.ruleVersion,
      value.startedAt, value.endedAt, value.status, value.reason, !!value.legacy, value.players.map((player) =>
        [player.userKey, player.seatId, player.nickname, player.outcome, player.remainingPoints, player.score, player.rank])]);
    if (canonical(archived.value.summary) !== canonical(summary)) fail('HISTORY_CONFLICT');
    for (const player of summary.players) {
      let saved = false;
      for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
        const previous = await storage.read('history-index', player.userKey);
        if (previous) { validateHistoryIndex(previous.value); if (previous.value.userKey !== player.userKey) fail('HISTORY_CORRUPT'); }
        const entries = (previous?.value.entries ?? []).filter((entry) => entry.endedAt + HISTORY_RETENTION_MS > now());
        if (entries.some((entry) => entry.matchId === summary.matchId)) { saved = true; break; }
        entries.push({ matchId: summary.matchId, endedAt: summary.endedAt }); entries.sort(order);
        const value = { schemaVersion: 1, userKey: player.userKey, entries };
        const indexExpiresAt = Math.max(...entries.map((entry) => entry.endedAt + HISTORY_RETENTION_MS));
        if (previous ? await storage.replaceCAS('history-index', player.userKey, previous.version, value, indexExpiresAt)
          : await storage.putIfAbsent('history-index', player.userKey, value, indexExpiresAt)) { saved = true; break; }
      }
      if (!saved) fail('HISTORY_BUSY');
    }
    return { matchId: summary.matchId, archived: true };
  }
  async function get(userKey, query = {}) {
    if (!HEX64.test(userKey ?? '')) fail('INVALID_IDENTITY', '请重新登录棋牌。', 401);
    if (Object.keys(query).some((key) => !['limit', 'cursor'].includes(key))
        || query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 30)) fail('INVALID_HISTORY_QUERY', '战绩分页参数无效。', 400);
    const limit = query.limit ?? 30, before = query.cursor === undefined ? null : decodeCursor(userKey, query.cursor);
    const index = await storage.read('history-index', userKey);
    if (index) { validateHistoryIndex(index.value); if (index.value.userKey !== userKey) fail('HISTORY_CORRUPT'); }
    const summaries = [];
    for (const entry of (index?.value.entries ?? []).filter((value) => value.endedAt + HISTORY_RETENTION_MS > now()).sort(order)) {
      const record = await storage.read('game-history', entry.matchId);
      if (!record) { if (entry.endedAt + HISTORY_RETENTION_MS <= now()) continue; fail('HISTORY_CORRUPT'); }
      validateHistoryRecord(record.value, { gameRegistry });
      const summary = record.value.summary;
      if (summary.matchId !== entry.matchId || summary.endedAt !== entry.endedAt || record.expiresAt !== summary.endedAt + HISTORY_RETENTION_MS
          || !summary.players.some((player) => player.userKey === userKey)) fail('HISTORY_CORRUPT');
      summaries.push(summary);
    }
    const stats = { completed: 0, wins: 0, draws: 0, losses: 0, aborted: 0, periodDays: HISTORY_RETENTION_DAYS };
    for (const summary of summaries) {
      if (summary.status === 'aborted') { stats.aborted++; continue; }
      stats.completed++;
      const outcome = summary.players.find((player) => player.userKey === userKey).outcome;
      const stat = { win: 'wins', draw: 'draws', loss: 'losses' }[outcome];
      if (stat) stats[stat]++;
    }
    const remaining = before ? summaries.filter((summary) => order(summary, before) > 0) : summaries;
    const page = remaining.slice(0, limit);
    const items = page.map((summary) => {
      const self = summary.players.find((player) => player.userKey === userKey);
      const extra = player => Object.fromEntries((gameRegistry.gameAdapter(summary.game).historyPlayerFields || [])
        .filter(field => Object.hasOwn(player, field)).map(field => [field, player[field]]));
      return { matchId: summary.matchId, roomCode: summary.roomCode, game: summary.game, ruleVersion: summary.ruleVersion,
        startedAt: summary.startedAt, endedAt: summary.endedAt, status: summary.status, reason: summary.reason,
        ...(summary.legacy ? { legacy: true } : {}),
        self: { outcome: self.outcome, remainingPoints: self.remainingPoints, ...extra(self) },
        players: summary.players.map(player => ({ nickname: player.nickname, outcome: player.outcome, remainingPoints: player.remainingPoints, ...extra(player) })) };
    });
    return { items, nextCursor: remaining.length > limit ? encodeCursor(userKey, page.at(-1)) : null,
      stats, retentionDays: HISTORY_RETENTION_DAYS };
  }
  return { archive, get };
}
