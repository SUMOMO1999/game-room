import { GOODS, createSampleDeck } from '../content.mjs';

export const SCENES = Object.freeze([
  ['active', '本人回合 · 2人'], ['six', '六人夜市'], ['dense', '120张手牌'],
  ['waiting', '准备室'], ['wait', '等待伙伴'], ['defense', '10秒防御'],
  ['bidder', '15秒竞价'], ['pending-leave', '待离席结算'], ['spectator', '观战'],
  ['paused', '暂停'], ['offline', '断线恢复'], ['result', '终局'], ['practice', '练习页面样板'],
]);

// Deliberately synthetic, public Step 0 material. No account, engine or storage.
export function fixture(scene = 'active') {
  if (!SCENES.some(([id]) => id === scene)) scene = 'active';
  const deck = createSampleDeck();
  const players = ['我（示范）', '灯笼铺老板', '这是一个非常长的夜市伙伴昵称用于阅读检查', '河童小店', '山里的天狗', '狸猫当铺'].slice(0, ['active', 'practice'].includes(scene) ? 2 : 6).map((name, index) => ({
    id: `sample-p${index + 1}`, name, money: [32, 27, 41, 19, 24, 36][index], capacity: index === 2 ? 30006 : 6 + (index % 3) * 3,
    goods: GOODS.map((good, n) => ({ id: good.id, count: (index + n) % 4 === 0 ? 1 : 0 })), ready: index !== 0,
  }));
  const featured = [deck.find(card => card.recipeId === 'ABC'), deck.find(card => card.recipeId === 'AABBCC'), ...['auction', 'theft', 'talisman', 'festival', 'stall-permit'].map(kind => deck.find(card => card.kind === kind)), ...deck.slice(0, 5)];
  const currentCard = scene === 'bidder' ? deck.filter(card => card.recipeId === 'AABBCC').at(-1)
    : scene === 'defense' ? deck.find(card => card.kind === 'theft') : null;
  return {
    scene, synthetic: true, sourceLabel: '朋友稿实验牌组', roomId: 'hyakki-step0-room', roomCode: '120006', selfId: 'sample-p1', selfRole: scene === 'spectator' ? 'spectator' : 'player',
    players, spectatorCount: 8, hand: scene === 'spectator' ? [] : scene === 'dense' ? [...deck] : featured.filter(card => card.id !== currentCard?.id),
    market: GOODS.map((good, index) => ({ ...good, count: [18, 16, 19, 15, 17, 18][index] })),
    actionPoints: 4, activeRemaining: 126, countdown: scene === 'defense' ? 10 : scene === 'bidder' ? 15 : 126,
    phase: scene === 'waiting' ? 'waiting' : scene === 'result' ? 'result' : 'playing',
    currentPlayerId: ['active', 'dense', 'six', 'practice'].includes(scene) ? 'sample-p1' : 'sample-p2',
    currentCard,
    // Screenshot-derived layout sample only, not a new playable card or effect.
    equipmentLayout: scene === 'spectator' ? [] : [{ id: 'sample-jiuzhuan-furnace', name: '九转金炉', status: 'definition-pending',
      missing: ['具体效果与目标', '放置费用、条件与时点', '每回合使用次数、费用与限制', '失效、离场与回收方式'] }],
    selectedCardId: null,
  };
}
