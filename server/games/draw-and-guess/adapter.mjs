/** Server assembly and private projection. Never serve this module over HTTP. */
import { randomInt as secureRandomInt } from 'node:crypto';
import * as core from '../../../app/games/draw-and-guess/rules.mjs';
import { normalizeDrawAndGuessGuess, normalizeDrawAndGuessChat } from '../../../app/games/draw-and-guess/matcher.mjs';
import { problem, publicFields } from '../adapter-contract.mjs';

const gameType = core.GAME_TYPE;
const actions = Object.freeze({ choose: Object.freeze(['matchId','turnId','candidateId']),
  guess: Object.freeze(['matchId','turnId','text']) });
const fields = ['version','ruleVersion','matcherVersion','resourceVersion','matchId','players','firstPlayerIndex',
  'turnIndex','turnPlayerId','round','turnNumber','turnId','revision','status','stage','settings','stageClock','result'];
const otherGameFields = ['jokerConfig','jokerCount','copies','deckCopies','deckSize','tileCount','boardPositions','assignment'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys = (value,allowed) => object(value) && Reflect.ownKeys(value).every(key => allowed.includes(key)
  && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
const array = (value,min,max) => Array.isArray(value) && Object.getPrototypeOf(value)===Array.prototype
  && value.length>=min && value.length<=max && Reflect.ownKeys(value).length===value.length+1
  && Array.from({length:value.length},(_,index)=>index).every(index=>Object.hasOwn(value,index)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value,index),'value'));
const integer = (value,min=0,max=Number.MAX_SAFE_INTEGER-1) => Number.isSafeInteger(value) && value>=min && value<=max;
const identifier = value => typeof value==='string' && value.length<=80 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
const idProblem = id => typeof id!=='string' || id.trim()!==id || !id.length || id.length>64 || /\p{C}/u.test(id);
const sameIds = (left,right) => left.length===right.length && left.every((id,index)=>id===right[index]);
const fail = (error,code='INVALID_GAME_ACTION') => ({ok:false,error,code});
const membersProblem = players => !Array.isArray(players) || players.length<1 || players.length>8
  || players.some(player=>!player||idProblem(player.id)) || new Set(players.map(player=>player.id)).size!==players.length;
const nameProblem = name => typeof name!=='string' || name!==name.normalize('NFC').trim()
  || [...name].length<1 || [...name].length>16 || /\p{Cc}/u.test(name);

function selectionProblem(selection) {
  if(!keys(selection,['packId','version','categoryIds','difficulties']) || Object.keys(selection).length!==4
    || !identifier(selection.packId) || !integer(selection.version,1)
    || !array(selection.categoryIds,1,64)
    || selection.categoryIds.some(id=>!identifier(id)) || new Set(selection.categoryIds).size!==selection.categoryIds.length
    || !array(selection.difficulties,1,3)
    || selection.difficulties.some(value=>!['easy','normal','hard'].includes(value))
    || new Set(selection.difficulties).size!==selection.difficulties.length) return '请选择一个发布词包、至少一个分类和一种难度。';
  return null;
}
export function drawConfigProblem(config,{allowUnselected=true}={}) {
  if(!keys(config,['rounds','drawingSeconds','contentSelection']) || Object.keys(config).length!==3) return '你画我猜设置字段无效。';
  const invalid=core.settingsProblem({rounds:config.rounds,drawingSeconds:config.drawingSeconds});if(invalid) return invalid;
  return config.contentSelection===null && allowUnselected ? null : selectionProblem(config.contentSelection);
}
function actionProblem(action) {
  if(!object(action)||!Object.hasOwn(actions,action.type)) return problem(400,'INVALID_ACTION','你画我猜操作格式无效。');
  if(!keys(action,['type','requestId','expectedRevision',...actions[action.type]])
    || typeof action.matchId!=='string'||!/^[a-f0-9]{32}$/u.test(action.matchId)
    || typeof action.turnId!=='string'||!/^dg-turn-[1-9][0-9]{0,2}$/u.test(action.turnId)) return problem(400,'INVALID_ACTION','操作需要有效对局和题目编号。');
  if(action.type==='choose'&&!identifier(action.candidateId)) return problem(400,'INVALID_ACTION','请选择一个有效候选词。');
  if(action.type==='guess') {
    try {if(!normalizeDrawAndGuessGuess(action.text)) throw new Error('请填写答案。');}
    catch(error) {return problem(400,'INVALID_GUESS',error.message);}
  }
  return null;
}
function randomIndex(source,maximum) {
  if(source===undefined) source=secureRandomInt;
  if(typeof source!=='function') throw new Error('服务端随机源无效。');
  let value;try {value=source(maximum);} catch {throw new Error('服务端随机暂时不可用。');}
  if(!integer(value,0,maximum-1)) throw new Error('服务端随机结果无效。');
  return value;
}
const wordDisplay = word => ({answer:word.answer,aliases:[...word.aliases],categoryName:word.categoryName,
  difficulty:word.difficulty,hintLength:word.hintLength});
function projection(game,playerId,observer,context={}) {
  const invalid=core.gameProblem(game);if(invalid) throw new Error(invalid);
  if(!observer&&!game.players.some(player=>player.id===playerId)) throw new Error('你不是本局参赛玩家。');
  const at=context.now ?? Date.now(),running=(context.phase??'playing')==='playing' && game.status==='playing'
    && game.stageClock?.pausedAt===null && integer(at) && at>=game.stageClock.startedAt && at<game.stageClock.deadlineAt;
  const drawer=!observer && game.turnPlayerId===playerId;
  const view=publicFields(game,fields,gameType,{...(observer?{}:{playerId}),
    totalTurns:game.players.length*game.settings.rounds,guessedPlayerIds:game.currentGuesses.map(guess=>guess.playerId),
    canChoose:running&&drawer&&game.stage==='choosing',canDraw:running&&drawer&&game.stage==='drawing',
    canGuess:running&&!observer&&!drawer&&game.stage==='drawing'&&!game.currentGuesses.some(guess=>guess.playerId===playerId)});
  // Public action events never contain a word ID or guessed text. All guesses
  // are accepted privately; only successful participants become public events.
  view.lastAction=game.lastAction===null?null:{...game.lastAction};
  if(game.stage==='choosing'&&drawer) view.candidates=core.candidatesForTurn(game)
    .map(word=>({id:word.id,answer:word.answer,categoryName:word.categoryName,difficulty:word.difficulty,hintLength:word.hintLength}));
  const word=core.selectedWord(game);
  if(word) {
    view.hint={categoryName:word.categoryName,hintLength:word.hintLength};
    if(drawer||['reveal','finished'].includes(game.stage)) view.word=wordDisplay(word);
  }
  if(['reveal','finished'].includes(game.stage)) view.turnResult={reason:game.turnResults.at(-1).reason,
    scores:game.currentGuesses.map(guess=>({playerId:guess.playerId,score:guess.score})),drawerScore:game.currentGuesses.length*25};
  return view;
}
export function drawingGameClock(game) {
  const invalid=core.gameProblem(game);if(invalid) throw new Error(invalid);
  if(game.status==='finished') return null;
  return {key:`${game.matchId}:${game.turnId}:${game.stage}`,...structuredClone(game.stageClock)};
}
function roomStateProblem(room,hasRoles) {
  if(!object(room)||room.gameType!==gameType||!hasRoles||membersProblem(room.players)||!Array.isArray(room.spectators)
    || room.spectators.length>8||room.spectators.some(member=>!member||idProblem(member.id))
    || new Set([...room.players,...room.spectators].map(member=>member.id)).size!==room.players.length+room.spectators.length
    || otherGameFields.some(field=>Object.hasOwn(room,field))||!Object.hasOwn(room,'turnClock')
    || !['waiting','playing','paused','finished','aborted'].includes(room.phase)||drawConfigProblem(room.drawConfig)) return '你画我猜房间、成员或设置无效。';
  if(room.phase==='waiting') return room.game!==null||room.turnClock!==null
    || ['matchId','matchStartedAt','matchEndedAt','matchParticipants','abortedResult'].some(field=>Object.hasOwn(room,field))
    ? '等待房间不能保留已开局状态。' : null;
  const invalid=core.gameProblem(room.game);if(invalid) return invalid;
  const game=room.game,gameIds=game.players.map(player=>player.id),roomIds=room.players.map(player=>player.id);
  if(game.status!==(room.phase==='finished'?'finished':'playing')||room.matchId!==game.matchId
    || (['playing','paused'].includes(room.phase)?!sameIds(roomIds,gameIds):!sameIds(roomIds,gameIds.filter(id=>roomIds.includes(id))))
    || room.spectators.some(member=>gameIds.includes(member.id))
    || !integer(room.matchStartedAt)||!Array.isArray(room.matchParticipants)||!sameIds(room.matchParticipants.map(member=>member?.playerId),gameIds)
    || room.matchParticipants.some(member=>!keys(member,['playerId','name','userKey'])||nameProblem(member.name)
      || Object.hasOwn(member,'userKey')&&!/^[a-f0-9]{64}$/u.test(member.userKey))) return '本局标识、参与者和阶段不符。';
  const userKeys=room.matchParticipants.filter(member=>Object.hasOwn(member,'userKey')).map(member=>member.userKey);
  if(new Set(userKeys).size!==userKeys.length) return '同一账号不能占用两个席位。';
  for(const member of room.players) {
    const saved=room.matchParticipants.find(entry=>entry.playerId===member.id);
    if(saved.name!==member.name||saved.userKey!==member.userKey) return '比赛参与者与原席位不符。';
  }
  if(room.drawConfig.rounds!==game.settings.rounds||room.drawConfig.drawingSeconds!==game.settings.drawingSeconds
    || drawConfigProblem(room.drawConfig,{allowUnselected:false})
    || game.frozenCandidates.some(word=>word.packId!==room.drawConfig.contentSelection.packId
      || word.packVersion!==String(room.drawConfig.contentSelection.version)
      || !room.drawConfig.contentSelection.categoryIds.includes(word.category)
      || !room.drawConfig.contentSelection.difficulties.includes(word.difficulty))) return '开局设置与冻结候选不符。';
  const terminal=['finished','aborted'].includes(room.phase);
  if(terminal ? !integer(room.matchEndedAt)||room.matchEndedAt<room.matchStartedAt||room.turnClock!==null
    : Object.hasOwn(room,'matchEndedAt')||!object(room.turnClock)) return '比赛期限与结束时间不符。';
  if(!terminal) {
    const {key,...clock}=drawingGameClock(game);
    const expected={version:2,...clock,stageKey:key,firstPlayerId:game.players[game.firstPlayerIndex].id,
      matchId:game.matchId,round:game.round,playerId:game.turnPlayerId};
    if(Object.keys(expected).some(key=>room.turnClock[key]!==expected[key])||Object.keys(room.turnClock).length!==Object.keys(expected).length
      || (room.phase==='paused')!==(game.stageClock.pausedAt!==null)) return '房间与游戏阶段时钟不符。';
  }
  if(room.phase==='aborted') {
    const r=room.abortedResult;
    if(!keys(r,['reason','winnerIds','scores','tie','aborted'])||Object.keys(r).length!==5||typeof r.reason!=='string'||!r.reason||r.reason.length>80
      ||r.aborted!==true||r.tie!==false||!Array.isArray(r.winnerIds)||r.winnerIds.length||!Array.isArray(r.scores)||r.scores.length) return '中止对局不能保存输赢。';
  } else if(Object.hasOwn(room,'abortedResult')) return '非中止对局不能保存中止结果。';
  return null;
}
export function createDrawAndGuessAdapter() {
  return Object.freeze({gameType,minPlayers:2,maxPlayers:8,ruleVersions:Object.freeze([core.RULE_VERSION]),
    historySchemaVersion:2,historyPlayerFields:Object.freeze(['score','rank']),
    usesActionIntents:true,concurrentActionTypes:Object.freeze(['guess']),actionTypes:Object.freeze(Object.keys(actions)),
    configurationFields:Object.freeze(['drawConfig']),
    createGame(players,options) {return core.createGame(players.map(player=>player?.id),options);},
    privateView:(game,playerId,context)=>projection(game,playerId,false,context),
    spectatorView:(game,context)=>projection(game,null,true,context),stateProblem:core.gameProblem,
    receiptResultProblem:result=>!keys(result,['correct','points'])||Object.keys(result).length!==2
      ||typeof result.correct!=='boolean'||(result.correct?!integer(result.points,100,200):result.points!==0),
    actionFields:type=>Object.hasOwn(actions,type)?actions[type]:null,
    validateAction:action=>object(action)&&!Object.hasOwn(actions,action.type)?null:actionProblem(action),
    applyGameAction(game,playerId,action,context={}) {
      const invalid=actionProblem(action);if(invalid) return fail(invalid.message,invalid.code);
      if(action.matchId!==game?.matchId) return fail('对局已经改变，请读取最新状态。','MATCH_CHANGED');
      if((context.phase??'playing')!=='playing') return fail('当前房间不能提交游戏操作。','GAME_NOT_PLAYING');
      const at=context.now ?? Date.now();
      return action.type==='choose'?core.applyChoose(game,playerId,action,at):core.applyGuess(game,playerId,action,at);
    },
    configurationSupportProblem:()=>null,
    rematchRoomUpdates(room, options) {
      return {drawConfig:structuredClone(options.drawRematchConfig ?? room.drawConfig)};
    },
    configure(room,input) {
      const invalid=drawConfigProblem(input?.drawConfig);
      return invalid?{problem:problem(400,'INVALID_CONFIG',invalid)}:{updates:{drawConfig:structuredClone(input.drawConfig)}};
    },
    roomView:room=>({drawConfig:structuredClone(room.drawConfig)}),
    gameOptions(room,options={}) {
      if(!room||room.gameType!==gameType||room.phase!=='waiting'||room.game!==null||membersProblem(room.players)||room.players.length<2) throw new Error('请先准备有效的你画我猜等待房间。');
      const invalid=drawConfigProblem(room.drawConfig,{allowUnselected:false});if(invalid) throw new Error(invalid);
      // Only the server content service supplies this pre-sampled frozen pool.
      // HTTP configuration/action schemas never accept candidate definitions.
      const words=core.freezeCandidates(options.frozenCandidates);
      const required=room.players.length*room.drawConfig.rounds*3,s=room.drawConfig.contentSelection;
      if(words.length!==required||words.some(word=>word.packId!==s.packId||word.packVersion!==String(s.version)
        ||!s.categoryIds.includes(word.category)||!s.difficulties.includes(word.difficulty))) throw new Error('冻结抽词池与本局设置不符。');
      const settings={rounds:room.drawConfig.rounds,drawingSeconds:room.drawConfig.drawingSeconds};
      // Check every deterministic dependency before consuming the first-player
      // sample. Client firstPlayerIndex/random/seed never enter the option seam.
      core.createGame(room.players.map(player=>player.id),{settings,frozenCandidates:words,firstPlayerIndex:0,matchId:options.matchId,now:options.now});
      return {settings,frozenCandidates:words,matchId:options.matchId,now:options.now,
        firstPlayerIndex:randomIndex(options.serverRandomInt,room.players.length)};
    },
    roomDefaults:()=>({drawConfig:{...core.DEFAULT_SETTINGS,contentSelection:null},turnClock:null}),
    playersChanged(room) {if(room.phase==='waiting') for(const member of room.players) member.ready=false;},
    turnTimeoutMs:()=>core.CHOOSING_MS,gameClock:drawingGameClock,
    onPhaseChanged(game,phase,now) {
      if(phase==='paused') return game.stageClock?.pausedAt!==null?{ok:true,state:structuredClone(game)}:core.pauseGame(game,now);
      if(phase==='playing') return game.stageClock?.pausedAt===null?{ok:true,state:structuredClone(game)}:core.resumeGame(game,now);
      return {ok:true,state:structuredClone(game)};
    },
    playerSummary(view,playerId) {
      const player=view?.players?.find(entry=>entry.id===playerId);
      return player?{score:player.score,hasGuessed:view.guessedPlayerIds.includes(playerId),drawing:view.turnPlayerId===playerId}:{};
    },
    playerResult(result,playerId) {
      if(!result||result.aborted) return {outcome:'unscored',score:null,rank:null};
      const score=result.scores.find(entry=>entry.playerId===playerId);
      if(!score) return {outcome:'unscored',score:null,rank:null};
      return {outcome:!result.winnerIds.length?'unscored':result.winnerIds.includes(playerId)?result.tie?'draw':'win':'loss',score:score.score,rank:score.rank};
    },
    describeAction({action,player,afterGame,guessResult}) {
      if(action.type==='choose') return `${player.name}开始绘画。`;
      if(action.type==='guess'&&guessResult?.correct) return `${player.name}猜中了，加${guessResult.points}分。`;
      return null;
    },
    chatProblem(game,text) {
      const invalid=core.gameProblem(game);if(invalid) return problem(503,'GAME_UNAVAILABLE','本局状态暂时无法确认。');
      if(game.stage!=='drawing') return null;
      try {
        const normalized=normalizeDrawAndGuessChat(text),word=core.selectedWord(game);
        return [word.answer,...word.aliases].map(normalizeDrawAndGuessGuess).some(term=>normalized.includes(term))
          ? problem(400,'ANSWER_IN_CHAT','这条消息涉及本题答案，请用猜词框或等揭晓后再聊。'):null;
      } catch {return problem(400,'INVALID_CHAT','聊天内容格式无效。');}
    },
    supportsTimeout:game=>core.gameProblem(game)===null&&game.status==='playing',
    applyTimeout(game,playerId,context={}) {
      if(game?.turnPlayerId!==playerId) return fail('当前画者已经改变。');
      const invalid=core.gameProblem(game);if(invalid) return fail(invalid);
      const at=context.now??Date.now();
      if(context.matchId!==undefined&&context.matchId!==game.matchId) return fail('对局已经改变。');
      if(context.turnId!==undefined&&context.turnId!==game.turnId||context.stage!==undefined&&context.stage!==game.stage) return fail('题目或阶段已经改变。');
      if(game.status!=='playing'||game.stageClock.pausedAt!==null||!integer(at)||at<game.stageClock.deadlineAt) return fail('当前阶段尚未到期。');
      let candidateIndex;
      if(game.stage==='choosing') {try{candidateIndex=randomIndex(context.serverRandomInt,3);}catch(error){return fail(error.message);}}
      return core.applyTimeout(game,{now:at,expectedTurnId:context.turnId??game.turnId,expectedStage:context.stage??game.stage,candidateIndex});
    },
    describeTimeout:(game,player)=>game.stage==='choosing'?`${player.name}选词时间已到，开始绘画。`
      :game.stage==='drawing'?'绘画时间已到，本题揭晓。':'揭晓结束，继续下一题。',
    snapshotSchema:()=>10,
    snapshotProblem:data=>data?.schemaVersion!==10||data.gameType!==gameType||!Object.hasOwn(data,'drawConfig')
      ||!Object.hasOwn(data,'turnClock')||data.game!==null&&data.game?.ruleVersion!==core.RULE_VERSION,
    roomStateProblem,
    historyPlayerProblem:(status,player)=>Object.hasOwn(player,'remainingPoints')
      || (status==='aborted'?player.outcome!=='unscored'||player.score!==null||player.rank!==null
        :!integer(player.score,0,8000)||(player.rank===null?player.score!==0||player.outcome!=='unscored':!integer(player.rank,1,8)
          ||player.rank===1&&!['win','draw'].includes(player.outcome)||player.rank>1&&player.outcome!=='loss')),
    historyOutcomeProblem:(wins,draws,count)=>!integer(count,2,8)||!((wins===1&&draws===0)||(wins===0&&draws>=2&&draws<=count)||(wins===0&&draws===0)),
  });
}
