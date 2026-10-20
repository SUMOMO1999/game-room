import { GOODS } from './presentation-content.mjs';
import { cardDraftChoices } from './card-draft.mjs';
import { renderGoodsIcon } from './digital-card-ui.mjs';
import { goodsTotal } from './game-ui-model.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const goodName=id=>GOODS.find(good=>good.id===id)?.name??'货物';
const button=(action,body,fields={},disabled=false,className='')=>`<button type="button" class="${className}" data-hy-action="${action}" data-hy-fields="${esc(JSON.stringify(fields))}" ${disabled?'disabled':''}>${body}</button>`;

/** C01 choices stay local until one existing play-character command commits. */
export function benefitDraftState(game,selfId,detail){
  const parts=cardDraftChoices(game,selfId,detail),peers=game.players.filter(player=>player.id!==selfId);
  const branch=parts[0]?.choice.options[detail.choiceInputs?.[0]?.optionIndex]?.branch;
  const goodsId=parts[1]?.choice.options[detail.choiceInputs?.[1]?.optionIndex]?.goodsId;
  const peer=peers.find(player=>player.id===(peers.length===1?peers[0].id:detail.targetId));
  const stock=goodsTotal(game.bankGoods),drawCount=Math.min(2,game.deckCount+game.discard.length);
  const needsGoods=branch==='goods'&&stock>0;
  const next=!branch?'branch':needsGoods&&!goodsId?'goods':!peer?'target':'ready';
  const requested=detail.benefitStep;
  const step=requested==='branch'?'branch':requested==='goods'&&needsGoods?'goods':requested==='target'&&peers.length>1&&branch&&(!needsGoods||goodsId)?'target':next;
  return {parts,peers,peer,branch,goodsId,stock,drawCount,step,available:stock>0||drawCount>0};
}

export function benefitDraftSummary(game,selfId,detail,name){
  const state=benefitDraftState(game,selfId,detail),target=state.peer?name(state.peer.id):'所选对手';
  if(!state.available)return '牌堆与公库都已空，本次没有可获得的收益。';
  if(!state.branch)return '先选自己的收益，另一项归一位对手；确认前可以改选或取消。';
  const draw=state.drawCount?`抽最多${state.drawCount}张`:'无牌可抽';
  const goods=state.goodsId?`取得${goodName(state.goodsId)}${Math.min(2,game.bankGoods[state.goodsId])}件`:state.stock?'自选同种货物最多2件':'无货可取';
  return state.branch==='draw'?`你${draw}；${target}${state.stock?'自行选择同种货物最多2件':'无货可取'}。`:`你${goods}；${target}${draw}。`;
}

export function renderBenefitDraft({game,selfId,detail,name,canChoose}){
  const state=benefitDraftState(game,selfId,detail),disabled=!canChoose||!state.available;
  const back=(step,label)=>button('benefit-step',esc(label),{step},!canChoose,'hy-benefit-back');
  const summary=benefitDraftSummary(game,selfId,detail,name);
  let body='';
  if(state.step==='branch'){
    body=`<div class="hy-benefit-options hy-benefit-branches">${state.parts[0].choice.options.map((option,index)=>{
      const draw=option.branch==='draw';
      const own=draw?(state.drawCount?`你抽最多${state.drawCount}张牌`:'你无牌可抽'):(state.stock?'你自选同种货物最多2件':'你无货可取');
      const other=draw?(state.stock?'对手自行选择同种货物最多2件':'对手无货可取'):(state.drawCount?`对手抽最多${state.drawCount}张牌`:'对手无牌可抽');
      return button('native-select',`<strong>${esc(own)}</strong><small>${esc(other)}</small>`,{type:'option',index,part:0},disabled,`hy-material-branch hy-benefit-option${state.branch===option.branch?' is-selected':''}`);
    }).join('')}</div>`;
  }else if(state.step==='goods'){
    const options=state.parts[1].choice.options;
    body=`<div class="hy-benefit-summary"><span>选择自己取得的货物；对手负责抽牌。</span>${back('branch','改选收益')}</div><div class="hy-benefit-options hy-benefit-goods">${GOODS.map(good=>{
      const available=game.bankGoods[good.id],index=options.findIndex(option=>option.goodsId===good.id);
      return button('native-select',`${renderGoodsIcon(good.id)}<strong>${good.name}</strong><small>${available?`可取${Math.min(2,available)}件 · 公库${available}件`:'公库已空'}</small>`,{type:'option',index,part:1},disabled||index<0,`hy-material-good${state.goodsId===good.id?' is-selected':''}`);
    }).join('')}</div>`;
  }else if(state.step==='target'){
    body=`<div class="hy-benefit-summary"><span>${esc(summary)}</span>${back('branch','改选收益')}${state.goodsId?back('goods','改选货物'):''}</div><div class="hy-benefit-options hy-benefit-players">${state.peers.map(peer=>button('draft-value',`<strong>${esc(name(peer.id))}</strong><small>${state.branch==='draw'?'由对方自己选货':'由对方抽牌'}</small>`,{field:'targetId',id:peer.id},disabled,`hy-material-player${state.peer?.id===peer.id?' is-selected':''}`)).join('')}</div>`;
  }else{
    body=`<p class="hy-benefit-result">${esc(summary)}</p><div class="hy-benefit-rechoose">${back('branch','改选收益')}${state.goodsId?back('goods','改选货物'):''}${state.peers.length>1?back('target','改选对手'):''}</div><p class="hy-benefit-confirm-note">选择已齐，点击左侧“确认使用”才会结算。</p>`;
  }
  return `<section class="hy-benefit-stage" data-benefit-step="${state.step}" aria-label="把戏人收益与对手选择">${body}</section>`;
}

/** After commitment the recipient chooses only their own good, never the split. */
export function renderBenefitGoods({game,pending,draft,canChoose}){
  const options=pending.choice.options;
  return `<section class="hy-benefit-stage" data-benefit-step="receive" aria-label="选择你的收益货物"><p class="hy-benefit-confirm-note">选一种货物，再确认取得；其他人不能替你选择。</p><div class="hy-benefit-options hy-benefit-goods">${GOODS.map(good=>{
    const available=game.bankGoods[good.id],index=options.findIndex(option=>option.goodsId===good.id);
    return button('inline-option',`${renderGoodsIcon(good.id)}<strong>${good.name}</strong><small>${available?`可取${Math.min(2,available)}件 · 公库${available}件`:'公库已空'}</small>`,{index},!canChoose||index<0,`hy-material-good${index>=0&&draft?.optionIndex===index?' is-selected':''}`);
  }).join('')}</div></section>`;
}


/** A restored C01 branch uses the same material owner as current local drafts.
 * Its original option index, pressed state and inline-option command remain
 * unchanged; choices are never embedded in a tiny reading-only body. */
export function renderBenefitBranches({pending,draft,canChoose}){
  const selected=draft?.optionIndex??-1;
  return `<section class="hy-benefit-stage" data-benefit-step="branch" aria-label="选择自己的收益"><div class="hy-benefit-options hy-benefit-branches">${pending.choice.options.map((option,index)=>{
    const draw=option.branch==='draw';
    return `<button type="button" class="hy-material-branch hy-benefit-option${selected===index?' is-selected':''}" data-hy-action="inline-option" data-hy-fields="${esc(JSON.stringify({index}))}" aria-pressed="${selected===index}" ${canChoose?'':'disabled'}><strong>${draw?'你抽最多2张牌':'你自选同种货物最多2件'}</strong><small>${draw?'对手自行选择同种货物最多2件':'对手抽最多2张牌'}</small></button>`;
  }).join('')}</div></section>`;
}
