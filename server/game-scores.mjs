import { createHash } from 'node:crypto';
import { recordKey, decryptStoredRecord } from './storage.mjs';

export const SCORE_SCOPES = Object.freeze({ ledger: 'game-score-ledger', balances: 'game-score-balances', meta: 'game-score-meta' });
export const SCORE_FOREVER = Number.MAX_SAFE_INTEGER;
export const SCORE_CAPACITY_BYTES = 256 * 1024 * 1024;
export const SCORE_LEDGER_MAX_BYTES = 16 * 1024;
const GROUP = '4a4', QUOTA_ID = '4a4:quota';
const HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, fields) => plain(value) && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : plain(value)
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const same = (left, right) => canonical(left) === canonical(right);
const text = (value, max = 80) => typeof value === 'string' && value === value.normalize('NFC').trim() && value.length > 0 && [...value].length <= max && !/\p{Cc}|\p{Cs}/u.test(value);
const matchId = id => `4a4:match:${id}`;
const balanceId = key => `4a4:${key}`;
const ledgerId = (id, version) => `4a4:${id}:${version}`;
const correctionKey = id => `4a4:correction:${id}`;
export class ScoreError extends Error {
  constructor(status, code, message) {
    super(message); this.name = 'ScoreError'; this.status = status; this.code = code;
  }
}
const fail = (code, message = '积分数据暂时无法确认，请稍后重试。', status = 503) => { throw new ScoreError(status, code, message); };
const demand = condition => { if (!condition) fail('SCORE_INVALID', '积分结算参数无效。', 400); };
const safeAdd = (left, right) => {
  const sum = BigInt(left) + BigInt(right);
  if (sum < BigInt(Number.MIN_SAFE_INTEGER) || sum > BigInt(Number.MAX_SAFE_INTEGER)) fail('SCORE_OVERFLOW');
  return Number(sum);
};
const pairFields = ['userKey', 'seatId'];
function validParticipants(value) {
  return Array.isArray(value) && value.length >= 3 && value.length <= 8
    && new Set(value.map(item => item?.userKey)).size === value.length
    && new Set(value.map(item => item?.seatId)).size === value.length
    && value.every(item => exact(item, pairFields) && HEX64.test(item.userKey) && HEX32.test(item.seatId));
}
function validDeltas(value, participants) {
  return Array.isArray(value) && value.length === participants.length && value.every((item, index) =>
    exact(item, ['userKey', 'delta']) && item.userKey === participants[index].userKey && Number.isSafeInteger(item.delta))
    && value.reduce((sum, item) => sum + BigInt(item.delta), 0n) === 0n;
}
function validBalances(value, participants) {
  return Array.isArray(value) && value.length === participants.length && value.every((item, index) =>
    exact(item, ['userKey', 'total']) && item.userKey === participants[index].userKey && Number.isSafeInteger(item.total));
}
const descriptorFields = ['matchId', 'roomId', 'game', 'ruleVersion', 'scoringVersion', 'startedAt', 'participants'];
function validDescriptor(value) {
  return HEX32.test(value.matchId ?? '') && HEX32.test(value.roomId ?? '') && value.game === 'poker414-2'
    && value.ruleVersion === 'poker414-2-v2' && value.scoringVersion === 'poker414-2-score-v1'
    && integer(value.startedAt) && validParticipants(value.participants);
}
function descriptor(value) { return Object.fromEntries(descriptorFields.map(field => [field, structuredClone(value[field])])); }
const settlementFields = ['matchId', 'roomId', 'game', 'ruleVersion', 'scoringVersion', 'settlementVersion', 'endedAt', 'status', 'reason', 'participants', 'deltas'];
function validSettlement(value) {
  return HEX32.test(value.matchId ?? '') && HEX32.test(value.roomId ?? '') && value.game === 'poker414-2'
    && value.ruleVersion === 'poker414-2-v2' && value.scoringVersion === 'poker414-2-score-v1'
    && integer(value.settlementVersion) && integer(value.endedAt) && ['completed', 'aborted', 'cancelled'].includes(value.status)
    && text(value.reason) && validParticipants(value.participants) && validDeltas(value.deltas, value.participants)
    && (value.settlementVersion > 0 || value.status !== 'cancelled' || value.deltas.every(item => item.delta === 0));
}
const commonFields = ['schemaVersion', 'accountGroup'];
const headFields = [...commonFields, 'kind', ...descriptorFields, 'phase', 'reservedBytes', 'settlementVersion', 'ledgerId', 'appliedDeltas', 'fingerprint'];
const ledgerFields = [...commonFields, ...settlementFields, 'fingerprint', 'correctionId', 'resultingDeltas', 'balancesAfter', 'sequence'];

/** Strict, permanent record contract shared by online writes and offline backups. */
export function validateScoreRecord(scope, value) {
  let valid = value?.schemaVersion === 1 && value?.accountGroup === GROUP;
  if (scope === SCORE_SCOPES.ledger) {
    valid &&= exact(value, ledgerFields) && validSettlement(value) && HEX64.test(value.fingerprint ?? '') && integer(value.sequence) && value.sequence > 0
      && (value.settlementVersion === 0 ? value.correctionId === null : HEX32.test(value.correctionId ?? ''))
      && validDeltas(value.resultingDeltas, value.participants) && validBalances(value.balancesAfter, value.participants)
      && (value.settlementVersion !== 0 || same(value.deltas, value.resultingDeltas))
      && (value.status !== 'cancelled' || value.resultingDeltas.every(item => item.delta === 0))
      && value.fingerprint === digest({ ...Object.fromEntries(settlementFields.map(field => [field, field === 'deltas' ? value.resultingDeltas : value[field]])),
        ...(value.settlementVersion > 0 ? { expectedSettlementVersion: value.settlementVersion - 1, correctionId: value.correctionId } : {}) })
      && Buffer.byteLength(JSON.stringify(value)) <= SCORE_LEDGER_MAX_BYTES;
  } else if (scope === SCORE_SCOPES.balances) {
    valid &&= exact(value, [...commonFields, 'userKey', 'total', 'updatedAt']) && HEX64.test(value.userKey ?? '')
      && Number.isSafeInteger(value.total) && integer(value.updatedAt);
  } else if (scope === SCORE_SCOPES.meta && value?.kind === 'quota') {
    valid &&= exact(value, [...commonFields, 'kind', 'capacityBytes', 'usedBytes', 'reservedBytes', 'settlements'])
      && integer(value.capacityBytes) && value.capacityBytes > 0 && integer(value.usedBytes) && integer(value.reservedBytes)
      && integer(value.settlements)
      && BigInt(value.usedBytes) + BigInt(value.reservedBytes) <= BigInt(value.capacityBytes);
  } else if (scope === SCORE_SCOPES.meta && value?.kind === 'match') {
    valid &&= exact(value, headFields) && validDescriptor(value) && HEX64.test(value.fingerprint ?? '') && integer(value.reservedBytes)
      && (value.phase === 'reserved' ? value.reservedBytes > 0 && value.settlementVersion === null && value.ledgerId === null && Array.isArray(value.appliedDeltas) && value.appliedDeltas.length === 0 && value.fingerprint === digest(descriptor(value))
        : value.phase === 'settled' && value.reservedBytes === 0 && integer(value.settlementVersion)
          && value.ledgerId === ledgerId(value.matchId, value.settlementVersion) && validDeltas(value.appliedDeltas, value.participants));
  } else if (scope === SCORE_SCOPES.meta && value?.kind === 'correction') {
    valid &&= exact(value, [...commonFields, 'kind', 'correctionId', 'matchId', 'settlementVersion', 'fingerprint'])
      && HEX32.test(value.correctionId ?? '') && HEX32.test(value.matchId ?? '') && integer(value.settlementVersion)
      && value.settlementVersion > 0 && HEX64.test(value.fingerprint ?? '');
  } else valid = false;
  if (!valid) fail('SCORE_CORRUPT');
  return value;
}

export function scoreRecordId(scope, value) {
  validateScoreRecord(scope, value);
  if (scope === SCORE_SCOPES.ledger) return ledgerId(value.matchId, value.settlementVersion);
  if (scope === SCORE_SCOPES.balances) return balanceId(value.userKey);
  return value.kind === 'quota' ? QUOTA_ID : value.kind === 'match' ? matchId(value.matchId) : correctionKey(value.correctionId);
}

/** Only plans score mutations. The caller MUST commit these with its room change in one CAS. */
export function createGameScores({ storage, now = Date.now, capacityBytes = SCORE_CAPACITY_BYTES } = {}) {
  if (!storage?.read || !storage?.encode || !storage?.adapter?.get || !storage?.scan || !storage?.compareAndSwapMany
      || !Buffer.isBuffer(storage.key) || typeof now !== 'function' || !integer(capacityBytes) || capacityBytes < 1) throw new TypeError('Scores require atomic encrypted storage.');
  const payloadBytes = (scope, id, value) => Buffer.byteLength(storage.encode(scope, id, value, SCORE_FOREVER).payload);
  async function read(scope, id) {
    const raw = await storage.adapter.get(recordKey(scope, id));
    if (!raw) return null;
    if (raw.expiresAt !== SCORE_FOREVER) fail('SCORE_CORRUPT');
    let value;
    try { value = decryptStoredRecord(storage.key, recordKey(scope, id), raw); } catch { fail('SCORE_CORRUPT'); }
    validateScoreRecord(scope, value);
    if (scoreRecordId(scope, value) !== id) fail('SCORE_CORRUPT');
    return { value, version: raw.revision, bytes: Buffer.byteLength(raw.payload) };
  }
  async function quota() {
    const saved = await read(SCORE_SCOPES.meta, QUOTA_ID);
    if (saved && saved.value.capacityBytes !== capacityBytes) fail('SCORE_CAPACITY_CONFIG');
    if (!saved && (await Promise.all(Object.values(SCORE_SCOPES).map(scope => storage.scan(scope)))).some(rows => rows.length)) fail('SCORE_CORRUPT');
    return saved;
  }
  const change = (scope, id, old, value) => ({ scope, id, expectedVersion: old?.version ?? null, value, expiresAt: SCORE_FOREVER });
  const guard = (scope, id, saved) => ({ scope, id, expectedVersion: saved?.version ?? null });
  function transaction(entries, previousQuota, reservedDelta, projection) {
    let used = (previousQuota?.value.usedBytes ?? 0) - (previousQuota?.bytes ?? 0);
    for (const entry of entries) used = safeAdd(used, payloadBytes(entry.scope, entry.id, entry.value) - (entry.old?.bytes ?? 0));
    const reserved = safeAdd(previousQuota?.value.reservedBytes ?? 0, reservedDelta);
    if (used < 0 || reserved < 0) fail('SCORE_CORRUPT');
    const settlements = safeAdd(previousQuota?.value.settlements ?? 0, entries.filter(entry => entry.scope === SCORE_SCOPES.ledger).length);
    let value = { schemaVersion: 1, accountGroup: GROUP, kind: 'quota', capacityBytes, usedBytes: used, reservedBytes: reserved, settlements };
    // The quota row counts its own final encrypted payload; decimal width stabilizes quickly.
    for (let pass = 0; pass < 20; pass++) {
      const next = used + payloadBytes(SCORE_SCOPES.meta, QUOTA_ID, value);
      if (next === value.usedBytes) break;
      value.usedBytes = next;
      if (pass === 19) fail('SCORE_QUOTA_ENCODING');
    }
    if (!Number.isSafeInteger(value.usedBytes) || BigInt(value.usedBytes) + BigInt(reserved) > BigInt(capacityBytes)) fail('SCORE_CAPACITY', '积分存储容量不足，暂时不能开始新局。');
    validateScoreRecord(SCORE_SCOPES.meta, value);
    return { changes: [...entries.map(entry => change(entry.scope, entry.id, entry.old, entry.value)), change(SCORE_SCOPES.meta, QUOTA_ID, previousQuota, value)],
      guards: [], projection: structuredClone(projection), alreadyCommitted: false };
  }
  async function prepareReservation(input) {
    demand(exact(input, descriptorFields) && validDescriptor(input) && input.startedAt <= now());
    const request = structuredClone(input), id = matchId(request.matchId), saved = await read(SCORE_SCOPES.meta, id);
    if (saved) {
      if (!await quota()) fail('SCORE_CORRUPT');
      if (!same(descriptor(saved.value), request)) fail('SCORE_MATCH_CONFLICT');
      return { changes: [], guards: [guard(SCORE_SCOPES.meta, id, saved)], projection: { matchId: request.matchId, reserved: saved.value.phase === 'reserved' }, alreadyCommitted: true };
    }
    const previousQuota = await quota();
    // Conservative bound includes every possible new balance, the complete terminal record,
    // a replaced head and quota growth. Existing balances may safely over-reserve in parallel rooms.
    const encodedMaximum = bytes => Math.ceil((bytes + 28) * 4 / 3);
    const reservedBytes = encodedMaximum(SCORE_LEDGER_MAX_BYTES) + request.participants.length * encodedMaximum(1024) + encodedMaximum(4096) + encodedMaximum(512);
    const value = { schemaVersion: 1, accountGroup: GROUP, kind: 'match', ...request, phase: 'reserved', reservedBytes,
      settlementVersion: null, ledgerId: null, appliedDeltas: [], fingerprint: digest(request) };
    return transaction([{ scope: SCORE_SCOPES.meta, id, old: null, value }], previousQuota, reservedBytes,
      { matchId: request.matchId, reserved: true, reservedBytes });
  }
  async function prepareSettlement(input) {
    demand(exact(input, settlementFields) && validSettlement(input) && input.settlementVersion === 0 && input.endedAt <= now());
    return prepareTerminal(structuredClone(input));
  }
  async function prepareCorrection(input) {
    const fields = [...settlementFields, 'expectedSettlementVersion', 'correctionId'];
    demand(exact(input, fields) && validSettlement(input) && HEX32.test(input.correctionId ?? '')
      && integer(input.expectedSettlementVersion) && input.settlementVersion === input.expectedSettlementVersion + 1 && input.endedAt <= now()
      && (input.status !== 'cancelled' || input.deltas.every(item => item.delta === 0)));
    return prepareTerminal(structuredClone(input));
  }
  async function prepareTerminal(input) {
    const isCorrection = input.settlementVersion > 0, fingerprint = digest(input), id = ledgerId(input.matchId, input.settlementVersion);
    const [existing, head, previousQuota] = await Promise.all([read(SCORE_SCOPES.ledger, id), read(SCORE_SCOPES.meta, matchId(input.matchId)), quota()]);
    if (existing) {
      if (existing.value.fingerprint !== fingerprint) fail('SCORE_SETTLEMENT_CONFLICT');
      if (!head || !previousQuota || head.value.phase !== 'settled' || head.value.settlementVersion < input.settlementVersion
          || ['roomId', 'game', 'ruleVersion', 'scoringVersion', 'participants'].some(field => !same(head.value[field], existing.value[field]))) fail('SCORE_CORRUPT');
      return { changes: [], guards: [guard(SCORE_SCOPES.ledger, id, existing), guard(SCORE_SCOPES.meta, matchId(input.matchId), head)], projection: structuredClone(existing.value), alreadyCommitted: true };
    }
    if (!head || !previousQuota) fail('SCORE_RESERVATION_MISSING');
    const match = head.value;
    if (['matchId', 'roomId', 'game', 'ruleVersion', 'scoringVersion', 'participants'].some(field => !same(input[field], match[field])) || input.endedAt < match.startedAt) fail('SCORE_MATCH_CONFLICT');
    if (isCorrection ? match.phase !== 'settled' || match.settlementVersion !== input.expectedSettlementVersion : match.phase !== 'reserved') fail('SCORE_VERSION_CONFLICT');
    let correction = null;
    if (isCorrection) {
      correction = await read(SCORE_SCOPES.meta, correctionKey(input.correctionId));
      if (correction) fail('SCORE_CORRECTION_REUSED');
    }
    const deltas = input.deltas.map((item, index) => ({ userKey: item.userKey,
      delta: isCorrection ? safeAdd(item.delta, -match.appliedDeltas[index].delta) : item.delta }));
    const savedBalances = await Promise.all(input.participants.map(player => read(SCORE_SCOPES.balances, balanceId(player.userKey))));
    const balances = input.participants.map((player, index) => ({ schemaVersion: 1, accountGroup: GROUP, userKey: player.userKey,
      total: safeAdd(savedBalances[index]?.value.total ?? 0, deltas[index].delta), updatedAt: Math.max(now(), savedBalances[index]?.value.updatedAt ?? 0) }));
    const base = Object.fromEntries(settlementFields.map(field => [field, input[field]]));
    const ledger = { schemaVersion: 1, accountGroup: GROUP, ...base, deltas, fingerprint, correctionId: input.correctionId ?? null,
      resultingDeltas: input.deltas, balancesAfter: balances.map(({ userKey, total }) => ({ userKey, total })), sequence: safeAdd(previousQuota.value.settlements, 1) };
    validateScoreRecord(SCORE_SCOPES.ledger, ledger);
    const nextHead = { ...match, phase: 'settled', reservedBytes: 0, settlementVersion: input.settlementVersion,
      ledgerId: id, appliedDeltas: input.deltas, fingerprint };
    const entries = [{ scope: SCORE_SCOPES.ledger, id, old: null, value: ledger }, ...balances.map((value, index) => ({ scope: SCORE_SCOPES.balances,
      id: balanceId(value.userKey), old: savedBalances[index], value })), { scope: SCORE_SCOPES.meta, id: matchId(input.matchId), old: head, value: nextHead }];
    if (isCorrection) entries.push({ scope: SCORE_SCOPES.meta, id: correctionKey(input.correctionId), old: null,
      value: { schemaVersion: 1, accountGroup: GROUP, kind: 'correction', correctionId: input.correctionId,
        matchId: input.matchId, settlementVersion: input.settlementVersion, fingerprint } });
    return transaction(entries, previousQuota, -match.reservedBytes, ledger);
  }
  async function readBalance(userKey) {
    demand(HEX64.test(userKey ?? ''));
    const saved = await read(SCORE_SCOPES.balances, balanceId(userKey));
    return saved ? structuredClone(saved.value) : { schemaVersion: 1, accountGroup: GROUP, userKey, total: 0, updatedAt: null };
  }
  /** Trusted room authority supplies the exact saved revision; callers fence all returned guards before delivery. */
  async function prepareRoomRead({ roomId, roomVersion, matchId: requestedMatchId = null }) {
    demand(HEX32.test(roomId ?? '') && typeof roomVersion === 'string' && (requestedMatchId === null || HEX32.test(requestedMatchId ?? '')));
    const room = await storage.read('rooms', roomId), snapshot = room?.value.snapshot;
    if (!snapshot || room.version !== roomVersion) fail('SCORE_ROOM_CHANGED', '房间已变化，请重新读取积分。', 409);
    if (snapshot.gameType !== 'poker414-2') fail('SCORE_UNSUPPORTED', '这个游戏暂未使用累计娱乐积分。', 400);
    const selectedMatchId = requestedMatchId ?? snapshot.matchId ?? snapshot.lastMatchResult?.matchId ?? null;
    // Membership in today's room does not grant access to every historical roster.
    // Older matches remain behind the participant-scoped match-history service.
    if (requestedMatchId && ![snapshot.matchId, snapshot.lastMatchResult?.matchId].includes(requestedMatchId)) {
      fail('SCORE_MATCH_NOT_FOUND', '请从自己的历史战绩查看以往对局。', 404);
    }
    const head = selectedMatchId ? await read(SCORE_SCOPES.meta, matchId(selectedMatchId)) : null;
    if (selectedMatchId && !head && [snapshot.matchId, snapshot.lastMatchResult?.matchId].includes(selectedMatchId)) fail('SCORE_CORRUPT');
    if (head && head.value.roomId !== roomId) fail('SCORE_MATCH_NOT_FOUND', '本房间没有这局积分记录。', 404);
    const ledger = head?.value.phase === 'settled' ? await read(SCORE_SCOPES.ledger, head.value.ledgerId) : null;
    if (head?.value.phase === 'settled' && (!ledger || ledger.value.fingerprint !== head.value.fingerprint)) fail('SCORE_CORRUPT');
    const values = await Promise.all(snapshot.players.map(player => read(SCORE_SCOPES.balances, balanceId(player.userKey))));
    const guards = [{ scope: 'rooms', id: roomId, expectedVersion: roomVersion },
      ...snapshot.players.map((player, index) => guard(SCORE_SCOPES.balances, balanceId(player.userKey), values[index])),
      ...(selectedMatchId ? [guard(SCORE_SCOPES.meta, matchId(selectedMatchId), head)] : []),
      ...(ledger ? [guard(SCORE_SCOPES.ledger, head.value.ledgerId, ledger)] : [])];
    const seatByUser = new Map((ledger?.value.participants ?? []).map(player => [player.userKey, player.seatId]));
    return { guards, body: { accountGroup: GROUP, roomId, roomRevision: snapshot.revision, matchId: selectedMatchId, readAt: now(),
      players: snapshot.players.map((player, index) => ({ playerId: player.id, total: values[index]?.value.total ?? 0 })),
      settlement: ledger ? { matchId: ledger.value.matchId, settlementVersion: ledger.value.settlementVersion,
        endedAt: ledger.value.endedAt, status: ledger.value.status, reason: ledger.value.reason,
        balancesAfter: ledger.value.balancesAfter.map(({ userKey, total }) => ({ playerId: seatByUser.get(userKey), total })),
        deltas: ledger.value.resultingDeltas.map(({ userKey, delta }) => ({ playerId: seatByUser.get(userKey), delta })) } : null } };
  }
  return Object.freeze({ prepareReservation, prepareSettlement, prepareCorrection, readBalance, prepareRoomRead });
}

/** Offline accounting proof. Room and archived-summary references are checked by backup.mjs. */
export function validateScoreState(rows) {
  if (!Array.isArray(rows)) fail('SCORE_CORRUPT');
  const byKey = new Map(), balances = new Map(), ledgers = new Map(), heads = [], reservations = [], corrections = [];
  let quota = null, usedBytes = 0, reservedBytes = 0;
  for (const row of rows) {
    const id = scoreRecordId(row.scope, row.value), key = `${row.scope}:${id}`;
    if (byKey.has(key) || row.expiresAt !== SCORE_FOREVER || !integer(row.payloadBytes) || row.payloadBytes <= 0) fail('SCORE_CORRUPT');
    byKey.set(key, row.value); usedBytes = safeAdd(usedBytes, row.payloadBytes);
    const value = row.value;
    if (row.scope === SCORE_SCOPES.ledger) ledgers.set(id, value);
    else if (row.scope === SCORE_SCOPES.balances) balances.set(value.userKey, value);
    else if (value.kind === 'quota') { if (quota) fail('SCORE_CORRUPT'); quota = value; }
    else if (value.kind === 'correction') corrections.push(value);
    else { heads.push(value); if (value.phase === 'reserved') { reservations.push(value); reservedBytes = safeAdd(reservedBytes, value.reservedBytes); } }
  }
  if (!rows.length) return { reservations, heads, ledgers: [], balances: [], usedBytes: 0, reservedBytes: 0 };
  if (!quota || quota.usedBytes !== usedBytes || quota.reservedBytes !== reservedBytes || quota.settlements !== ledgers.size) fail('SCORE_CORRUPT');
  const totals = new Map(), headsByMatch = new Map(heads.map(head => [head.matchId, head])),
    correctionsById = new Map(corrections.map(correction => [correction.correctionId, correction]));
  const orderedLedgers = [...ledgers.values()].sort((left, right) => left.sequence - right.sequence);
  for (const [index, ledger] of orderedLedgers.entries()) {
    if (ledger.sequence !== index + 1) fail('SCORE_CORRUPT');
    const head = headsByMatch.get(ledger.matchId);
    if (!head || head.phase !== 'settled' || ledger.settlementVersion > head.settlementVersion
        || ledger.endedAt < head.startedAt
        || ['roomId', 'game', 'ruleVersion', 'scoringVersion', 'participants'].some(field => !same(head[field], ledger[field]))) fail('SCORE_CORRUPT');
    if (ledger.settlementVersion > 0) {
      const previous = ledgers.get(ledgerId(ledger.matchId, ledger.settlementVersion - 1));
      const correction = correctionsById.get(ledger.correctionId);
      if (!previous || !correction || correction.matchId !== ledger.matchId || correction.settlementVersion !== ledger.settlementVersion || correction.fingerprint !== ledger.fingerprint
          || ledger.deltas.some((item, index) => BigInt(item.delta) !== BigInt(ledger.resultingDeltas[index].delta) - BigInt(previous.resultingDeltas[index].delta))) fail('SCORE_CORRUPT');
    }
    for (const [index, item] of ledger.deltas.entries()) {
      const next = (totals.get(item.userKey) ?? 0n) + BigInt(item.delta);
      if (next !== BigInt(ledger.balancesAfter[index].total)) fail('SCORE_CORRUPT');
      totals.set(item.userKey, next);
    }
  }
  for (const head of heads) {
    const latest = ledgers.get(head.ledgerId);
    if (head.phase === 'reserved' ? ledgers.has(ledgerId(head.matchId, 0))
      : !latest || latest.fingerprint !== head.fingerprint || !same(latest.resultingDeltas, head.appliedDeltas)) fail('SCORE_CORRUPT');
  }
  for (const correction of corrections) {
    const ledger = ledgers.get(ledgerId(correction.matchId, correction.settlementVersion));
    if (!ledger || ledger.correctionId !== correction.correctionId || ledger.fingerprint !== correction.fingerprint) fail('SCORE_CORRUPT');
  }
  if (balances.size !== totals.size || [...balances].some(([key, balance]) => totals.get(key) !== BigInt(balance.total))) fail('SCORE_CORRUPT');
  return { reservations, heads, ledgers: [...ledgers.values()], balances: [...balances.values()], usedBytes, reservedBytes };
}
