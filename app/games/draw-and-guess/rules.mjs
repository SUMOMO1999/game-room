/** Deterministic rules. Callers supply trusted time, first player and frozen words.
 * Authentication, role membership, request receipts, transaction retries,
 * secure sampling and canvas storage are server responsibilities. */
import { DRAW_AND_GUESS_MATCHER_VERSION, drawAndGuessCharacterLength,
  checkDrawAndGuessText, normalizeDrawAndGuessAnswer, normalizeDrawAndGuessGuess } from './matcher.mjs';

export const GAME_TYPE = 'draw-and-guess';
export const RULE_VERSION = 'draw-and-guess-classic-v1';
export const RESOURCE_VERSION = 'dg-tools-v1';
export const STATE_VERSION = 1;
export const DEFAULT_SETTINGS = Object.freeze({ rounds: 2, drawingSeconds: 120 });
export const CHOOSING_MS = 15_000;
export const REVEAL_MS = 8_000;
const stateKeys = ['version','gameType','ruleVersion','matcherVersion','resourceVersion','matchId','players',
  'firstPlayerIndex','turnIndex','turnPlayerId','round','turnNumber','turnId','revision','status','stage','settings',
  'frozenCandidates','selectedWordId','currentGuesses','turnResults','stageClock','lastAction','result'];
const wordKeys = ['id','answer','aliases','category','categoryName','difficulty','language','packId','packVersion',
  'definitionVersion','source','status','hintLength','tags'];
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const array = (value, min, max) => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && value.length >= min && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
  && Array.from({length:value.length}, (_,i)=>i).every(i=>Object.hasOwn(value,i)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value,i),'value'));
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER - 1) => Number.isSafeInteger(value) && value >= min && value <= max;
const identifier = value => typeof value === 'string' && value.length <= 80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
const memberId = value => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 64 && !/\p{C}/u.test(value);
const turnId = number => `dg-turn-${number}`;
const fail = (error, code = 'INVALID_GAME_ACTION') => ({ ok: false, error, code });
// These bounded caches contain only deterministic transforms of immutable
// strings. Room/game validity, membership, time and identity are never cached.
const frozenTextCache = new Map(), frozenSourceCache = new Map();
const FROZEN_TEXT_CACHE_LIMIT = 512;
function cachedFrozenString(cache, value, transform) {
  if (cache.has(value)) return cache.get(value);
  const result = transform(value);
  if (cache.size >= FROZEN_TEXT_CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(value, result);
  return result;
}
const frozenText = value => cachedFrozenString(frozenTextCache, value, text => Object.freeze({
  display: normalizeDrawAndGuessAnswer(text), guess: normalizeDrawAndGuessGuess(text),
  length: drawAndGuessCharacterLength(text),
}));
const frozenSource = value => cachedFrozenString(frozenSourceCache, value, text => {
  checkDrawAndGuessText(text, { maxCharacters: 160, maxBytes: 640 });
  return text === text.normalize('NFC').trim();
});
const same = (a,b) => a === b || (Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every((item,index) => same(item,b[index]))
  : object(a) && object(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b,key) && same(a[key],b[key])));
function clock(stage, settings, now) {
  const durationMs = stage === 'choosing' ? CHOOSING_MS : stage === 'drawing' ? settings.drawingSeconds * 1000 : REVEAL_MS;
  if (!integer(now) || !integer(now + durationMs)) throw new TypeError('服务端时间无效。');
  return { durationMs, remainingMs: durationMs, startedAt: now, deadlineAt: now + durationMs, pausedAt: null };
}
export function settingsProblem(settings) {
  return !exact(settings,['rounds','drawingSeconds']) || !integer(settings.rounds,1,5)
    || !integer(settings.drawingSeconds,30,600) ? '轮数需要1～5，绘画时间需要30～600秒。' : null;
}
export function normalizeSettings(settings = {}) {
  if (!object(settings) || Object.keys(settings).some(key=>!['rounds','drawingSeconds'].includes(key))) throw new TypeError('游戏设置字段无效。');
  const value = { ...DEFAULT_SETTINGS, ...settings }, problem = settingsProblem(value);
  if (problem) throw new TypeError(problem);
  return value;
}
function wordProblem(word) {
  if (!exact(word,wordKeys) || !identifier(word.id) || !identifier(word.category) || !identifier(word.packId)
    || typeof word.packVersion !== 'string' || !word.packVersion.trim() || word.packVersion.length > 128 || /\p{C}/u.test(word.packVersion)
    || !integer(word.definitionVersion,1) || !['easy','normal','hard'].includes(word.difficulty)
    || word.language !== 'zh' || word.status !== 'reviewed' || !array(word.aliases,0,8) || !array(word.tags,0,8)
    || typeof word.source !== 'string' || !word.source.trim() || word.source.length > 640 || /[\p{C}<>]/u.test(word.source)) return '冻结词条定义无效。';
  try {
    if(!frozenSource(word.source)) return '冻结词条来源无效。';
    if (frozenText(word.answer).display !== word.answer
      || frozenText(word.categoryName).display !== word.categoryName
      || word.hintLength !== frozenText(word.answer).length) return '冻结词条文字或提示字数无效。';
    const terms = [word.answer,...word.aliases].map(term=> {
      const normalized = frozenText(term);
      if (normalized.display!==term) throw new Error();
      return normalized.guess;
    });
    if (terms.some(term=>!term) || new Set(terms).size !== terms.length
      || word.tags.some(tag=>frozenText(tag).display!==tag) || new Set(word.tags).size!==word.tags.length) return '冻结词条别名或标签无效。';
  } catch { return '冻结词条文字格式无效。'; }
  return null;
}
// Discard maintenance-only drawing cues. Nothing here imports an answer corpus.
export function freezeCandidates(words) {
  if (!array(words,6,120)) throw new TypeError('冻结候选需要6～120条。');
  const frozen = words.map(word => ({ id:word?.id, answer:word?.answer, aliases:clone(word?.aliases), category:word?.category,
    categoryName:word?.categoryName ?? word?.category, difficulty:word?.difficulty, language:word?.language,
    packId:word?.packId, packVersion:String(word?.packVersion ?? word?.definitionVersion ?? ''), definitionVersion:word?.definitionVersion,
    source:word?.source, status:word?.status, hintLength:word?.hintLength, tags:clone(word?.tags) }));
  const ids=new Set(),terms=new Set();
  for (const word of frozen) {
    const problem=wordProblem(word);if(problem) throw new TypeError(problem);
    if(ids.has(word.id)) throw new TypeError('冻结候选不能重复。');ids.add(word.id);
    for(const term of [word.answer,...word.aliases].map(term=>frozenText(term).guess)) {
      if(terms.has(term)) throw new TypeError('冻结候选不能有答案或别名歧义。');terms.add(term);
    }
  }
  return frozen;
}
export function candidatesForTurn(game, number = game.turnNumber) {
  return game.frozenCandidates.slice((number-1)*3,number*3);
}
export function selectedWord(game) {
  return candidatesForTurn(game).find(word=>word.id===game.selectedWordId) ?? null;
}
export function createGame(playerIds, { settings = {}, rounds, drawingSeconds, firstPlayerIndex = 0,
  frozenCandidates, matchId, now } = {}) {
  if(!array(playerIds,2,8) || playerIds.some(id=>!memberId(id)) || new Set(playerIds).size!==playerIds.length) throw new TypeError('你画我猜需要2～8位不同玩家。');
  const config=normalizeSettings({ ...settings, ...(rounds===undefined?{}:{rounds}), ...(drawingSeconds===undefined?{}:{drawingSeconds}) });
  if(!integer(firstPlayerIndex,0,playerIds.length-1) || typeof matchId!=='string'||!/^[a-f0-9]{32}$/u.test(matchId)) throw new TypeError('首位或对局标识无效。');
  const words=freezeCandidates(frozenCandidates);
  if(words.length!==playerIds.length*config.rounds*3) throw new TypeError('冻结候选数量与人数和轮数不符。');
  return { version:STATE_VERSION,gameType:GAME_TYPE,ruleVersion:RULE_VERSION,matcherVersion:DRAW_AND_GUESS_MATCHER_VERSION,
    resourceVersion:RESOURCE_VERSION,matchId,players:playerIds.map(id=>({id,score:0})),firstPlayerIndex,
    turnIndex:firstPlayerIndex,turnPlayerId:playerIds[firstPlayerIndex],round:1,turnNumber:1,turnId:turnId(1),revision:0,
    status:'playing',stage:'choosing',settings:config,frozenCandidates:words,selectedWordId:null,currentGuesses:[],turnResults:[],
    stageClock:clock('choosing',config,now),lastAction:null,result:null };
}
function guessListProblem(guesses, game, drawerId) {
  if(!array(guesses,0,game.players.length-1) || new Set(guesses.map(guess=>guess?.playerId)).size!==guesses.length) return true;
  return guesses.some(guess=>!exact(guess,['playerId','score','remainingMs']) || guess.playerId===drawerId
    || !game.players.some(player=>player.id===guess.playerId) || !integer(guess.remainingMs,1,game.settings.drawingSeconds*1000)
    || guess.score!==100+Math.floor(100*guess.remainingMs/(game.settings.drawingSeconds*1000)));
}
export function resultFor(game) {
  const maximum=Math.max(...game.players.map(player=>player.score)), noWinners=maximum===0;
  const scores=game.players.map(player=>({ playerId:player.id, score:player.score,
    rank:noWinners?null:1+game.players.filter(other=>other.score>player.score).length }));
  const winnerIds=noWinners?[]:scores.filter(player=>player.rank===1).map(player=>player.playerId);
  return { version:1,reason:noWinners?'no-guesses':'rounds-complete',winnerIds,scores,tie:winnerIds.length>1 };
}
export function gameProblem(game) {
  if(!exact(game,stateKeys) || game.version!==STATE_VERSION || game.gameType!==GAME_TYPE || game.ruleVersion!==RULE_VERSION
    || game.matcherVersion!==DRAW_AND_GUESS_MATCHER_VERSION || game.resourceVersion!==RESOURCE_VERSION
    || typeof game.matchId!=='string'||!/^[a-f0-9]{32}$/u.test(game.matchId) || settingsProblem(game.settings)
    || !array(game.players,2,8) || game.players.some(player=>!exact(player,['id','score'])||!memberId(player.id)||!integer(player.score,0,8000))
    || new Set(game.players.map(player=>player.id)).size!==game.players.length || !integer(game.firstPlayerIndex,0,game.players.length-1)
    || !integer(game.turnNumber,1,game.players.length*game.settings.rounds) || !integer(game.revision)
    || game.turnId!==turnId(game.turnNumber) || game.round!==Math.ceil(game.turnNumber/game.players.length)
    || game.turnIndex!==(game.firstPlayerIndex+game.turnNumber-1)%game.players.length || game.turnPlayerId!==game.players[game.turnIndex].id
    || !['playing','finished'].includes(game.status) || !['choosing','drawing','reveal','finished'].includes(game.stage)
    || (game.status==='finished')!==(game.stage==='finished')) return '你画我猜状态字段或轮序无效。';
  if(!array(game.frozenCandidates,game.players.length*game.settings.rounds*3,game.players.length*game.settings.rounds*3)) return '冻结候选数量无效。';
  try { const frozen=freezeCandidates(game.frozenCandidates);if(!same(frozen,game.frozenCandidates)) return '冻结候选字段无效。'; } catch(error) { return error.message; }
  const revealing=['reveal','finished'].includes(game.stage), total=game.players.length*game.settings.rounds;
  if(game.stage==='choosing' ? game.selectedWordId!==null || !array(game.currentGuesses,0,0) : !selectedWord(game)
    || guessListProblem(game.currentGuesses,game,game.turnPlayerId)) return '当前答案或猜中集合无效。';
  if(game.stage==='drawing' && game.currentGuesses.length===game.players.length-1) return '全员猜中后必须揭晓。';
  if(!array(game.turnResults,game.turnNumber-(revealing?0:1),game.turnNumber-(revealing?0:1))) return '逐题结果数量无效。';
  const sums=new Map(game.players.map(player=>[player.id,0]));
  for(const [index,result] of game.turnResults.entries()) {
    const drawer=game.players[(game.firstPlayerIndex+index)%game.players.length].id;
    if(!exact(result,['turnId','turnNumber','drawerId','wordId','guesses','reason']) || result.turnNumber!==index+1
      || result.turnId!==turnId(index+1) || result.drawerId!==drawer || !candidatesForTurn(game,index+1).some(word=>word.id===result.wordId)
      || !['all-guessed','timeout'].includes(result.reason) || guessListProblem(result.guesses,game,drawer)
      || (result.reason==='all-guessed')!==(result.guesses.length===game.players.length-1)) return '逐题结果定义无效。';
    for(const guess of result.guesses) {sums.set(guess.playerId,sums.get(guess.playerId)+guess.score);sums.set(drawer,sums.get(drawer)+25);}
  }
  if(game.stage==='drawing') for(const guess of game.currentGuesses) {sums.set(guess.playerId,sums.get(guess.playerId)+guess.score);sums.set(game.turnPlayerId,sums.get(game.turnPlayerId)+25);}
  if(revealing && (!same(game.turnResults.at(-1).guesses,game.currentGuesses)||game.turnResults.at(-1).wordId!==game.selectedWordId)) return '揭晓与本题结果不符。';
  if(game.players.some(player=>player.score!==sums.get(player.id))) return '积分与已确认逐题结果不符。';
  if(game.stage==='finished') {
    if(game.turnNumber!==total||game.stageClock!==null||!same(game.result,resultFor(game))) return '完整结算无效。';
  } else {
    const c=game.stageClock,duration=game.stage==='choosing'?CHOOSING_MS:game.stage==='drawing'?game.settings.drawingSeconds*1000:REVEAL_MS;
    if(game.result!==null||!exact(c,['durationMs','remainingMs','startedAt','deadlineAt','pausedAt'])||c.durationMs!==duration
      || !integer(c.remainingMs,1,duration)||!integer(c.startedAt)|| (c.pausedAt===null ? !integer(c.deadlineAt)||c.deadlineAt!==c.startedAt+c.remainingMs
        : !integer(c.pausedAt)||c.pausedAt<c.startedAt||c.remainingMs+c.pausedAt-c.startedAt>duration||c.deadlineAt!==null)) return '阶段期限无效。';
  }
  if(game.lastAction!==null && (!exact(game.lastAction,['type','playerId','turnId','points','correct'])
    || !['choose','guess','timeout'].includes(game.lastAction.type)||!game.players.some(player=>player.id===game.lastAction.playerId)
    || !integer(game.lastAction.points,0,200)||!(game.lastAction.correct===null||typeof game.lastAction.correct==='boolean')
    || !/^dg-turn-[1-9][0-9]*$/u.test(game.lastAction.turnId))) return '最近事件无效。';
  if(game.lastAction!==null) {
    const last=game.lastAction,number=Number(last.turnId.slice(8));
    if(!integer(number,Math.max(1,game.turnNumber-1),game.turnNumber)
      || (last.type==='guess' ? last.correct!==true || !integer(last.points,100,200)
        : last.correct!==null || last.points!==0)) return '最近事件结果无效。';
    const drawer=game.players[(game.firstPlayerIndex+number-1)%game.players.length].id;
    if(last.type==='guess') {
      const guessed=(number===game.turnNumber?game.currentGuesses:game.turnResults[number-1]?.guesses)
        ?.find(guess=>guess.playerId===last.playerId);
      if(!guessed||guessed.score!==last.points) return '最近猜中事件与得分不符。';
    } else if(last.playerId!==drawer||last.type==='choose'&&(number!==game.turnNumber||game.stage==='choosing')) return '最近画者事件无效。';
  } else if(game.stage!=='choosing'||game.turnNumber!==1) {
    return '缺少阶段事件。';
  }
  return null;
}
function activeProblem(game, now, expectedTurnId, stage) {
  const invalid=gameProblem(game);if(invalid) return invalid;
  if(game.status!=='playing'||game.stage!==stage) return '当前阶段不能执行这个操作。';
  if(expectedTurnId!==game.turnId) return '题目已经改变，请读取最新状态。';
  if(game.stageClock.pausedAt!==null) return '对局已暂停。';
  if(!integer(now)||now<game.stageClock.startedAt) return '服务端时间无效。';
  if(now>=game.stageClock.deadlineAt) return '当前阶段已经到期。';
  if(game.revision>=Number.MAX_SAFE_INTEGER-2) return '对局计数已达上限。';
  return null;
}
export function applyChoose(game, playerId, { turnId:expectedTurnId, candidateId } = {}, now) {
  const error=activeProblem(game,now,expectedTurnId,'choosing');if(error) return fail(error);
  if(playerId!==game.turnPlayerId) return fail('只有当前画者可以选词。','DRAWER_REQUIRED');
  if(!candidatesForTurn(game).some(word=>word.id===candidateId)) return fail('只能从本题三个候选中选词。');
  const state=clone(game);state.selectedWordId=candidateId;state.stage='drawing';state.stageClock=clock('drawing',state.settings,now);state.revision++;
  state.lastAction={type:'choose',playerId,turnId:state.turnId,points:0,correct:null};
  return {ok:true,state};
}
function reveal(state, now, reason) {
  state.turnResults.push({turnId:state.turnId,turnNumber:state.turnNumber,drawerId:state.turnPlayerId,
    wordId:state.selectedWordId,guesses:clone(state.currentGuesses),reason});
  state.stage='reveal';state.stageClock=clock('reveal',state.settings,now);
}
export function applyGuess(game, playerId, { turnId:expectedTurnId, text } = {}, now) {
  const error=activeProblem(game,now,expectedTurnId,'drawing');if(error) return fail(error);
  if(!game.players.some(player=>player.id===playerId)||playerId===game.turnPlayerId) return fail('只有本局其他参赛者可以猜词。','GUESSER_REQUIRED');
  if(game.currentGuesses.some(guess=>guess.playerId===playerId)) return fail('本题已经猜中。','ALREADY_GUESSED');
  let normalized;try {normalized=normalizeDrawAndGuessGuess(text);if(!normalized) return fail('请填写答案。','INVALID_GUESS');} catch(error) {return fail(error.message,'INVALID_GUESS');}
  const word=selectedWord(game),correct=[word.answer,...word.aliases].some(term=>normalizeDrawAndGuessGuess(term)===normalized);
  if(!correct) return {ok:true,state:clone(game),guessResult:{correct:false,points:0}};
  const state=clone(game),remainingMs=state.stageClock.deadlineAt-now,points=100+Math.floor(100*remainingMs/(state.settings.drawingSeconds*1000));
  state.currentGuesses.push({playerId,score:points,remainingMs});state.players.find(player=>player.id===playerId).score+=points;
  state.players[state.turnIndex].score+=25;state.revision++;
  state.lastAction={type:'guess',playerId,turnId:state.turnId,points,correct:true};
  if(state.currentGuesses.length===state.players.length-1) reveal(state,now,'all-guessed');
  return {ok:true,state,guessResult:{correct:true,points}};
}
export function applyTimeout(game, { now, expectedTurnId=game?.turnId, expectedStage=game?.stage, candidateIndex } = {}) {
  const invalid=gameProblem(game);if(invalid) return fail(invalid);
  if(game.status!=='playing'||game.turnId!==expectedTurnId||game.stage!==expectedStage||game.stageClock.pausedAt!==null
    || !integer(now)||now<game.stageClock.deadlineAt) return fail('阶段期限或题目已改变。');
  if(game.revision>=Number.MAX_SAFE_INTEGER-2) return fail('对局计数已达上限。');
  const state=clone(game),previousTurn=state.turnId,previousPlayer=state.turnPlayerId;state.revision++;
  if(state.stage==='choosing') {
    if(!integer(candidateIndex,0,2)) return fail('自动选词需要可信随机结果。');
    state.selectedWordId=candidatesForTurn(state)[candidateIndex].id;state.stage='drawing';state.stageClock=clock('drawing',state.settings,now);
  } else if(state.stage==='drawing') reveal(state,now,'timeout');
  else if(state.turnNumber===state.players.length*state.settings.rounds) {
    state.stage='finished';state.status='finished';state.stageClock=null;state.result=resultFor(state);
  } else {
    state.turnNumber++;state.turnId=turnId(state.turnNumber);state.round=Math.ceil(state.turnNumber/state.players.length);
    state.turnIndex=(state.firstPlayerIndex+state.turnNumber-1)%state.players.length;state.turnPlayerId=state.players[state.turnIndex].id;
    state.selectedWordId=null;state.currentGuesses=[];state.stage='choosing';state.stageClock=clock('choosing',state.settings,now);
  }
  state.lastAction={type:'timeout',playerId:previousPlayer,turnId:previousTurn,points:0,correct:null};return {ok:true,state};
}
export function pauseGame(game, now) {
  const invalid=gameProblem(game);if(invalid) return fail(invalid);
  if(game.status!=='playing'||game.stageClock.pausedAt!==null||!integer(now)||now<game.stageClock.startedAt||now>=game.stageClock.deadlineAt) return fail('当前阶段不能暂停。');
  if(game.revision>=Number.MAX_SAFE_INTEGER-2) return fail('对局计数已达上限。');
  const state=clone(game);state.stageClock.remainingMs=state.stageClock.deadlineAt-now;state.stageClock.deadlineAt=null;state.stageClock.pausedAt=now;state.revision++;
  return {ok:true,state};
}
export function resumeGame(game, now) {
  const invalid=gameProblem(game);if(invalid) return fail(invalid);
  if(game.status!=='playing'||game.stageClock.pausedAt===null||!integer(now)||now<game.stageClock.pausedAt
    || !integer(now+game.stageClock.remainingMs)) return fail('当前阶段不能继续。');
  if(game.revision>=Number.MAX_SAFE_INTEGER-2) return fail('对局计数已达上限。');
  const state=clone(game);state.stageClock.startedAt=now;state.stageClock.deadlineAt=now+state.stageClock.remainingMs;state.stageClock.pausedAt=null;state.revision++;
  return {ok:true,state};
}
