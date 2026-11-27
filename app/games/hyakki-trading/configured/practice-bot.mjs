import {quoteGoodsTrade,recipeMaterials,findMaterials,newTradeUsage} from '../trade-contract.mjs';
import {CATEGORIES} from '../content/expansion-one.mjs';
import {getPublicOrder} from '../content/expansion-two.mjs';
import {matchingOrderCount,quoteOrderDelivery} from './expansion-two-economy.mjs';
import {WORKSHOP_OWNER} from './refining.mjs';
/** Ordinary practice decisions use only the deciding seat's private projection. */
import { GOODS, getCard, getRole, DIGITAL_RULE_VERSION, MULTIPLAYER_RULE_VERSION } from './material.mjs';
import { qualifiesForIdleReward } from './model.mjs';
import {exchangeOfferKey} from './exchange-market.mjs';

const count = vector => Object.values(vector).reduce((sum, value) => sum + value, 0);
const covers = (stock, recipe) => Object.entries(recipe).every(([id, amount]) => stock[id] >= amount);
const canAdd = (owner, amount, cost = 0) => {
  const total = count(owner.goods) + amount;
  return total <= owner.ordinaryCapacity + 1
    && owner.silver >= cost + (total > owner.ordinaryCapacity && !owner.temporaryOccupied ? 2 : 0);
};
function legalView(view, playerId, now, allowPaused) {
  return view?.gameType === 'hyakki-trading' && view.viewerId === playerId && view.status === 'playing'
    && !Object.hasOwn(view, 'deck') && !Object.hasOwn(view, 'lifecycle') && !view.pending?.data
    && Array.isArray(view.players) && view.players.length >= 2 && view.players.length <= 6
    && (view.ruleVersion === MULTIPLAYER_RULE_VERSION || view.ruleVersion === DIGITAL_RULE_VERSION && view.players.length === 2)
    && view.players.every(owner => owner.id === playerId ? Array.isArray(owner.hand) && owner.hand.every(card => typeof card?.cardId === 'string'
      && typeof card.definitionId === 'string') : !Object.hasOwn(owner, 'hand'))
    && !view.holds?.manual && !view.holds?.absence && !view.holds?.capacity
    && (!view.clock?.paused || allowPaused === true) && (now === undefined || Number.isSafeInteger(now) && now >= 0
      && (view.clock?.deadlineAt === null || view.clock?.deadlineAt > now));
}
const jitter = text => {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
};
function faceValue(definition) {
  if (definition.category === 'goods') return 20 + definition.sellSilver;
  if (definition.category === 'tool') return 22;
  if (definition.category === 'stall_permit') return 9;
  if (['C04', 'C07'].includes(definition.sourceCode)) return 12;
  return ['C01', 'C05', 'C08', 'C13', 'M01', 'M04'].includes(definition.sourceCode) ? 28 : 18;
}
function stockValue(stock,refined={}){
  return GOODS.reduce((value,{id})=>value+0.65*stock[id]+Number(stock[id]>=1)*1.1+Number(stock[id]>=2)*0.55
    +0.65*(refined[id]??0),0);
}
function stockOpportunity(view,owner,stock){
  const sale=owner.hand.some(card=>{
    const face=getCard(card.definitionId);
    return face.category==='goods'&&recipeMaterials(face,stock);
  });
  const slots=view.orderUsage?.delivered?[]:view.publicOrders?.orders??[];
  const order=slots.some(slot=>matchingOrderCount(getPublicOrder(slot.id),stock)===getPublicOrder(slot.id).count);
  return Number(sale)*1.75+Number(order)*1.25;
}
function handValue(owner,definitionId,excludedId){
  const face=getCard(definitionId);
  const extra=owner.hand.some(card=>card.cardId!==excludedId&&card.definitionId===definitionId);
  return extra?0.8:faceValue(face)/15;
}
function offerPost(view,owner,peers,cards){
  const usage=view.exchangeMarket?.usage;
  if(!usage||view.stage!=='use'||view.closing||usage.published||usage.traded)return null;
  const buyers=peers.filter(peer=>peer.silver>=4&&peer.handCount>0);
  if(!buyers.length)return null;
  const provideUnit=GOODS.find(({id})=>owner.goods[id]-(owner.refined?.[id]??0)>0&&owner.goods[id]>=3
    &&buyers.some(peer=>count(peer.goods)<peer.ordinaryCapacity&&peer.goods[id]<2)
    &&stockOpportunity(view,owner,{...owner.goods,[id]:owner.goods[id]-1})>=stockOpportunity(view,owner,owner.goods));
  if(provideUnit)return {type:'offer-post',provide:{ordinary:{[provideUnit.id]:1}},receive:{silver:1}};
  const duplicate=cards.find(card=>cards.some(other=>other.cardId!==card.cardId&&other.definitionId===card.definitionId));
  if(duplicate&&cards.length>=5&&buyers.some(peer=>peer.handCount<owner.hand.length))
    return {type:'offer-post',provide:{cardIds:[duplicate.cardId]},receive:{silver:1}};
  return null;
}

/** Review only the deciding seat's projection, including legal payment cards
 * and the real temporary-slot fee. No opponent or deck material is inspected. */
export function choosePracticeOfferResponse(view,playerId,keys,{now,allowPaused=false}={}){
  if(!legalView(view,playerId,now,allowPaused)||view.pending||!view.exchangeMarket||view.closing)return null;
  const owner=view.players.find(player=>player.id===playerId);
  let best=null,bestScore=0.15;
  for(const offer of view.exchangeMarket.offers){
    if(!keys.includes(exchangeOfferKey(offer))||!offer.ready||offer.mine)continue;
    const {provide:receive,receive:give}=offer;
    const deltaSilver=receive.silver-give.silver-(offer.temporaryFee??0);
    if(deltaSilver<0&&owner.silver+deltaSilver<3)continue;
    const updated=quality=>Object.fromEntries(GOODS.map(({id})=>[id,(quality==='refined'?owner.refined?.[id]??0:owner.goods[id])
      +(receive.refined[id]??0)-(give.refined[id]??0)+(quality==='refined'?0:(receive.ordinary[id]??0)-(give.ordinary[id]??0))]));
    const goods=updated('goods'),refined=updated('refined');
    const material=stockValue(goods,refined)-stockValue(owner.goods,owner.refined)
      +stockOpportunity(view,owner,goods)-stockOpportunity(view,owner,owner.goods);
    const gained=receive.cards.reduce((sum,id)=>sum+handValue(owner,id),0);
    const cards=give.card?owner.hand.filter(card=>offer.eligibleCards.includes(card.cardId)):[null];
    for(const card of cards){
      const score=deltaSilver+material+gained-(card?handValue(owner,card.definitionId,card.cardId):0);
      if(score<=bestScore)continue;
      bestScore=score;
      best={type:'offer-accept',offerId:offer.id,generation:offer.generation,...(card?{cardId:card.cardId}:{}),
        matchId:view.matchId,turnId:view.turnId,expectedRevision:view.revision};
    }
  }
  return best;
}
function ordinaryActions(view) {
  const owner = view.players.find(item => item.id === view.viewerId), peers = view.players.filter(item => item.id !== view.viewerId);
  const targetParams = (peer, extra = {}) => ({ ...(view.ruleVersion === MULTIPLAYER_RULE_VERSION ? { targetId: peer.id } : {}), ...extra });
  const available = view.deckCount + view.discard.length, ownGoods = count(owner.goods), bankGoods = count(view.bankGoods);
  const cards = owner.hand.map(card => ({ ...card, face: getCard(card.definitionId) })), actions = [];
  if (view.remainingActions <= 0) return [{ type: 'end-turn' }];
  for (const card of cards) {
    const face = card.face, cardId = card.cardId;
    if (face.category === 'goods') {
      for(const direction of ['sell','buy']){
        const materials=recipeMaterials(face,direction==='sell'?owner.goods:view.bankGoods);
        if(!materials)continue;
        const refinedMaterials=direction==='sell'&&owner.refined?refinedPart(owner,materials):undefined;
        try{quoteGoodsTrade({owner,bankGoods:view.bankGoods,usage:tradeUsage(view),bookLayers:view.bookLayers,definitionId:face.id,direction,materials,refinedMaterials});
          actions.push({type:direction,cardId,...(face.recipe.type==='fixed'?{}:{materials}),...(refinedMaterials?{refinedMaterials}:{})});}catch(error){if(!(error instanceof RangeError))throw error;}
      }
    } else if (face.category === 'stall_permit') {
      if (view.availableStalls > 0 && owner.silver >= (view.purchasedStalls ? 3 : 6)) actions.push({ type: 'buy-stall', cardId });
    } else if (face.category === 'tool') {
      if (owner.tools.length < 3) actions.push({ type: 'install-tool', cardId });
      else for (const tool of owner.tools) actions.push({ type: 'install-tool', cardId, replaceCardId: tool.cardId });
    } else {
      let allowed = false;
      switch (face.sourceCode) {
        case 'C02': allowed = available > 0; break;
        case 'C03': allowed = true; break;
        case 'C05': allowed = ownGoods >= 3 && cards.some(other => other.face.category === 'goods'
          && other.face.recipe.count === 3 && Number.isSafeInteger(owner.silver + other.face.sellSilver + view.bookLayers * 2)); break;
        case 'C06': allowed = GOODS.some(from => owner.goods[from.id] > 0 && GOODS.some(to => to.id !== from.id
          && view.bankGoods[to.id] >= owner.goods[from.id])); break;
        case 'C09': allowed = bankGoods >= 2 && view.players.some(item => item.silver >= 1); break;
        case 'C10': allowed = owner.silver >= 2 && GOODS.some(good => view.bankGoods[good.id] >= 2); break;
        case 'C11': allowed = view.discard.some(item => getCard(item.definitionId).category === 'tool'); break;
        case 'C12': allowed = available >= 3 && view.players.some(item => item.silver >= 1); break;
        case 'C13': allowed = ownGoods >= 1 && Number.isSafeInteger(owner.silver + 2); break;
      }
      if (allowed) actions.push({ type: 'play-character', cardId, params: {} });
      for (const peer of peers) {
        let targeted = false;
        switch (face.sourceCode) {
          case 'C01': targeted = available > 0 || bankGoods > 0; break;
          case 'C08': targeted = owner.hand.length - 1 < 5 && available > 0 || peer.handCount > 3; break;
          case 'M01':
            for (const good of GOODS) if (peer.goods[good.id] > 0) actions.push({ type: 'play-character', cardId,
              params: targetParams(peer, { goodsId: good.id }) });
            break;
          case 'M02': targeted = owner.hand.length - 1 + peer.handCount > 0; break;
          case 'M03': targeted = owner.tools.length > 1 || peer.tools.length > 1; break;
          case 'M04': targeted = peer.silver >= 2 && Number.isSafeInteger(owner.silver + 2) || available > 0; break;
          case 'M05': targeted = ownGoods + count(peer.goods) > 0; break;
          case 'M06': targeted = owner.tools.length + peer.tools.length > 0; break;
          case 'M07': targeted = peer.handCount > 0; break;
          case 'M08':
            for (const tool of peer.tools) actions.push({ type: 'play-character', cardId,
              params: targetParams(peer, { toolCardId: tool.ref }) });
            break;
        }
        if (targeted) actions.push({ type: 'play-character', cardId, params: targetParams(peer) });
      }
    }
  }
  for (const tool of owner.tools) {
    if (tool.exhausted) continue;
    const code = getCard(tool.definitionId).sourceCode;
    let allowed = false;
    switch (code) {
      case 'T01': allowed = available > 0 && (owner.silver >= 1 || owner.hand.length > 0); break;
      case 'T03': allowed = owner.hand.length > 0; break;
      case 'T05': allowed = available > 0 && owner.silver >= 1; break;
      case 'T06': allowed = ownGoods > 0 && available > 0; break;
      case 'T08': allowed = Number.isSafeInteger(owner.silver + 2); break;
      case 'T09': allowed = bankGoods > 0 && canAdd(owner, 1, 2); break;
      case 'T10': allowed = bankGoods > 0 && canAdd(owner, 1); break;
    }
    if (allowed) actions.push({ type: 'activate-tool', cardId: tool.cardId, params: {} });
    for (const peer of peers) if (code === 'T02' && ownGoods > 0 && count(peer.goods) > 0 || code === 'T04' && available >= 2)
      actions.push({ type: 'activate-tool', cardId: tool.cardId, params: targetParams(peer) });
  }
  addExpansionActions(view,owner,peers,cards,actions);
  if(view.publicOrders)addOrderActions(view,owner,cards,actions);
  if(owner.refined&&!view.refiningUsed)addRefiningActions(owner,cards,actions);
  const offer=offerPost(view,owner,peers,cards);
  if(offer)actions.push(offer);
  const filtered=actions.filter(a=>!view.turnUsage.monitorUsed||!a.cardId||getCard(a.cardId.split('#')[0]).category!=='monitored_character');
  filtered.push({ type: 'end-turn' }); return filtered;
}
function pendingActions(view) {
  const pending = view.pending, decision = pending.decision;
  if (pending.actorId !== view.viewerId || !decision?.defaultSelection) return [];
  if (pending.choice) return (pending.choice.kind==='compass-order'?decision.options:[decision.defaultSelection])
    .map(selection=>({type:'choose-effect',selection:structuredClone(selection)}));
  if (pending.kind === 'auction') {
    const bid = decision.options.find(option => option.type === 'bid');
    return [...(bid ? [{ type: 'bid', amount: bid.minimum }] : []), { type: 'pass-bid' }];
  }
  return decision.options.map(option => structuredClone(option));
}

/** Enumerates only publicly provable ordinary moves and projected legal choices.
 * No engine trial, hidden deck, opposing hand, or material reconstruction occurs. */
export function legalHyakkiPracticeActions(view, playerId = view?.viewerId, { now, allowPaused = false } = {}) {
  if (!legalView(view, playerId, now, allowPaused)) return [];
  let actions;
  if (view.pending) actions = pendingActions(view);
  else if (view.turnPlayerId !== playerId) return [];
  else if (view.stage === 'use') actions = ordinaryActions(view);
  else {
    const owner = view.players.find(item => item.id === playerId);
    const firstPeekRequired = !view.drawStarted && view.deckCount + view.discard.length > 0;
    actions = firstPeekRequired ? [] : [{ type: 'finish-draw' }, { type: 'end-turn' }];
    if (view.remainingActions > 0) {
      if (view.deckCount + view.discard.length > 0) actions.unshift({ type: 'peek' });
      if (!view.drawStarted && owner.hand.length && view.discard.length && view.remainingActions >= 2) for (const tool of owner.tools) {
        if (!tool.exhausted && getCard(tool.definitionId).sourceCode === 'T07') actions.unshift({ type: 'activate-tool', cardId: tool.cardId, params: {} });
      }
    }
  }
  const fence = { matchId: view.matchId, turnId: view.turnId, expectedRevision: view.revision,
    ...(view.pending ? { effectId: view.pending.id, decisionId: view.pending.decisionId } : {}) };
  return actions.map(action => ({ ...action, ...fence }));
}

function choosePending(view, actions) {
  const pending = view.pending, owner = view.players.find(item => item.id === view.viewerId);
  if(pending.choice?.kind==='compass-order'){
    return actions.reduce((best,action)=>orderFit(owner.goods,action.selection.orderId)>orderFit(owner.goods,best.selection.orderId)?action:best,actions[0]);
  }
  if (pending.choice) return actions[0]; // The complete engine-supplied default also covers every future mandatory selector.
  if (pending.response) return actions.find(action => action.type === 'respond') ?? actions[0];
  if (pending.kind === 'peek') return actions.find(action => action.type === 'keep-peek') ?? actions[0];
  if (pending.kind === 'auction') {
    const ceiling = pending.auction.kind === 'goods' ? 3 : 4;
    return actions.find(action => action.type === 'bid' && action.amount <= ceiling && owner.silver - action.amount >= 4)
      ?? actions.find(action => action.type === 'pass-bid');
  }
  return actions[0];
}
function ordinaryScore(view, action) {
  const owner = view.players.find(item => item.id === view.viewerId), peer = view.players.find(item => item.id === action.params?.targetId)
    ?? view.players.find(item => item.id !== view.viewerId);
  const card = [...owner.hand, ...owner.tools].find(item => item.cardId === action.cardId), face = card && getCard(card.definitionId);
  if(action.type==='offer-post')return 98;
  if (action.type === 'end-turn') return owner.silver >= view.configuration.closingTarget ? 1000 : qualifiesForIdleReward(view)
    && jitter(`${view.matchId}:${view.turnId}`) % 24 === 0 ? 95 : 0;
  if (action.type === 'sell') return 115 + face.sellSilver + Math.min(4,2*count(action.refinedMaterials??{}));
  if(action.type==='refine-stock'||action.type==='play-character'&&face?.sourceCode==='E2C02'
    ||action.type==='activate-tool'&&face?.sourceCode==='E2T02'){
    const nearSale=owner.hand.some(card=>{
      const candidate=getCard(card.definitionId);
      return candidate.category==='goods'&&recipeMaterials(candidate,owner.goods);
    });
    return (nearSale&&view.remainingActions>1?143:48)+(face?.sourceCode==='E2T02'?4:0);
  }
  if (action.type === 'buy'){
    if(!view.publicOrders||view.orderUsage.delivered)return 60;
    const material=action.materials??face.recipe.goods;
    const after=Object.fromEntries(GOODS.map(({id})=>[id,owner.goods[id]+(material?.[id]??0)]));
    const progress=stock=>Math.max(...view.publicOrders.orders.map(order=>orderFit(stock,order.id)));
    return 60+Math.max(0,progress(after)-progress(owner.goods))*12;
  }
  if (action.type === 'use-role') return getRole(owner.roleId,view.configuration).sourceCode==='R20'?90:55;
  if (action.type==='order-deliver'||face?.sourceCode==='E2C01'){
    const slot=view.publicOrders.orders[(action.params??action).position],order=getPublicOrder(slot.id);
    return (action.type==='order-deliver'?118:112)+order.silver;
  }
  if(action.type==='order-replace')return owner.roleId==='yousei.role.e2r02'?54:38;
  if (action.type === 'buy-stall') return count(owner.goods) >= owner.ordinaryCapacity - 1 && owner.silver >= 12 ? 65 : 12;
  if (action.type === 'install-tool') {
    if (!action.replaceCardId) return 35;
    const old = owner.tools.find(tool => tool.cardId === action.replaceCardId);
    return faceValue(face) > faceValue(getCard(old.definitionId)) ? 20 : -20;
  }
  if (action.type === 'activate-tool') {
    if (['T01', 'T05'].includes(face.sourceCode) && owner.hand.length >= 7) return -10;
    return face.sourceCode === 'T08' ? 65 : 40;
  }
  if (action.type === 'play-character') {
    switch (face.sourceCode) {
      case 'C05': return 105;
      case 'C13': return 90;
      case 'C03': return view.remainingActions >= 2 && owner.hand.some(item => getCard(item.definitionId).category === 'goods'
        && recipeMaterials(getCard(item.definitionId),owner.goods)) ? 145 : 4;
      case 'C01': case 'C02': case 'C08': return 65;
      case 'M01': return 65;
      case 'M02': return peer.handCount > owner.hand.length ? 60 : 18;
      case 'M03': return peer.tools.length > owner.tools.length ? 60 : 4;
      case 'M04': return 60;
      case 'M05': return count(peer.goods) > count(owner.goods) ? 55 : 12;
      case 'M06': return peer.tools.length > owner.tools.length ? 55 : 15;
      case 'M07': return 20;
      case 'M08': return 55;
      default: return 45;
    }
  }
  return 0;
}

export function chooseHyakkiPracticeAction(view, playerId = view?.viewerId, options = {}) {
  const actions = legalHyakkiPracticeActions(view, playerId, options);
  if (!actions.length) return null;
  if (view.pending) return choosePending(view, actions);
  if (view.stage === 'draw') {
    const owner = view.players.find(item => item.id === playerId), paper = actions.find(action => action.type === 'activate-tool');
    if (paper) {
      const low = [...owner.hand].sort((a, b) => faceValue(getCard(a.definitionId)) - faceValue(getCard(b.definitionId)) || a.cardId.localeCompare(b.cardId))[0];
      if (faceValue(getCard(view.discard.at(-1).definitionId)) > faceValue(getCard(low.definitionId)))
        return { ...paper, params: { cardId: low.cardId } };
    }
    if (!view.drawStarted && view.deckCount + view.discard.length > 0) return actions.find(action => action.type === 'peek');
    if (owner.silver >= view.configuration.closingTarget) return actions.find(action => action.type === 'end-turn');
    const useful = ordinaryActions(view).some(action => ['buy', 'sell', 'play-character', 'activate-tool','order-deliver'].includes(action.type));
    const wantsCard = owner.hand.length < 4 || !useful || jitter(`${view.matchId}:${view.turnId}:draw`) % (view.actionLimit === 1 ? 3 : 4) === 0;
    return wantsCard && actions.find(action => action.type === 'peek') || actions.find(action => action.type === 'finish-draw');
  }
  return actions.map((action, index) => ({ action, index, score: ordinaryScore(view, action)
    + (action.type === 'end-turn' ? 0 : jitter(`${view.matchId}:${view.revision}:${JSON.stringify(action)}`) % 13) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].action;
}

export const chooseHyakkiBotAction = chooseHyakkiPracticeAction;

function tradeUsage(view){return Object.fromEntries(Object.keys(newTradeUsage()).map(key=>[key,view.turnUsage[key]]));}
export {recipeMaterials};
const orderFit=(stock,id)=>matchingOrderCount(getPublicOrder(id),stock);
const refinedPart=(owner,materials)=>Object.fromEntries(Object.entries(materials)
  .filter(([id])=>owner.refined[id]>0).map(([id,n])=>[id,Math.min(n,owner.refined[id])]));
function addRefiningActions(owner,cards,actions){
  const ordinaryFor=limit=>{
    const result={};let remaining=limit;
    for(const {id} of GOODS){
      const amount=Math.min(remaining,owner.goods[id]-owner.refined[id]);
      if(amount>0){result[id]=amount;remaining-=amount;}
      if(!remaining)break;
    }
    return result;
  };
  const ordinary=ordinaryFor(owner.roleId===WORKSHOP_OWNER?2:1);
  if(!Object.keys(ordinary).length)return;
  actions.push({type:'refine-stock',ordinary});
  const artisan=cards.find(card=>card.face.sourceCode==='E2C02');
  if(artisan)actions.push({type:'play-character',cardId:artisan.cardId,params:{ordinary:ordinaryFor(2)}});
  const hammer=owner.tools.find(tool=>tool.definitionId==='yousei.e2t02'&&!tool.exhausted);
  if(hammer)actions.push({type:'activate-tool',cardId:hammer.cardId,params:{ordinary}});
}
function addOrderActions(view,owner,cards,actions){
  const slots=view.publicOrders.orders,broker=cards.find(card=>card.face.sourceCode==='E2C01');
  let found=false;
  if(!view.orderUsage.delivered)for(const {id,position,generation} of slots){
    const order=getPublicOrder(id);
    if(count(owner.goods)<order.count)continue;
    const select=useBroker=>findMaterials(owner.goods,order.count,goods=>{
      const refined=owner.refined?refinedPart(owner,goods):{};
      const selection={ordinary:Object.fromEntries(Object.entries(goods).map(([id,n])=>[id,n-(refined[id]??0)])),...(owner.refined?{refined}:{})};
      quoteOrderDelivery({owner,orderId:id,selection,broker:useBroker,saleBonusUsed:view.turnUsage?.saleBonus});
      return selection;
    });
    const ordinary=select(false);
    if(ordinary){actions.push({type:'order-deliver',position,generation,selection:ordinary});found=true;}
    else if(broker){
      const selection=select(true);
      if(selection){actions.push({type:'play-character',cardId:broker.cardId,params:{position,generation,selection}});found=true;}
    }
  }
  if(found||view.orderUsage.delivered||view.orderUsage.replaced||count(owner.goods)<2)return;
  const {position,generation}=slots.reduce((least,slot)=>orderFit(owner.goods,slot.id)<orderFit(owner.goods,least.id)?slot:least);
  actions.push({type:'order-replace',position,generation});
  const compass=owner.tools.find(tool=>tool.definitionId==='yousei.e2t01'&&!tool.exhausted);
  if(compass)actions.push({type:'activate-tool',cardId:compass.cardId,params:{position,generation}});
}
function addExpansionActions(view,owner,peers,cards,actions){
  const cls=(stock,cat)=>GOODS.filter(g=>g.category===cat).reduce((sum,g)=>sum+(stock[g.id]??0),0);
  const own=count(owner.goods),bank=count(view.bankGoods),available=view.deckCount+view.discard.length;
  const hasDiscard=category=>view.discard.some(c=>getCard(c.definitionId).category===category);
  for(const {face,cardId} of cards){let allowed=false,params={};const code=face.sourceCode,n=Number(code.slice(2));
    if(/^XC0[1-6]$/u.test(code))allowed=owner.silver>=2&&cls(view.bankGoods,CATEGORIES[n-1].id)>=2;
    if(code==='XC07'){const c=CATEGORIES.find(c=>cls(view.bankGoods,c.id)>=2);allowed=owner.silver>=1&&!!c;params={categoryId:c?.id};}
    if(code==='XC08')allowed=owner.silver>=1&&CATEGORIES.some(c=>cls(owner.goods,c.id)>=2&&GOODS.some(g=>g.category!==c.id&&view.bankGoods[g.id]>0));
    if(code==='XC09')allowed=available>0;
    if(code==='XC10')allowed=view.discard.some(c=>getCard(c.definitionId).sourceCode==='C07');
    if(code==='XC11')allowed=own>0;
    if(allowed)actions.push({type:'play-character',cardId,params});
    if(/^XM0[1-6]$/u.test(code)&&!view.turnUsage.monitorUsed)for(const peer of peers){
      let ok=code==='XM01'?peer.silver>=1:code==='XM02'?peer.silver-owner.silver>=6:code==='XM03'?peer.silver>=2||count(peer.goods)>0:code==='XM04'?owner.silver>=2&&peer.silver>=1:false;
      const cat=CATEGORIES.find(c=>cls(peer.goods,c.id)>0);
      if(['XM05','XM06'].includes(code))ok=!!cat&&(code!=='XM05'||owner.silver>=1);
      if(ok)actions.push({type:'play-character',cardId,params:{targetId:peer.id,...(['XM05','XM06'].includes(code)?{categoryId:cat.id}:{})}});
    }
  }
  for(const tool of owner.tools){if(tool.exhausted)continue;const code=getCard(tool.definitionId).sourceCode;if(!/^XT/u.test(code))continue;
    const n=Number(code.slice(2)),fee=n<=6?0:owner.roleId==='yousei.role.r13'&&!view.turnUsage.toolFeeUsed?0:1;
    let allowed=owner.silver>=fee;
    if(n<=12)allowed&&=cls(view.bankGoods,CATEGORIES[(n-1)%6].id)>0&&canAdd(owner,1,fee);
    else if(code==='XT13')allowed&&=GOODS.some(from=>owner.goods[from.id]>0&&GOODS.some(to=>to.category!==from.category&&view.bankGoods[to.id]>0));
    else allowed&&=cards.some(c=>c.face.category==='goods')&&hasDiscard('goods');
    if(allowed)actions.push({type:'activate-tool',cardId:tool.cardId,params:{}});
  }
  if(view.turnUsage.roleUsed)return;
  const code=getRole(owner.roleId,view.configuration).sourceCode;let ok=false,params={};
  if(code==='R09')ok=GOODS.some(from=>owner.goods[from.id]>0&&GOODS.some(to=>to.id!==from.id&&to.category===from.category&&view.bankGoods[to.id]>0));
  if(code==='R14')ok=owner.silver>=1&&hasDiscard('tool');
  if(code==='R16')ok=bank>0&&canAdd(owner,1);
  if(code==='R17'){const cat=CATEGORIES.find(c=>cls(view.bankGoods,c.id)>0);ok=!!cat&&canAdd(owner,1,1);params={categoryId:cat?.id};}
  if(code==='R18')ok=bank>0&&canAdd(owner,1,2);
  if(code==='R20')ok=own>0;
  if(code==='R22')ok=owner.hand.length>0&&owner.tools.some(t=>t.exhausted)&&view.remainingActions>=1;
  if(['R23','R24'].includes(code)&&!view.turnUsage.monitorUsed)for(const peer of peers)if(peer.silver>=2&&(code==='R23'?peer.silver>=owner.silver:count(peer.goods)>=3))actions.push({type:'use-role',params:{targetId:peer.id}});
  if(ok)actions.push({type:'use-role',params});
}
