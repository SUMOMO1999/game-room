import { createParksPractice, parksPracticeView, practiceProblem, PRACTICE_SELF, randomStream } from './practice-engine.mjs';
import { applyGameAction, nextSystemStep, applySystemStep } from './rules/index.mjs';
import { privateView } from './view.mjs';
import { chooseParksPracticeAction } from './practice-bot.mjs';

const clone = structuredClone;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const standard = { mode: 'standard', camping: false, volunteerCount: 0, passionChoice: 'choose' };
const prelude = '此前行动由固定种子的合法预演完成；本课从真实待办开始，不是从整局起点开始。';
const lesson = (id, title, goal, instruction, options = {}) => ({ id, title, goal, instruction, normalDifference: prelude,
  configuration: standard, seed: 1, playerCount: 2, topic: false, ...options });

export const LESSONS = freeze([
  lesson('movement-weather', '1 · 前进与天气', '移动到有天气的位置，并领取该位置的天气。', '选一名徒步者，再选前方带天气的位置；到达后领取“天气”，地点行动也要处理。'),
  lesson('occupied-campfire', '2 · 占位与营火', '用点燃的营火进入已有棋子的位置。', '选前方已有棋子的位置。合法行动会说明本次消耗营火；熄灭后不能再次借它进入占位位置。',
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
    case 'reserve-park': return owner.reserved.some(id => !before.reserved.includes(id)) || owner.visited.some(id => !before.visited.includes(id));
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
export function tutorialProgress(view, id) {
  const info = definition(id), initial = basis(id), owner = own(view);
  if (!owner || view.gameType !== 'parks' || JSON.stringify(view.configuration) !== JSON.stringify(info.configuration)) {
    return { complete: false, instruction: '这是另一种局面，请重做当前课程。', nextLessonId: null, suggestedAction: null, detail: null };
  }
  const complete = completed(view, id, initial), index = LESSONS.findIndex(value => value.id === id);
  const suggestedAction = complete ? null : nextChoice(view, id);
  const score = view.result?.scores?.find(value => value.playerId === view.selfId);
  const detail = score ? { score: score.score, breakdown: clone(score.breakdown), soloRank: score.soloRank ?? null, rankThreshold: score.rankThreshold ?? null,
    ratingThresholds: view.configuration.mode === 'solo' ? [30, 35, 40, 45, 50] : [], difficulty: score.difficulty ?? null } : null;
  const instruction = complete ? '本课目标已完成。可以继续处理当前收益，或进入下一课。' : view.window?.responsibleSeatId !== PRACTICE_SELF
    ? '等待系统或电脑完成它的行动；当前课程状态会保留。' : allowed(view).find(value => JSON.stringify(value.fields) === JSON.stringify(suggestedAction))?.label ?? info.instruction;
  return { complete, instruction, nextLessonId: index + 1 < LESSONS.length ? LESSONS[index + 1].id : null, suggestedAction: clone(suggestedAction), detail };
}
