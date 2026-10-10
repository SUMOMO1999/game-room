/** User-confirmed rules and screenshot quantities; the rule engine is not implemented. */
export const REFERENCE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'goods', name: '货物牌', quantity: '40 张', zone: '手牌 → 买卖 → 摊位货物', summary: '凭牌购买或出售货物；牌与摊位上的实际货物分开。', example: '货物牌', missing: '全部货物组合、买卖价格与每种副本数。' }),
  Object.freeze({ id: 'permit', name: '摊位许可牌', quantity: '5 张', zone: '使用许可 → 扩建摊位', summary: '购买摊位面板，扩展货物空间。', example: '摊位许可', missing: '图示 6／3 两的适用条件、每块容量与扩建上限。' }),
  Object.freeze({ id: 'character', name: '人物牌', quantity: '图示 29 张；与带标记牌的统计关系待核', zone: '手牌 → 发动效果', summary: '打出后产生各自的效果；人物牌不等于玩家角色。锦衣卫可取消对方监视标记人物牌的效果。', example: '锦衣卫', missing: '每张完整效果、锦衣卫的回应时机及费用。' }),
  Object.freeze({ id: 'watched-character', name: '人物牌（监视标记）', quantity: '图示 14 张；是否含在 29 张内待核', zone: '手牌 → 对方可用锦衣卫取消效果', summary: '打出后产生各自的效果；对方打出锦衣卫时，该牌效果被取消。', example: '带监视标记的人物', missing: '全部牌名与效果、标记原图、回应窗口、取消后的牌去向与费用。' }),
  Object.freeze({ id: 'item', name: '道具牌', quantity: '20 张', zone: '手牌 → 道具区 → 使用', summary: '先放置到道具区才能使用；道具每回合都可以使用。', example: '九转金炉', missing: '放置与使用费用、每回合次数、具体效果、移除与叠加规则。' }),
]);

export const REFERENCE_UNRESOLVED = '用户补充规则明确分为五类；人物牌与监视标记人物牌分开识别。顺手牵羊、黑市拍卖仍是朋友稿的行动示例，尚未对应到原版牌。';

export const REFERENCE_RULES = Object.freeze([
  '阶段1：一次只看牌堆顶的1张牌，每看一张计1次行动。弃掉后才可继续看下一张；一旦留下，就结束看牌阶段并进入出牌阶段，不能先看多张再挑选。',
  '阶段2：使用卡牌，每次推进公用行动标记1格；牌面明确不耗行动的除外。看牌与用牌共用次数，每回合开始重新计数。',
  '行动上限默认5，设计为房主开局前可调；本轮建议1～10次，开局后固定。例如前3张逐张弃掉，第4张留下，已用4次，只剩1次出牌。当前样板尚未接入房间配置。',
  '五类牌：货物牌、摊位牌、人物牌、人物牌（监视标记）、道具牌。道具先放入道具区才能使用，每回合都可使用；具体费用和次数仍看完整牌文。',
  '对方打出锦衣卫，可取消监视标记人物牌的效果；具体回应时机和费用待完整牌文明确。',
  '双人局只在回合结束时检查60两。起始玩家达到60两或更多，对手再进行最后一回合；非起始玩家达到则立即结束。',
  '游戏结束后银两最多者获胜；银两相同，最后一回合行动的玩家获胜。达到60两是触发收市，不保证获胜。',
]);

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
