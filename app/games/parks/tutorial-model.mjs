import { createParksPractice, parksPracticeView, practiceProblem, PRACTICE_SELF, randomStream } from './practice-engine.mjs';
import { applyGameAction, nextSystemStep, applySystemStep } from './rules/index.mjs';
import { privateView } from './view.mjs';
import { chooseParksPracticeAction } from './practice-bot.mjs';
import { getDefinition } from './content/catalog.mjs';

const clone = structuredClone;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const standard = { mode: 'standard', camping: false, volunteerCount: 0, passionChoice: 'choose' };
const prelude = '此前行动由固定种子的合法预演完成；本课从真实待办开始，不是从整局起点开始。';
const lesson = (id, title, goal, instruction, options = {}) => ({ id, title, goal, instruction, normalDifference: prelude,
  configuration: standard, seed: 1, playerCount: 2, topic: false, ...options });

export const LESSONS = freeze([
  lesson('movement-weather', '1 · 前进与天气', '移动到有天气的位置，并领取该位置的天气。', '选一名徒步者，再选前方带天气的位置；到达后领取“天气”，地点行动也要处理。'),
  lesson('occupied-campfire', '2 · 占位与营火', '用点燃的营火进入已有棋子的位置。', '选前方已有棋子的位置。合法行动会说明本次消耗营火；熄灭后暂时不能用于占位，卡牌效果可重新点燃。',
    { configuration: { ...standard, passionChoice: 'random' }, playerCount: 4, normalDifference: `${prelude} 本课使用四人局：开局营火已点燃。二、三人局开局营火熄灭。` }),
  lesson('fill-canteen', '3 · 新水与水壶', '把刚得到的新水填进一行未填过的水壶。', '在“分配新水”中选一行未填过的水壶，再领取水壶收益；只有新得到的水可以填壶。'),
  lesson('buy-gear', '4 · 购买装备', '按实际费用购买一件公开装备。', '选择“购买装备”的一项合法报价，检查付款后确认。已购买的装备会出现在自己的装备区。'),
  lesson('reserve-park', '5 · 预订公园', '从公开市场预订一座公园。', '选择预订目标并确认；预订不算已游览，也暂不获得该公园的分数。'),
  lesson('visit-park', '6 · 游览公园', '付费游览一座公园，领取它的即时收益。', '选择合法的游览报价并确认。公园分数来自已游览卡；若有即时收益，还要完成它。'),
  lesson('passion-branch', '7 · 完成热忱', '达成目标后，在能力与终局计分之间选择一条分支。', '当前目标已经合法达成。阅读自己的热忱，选择能力或终局计分；本局只能选择一次。'),
  lesson('season-score', '8 · 季末与终局', '完成秋季奖励，查看三季结束后的真实计分。', '所有徒步者已经到达终点。完成季节奖励和剩余必选收益，再查看公园、照片、排名、热忱与起始标记的计分。',
    { normalDifference: `${prelude} 春、夏和秋季移动已合法预演；从秋季结算开始，使用真实三季成绩。` }),
  lesson('camping', '专题 · 露营', '以露营方式到达地点，把帐篷放到一个合法露营格。', '选露营到达方式和可用露营格；天气会被放弃，正常地点行动被该格的露营行动替代。',
    { topic: true, configuration: { ...standard, camping: true, passionChoice: 'random' } }),
  lesson('teddy-order', '专题 · Teddy顺序', '决定两个颜色组的先后，看到两组各按各自抽牌移动。', '先选择哪组使用当前Teddy牌。系统会移动该组，再抽另一张牌移动剩余组；不能把一张牌用在两组上。',
    { topic: true, configuration: { ...standard, mode: 'solo', passionChoice: 'random' }, normalDifference: `${prelude} 两个颜色组只出现在单人模式。双人Teddy只有一个颜色组，不出现这项顺序选择。` }),
  lesson('solo-rating', '专题 · 单人评级', '完成单人秋季结算，查看真实分数与评级门槛。', '结清当前季节奖励后查看评级。单人没有照片排名分；30、35、40、45、50分对应五档评级，低于30分尚未达评级。',
    { topic: true, configuration: { mode: 'solo', camping: true, volunteerCount: 0, passionChoice: 'random' }, normalDifference: `${prelude} 本课合法预演到单人秋季结算；评级使用这一局实际成绩。` }),
  lesson('volunteer-projects', '专题 · 志愿项目', '在四项目限制下游览自己预订的公园，并支付本次实际报价。', '先阅读四张项目。本局只能游览预订公园；碳抵消要求额外支付一枚森林或山脉，合法报价已包含它。项目增加难度，不额外加分。',
    { topic: true, configuration: { mode: 'solo', camping: true, volunteerCount: 4, passionChoice: 'choose' } }),
]);

const byId = new Map(LESSONS.map(value => [value.id, value]));
const learned = {
  'movement-weather': '徒步者只能向前走。到站先领取天气，再处理地点行动。',
  'occupied-campfire': '进入占位地点会熄灭营火。通常新季复原；卡牌效果也可重新点燃。',
  'fill-canteen': '只有新得到的水可以填壶；同一行每季只能填一次。',
  'buy-gear': '装备付款后留在装备区；满足卡面触发条件时，才产生额外收益。',
  'reserve-park': '预订把公园留给自己；只有之后付费游览，才获得公园分数。',
  'visit-park': '付清实际报价后，公园进入已游览区并计分；即时收益仍要结清。',
  'passion-branch': '热忱达标后，在能力与终局计分中选一条；本局不能改选。',
  'season-score': '三季结束后，把公园、照片、热忱与季节奖励合计为总分。',
  camping: '露营放弃天气与正常地点行动，改为执行所选营位的行动。',
  'teddy-order': '两个颜色组分别使用不同的Teddy牌；你决定哪组先走。',
  'solo-rating': '单人看总分评级，不计照片排名分；志愿项目只增加难度。',
  'volunteer-projects': '志愿项目改变可选行动和费用；实际报价已计入本次额外成本。',
};
const reference = new Map();
const own = view => view?.players?.find(value => value.id === view.selfId);
const allowed = view => (view?.legalActions ?? []).filter(value => !value.disabledReason);
const choice = (view, predicate) => allowed(view).find(predicate) ?? null;
const endReached = view => view.hikers.length > 0 && view.hikers.every(value => value.position === 10);
function gateAction(view, id) {
  switch (id) {
    case 'movement-weather': return choice(view, value => value.type === 'move-hiker' && value.result.arrivalMode === 'normal' && !value.result.campfireUsed && value.result.weather);
    case 'occupied-campfire': return choice(view, value => value.type === 'move-hiker' && value.result.arrivalMode === 'normal' && value.result.campfireUsed);
    case 'fill-canteen': return choice(view, value => value.type === 'allocate-water' && value.fields.rowIndex !== null);
    case 'buy-gear': return choice(view, value => value.fields.action === 'buy-gear');
    case 'reserve-park': return choice(view, value => value.fields.action === 'reserve');
    case 'visit-park': return choice(view, value => value.fields.action === 'visit');
    case 'passion-branch': return choice(view, value => value.type === 'choose-passion');
    case 'season-score': case 'solo-rating': return view.season.index === 2 && endReached(view) ? choice(view, () => true) : null;
    case 'camping': return choice(view, value => value.type === 'move-hiker' && value.result.arrivalMode === 'camping');
    case 'teddy-order': return allowed(view).filter(value => value.type === 'choose-teddy').length === 2 ? choice(view, value => value.type === 'choose-teddy') : null;
    case 'volunteer-projects': return view.projects.includes('volunteer.sustainable-transportation') && view.projects.includes('volunteer.carbon-offsetting')
      ? choice(view, value => value.fields.action === 'visit' && own(view).reserved.includes(value.fields.targetId)) : null;
    default: return null;
  }
}
function definition(id) { const result = byId.get(id); if (!result) throw new RangeError('教学课程不存在。'); return result; }

// Rehearsals use the same commands, private participant projections and system
// transitions as practice. No domain field, deck or resource is patched.
function prepare(id, requestId) {
  const info = definition(id);
  let saved = createParksPractice({ configuration: info.configuration, playerCount: info.playerCount, seed: info.seed, ...(requestId ? { requestId } : {}) });
  const trace = [];
  for (let index = 0; index <= 800; index += 1) {
    const view = parksPracticeView(saved), target = gateAction(view, id);
    if (target) return { saved, view, target, trace };
    if (index === 800 || saved.game.status !== 'playing') throw new Error(`固定教学未到达目标：${id}。保留合法预演，不生成替代局面。`);
    const step = nextSystemStep(saved.game), actorId = saved.game.decisionWindow.responsibleSeatId;
    const intent = step ?? chooseParksPracticeAction(privateView(saved.game, actorId, { now: saved.logicalNow }));
    if (!intent) throw new Error(`固定教学没有合法下一步：${id}。`);
    const rng = randomStream(saved.rngState), now = saved.logicalNow + 1;
    const context = { now, serverRandomInt: limit => rng.randomInt(limit) };
    const result = step ? applySystemStep(saved.game, intent, context) : applyGameAction(saved.game, actorId, intent, context);
    if (!result.ok) throw new Error(`固定教学预演被规则拒绝：${id}：${result.error ?? result.reason}`);
    trace.push({ kind: step ? 'system' : 'player', actorId: step ? null : actorId, intent: clone(intent), beforeRevision: saved.game.revision, afterRevision: result.state.revision });
    saved = { ...saved, game: result.state, logicalNow: now, rngState: rng.state };
  }
  throw new Error('固定教学预演超出界限。');
}
function remember(id, prepared) {
  reference.set(id, { view: clone(prepared.view), target: clone(prepared.target), trace: clone(prepared.trace) });
}
function basis(id) {
  if (!reference.has(id)) {
    const index = LESSONS.findIndex(value => value.id === id);
    remember(id, prepare(id, () => (0x7000 + index).toString(16).padStart(32, '0')));
  }
  return reference.get(id);
}
export function createTutorialLesson(id, { requestId } = {}) {
  const prepared = prepare(id, requestId); remember(id, prepared);
  const issue = practiceProblem(prepared.saved); if (issue) throw new Error(issue);
  return prepared.saved;
}
export function tutorialTrace(id) { definition(id); return clone(basis(id).trace); }

function completed(view, id, initial) {
  const owner = own(view), before = own(initial.view);
  const events = (view.lastPublicEvents ?? []).filter(value => value.actorId === view.selfId);
  switch (id) {
    case 'movement-weather': return events.some(value => value.type === 'resources-gained' && value.sourceId?.startsWith('weather.'));
    case 'occupied-campfire': return !owner.campfire && owner.hikers.some(value => value.position !== before.hikers.find(old => old.id === value.id)?.position);
    case 'fill-canteen': return owner.canteenRows.some((row, index) => row.filled && !before.canteenRows[index].filled);
    case 'buy-gear': return owner.gearPurchases > before.gearPurchases;
    case 'reserve-park': return owner.reserved.some(id => !before.reserved.includes(id))
      || events.some(value => value.type === 'park-reserved' && value.targetId && !before.reserved.includes(value.targetId));
    case 'visit-park': case 'volunteer-projects': return owner.visited.length > before.visited.length;
    case 'passion-branch': return ['ability', 'scoring'].includes(owner.passionBranch);
    case 'camping': return view.camping.tents.some(tent => tent.slotId && !initial.view.camping.tents.some(old => old.id === tent.id && old.slotId === tent.slotId));
    case 'teddy-order': { const groups = ['teddy.amber', 'teddy.blue']; return groups.every(groupId => view.hikers.some(value => value.groupId === groupId && value.position !== initial.view.hikers.find(old => old.id === value.id)?.position)); }
    case 'season-score': case 'solo-rating': return view.status === 'finished' && view.result?.reason === 'three-seasons-complete' && !view.result.aborted;
    default: return false;
  }
}
function nextChoice(view, id) {
  const target = gateAction(view, id); if (target) return target.fields;
  if (id === 'movement-weather') {
    const weather = choice(view, value => value.sourceId?.startsWith('weather.')); if (weather) return weather.fields;
  }
  return chooseParksPracticeAction(view);
}

const resourceNames = { mountain: '山脉', forest: '森林', sun: '阳光', water: '水', wildlife: '野生动物' };
const resourceText = resources => Object.entries(resources || {}).filter(([id, count]) => resourceNames[id] && count > 0).map(([id, count]) => `${resourceNames[id]}${count}`).join('、');
const cardName = id => { try { return getDefinition(id).nameZh; } catch { return ''; } };
function completionOutcome(view, id, initial) {
  const owner = own(view), before = own(initial.view);
  const acquired = key => owner[key].filter(value => !before[key].includes(value));
  switch (id) {
    case 'movement-weather': {
      const events = (view.lastPublicEvents || []).filter(value => value.actorId === view.selfId && value.type === 'resources-gained' && value.sourceId?.startsWith('weather.'));
      const resources = Object.fromEntries(Object.keys(resourceNames).map(key => [key, events.reduce((total, event) => total + (event.resources?.[key] || 0), 0)]));
      return { text: resourceText(resources) ? `天气已领取：${resourceText(resources)}。` : '已领取到达位置的天气。', resources };
    }
    case 'occupied-campfire': return { text: '徒步者已进入占位地点，你的营火已熄灭。' };
    case 'fill-canteen': {
      const index = owner.canteenRows.findIndex((row, index) => row.filled && !before.canteenRows[index].filled);
      return { text: index >= 0 ? `新水已填入第${index + 1}行水壶。` : '本课已完成新水填壶。' };
    }
    case 'buy-gear': return { text: `${acquired('gear').map(cardName).join('、') || '新装备'}已进入你的装备区。` };
    case 'reserve-park': return { text: `${acquired('reserved').map(cardName).join('、') || '公园'}已预订，暂不获得游览分数。` };
    case 'visit-park': case 'volunteer-projects': return { text: `${acquired('visited').map(cardName).join('、') || '公园'}已游览，卡面分数已计入。` };
    case 'passion-branch': return { text: owner.passionBranch === 'ability' ? '已选择热忱能力，本局持续生效。' : '已选择热忱终局计分，本局不再改选。' };
    case 'camping': return { text: '帐篷已放入所选营位，接下来执行该营位的收益。' };
    case 'teddy-order': return { text: '橙色与蓝色Teddy都已按各自的牌移动。' };
    case 'season-score': case 'solo-rating': {
      const score = view.result?.scores?.find(value => value.playerId === view.selfId);
      return { text: score ? `三季已结清，你得到${score.score}分${id === 'solo-rating' ? ` · ${score.soloRank || '尚未达评级'}` : '。'}` : '本课已完成三季计分。', score: score?.score ?? null };
    }
    default: return { text: '本课目标已完成。' };
  }
}

// Teaching owns guidance only. Every suggested target comes from the current
// participant projection; selecting it never submits a domain command.
function lessonGuidance(view, info, initial, action, complete) {
  const index = LESSONS.indexOf(info), title = info.title.replace(/^\d+ · |^专题 · /, '');
  if (complete) {
    const unfinished = !view.result && (view.opportunities || []).some(value => value.status === 'open' && value.ownerSeatId === view.selfId && value.mandatory);
    return { lessonId: info.id, title, number: index + 1, total: LESSONS.length, goal: info.goal, complete: true,
      heading: '本课完成', instruction: learned[info.id], outcome: completionOutcome(view, info.id, initial),
      continuation: unfinished ? '本课只练这一项；后续地点行动仍待处理，教学已停在这里。' : '教学已停在完成的位置。下一课会进入另一段独立练习。',
      nextLabel: index === 7 || index === LESSONS.length - 1 ? '完整练习 →' : '下一课 →', suggestedAction: null };
  }
  const opportunity = view.opportunities?.find(value => value.id === action?.opportunityId);
  let heading = action?.label || '等待同行者', instruction = opportunity?.reason || info.instruction;
  if (view.window?.paused) { heading = '教学已暂停'; instruction = '打开设置恢复旅程，然后继续当前步骤。'; }
  else if (view.window?.responsibleSeatId !== PRACTICE_SELF) { heading = '看同行者完成这一步'; instruction = '电脑和系统正在处理真实行动；轮到你时，可选物件会重新亮起。'; }
  else if (action?.type === 'move-hiker') {
    heading = `点步道第${action.fields.position}站${action.result.campfireUsed ? ' · 消耗营火' : ''}`;
    instruction = action.fields.arrivalMode === 'camping' ? '点亮起的目的地，再选露营方式。露营替代天气和地点行动。'
      : `下方已选好一名徒步者。点亮起的地点，看清收益后确认${action.result.weather ? `；到站可领${resourceNames[action.result.weather]}天气` : ''}。`;
  } else if (opportunity?.kind === 'weather') {
    heading = '领取刚到站的天气'; instruction = `已到达第${action.sourceId.split('.')[1]}站。点“领取天气”，再确认；这份${resourceText(action.result?.resources)}来自地点上的天气标记。`;
  } else if (action?.type === 'allocate-water') {
    heading = action.fields.rowIndex === null ? '安排这一枚新水' : `把新水填进第${action.fields.rowIndex + 1}行`;
    instruction = '点亮起的水壶选项，再确认。填壶换取该行效果；放入背包则保留这枚水。';
  } else if (action?.fields.action === 'buy-gear') {
    instruction = '点亮起的装备报价，查看实际付款与效果，再确认购买。';
  } else if (action?.fields.action === 'reserve') {
    instruction = '点公园报价，再确认预订；现在不付款，也不计游览分数。';
  } else if (action?.fields.action === 'visit') {
    instruction = info.id === 'volunteer-projects' ? '点已预订的公园报价；核对项目加收与付款后，再确认游览。'
      : '点公园报价；核对实际付款和分数后，再确认游览。';
  } else if (action?.type === 'choose-passion') {
    instruction = '目标已达成。直接点“启用能力”或“选择终局计分”，阅读后果后确认。';
  } else if (action?.type === 'choose-teddy') {
    instruction = '直接点橙色或蓝色组，再确认谁先走；系统随后分别为两组翻牌移动。';
  } else if (action?.type === 'finish-window') {
    instruction = view.stage === 'season-reward' ? '本轮没有待选奖励。点“完成季节奖励”并确认，继续到真实计分。'
      : '当前收益已处理。点结束这一步并确认，再继续本课目标。';
  }
  return { lessonId: info.id, title, number: index + 1, total: LESSONS.length, goal: info.goal, complete: false,
    heading, instruction, outcome: null, continuation: null, nextLabel: null, suggestedAction: action ? clone(action.fields) : null };
}

export function tutorialActionGuidance(view, id, fields) {
  const info = definition(id);
  const action = allowed(view).find(value => JSON.stringify(value.fields) === JSON.stringify(fields));
  if (!action) return null;
  const guidance = lessonGuidance(view, info, basis(id), action, false), target = gateAction(view, id);
  if (target?.opportunityId && action.opportunityId !== target.opportunityId) {
    const current = view.opportunities.find(value => value.id === action.opportunityId), goal = view.opportunities.find(value => value.id === target.opportunityId);
    guidance.instruction = `当前查看${current?.label || action.label}；本课目标在“${goal?.label || target.label}”中，可点上方切回。`;
  }
  return guidance;
}
export function tutorialProgress(view, id, { completedPreviously = false } = {}) {
  const info = definition(id), initial = basis(id), owner = own(view);
  if (!owner || view.gameType !== 'parks' || JSON.stringify(view.configuration) !== JSON.stringify(info.configuration)) {
    return { complete: false, instruction: '这是另一种局面，请重做当前课程。', nextLessonId: null, suggestedAction: null, detail: null };
  }
  const complete = completedPreviously || completed(view, id, initial), index = LESSONS.findIndex(value => value.id === id);
  const suggestedAction = complete ? null : nextChoice(view, id);
  const score = view.result?.scores?.find(value => value.playerId === view.selfId);
  const detail = score ? { score: score.score, breakdown: clone(score.breakdown), soloRank: score.soloRank ?? null, rankThreshold: score.rankThreshold ?? null,
    ratingThresholds: view.configuration.mode === 'solo' ? [30, 35, 40, 45, 50] : [], difficulty: score.difficulty ?? null } : null;
  const instruction = complete ? '本课目标已完成。可以继续处理当前收益，或进入下一课。' : view.window?.responsibleSeatId !== PRACTICE_SELF
    ? '等待系统或电脑完成它的行动；当前课程状态会保留。' : allowed(view).find(value => JSON.stringify(value.fields) === JSON.stringify(suggestedAction))?.label ?? info.instruction;
  const action = allowed(view).find(value => JSON.stringify(value.fields) === JSON.stringify(suggestedAction));
  return { complete, instruction, nextLessonId: index + 1 < LESSONS.length ? LESSONS[index + 1].id : null, suggestedAction: clone(suggestedAction), detail,
    guidance: lessonGuidance(view, info, initial, action, complete) };
}
