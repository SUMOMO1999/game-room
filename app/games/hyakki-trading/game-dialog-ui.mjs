import { GOODS, getCard } from './content/definitions.mjs';
import { assetPath } from './content/manifest.mjs';
import { renderCard, renderGoodsIcon } from './digital-card-ui.mjs';
import { cardKey, choiceModel } from './game-ui-model.mjs';

export const dialogEscape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const esc = dialogEscape;
export const DIALOG_PAGE_SIZE = 6;

/** Pagination changes presentation only; original indexes remain the submitted choices. */
export function dialogPage(items, page = 0) {
  const pages = Math.max(1, Math.ceil(items.length / DIALOG_PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Number.isSafeInteger(page) ? page : 0));
  const start = current * DIALOG_PAGE_SIZE;
  return { items: items.slice(start, start + DIALOG_PAGE_SIZE), start, current, pages, total: items.length };
}

export function renderDialogPager(page, action = 'choice-page') {
  if (page.pages === 1) return '';
  const button = (label, number, disabled) => `<button type="button" data-hy-action="${action}" data-hy-fields="${esc(JSON.stringify({page:number}))}" ${disabled?'disabled':''}>${label}</button>`;
  return `<nav class="hy-dialog-pager" aria-label="候选分页">${button('上一页',page.current-1,page.current===0)}<span>第${page.current+1}/${page.pages}页 · 共${page.total}项</span>${button('下一页',page.current+1,page.current===page.pages-1)}</nav>`;
}

/** Small decision faces retain identity, goods quantities and price; full rules are one action away. */
export function renderCompactCard(card, { readButton = true, inline = false } = {}) {
  const face = getCard(card.definitionId ?? card.id), key = cardKey(card);
  const art = face.category === 'goods'
    ? `<span class="hy-compact-goods">${Object.entries(face.goods).map(([id,count])=>`<span title="${esc(GOODS.find(good=>good.id===id).name)}">${renderGoodsIcon(id)}<b>×${count}</b></span>`).join('')}</span>`
    : `<span class="hy-compact-art"><img src="${assetPath(face.artId)}" alt="" draggable="false" decoding="sync"></span>`;
  return `<span class="hy-compact-face" aria-label="${esc(face.name)}" data-definition-id="${esc(face.id)}"><strong>${esc(face.category==='goods'?(inline?'货物交易':face.sourceCode):face.name)}</strong>${art}<small>${face.category==='goods'?`买${face.buySilver} · 卖${face.sellSilver}两`:esc(face.sourceCode)}</small></span>${readButton?`<button type="button" data-hy-detail="${esc(key)}" aria-label="阅读${esc(face.name)}完整牌文">完整牌文</button>`:''}`;
}

export function renderCompactCards(cards, pageNumber = 0) {
  const page = dialogPage(cards,pageNumber);
  return `<div class="hy-compact-cards" style="--hy-card-count:${Math.max(1,page.items.length)}">${page.items.map(card=>`<article>${renderCompactCard(card)}</article>`).join('')}</div>${renderDialogPager(page,'cards-page')}`;
}

/** Current public pile only: each physical copy remains one independently readable card. */
export function renderPublicDiscardCards(cards, pageNumber = 0, { origins = [], originsLoaded = false, name = () => '伙伴' } = {}) {
  const page = dialogPage(cards, pageNumber);
  if (!cards.length) return '<p>弃牌区现在是空的。</p>';
  const reasons={used:'使用后弃置','draw-discarded':'摸看后弃置',replaced:'替换装备',payment:'作为费用',response:'用于回应','auction-unsold':'拍卖未成交',removed:'被移除'};
  return `<p class="hy-discard-guide">当前弃牌 · 最新在前 · 共${cards.length}张。</p><div class="hy-public-discard">${page.items.map((card,offset) => {
    const face = getCard(card.definitionId ?? card.id);
    const goods = Object.entries(face.goods ?? {}).map(([id, count]) => `${GOODS.find(good => good.id === id).name}×${count}`).join(' · ');
    const caption = face.category === 'goods' ? `${goods} · 买${face.buySilver}两／卖${face.sellSilver}两` : `${face.name} · ${face.costText}`;
    const origin=origins[cards.length-1-page.start-offset];
    const source=origin?.known&&reasons[origin.reason]?`${origin.actorSeatId?`${name(origin.actorSeatId)} · `:''}${reasons[origin.reason]}${origin.sourceCardId&&origin.sourceCardId!==face.id?` · ${getCard(origin.sourceCardId).name}`:''}`:originsLoaded?'来源未完整记录':'来源尚未载入';
    return `<button type="button" class="hy-discard-card" data-definition-id="${esc(face.id)}" data-hy-detail="${esc(cardKey(card))}" data-hy-read-card="${esc(face.id)}" aria-label="阅读${esc(caption)}原牌文">${renderCard(card,{interactive:false})}<span class="hy-discard-caption">${esc(caption)}</span><span class="hy-discard-origin">${esc(source)}</span></button>`;
  }).join('')}</div>${renderDialogPager(page,'discard-page')}`;
}

/** Explain the current projected step; the engine remains the owner of costs and outcomes. */
export function decisionContext(pending, game, selfId, playerName = id => id) {
  const owner = playerName(pending.ownerId), actor = playerName(pending.actorId);
  const targetId = pending.borrowedTargetId ?? pending.targetId;
  const target = targetId ? playerName(targetId) : '所选对手';
  const own = pending.actorId === selfId, selfSource = pending.ownerId === selfId;
  const source = pending.kind==='peek' ? null : /^[CMT]\d{2}$/u.test(pending.code??'')
    ? getCard(`yousei.${pending.code.toLowerCase()}`)
    : pending.sourceCards?.[0] ? getCard(pending.sourceCards[0].definitionId) : null;
  const kind = pending.choice?.kind;
  const context = { source, owner, actor, own,
    reason: selfSource ? `你使用了${source?.name??'当前牌'}，现在继续结算自己的效果。` : `${owner}使用了${source?.name??'当前牌'}，现在轮到${own?'你':actor}处理这一步。`,
    task:'选择下面一项合法选项。', outcome:'确认后提交这项选择，并继续结算当前牌的效果。',
    cost:'发动费用已经记入当前步骤；本次选择不另耗行动。' };
  const tasks = {
    'benefit-branch':['选择自己抽最多2张，或取得最多2件同种货物。',`你取得所选收益，${target}取得另一项收益；拿货的人各自选择货种。`],
    'benefit-good':['选择一种公库仍有的货物，最多取得2件同种货物。','所选货物交给你；放不下时接着选择保留，余货退回公库。'],
    'artisan-good':['选择一种公库有至少2件的货物。','你取得所选货种2件；接着如需调整容量，再选择最终保留的库存。'],
    'recover-tool':['从全部公开弃牌中的道具里选择1张。','所选道具加入你的手牌；不会自动安装，之后安装不耗行动。'],
    'exchange':['选择自己要交回的货种，以及从公库换取的另一货种。','自己这一货种的全部库存退公库，换取所选新货种的相同件数。'],
    'return-card':['从自己现在的手牌中选1张交给所选对手。',`所选牌交给${target}，允许交回刚盲抽到的牌；其他手牌保持私有。`],
    'hand-branch':['选择自己补牌至5张，或让所选对手弃牌至3张。',`补牌只归你；弃牌分支由${target}自己选择要弃掉的牌。`],
    'discard-hand':['从自己手牌中选出要弃掉的牌，直到剩3张。','选中的牌立即进入弃牌区；未勾选的牌留在你的手中。'],
    'take-card':['从这些候选中选择1张加入自己的手牌。',pending.code==='C02'?'所选牌加入你的手牌；其余按原相对顺序背面向上放回堆顶。':'所选道具加入你的手牌；以后安装不耗行动。'],
    'tool-two-cards':['从刚私看的2张牌中选择自己留下的1张。',`所选牌加入你的手牌，另一张交给${target}；这批私牌不会向观众公开。`],
    'tool-discard-draw':['点选自己要弃掉的1或2张手牌。','先弃掉选中的牌，再抽同样张数；牌堆空时可能抽回刚弃的牌。'],
    'auction-goods':['从公库选择2件货物，组成一个完整拍品。','两件货物一起拍卖；全部参赛者依顺位竞价，不能只买其中一件。'],
    'sell-goods':['选择要出售的3件库存货物。','这些货物退回公库，你取得该人物效果规定的银两。'],
    'sell-stock':['点库存的加减按钮，选择出售数量。','所选货物退回公库，银两按该人物的货物单价结算。'],
    'trade-card':['从手中的货物牌选择一组。','这组牌所列货物按买办牌文结算；后续取牌回应属于同一步骤。'],
    'draft-card':['从双方已公开的手牌池中选择1张。',`这张牌加入你的手牌，接着由配对玩家轮流选1张，直到分完；其他席位不参与。`],
    'draft-good':['从双方合并的公开库存中选择1件货物。','这件货物进入你的商铺；配对双方轮流分配。临时格费用以当前合法选项为准。'],
    'draft-tool':['从双方合并的公开道具池中选择1件。','这件道具竖直放入你的道具区，不进入手牌、不另收安装行动；随后轮到配对玩家。'],
    'keep-tool':['选择自己唯一要保留的已装道具。','保留的道具维持原竖直或横置状态；其余已装道具全部弃置。'],
    'tribute-branch':['选择支付2两给发动者，或让发动者抽最多2张牌。',`付钱会从你的银两转给${owner}；抽牌分支由${owner}取得新牌。`],
    'borrow-tool':['决定是否立即借用刚拆除道具的一次效果。','借用不安装、不另耗行动，但仍须支付该道具的效果费用；不借用则完成人物效果。'],
    'borrowed-target':['为这次借用的道具另选一名对手。','确认后以这名对手结算借用效果；术士原先拆道具的目标不会被改写。'],
    'tool-search-payment':['选择支付1两，或弃掉一张自己的手牌。','支付成功后取得搜寻出的货物牌；不支付则不能取得。'],
    'tool-exchange':['选择交出自己的1件库存，以及换取对手的1件库存。',`你与${target}完整交换各1件，不能只给或只拿；持续占用临时格不重复收费。`],
    'tool-payment-good':['选择公库货物，并选择自己要作为费用弃掉的牌。','支付牌立即弃置，取得所选货物；随后如需处理容量，继续选择保留。'],
    'tool-goods-draw':['选择自己要交回公库的1件库存货物。','这件库存退回公库，你抽1张牌；手中的货物牌不能代替库存。'],
    'tool-discard-swap':['选择自己要交出去的1张手牌。','所选手牌成为新的弃牌堆顶，原弃牌堆顶加入你的手牌；之后仍须完成首次普通摸牌。'],
    'tool-payment-silver':['选择自己要作为费用弃掉的1张手牌或已装道具。','所选牌弃置，你获得2两；弃掉当前道具本身时，它会离开道具区。'],
    'tool-buy-good':['选择公库中的任意1件货物。','确认支付2两并取得这1件货物；新占临时格时同时另付2两。'],
    'retain-goods':['点库存的加减按钮，确定最后留下多少。','确认数量留在你的商铺；原库存和本次所得中未保留的货物全部退回公库。'],
  };
  if (tasks[kind]) [context.task,context.outcome] = tasks[kind];
  if (kind==='benefit-good') context.reason = selfSource
    ? `你使用把戏人并选择了货物收益，现在挑选自己取得的货种。`
    : `${owner}使用把戏人并选择了抽牌收益，因此${own?'你':actor}取得货物收益。`;
  if (kind==='retain-goods') {
    const model=choiceModel(pending);
    context.reason=`${own?'你':actor}正在接收货物，须确定自己商铺最后留下的库存。`;
    context.cost=model?`本次选择不另耗行动。普通容量${model.ordinaryCapacity}格；${model.temporaryFee?`新占临时格须付${model.temporaryFee}两`:'当前保留不另收临时格费用'}。`:'本次选择不另耗行动；保留数量和临时格费用由选择者当前商铺结算。';
  }
  if (pending.code==='C10'&&kind!=='retain-goods') context.cost='匠人的1行动与2两已经支付；本次选货不重复收费。新占临时格费用另计。';
  if (kind==='tool-search-payment') context.cost='本次确认将支付所选的1两或弃牌费用，不另耗行动。';
  if (kind==='tool-payment-good') context.cost='本次确认将弃掉所选支付牌，不另耗行动；临时格费用另计。';
  if (kind==='tool-goods-draw') context.cost='激活行动已经消耗；本次确认交回1件所选库存，不另耗行动。';
  if (kind==='tool-payment-silver') context.cost='激活行动已经消耗；本次确认弃掉所选支付牌，获得2两。';
  if (kind==='tool-buy-good') {
    const buyer=game.players.find(player=>player.id===pending.actorId);
    const count=GOODS.reduce((sum,good)=>sum+(buyer?.goods?.[good.id]??0),0);
    context.cost=`本次确认付2两${buyer&&count>=buyer.ordinaryCapacity&&!buyer.temporaryOccupied?'＋临时格2两，共4两':''}；激活行动已消耗，不重复计步。`;
  }
  if (pending.kind==='peek') Object.assign(context,{
    reason:own?'你刚花1行动看到了这张牌，只有你能看见它。':`${owner}花1行动正在私看新牌；只有本人能看见牌面。`, task:own?'选择留下这张牌，或弃掉后继续看牌。':`等待${actor}完成留下或弃掉；其他人不能操作。`,
    outcome:'留下：牌加入手牌并进入用牌阶段。弃掉：牌进入公开弃牌区，仍可继续摸牌。',cost:'这次摸看已消耗1行动；留下或弃掉不重复收费。',source:null,
  });
  if (pending.response) Object.assign(context,{
    reason:pending.response.kind==='counter'?`${owner}对${own?'你':actor}使用了监视人物${source.name}，效果尚未执行。`:`${owner}完成货物牌交易，现在轮到${own?'你':actor}决定是否用番商取得这张牌。`,
    task:pending.response.kind==='counter'?'可以使用自己的一张锦衣卫取消该人物效果，或不回应。':'可以使用自己的一张番商取得交易牌，或不回应并让顺位继续。',
    outcome:pending.response.kind==='counter'?'使用锦衣卫：两张人物牌弃置，本次人物效果取消。不回应：原人物效果继续。':'使用番商：番商弃置，你取得交易牌。不回应：继续处理其余合法回应者或结束交易。',
    cost:'回应不耗行动、不付银两；确认使用会消耗所选回应牌。',
  });
  if (pending.auction&&pending.stage==='bidding') Object.assign(context,{
    reason:`${owner}使用${source.name}发起全桌拍卖，现在轮到${own?'你':actor}报价。`,task:'填写超过当前最高价的整数报价，或放弃这次拍卖。',
    outcome:'报价确认后成为当前最高价，继续顺位竞价；只剩最高报价者时支付报价并取得整组拍品。放弃后本次拍卖不能重新加入。',
    cost:`报价时不扣款；成交时一次支付最终报价。${own?'你':actor}当前有${game.players.find(player=>player.id===pending.actorId)?.silver??0}两。`,
  });
  return context;
}

export function renderDecisionContext(context, pending) {
  const sourceCards=pending.sourceCards?.length?pending.sourceCards:pending.kind==='peek'?pending.privatePool??[]:context.source?[{id:context.source.id,definitionId:context.source.id}]:[];
  return `<section class="hy-decision-context" aria-label="当前步骤的来源与后果">${sourceCards.length?`<div class="hy-decision-source">${sourceCards.map(card=>renderCompactCard(card,{readButton:false})).join('')}<div><strong>${esc(context.owner)}${pending.kind==='peek'?'刚摸看': '使用'}${esc(context.source?.name??getCard(sourceCards[0].definitionId).name)}</strong><p>${esc(context.source?.summary??'')}</p></div></div>`:''}<p class="hy-step-reason">${esc(context.reason)}</p><p><strong>现在要做：</strong>${esc(context.task)}</p><p><strong>确认后：</strong>${esc(context.outcome)}</p><p class="hy-step-cost"><strong>当前费用：</strong>${esc(context.cost)}</p><small>关闭只收起窗口，已发动的牌与费用保留；点桌面「处理当前选择」返回。确认后不能撤回。</small></section>`;
}

/** Header, scrollable reading area and actions have separate height ownership. */
export function renderDialogBody(content, actions = '', { formId = null } = {}) {
  const inner = `<div class="hy-dialog-content">${content}</div>${actions?`<div class="hy-dialog-footer">${actions}</div>`:''}`;
  return formId ? `<form id="${formId}" class="hy-dialog-layout">${inner}</form>` : `<div class="hy-dialog-layout">${inner}</div>`;
}
