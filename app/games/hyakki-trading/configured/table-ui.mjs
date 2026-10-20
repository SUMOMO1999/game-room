/** New expansion decisions reuse the accepted Step 0 table surfaces. No modal play and no hidden-state simulation. */
import {GOODS,CATEGORIES,CARDS,ROLES,getRole} from '../content/expansion-one.mjs';
import {isExpansion,getCard,categoryName,expansionAsset} from '../presentation-content.mjs';
import {renderCard,renderGoodsIcon} from '../digital-card-ui.mjs';
import {knownCards,cardKey} from '../game-ui-model.mjs';
import {resolveTradeMaterials,quoteGoodsTrade,newTradeUsage,receiptPlan,categoryCounts} from '../trade-contract.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count=v=>Object.values(v??{}).reduce((a,b)=>a+b,0),zeros=()=>Object.fromEntries(GOODS.map(g=>[g.id,0]));
const button=(type,label,fields={},disabled=false,className='')=>`<button type="button"${className?` class="${className}"`:''} data-ex-command="${type}" data-ex-fields="${esc(JSON.stringify(fields))}" ${disabled?'disabled':''}>${label}</button>`;
const activeRoles=new Set(['R09','R14','R16','R17','R18','R20','R22','R23','R24']);
const expansionCard=c=>{const f=getCard(c.definitionId);return f.category==='goods'?!!f.recipe&&f.recipe.type!=='fixed':f.sourceCode.startsWith('X');};
const newPending=p=>!!p&&(!p.response&&p.choice&&(p.code?.startsWith('X')||p.kind==='role'||p.choice.kind==='peek-select'));
export function mountExpansionTable({root,send,read,rerender,feedback,available,clearLegacyDraft,inspect}){
  const document=root.ownerDocument,$=id=>document.getElementById(id);
  const work=document.createElement('section');work.id='ex-workbench';work.className='ex-workbench';work.hidden=true;work.setAttribute('aria-labelledby','ex-work-title');$('yg-scene-content').after(work);
  const roles=document.createElement('section');roles.className='ex-role-stage';roles.hidden=true;roles.setAttribute('aria-label','选择本局角色');root.querySelector('.yg-shell').append(roles);
  const dock=document.createElement('button');dock.type='button';dock.className='ex-role-dock';dock.dataset.exCommand='role';dock.dataset.exFields='{}';dock.hidden=true;$('yg-tool-zone').insertBefore(dock,$('yg-tool-zone').firstElementChild??null);
  let room=null,selected=null,direction=null,selection={},params={},choiceId=null,candidate=null,catalogPage=0,page=0,pagesByField={},scope=null;
  const own=()=>room?.game?.players.find(p=>p.id===room.selfId);
  const usable=()=>available()&&room.phase==='playing'&&room.selfRole==='player';
  const image=role=>`<img class="ex-dock-art" src="${esc(expansionAsset(role.artPath))}" alt="" draggable="false">`;
  const faceOf=()=>selected?.roleId?getRole(selected.roleId):selected?getCard(selected.definitionId):null;
  function reset(){selected=null;direction=null;selection={};params={};page=0;pagesByField={};}
  function selectedOwned(){if(!selected)return false;return selected.roleId===own()?.roleId||[...(own()?.hand??[]),...(own()?.tools??[])].some(c=>cardKey(c)===cardKey(selected));}
  function renderMarket(){
    $('yg-market').classList.add('ex-market');$('yg-market').innerHTML=`<button type="button" class="ex-market-board" data-hy-action="members" aria-label="查看十二种公共货物及公开商铺">${CATEGORIES.map(c=>`<span class="ex-market-pair"><small>${c.name}</small><span>${GOODS.filter(g=>g.category===c.id).map(g=>`<span class="ex-market-good"><img src="${esc(expansionAsset(g.icon))}" alt=""><span>${g.name}</span><b>${room.game?.bankGoods?.[g.id]??room.hyakkiConfig.goodsPerType}</b></span>`).join('')}</span></span>`).join('')}</button>`;
    $('yg-stock-limit').textContent=`十二种 · 各${room.game?.goodsPerType??room.hyakkiConfig.goodsPerType}件`;
  }
  function roleDock(){const me=own();dock.hidden=!me?.roleId;if(!me?.roleId)return;
    const role=getRole(me.roleId);dock.innerHTML=`${image(role)}<span><strong>${esc(role.name)}</strong><small>${esc(role.compactText)}</small></span>`;
    dock.setAttribute('aria-label',`${role.name}：${role.compactText}，查看能力`);
    for(const node of root.querySelectorAll('#yg-peer [data-public-player]')){
      const p=room.game.players.find(p=>p.id===node.dataset.publicPlayer);if(!p?.roleId)continue;const r=getRole(p.roleId);
      const portrait=node.querySelector('.nm-portrait');if(portrait)portrait.src=expansionAsset(r.artPath);
      const seat=node.querySelector('.nm-peer-copy>small');if(seat)seat.textContent=`${room.game.players.indexOf(p)+1}席 · ${r.name}`;
    }
  }
  function catalog(){const all=[...CARDS,...ROLES],last=Math.ceil(all.length/8)-1;catalogPage=Math.min(catalogPage,last);
    inspect('六行百业 · 102种牌与24位角色',`<div class="ex-catalog">${all.slice(catalogPage*8,catalogPage*8+8).map(c=>button('read',renderCard({definitionId:c.id},{interactive:false}),{definitionId:c.id})).join('')}</div>`,`${button('catalog-page','上一页',{delta:-1},!catalogPage)}<span>${catalogPage+1}/${last+1} · 点牌阅读</span>${button('catalog-page','下一页',{delta:1},catalogPage>=last)}`);
  }
  function renderOpening(){const o=room.game.opening,self=o.self;roles.hidden=false;root.dataset.exScene='select-role';
    if(candidate&&!self?.candidates.includes(candidate))candidate=null;
    roles.innerHTML=`<div class="ex-choice-heading"><div><small>候选仅你可见 · ${o.confirmed.filter(p=>p.confirmed).length}/${o.confirmed.length}已确认</small><h1>${self?.confirmedRoleId?'已确认，等待伙伴':'选择你的经营方式'}</h1></div><span>限时60秒 · 到时采用原候选第一位</span></div><div class="ex-candidates">${(self?.candidates??[]).map(id=>{const r=getRole(id);return `<article class="ex-candidate${candidate===id?' is-selected':''}">${button('candidate',renderCard({definitionId:id},{interactive:false}),{roleId:id},!!self.confirmedRoleId)}${button('read','ⓘ',{definitionId:id})}</article>`;}).join('')||'<p>选角进行中；其他人的候选不公开。</p>'}</div><div class="ex-role-confirm"><span>全部确认后统一公开角色、发钱与手牌。</span><div>${button('confirm-role',self?.confirmedRoleId?'已确认':'确认角色',{},!candidate||!!self?.confirmedRoleId||!usable())}</div></div>`;
    root.querySelector('.yg-playfield').inert=true;
  }
  function tradeQuote(){const face=faceOf();return quoteGoodsTrade({owner:own(),bankGoods:room.game.bankGoods,usage:Object.fromEntries(Object.keys(newTradeUsage()).map(k=>[k,room.game.turnUsage[k]])),
    bookLayers:room.game.bookLayers,definitionId:face.id,direction,materials:selection.goods});}
  function canAddTrade(id){if(!direction)return true;const recipe=faceOf().recipe,goods={...(selection.goods??{})};goods[id]=(goods[id]??0)+1;
    if(count(goods)>recipe.count)return false;const classes=categoryCounts(goods),primary=classes[recipe.category]??0;
    if(recipe.type==='class')return primary===count(goods);
    if(recipe.type==='mixed')return primary<=recipe.primaryCount&&count(goods)-primary<=recipe.otherCount;
    if(recipe.type==='distinct')return Object.keys(classes).length===count(goods);return true;
  }
  function goodsPicker(stock,field,{category=null}={}){
    const list=GOODS.filter(g=>stock[g.id]>0&&(!category||g.category===category));
    const per=['give','receive'].includes(field)?(root.ownerDocument.defaultView.innerWidth<=700?1:2):4;
    const pages=Math.max(1,Math.ceil(list.length/per)),page=Math.min(pagesByField[field]??0,pages-1);
    const option=room.game.pending?.choice?.options[0],maximum=direction?faceOf().recipe.count:option?.capacity??option?.count??option?.maximum??2;
    return `<div class="ex-material-browser" aria-label="${field==='give'?'交出':field==='receive'?'换入':'选择'}货物，第${page+1}页，共${pages}页">${button('page','‹',{delta:-1,key:field},!page)}<div class="ex-material-source">${list.slice(page*per,(page+1)*per).map(g=>button('amount',`${renderGoodsIcon(g.id)}<span><strong>${g.name}</strong><small>公货${stock[g.id]} · 已选${selection[field]?.[g.id]??0}</small></span>`,{field,id:g.id,delta:1},(selection[field]?.[g.id]??0)>=stock[g.id]||count(selection[field])>=maximum||direction&&field==='goods'&&!canAddTrade(g.id))).join('')||'<span>当前无货</span>'}</div>${button('page','›',{delta:1,key:field},page>=pages-1)}</div>`;
  }
  function selectionSummary(){if(selection.give||selection.receive)return `交${named(selection.give)} → 换${named(selection.receive)}`;
    return selection.goods?named(selection.goods):Object.keys(selection).length?choiceName(selection):'请选择材料';}
  function undoSelection(){for(const field of ['receive','give','goods']){const id=GOODS.findLast(g=>selection[field]?.[g.id]>0)?.id;if(id){selection[field][id]--;return;}}selection={};}
  function named(v){return GOODS.filter(g=>v?.[g.id]).map(g=>`${g.name}×${v[g.id]}`).join('、')||'未选';}
  function choiceName(value){const cards=knownCards(room.game),items=[];for(const [key,v] of Object.entries(value)){
    if(key==='cardId'||key.endsWith('CardId')||key==='toolCardId'){const c=cards.get(v);items.push(c?getCard(c.definitionId).name:'当前候选牌');}
    else if(key==='goodId'||key==='ownGoodId')items.push(GOODS.find(g=>g.id===v)?.name??'货物');
    else if(key==='branch')items.push(v==='silver'?'支付2两':'交回1件货物');
    else items.push(String(v));}return esc(items.join(' → '));}
  function choiceBrowser(label,items,key,{dual=false}={}){
    const short=document.defaultView.innerHeight<=500;
    const per=dual?1:short?2:4, pages=Math.max(1,Math.ceil(items.length/per));
    const page=Math.min(pagesByField[key]??0,pages-1);
    return `<section class="ex-choice-list" aria-label="${esc(label)}"><strong>${esc(label)} · ${page+1}/${pages}</strong><div class="ex-material-browser ex-card-browser ex-picker-${per}">${button('page','‹',{delta:-1,key},!page)}<div class="ex-material-source">${items.slice(page*per,(page+1)*per).join('')}</div>${button('page','›',{delta:1,key},page>=pages-1)}</div></section>`;
  }
  function choiceObject(type,fields,card,label,chosen){
    return `<div class="ex-choice-object">${button(type,esc(label),fields,false,chosen?'is-selected':'')}${card?button('read',`<span aria-hidden="true">ⓘ</span><span class="ex-sr-only">阅读${esc(label)}</span>`,{definitionId:card.definitionId}):''}</div>`;
  }
  function picker(kind,values,key){const cards=knownCards(room.game);return choiceBrowser(kind,values.map(id=>{const c=cards.get(id);return choiceObject('field',{key,value:id},c,c?getCard(c.definitionId).name:String(id),selection[key]===id);}),key,{dual:true});}
  function pendingBody(p){const first=p.choice.options[0]??{},kind=p.choice.kind;
    if(kind==='retain-goods')return goodsPicker(first.combined,'goods');
    if(first.goods){const category=first.categoryId;return goodsPicker(first.goods,'goods',{category});}
    if(first.ownGoods)return `<div class="ex-field-pair"><section><h3>交出</h3>${goodsPicker(first.ownGoods,'give')}</section><section><h3>换入</h3>${goodsPicker(first.bankGoods,'receive')}</section></div>`;
    if(first.tools)return `<div class="ex-field-pair">${picker('① 弃掉1张手牌',first.payments,'cardId')}${picker('② 重置自己的道具',first.tools,'toolCardId')}</div>`;
    if(first.payments)return `<div class="ex-field-pair">${picker('① 弃手中货物牌',first.payments,'payCardId')}${picker('② 取弃牌区货物牌',first.targets,'takeCardId')}</div>`;
    const options=p.choice.options,cards=knownCards(room.game);
    return choiceBrowser(kind==='private-hand-discard'?'选择弃掉的手牌':'选择本次材料',options.map((value,index)=>{const card=value.cardId&&cards.get(value.cardId);return choiceObject('option',{index},card,card?getCard(card.definitionId).name:choiceName(value),JSON.stringify(selection)===JSON.stringify(value));}),'options');
  }
  function pendingReady(p){const first=p.choice.options[0]??{};try{
    if(p.choice.kind==='retain-goods')return !!selection.goods&&count(selection.goods)<=first.capacity&&GOODS.every(g=>Number.isSafeInteger(selection.goods[g.id])&&selection.goods[g.id]>=0&&selection.goods[g.id]<=first.combined[g.id]);
    if(first.goods){const n=count(selection.goods);if(n<(first.count??first.minimum??1)||n>(first.count??first.maximum??3))return false;
      if(GOODS.some(g=>(selection.goods?.[g.id]??0)>first.goods[g.id]||first.categoryId&&selection.goods?.[g.id]>0&&g.category!==first.categoryId))return false;
      if(p.choice.kind==='class-surrender'&&Object.keys(categoryCounts(selection.goods)).length!==1)return false;return true;}
    if(first.ownGoods){const a=categoryCounts(selection.give??{}),b=categoryCounts(selection.receive??{}),n=count(selection.give);if(n<1||n>(first.count??2)||n!==count(selection.receive)||first.count&&n!==first.count||Object.keys(a).length!==1||Object.keys(b).length!==1)return false;
      if((p.choice.kind==='class-exchange')===(Object.keys(a)[0]===Object.keys(b)[0]))return false;
      if(!GOODS.some(g=>selection.give?.[g.id]!==selection.receive?.[g.id]))return false;
      receiptPlan(own(),room.game.bankGoods,{give:selection.give,receive:selection.receive,cost:p.choice.kind==='class-exchange'?1:0});return true;}
    if(first.tools)return first.payments.includes(selection.cardId)&&first.tools.includes(selection.toolCardId);
    if(first.payments)return first.payments.includes(selection.payCardId)&&first.targets.includes(selection.takeCardId);
    return p.choice.options.some(o=>JSON.stringify(o)===JSON.stringify(selection));
  }catch{return false;}}
  const needsTarget=code=>/^XM|^R2[34]$/u.test(code);
  const needsCategory=code=>['XC07','XM05','XM06','R17'].includes(code);
  function peerEligible(code,peer){
    const me=own(),stock=count(peer.goods);
    if(code==='R23')return peer.silver>=2&&peer.silver>=me.silver;
    if(code==='R24')return peer.silver>=2&&stock>=3;
    if(code==='XM02')return peer.silver-me.silver>=6;
    if(code==='XM03')return peer.silver>=2||stock>0;
    if(['XM05','XM06'].includes(code))return stock>0;
    return peer.silver>=1;
  }
  function parameterTray(face,{replacement,can,role}){
    const code=face.sourceCode,targetNeeded=needsTarget(code),categoryNeeded=needsCategory(code);
    const phase=replacement?'replacement':targetNeeded&&!params.targetId?'target':categoryNeeded?'category':'target';
    const member=id=>room.players.find(p=>p.id===id)?.name??'对手';let entries=[],label='';
    if(phase==='replacement'){
      label='选择要替换的装备';entries=own().tools.map(card=>{const id=cardKey(card);return `<div class="ex-choice-object">${button('param',esc(getCard(card.definitionId).name),{key:'replaceCardId',value:id},false,params.replaceCardId===id?'is-selected':'')}${button('read',`ⓘ<span class="ex-sr-only">阅读${esc(getCard(card.definitionId).name)}</span>`,{definitionId:card.definitionId})}</div>`;});
    }else if(phase==='target'){
      label=categoryNeeded?'① 选择对手':'选择对手';entries=room.game.players.filter(p=>p.id!==room.selfId).map(peer=>{const eligible=peerEligible(code,peer);return `<div class="ex-choice-object">${button('param',`<span class="ex-param-label">${esc(member(peer.id))}</span><small>${peer.silver}两${eligible?'':' · 不符条件'}</small>`,{key:'targetId',value:peer.id},!eligible,params.targetId===peer.id?'is-selected':'')}</div>`;});
    }else{
      label=targetNeeded?'② 选择类别':'选择类别';const stock=targetNeeded?room.game.players.find(p=>p.id===params.targetId).goods:room.game.bankGoods;
      entries=CATEGORIES.map(c=>{const available=GOODS.filter(g=>g.category===c.id).reduce((sum,g)=>sum+stock[g.id],0),eligible=available>=(code==='XC07'?2:1);return `<div class="ex-choice-object">${button('param',`${c.name}<small>${available}件${eligible?'':' · 不足'}</small>`,{key:'categoryId',value:c.id},!eligible,params.categoryId===c.id?'is-selected':'')}</div>`;});
    }
    const ready=replacement?!!params.replaceCardId:(!targetNeeded||!!params.targetId)&&(!categoryNeeded||!!params.categoryId);
    const selected=replacement?params.replaceCardId&&getCard(own().tools.find(c=>cardKey(c)===params.replaceCardId).definitionId).name:[params.targetId&&member(params.targetId),params.categoryId&&categoryName(params.categoryId)].filter(Boolean).join(' · ');
    frame(face,`${face.name} · ${label}`,choiceBrowser(label,entries,'param-'+phase),`<div class="ex-quote"><p>${esc(selected||'请选择本次对象')}</p><p>${replacement?'安装免费，确认后替换旧装备':'确认前不消耗行动或银两'}</p></div>${targetNeeded&&categoryNeeded&&params.targetId?button('param-back','重选对手'):''}${button('close','取消')}${button(replacement?'install':'use',replacement?'确认安装 · 0行动':`确认使用 · ${role&&code==='R22'?0:1}行动`,{},!ready||!can||role&&room.game.turnUsage.roleUsed)}`);
  }
  function frame(source,title,body,footer){
    work.hidden=false;root.classList.add('ex-working');if(document.defaultView.innerHeight<=719)$('yg-title').textContent=title;$('hy-task-materials').hidden=true;$('yg-scene-content').innerHTML='';
    work.innerHTML=`<button class="ex-task-source" type="button" data-ex-command="read" data-ex-fields="${esc(JSON.stringify({definitionId:source.id}))}" aria-label="阅读完整牌文">${renderCard({definitionId:source.id},{interactive:false})}</button><div class="ex-task-copy"><div class="ex-task-heading"><h2 id="ex-work-title">${esc(title)}</h2>${button('close','×',{},!!room.game.pending)}</div><div class="ex-work-body">${body}</div><div class="ex-work-footer">${footer}</div></div>`;
  }
  function renderSelected(){const face=faceOf();if(!face)return;
    const me=own(),can=usable()&&room.game.turnPlayerId===room.selfId&&!room.game.pending&&room.game.stage==='use';
    const role=!!selected.roleId,isTool=face.category==='tool',installed=isTool&&me.tools.some(c=>cardKey(c)===cardKey(selected));
    if(direction){let quote=null,error='';try{quote=tradeQuote();}catch(e){error=e.message;}
      const recipe=face.recipe??{type:'fixed',goods:face.goods,count:count(face.goods)},fixed=recipe.type==='fixed';
      frame(face,`${face.name} · ${direction==='buy'?'买入':'卖出'}`,`${goodsPicker(direction==='buy'?room.game.bankGoods:me.goods,'goods',{category:recipe.type==='class'?recipe.category:null})}`,
        `<div class="ex-quote"><p>已选${count(selection.goods)}/${recipe.count}：${esc(named(selection.goods))}</p>${quote?`<p>印价${quote.printedPrice}${quote.bookLayers?' · 书算'+quote.bookLayers+'层':''}${quote.roleAdjustment?' · 角色'+quote.roleAdjustment:''}${quote.buyTax?' · 税'+quote.buyTax:''}${quote.temporaryFee?' · 临时格'+quote.temporaryFee:''}</p><strong>${direction==='buy'?'应付':'取得'}${direction==='buy'?quote.totalPayment:quote.saleProceeds}两</strong>`:esc(count(selection.goods)<recipe.count?'再选'+(recipe.count-count(selection.goods))+'件货物':error)}</div>${button('undo','撤1件',{},!count(selection.goods))}${button('back','返回')}${button('trade-confirm',`确认${direction==='buy'?'买入':'卖出'}`,{},!quote||!can)}`);return;}
    const replacement=isTool&&!installed&&me.tools.length>=3;
    if(room.game.stage==='use'&&(needsTarget(face.sourceCode)||needsCategory(face.sourceCode)||replacement)){
      parameterTray(face,{replacement,can,role});return;
    }
    const actions=room.game.stage==='draw'?button('start-use',!room.game.drawStarted?'先摸第一张 · 1行动':'进入用牌',{},!usable()):face.category==='goods'?button('trade','买入',{direction:'buy'},!can)+button('trade','卖出',{direction:'sell'},!can)
      :role?activeRoles.has(face.sourceCode)?button('use',`发动角色 · ${face.sourceCode==='R22'?0:1}行动`,{},!can||room.game.turnUsage.roleUsed):''
      :isTool&&!installed?button('install','安装 · 0行动',{},!can):button('use',`${isTool?'使用道具':'确认使用'} · 1行动`,{},!can||installed&&selected.exhausted);
    $('yg-scene-content').innerHTML=`<section class="hy-card-play hy-action-draft"><div class="hy-inline-card">${button('read',renderCard({definitionId:face.id},{interactive:false}),{definitionId:face.id},false,'hy-source-reader')}</div><div class="hy-inline-copy"><div class="hy-decision-heading"><strong>${esc(face.name)}</strong>${button('read','牌文',{definitionId:face.id})}</div><div class="hy-source-description"><p class="hy-decision-summary">${esc(face.summary)}</p></div><div class="hy-inline-actions">${actions}${button('close','取消')}</div></div></section>`;
  }
  function render(next){room=next;const expansion=isExpansion(room.game??room.hyakkiConfig);root.classList.toggle('ex-preview',expansion);if(expansion){$('yg-catalog').dataset.exCommand='catalog';$('yg-catalog').textContent='查看102种牌与24角色';}else {delete $('yg-catalog').dataset.exCommand;$('yg-catalog').textContent='查看完整51种卡牌';}if(!expansion){work.hidden=true;roles.hidden=true;dock.hidden=true;root.classList.remove('ex-working');delete root.dataset.exScene;return;}
    const nowScope=`${room.roomId}:${room.matchId}`;if(scope!==nowScope){reset();candidate=null;choiceId=null;scope=nowScope;}
    renderMarket();roleDock();if(room.game?.kind==='hyakki-opening-game'){renderOpening();return;}
    roles.hidden=true;delete root.dataset.exScene;root.querySelector('.yg-playfield').inert=false;
    if(selected&&!selectedOwned())reset();work.hidden=true;root.classList.remove('ex-working');
    const p=room.game?.pending;
    if(newPending(p)){
      if(choiceId!==p.choice.id){choiceId=p.choice.id;selection=p.choice.kind==='retain-goods'?{goods:{...p.choice.defaultSelection}}:{};page=0;pagesByField={};}
      const source=p.sourceRole?getRole(p.sourceRole.roleId):getCard(p.sourceCards[0]?.definitionId??`yousei.${p.code.toLowerCase()}`);
      const mine=p.actorId===room.selfId&&usable();
      frame(source,p.choice.kind==='retain-goods'?`选择保留的货物 · 最多${p.choice.options[0].capacity}件`:source.name,mine?pendingBody(p):`<p>等待${esc(room.players.find(m=>m.id===p.actorId)?.name??'伙伴')}完成选择。</p>`,
        `<div class="ex-quote"><p>${p.choice.kind==='retain-goods'?`保留${count(selection.goods)}/${p.choice.options[0].capacity}件：`:''}${selectionSummary()}</p><p>${p.choice.kind==='retain-goods'?`临时格费${count(selection.goods)>p.choice.options[0].ordinaryCapacity?p.choice.options[0].temporaryFee:0}两 · `:''}本步不再消耗行动</p></div>${mine?button('undo','撤1项')+button('pending-confirm','确认选择',{},!pendingReady(p)):''}`);return;
    }
    choiceId=null;if(!p&&selected)renderSelected();
    const me=own();if(me?.roleId==='yousei.role.r15'&&room.game.stage==='draw'&&!room.game.drawStarted&&!p&&room.game.turnPlayerId===room.selfId){$('yg-scene-content').insertAdjacentHTML('beforeend',button('inspect','鉴牌：付1两，先看2张',{},!usable()||me.silver<1||room.game.deckCount+room.game.discard.length<2));}
  }
  function event(event){
    if(!room||!isExpansion(room.game??room.hyakkiConfig))return;
    const command=event.target.closest('[data-ex-command]'),hand=event.target.closest('#yg-hand [data-entity-id]'),tool=event.target.closest('#yg-tools [data-tool-id]');
    let intercept=!!command;
    const physical=hand||tool,c=physical&&[...(own()?.hand??[]),...(own()?.tools??[])].find(c=>cardKey(c)===(hand?.dataset.entityId??tool?.dataset.toolId));
    if(c&&!room.game.pending){const f=getCard(c.definitionId);intercept=intercept||expansionCard(c);}
    if(!intercept){if(c)reset();return;}event.preventDefault();event.stopImmediatePropagation();
    if(!command){if(room.game.turnPlayerId!==room.selfId)return read(c);clearLegacyDraft();reset();selected=c;rerender();return;}
    const type=command.dataset.exCommand,fields=JSON.parse(command.dataset.exFields??'{}');if(command.disabled)return;
    if(type==='catalog'){catalogPage=0;return catalog();}
    if(type==='catalog-page'){catalogPage=Math.max(0,catalogPage+fields.delta);return catalog();}
    if(type==='read')return read({definitionId:fields.definitionId});
    if(type==='candidate')candidate=fields.roleId;
    else if(type==='confirm-role'){const self=room.game.opening.self;return send('confirm-role',{openingId:room.game.matchId,candidateId:self.candidateId,roleId:candidate});}
    else if(type==='role'){reset();selected={roleId:own().roleId};}
    else if(type==='close'){reset();}
    else if(type==='back'){direction=null;}
    else if(type==='trade'){direction=fields.direction;const f=faceOf();selection={goods:f.recipe?.type==='fixed'?{...f.recipe.goods}:zeros()};page=0;}
    else if(type==='undo')undoSelection();
    else if(type==='amount'){selection[fields.field]??=zeros();selection[fields.field][fields.id]=Math.max(0,selection[fields.field][fields.id]+fields.delta);}
    else if(type==='page'){if(fields.key)pagesByField[fields.key]=Math.max(0,(pagesByField[fields.key]??0)+fields.delta);else page=Math.max(0,page+fields.delta);}
    else if(type==='option')selection=structuredClone(room.game.pending.choice.options[fields.index]);
    else if(type==='field')selection[fields.key]=fields.value;
    else if(type==='param')params[fields.key]=fields.value;
    else if(type==='param-back'){delete params.targetId;delete params.categoryId;}
    else if(type==='pending-confirm')return send('choose-effect',{selection:room.game.pending.choice.kind==='retain-goods'?selection.goods:selection});
    else if(type==='trade-confirm')return send(direction,{cardId:cardKey(selected),materials:selection.goods});
    else if(type==='inspect')return send('peek',{inspect:true});
    else if(type==='start-use')return send(room.game.drawStarted?'finish-draw':'peek');
    else if(type==='install'){if(own().tools.length>=3&&!params.replaceCardId)return feedback('请选择要替换的装备。');return send('install-tool',{cardId:cardKey(selected),...(params.replaceCardId?{replaceCardId:params.replaceCardId}:{})});}
    else if(type==='use'){const f=faceOf();if((/^XM|^R2[34]$/u.test(f.sourceCode))&&!params.targetId)return feedback('请先选择一名对手。');if(['XC07','XM05','XM06','R17'].includes(f.sourceCode)&&!params.categoryId)return feedback('请先选择类别。');
      return send(selected.roleId?'use-role':own().tools.some(t=>cardKey(t)===cardKey(selected))?'activate-tool':'play-character',selected.roleId?{params}:{cardId:cardKey(selected),params});}
    rerender();
  }
  const onResize=()=>{if(room&&isExpansion(room.game??room.hyakkiConfig))render(room);};
  document.defaultView.addEventListener('resize',onResize);
  root.addEventListener('click',event,true);
  return {render,handlesPending:newPending,select(card){if(!room||!isExpansion(room.game)||!expansionCard(card))return false;clearLegacyDraft();reset();selected=card;rerender();return true;},destroy(){document.defaultView.removeEventListener('resize',onResize);room=null;root.removeEventListener('click',event,true);work.remove();roles.remove();dock.remove();}};
}
