import { person, random, demand } from './table.mjs';
import { answerOptions } from './interaction-cards.mjs';

// Accumulate each player's public prize separately from transfers between wallets.
// Survival exchanges the total prize once, so splitting one award never mints an extra coin.
function ledger(g, ids) {
  const before = new Map(ids.map((id) => [id, { ...person(g, id) }]));
  const awards = new Map(ids.map((id) => [id, 0]));
  const coins = (id, n) => {
    person(g, id).silver += n;
  };
  const points = (id, n) => awards.set(id, awards.get(id) + n);
  const attack = (id, n) => {
    const p = person(g, id);
    p.eventAttack = Math.min(2, (p.eventAttack || 0) + n);
  };
  const shield = (id, n) => {
    const p = person(g, id);
    p.eventShield = Math.min(2, (p.eventShield || 0) + n);
  };
  function heal(id, n) {
    const p = person(g, id),
      effective = Math.min(n, p.maxHp - p.hp);
    p.hp += effective;
    coins(id, n - effective);
  }
  function take(from, to, n) {
    const amount = Math.min(n, person(g, from).silver);
    coins(from, -amount);
    coins(to, amount);
    return amount;
  }
  function close() {
    return ids.map((id) => {
      const prize = awards.get(id),
        a = before.get(id),
        b = person(g, id);
      if (g.scoreOnly) b.score += prize;
      else coins(id, Math.ceil(prize / 10));
      return {
        id,
        points: b.score - a.score,
        silver: b.silver - a.silver,
        hp: b.hp - a.hp,
        attack: (b.eventAttack || 0) - (a.eventAttack || 0),
        shield: (b.eventShield || 0) - (a.eventShield || 0),
        total: b.score,
      };
    });
  }
  return { coins, points, attack, shield, heal, take, close };
}
function resolveDuel(c, a, b, onWin, onTie) {
  if (a === b) {
    c.text('双方平手');
    for (const id of [c.host, c.target]) onTie(id);
  } else {
    const winner = a > b ? c.host : c.target;
    c.text(c.name(winner) + ' 获胜');
    onWin(winner);
  }
}
function guessing(c, tactical) {
  const correct = c.choice(c.host) === c.choice(c.target);
  const winner = correct ? c.target : c.host;
  c.text(
    c.name(c.target) +
      (correct ? ' 猜中' : ' 猜错') +
      ' · ' +
      c.name(winner) +
      ' 获奖',
  );
  if (tactical) {
    c.attack(winner, 1);
    c.coins(winner, 1);
  } else c.points(winner, 20);
}
function duel(c, method, prize) {
  let left, right;
  if (method === 'rps') {
    const hand = ['rock', 'scissors', 'paper'];
    const diff =
      (hand.indexOf(c.choice(c.target)) - hand.indexOf(c.choice(c.host)) + 3) %
      3;
    left = diff === 2 ? -1 : diff;
    right = 0;
  } else if (method === 'dice') {
    const a = [c.die(), c.die()],
      b = [c.die(), c.die()];
    [left, right] = [a[0] + a[1], b[0] + b[1]];
    c.text(
      c.name(c.host) +
        ' ' +
        a.join('+') +
        '　' +
        c.name(c.target) +
        ' ' +
        b.join('+'),
    );
  } else {
    left = -Math.abs(7 - Number(c.choice(c.host)));
    right = -Math.abs(7 - Number(c.choice(c.target)));
  }
  resolveDuel(
    c,
    left,
    right,
    (id) => (prize === 'points' ? c.points(id, 20) : c[prize](id, 1)),
    (id) => (prize === 'points' ? c.points(id, 10) : c.coins(id, 1)),
  );
}
function split(c, camp) {
  const grabbers = [c.host, c.target].filter((id) => c.choice(id) === 'grab');
  if (!grabbers.length)
    for (const id of [c.host, c.target])
      camp ? c.heal(id, 1) : c.points(id, 15);
  else if (grabbers.length === 1)
    camp ? c.coins(grabbers[0], 2) : c.points(grabbers[0], 24);
  c.text(['双方平分', '只有一人抢', '两人都抢，桌奖收回'][grabbers.length]);
}
function counts(c) {
  const groups = new Map();
  for (const id of c.ids) {
    const key = c.choice(id);
    groups.set(key, [...(groups.get(key) || []), id]);
  }
  return groups;
}
function auction(c, tactical) {
  const top = Math.max(...c.ids.map((id) => Number(c.choice(id))));
  if (!top) {
    c.text('无人出价');
    return;
  }
  const winners = c.ids.filter((id) => Number(c.choice(id)) === top);
  c.text('最高 ' + top + ' 银 · ' + winners.map(c.name).join('、'));
  for (const id of winners) {
    c.coins(id, -top);
    if (tactical) c.shield(id, 1);
    else c.points(id, Math.floor(30 / winners.length));
  }
}
const settlements = {
  rps: (c) => duel(c, 'rps', 'points'),
  colorBluff: (c) => guessing(c, false),
  oddEven(c) {
    const roll = c.die();
    c.text('骰面 ' + roll);
    for (const id of c.ids)
      if (c.choice(id) === (roll % 2 ? 'odd' : 'even')) c.points(id, 15);
  },
  highLow(c) {
    const rank = 2 + c.randomInt(13);
    c.text('翻出 ' + c.rankName(rank));
    for (const id of c.ids) {
      if (rank === 8) c.points(id, 8);
      else if (c.choice(id) === (rank > 8 ? 'high' : 'low')) c.points(id, 18);
    }
  },
  harmony(c) {
    const same = c.choice(c.host) === c.choice(c.target);
    c.text(same ? '两人暗号一致' : '两人暗号不同');
    for (const id of [c.host, c.target]) c.points(id, same ? 20 : 4);
  },
  split: (c) => split(c, false),
  minority(c) {
    const groups = [...counts(c).values()],
      small = Math.min(...groups.map((g) => g.length));
    const tie = groups.length === 2 && groups[0].length === groups[1].length;
    for (const group of groups)
      for (const id of group)
        c.points(
          id,
          groups.length === 1 ? 3 : tie ? 8 : group.length === small ? 18 : 0,
        );
  },
  majority(c) {
    const groups = [...counts(c).values()],
      max = Math.max(...groups.map((g) => g.length));
    const leaders = groups.filter((g) => g.length === max);
    for (const group of leaders)
      for (const id of group) c.points(id, leaders.length > 1 ? 6 : 12);
  },
  singleSuit(c) {
    for (const group of counts(c).values())
      for (const id of group) c.points(id, group.length === 1 ? 18 : 2);
  },
  uniqueHigh(c) {
    const groups = counts(c);
    for (const number of ['3', '2', '1'])
      if (groups.get(number)?.length === 1) {
        c.points(groups.get(number)[0], 24);
        c.text('独报最高 ' + number);
        return;
      }
    c.text('没人独报');
    for (const id of c.ids) c.points(id, 4);
  },
  twoPots(c) {
    for (const [pot, people] of counts(c)) {
      const award = Math.floor((pot === 'silver' ? 6 : 30) / people.length);
      for (const id of people)
        pot === 'silver' ? c.coins(id, award) : c.points(id, award);
    }
  },
  prizeBid: (c) => auction(c, false),
  diceDuel: (c) => duel(c, 'dice', 'points'),
  relay(c) {
    const n = c.ids.length;
    c.ids.forEach((id, i) => {
      const neighbors = new Set([c.ids[(i + n - 1) % n], c.ids[(i + 1) % n]]);
      for (const other of neighbors)
        if (c.choice(other) !== c.choice(id)) c.points(id, 6);
    });
  },
  bouquet(c) {
    for (const id of c.ids) {
      const other = c.choice(id);
      c.points(other, 6);
      if (c.choice(other) === id) c.points(id, 8);
    }
  },
  closeSeven: (c) => duel(c, 'seven', 'points'),
  levy(c) {
    let collected = 0;
    for (const id of c.others) collected += c.take(id, c.host, 1);
    c.points(c.host, 5 + collected * 3);
    c.text('共收到 ' + collected + ' 银');
  },
  richPurse(c) {
    const n = c.wallet(c.target) > c.wallet(c.host) ? 3 : 1;
    c.text('借到 ' + c.take(c.target, c.host, n) + ' 银');
    c.points(c.host, 10);
  },
  safety(c) {
    if (c.choice(c.host) === 'bank') {
      c.points(c.host, 12);
      c.coins(c.host, 1);
    } else {
      const roll = c.die();
      c.text('骰面 ' + roll);
      c.points(c.host, roll >= 3 ? 28 : 4);
    }
  },
  draftLeader(c) {
    const ahead = c.seat(c.target).score > c.seat(c.host).score;
    c.points(c.host, ahead ? 20 : 8);
    c.points(c.target, 5);
  },
  patron(c) {
    c.points(c.host, 14);
    if (c.choice(c.target) === 'points') {
      c.points(c.target, 8);
      c.coins(c.host, 1);
    } else {
      c.coins(c.target, 2);
      c.points(c.host, 6);
    }
  },
  cushion(c) {
    c.points(c.host, 8 + 4 * (5 - c.hand(c.host).length));
    for (const id of c.others) c.points(id, 2);
  },
  reliefVote(c) {
    for (const id of c.others) {
      if (c.choice(id) === 'silver') {
        c.take(id, c.host, 1);
        c.points(id, 6);
      } else {
        c.points(c.host, 4);
        c.points(id, 2);
      }
    }
  },
  borrowSuit(c) {
    const counts = new Map();
    for (const card of c.hand(c.target))
      counts.set(card.suit, (counts.get(card.suit) || 0) + 1);
    const high = Math.max(...counts.values());
    c.text('同一花色最多 ' + high + ' 张');
    c.points(c.host, 4 + 5 * high);
    c.points(c.target, 4);
  },
  royalTea(c) {
    let number = 0;
    for (const id of c.ids) {
      const court = c
        .hand(id)
        .filter(
          (card) =>
            card.rank >= 11 &&
            card.rank <= 13 &&
            (['h', 'd'].includes(card.suit) ? 'red' : 'black') ===
              c.choice(c.host),
        );
      if (court.length) {
        c.points(id, 3);
        number += court.length;
      }
    }
    c.text('找到 ' + number + ' 张人头牌');
    c.points(c.host, 4 + 3 * Math.min(8, number));
  },
  smallSteps(c) {
    const low = Math.min(...c.ids.map((id) => Number(c.choice(id))));
    c.text('最低点数 ' + c.rankName(low));
    for (const id of c.ids) if (Number(c.choice(id)) === low) c.points(id, 12);
    c.points(c.host, 8);
  },
  makeTen(c) {
    const val = (id) => (c.choice(id) === '14' ? 1 : Number(c.choice(id)));
    const sum = val(c.host) + val(c.target);
    c.text('点数和 ' + sum);
    c.points(c.host, sum <= 10 ? 2 * sum : 6);
    c.points(c.target, sum <= 10 ? 6 : 2);
  },
  blindBag(c) {
    const [points, silver] = [
      [6, 3],
      [16, 1],
      [28, 0],
    ][c.x.bags[Number(c.choice(c.host))]];
    c.points(c.host, points);
    c.coins(c.host, silver);
    c.text('福袋里有 ' + points + ' 奖分、' + silver + ' 银');
  },
  doubleTicket(c) {
    const tickets = [...c.ids, c.host],
      winner = tickets[c.randomInt(tickets.length)];
    c.text('抽中 ' + c.name(winner));
    c.points(winner, 24);
    c.points(c.host, 6);
  },
  secondDie(c) {
    const call = c.choice(c.host);
    if (call === 'bank') {
      c.points(c.host, 10);
      c.text('收手');
      return;
    }
    const first = c.x.openDie,
      second = c.die();
    c.text('第一骰 ' + first + ' · 第二骰 ' + second);
    c.points(
      c.host,
      first === second ? 14 : second > first === (call === 'up') ? 24 : 4,
    );
  },
  redEnvelope(c) {
    if (c.choice(c.host) === 'all') {
      for (const id of c.ids) c.points(id, 6);
      c.points(c.host, 12);
    } else {
      const low = Math.min(...c.others.map((id) => c.seat(id).score));
      c.points(c.host, 22);
      for (const id of c.others) if (c.seat(id).score === low) c.points(id, 6);
    }
  },
  receipts(c) {
    const auction = c.g.lastAward,
      winners = new Set(auction?.lots.map((lot) => lot.winner) || []);
    const lost = (auction?.entries || []).filter(
      (row) =>
        row.kind === 'bid' && !winners.has(row.id) && c.ids.includes(row.id),
    );
    for (const { id } of lost) c.coins(id, 1);
    c.points(c.host, 10 + 3 * lost.length);
    c.text(lost.length + ' 席领到返现');
  },
  warDrum: (c) => duel(c, 'rps', 'attack'),
  shieldDice: (c) => duel(c, 'dice', 'shield'),
  colorGuard(c) {
    const red = c.randomInt(2) === 0;
    c.text('翻出' + (red ? '红牌' : '黑牌'));
    for (const id of c.ids)
      if (c.choice(id) === (red ? 'red' : 'black')) c.shield(id, 1);
  },
  banner(c) {
    const same = c.choice(c.host) === c.choice(c.target);
    for (const id of [c.host, c.target])
      same ? c.attack(id, 1) : c.shield(id, 1);
    c.text(same ? '同一号令 · 加攻' : '不同号令 · 得盾');
  },
  camp: (c) => split(c, true),
  shieldBid: (c) => auction(c, true),
  ambush: (c) => guessing(c, true),
  sevenGuard: (c) => duel(c, 'seven', 'shield'),
  bandage(c) {
    if (c.seat(c.host).hp <= 2) c.shield(c.host, 1);
    c.heal(c.host, 1);
  },
  ward: (c) => c.shield(c.host, 2),
  supply(c) {
    const val = c.choice(c.host);
    c.coins(c.host, val === 'silver' ? 3 : 1);
    if (val === 'shield') c.shield(c.host, 1);
    if (val === 'drum') c.attack(c.host, 1);
  },
  shareHeal(c) {
    c.heal(c.host, 1);
    c.heal(c.target, 1);
    c.coins(c.host, 1);
  },
  underdog(c) {
    if (c.seat(c.target).hp > c.seat(c.host).hp) {
      c.heal(c.host, 1);
      c.shield(c.host, 1);
    } else c.coins(c.host, 2);
    c.coins(c.target, 1);
  },
  healingDice(c) {
    const a = c.die(),
      b = c.die();
    c.shield(c.host, 1);
    c.text('骰面 ' + a + '、' + b);
    if (Math.max(a, b) >= 4) c.heal(c.host, 1);
    else c.coins(c.host, 2);
  },
  riposte(c) {
    if (c.choice(c.host) === 'drum') c.attack(c.host, 2);
    else c.shield(c.host, 2);
  },
  lastSupply(c) {
    if (c.seat(c.host).hp <= 2) {
      c.heal(c.host, 1);
      c.shield(c.host, 1);
    } else {
      c.coins(c.host, 2);
      c.attack(c.host, 1);
    }
  },
};
export function settleEvent(g) {
  const x = g.interaction,
    host = x.hosts[x.turn],
    ids = g.players
      .filter((p) => g.showdown.some((r) => r.id === p.id))
      .map((p) => p.id);
  demand(
    x.stage !== 'result' && x.results.length === x.turn,
    '这次互动已经结算',
  );
  const facts = [],
    dice = [],
    awards = ledger(g, ids);
  const c = {
    g,
    x,
    host,
    target: x.target,
    ids,
    others: ids.filter((id) => id !== host),
    ...awards,
    name: (id) => person(g, id).name,
    seat: (id) => person(g, id),
    wallet: (id) => person(g, id).silver,
    hand: (id) => g.showdown.find((row) => row.id === id).main,
    choice: (id) => x.answers[id],
    text: (note) => facts.push(note),
    randomInt: (n) => Math.floor(random(g) * n),
    die: () => {
      const n = 1 + Math.floor(random(g) * 6);
      dice.push(n);
      return n;
    },
    rankName: (rank) =>
      ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' })[rank] || String(rank),
  };
  const answers = x.participants.map((id) => ({
    id,
    value: x.answers[id],
    label:
      answerOptions(g, id).find((option) => option.value === x.answers[id])
        ?.label || '',
  }));
  settlements[x.event](c);
  return {
    event: x.event,
    host,
    target: x.target,
    blind: x.blind,
    answers,
    facts,
    dice,
    gains: awards.close(),
  };
}
