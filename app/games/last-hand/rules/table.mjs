import { items, suits } from './catalog.mjs';
import { awardTiming } from './award-timing.mjs';
export const version = 'olh-1';
export const timerFields = {
  matchMinutes: { label: '整桌限时', unit: '分钟', initial: 0, min: 0, max: 1440 },
  actionSeconds: { label: '出价、选物及战后行动', unit: '秒', initial: 180, min: 1, max: 3600 },
  peekSeconds: { label: '摸二留一', unit: '秒', initial: 120, min: 1, max: 3600 },
  buildSeconds: { label: '组主手', unit: '秒', initial: 300, min: 1, max: 3600 },
};
const decisionTimer = {
  auction: 'actionSeconds', growth: 'actionSeconds', attack: 'actionSeconds', interact: 'actionSeconds',
  peek: 'peekSeconds', build: 'buildSeconds',
};
export const phaseMs = {
  ...Object.fromEntries(Object.entries(decisionTimer).map(([name, key]) => [name, timerFields[key].initial * 1000])),
  award: awardTiming(null).duration,
  reveal: 9000,
  hit: 8000,
  finish: 0,
};
export function demand(test, message) {
  if (!test) throw new Error(message);
}
export function random(g) {
  let n = g.rng >>> 0;
  n ^= n << 13;
  n ^= n >>> 17;
  n ^= n << 5;
  g.rng = n >>> 0;
  return g.rng / 4294967296;
}
export function shuffle(g, list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random(g) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function deck(g) {
  return shuffle(
    g,
    suits.flatMap((suit) =>
      Array.from({ length: 13 }, (_, i) => ({ id: suit + (i + 2), rank: i + 2, suit })),
    ),
  );
}
export function draw(g) {
  if (!g.deck.length) {
    g.deck = shuffle(
      g,
      g.discard.filter((c) => !c.copy),
    );
    g.discard = [];
  }
  demand(g.deck.length, '桌上可抽的牌不足');
  return g.deck.pop();
}
export const alive = (g) => g.players.filter((p) => !p.out);
export const active = (g) => alive(g).filter((p) => p.sit !== g.battle);
export const has = (p, id) => p.relics.includes(id);
export const battleRelics = (p) => (p.boosts?.length ? [...p.relics, ...p.boosts] : p.relics);
export function attackBonus(p) {
  const effects = battleRelics(p);
  return (
    Number(effects.includes('fist')) +
    2 * Number(effects.includes('glass')) +
    Number(!!p.adrenaline) + (p.eventAttack || 0)
  );
}
export const person = (g, id) => g.players.find((p) => p.id === id);
export const battlesPerChapter = (g) => (g.chapterVersion >= 2 ? 4 : 3);
export const chapterIndex = (g) => Math.floor((g.battle - 1) / battlesPerChapter(g));
export const battleInChapter = (g) => (g.battle - 1) % battlesPerChapter(g) + 1;
export function note(g, s) {
  g.log.push(s);
  if (g.log.length > 160) g.log.shift();
}
export function phase(g, name, now) {
  g.phase = name;
  g.epoch++;
  g.ready = [];
  g.phaseDuration = phaseMs[name];
  const key = decisionTimer[name];
  if (key && g.settings[key] != null) g.phaseDuration = g.settings[key] * 1000;
  if (name === 'award') g.phaseDuration = awardTiming(g.award).duration;
  g.deadline = name === 'finish' ? null : now + g.phaseDuration;
  if (name === 'growth' && g.lastBattle && g.matchDeadline != null)
    g.deadline = Math.min(g.deadline, g.matchDeadline);
  g.botAt = now + (g.settings.fast ? 50 : 650);
  for (const p of g.players) p.revision++;
}
export function give(p, id) {
  const effect = items[id];
  if (effect.aim === 'receive') {
    p.silver += effect.silver || 0;
    p.gold += effect.gold || 0;
  } else if (effect.kind === 'relic') {
    if (has(p, id)) return false;
    p.relics.push(id);
  } else {
    p.tools.push(id);
  }
  if (id === 'charm') {
    p.maxHp++;
    p.hp++;
  }
  if (id === 'rebate') p.gold++;
  return true;
}
export function takeTool(p, id) {
  const i = p.tools.indexOf(id);
  demand(i >= 0, '没有这件道具');
  p.tools.splice(i, 1);
}
export function clearBattle(p) {
  p.boosts = [];
  p.hand = [];
  p.choice = null;
  p.guard = null;
  p.vow = false;
  p.used = {};
  p.pending = null;
  p.two = null;
  p.bank = 0;
  p.ledger ??= false;
  p.reserved = [];
  p.echo = false;
  p.autoPass = false;
}
