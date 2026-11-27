import { gamePath } from '../../entry-path.mjs';
/** Presentation catalog only. Legacy rule material catalogs retain their original bounds. */
import * as base from './content/definitions.mjs';
import * as expansion from './content/expansion-one.mjs';
import {
  EXPANSION_TWO_PACK_ID,
  EXPANSION_TWO_CONTENT_VERSION,
  EXPANSION_TWO_BASE_CONTENT_VERSION,
  TRADE_ROUTES_CARDS,
  TRADE_ROUTES_ROLES,
  composeTradeRoutes
} from './content/expansion-two.mjs';
// Both editions use the same illustrated goods in hands, stock and decisions.
export const GOODS = Object.freeze(
  expansion.GOODS.map((good) =>
    Object.freeze({
      ...good,
      icon: good.icon.includes('/expansion-one/')
        ? '/assets/hyakki/night-goods/' + good.id + '.svg'
        : good.icon
    })
  )
);
const baseGoodIds = new Set(base.GOODS.map((good) => good.id));
const baseGoods = Object.freeze(GOODS.filter((good) => baseGoodIds.has(good.id)));
export const CARDS = base.CARDS,
  CATEGORIES = base.CATEGORIES;
const configurationOf = (value) => value?.configuration ?? value?.opening?.configuration ?? value;
export const isExpansion = (value) =>
  [expansion.EXPANSION_PACK_ID, EXPANSION_TWO_PACK_ID].includes(configurationOf(value)?.packId);
export const goodsFor = (value) => (isExpansion(value) ? GOODS : baseGoods);
export const cardsFor = (value) => {
  const config = configurationOf(value);
  if (config?.packId === EXPANSION_TWO_PACK_ID)
    return composeTradeRoutes(config.playerCount ?? 2, config.modules).cards;
  return isExpansion(config) ? expansion.cardsForExpansion(config.contentVersion) : base.CARDS;
};
// All instances of an expansion piece use the same illustration, including seat portraits.
function illustrateTradeRoutes(piece) {
  return {
    ...piece,
    artPath: '/assets/hyakki/night-illustrations/' + piece.sourceCode.toLowerCase() + '.webp'
  };
}
export function rolesFor(value) {
  const config = configurationOf(value);
  return config?.packId === EXPANSION_TWO_PACK_ID
    ? composeTradeRoutes(config.playerCount ?? 2, config.modules).roles.map((role) =>
        role.sourceCode.startsWith('E2') ? illustrateTradeRoutes(role) : role
      )
    : expansion.ROLES;
}
export function getRole(id, configuration = null) {
  const next = TRADE_ROUTES_ROLES.find((role) => role.id === id);
  if (next) return illustrateTradeRoutes(next);
  if (
    id === 'yousei.role.r08' &&
    configuration?.packId === EXPANSION_TWO_PACK_ID &&
    configuration.modules?.orders
  ) {
    const role = expansion.getRole(id, {
      ...configuration,
      contentVersion: EXPANSION_TWO_BASE_CONTENT_VERSION
    });
    return {
      ...role,
      compactText: '整批出售／交单＋2两',
      summary: '用货物牌卖出恰好3件同种货物，或交公单时交出至少3件同种货物，多得2两。',
      details: ['每个自己的回合合计限1次。买办代卖也算。', '普通货和精制货可合计，同类的不同货物分开算。'],
      example: '交「军工集采」时交出4件普通火器，公单给11两，整批行商加2两，共13两。'
    };
  }
  return expansion.getRole(
    id,
    configuration?.contentVersion === EXPANSION_TWO_CONTENT_VERSION
      ? { ...configuration, contentVersion: EXPANSION_TWO_BASE_CONTENT_VERSION }
      : configuration
  );
}
export function getCard(id, configuration = null) {
  if ([...expansion.ROLES, ...TRADE_ROUTES_ROLES].some((r) => r.id === id))
    return {
      ...getRole(id, configuration),
      category: 'role',
      timingLabel: '常驻角色',
      costText: '不占装备槽',
      copies: 1
    };
  const tradeCard = TRADE_ROUTES_CARDS.find((c) => c.id === id);
  const found = tradeCard ? illustrateTradeRoutes(tradeCard) : expansion.CARDS.find((c) => c.id === id);
  return found && !found.original
    ? {
        ...found,
        copies: found.copiesByPlayerCount[2],
        timingLabel: found.category === 'tool' ? '自己回合使用' : '自己回合用牌阶段'
      }
    : found?.original
      ? { ...base.getCard(id), name: found.name }
      : base.getCard(id);
}
export const getGood = (id) => GOODS.find((g) => g.id === id) ?? base.getGood(id);
export const getCategory = (id) => (id === 'role' ? { id, name: '常驻角色' } : base.getCategory(id));
export const categoryName = (id) => expansion.CATEGORIES.find((c) => c.id === id)?.name ?? id;
// Rules name logical artwork; base portraits from assetPath already include the current entry.
export const expansionAsset = path => path.startsWith('/assets/') ? gamePath(path) : path;
