import { GOODS, getCard } from './content/definitions.mjs';
import { buildChoiceSelection, cardKey, goodsTotal } from './game-ui-model.mjs';

const ids = GOODS.map(good => good.id).sort();
const stockIds = stock => ids.filter(id => stock?.[id] > 0);

/** Local choices use only the viewer's hand and public stock. They never simulate a draw. */
export function cardDraftChoices(game, selfId, detail) {
  const self = game.players.find(player => player.id === selfId);
  if (!self || !detail) return [];
  const face = getCard(detail.card.definitionId), code = face.sourceCode;
  const peers = game.players.filter(player => player.id !== selfId);
  const peer = peers.find(player => player.id === (peers.length === 1 ? peers[0].id : detail.targetId));
  const hand = self.hand.filter(card => cardKey(card) !== (!detail.tool ? cardKey(detail.card) : null));
  const options = (kind, values, title) => ({ kind: detail.tool ? 'tool' : 'character', code,
    ownerId: selfId, actorId: selfId, targetId: peer?.id, sourceCards: [detail.card],
    title, choice: { kind, options: values } });
  const goods = (kind, stock, minimum, maximum, title) => options(kind, [{ goods: { ...stock }, minimum, maximum }], title);
  const cards = hand.map(cardKey).sort();
  const payments = [...self.hand.map(card => ({ zone: 'hand', cardId: cardKey(card) })),
    ...self.tools.map(card => ({ zone: 'tool', cardId: cardKey(card) }))]
    .sort((a, b) => a.cardId.localeCompare(b.cardId) || a.zone.localeCompare(b.zone));
  if (detail.tool) {
    switch (code) {
      case 'T01': return [options('tool-search-payment', [...(self.silver >= 1 ? [{ kind: 'silver' }] : []),
        ...cards.map(cardId => ({ kind: 'card', cardId }))], '搜到货物牌后支付')];
      case 'T02': return peer ? [options('tool-exchange', [{ ownGoodIds: stockIds(self.goods), otherGoodIds: stockIds(peer.goods) }], '双方各换一件')] : [];
      case 'T03': return [options('tool-discard-draw', [{ cardIds: cards, min: 1, max: Math.min(2, cards.length) }], '点自己的手牌：弃1～2张，补抽同数')];
      case 'T06': return [options('tool-goods-draw', stockIds(self.goods).map(goodId => ({ goodId })), '交回自己的1件货物')];
      case 'T07': return [options('tool-discard-swap', cards.map(cardId => ({ cardId })), '点自己的手牌，与弃牌顶交换')];
      case 'T08': return [options('tool-payment-silver', payments.map(payment => ({ payment })), '点自己的手牌或装备：弃1张，得2两')];
      case 'T09': return [options('tool-buy-good', stockIds(game.bankGoods).map(goodId => ({ goodId })), '付2两，取得公库1件货物')];
      case 'T10': return [options('tool-payment-good', [{ goodIds: stockIds(game.bankGoods), payments }], '选择货物；点手牌或装备作为费用')];
      default: return [];
    }
  }
  switch (code) {
    case 'C01': {
      const branch = options('benefit-branch', [{ branch: 'draw' }, { branch: 'goods' }], '自己的收益；另一项归对手');
      const choice = branch.choice.options[detail.choiceInputs?.[0]?.optionIndex];
      return [branch, ...(choice?.branch === 'goods' && goodsTotal(game.bankGoods) ?
        [options('benefit-good', stockIds(game.bankGoods).map(goodsId => ({ goodsId })), '自己取得的同种货物（最多2件）')] : [])];
    }
    case 'C05': return [options('trade-card', hand.filter(card => {
      const cardFace = getCard(card.definitionId);
      return cardFace.category === 'goods' && goodsTotal(cardFace.goods) === 3;
    }).map(card => ({ cardId: cardKey(card) })), '点手牌里的三件货物牌，决定卖价'),
    goods('sell-goods', self.goods, 3, 3, '选择自己出售的3件库存')];
    case 'C06': return [options('exchange', stockIds(self.goods).flatMap(fromGoodsId =>
      ids.filter(toGoodsId => toGoodsId !== fromGoodsId && game.bankGoods[toGoodsId] >= self.goods[fromGoodsId])
        .map(toGoodsId => ({ fromGoodsId, toGoodsId }))), '整类库存换成同数的另一类')];
    case 'C08': return [options('hand-branch', [...(hand.length < 5 && game.deckCount + game.discard.length ? [{ branch: 'draw' }] : []),
      ...((peer?.handCount ?? peer?.hand?.length ?? 0) > 3 ? [{ branch: 'discard' }] : [])], '自己补牌，或让对手弃牌')];
    case 'C09': return [goods('auction-goods', game.bankGoods, 2, 2, '选择2件货物作为整组拍品')];
    case 'C10': return [options('artisan-good', ids.filter(id => game.bankGoods[id] >= 2).map(goodsId => ({ goodsId })), '付2两，取得同种货物2件')];
    case 'C11': return [options('recover-tool', game.discard.filter(card => getCard(card.definitionId).category === 'tool')
      .map(card => ({ cardId: cardKey(card) })), '取回公开弃牌里的1件道具')];
    case 'C13': return [goods('sell-stock', self.goods, 1,
      Math.min(goodsTotal(self.goods), Math.floor((Number.MAX_SAFE_INTEGER - self.silver) / 2)), '每交回1件库存，取得2两')];
    default: return [];
  }
}

export function cardDraftSelections(game, selfId, detail) {
  return cardDraftChoices(game, selfId, detail).map((pending, index) => ({ kind: pending.choice.kind,
    selection: buildChoiceSelection(pending, detail.choiceInputs?.[index] ?? {}) }));
}

export function cardDraftCost(game, selfId, detail, selections = [], { short = false, borrowed = false } = {}) {
  const face = getCard(detail.card.definitionId), code = face.sourceCode;
  const self = game.players.find(player => player.id === selfId);
  const selection = selections[0]?.selection;
  const extraTemporary = count => self && !self.temporaryOccupied && goodsTotal(self.goods) + count > self.ordinaryCapacity ? '；新占临时格另付2两' : '';
  if (borrowed) {
    if(short){
      const fees={T01:`搜到后${selection?.kind==='card'?'弃手牌':'付1两'}`,T02:'双方各换1货',T03:'弃1～2手牌补同数',T04:'各留1张',T05:'付1两',T06:'交1货',T08:'弃所选牌得2两',T09:'付2两',T10:'弃所选牌'};
      const temporary=['T09','T10'].includes(code)&&extraTemporary(1)?'；新占临时格2两':'';
      return `已拆·借用0步；${fees[code]??'按道具结算'}${temporary}。`;
    }
    const costs = {
      T01: `搜到后${selection?.kind === 'card' ? '弃所选手牌' : '付1两'}。`,
      T02: '双方各换1货；临时格不重复收费。',
      T03: '弃所选1～2张手牌，补抽同数。',
      T04: '摸2张，自留1张，另一张给所选对手。',
      T05: '付1两，抽1张。',
      T06: '交回所选1货，抽1张。',
      T08: '弃所选牌，得2两。',
      T09: `付2两取1货${extraTemporary(1)}。`,
      T10: `弃所选牌取1货${extraTemporary(1)}。`,
    };
    return `术士的行动与拆除已发生；借用不计步；${costs[code] ?? '按道具效果结算。'}`;
  }
  if (face.category === 'tool' && !detail.tool) return short ? '安装0行动；使用时另计费用。' : '确认安装不耗行动；使用时按牌面支付行动和费用，取消保留原状。';
  if (short) {
    if (detail.tool) {
      if (code === 'T01') return `1行动；搜到后${selection?.kind === 'card' ? '弃所选手牌' : '付1两'}。`;
      if (code === 'T04') return '1行动；摸2张，自留1张，另一张给对手。';
      if (code === 'T05') return '1行动＋1两；抽1张。';
      if (code === 'T08') return '1行动；弃所选牌，得2两。';
      if (code === 'T09') return `1行动＋2两${extraTemporary(1)}。`;
      if (code === 'T10') return `1行动；弃所选牌${extraTemporary(1)}。`;
      return '确认使用耗1行动；取消保留原状。';
    }
    if (code === 'C10') return `1行动＋2两${extraTemporary(2)}；放不下再选保留。`;
    if (code === 'C05') {
      const card=self.hand.find(card=>cardKey(card)===selection?.cardId);
      return `1行动；出售3件，获得${card?getCard(card.definitionId).sellSilver+2*game.bookLayers:'牌面卖价'}两。`;
    }
    if (code === 'C13' && selection) return `1行动；出售${goodsTotal(selection.goods)}件，得${goodsTotal(selection.goods)*2}两。`;
    if (code === 'C01' && selection?.branch === 'goods') return `1行动${extraTemporary(Math.min(2,game.bankGoods[selections[1]?.selection?.goodsId]??0))}；对手抽最多2张。`;
    if (code === 'M01') return `1行动；生效取1货${extraTemporary(1)}；被反制不收货物费。`;
    return '确认使用耗1行动；取消保留原状。';
  }
  if (detail.tool) {
    if (code === 'T01') return `确认后耗1行动并搜寻；搜到才${selection?.kind === 'card' ? '弃所选手牌' : '付1两'}。`;
    if (code === 'T04') return '确认后耗1行动并摸出2张；再自留1张，另一张交给所选对手。';
    if (code === 'T05') return '确认后耗1行动、付1两并抽1张牌。';
    if (code === 'T08') return '确认后耗1行动，弃所选牌，获得2两。';
    if (code === 'T09') return `确认后耗1行动、付2两${extraTemporary(1)}。`;
    if (code === 'T10') return `确认后耗1行动，弃所选手牌或装备${extraTemporary(1)}。`;
    return '确认后耗1行动并使用道具；取消不扣费、不横置。';
  }
  if (code === 'C10') return `确认后耗1行动、付2两${extraTemporary(2)}；超出货位须选择保留。`;
  if (code === 'C05') {
    const card = self.hand.find(card => cardKey(card) === selection?.cardId);
    return `确认后耗1行动、出售3件，获得${card ? getCard(card.definitionId).sellSilver + 2 * game.bookLayers : '牌面卖价'}两。`;
  }
  if (code === 'C13' && selection) return `确认后耗1行动、出售${goodsTotal(selection.goods)}件，获得${goodsTotal(selection.goods) * 2}两。`;
  if (code === 'C01' && selection?.branch === 'goods') return `确认后耗1行动${extraTemporary(Math.min(2,game.bankGoods[selections[1]?.selection?.goodsId]??0))}；自己取得同种最多2件，对手抽最多2张牌。`;
  if (code === 'M01') return `确认后耗1行动；生效时取得对手1件货物${extraTemporary(1)}；被反制不收货物费，超容量再选保留。`;
  return '确认后耗1行动并使用此牌；取消保留原状。';
}
