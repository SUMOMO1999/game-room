import { eventCards, answerOptions } from './interaction-cards.mjs';
import { settleEvent } from './interaction-effects.mjs';
import { demand, note, person, phase, random, shuffle } from './table.mjs';

const recentLimit = 6;
const targetScopes = new Set(['duel', 'guest', 'give']);
const handSeats = (g) =>
  g.players
    .filter((p) => g.showdown.some((row) => row.id === p.id))
    .map((p) => p.id);
const currentHost = (x) => x.hosts[x.turn];
const guests = (g) =>
  handSeats(g).filter((id) => id !== currentHost(g.interaction));

function hostsFor(g) {
  const seats = handSeats(g);
  const rank = id => g.showdown.find(row => row.id === id).rank;
  const bestRank = Math.min(...seats.map(rank)), worstRank = Math.max(...seats.map(rank));
  const leaders = seats.filter(id => rank(id) === bestRank);
  const top = g.scoreOnly ? leaders[(g.battle - 1) % leaders.length] : g.attacker;
  const trailing = seats.filter(id => rank(id) === worstRank);
  const start = (g.battle - 1) % trailing.length;
  const bottom = [...trailing.slice(start), ...trailing.slice(0,start)].find(id => id !== top);
  return [top, bottom];
}

function openOffer(g, now) {
  const x = g.interaction;
  const preferred = x.turn ? 'comeback' : 'fair';
  const pool = Object.values(eventCards).filter(
    (card) =>
      (!g.scoreOnly || !card.survival) &&
      !x.offered.includes(card.id) &&
      !g.recentEvents.includes(card.id),
  );
  x.offers = [];
  while (x.offers.length < 3) {
    const favor = random(g) < 0.8;
    const remaining = pool.filter((card) => !x.offers.includes(card.id));
    const family = remaining.filter(
      (card) => (card.family === preferred) === favor,
    );
    const options = family.length ? family : remaining;
    x.offers.push(options[Math.floor(random(g) * options.length)].id);
  }
  x.offered.push(...x.offers);
  Object.assign(x, {
    stage: 'offer',
    event: null,
    target: null,
    blind: false,
    openDie: null,
    bags: null,
    answers: {},
    participants: [],
  });
  phase(g, 'interact', now);
}
export function startInteractions(g, now) {
  g.recentEvents ??= [];
  g.interaction = { hosts: hostsFor(g), turn: 0, offered: [], results: [] };
  openOffer(g, now);
}
export function eventActors(g) {
  const x = g.interaction;
  if (x.stage === 'offer' || x.stage === 'target') return [currentHost(x)];
  if (x.stage === 'play')
    return x.participants.filter((id) => !Object.hasOwn(x.answers, id));
  return [];
}
function resolve(g, now) {
  const x = g.interaction;
  const result = settleEvent(g);
  x.results.push(result);
  x.stage = 'result';
  note(
    g,
    person(g, result.host).name +
      ' 发起「' +
      eventCards[result.event].name +
      '」',
  );
  for (const line of result.gains) {
    const changes = [['points','分'],['silver','银'],['hp','血'],['attack','攻'],['shield','盾']]
      .filter(([key]) => line[key]).map(([key,label]) => (line[key]>0?'+':'')+line[key]+label);
    if (changes.length) note(g, person(g,line.id).name + ' · ' + changes.join(' '));
  }
  phase(g, 'interact', now);
  g.phaseDuration = 8500;
  g.deadline = now + g.phaseDuration;
}
function startPlay(g, now) {
  const x = g.interaction,
    card = eventCards[x.event],
    host = currentHost(x);
  switch (card.scope) {
    case 'give':
    case 'instant':
      return resolve(g, now);
    case 'all':
      x.participants = handSeats(g);
      break;
    case 'others':
      x.participants = guests(g);
      break;
    case 'host':
      x.participants = [host];
      break;
    case 'guest':
      x.participants = [x.target];
      break;
    case 'duel':
      x.participants = [host, x.target];
      break;
  }
  x.stage = 'play';
  if (x.event === 'secondDie') x.openDie = 1 + Math.floor(random(g) * 6);
  if (x.event === 'blindBag') x.bags = shuffle(g, [0, 1, 2]);
  phase(g, 'interact', now);
}
export function moveEvent(g, p, move, now) {
  const x = g.interaction;
  demand(eventActors(g).includes(p.id), '请等这一席行动');
  if (x.stage === 'offer') {
    demand(
      move.type === 'eventPick' &&
        Number.isInteger(move.slot) &&
        move.slot >= 0 &&
        move.slot < 3,
      '请从三张互动牌中选一张',
    );
    x.event = x.offers[move.slot];
    x.blind = move.slot === 2;
    g.recentEvents = [...g.recentEvents, x.event].slice(-recentLimit);
    if (targetScopes.has(eventCards[x.event].scope)) {
      x.stage = 'target';
      phase(g, 'interact', now);
    } else startPlay(g, now);
  } else if (x.stage === 'target') {
    demand(
      move.type === 'eventTarget' && guests(g).includes(move.target),
      '请点本战的另一位牌友',
    );
    x.target = move.target;
    startPlay(g, now);
  } else {
    demand(
      move.type === 'eventPlay' &&
        answerOptions(g, p.id).some((o) => o.value === move.choice),
      '请选择桌面上的一项',
    );
    x.answers[p.id] = move.choice;
    g.ready.push(p.id);
    if (!eventActors(g).length) resolve(g, now);
  }
}
// Returns true once both receipts have been shown in full.
export function advanceEvent(g, now) {
  const x = g.interaction;
  demand(x.stage === 'result', '请等互动完成');
  if (!x.turn) {
    x.turn = 1;
    openOffer(g, now);
    return false;
  }
  g.lastInteraction = {
    battle: g.battle,
    hosts: [...x.hosts],
    results: x.results,
  };
  g.interaction = null;
  return true;
}
export function eventView(g, id) {
  const x = g.interaction;
  if (!x) return null;
  const actors = eventActors(g);
  return {
    role: x.turn ? 'bottom' : 'top',
    turn: x.turn,
    host: currentHost(x),
    hosts: [...x.hosts],
    stage: x.stage,
    offers: x.stage === 'offer' ? [x.offers[0], x.offers[1], null] : [],
    event: x.event,
    blind: x.blind,
    target: x.target,
    openDie: x.openDie,
    targets: x.stage === 'target' ? guests(g) : [],
    actors,
    participants: [...x.participants],
    ownLabel:
      x.stage === 'play' && Object.hasOwn(x.answers, id)
        ? answerOptions(g, id).find((o) => o.value === x.answers[id])?.label
        : null,
    ready: Object.keys(x.answers),
    ownChoice: id && Object.hasOwn(x.answers, id) ? x.answers[id] : null,
    options:
      x.stage === 'play' && actors.includes(id) ? answerOptions(g, id) : [],
    result: x.stage === 'result' ? x.results[x.turn] : null,
    results: x.results,
  };
}
export function botEvent(v, fraction) {
  const x = v.interaction;
  if (x.stage === 'offer')
    return { type: 'eventPick', slot: Math.floor(fraction * 3) };
  if (x.stage === 'target')
    return {
      type: 'eventTarget',
      target: x.targets[Math.floor(fraction * x.targets.length)],
    };
  const pick = x.options[Math.floor(fraction * x.options.length)];
  if (x.event === 'secondDie' && (x.openDie === 1 || x.openDie === 6))
    return { type: 'eventPlay', choice: x.openDie === 1 ? 'up' : 'down' };
  return { type: 'eventPlay', choice: pick.value };
}
export function interactionProblem(g) {
  const x = g.interaction;
  if (g.interactionVersion != null && g.interactionVersion !== 1)
    return '未知战后互动规则';
  const validCard = (id) =>
    Object.hasOwn(eventCards, id) && (!g.scoreOnly || !eventCards[id].survival);
  const unique = (a) => Array.isArray(a) && new Set(a).size === a.length;
  const ids = g.players.map(p => p.id);
  const die = d => Number.isInteger(d) && d >= 1 && d <= 6;
  function validReceipt(r, host) {
    return r && validCard(r.event) && r.host === host && ids.includes(host) &&
      (r.target === null || (ids.includes(r.target) && r.target !== host)) &&
      typeof r.blind === 'boolean' && Array.isArray(r.dice) && r.dice.every(die) &&
      Array.isArray(r.facts) && r.facts.every(f => typeof f === 'string') &&
      Array.isArray(r.answers) && r.answers.every(v => v && ids.includes(v.id) && typeof v.label === 'string' && typeof v.value === 'string') &&
      Array.isArray(r.gains) && r.gains.length >= 2 && r.gains.every(v => v && ids.includes(v.id) &&
        [v.total,v.points,v.silver,v.hp,v.attack,v.shield].every(Number.isSafeInteger)) &&
      unique(r.gains.map(v => v.id));
  }
  const history = g.lastInteraction;
  if (history && (!Number.isSafeInteger(history.battle) || !unique(history.hosts) || history.hosts.length !== 2 ||
    !Array.isArray(history.results) || history.results.length !== 2 || !history.results.every((r,i) => validReceipt(r, history.hosts[i]))))
    return '上一战互动记录无效';
  if (g.phase !== 'interact') return x ? '互动与牌桌阶段不一致' : null;
  if (!Array.isArray(g.showdown) || g.showdown.length < 2 ||
      !g.showdown.every(r => r && ids.includes(r.id) && Number.isInteger(r.rank) && r.rank >= 1 &&
        Array.isArray(r.main) && r.main.length >= 1 && r.main.length <= 5) ||
      !unique(g.showdown.map(r => r.id))) return '本战亮牌记录无效';
  const seats = handSeats(g);
  if (
    g.interactionVersion !== 1 ||
    !x ||
    !unique(x.hosts) ||
    x.hosts.length !== 2 ||
    !x.hosts.every((id) => seats.includes(id)) ||
    ![0, 1].includes(x.turn) ||
    !['offer', 'target', 'play', 'result'].includes(x.stage) ||
    !unique(x.offers) ||
    x.offers.length !== 3 ||
    !x.offers.every(validCard) ||
    !unique(x.offered) ||
    x.offered.length !== (x.turn + 1) * 3 ||
    !x.offered.every(validCard) ||
    !x.offers.every((id) => x.offered.includes(id)) ||
    !Array.isArray(g.recentEvents) ||
    g.recentEvents.length > recentLimit ||
    !g.recentEvents.every(validCard) ||
    !unique(x.participants) ||
    !x.participants.every((id) => seats.includes(id)) ||
    !x.answers ||
    typeof x.answers !== 'object' ||
    Array.isArray(x.answers) ||
    !Object.keys(x.answers).every((id) => x.participants.includes(id)) ||
    !Array.isArray(x.results) ||
    x.results.length !== x.turn + Number(x.stage === 'result') ||
    !x.results.every((r,i) => validReceipt(r, x.hosts[i]))
  )
    return '战后互动存档损坏';
  if (x.stage === 'offer')
    return x.event === null && !x.participants.length && x.target === null
      ? null
      : '待选互动无效';
  if (!x.offers.includes(x.event) || x.blind !== (x.offers[2] === x.event))
    return '已选互动无效';
  const scope = eventCards[x.event].scope;
  if (x.stage === 'target')
    return targetScopes.has(scope) &&
      x.target === null &&
      !x.participants.length
      ? null
      : '搭档无效';
  if (
    targetScopes.has(scope) ? !guests(g).includes(x.target) : x.target !== null
  )
    return '搭档无效';
  const expected = {
    all: seats,
    others: guests(g),
    duel: [currentHost(x), x.target],
    host: [currentHost(x)],
    guest: [x.target],
    instant: [],
    give: [],
  }[scope];
  if (
    expected.length !== x.participants.length ||
    !expected.every((id) => x.participants.includes(id))
  )
    return '参与席位无效';
  if (
    x.event === 'blindBag' &&
    (!unique(x.bags) ||
      x.bags.length !== 3 ||
      !x.bags.every((n) => [0, 1, 2].includes(n)))
  )
    return '福袋记录无效';
  if (
    x.event === 'secondDie' &&
    !(Number.isInteger(x.openDie) && x.openDie >= 1 && x.openDie <= 6)
  )
    return '骰面无效';
  if (
    x.stage === 'play' &&
    (!eventActors(g).length ||
      !Object.entries(x.answers).every(([id, value]) =>
        answerOptions(g, id).some((option) => option.value === value),
      ))
  )
    return '私选记录无效';
  if (
    x.stage === 'result' &&
    (!x.results[x.turn] ||
      x.results[x.turn].event !== x.event ||
      Object.keys(x.answers).length !== expected.length)
  )
    return '互动结算无效';
  return null;
}
