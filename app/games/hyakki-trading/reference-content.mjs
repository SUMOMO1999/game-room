/** Evidence from the four user-supplied product screenshots, not playable rules. */
export const REFERENCE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'goods', name: '货物牌', quantity: '40 张', zone: '手牌 → 买卖 → 摊位货物', summary: '凭牌购买或出售货物；牌与摊位上的实际货物分开。', example: '货物牌', missing: '全部货物组合、买卖价格与每种副本数。' }),
  Object.freeze({ id: 'permit', name: '摊位许可牌', quantity: '5 张', zone: '使用许可 → 扩建摊位', summary: '购买摊位面板，扩展货物空间。', example: '摊位许可', missing: '图示 6／3 两的适用条件、每块容量与扩建上限。' }),
  Object.freeze({ id: 'character', name: '人物牌', quantity: '29 张；另列带标记人物牌 14 张', zone: '手牌 → 发动效果', summary: '打出后产生各自的效果；人物牌不等于玩家角色。', example: '锦衣卫', missing: '每张效果、费用、时机；监督标记 14 张与 29 张是否重复统计。' }),
  Object.freeze({ id: 'item', name: '道具牌', quantity: '20 张', zone: '手牌 → 道具区 → 使用', summary: '先放置到道具区才能使用；道具每回合都可以使用。', example: '九转金炉', missing: '放置与使用费用、每回合次数、具体效果、移除与叠加规则。' }),
]);

export const REFERENCE_UNRESOLVED = '截图没有列出独立“行动牌”大类；顺手牵羊、黑市拍卖仍保留为朋友稿的行动示例，暂不改称原版人物牌。';

/** Behaviour names from the first draft are not commercial card categories. */
export function draftCategory(kind) {
  if (kind === 'goods-card') return 'goods';
  if (kind === 'stall-permit') return 'permit';
  if (['festival', 'theft', 'talisman', 'auction'].includes(kind)) return 'action';
  throw new RangeError('未知的朋友稿牌种');
}
export const DRAFT_CATEGORIES = Object.freeze([
  { id: 'goods', name: '货物' }, { id: 'permit', name: '摊位许可' },
  { id: 'action', name: '行动（朋友稿）' },
].map(Object.freeze));
