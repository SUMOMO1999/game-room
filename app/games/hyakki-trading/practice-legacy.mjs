import {randomStream} from './practice-session.mjs';
/** Device-local practice owns logical time, saved randomness and computer pacing.
 * All materials, decisions and results still belong to the production rules. */
import { createGame, applyGameAction, applyTimeout, gameProblem, currentDecision } from './rules.mjs';
import { privateView } from './view.mjs';
import { chooseHyakkiPracticeAction } from './practice-bot.mjs';
import { DEFAULT_ACTION_LIMIT, DEFAULT_GOODS_PER_TYPE, validActionLimit, validGoodsPerType } from './model.mjs';
import { publicEvent } from './validation.mjs';
import { projectPublicBattleMetadata, publicBattleMetadataProblem } from './battle-public-metadata.mjs';
import { PLAYER_COUNT_CONTENT_VERSION, materialProfileFor } from './content/definitions.mjs';
import { recommendedGoodsPerType } from './content/player-count-profile.mjs';

export const PRACTICE_SELF = '00000000000000000000000000000001';
export const PRACTICE_BOT = '00000000000000000000000000000002';
export const PRACTICE_BOTS = Object.freeze(Array.from({ length: 5 }, (_, index) => (index + 2).toString(16).padStart(32, '0')));
export const PRACTICE_STORAGE_KEY = 'game-room:hyakki-trading:practice:v1';
const SAVE_KEYS = ['version', 'kind', 'matchId', 'logicalNow', 'rngState', 'game'];
export const PRACTICE_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
export const PRACTICE_SAVE_MAX_BYTES = PRACTICE_JOURNAL_MAX_BYTES + 1024 * 1024;
const GAME_MAX_CHARS = 524288, SAVE_MAX_BYTES = PRACTICE_SAVE_MAX_BYTES;
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
const failure = (code, message) => Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const stamp = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 2000000;
const validId = value => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value);
const validSeed = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const validPlayerCount = value => Number.isInteger(value) && value >= 2 && value <= 6;
const practiceIds = count => [PRACTICE_SELF, ...PRACTICE_BOTS.slice(0, count - 1)];
function savedProblem(saved) {
  if (!plain(saved) || !exactKeys(saved, [...SAVE_KEYS, ...(Object.hasOwn(saved, 'journal') ? ['journal'] : []),
    ...(Object.hasOwn(saved, 'configuration') ? ['configuration'] : [])]) || ![1, 2].includes(saved.version) || saved.kind !== 'hyakki-local-practice'
      || !validId(saved.matchId) || !stamp(saved.logicalNow) || !validSeed(saved.rngState)) return '练习存档版本或字段无效。';
  const issue = gameProblem(saved.game); if (issue) return issue;
  if (JSON.stringify(saved.game).length > GAME_MAX_CHARS) return '练习牌局内容超出保存上限。';
  const game = saved.game;
  if (game.matchId !== saved.matchId || game.committedAt > saved.logicalNow || game.lifecycle.startedAt !== 0
      || !validPlayerCount(game.players.length) || game.players.some((player, index) => player.id !== practiceIds(game.players.length)[index])
      || saved.version !== game.version || saved.version === 1 && game.players.length !== 2
      || game.lifecycle.manual || game.lifecycle.absence || game.lifecycle.capacity
      || !['playing', 'finished'].includes(game.status)) return '本机练习身份、时间或牌局归属无效。';
  if (Object.hasOwn(saved, 'journal') && journalProblem(saved.journal, game)) return '练习公开战况无效。';
  if (Object.hasOwn(saved, 'configuration')) {
    const config = saved.configuration;
    if (game.contentVersion !== PLAYER_COUNT_CONTENT_VERSION
      || !exactKeys(config, ['playerCount', 'actionLimit', 'goodsPerType', 'goodsSupplyMode'])
      || config.playerCount !== game.players.length || config.actionLimit !== game.actionLimit
      || config.goodsPerType !== game.goodsPerType || !['recommended', 'custom'].includes(config.goodsSupplyMode)
      || config.goodsSupplyMode === 'recommended' && config.goodsPerType !== recommendedGoodsPerType(config.playerCount)) return '练习设置与冻结牌局不一致。';
  }
  return null;
}
function journalProblem(journal, game) {
  if (!exactKeys(journal, ['schema', 'matchId', 'startSequence', 'firstTurn', 'partialStart', 'groups']) || journal.schema !== 1
    || journal.matchId !== game.matchId || !stamp(journal.startSequence) || journal.startSequence < 1
    || typeof journal.partialStart !== 'boolean' || !Array.isArray(journal.groups) || journal.groups.length > 100000
    || !exactKeys(journal.firstTurn, ['id', 'number', 'round', 'ownerId']) || !stamp(journal.firstTurn.number)
    || journal.firstTurn.number < 1 || journal.firstTurn.id !== `turn-${journal.firstTurn.number}`
    || journal.firstTurn.round !== Math.ceil(journal.firstTurn.number / game.players.length)
    || journal.firstTurn.number > game.turnNumber
    || !game.players.some(player => player.id === journal.firstTurn.ownerId)) return true;
  const ids = game.players.map(player => player.id);
  const profile = materialProfileFor(game), modern = game.contentVersion === PLAYER_COUNT_CONTENT_VERSION;
  if (journal.groups.some((group, index) => !exactKeys(group,
    ['schemaVersion', 'sequence', 'committedAt', 'events', 'turn', 'sourceCardId', 'changes', 'discard', ...(modern ? ['contentVersion', 'playerCount'] : [])])
    || group.schemaVersion !== (modern ? 3 : 2)
    || modern && (group.contentVersion !== game.contentVersion || group.playerCount !== game.players.length)
    || group.sequence !== journal.startSequence + index || !stamp(group.committedAt)
    || group.committedAt > game.committedAt || index > 0 && group.committedAt < journal.groups[index - 1].committedAt
    || group.turn?.number > game.turnNumber || group.turn?.round !== Math.ceil(group.turn?.number / ids.length) || !Array.isArray(group.events) || !group.events.length || group.events.length > 64
    || group.events.some(event => !publicEvent(event, ids, game.goodsPerType ?? 6, profile))
    || publicBattleMetadataProblem({ turn: group.turn, sourceCardId: group.sourceCardId, changes: group.changes, discard: group.discard }, ids, profile)
    || bytes(group) > 32768)) return true;
  if (journal.groups.length && (journal.groups[0].turn.id !== journal.firstTurn.id
    || journal.groups[0].turn.ownerSeatId !== journal.firstTurn.ownerId)) return true;
  return journal.groups.length ? journal.groups.at(-1).sequence !== game.publicEventSequence
    : journal.startSequence !== game.publicEventSequence + 1;
}
function journalStart(game, includeStart = false) {
  const journal = { schema: 1, matchId: game.matchId, startSequence: game.publicEventSequence + (includeStart ? 0 : 1),
    firstTurn: { id: game.turnId, number: game.turnNumber, round: game.round, ownerId: game.turnPlayerId },
    partialStart: !includeStart, groups: [] };
  if (includeStart) journal.groups.push({ ...eventContext(game), sequence: game.publicEventSequence, committedAt: game.committedAt,
    events: structuredClone(game.lastPublicEvents), ...projectPublicBattleMetadata(null, game) });
  return journal;
}
export function decodeHyakkiPractice(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > SAVE_MAX_BYTES || bytes(raw) > SAVE_MAX_BYTES) return null;
    const saved = JSON.parse(raw); return savedProblem(saved) || saved.journal && bytes(saved.journal) > PRACTICE_JOURNAL_MAX_BYTES ? null : saved;
  } catch { return null; }
}
export function encodeHyakkiPractice(saved) {
  const issue = savedProblem(saved); if (issue) throw failure('PRACTICE_SAVE_INVALID', issue);
  const text = JSON.stringify(saved);
  if (saved.journal && bytes(saved.journal) > PRACTICE_JOURNAL_MAX_BYTES || bytes(text) > SAVE_MAX_BYTES)
    throw failure('PRACTICE_SAVE_CAPACITY', '完整战况达到本机保存上限；本页保留全部进度，关闭后只能恢复此前成功保存的进度。');
  return text;
}

const eventContext = game => game.contentVersion === PLAYER_COUNT_CONTENT_VERSION
  ? { schemaVersion: 3, contentVersion: game.contentVersion, playerCount: game.players.length } : { schemaVersion: 2 };
function fresh({ actionLimit, goodsPerType, goodsSupplyMode, playerCount, seed, requestId }) {
  if (goodsSupplyMode === undefined) goodsSupplyMode = goodsPerType === undefined ? 'recommended' : 'custom';
  if (!validPlayerCount(playerCount) || !['recommended', 'custom'].includes(goodsSupplyMode)
    || goodsPerType !== undefined && !validGoodsPerType(goodsPerType)) throw failure('PRACTICE_OPTIONS_INVALID', '本机练习配置无效。');
  if (goodsSupplyMode === 'recommended') goodsPerType = recommendedGoodsPerType(playerCount);
  if (!validActionLimit(actionLimit) || !validGoodsPerType(goodsPerType) || !validPlayerCount(playerCount)) throw failure('PRACTICE_OPTIONS_INVALID', '人数需要在2至6人之间，行动数1至10，每类货物4至20。');
  const matchId = requestId(); if (!validId(matchId)) throw failure('PRACTICE_ID_INVALID', '练习编号无效。');
  const initial = seed ?? (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  if (!validSeed(initial)) throw failure('PRACTICE_RANDOM_INVALID', '练习随机种子无效。');
  const ids = practiceIds(playerCount), random = randomStream(initial), firstPlayerId = ids[random.randomInt(playerCount)];
  const game = createGame(ids, { matchId, now: 0, actionLimit, goodsPerType, firstPlayerId, randomInt: random.randomInt });
  return { version: 2, kind: 'hyakki-local-practice', matchId, logicalNow: 0, rngState: random.state, game, journal: journalStart(game, true),
    configuration: { playerCount, actionLimit, goodsPerType, goodsSupplyMode } };
}
const actor = game => currentDecision(game)?.actorId ?? game.turnPlayerId;
const clock = game => game.timing.decision ?? game.timing.active;
const commandFields = {
  peek: [], 'finish-draw': [], 'keep-peek': [], 'discard-peek': [], 'end-turn': [], 'decline-response': [], 'pass-bid': [],
  buy: ['cardId'], sell: ['cardId'], 'buy-stall': ['cardId'], respond: ['cardId'],
  'play-character': ['cardId', 'params?'], 'activate-tool': ['cardId', 'params?'],
  'install-tool': ['cardId', 'replaceCardId?'], 'choose-effect': ['selection'], bid: ['amount'],
};
function validFields(type, fields) {
  const keys = typeof type === 'string' && Object.hasOwn(commandFields, type) ? commandFields[type] : null;
  return keys && plain(fields) && keys.filter(key => !key.endsWith('?')).every(key => Object.hasOwn(fields, key))
    && Object.keys(fields).every(key => keys.includes(key) || keys.includes(`${key}?`));
}


export const legacyPracticeRuntime={fresh,decode:decodeHyakkiPractice,encode:encodeHyakkiPractice,currentDecision,clock,privateView,
  applyGameAction,applyTimeout,chooseAction:chooseHyakkiPracticeAction,actor,validFields,PRACTICE_SELF,PRACTICE_BOTS,
  restartFields:['actionLimit','goodsPerType','goodsSupplyMode','playerCount'],
  context:(game,decision)=>({matchId:game.matchId,turnId:game.turnId,expectedRevision:game.revision,
    ...(game.pending?{effectId:game.pending.id,decisionId:decision?.id}:{})}),
  transition(saved,game,rngState,logicalNow){const journal=saved.journal??journalStart(saved.game);
    const group={...eventContext(game),sequence:game.publicEventSequence,committedAt:game.committedAt,
      events:structuredClone(game.lastPublicEvents),...projectPublicBattleMetadata(saved.game,game)};
    return {...saved,game,rngState,logicalNow,journal:{...journal,groups:[...journal.groups,group]}};},
  history(saved,{after,limit}){const journal=saved.journal??journalStart(saved.game),groups=[];let size=1024;
    for(const group of journal.groups.filter(item=>item.sequence>after).slice(0,limit)){const count=bytes(group);if(size+count>256*1024)break;groups.push(structuredClone(group));size+=count;}
    const nextAfter=groups.at(-1)?.sequence??Math.min(saved.game.publicEventSequence,Math.max(after,journal.startSequence-1));
    return {roomId:'hyakki-local-practice',matchId:saved.matchId,groups,nextAfter,headSequence:saved.game.publicEventSequence,
      hasMore:nextAfter<saved.game.publicEventSequence,coverage:{startSequence:journal.startSequence,firstTurn:structuredClone(journal.firstTurn),partialStart:journal.partialStart}};
  },
};
