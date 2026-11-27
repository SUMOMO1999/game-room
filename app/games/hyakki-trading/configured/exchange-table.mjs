import {GOODS,materialProfileFor} from './material.mjs';
import {renderCard,renderGoodsIcon} from '../digital-card-ui.mjs';
import {getCard} from '../presentation-content.mjs';
import {exchangeTermsProblem,EXCHANGE_KEEPER} from './exchange-market.mjs';

const categories={goods:'货物牌',ordinary_character:'普通人物',monitored_character:'监视人物',tool:'道具',stall_permit:'摊位许可'};
const sourceName={ordinary:'普通报价',broker:'牙行中人',seal:'合契印'};
const qualities=['ordinary','refined'];
const blank=()=>({ordinary:{},refined:{},silver:0});
const total=stock=>Object.values(stock).reduce((sum,count)=>sum+count,0);
const sameLeg=(a,b)=>a.silver===b.silver&&a.card?.definitionId===b.card?.definitionId&&a.card?.category===b.card?.category
  &&qualities.every(quality=>GOODS.every(({id})=>(a[quality][id]??0)===(b[quality][id]??0)));
const sourceFor=card=>card?.definitionId==='yousei.e2c03'?'broker':card?.definitionId==='yousei.e2t03'?'seal':'ordinary';
const setCount=(vector,id,value)=>{if(value>0)vector[id]=value;else delete vector[id];};
const hasAssets=leg=>Boolean(leg.silver||leg.card||leg.cardIds?.length||qualities.some(quality=>total(leg[quality])));

/** Only presentation owns the draft. Room authority owns all quotes and eligibility. */
export function createExchangeTable({button,escape,frame,picker,cardFace,commit,inspect}) {
  let offerRef,draft,cardId,borrowId;
  function reset(){offerRef=null;draft=null;cardId=null;borrowId=null;}
  reset();
  const refOf=({id,generation})=>({offerId:id,generation});
  const sameOffer=(offer,ref)=>offer?.id===ref?.offerId&&offer?.generation===ref?.generation;
  const name=(room,id)=>[...(room.matchPlayers??[]),...room.players].find(p=>p.id===id)?.name??'伙伴';
  function openDraft(source='ordinary',offered=null,turnId=null){
    draft={source,offered,turnId,side:offered?'receive':'provide',tab:'goods',quality:'ordinary',
      provide:{...blank(),cardIds:[]},receive:offered?structuredClone(offered.receive):{...blank(),card:null}};
  }
  function materialLine(leg,player){
    const goods=qualities.flatMap(quality=>GOODS.filter(({id})=>leg[quality][id]).map(({id,name})=>{
      const label=(quality==='refined'?'精制':'')+name;
      return `<span class="e2-asset">${renderGoodsIcon(id)}${label}<b>×${leg[quality][id]}</b></span>`;
    }));
    const cards=leg.cards??leg.cardIds?.map(id=>player.hand.find(card=>card.cardId===id)?.definitionId).filter(Boolean)??[];
    const requirement=leg.card?.category?categories[leg.card.category]:leg.card?.definitionId?getCard(leg.card.definitionId).name:null;
    return [...goods,...(leg.silver?[`<span class="e2-asset"><b>${leg.silver}</b>两</span>`]:[]),
      ...cards.map(id=>`<span class="e2-asset"><small>手牌</small> ${escape(getCard(id).name)}</span>`),
      ...(requirement?[`<span class="e2-asset">${escape(requirement)} ×1</span>`]:[])].join('')||'未选';
  }
  function terms(offer,player,{mine=false,taking=false}={}){
    const rows=taking?[[offer.receive,'你付'],[offer.provide,'你拿']]:
      [[offer.provide,mine?'我给':'对方给'],[offer.receive,mine?'我想换':'对方想换']];
    return `<div class="e2-offer-terms">${rows.map(([leg,label])=>
      `<div><strong>${label}</strong><div>${materialLine(leg,player)}</div></div>`).join('')}</div>`;
  }
  function draftTerms(player,offer,disabled){
    const row=(side,label,leg)=>{
      const content=`<strong>${label}</strong><span class="e2-offer-row-assets">${materialLine(leg,player)}</span>`;
      if(offer&&side==='provide')return `<div class="e2-offer-row">${content}</div>`;
      return button('exchange-side',content,{side},disabled,'e2-offer-row',label,draft.side===side);
    };
    return `<div class="e2-offer-terms e2-offer-draft">
      ${row('provide','我给',offer?.provide??draft.provide)}
      ${row('receive','我想换',draft.receive)}
    </div>`;
  }
  function inspectBoard(room){
    const offers=room.game.exchangeMarket.offers;
    inspect('玩家交易',offers.length?offers.map(offer=>`<article class="e2-offer-entry"><strong>${escape(name(room,offer.makerId))}</strong>${terms(offer,undefined,{mine:offer.mine,taking:room.selfRole==='player'&&!offer.mine})}</article>`).join(''):'<p>暂无报价。</p>');
  }
  function selectedOffer(market){
    return offerRef&&market.offers.find(item=>sameOffer(item,offerRef));
  }
  function canPost({market,current,safe}){
    return current&&safe&&market.usage&&!market.usage.published&&!market.usage.traded;
  }
  function canEdit({player,current,safe,market},offer){
    return current&&safe&&offer?.mine&&offer.source==='ordinary'&&player?.roleId===EXCHANGE_KEEPER&&!market.usage.edited;
  }
  function cardOptions(cards,selected,disabled,command){
    return `<div class="e2-offer-cards">${cards.map((card,index)=>{
      const {definitionId,cardId:id}=card, label=getCard(definitionId).name, chosen=selected.includes(id);
      return `<article class="e2-offer-card">${command?button(command,renderCard(card,{interactive:false}),{id},
        disabled(id),`hy-material-card${chosen?' is-selected':''}`,`选择${label} · 第${index+1}张`,chosen):renderCard(card,{interactive:false})}
        <button type="button" data-detail-id="${escape(definitionId)}" aria-label="阅读${escape(label)}">牌文</button></article>`;
    }).join('')}</div>`;
  }
  function requestedCard(profile,leg,disabled){
    const value=leg.card?.definitionId??leg.card?.category??'';
    const option=(id,label)=>`<option value="${escape(id)}" ${id===value?'selected':''}>${escape(label)}</option>`;
    const groups=Object.entries(categories).map(([category,label])=>`<optgroup label="${label}">${option(category,'任意'+label)}${profile.cards
      .filter(card=>card.category===category).map(card=>option(card.id,card.name+(card.category==='goods'&&card.name==='货物交易'?' · '+card.sourceCode:''))).join('')}</optgroup>`);
    return `<label class="e2-exchange-card-request"><span>索取手牌</span><select data-e2-offer-request ${disabled?'disabled':''}>${option('','无需手牌')}${groups.join('')}</select></label>`;
  }
  function renderDraft(ctx){
    const {room,player,sourceCard,borrowed,canChoose,market}=ctx,offer=draft.offered;
    const profile=materialProfileFor(room.game);
    const maximum=draft.source==='seal'?4:3, cardLimit=draft.source==='broker'?2:1;
    const other=draft.side==='provide'?'receive':'provide',leg=draft[draft.side],giving=draft.side==='provide';
    const usable=canChoose&&(borrowed|| (offer?canEdit(ctx,selectedOffer(market)):canPost(ctx)));
    let problem='';
    if(!offer&&!hasAssets(draft.provide))problem='请选择你给出的东西';
    else if(!hasAssets(draft.receive))problem='请选择你想换的东西';
    else if(offer?.provide.silver&&draft.receive.silver)problem='银两只能由一方支付';
    else problem=exchangeTermsProblem(offer?undefined:draft.provide,draft.receive,profile,draft.source);
    const changed=!offer||!sameLeg(draft.receive,offer.receive);
    const hasGive=giving&&draft.provide.cardIds.length>0;
    const cards=player.hand.filter(card=>card.cardId!==sourceCard?.cardId);
    const stock=Object.fromEntries(GOODS.map(({id})=>[id,maximum]));
    const capacity={goods:Object.fromEntries(GOODS.map(({id})=>[id,2*maximum])),refined:stock};
    const qualityEnabled=profile.modules.refining;
    const otherSilver=offer?.provide.silver??draft[other].silver;
    const silverBar=otherSilver?'':`<div class="e2-offer-silver"><span>银两</span>${button('exchange-silver','−',{delta:-1},!usable||leg.silver===0,'','减少1两')}<b>${leg.silver}</b>
      ${button('exchange-silver','+',{delta:1},!usable||leg.silver===10,'','增加1两')}</div>`;
    const assets=draft.tab==='goods'?picker(maximum,{owner:giving?player:capacity,canChoose:usable,basket:leg,grade:draft.quality,
      ordinaryOnly:!qualityEnabled,command:'exchange-quantity',qualityCommand:'exchange-quality'})
      :giving?cards.length?cardOptions(cards,leg.cardIds,id=>!usable||leg.cardIds.length===cardLimit&&!leg.cardIds.includes(id),'exchange-give-card'):'<p>没有可提供的手牌。</p>'
        :requestedCard(profile,leg,!usable);
    const publish=button('exchange-publish',offer?'确认改价':'免费发布',{},!usable||!changed||!!problem);
    const note=hasAssets(draft.receive)&&(offer||hasAssets(draft.provide))?problem:'';
    frame({title:offer?'修改想换的东西':borrowed?'借用合契印 · 发报价':'发布交易报价',
      source:sourceCard?cardFace(sourceCard):borrowed?cardFace({definitionId:'yousei.e2t03'}):'',
      description:draftTerms(player,offer,!usable)
        +(note?`<p class="e2-next-note">${escape(note)}</p>`:''),
      canClose:!borrowed,closeLabel:'取消',
      materials:`<div class="e2-offer-controls"><div class="e2-offer-switches">
        <div class="e2-quality" role="group" aria-label="交易材料">${button('exchange-tab','货物',{tab:'goods'},false,'','',draft.tab==='goods')}${button('exchange-tab',`手牌${hasGive?' · '+leg.cardIds.length:''}`,{tab:'cards'},false,'','',draft.tab==='cards')}</div></div>${silverBar}</div>${assets}`,
      actions:(borrowed?button('exchange-skip','取消',{},!canChoose):'')
        +publish});
  }
  function render(ctx){
    const {room,market,sourceCard,borrowed,safe,canChoose}=ctx;
    if(borrowed){
      if(borrowId!==borrowed.decisionId){reset();borrowId=borrowed.decisionId;openDraft('seal');}
      if(!ctx.player||borrowed.actorId!==room.selfId){
        frame({title:'合契印',source:cardFace({definitionId:'yousei.e2t03'}),description:'<p>等待伙伴填写报价。</p>',materials:'',actions:'',canClose:false});
        return;
      }
    }
    if(draft?.turnId&&draft.turnId!==room.game.turnId)draft=null;
    if(draft)return renderDraft(ctx);
    const offer=selectedOffer(market);
    if(offerRef&&!offer){
      frame({title:'玩家交易',source:'',description:'<p>报价已更改或结束，请返回查看其他报价。</p>',materials:'',actions:''});
      return;
    }
    if(!offer){
      const post=ctx.player&&canChoose&&canPost(ctx);
      const note=post?'出个价，跟其他玩家换货、银两或手牌。':
        !market.offers.length?'暂无报价。':ctx.player?'点一笔报价查看你要付和拿什么。':'';
      frame({title:'玩家交易',source:'',description:note?`<p>${note}</p>`:'',
        materials:market.offers.map(item=>`<article class="e2-offer-entry">${button('exchange-offer',
          `${item.mine?'我的报价':escape(name(room,item.makerId))+'的报价'} ›`,refOf(item))}
          ${terms(item,undefined,{mine:item.mine,taking:Boolean(ctx.player&&!item.mine)})}</article>`).join(''),
        actions:ctx.player?button('exchange-post','发布报价',{},!post):''});
      return;
    }
    const offered=offer.provide.cards.map(definitionId=>({definitionId}));
    const choices=ctx.player?.hand.filter(card=>offer.eligibleCards?.includes(card.cardId))??[];
    const validCard=choices.some(card=>card.cardId===cardId);
    const cardRequired=Boolean(offer.receive.card);
    const exactCard=offer.receive.card?.definitionId;
    const materials=(offered.length?'<section class="hy-material-step"><h3>对方提供的牌</h3>'+cardOptions(offered,[],()=>true)+'</section>':'')
      +(choices.length?'<section class="hy-material-step"><h3>选择自己要交出的牌</h3>'+cardOptions(choices,[cardId],()=>!safe||!canChoose,'exchange-take-card')+'</section>':'');
    const cost=offer.temporaryFee?`<p>临时格另付 ${offer.temporaryFee}两</p>`:'';
    const note=offer.reason||(ctx.player&&!offer.mine&&cardRequired&&!validCard?'选一张要付的手牌':'');
    const owner=offer.mine?'我的报价':name(room,offer.makerId)+'的报价';
    frame({title:offer.source==='ordinary'?owner:owner+' · '+sourceName[offer.source],source:sourceCard?cardFace(sourceCard):'',
      description:terms(offer,undefined,{mine:offer.mine,taking:Boolean(ctx.player&&!offer.mine)})+cost
        +(note&&ctx.player?`<p class="e2-next-note">${escape(note)}</p>`:''),
      materials:materials?`<div class="e2-offer-card-pairs">${materials}</div>`:exactCard?cardOptions([{definitionId:exactCard}],[],()=>true):'',
      actions:!ctx.player?'':offer.mine?button('exchange-withdraw','撤回报价',{},!safe||!canChoose)
        +(canEdit(ctx,offer)?button('exchange-edit','改价',{},!canChoose):'')
        :button('exchange-accept','确认交换',{},!safe||!canChoose||!offer.ready||cardRequired&&!validCard)});
  }
  function command(type,fields,ctx){
    const {sourceCard,borrowed}=ctx;
    if(type==='exchange-read')return inspectBoard(ctx.room);
    if(type==='exchange-offer'){offerRef=fields;cardId=null;return;}
    if(type==='exchange-post'){openDraft('ordinary',null,ctx.room.game.turnId);return;}
    if(type==='exchange-edit'){const offer=selectedOffer(ctx.market);if(offer)openDraft('ordinary',offer,ctx.room.game.turnId);return;}
    if(type==='exchange-withdraw')return commit('offer-withdraw',offerRef);
    if(type==='exchange-take-card'){cardId=fields.id;return;}
    if(type==='exchange-accept')return commit('offer-accept',{...offerRef,...(cardId?{cardId}:{})});
    if(type==='exchange-skip')return commit('choose-effect',{selection:{skip:true}});
    if(!draft)return;
    if(type==='exchange-publish'){
      const {provide,receive,offered}=draft,params={provide,receive};
      if(borrowed)return commit('choose-effect',{selection:params});
      if(offered)return commit('offer-edit',{...offerRef,receive});
      return sourceCard?commit(draft.source==='broker'?'play-character':'activate-tool',{cardId:sourceCard.cardId,params}):commit('offer-post',params);
    }
    if(type==='exchange-side'){draft.side=fields.side;draft.quality='ordinary';return;}
    if(type==='exchange-tab'){draft.tab=fields.tab;return;}
    if(type==='exchange-quality'){draft.quality=fields.quality;return;}
    const leg=draft[draft.side];
    if(type==='exchange-silver')leg.silver+=fields.delta;
    if(type==='exchange-quantity')setCount(leg[draft.quality],fields.id,(leg[draft.quality][fields.id]??0)+fields.delta);
    if(type==='exchange-give-card'){
      if(leg.cardIds.includes(fields.id))leg.cardIds=leg.cardIds.filter(id=>id!==fields.id);
      else leg.cardIds.push(fields.id);
    }
  }
  return {render,reset,command,
    selecting:()=>!!draft||!!offerRef,
    source:card=>openDraft(sourceFor(card)),
    close(){if(draft){draft=null;return;}offerRef=null;cardId=null;},
    requestCard(value){if(draft?.side==='receive')draft.receive.card=value?{[Object.hasOwn(categories,value)?'category':'definitionId']:value}:null;},
    trayIdentity:()=>draft?`draft:${draft.side}:${draft.tab}:${borrowId??''}`:offerRef?.offerId??'board',
    borrowedDone:()=>!!borrowId,
  };
}
