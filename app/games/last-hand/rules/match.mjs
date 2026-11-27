import { items, arenas, cast, scoringVersion, stockFor, worksInPointsMatch } from './catalog.mjs';
import {
  version,
  shuffle,
  deck,
  draw,
  phase,
  note,
  demand,
  active,
  alive,
  person,
  has,
  battleRelics,
  give,
  takeTool,
  clearBattle,
  chapterIndex, battleInChapter, battlesPerChapter, timerFields,
} from './table.mjs';
import { openAuction, seal, resolveAuction, pickPeek } from './auction.mjs';
import { submit, reveal, attack, attrition, finish, targets } from './combat.mjs';
import { useEffect } from './effects.mjs';
import { bestSelection } from './poker.mjs';

import {startInteractions, eventActors, moveEvent, advanceEvent, eventView} from './interactions.mjs';

export const chapterChoices = Object.freeze([2, 3, 4, 5, 6, 8, 10, 12]);
export const healthChoices = Object.freeze(Array.from({ length: 21 }, (_, i) => i + 5));
export const defaults = {
  mode: 'score',
  seats: 6,
  arena: 'canyon',
  ego: 'ranger',
  sections: 2,
  chips: 20,
  health: 10,
  tiers: 'mixed',
  expansion: true,
  public: false,
  fast: false,
  style: 'mixed',
  ...Object.fromEntries(Object.entries(timerFields).map(([key, field]) => [key, field.initial])),
};
export function settings(value = {}, previousHealth = null) {
  const s = { ...defaults, ...value };
  for (const [key, field] of Object.entries(timerFields))
    demand(Number.isInteger(s[key]) && s[key] >= field.min && s[key] <= field.max,
      field.label + '请填 ' + field.min + '～' + field.max + ' 的整数（' + field.unit + '）');
  demand(
    ['score', 'survival'].includes(s.mode) &&
      Number.isInteger(s.seats) &&
      s.seats >= 2 &&
      s.seats <= 6,
    '需要二至六个席位',
  );
  demand(
    chapterChoices.includes(s.sections) && Number.isInteger(s.chips) && s.chips >= 10 && s.chips <= 50,
    '局长或初始银筹无效',
  );
  // Three-life tables created by earlier versions keep their original stake when resumed.
  demand(healthChoices.includes(s.health) || (s.health === 3 && previousHealth === 3),
    '起始生命请选 5～25 的整数');
  demand(['mixed', 'rising', 'falling'].includes(s.tiers), '遗物顺序无效');
  demand(
    arenas.some((a) => a.key === s.arena) && cast.some((c) => c.id === s.ego),
    '场地或人物无效',
  );
  demand(
    ['mixed', '稳健', '争牌', '构筑'].includes(s.style) &&
      ['public', 'expansion', 'fast'].every((k) => typeof s[k] === 'boolean'),
    '牌桌设置无效',
  );
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, s[k]]));
}
export function newMatch(members, options) {
  const cfg = settings(options.settings, options.previousHealth),
    g = {
      ruleVersion: version,
      itemPoolVersion: 3,
      scoringVersion,
      interactionVersion: 1,
      chapterVersion: 2,
      ...(cfg.mode === 'score' ? { scoreOnly: true } : {}),
      matchId: options.matchId,
      settings: cfg,
      matchDeadline: cfg.matchMinutes ? options.now + cfg.matchMinutes * 60000 : null,
      rng: options.seed >>> 0 || 0x7c482be1,
      status: 'playing',
      result: null,
      epoch: 0,
      seq: 0,
      battle: 1,
      batch: 0,
      copySeq: 0,
      players: [],
      deck: [],
      discard: [],
      market: [],
      log: [],
      award: null,
      hit: null,
      showdown: [],
      lastBattle: null,
      attacker: null,
      protected: null,
      growth: null,
    };
  demand(
    members.length >= 1 &&
      members.length <= cfg.seats &&
      new Set(members.map((p) => p.id)).size === members.length,
    '参与席位有误',
  );
  const egos = [
    cast.find((c) => c.id === cfg.ego),
    ...shuffle(
      g,
      cast.filter((c) => c.id !== cfg.ego),
    ),
  ];
  for (let i = 0; i < cfg.seats; i++) {
    const m = members[i],
      e = egos[i],
      p = {
        id: m?.id || 'bot-' + i,
        name: m?.name || e.name,
        ego: e.id,
        style: cfg.style === 'mixed' ? e.style : cfg.style,
        bot: !m,
        hp: cfg.health,
        maxHp: cfg.health,
        silver: 0,
        gold: 1,
        score: 0,
        best: 0,
        out: false,
        outAt: 0,
        sit: 0,
        revision: 0,
        relics: [],
        tools: [],
        flags: {},
      };
    clearBattle(p);
    g.players.push(p);
  }
  beginBattle(g, options.now);
  return g;
}
function availableItems(g, kind) {
  return Object.values(items).filter(
    (item) =>
      (g.settings.expansion || !item.extra) &&
      (!g.scoreOnly || worksInPointsMatch(item)) &&
      (kind === 'private' || item.kind === kind) &&
      stockFor(item) <= (g.itemPoolVersion || 1),
  );
}
function growthPool(g, kind, order) {
  const candidates = availableItems(g, kind).filter(
    (x) => x.kind === 'tool' || order.some((id) => !has(person(g, id), x.id)),
  );
  const mix = shuffle(g, candidates);
  if (kind === 'relic' && g.settings.tiers !== 'mixed') {
    const stage = Math.min(3, 1 + chapterIndex(g)),
      tier = g.settings.tiers === 'rising' ? stage : 4 - stage;
    mix.sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier));
  }
  const count =
    kind === 'private'
      ? 3
      : kind === 'tool' && g.itemPoolVersion >= 3
        ? order.length + Number(g.chapterVersion >= 2)
        : order.length + 2;
  return mix.slice(0, count).map((x) => x.id);
}
function offersFor(x, id) {
  return x.seatOffers ? x.seatOffers[id] || [] : x.offers;
}
function personalPool(g, p) {
  const x = g.growth,
    offers = offersFor(x, p.id),
    tiers = new Set(offers.map((id) => items[id].tier));
  return availableItems(g, x.kind)
    .filter(
      (o) =>
        tiers.has(o.tier) &&
        !offers.includes(o.id) &&
        (x.seatOffers || !x.picked.some((k) => k.item === o.id)) &&
        (o.kind === 'tool' || !has(p, o.id)),
    )
    .map((o) => o.id);
}
function nextGrowth(g, queue, now) {
  const task = queue.shift();
  if (!task) {
    g.growth = null;
    beginBattle(g, now);
    return;
  }
  const living = alive(g);
  const order = task.id
    ? [task.id]
    : living
        .map((p, i) => ({
          id: p.id,
          s: p.score,
          t: (i + living.length - (chapterIndex(g) % living.length)) % living.length,
        }))
        .sort((a, b) => a.s - b.s || a.t - b.t)
        .map((x) => x.id);
  if (!order.length) {
    nextGrowth(g, queue, now);
    return;
  }
  const chooseTogether = task.kind === 'relic' && g.itemPoolVersion >= 3;
  const offers = chooseTogether ? [] : growthPool(g, task.kind, order);
  g.growth = {
    kind: task.kind,
    owner: task.id || null,
    order,
    offers,
    picked: [],
    passed: [],
    queue,
  };
  if (chooseTogether) {
    g.growth.seatOffers = Object.fromEntries(order.map((id) => [id, growthPool(g, 'relic', [id])]));
    g.growth.seatExtras = {};
  }
  phase(g, 'growth', now);
}
function grow(g, p, m, now) {
  const x = g.growth;
  const offers = offersFor(x, p.id);
  const personal = x.seatOffers
    ? x.seatExtras[p.id]
    : x.personal?.id === p.id
      ? x.personal.item
      : null;
  demand(x.seatOffers ? x.order.includes(p.id) : x.order[0] === p.id, '还没轮到你选物');
  if (m.type === 'ledger') {
    demand(p.ledger && !personal, '没有可用账本记号');
    const alternatives = personalPool(g, p);
    demand(alternatives.length, '同级备选暂缺，保留记号');
    p.ledger = false;
    const item = shuffle(g, alternatives)[0];
    if (x.seatOffers) x.seatExtras[p.id] = item;
    else x.personal = { id: p.id, item };
    return;
  } else if (m.type === 'light') {
    demand(
      !x.seatOffers &&
        x.kind !== 'private' &&
        x.order.length >= 2 &&
        !x.personal &&
        !x.passed.includes(p.id) &&
        !x.passed.includes(x.order[1]),
      '这次不能传灯',
    );
    takeTool(p, 'lantern');
    p.silver += 3;
    x.passed.push(p.id, x.order[1]);
    [x.order[0], x.order[1]] = [x.order[1], p.id];
    note(g, p.name + ' 传灯，获得 3 银');
  } else {
    const eligible = offers.filter((id) => items[id].kind === 'tool' || !has(p, id));
    if (personal) eligible.push(personal);
    demand(
      eligible.includes(m.item) || (m.item === null && !eligible.length),
      '请从仍可领取的物品中选择',
    );
    if (m.item) {
      x.picked.push({ id: p.id, item: m.item });
      if (!x.seatOffers) {
        give(p, m.item);
        const at = offers.indexOf(m.item);
        if (at >= 0) offers.splice(at, 1);
        note(
          g,
          p.name +
            ' 取得「' +
            items[m.item].name +
            '」' +
            (items[m.item].silver ? '，获得 ' + items[m.item].silver + ' 银' : ''),
        );
      }
    }
    x.personal = null;
    x.order.splice(x.order.indexOf(p.id), 1);
  }
  if (!x.order.length) {
    if (x.seatOffers) {
      for (const pick of x.picked) {
        const seat = person(g, pick.id);
        give(seat, pick.item);
        note(g, seat.name + ' 取得「' + items[pick.item].name + '」');
      }
    }
    nextGrowth(g, [...x.queue], now);
    return;
  }
  if (!x.seatOffers) phase(g, 'growth', now);
  else g.ready.push(p.id);
}
function beginBattle(g, now) {
  delete g.battleEndHp;
  g.batch = 0;
  g.deck = deck(g);
  g.discard = [];
  g.recycled = [];
  g.showdown = [];
  g.hit = g.award = null;
  g.attacker = g.protected = null;
  for (const p of g.players) {
    clearBattle(p);
    if (p.out) continue;
    if (p.sit > 0 && p.sit < g.battle) {
      p.hp = p.maxHp;
      p.sit = 0;
    } else if (p.hp === 0 && p.sit !== g.battle) p.hp = p.maxHp;
    if (p.sit === g.battle) continue;
    p.silver += g.settings.chips + (has(p, 'dealer') ? 3 : 0);
    p.hand = [draw(g), draw(g)];
  }
  openAuction(g, now);
}
function afterBattle(g, now) {
  const events = g.lastInteraction?.battle === g.battle ? g.lastInteraction.results : [];
  g.lastBattle = { battle: g.battle, showdown: g.showdown, hit: g.hit, events };
  if (g.settings.mode === 'survival') {
    attrition(g);
    if (alive(g).length <= 1) {
      finish(g, now);
      return;
    }
  }
  if (g.settings.mode === 'score' && g.battle >= g.settings.sections * battlesPerChapter(g)) {
    finish(g, now);
    return;
  }
  if (g.matchDeadline != null && now >= g.matchDeadline) {
    finish(g, now, true);
    return;
  }
  const queue = [];

  const completed = battleInChapter(g);
  if (g.chapterVersion >= 2) {
    if (completed === 1 || completed === 3) queue.push({ kind: 'relic' });
    if (completed === 2) queue.push({ kind: 'tool' });
  } else if (completed === 1) queue.push({ kind: 'tool' });
  // Rewards can grant health. If time runs out between battles, rank the completed battle.
  if (queue.length && !g.scoreOnly) g.battleEndHp = g.players.map((p) => p.hp);
  g.battle++;
  if (battleInChapter(g) === 1) {
    for (const p of alive(g)) {
      if (has(p, 'charm')) {
        p.maxHp++;
        if (p.hp > 0) p.hp++;
      }
      if (has(p, 'rebate')) p.gold++;
    }
    if (!(g.chapterVersion >= 2)) queue.push({ kind: 'relic' });
  }
  nextGrowth(g, queue, now);
}
function afterInteractions(g, now) {
  if (g.scoreOnly) afterBattle(g, now);
  else if (targets(g).length) phase(g, 'attack', now);
  else {
    g.hit = null;
    phase(g, 'hit', now);
  }
}
function transition(g, now) {
  if (g.phase === 'award') {
    if (g.batch < 4) openAuction(g, now);
    else {
      for (const p of active(g))
        p.beforeBuild = {
          hp: p.hp,
          tools: [...p.tools],
          relics: [...p.relics],
          handCount: p.hand.length,
        };
      g.market = [];
      phase(g, 'build', now);
    }
  } else if (g.phase === 'reveal') {
    if (g.interactionVersion === 1 && g.showdown.length >= 2) startInteractions(g, now);
    else afterInteractions(g, now);
  } else if (g.phase === 'interact') {
    if (advanceEvent(g, now)) afterInteractions(g, now);
  } else if (g.phase === 'hit') afterBattle(g, now);
}
export function currentActors(g) {
  if (g.status !== 'playing') return [];
  if (g.phase === 'growth')
    return g.growth.seatOffers ? [...g.growth.order] : g.growth.order.slice(0, 1);
  if (g.phase === 'auction')
    return active(g)
      .filter((p) => !p.pending)
      .map((p) => p.id);
  if (g.phase === 'peek')
    return active(g)
      .filter((p) => p.two)
      .map((p) => p.id);
  if (g.phase === 'build')
    return active(g)
      .filter((p) => !p.choice)
      .map((p) => p.id);
  if (g.phase === 'interact') return eventActors(g);
  if (g.phase === 'attack') return [g.attacker];
  return [];
}
function visibleShowdown(rows, viewer, hit) {
  return rows.map(({ guardId, ...row }) => {
    if (!guardId || row.id === viewer || row.id === hit?.target)
      return { ...row, hiddenGuard: false };
    return { ...row, backup: row.backup.filter((c) => c.id !== guardId), hiddenGuard: true };
  });
}
export function viewFor(g, id) {
  const me = person(g, id),
    privateGrowth = g.growth?.kind === 'private' && g.growth.owner !== id;
  const stock = g.itemPoolVersion || 1;
  const ownExtra =
    g.growth?.seatExtras?.[id] ||
    (g.growth?.personal && g.growth.personal.id === id ? g.growth.personal.item : null);
  return {
    matchId: g.matchId,
    ruleVersion: g.ruleVersion,
    scoringVersion: g.scoringVersion || 1,
    itemPoolVersion: stock,
    chapterVersion: g.chapterVersion || 1,
    scoreOnly: g.scoreOnly === true,
    interactionVersion: g.interactionVersion || 0,
    interaction: eventView(g, id),
    settledEvents: g.lastInteraction?.battle === g.battle ? g.lastInteraction.results : [],
    settings: g.settings,
    status: g.status,
    epoch: g.epoch,
    seq: g.seq,
    phase: g.phase,
    battle: g.battle,
    batch: g.batch,
    deadline: g.deadline,
    phaseDuration: g.phaseDuration,
    matchDeadline: g.matchDeadline ?? null,
    self: id,
    actors: currentActors(g),
    ready: [...g.ready],
    market: g.market,
    award: g.phase === 'award' || g.phase === 'peek' ? g.award : null,
    showdown: ['reveal', 'interact', 'attack', 'hit', 'finish'].includes(g.phase)
      ? visibleShowdown(g.showdown, id, g.hit)
      : [],
    hit: g.hit,
    attacker: g.attacker,
    protected: g.protected,
    targets: g.phase === 'attack' ? targets(g) : [],
    growth: g.growth
      ? {
          kind: g.growth.kind,
          order: g.growth.order,
          simultaneous: !!g.growth.seatOffers,
          offers:
            privateGrowth || (g.growth.seatOffers && !g.growth.order.includes(id))
              ? []
              : offersFor(g.growth, id),
          picked: g.growth.seatOffers
            ? g.growth.picked.filter((p) => p.id === id)
            : g.growth.picked,
          passed: g.growth.passed,
          personal: ownExtra,
          canLedger: !!(
            me &&
            currentActors(g).includes(id) &&
            me.ledger &&
            !ownExtra &&
            personalPool(g, me).length
          ),
        }
      : null,
    players: g.players.map((p) => {
      const snap = g.phase === 'build' && p.id !== id ? p.beforeBuild : null;
      return {
        id: p.id,
        name: p.name,
        ego: p.ego,
        style: p.style,
        bot: p.bot,
        hp: snap?.hp ?? p.hp,
        maxHp: p.maxHp,
        eventAttack: p.eventAttack || 0,
        eventShield: p.eventShield || 0,
        silver: p.silver,
        gold: p.gold,
        score: p.score,
        out: p.out,
        sitting: p.sit === g.battle,
        handCount: snap?.handCount ?? p.hand.length,
        relics: snap?.relics ?? p.relics,
        tools: snap?.tools ?? p.tools,
        ready: g.ready.includes(p.id),
      };
    }),
    own: me
      ? {
          id: me.id,
          revision: me.revision,
          hand: me.hand,
          replacementsAvailable: g.deck.length + g.discard.filter((c) => !c.copy).length > 0,
          relics: me.relics,
          boosts: me.boosts || [],
          adrenaline: !!me.adrenaline,
          scoringVersion: g.scoringVersion || 1,
          tools: me.tools,
          used: me.used,
          guard: me.guard,
          vow: me.vow,
          choice: me.choice,
          bank: me.bank,
          echo: me.echo,
          pending: me.pending,
          peek: me.two,
          hp: me.hp,
          maxHp: me.maxHp,
          eventAttack: me.eventAttack || 0,
          eventShield: me.eventShield || 0,
          silver: me.silver,
          gold: me.gold,
          flags: me.flags,
        }
      : null,
    lastBattle: g.lastBattle
      ? { ...g.lastBattle, showdown: visibleShowdown(g.lastBattle.showdown, id, g.lastBattle.hit) }
      : null,
    lastAward: g.lastAward || null,
    result: g.result,
    log: g.log.slice(-55),
  };
}
function doMove(g, p, m, now) {
  if (m.type === 'avatar') {
    demand(
      g.battle === 1 && currentActors(g).includes(p.id) &&
        ((g.phase === 'growth' && g.batch === 0) || (g.phase === 'auction' && g.batch === 1)),
      '请在开场行动前选择角色',
    );
    const next = cast.find((c) => c.id === m.ego),
      taken = g.players.find((q) => q.ego === m.ego);
    demand(next && (!taken || taken.bot || taken === p), '这位角色已有人入席');
    if (taken && taken !== p) {
      const previous = cast.find((c) => c.id === p.ego);
      taken.ego = previous.id;
      taken.name = previous.name;
      taken.style = g.settings.style === 'mixed' ? previous.style : g.settings.style;
    }
    p.ego = next.id;
    p.style = g.settings.style === 'mixed' ? next.style : g.settings.style;
    p.revision++;
    g.seq++;
    return;
  }
  demand(currentActors(g).includes(p.id), '当前无需这席行动');
  if (g.phase === 'growth' && ['pick', 'light', 'ledger'].includes(m.type)) grow(g, p, m, now);
  else if (g.phase === 'interact') moveEvent(g, p, m, now);
  else if (g.phase === 'auction' && m.type === 'seal') {
    seal(g, p, m);
    if (currentActors(g).length === 0) resolveAuction(g, now);
  } else if (g.phase === 'peek' && m.type === 'peek') pickPeek(g, p, m, now);
  else if (g.phase === 'build' && m.type === 'effect') useEffect(g, p, m);
  else if (g.phase === 'build' && m.type === 'submit') {
    submit(g, p, m);
    if (currentActors(g).length === 0) reveal(g, now);
  } else if (g.phase === 'attack' && m.type === 'attack') attack(g, p, m.target, now);
  else throw new Error('这一步不能这样操作');
  p.revision++;
  g.seq++;
}
export function applyMove(g, id, a, now) {
  const p = person(g, id);
  if (!p || g.status !== 'playing') return { ok: false, error: '本局已结束或该席不存在' };
  if (a.matchId !== g.matchId || p.revision !== a.seatRevision)
    return { ok: false, code: 'SEAT_CHANGED', error: '桌面有了新变化' };
  if (now >= g.deadline) return { ok: false, error: '本阶段时间已到' };
  const next = structuredClone(g);
  try {
    doMove(next, person(next, id), a.move, now);
    return { ok: true, state: next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
export function dueAt(g) {
  if (g.status !== 'playing') return null;
  const ids = currentActors(g);
  return ids.some((id) => person(g, id).bot) ? Math.min(g.botAt, g.deadline) : g.deadline;
}
export function step(g, now, policy) {
  if (g.status !== 'playing' || now < dueAt(g)) return { ok: true, changed: false };
  const next = structuredClone(g),
    epoch = g.epoch,
    timeout = now >= g.deadline;
  if (g.phase === 'growth' && g.lastBattle && g.matchDeadline != null && now >= g.matchDeadline) {
    next.battle = g.lastBattle.battle;
    next.growth = null;
    finish(next, now, true);
    next.seq++;
    return { ok: true, state: next };
  }
  const actors = currentActors(next);
  if (!actors.length) {
    transition(next, now);
    next.seq++;
  } else
    for (const id of actors) {
      if (next.epoch !== epoch) break;
      const p = person(next, id);
      if (!p.bot && !timeout) continue;
      let m;
      if (!p.bot && next.phase === 'auction') {
        p.autoPass = true;
        m = { type: 'seal', kind: 'pass' };
      } else if (timeout && next.phase === 'peek') m = { type: 'peek', card: p.two[0].id };
      else if (!p.bot && next.phase === 'build')
        m = {
          type: 'submit',
          ids: bestSelection(p.hand, battleRelics(p), p.vow, p.guard, next.scoringVersion || 1, next.scoreOnly).ids,
        };
      else m = policy(viewFor(next, id), { timeout, auto: true });
      doMove(next, p, m, now);
    }
  next.botAt = now + (next.settings.fast ? 50 : 680);
  return { ok: true, state: next };
}
