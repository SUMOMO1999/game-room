import { createHash } from 'node:crypto';
import { recordKey, decryptStoredRecord } from '../../storage.mjs';
import { CARDS, GOODS, CONTENT_VERSION, PLAYER_COUNT_CONTENT_VERSION, DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION,
  materialProfile } from '../../../app/games/hyakki-trading/content/definitions.mjs';
import { MAX_GOODS_PER_TYPE } from '../../../app/games/hyakki-trading/model.mjs';
import { publicBattleMetadataProblem } from '../../../app/games/hyakki-trading/battle-public-metadata.mjs';
import {openingProblem} from '../../../app/games/hyakki-trading/opening.mjs';
import {isExpansionContentVersion,CONFIGURABLE_RULE_VERSION} from '../../../app/games/hyakki-trading/content/expansion-one.mjs';
import {materialForConfiguration} from '../../../app/games/hyakki-trading/opening-configuration.mjs';
import {history4Material,history4EventProblem,history4GroupProblem,history4RoleProblem,encodeHistory4Metadata,decodeHistory4Metadata} from '../../../app/games/hyakki-trading/public-history-v4.mjs';

export const HYAKKI_EVENT_SCOPES = Object.freeze({ events: 'hyakki-events', meta: 'hyakki-event-meta' });
export const HYAKKI_EVENT_FOREVER = Number.MAX_SAFE_INTEGER;
// Local S1 ceilings, not a cloud allocation or a gameplay turn limit.
export const HYAKKI_EVENT_CAPACITY_BYTES = 32 * 1024 * 1024;
export const HYAKKI_EVENT_GROUP_MAX_BYTES = 32 * 1024;
export const HYAKKI_EVENT_GROUP_MAX_EVENTS = 64;
export const HYAKKI_EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
export const HYAKKI_EVENT_PAGE_MAX_BYTES = 256 * 1024;
// AES-GCM adds 28 bytes; base64url is at most ceil(n/3)*4 bytes. Two
// maximum groups cover one capacity suspension and one terminal release.
// 2048 further bytes bound head/quota decimal and terminal-field growth.
export const HYAKKI_EVENT_FINISH_RESERVE_BYTES = 2 * Math.ceil((HYAKKI_EVENT_GROUP_MAX_BYTES + 28) / 3) * 4 + 2048;
const MAX_META_BYTES = 2048, QUOTA_ID = 'quota', HEX32 = /^[a-f0-9]{32}$/, HEX64 = /^[a-f0-9]{64}$/;
const cardIds = new Set(CARDS.map(card => card.id)), goodIds = new Set(GOODS.map(good => good.id));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, names) => plain(value) && Object.keys(value).every(key => names.includes(key));
const exact = (value, names) => fields(value, names) && names.every(key => Object.hasOwn(value, key));
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
  : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const groupId = (matchId, sequence) => `${matchId}:${sequence}`;
const headId = matchId => `match:${matchId}`;
const same = (left, right) => canonical(left) === canonical(right);
export class HyakkiEventError extends Error {
  constructor(status, code, message) { super(message); this.name = 'HyakkiEventError'; this.status = status; this.code = code; }
}
const fail = (code, message = '本局历史暂时无法确认，请稍后重试。', status = 503) => { throw new HyakkiEventError(status, code, message); };
const demand = condition => { if (!condition) fail('GAME_HISTORY_INVALID', '局内历史参数无效。', 400); };
const isConfiguredMatch=match=>match?.ruleVersion===CONFIGURABLE_RULE_VERSION;
const context4=value=>({contentVersion:value.contentVersion,participantIds:value.participantIds??value.participants.map(p=>p.seatId)});
const roleRoster=(group,match)=>{
  try{return decodeHistory4Metadata(group?.metadata,context4(match)).rolesRevealed;}
  catch{fail('GAME_HISTORY_CORRUPT');}
};
const profileForMatch = match => isConfiguredMatch(match)?materialForConfiguration(match.configuration):materialProfile(match.contentVersion, match.participants.length);
function profileForGroup(group) {
  if(group.schemaVersion===4)return history4Material(context4(group)).profile;
  if (group.schemaVersion !== 3) return materialProfile();
  if (group.contentVersion !== PLAYER_COUNT_CONTENT_VERSION) throw new RangeError('Unsupported public history content.');
  return materialProfile(group.contentVersion, group.playerCount);
}
const groupMatches = (group, match) => group.schemaVersion===4
  ?isConfiguredMatch(match)&&group.contentVersion===match.contentVersion&&same(group.participantIds,match.participants.map(p=>p.seatId))
  :isConfiguredMatch(match)?false:group.schemaVersion === 3
  ? group.contentVersion === match.contentVersion && group.playerCount === match.participants.length
  : match.contentVersion === CONTENT_VERSION;

// A version22 private opening is an attempt, not an active public battle.
// Its confirmed choices and receipts live in the encrypted room snapshot.
// A public head is required immediately after initialization; this exception
// cannot hide a missing event head for a dealt game or any legacy snapshot.
function unpublishedOpening(room){
  const game=room.game,opening=game?.opening;
  return room.schemaVersion===22&&['playing','paused'].includes(room.phase)
    &&game?.kind==='hyakki-opening-game'&&game.version===3&&game.stage==='role-selection'&&game.status==='playing'&&game.result===null
    &&game.ruleVersion===CONFIGURABLE_RULE_VERSION&&isExpansionContentVersion(game.contentVersion)
    &&opening?.status==='selecting'&&opening.deal===null&&openingProblem(opening)===null
    &&room.matchId===opening.openingId&&game.matchId===opening.openingId&&room.matchStartedAt===opening.createdAt
    &&Array.isArray(room.matchParticipants)&&Array.isArray(game.players)
    &&same(room.matchParticipants.map(p=>p.playerId),opening.configuration.participantIds)
    &&same(game.players.map(p=>p.id),opening.configuration.participantIds);
}

// A closed public vocabulary: no text blobs, hidden copy IDs, hands or PRNG.
// S2 projectors must explicitly choose a public event, never forward a client
// body or arbitrary game state. Private look/keep events cannot carry faces.
const eventFields = Object.freeze({
  'match-started': [], 'draw-peeked': ['actorSeatId'], 'draw-kept': ['actorSeatId'],
  'draw-discarded': ['actorSeatId', 'cardId'], 'draw-finished': ['actorSeatId'],
  'trade-bought': ['actorSeatId', 'cardId', 'goods', 'silver'],
  'trade-sold': ['actorSeatId', 'cardId', 'goods', 'silver'],
  'stall-expanded': ['actorSeatId', 'silver', 'count'],
  'character-played': ['actorSeatId', 'cardId', 'targetSeatId'],
  'tool-installed': ['actorSeatId', 'cardId'], 'tool-activated': ['actorSeatId', 'cardId', 'targetSeatId'],
  'response-played': ['actorSeatId', 'cardId'], 'response-declined': ['actorSeatId'],
  'choice-resolved': ['actorSeatId', 'targetSeatId', 'count'],
  'cards-revealed': ['actorSeatId', 'cardIds'],
  'search-revealed': ['actorSeatId', 'cardIds'],
  'auction-revealed': ['actorSeatId', 'cardIds', 'goods'],
  'bid-raised': ['actorSeatId', 'silver'], 'bid-passed': ['actorSeatId'],
  'auction-settled': ['actorSeatId', 'targetSeatId', 'silver', 'cardIds', 'goods'],
  'turn-ended': ['actorSeatId'], paused: [], resumed: [], suspended: ['reason'], 'pending-closed': ['reason'],
  'match-ended': ['reason', 'winnerSeatId'],
});
const reasons = new Set(['capacity', 'disconnected', 'server-recovery', 'voluntary-leave', 'normal-close', 'absence-expired', 'room-expired', 'cancelled']);
export function validateHyakkiPublicEvent(value, context) {
  let profile;
  try {
    // Preserve the historical Array.forEach(validator) API: its numeric index
    // is never material authority and retains the strict legacy 110 bound.
    if (context === undefined || Number.isSafeInteger(context) && context >= 0) profile = materialProfile();
    else {
      demand(typeof context?.contentVersion === 'string');
      profile = materialProfile(context.contentVersion, context.playerCount);
    }
  } catch { demand(false); }
  const allowed = Object.hasOwn(eventFields, value?.type) ? eventFields[value.type] : null;
  if (!allowed || !fields(value, ['type', ...allowed])) fail('GAME_HISTORY_INVALID', '公开历史含未支持字段。', 400);
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith('SeatId') && !(item === null && key === 'winnerSeatId') && !HEX32.test(item ?? '')) demand(false);
    if (key === 'cardId') demand(cardIds.has(item));
    if (key === 'cardIds') demand(Array.isArray(item) && item.length <= profile.deckSize && item.every(id => cardIds.has(id)));
    if (key === 'goods') demand(Array.isArray(item) && item.length <= 6 && new Set(item.map(good => good?.id)).size === item.length
      && item.every(good => exact(good, ['id', 'count']) && goodIds.has(good.id) && integer(good.count) && good.count <= MAX_GOODS_PER_TYPE));
    if (key === 'silver') demand(integer(item));
    if (key === 'count') demand(integer(item) && item <= profile.deckSize);
    if (key === 'reason') demand(reasons.has(item));
  }
  if (allowed.includes('actorSeatId')) demand(HEX32.test(value.actorSeatId ?? ''));
  if (['suspended', 'match-ended', 'pending-closed'].includes(value.type)) demand(reasons.has(value.reason));
  return value;
}
const matchFields = ['roomId', 'matchId', 'ruleVersion', 'contentVersion', 'startedAt', 'participants'];
function validMatch(value) {
  try {
    profileForMatch(value);
    if(isConfiguredMatch(value)&&(!same(value.configuration.participantIds,value.participants.map(p=>p.seatId))
      ||value.configuration.ruleVersion!==value.ruleVersion||value.configuration.contentVersion!==value.contentVersion))return false;
  } catch { return false; }
  return exact(value, [...matchFields,...(isConfiguredMatch(value)?['configuration']:[])]) && HEX32.test(value.roomId ?? '') && HEX32.test(value.matchId ?? '')
    && [DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION,CONFIGURABLE_RULE_VERSION].includes(value.ruleVersion)
    && (value.contentVersion !== PLAYER_COUNT_CONTENT_VERSION || [MULTIPLAYER_RULE_VERSION,CONFIGURABLE_RULE_VERSION].includes(value.ruleVersion)) && integer(value.startedAt)
    && Array.isArray(value.participants) && value.participants.length >= 2 && value.participants.length <= (value.ruleVersion === DIGITAL_RULE_VERSION ? 2 : 6)
    && new Set(value.participants.map(player => player?.seatId)).size === value.participants.length
    && new Set(value.participants.map(player => player?.userKey)).size === value.participants.length
    && value.participants.every(player => exact(player, ['seatId', 'userKey']) && HEX32.test(player.seatId ?? '') && HEX64.test(player.userKey ?? ''));
}
function validGroup(value) {
  if(value?.schemaVersion===4){
    try{
      if(history4GroupProblem(value,context4(value)))return false;
      const {fingerprint,...body}=value;
      return validModes(value)&&fingerprint===digest(body);
    }catch{return false;}
  }
  let profile;
  try { profile = profileForGroup(value); } catch { return false; }
  const metadataFields = [2, 3].includes(value?.schemaVersion) ? ['turn', 'sourceCardId', 'changes', 'discard'] : [];
  const contextFields = value?.schemaVersion === 3 ? ['contentVersion', 'playerCount'] : [];
  if (!exact(value, ['schemaVersion', 'kind', 'roomId', 'matchId', 'sequence', 'commitId', 'committedAt', 'mode', 'events', 'fingerprint', ...metadataFields, ...contextFields])
      || ![1, 2, 3].includes(value.schemaVersion) || value.kind !== 'group' || !HEX32.test(value.roomId ?? '') || !HEX32.test(value.matchId ?? '')
      || !integer(value.sequence) || value.sequence < 1 || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.commitId ?? '')
      || !integer(value.committedAt) || !['normal', 'capacity', 'resume', 'terminal'].includes(value.mode)
      || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > HYAKKI_EVENT_GROUP_MAX_EVENTS
      || !HEX64.test(value.fingerprint ?? '') || Buffer.byteLength(JSON.stringify(value)) > HYAKKI_EVENT_GROUP_MAX_BYTES) return false;
  try { value.events.forEach(event => validateHyakkiPublicEvent(event, profile)); } catch { return false; }
  if ([2, 3].includes(value.schemaVersion) && (publicBattleMetadataProblem({ turn: value.turn, sourceCardId: value.sourceCardId,
    changes: value.changes, discard: value.discard }, null, profile))) return false;
  if(!validModes(value))return false;
  const { fingerprint, ...body } = value;
  return fingerprint === digest(body);
}
function validModes(value){
  if (value.sequence === 1 && !(value.mode === 'normal' && value.events.length === 1 && value.events[0].type === 'match-started')) return false;
  if (value.mode === 'capacity' && !(value.events.length === 1 && value.events[0].type === 'suspended' && value.events[0].reason === 'capacity')) return false;
  if (value.mode === 'resume' && !(value.events.length === 1 && value.events[0].type === 'resumed')) return false;
  if (value.mode === 'terminal' && !(value.events.at(-1).type === 'match-ended'
      && value.events.filter(event => event.type === 'match-ended').length === 1
      && (value.events.at(-1).reason === 'normal-close' || value.events.every(event => ['pending-closed', 'match-ended'].includes(event.type))))) return false;
  if (value.mode !== 'capacity' && value.events.some(event => event.type === 'suspended' && event.reason === 'capacity')) return false;
  if (value.mode !== 'terminal' && value.events.some(event => event.type === 'match-ended')) return false;
  return true;
}
const headFields = ['schemaVersion', 'kind', 'match', 'phase', 'sequence', 'eventBytes', 'reservedBytes', 'lastCommittedAt', 'endedAt', 'retainUntil', 'prunedThrough'];
export function validateHyakkiEventRecord(scope, value) {
  let valid = false;
  if (scope === HYAKKI_EVENT_SCOPES.events) valid = validGroup(value);
  else if (scope === HYAKKI_EVENT_SCOPES.meta && value?.kind === 'quota') valid = exact(value,
    ['schemaVersion', 'kind', 'capacityBytes', 'usedBytes', 'reservedBytes']) && value.schemaVersion === 1
    && integer(value.capacityBytes) && value.capacityBytes > 0 && integer(value.usedBytes) && integer(value.reservedBytes)
    && value.usedBytes + value.reservedBytes <= value.capacityBytes;
  else if (scope === HYAKKI_EVENT_SCOPES.meta && value?.kind === 'match') valid = exact(value, headFields)
    && value.schemaVersion === 1 && validMatch(value.match) && ['active', 'capacity-suspended', 'terminal', 'pruning'].includes(value.phase)
    && integer(value.sequence) && value.sequence > 0 && integer(value.eventBytes) && integer(value.reservedBytes)
    && value.reservedBytes <= HYAKKI_EVENT_FINISH_RESERVE_BYTES && integer(value.lastCommittedAt) && value.lastCommittedAt >= value.match.startedAt
    && integer(value.prunedThrough) && value.prunedThrough <= value.sequence
    && (['terminal', 'pruning'].includes(value.phase) ? integer(value.endedAt) && value.endedAt >= value.match.startedAt
      && value.retainUntil === value.endedAt + HYAKKI_EVENT_RETENTION_MS && value.reservedBytes === 0
      : value.endedAt === null && value.retainUntil === null && value.reservedBytes > 0 && value.prunedThrough === 0);
  if (!valid || scope === HYAKKI_EVENT_SCOPES.meta && Buffer.byteLength(JSON.stringify(value)) > MAX_META_BYTES) fail('GAME_HISTORY_CORRUPT');
  return value;
}
export function hyakkiEventRecordId(scope, value) {
  validateHyakkiEventRecord(scope, value);
  return scope === HYAKKI_EVENT_SCOPES.events ? groupId(value.matchId, value.sequence) : value.kind === 'quota' ? QUOTA_ID : headId(value.match.matchId);
}

/** Decoded backup rows retain their actual encrypted byte lengths. Optional
 * references are authoritative room snapshots plus history/pending summaries. */
export function validateHyakkiEventState(rows, { rooms = null, summaries = [], now = Date.now() } = {}) {
  demand(Array.isArray(rows));
  const groups = new Map(), heads = new Map(); let quota = null, usedBytes = 0, reservedBytes = 0;
  for (const row of rows) {
    const id = hyakkiEventRecordId(row.scope, row.value);
    if (row.expiresAt !== HYAKKI_EVENT_FOREVER || !integer(row.payloadBytes) || row.payloadBytes < 1
        || row.key !== undefined && row.key !== recordKey(row.scope, id)) fail('GAME_HISTORY_CORRUPT');
    usedBytes += row.payloadBytes;
    if (row.scope === HYAKKI_EVENT_SCOPES.events) {
      if (groups.has(id)) fail('GAME_HISTORY_CORRUPT'); groups.set(id, row);
    } else if (row.value.kind === 'quota') {
      if (quota) fail('GAME_HISTORY_CORRUPT'); quota = row.value;
    } else {
      if (heads.has(row.value.match.matchId)) fail('GAME_HISTORY_CORRUPT');
      heads.set(row.value.match.matchId, row.value); reservedBytes += row.value.reservedBytes;
    }
  }
  if (rows.length && (!quota || quota.usedBytes !== usedBytes || quota.reservedBytes !== reservedBytes)) fail('GAME_HISTORY_CORRUPT');
  let consumed = 0;
  for (const head of heads.values()) {
    let measured = 0, lastAt = head.match.startedAt;
    const roster=isConfiguredMatch(head.match)&&isExpansionContentVersion(head.match.contentVersion)&&head.prunedThrough===0
      ?roleRoster(groups.get(groupId(head.match.matchId,1))?.value,head.match):null;
    if (head.phase === 'active' && head.reservedBytes !== HYAKKI_EVENT_FINISH_RESERVE_BYTES) fail('GAME_HISTORY_CORRUPT');
    for (let sequence = head.prunedThrough + 1; sequence <= head.sequence; sequence++) {
      const row = groups.get(groupId(head.match.matchId, sequence)), value = row?.value;
      if (!value || value.roomId !== head.match.roomId || value.committedAt < lastAt || !groupMatches(value, head.match)) fail('GAME_HISTORY_CORRUPT');
      const seats = new Set(head.match.participants.map(player => player.seatId));
      if (value.events.some(event => Object.entries(event).some(([field, id]) => field.endsWith('SeatId') && id !== null && !seats.has(id)))) fail('GAME_HISTORY_CORRUPT');
      if ([2, 3].includes(value.schemaVersion) && (publicBattleMetadataProblem({ turn: value.turn, sourceCardId: value.sourceCardId,
        changes: value.changes, discard: value.discard }, [...seats], profileForMatch(head.match))
        || value.turn.round !== Math.ceil(value.turn.number / seats.size))) fail('GAME_HISTORY_CORRUPT');
      if(value.schemaVersion===4&&history4GroupProblem(value,context4(head.match)))fail('GAME_HISTORY_CORRUPT');
      if(roster&&history4RoleProblem(value,roster,context4(head.match)))fail('GAME_HISTORY_CORRUPT');
      measured += row.payloadBytes; lastAt = value.committedAt; consumed++;
    }
    if (measured !== head.eventBytes || lastAt !== head.lastCommittedAt) fail('GAME_HISTORY_CORRUPT');
    const latest = groups.get(groupId(head.match.matchId, head.sequence))?.value;
    if (!latest || (head.phase === 'capacity-suspended') !== (latest.mode === 'capacity')
        || (['terminal', 'pruning'].includes(head.phase)) !== (latest.mode === 'terminal')
        || head.endedAt !== null && head.endedAt !== lastAt) fail('GAME_HISTORY_CORRUPT');
  }
  if (consumed !== groups.size) fail('GAME_HISTORY_CORRUPT');
  if (rooms !== null) {
    demand(Array.isArray(rooms) && Array.isArray(summaries) && integer(now));
    const relevantRooms = rooms.filter(room => room.gameType === 'hyakki-trading' && room.matchId && !unpublishedOpening(room));
    const relevantSummaries = summaries.filter(summary => summary.game === 'hyakki-trading');
    const roomByMatch = new Map(relevantRooms.map(room => [room.matchId, room]));
    const summaryByMatch = new Map(relevantSummaries.map(summary => [summary.matchId, summary]));
    // Seat order is part of a frozen match, including auction and closing order.
    const samePeople = (people, expected) => same(people, expected);
    for (const head of heads.values()) {
      const room = roomByMatch.get(head.match.matchId), summary = summaryByMatch.get(head.match.matchId);
      if (!['terminal', 'pruning'].includes(head.phase) && !room) fail('GAME_HISTORY_REFERENCE');
      if (room) {
        const initializedOpening=room.schemaVersion===22&&room.game?.kind==='hyakki-opening-game'
          &&room.game.opening?.status==='completed'&&openingProblem(room.game.opening)===null;
        const phaseMatches = head.phase === 'active'
          ? ['playing', 'paused'].includes(room.phase) && (room.game?.lifecycle?.capacity === false||initializedOpening)
          : head.phase === 'capacity-suspended'
            ? room.phase === 'paused' && room.game?.lifecycle?.capacity === true
            : ['finished', 'aborted'].includes(room.phase) && room.matchEndedAt === head.endedAt;
        if (!phaseMatches) fail('GAME_HISTORY_REFERENCE');
      }
      if (room && (room.roomId !== head.match.roomId || room.game?.ruleVersion !== head.match.ruleVersion
          || room.game?.contentVersion !== head.match.contentVersion
          ||(room.game?.kind==='hyakki-opening-game'&&room.game.opening?.status==='completed'?1:room.game?.publicEventSequence)!==head.sequence
          || room.matchStartedAt !== head.match.startedAt
          || !samePeople((room.matchParticipants ?? []).map(player => ({ seatId: player.playerId, userKey: player.userKey })), head.match.participants))) fail('GAME_HISTORY_REFERENCE');
      if(room&&isConfiguredMatch(head.match)){
        const configuration=room.game?.configuration??room.game?.opening?.configuration;
        if(!same(configuration,head.match.configuration))fail('GAME_HISTORY_REFERENCE');
        if(isExpansionContentVersion(head.match.contentVersion)&&head.prunedThrough===0){
          const first=groups.get(groupId(head.match.matchId,1))?.value;
          const roles=roleRoster(first,head.match);
          const players=room.game?.opening?.deal?.players??room.game.players;
          if(!players.every(p=>roles.some(r=>r.seatId===p.id&&r.roleId===p.roleId)))fail('GAME_HISTORY_REFERENCE');
        }
      }
      if (summary && (summary.roomId !== head.match.roomId || summary.ruleVersion !== head.match.ruleVersion
          || summary.startedAt !== head.match.startedAt || summary.endedAt !== head.endedAt
          || !samePeople(summary.players.map(player => ({ seatId: player.seatId, userKey: player.userKey })), head.match.participants))) fail('GAME_HISTORY_REFERENCE');
      if (head.phase === 'terminal' && head.retainUntil > now && !room && !summary) fail('GAME_HISTORY_REFERENCE');
    }
    for (const room of relevantRooms) if (!heads.has(room.matchId)) fail('GAME_HISTORY_REFERENCE');
    for (const summary of relevantSummaries) if (summary.endedAt + HYAKKI_EVENT_RETENTION_MS > now && !heads.has(summary.matchId)) fail('GAME_HISTORY_REFERENCE');
  }
  return { heads: [...heads.values()], groups: [...groups.values()].map(row => row.value), usedBytes, reservedBytes, quota };
}

/** Server-only preparation and exact-key paging. No auth or room write here. */
export function createHyakkiEventStore({ storage, now = Date.now, capacityBytes = HYAKKI_EVENT_CAPACITY_BYTES } = {}) {
  if (!storage?.encode || !storage?.adapter?.get || !storage?.scan || !storage?.compareAndSwapMany || !Buffer.isBuffer(storage.key)
      || typeof now !== 'function' || !integer(capacityBytes) || capacityBytes < 1) throw new TypeError('Events require encrypted atomic storage.');
  const bytes = (scope, id, value) => Buffer.byteLength(storage.encode(scope, id, value, HYAKKI_EVENT_FOREVER).payload);
  async function read(scope, id) {
    const raw = await storage.adapter.get(recordKey(scope, id));
    if (!raw) return null;
    let value;
    try { value = decryptStoredRecord(storage.key, recordKey(scope, id), raw); } catch { fail('GAME_HISTORY_CORRUPT'); }
    if (raw.expiresAt !== HYAKKI_EVENT_FOREVER || hyakkiEventRecordId(scope, value) !== id) fail('GAME_HISTORY_CORRUPT');
    return { value, version: raw.revision, bytes: Buffer.byteLength(raw.payload) };
  }
  async function readQuota() {
    const saved = await read(HYAKKI_EVENT_SCOPES.meta, QUOTA_ID);
    if (saved && saved.value.capacityBytes !== capacityBytes) fail('GAME_HISTORY_CAPACITY_CONFIG');
    if (!saved && (await Promise.all(Object.values(HYAKKI_EVENT_SCOPES).map(scope => storage.scan(scope)))).some(rows => rows.length)) {
      // Another match may have initialized quota between the first read and
      // this orphan check. Re-read once; never overwrite a concurrent quota.
      const concurrent = await read(HYAKKI_EVENT_SCOPES.meta, QUOTA_ID);
      if (!concurrent) fail('GAME_HISTORY_CORRUPT');
      if (concurrent.value.capacityBytes !== capacityBytes) fail('GAME_HISTORY_CAPACITY_CONFIG');
      return concurrent;
    }
    return saved;
  }
  const guard = (scope, id, saved) => ({ scope, id, expectedVersion: saved?.version ?? null });
  const change = (entry) => ({ ...guard(entry.scope, entry.id, entry.old), value: entry.value,
    ...(entry.value === null ? {} : { expiresAt: HYAKKI_EVENT_FOREVER }) });
  function quotaValue(entries, quota, reservedDelta) {
    let used = (quota?.value.usedBytes ?? 0) - (quota?.bytes ?? 0);
    for (const entry of entries) used += (entry.value === null ? 0 : bytes(entry.scope, entry.id, entry.value)) - (entry.old?.bytes ?? 0);
    const value = { schemaVersion: 1, kind: 'quota', capacityBytes, usedBytes: used,
      reservedBytes: (quota?.value.reservedBytes ?? 0) + reservedDelta };
    for (let pass = 0; pass < 20; pass++) {
      const measured = used + bytes(HYAKKI_EVENT_SCOPES.meta, QUOTA_ID, value);
      if (value.usedBytes === measured) break;
      value.usedBytes = measured;
      if (pass === 19) fail('GAME_HISTORY_CORRUPT');
    }
    if (!integer(value.usedBytes) || !integer(value.reservedBytes)) fail('GAME_HISTORY_CORRUPT');
    return value;
  }
  function plan(entries, quota, reservedDelta) {
    const value = quotaValue(entries, quota, reservedDelta);
    if (value.usedBytes + value.reservedBytes > capacityBytes) fail('GAME_HISTORY_CAPACITY', '本局公开历史容量已满，原操作未保存。');
    validateHyakkiEventRecord(HYAKKI_EVENT_SCOPES.meta, value);
    return { changes: [...entries.map(change), change({ scope: HYAKKI_EVENT_SCOPES.meta, id: QUOTA_ID, old: quota, value })], guards: [] };
  }
  async function prepareAppend(input) {
    const metadataFields = input?.schemaVersion===4?['schemaVersion','contentVersion','participantIds','metadata']
      :[2, 3].includes(input?.schemaVersion) ? ['schemaVersion', 'turn', 'sourceCardId', 'changes', 'discard',
      ...(input.schemaVersion === 3 ? ['contentVersion', 'playerCount'] : [])] : [];
    demand(exact(input, ['match', 'sequence', 'commitId', 'committedAt', 'mode', 'events', ...metadataFields]) && validMatch(input.match));
    const fixed = structuredClone(input), { match, sequence, commitId, committedAt, mode, events } = fixed;
    const profile = profileForMatch(match);
    demand(groupMatches({ ...fixed, schemaVersion: fixed.schemaVersion ?? 1 }, match));
    demand(integer(sequence) && sequence > 0 && typeof commitId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(commitId)
      && integer(committedAt) && ['normal', 'capacity', 'resume', 'terminal'].includes(mode)
      && Array.isArray(events) && events.length >= 1 && events.length <= HYAKKI_EVENT_GROUP_MAX_EVENTS);
    events.forEach(event => fixed.schemaVersion===4?demand(!history4EventProblem(event,context4(fixed))):validateHyakkiPublicEvent(event, profile));
    let metadata4;
    if(fixed.schemaVersion===4){
      try{metadata4=encodeHistory4Metadata(fixed.metadata,context4(fixed));}
      catch(error){if(error instanceof RangeError)demand(false);throw error;}
    }
    const base = { schemaVersion: fixed.schemaVersion ?? 1, kind: 'group', roomId: match.roomId, matchId: match.matchId, sequence, commitId, committedAt, mode, events,
      ...([2, 3].includes(fixed.schemaVersion) ? { turn: fixed.turn, sourceCardId: fixed.sourceCardId, changes: fixed.changes, discard: fixed.discard } : {}),
      ...(fixed.schemaVersion === 3 ? { contentVersion: fixed.contentVersion, playerCount: fixed.playerCount } : {}),
      ...(fixed.schemaVersion===4?{contentVersion:fixed.contentVersion,participantIds:fixed.participantIds,
        metadata:metadata4}:{}) };
    const value = { ...base, fingerprint: digest(base) };
    demand(validGroup(value) && committedAt >= match.startedAt && committedAt <= now());
    const seats = new Set(match.participants.map(player => player.seatId));
    demand(events.every(event => Object.entries(event).every(([key, id]) => !key.endsWith('SeatId') || id === null || seats.has(id))));
    if ([2, 3].includes(fixed.schemaVersion)) demand(!publicBattleMetadataProblem({ turn: fixed.turn, sourceCardId: fixed.sourceCardId,
      changes: fixed.changes, discard: fixed.discard }, [...seats], profile) && fixed.turn.round === Math.ceil(fixed.turn.number / seats.size));
    const [head, quota, existing] = await Promise.all([read(HYAKKI_EVENT_SCOPES.meta, headId(match.matchId)), readQuota(), read(HYAKKI_EVENT_SCOPES.events, groupId(match.matchId, sequence))]);
    if(fixed.schemaVersion===4&&isExpansionContentVersion(match.contentVersion)){
      const first=sequence===1?value:(await read(HYAKKI_EVENT_SCOPES.events,groupId(match.matchId,1)))?.value;
      demand(first&&!history4RoleProblem(value,decodeHistory4Metadata(first.metadata,context4(match)).rolesRevealed,context4(match)));
    }
    if (head && !same(head.value.match, match)) fail('GAME_HISTORY_CONFLICT', '比赛历史归属或版本不一致。', 409);
    if (existing) {
      if (!same(existing.value, value) || !head || sequence > head.value.sequence) fail('GAME_HISTORY_CONFLICT', '这个历史序号已经属于另一操作。', 409);
      return { changes: [], guards: [guard(HYAKKI_EVENT_SCOPES.events, groupId(match.matchId, sequence), existing), guard(HYAKKI_EVENT_SCOPES.meta, headId(match.matchId), head)] };
    }
    if (sequence !== (head?.value.sequence ?? 0) + 1 || head && ['terminal', 'pruning'].includes(head.value.phase)) fail('GAME_HISTORY_CONFLICT', '历史步骤已经变化，请确认原操作结果。', 409);
    if (head && committedAt < head.value.lastCommittedAt) demand(false);
    if (!head) demand(mode === 'normal' && events.length === 1 && events[0].type === 'match-started');
    if (mode === 'capacity') demand(head?.value.phase === 'active' && events.length === 1 && events[0].type === 'suspended' && events[0].reason === 'capacity');
    if (mode === 'resume') demand(head?.value.phase === 'capacity-suspended' && events.length === 1 && events[0].type === 'resumed');
    if (mode === 'normal' && head?.value.phase === 'capacity-suspended') fail('GAME_HISTORY_CAPACITY', '历史容量挂起期间不能提交新的经营操作。');
    if (mode === 'terminal') demand(head && events.at(-1).type === 'match-ended'
      && events.filter(event => event.type === 'match-ended').length === 1
      && (events.at(-1).reason === 'normal-close' || events.every(event => ['pending-closed', 'match-ended'].includes(event.type)))
      && committedAt <= Number.MAX_SAFE_INTEGER - HYAKKI_EVENT_RETENTION_MS);
    if (mode !== 'capacity') demand(!events.some(event => event.type === 'suspended' && event.reason === 'capacity'));
    if (mode !== 'terminal') demand(!events.some(event => event.type === 'match-ended'));
    const group = { scope: HYAKKI_EVENT_SCOPES.events, id: groupId(match.matchId, sequence), old: null, value };
    const next = { schemaVersion: 1, kind: 'match', match, phase: mode === 'capacity' ? 'capacity-suspended' : mode === 'terminal' ? 'terminal' : 'active',
      sequence, eventBytes: (head?.value.eventBytes ?? 0) + bytes(group.scope, group.id, value),
      reservedBytes: mode === 'terminal' ? 0 : mode === 'capacity' ? head.value.reservedBytes : HYAKKI_EVENT_FINISH_RESERVE_BYTES,
      lastCommittedAt: committedAt, endedAt: mode === 'terminal' ? committedAt : null,
      retainUntil: mode === 'terminal' ? committedAt + HYAKKI_EVENT_RETENTION_MS : null, prunedThrough: 0 };
    const headEntry = { scope: HYAKKI_EVENT_SCOPES.meta, id: headId(match.matchId), old: head, value: next };
    if (mode === 'capacity') {
      // Spend only the actual encrypted growth; retain the remaining allowance
      // for the terminal group. Fixed-point includes changed decimal widths.
      for (let pass = 0; pass < 20; pass++) {
        const candidate = quotaValue([group, headEntry], quota, next.reservedBytes - head.value.reservedBytes);
        const reserved = head.value.reservedBytes - (candidate.usedBytes - quota.value.usedBytes);
        if (reserved === next.reservedBytes) break;
        next.reservedBytes = reserved;
        if (pass === 19) fail('GAME_HISTORY_CORRUPT');
      }
    }
    validateHyakkiEventRecord(HYAKKI_EVENT_SCOPES.meta, next);
    return plan([group, headEntry], quota, next.reservedBytes - (head?.value.reservedBytes ?? 0));
  }
  async function readPage({ matchId, after = 0, limit = 30 } = {}) {
    demand(HEX32.test(matchId ?? '') && integer(after) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50);
    const head = await read(HYAKKI_EVENT_SCOPES.meta, headId(matchId));
    if (!head) fail('GAME_HISTORY_NOT_FOUND', '没有这局公开历史。', 404);
    if (head.value.phase === 'pruning' || head.value.retainUntil !== null && head.value.retainUntil <= now()) fail('GAME_HISTORY_GONE', '这局公开历史已超过保留期。', 410);
    demand(after <= head.value.sequence);
    // Cover the fixed envelope, commas and cursor digit growth as well as rows.
    const groups = [], guards = [{ ...guard(HYAKKI_EVENT_SCOPES.meta, headId(matchId), head),
      ...(head.value.retainUntil === null ? {} : { validUntil: head.value.retainUntil }) }]; let pageBytes = 1024;
    const first=isConfiguredMatch(head.value.match)&&isExpansionContentVersion(head.value.match.contentVersion)
      ?await read(HYAKKI_EVENT_SCOPES.events,groupId(matchId,1)):null;
    let roster=null;
    if(isConfiguredMatch(head.value.match)&&isExpansionContentVersion(head.value.match.contentVersion)){
      if(!first||!groupMatches(first.value,head.value.match))fail('GAME_HISTORY_CORRUPT');
      roster=roleRoster(first.value,head.value.match);
      if(after>0)guards.push(guard(HYAKKI_EVENT_SCOPES.events,groupId(matchId,1),first));
    }
    for (let sequence = after + 1; sequence <= Math.min(after + limit, head.value.sequence); sequence++) {
      const row = await read(HYAKKI_EVENT_SCOPES.events, groupId(matchId, sequence));
      if (!row || !groupMatches(row.value, head.value.match)) fail('GAME_HISTORY_CORRUPT');
      if(roster&&history4RoleProblem(row.value,roster,context4(head.value.match)))fail('GAME_HISTORY_CORRUPT');
      const { schemaVersion, roomId, matchId: id, sequence: seq, committedAt, events } = row.value;
      const item = { schemaVersion, roomId, matchId: id, sequence: seq, committedAt, events };
      if ([2, 3].includes(schemaVersion)) Object.assign(item, { turn: row.value.turn, sourceCardId: row.value.sourceCardId,
        changes: row.value.changes, discard: row.value.discard });
      if (schemaVersion === 3) Object.assign(item, { contentVersion: row.value.contentVersion, playerCount: row.value.playerCount });
      if(schemaVersion===4)Object.assign(item,{contentVersion:row.value.contentVersion,participantIds:row.value.participantIds,metadata:row.value.metadata});
      const size = Buffer.byteLength(JSON.stringify(item));
      if (pageBytes + size > HYAKKI_EVENT_PAGE_MAX_BYTES) break;
      groups.push(item); pageBytes += size; guards.push(guard(HYAKKI_EVENT_SCOPES.events, groupId(matchId, sequence), row));
    }
    const nextAfter = groups.at(-1)?.sequence ?? after;
    // Internal guards are for the future authenticated HTTP output fence;
    // callers must not serialize this envelope or the private match head.
    return { match: structuredClone(head.value.match), page: { roomId: head.value.match.roomId, matchId, groups, nextAfter,
      headSequence: head.value.sequence, hasMore: nextAfter < head.value.sequence }, guards };
  }
  async function preparePrune({ matchId, limit = 48 } = {}) {
    demand(HEX32.test(matchId ?? '') && Number.isSafeInteger(limit) && limit >= 1 && limit <= 48);
    const [head, quota] = await Promise.all([read(HYAKKI_EVENT_SCOPES.meta, headId(matchId)), readQuota()]);
    if (!head) return { changes: [], guards: [guard(HYAKKI_EVENT_SCOPES.meta, headId(matchId), null)] };
    if (!['terminal', 'pruning'].includes(head.value.phase) || head.value.retainUntil > now()) fail('GAME_HISTORY_RETAINED', '本局公开历史仍需保留。', 409);
    const entries = []; let released = 0, through = head.value.prunedThrough;
    while (through < Math.min(head.value.prunedThrough + limit, head.value.sequence)) {
      const id = groupId(matchId, ++through), saved = await read(HYAKKI_EVENT_SCOPES.events, id);
      if (!saved) fail('GAME_HISTORY_CORRUPT');
      released += saved.bytes; entries.push({ scope: HYAKKI_EVENT_SCOPES.events, id, old: saved, value: null });
    }
    const value = through === head.value.sequence ? null : { ...head.value, phase: 'pruning', prunedThrough: through, eventBytes: head.value.eventBytes - released };
    if (value) validateHyakkiEventRecord(HYAKKI_EVENT_SCOPES.meta, value);
    entries.push({ scope: HYAKKI_EVENT_SCOPES.meta, id: headId(matchId), old: head, value });
    return plan(entries, quota, 0);
  }
  async function sweep() {
    // Maintenance scans metadata once per server sweep, never for a history
    // page. Each transaction stays below the storage's 64-record ceiling.
    const candidates = (await storage.scan(HYAKKI_EVENT_SCOPES.meta)).map(row => row.value)
      .filter(value => value.kind === 'match' && ['terminal', 'pruning'].includes(value.phase) && value.retainUntil <= now())
      .sort((a, b) => a.retainUntil - b.retainUntil || a.match.matchId.localeCompare(b.match.matchId)).slice(0, 4);
    let matches = 0, groups = 0;
    for (const candidate of candidates) {
      const prepared = await preparePrune({ matchId: candidate.match.matchId });
      if (prepared.changes.length && await storage.compareAndSwapMany(prepared)) {
        matches++; groups += prepared.changes.filter(change => change.scope === HYAKKI_EVENT_SCOPES.events).length;
      }
    }
    return { matches, groups };
  }
  function transitionPreparer(projectTransition) {
    if (typeof projectTransition !== 'function') throw new TypeError('A trusted server transition projector is required.');
    return Object.freeze({ scopes: Object.freeze(Object.values(HYAKKI_EVENT_SCOPES)), async prepare(context) {
      const append = await projectTransition(context);
      return append === null ? { changes: [], guards: [] } : prepareAppend(append);
    } });
  }
  return Object.freeze({ prepareAppend, readPage, preparePrune, sweep, transitionPreparer });
}
