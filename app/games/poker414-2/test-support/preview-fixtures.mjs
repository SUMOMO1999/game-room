// Local synthetic density examples, not authoritative room or action history.
import { makeDeck } from '../cards.mjs';

export const SCENES = Object.freeze([
  ['waiting', '准备室 · 3人'], ['waiting-eight', '准备室 · 8人'],
  ['opening', '3人 · 36张手牌'], ['eight', '8人 · 14张手牌'],
  ['response', '勾叉 · 5秒响应'], ['dense', '98张公牌 · 八张接链'],
  ['spectator', '全知观战 · 8人'], ['finished', '结算'], ['cancelled', '失联取消'],
]);
const names = ['小禾', '长昵称的朋友也想好好打牌', 'Akira', '月亮', '小林', '七七', 'Leo', '夏天'];
const id = i => i === 0 ? 'preview-self' : `preview-player-${i}`;

function historyStrips(cards) {
  const groups = [];
  for (let offset = 0; offset < cards.length; offset += 6) {
    groups.push({ id: `history-strip-${offset}`, displayKind: 'history-strip',
      label: `已出牌第${offset / 6 + 1}排 · 多次行动`, cards: cards.slice(offset, offset + 6) });
  }
  return groups;
}

function penalty(hand) {
  // Fixture scoring follows the published formula, independently of the engine.
  const count = rank => hand.filter(card => card.rank === rank).length;
  const rockets = Math.min(Math.floor(count(4) / 2), count(14));
  const jokerBombs = Math.min(count(16), count(17));
  return 10 * rockets + 5 * jokerBombs + hand.length - 3 * rockets - 2 * jokerBombs;
}

export function fixture(scene = 'opening', now = Date.now()) {
  if (!SCENES.some(([key]) => key === scene)) throw new RangeError('未知演示局面。');
  const count = ['waiting', 'opening', 'response'].includes(scene) ? 3 : 8;
  const deck = makeDeck(), players = names.slice(0, count).map((name, i) => ({
    id: scene === 'spectator' && i === 0 ? 'preview-seated-0' : id(i), name, ready: i !== 0, count: 0, hand: [],
  }));
  const seatOrder = players.map(player => player.id), actionOrder = [seatOrder[0], ...seatOrder.slice(1).reverse()];
  const publicGroups = [];
  const undealtCards = [];
  let available = [...deck];
  let firstPlayerId = id(1);
  if (scene.startsWith('waiting') || scene === 'cancelled') {
    // There is no match in the preparation room. This deck is fixture accounting
    // only; page rendering must never present it as anyone's private hand.
    undealtCards.push(...available); available = []; firstPlayerId = null;
  } else if (scene === 'dense') {
    const chain = available.filter(card => card.rank === 6);
    const rest = available.filter(card => card.rank !== 6);
    const publicCards = rest.splice(0, 90);
    publicGroups.push(...historyStrips(publicCards));
    publicGroups.push({ id: 'eight-chain', displayKind: 'target', label: '对牌→勾→叉→勾→叉 · 八张6', cards: chain });
    available = rest;
    const sizes = [2, 2, 1, 1, 1, 1, 1, 1];
    for (let i = 0; i < count; i++) players[i].hand = available.splice(0, sizes[i]);
  } else if (scene === 'finished') {
    const finalBomb = available.filter(card => card.rank === 6);
    const hands = [[],
      ['spades-4-0', 'hearts-4-0', 'spades-14-0'],
      ['joker-16-0', 'joker-17-0'],
      ['joker-16-1', 'joker-17-1', 'spades-3-0'],
      ['clubs-4-0', 'diamonds-4-0', 'clubs-14-0', 'clubs-4-1', 'diamonds-4-1', 'diamonds-14-0'],
      ['spades-7-0', 'hearts-7-0'], ['spades-8-0'], ['spades-9-0']];
    for (let i = 1; i < count; i++) {
      players[i].hand = hands[i].map(suffix => deck.find(card => card.id === `p414-2-${suffix}`));
    }
    const remainingIds = new Set(players.flatMap(player => player.hand.map(card => card.id)));
    const previousCards = deck.filter(card => !remainingIds.has(card.id) && card.rank !== 6);
    publicGroups.push(...historyStrips(previousCards));
    publicGroups.push({ id: 'last-play', displayKind: 'target', label: '小禾 · 最后一手 · 八张6炸弹', cards: finalBomb });
    available = [];
  } else if (scene === 'response') {
    const target = available.find(card => card.rank === 9);
    publicGroups.push({ id: 'target-nine', displayKind: 'target', label: `${players[1].name} · 单牌9`, cards: [target] });
    available = available.filter(card => card.id !== target.id);
    players[0].hand = available.filter(card => card.rank === 9).slice(0, 2);
    available = available.filter(card => !players[0].hand.some(held => held.id === card.id));
    // Three players originally received 36 each; only the target's owner has
    // played once. Keep the responder at 36, not 38 after seeding two nines.
    const remainingSizes = [36, 35, 36];
    for (let i = 0; available.length; i++) {
      const playerIndex = i % count;
      if (players[playerIndex].hand.length < remainingSizes[playerIndex]) players[playerIndex].hand.push(available.shift());
    }
  } else {
    // A deterministic shuffled order with the first heart three at the front
    // makes the displayed self player genuinely lead the untouched opening.
    const firstHeartIndex = available.findIndex(card => card.suit === 'hearts' && card.rank === 3);
    available.unshift(...available.splice(firstHeartIndex, 1));
    for (let i = 0; available.length; i++) {
      const player = players.find(candidate => candidate.id === actionOrder[i % count]);
      const card = available.shift();
      player.hand.push(card);
      if (card.suit === 'hearts' && card.rank === 3 && card.copyId === 0) firstPlayerId = player.id;
    }
  }
  for (const player of players) {
    player.hand.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    player.count = player.hand.length;
  }
  const view = {
    scene, roomCode: '414000', roomId: '414-preview-room', matchId: `preview-${scene}`,
    phase: scene.startsWith('waiting') ? 'waiting' : ['finished', 'cancelled'].includes(scene) ? scene : 'playing',
    selfId: 'preview-self', selfRole: scene === 'spectator' ? 'spectator' : 'player', hostId: players[0].id,
    players, spectators: count === 8 ? Array.from({ length: 8 }, (_, i) => ({
      id: scene === 'spectator' && i === 0 ? 'preview-self' : `observer-${i}`, name: `观众${i + 1}`,
    })) : [],
    seatOrder, actionOrder, turnPlayerId: scene.startsWith('waiting') || ['finished', 'cancelled'].includes(scene) ? null : players[0].id, firstPlayerId,
    publicGroups, undealtCards, hand: scene === 'spectator' ? [] : players[0].hand, target: publicGroups.at(-1) || null,
    targetOwnerId: publicGroups.length ? id(1) : null, response: scene === 'response' ? { id: 'response-1', action: 'fork', rank: 9, deadlineAt: now + 5000 } : null,
    result: null,
  };
  if (scene === 'finished') {
    const penalties = players.map(player => penalty(player.hand));
    const winningPoints = penalties.reduce((sum, points) => sum + points, 0);
    view.result = players.map((player, index) => {
      const delta = index === 0 ? winningPoints : -penalties[index];
      return { playerId: player.id, delta, balanceAfter: (index === 0 ? 100 : 50) + delta };
    });
    view.targetOwnerId = players[0].id;
  }
  return view;
}
