import { SIDES, boardPosition } from './board.mjs';

// Public, pure presentation. This module consumes saved projections; it never
// derives permissions by running rules, rolls dice, or reads device storage.
const sideById = new Map(SIDES.map(side => [side.id, side]));
const validDie = value => Number.isInteger(value) && value >= 1 && value <= 6;
const list = value => Array.isArray(value) ? value : [];
const sameMember = (view, id) => list(view?.players).find(player => player?.id === id);
const playerName = (view, id) => sameMember(view, id)?.name
  || list(view?.matchPlayers).find(player => player?.id === id)?.name || (id === view?.selfId ? '你' : '朋友');

export function flyingSideLabel(side) { return sideById.get(side)?.label || '未分阵营'; }

function positionLabel(plane) {
  if (plane.progress === -2) return '机库 · 六点起飞';
  if (plane.progress === -1) return '起飞点';
  if (plane.progress === 55) return '已完成';
  if (plane.progress >= 50) return `归航 H${plane.progress - 49}`;
  try { return `环道 ${boardPosition(plane.side, plane.progress, plane.number).id}`; }
  catch { return '位置暂不可用'; }
}

function publicLastAction(view) {
  const action = view?.game?.lastAction;
  if (!action) return '';
  const name = playerName(view, action.playerId);
  if (action.type === 'roll' && validDie(action.die)) {
    return `${name}掷出 ${action.die} 点${action.outcome === 'no-move' ? '，没有可行动的飞机，已换下一位。' : '，正在选机。'}`;
  }
  if (action.type === 'move') {
    const route = action.route;
    return `${name}确认移动。${typeof route?.description === 'string' ? route.description : ''}${action.outcome === 'six-again' ? '六点奖励，继续掷骰。' : ''}`;
  }
  if (action.type === 'timeout') {
    return `${name}回合时间已到${validDie(action.discardedDie) ? `，未使用的 ${action.discardedDie} 点已弃掉` : ''}，已换下一位。`;
  }
  return '';
}

function resultText(view) {
  const result = view?.game?.result;
  if (view?.phase === 'aborted' || result?.aborted) return '有玩家退出房间，本局中止，所有人不计输赢。';
  if (view?.phase !== 'finished' && view?.game?.status !== 'finished') return '';
  const winner = list(result?.winnerIds)[0];
  return winner ? `${playerName(view, winner)}的四架飞机全部完成，赢得本局。` : '本局已经结束。';
}

function routeMatches(route, plane, die) {
  return route && plane && route.planeId === plane.id && route.side === plane.side
    && route.from === plane.progress && route.die === die && Number.isInteger(route.to)
    && route.to >= -1 && route.to <= 55 && Array.isArray(route.segments)
    && Array.isArray(route.landings) && Array.isArray(route.capturedIds)
    && typeof route.description === 'string';
}

/** Permissions come exclusively from the owning room/practice projection. */
export function flyingModel(view, { selectedId = null, busy = false, pending = false } = {}) {
  const game = view?.game, phase = view?.phase || 'loading';
  const players = list(game?.players), self = players.find(player => player?.id === view?.selfId);
  const selfSide = self?.side || list(view?.sideAssignments).find(item => item?.playerId === view?.selfId)?.side || null;
  const playing = phase === 'playing' && game?.status === 'playing';
  const ownTurn = playing && view?.selfRole === 'player' && Boolean(self)
    && game?.playerId === view?.selfId && game.turnPlayerId === view.selfId;
  const interaction = ownTurn && !busy && !pending;
  const canRoll = interaction && game.stage === 'await-roll' && game.canRoll === true;
  const currentDie = validDie(game?.die) ? game.die : null;
  const canChoose = interaction && game.stage === 'await-move' && currentDie !== null;
  const planes = list(game?.planes), legalIds = new Set(canChoose ? list(game?.legalPlaneIds) : []);
  const legalRoutes = new Map();
  if (canChoose) for (const route of list(game.legalMoves)) {
    const plane = planes.find(item => item?.id === route?.planeId && item.side === selfSide);
    if (legalIds.has(plane?.id) && plane.progress !== 55 && routeMatches(route, plane, currentDie)) legalRoutes.set(plane.id, route);
  }
  const visibleSelection = legalRoutes.has(selectedId) ? selectedId : null;
  const route = visibleSelection ? structuredClone(legalRoutes.get(visibleSelection)) : null;
  const planesToChoose = selfSide ? planes.filter(plane => plane?.side === selfSide)
    .map(plane => ({ id: plane.id, label: `${flyingSideLabel(plane.side)} ${plane.number}`, positionLabel: positionLabel(plane),
      legal: legalRoutes.has(plane.id), selected: plane.id === visibleSelection,
      completed: plane.progress === 55, side: plane.side, number: plane.number }))
    .sort((left, right) => left.number - right.number) : [];
  const turnToSelf = playing && game?.turnPlayerId === view?.selfId && view?.selfRole === 'player';
  const turnText = playing ? turnToSelf ? '轮到你了' : `${playerName(view, game.turnPlayerId)}的回合`
    : phase === 'paused' ? '对局暂停 · 棋位与骰面保留' : phase === 'waiting' ? '等待大家准备'
      : ['finished', 'aborted'].includes(phase) ? '本局已结束' : '正在连接房间';
  let stageText = phase === 'waiting' ? '准备后开始，开局随机选先手。'
    : phase === 'paused' ? '恢复后接着当前阶段，不重新掷骰。'
      : ['finished', 'aborted'].includes(phase) ? resultText(view)
        : !game ? '正在读取已保存的对局。'
          : view?.selfRole === 'spectator' ? `观战中 · ${game.stage === 'await-move' ? '等待当前玩家选机' : '等待当前玩家掷骰'}`
            : !ownTurn ? game.stage === 'await-move' ? '等待对方选择飞机并确认。' : '等待对方掷骰。'
              : game.stage === 'await-roll' ? game.lastAction?.outcome === 'six-again' ? '六点奖励，继续掷骰。' : '掷一次骰子，再选择一架飞机。'
                : visibleSelection ? '路线仅为预览，确认后才会移动。' : '骰面已保存，请选择一架可行动的飞机。';
  if (busy) stageText = game?.stage === 'await-move' ? '正在提交移动，等待正式结果。' : '正在保存骰面，等待正式结果。';
  if (pending) stageText = '这次操作的结果尚未确认，正在核对。请勿重新掷骰或重复走子。';
  const die = currentDie || (validDie(game?.lastAction?.die) ? game.lastAction.die : null);
  const feedback = pending ? '先核对原操作；必要时用原请求重试。退出房间仍可使用。'
    : route?.description || publicLastAction(view) || (view?.selfRole === 'spectator' ? '你可以查看棋盘和聊天，不能替玩家行动。'
      : phase === 'waiting' ? '六点起飞、六点再掷；精确归航，首位四架完成者胜。' : '选择列表保留每架飞机的固定序号，同格飞机也可逐架选择。');
  return { phase, canRoll: Boolean(canRoll), canChoose: Boolean(canChoose && legalRoutes.size),
    canConfirm: Boolean(interaction && route), selectedId: visibleSelection, route, planesToChoose,
    die, dieIsCurrent: currentDie !== null, stageText, feedback, resultText: resultText(view), turnText,
    selfSide, ownTurn, turnToSelf, observer: view?.selfRole === 'spectator', paused: phase === 'paused',
    legalIds: [...legalRoutes.keys()], lastMoveId: game?.lastAction?.type === 'move' ? game.lastAction.route?.planeId || null : null,
    lastActionText: publicLastAction(view), round: game?.round ?? null, rollId: game?.rollId ?? null,
    nextPlayerId: players.length ? players[(players.findIndex(player => player.id === game?.turnPlayerId) + 1) % players.length]?.id || null : null };
}

/** POST and SSE projections of one saved revision produce one set of cues. */
export function flyingTransition(previous, next, { baseline = false } = {}) {
  const none = { changed: false, cues: [] };
  const localCycle = previous?.practice === true && next?.practice === true
    && previous.roomId === 'flying-local-practice' && next.roomId === 'flying-local-practice';
  const identityMatches = previous?.selfId === next?.selfId || localCycle;
  const room = next?.roomId || next?.roomCode;
  if (baseline || !previous?.game || !next?.game || previous.roomId !== next.roomId
      || previous.roomCode !== next.roomCode || typeof room !== 'string' || !room
      || typeof next.matchId !== 'string' || !next.matchId || previous.matchId !== next.matchId || !identityMatches
      || previous.selfRole !== next.selfRole || !Number.isSafeInteger(previous.game.revision)
      || !Number.isSafeInteger(next.game.revision) || next.game.revision <= previous.game.revision) return none;
  const action = next.game.lastAction, cues = [];
  if (next.phase === 'finished' && !next.game.result?.aborted) {
    cues.push(next.selfRole === 'spectator' ? 'draw-result' : list(next.game.result?.winnerIds).includes(next.selfId) ? 'win' : 'loss');
    return { changed: true, cues };
  }
  if (next.phase === 'aborted') return { changed: true, cues: [] };
  if (previous.phase !== 'playing' || next.phase !== 'playing') return { changed: true, cues: [] };
  if (action?.type === 'roll') cues.push('roll');
  else if (action?.type === 'move' && action.route) {
    const route = action.route;
    cues.push(list(route.capturedIds).length ? 'collision' : route.finished ? 'plane-finish'
      : list(route.segments).some(segment => ['fly', 'jump'].includes(segment.kind)) ? 'flight'
        : list(route.segments).some(segment => segment.kind === 'launch') ? 'launch' : 'move');
  }
  if (previous.game.turnPlayerId !== next.game.turnPlayerId && next.game.turnPlayerId === next.selfId
      && next.selfRole === 'player') cues.push('turn');
  return { changed: true, cues };
}

export function flyingRulePages({ practice = false } = {}) {
  return [
    [{ title: '目标与阵营', text: '2～4 人，每人四架飞机。两人红黄，三人红蓝黄，四人全部阵营。开局随机先手，随后按固定轮序行动；首位四架全部归航完成者赢，整局结束。' },
      { title: '骰子与选机', text: '仅六点起飞，起飞只到独立起飞点，不再走六格。每个骰子选一架合法飞机；确认前可以换选或取消，确认后不能撤销。非六换下一位，没有可动飞机也换手。' }],
    [{ title: '六点再掷', text: '六点确认行动后继续掷骰，连续三个六也不处罚。若最后一架以六点完成，先结束整局，不再掷骰。叠在同格的飞机仍逐架行动，不齐飞、不堵路。' },
      { title: '跳色与捷径', text: '普通落到本色格跳四格；直接到自己的捷径入口先飞再跳。跳到捷径入口则飞一次，不再跳。每次最多一跳一飞，途中经过同色格不触发；归航入口前不能越界跳。' }],
    [{ title: '撞机与归航', text: '骰子、跳跃、捷径的每个实际落点，全部敌机返回机库；途中经过不撞，自己的叠机不返库。归航道安全；精确到终点才完成，超出步数从终点反弹。' },
      { title: practice ? '本机练习' : '计时与保存', text: practice ? '教学使用固定骰序，本机练习由同一台设备轮流操作各方，不计战绩。返回大厅保存练习，重新开始只清本机练习。' : '每人整个回合 30 分钟，连六不重置。超时只换手，弃掉未使用骰子，保留此前确认的移动。暂停与重登恢复原棋位、骰面和剩余时间，不重新掷骰。' }],
    [{ title: '观战与退出', text: practice ? '练习不是正式房间，可以随时返回大厅。选机和路线预览仅本机显示，不会产生线上牌局或战绩。' : '观众只看公开棋盘、骰面与结果，可聊天，不能行动或代走。返回大厅保留席位；明确退出释放席位，进行或暂停中的整局中止，所有人不计输赢。' },
      { title: '操作结果不明', text: '确认结果前不要再次掷骰或重复移动。系统先核对原操作，明确重试也沿用原请求；另一个设备推进后，旧骰和旧选择会失效。' }],
  ];
}
