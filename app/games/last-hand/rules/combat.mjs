import { active, battleRelics, attackBonus, person, phase, note, demand, alive, chapterIndex, battlesPerChapter } from './table.mjs';
import { evaluate, blockValue, compareKey } from './poker.mjs';
import { damagePenalty } from './catalog.mjs';
export function submit(g, p, m) {
  const ids = m.ids;
  demand(
    !p.choice &&
      Array.isArray(ids) &&
      ids.length >= 1 &&
      ids.length <= 5 &&
      new Set(ids).size === ids.length,
    '主手需要一至五张不同的牌',
  );
  demand(
    ids.every((id) => p.hand.some((c) => c.id === id) && id !== p.guard),
    '主手中有不能使用的牌',
  );
  p.choice = [...ids];
  g.ready.push(p.id);
}
export function reveal(g, now) {
  const order = active(g),
    shift = chapterIndex(g) % g.players.length;
  const rankTie = (p) => (g.players.indexOf(p) - shift + g.players.length) % g.players.length;
  const result = order
    .map((p) => {
      const main = p.hand.filter((c) => p.choice.includes(c.id)),
        backup = p.hand.filter((c) => !p.choice.includes(c.id));
      const e = evaluate(main, battleRelics(p), p.vow, g.scoringVersion || 1);
      p.score += e.points;
      p.best = Math.max(p.best, e.points);
      p.flags['hand' + e.type] = true;
      return {
        id: p.id,
        main,
        backup,
        guardId: p.guard,
        boosts: [...(p.boosts || [])],
        adrenaline: !!p.adrenaline,
        ...e,
        block: blockValue(backup, p.guard, p.vow),
        seasonBonus: p.ledger,
        rankTie: rankTie(p),
      };
    })
    .sort(
      (a, b) =>
        b.points - a.points || (g.scoreOnly ? 0 : b.type - a.type || compareKey(b.key, a.key)) || a.rankTie - b.rankTie,
    );
  // Exact ties rotate within their own group, including the right to attack on new survival tables.
  if (g.interactionVersion && !g.scoreOnly) {
    for (let start = 0; start < result.length;) {
      const first = result[start];
      let end = start + 1;
      while (end < result.length && result[end].points === first.points && result[end].type === first.type &&
             compareKey(result[end].key, first.key) === 0) end++;
      const tied = result.slice(start,end).sort((a,b) => order.findIndex(p=>p.id===a.id)-order.findIndex(p=>p.id===b.id));
      const rotate = (g.battle-1) % tied.length;
      result.splice(start,tied.length,...tied.slice(rotate),...tied.slice(0,rotate));
      start = end;
    }
  }
  result.forEach((r, i) => {
    r.rank =
      i > 0 &&
      r.points === result[i - 1].points &&
      (g.scoreOnly || (r.type === result[i - 1].type && compareKey(r.key, result[i - 1].key) === 0))
        ? result[i - 1].rank
        : i + 1;
  });
  g.showdown = result;
  g.attacker = g.scoreOnly ? null : result[0].id;
  g.protected = !g.scoreOnly && result.length > 2 ? result[1].id : null;
  const winner = person(g, result[0].id);
  if (g.scoreOnly) {
    for (const row of result) {
      const seat = person(g, row.id);
      row.total = seat.score;
      row.previousTotal = seat.score - row.points;
      row.overallRank = 1 + g.players.filter(other => other.score > seat.score).length;
      row.sharedRank = g.players.some(other => other.id !== seat.id && other.score === seat.score);
      if (row.rank === 1 && seat.reserved.some(id => row.counted.includes(id))) seat.flags.reservedWin = true;
    }
  } else if (winner.reserved.some((id) => result[0].counted.includes(id))) winner.flags.reservedWin = true;
  note(
    g,
    '第 ' +
      g.battle +
      ' 战 · ' +
      winner.name +
      ' 亮出' +
      result[0].label +
      '，得 ' +
      result[0].points +
      ' 分',
  );
  phase(g, 'reveal', now);
}
export function targets(g) {
  if (g.scoreOnly) return [];
  return active(g)
    .filter((p) => p.id !== g.attacker && p.id !== g.protected)
    .map((p) => p.id);
}
function takeHit(g, p, value) {
  p.hp = Math.max(0, p.hp - value);
  if (p.hp === 0 && battleRelics(p).includes('life')) {
    const source = p.boosts?.includes('life') ? p.boosts : p.relics;
    source.splice(source.indexOf('life'), 1);
    p.hp = p.maxHp;
    return '续命';
  }
  if (p.hp === 0) {
    if (g.settings.mode === 'survival') {
      p.out = true;
      p.outAt = g.battle;
      return '淘汰';
    }
    p.sit = g.battle + 1;
    return '停战';
  }
  return '';
}
function absorbShield(p, damage) {
  const absorbed = Math.min(p.eventShield || 0, damage);
  if (absorbed) p.eventShield -= absorbed;
  return absorbed;
}
export function attack(g, p, id, now) {
  demand(p.id === g.attacker && targets(g).includes(id), '请选择亮起的对手');
  const target = person(g, id),
    r = g.showdown.find((x) => x.id === p.id),
    def = g.showdown.find((x) => x.id === id);
  const offense = battleRelics(p);
  const attackBuff = attackBonus(p),
    vuln = Number(battleRelics(target).includes('glass'));
  const raw = r.damage + attackBuff + vuln,
    handBlock = battleRelics(target).includes('barrier')
      ? raw
      : Math.min(raw, def.block.pair + def.block.pin);
  const eventBlocked = absorbShield(target, raw - handBlock), blocked = handBlock + eventBlocked;
  const actual = raw - blocked,
    old = target.hp,
    loss = Math.min(target.score, actual * damagePenalty(g.scoringVersion || 1));
  if (p.eventAttack) p.eventAttack = 0;
  p.adrenaline = false;
  target.score -= loss;
  const result = takeHit(g, target, actual);
  if (actual > 0) p.flags.slap = true;
  if (def.block.pin && old <= raw - def.block.pair && target.hp > 0 && !result)
    target.shieldSaved = true;
  let coins = 0;
  if (actual > 0 && offense.includes('pick')) {
    coins = Math.min(target.silver, old <= actual ? 5 : 3);
    p.silver += coins;
    target.silver -= coins;
  }
  if (actual === 0 && p.echo) p.silver += 2;
  g.hit = {
    actor: p.id,
    target: id,
    base: r.damage,
    attackBuff,
    vuln,
    blocked,
    eventBlocked,
    actual,
    loss,
    coins,
    before: old,
    after: target.hp,
    result,
    echo: actual === 0 && p.echo,
  };
  note(
    g,
    p.name +
      ' → ' +
      target.name +
      ' · ' +
      actual +
      ' 点实伤' +
      (blocked ? '（抵挡 ' + blocked + '）' : '') +
      (result ? ' · ' + result : ''),
  );
  phase(g, 'hit', now);
}
export function attrition(g) {
  const value = g.battle - g.settings.sections * battlesPerChapter(g);
  if (value <= 0) return;
  for (const p of alive(g)) {
    if (battleRelics(p).includes('barrier')) {
      note(g, p.name + ' 的临时护盾挡住了决胜伤害');
      continue;
    }
    const absorbed = absorbShield(p, value);
    const actual = value - absorbed;
    const result = takeHit(g, p, actual);
    note(g, '决胜消耗 · ' + p.name + ' −' + actual + ' 生命' + (absorbed ? ' · 互动盾挡 ' + absorbed : '') + (result ? ' · ' + result : ''));
  }
}
function standingsFor(g, timed) {
  const survival = g.settings.mode === 'survival';
  function compare(a, b) {
    if (!survival) return b.score - a.score || (g.scoreOnly ? 0 : b.hp - a.hp);
    if (a.out !== b.out) return Number(a.out) - Number(b.out);
    if (a.out) return b.outAt - a.outAt;
    return timed ? b.hp - a.hp || b.score - a.score : 0;
  }
  const seats = g.players.map((p, i) => ({
    id: p.id, name: p.name, ego: p.ego, out: p.out, outAt: p.outAt,
    hp: timed ? g.battleEndHp?.[i] ?? p.hp : p.hp, score: p.score, best: p.best,
  })).sort((a, b) => compare(a, b) || b.score - a.score);
  let rank = 1;
  return seats.map((p, i) => {
    if (i && compare(seats[i - 1], p) !== 0) rank = i + 1;
    return { rank, id: p.id, name: p.name, ego: p.ego, out: p.out, hp: p.hp, score: p.score, best: p.best };
  });
}
export function finish(g, now, timed = false) {
  const standings = standingsFor(g, timed);
  delete g.battleEndHp;
  const winnerIds = standings.filter((row) => row.rank === 1).map((row) => row.id);
  const lastRank = standings.at(-1).rank;
  const earned = {};
  for (const row of standings) {
    const p = person(g, row.id);
    p.flags.finish1 = true;
    if (row.rank === lastRank) p.flags.last = true;
    if (row.rank === 1) {
      if (g.players.length === 6) p.flags.six = true;
      if (p.shieldSaved) p.flags.shieldWin = true;
    }
    earned[p.id] = Object.keys(p.flags);
  }
  g.result = {
    reason: timed ? 'time-limit' : g.settings.mode === 'survival' ? 'last-standing' : 'high-score',
    winnerIds,
    tie: winnerIds.length > 1,
    earned,
    arena: g.settings.arena,
    battles: g.battle,
    standings,
  };
  g.status = 'finished';
  phase(g, 'finish', now);
  note(g, (timed ? '整桌限时已到，' : '') + standings.filter((p) => p.rank === 1).map((p) => p.name).join('、') + ' 赢得整场');
}
