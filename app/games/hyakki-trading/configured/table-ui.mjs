/** New expansion decisions reuse the accepted Step 0 table surfaces. No modal play and no hidden-state simulation. */
import {GOODS,CATEGORIES,CARDS,ROLES,getRole} from '../content/expansion-one.mjs';
import {isExpansion,getCard,categoryName,expansionAsset} from '../presentation-content.mjs';
import {renderCard,renderGoodsIcon} from '../digital-card-ui.mjs';
import {knownCards,cardKey} from '../game-ui-model.mjs';
import {syncTaskMarkup,renderNativeMaterials,renderMaterialTarget,renderTableActionDraft} from '../table-decision-ui.mjs';
import {resolveTradeMaterials,quoteGoodsTrade,newTradeUsage,receiptPlan,categoryCounts} from '../trade-contract.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count=v=>Object.values(v??{}).reduce((a,b)=>a+b,0),zeros=()=>Object.fromEntries(GOODS.map(g=>[g.id,0]));
const button=(type,label,fields={},disabled=false,className='')=>`<button type="button"${className?` class="${className}"`:''} data-ex-command="${type}" data-ex-fields="${esc(JSON.stringify(fields))}" ${disabled?'disabled':''}>${label}</button>`;
const activeRoles=new Set(['R09','R14','R16','R17','R18','R20','R22','R23','R24']);
const expansionCard=c=>{const f=getCard(c.definitionId);return f.category==='goods'?!!f.recipe&&f.recipe.type!=='fixed':f.sourceCode.startsWith('X');};
const newPending=p=>!!p&&(!p.response&&p.choice&&(p.code?.startsWith('X')||p.kind==='role'||p.choice.kind==='peek-select'));
export function mountExpansionTable({root,send,read,rerender,feedback,available,clearLegacyDraft,isLegacyMaterial=()=>false,inspect}){
  const document=root.ownerDocument,$=id=>document.getElementById(id);
  const work=document.createElement('section');work.id='ex-workbench';work.className='ex-workbench';work.hidden=true;work.setAttribute('aria-labelledby','ex-work-title');$('yg-scene-content').after(work);
  const roles=document.createElement('section');roles.className='ex-role-stage';roles.hidden=true;roles.setAttribute('aria-label','选择本局角色');root.querySelector('.yg-shell').append(roles);
  const dock=document.createElement('button');dock.type='button';dock.className='ex-role-dock';dock.dataset.exCommand='role';dock.dataset.exFields='{}';dock.hidden=true;$('yg-tool-zone').insertBefore(dock,$('yg-tool-zone').firstElementChild??null);
  let room=null,selected=null,direction=null,selection={},params={},choiceId=null,candidate=null,catalogPage=0,scope=null;
  const own=()=>room?.game?.players.find(p=>p.id===room.selfId);
  const usable=()=>available()&&room.phase==='playing'&&room.selfRole==='player';
  const image=role=>`<img class="ex-dock-art" src="${esc(expansionAsset(role.artPath))}" alt="" draggable="false">`;
  const faceOf=()=>selected?.roleId?getRole(selected.roleId):selected?getCard(selected.definitionId):null;
  function reset(){selected=null;direction=null;selection={};params={};}
  function selectedOwned(){if(!selected)return false;return selected.roleId===own()?.roleId||[...(own()?.hand??[]),...(own()?.tools??[])].some(c=>cardKey(c)===cardKey(selected));}
  function renderMarket(){
    $('yg-market').classList.add('ex-market');$('yg-market').innerHTML=`<button type="button" class="ex-market-board" data-hy-action="members" aria-label="查看十二种公共货物及公开商铺">${CATEGORIES.map(c=>`<span class="ex-market-pair"><small>${c.name}</small><span>${GOODS.filter(g=>g.category===c.id).map(g=>`<span class="ex-market-good"><img src="${esc(expansionAsset(g.icon))}" alt=""><span>${g.name}</span><b>${room.game?.bankGoods?.[g.id]??room.hyakkiConfig.goodsPerType}</b></span>`).join('')}</span></span>`).join('')}</button>`;
    $('yg-stock-limit').textContent=`十二种 · 各${room.game?.goodsPerType??room.hyakkiConfig.goodsPerType}件`;
  }
  function roleDock(){const me=own();dock.hidden=!me?.roleId;if(me?.roleId){
    const role=getRole(me.roleId);dock.innerHTML=`${image(role)}<span><strong>${esc(role.name)}</strong><small>${esc(role.compactText)}</small></span>`;
    dock.setAttribute('aria-label',`${role.name}：${role.compactText}，查看能力`);
    }
    for(const node of root.querySelectorAll('#yg-peer [data-public-player]')){
      const p=room.game?.players?.find(p=>p.id===node.dataset.publicPlayer);if(!p?.roleId)continue;const r=getRole(p.roleId);
      const portrait=node.querySelector('.nm-portrait');if(portrait)portrait.src=expansionAsset(r.artPath);
      const seat=node.querySelector('.nm-peer-copy>small');if(seat){
        seat.innerHTML=`<span class="ex-peer-role-name">${room.game.players.indexOf(p)+1}席 · ${esc(r.name)}</span><span class="ex-peer-role-skill">${esc(r.compactText)}</span>`;
        seat.title=`${r.name}：${r.compactText}；点商铺查看完整能力`;
      }
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
  // Reuse the original quantity objects, action draft and material container.
  // Only new recipe validation and command fields remain expansion-owned.
  function materials(model,draft,handle,{canIncreaseGood=()=>true,optionLabel=null}={}){
    return renderNativeMaterials({pending:{choice:{kind:'expansion-materials',options:[]}},game:room.game,selfId:room.selfId,draft,name:id=>room.players.find(p=>p.id===id)?.name??'伙伴',canChoose:usable(),modelOverride:model,canIncreaseGood,optionLabel,
      renderAction:(type,label,fields,disabled,className)=>{const mapped=handle(fields);return button(mapped.type,label,mapped.fields,disabled,className);}});
  }
  // Like the accepted card-draft flow, select visible materials before the one
  // authoritative use command. Random draws and other players' decisions are
  // never predicted here; saved pending choices use the same renderer below.
  function localMaterialChoice(){
    if(!selected||direction||room.game.pending||room.game.stage!=='use')return null;
    const face=faceOf(),code=face.sourceCode,me=own(),bank=room.game.bankGoods;
    let kind,options;
    const stock=goods=>Object.fromEntries(GOODS.map(g=>[g.id,goods[g.id]??0]));
    const discards=category=>room.game.discard.filter(c=>getCard(c.definitionId).category===category).map(cardKey);
    if(/^XC0[1-6]$/u.test(code)){kind='class-procure';options=[{goods:stock(bank),categoryId:CATEGORIES[Number(code.slice(2))-1].id,count:2}];}
    else if(code==='XC08'||code==='R09'){kind=code==='R09'?'role-class-exchange':'class-exchange';options=[{ownGoods:stock(me.goods),bankGoods:stock(bank),...(code==='R09'?{minimum:1,maximum:2}:{count:2})}];}
    else if(code==='XC10'||code==='R14'){kind=code==='R14'?'role-recover-tool':'recover-guard';options=room.game.discard.filter(c=>code==='R14'?getCard(c.definitionId).category==='tool':getCard(c.definitionId).sourceCode==='C07').map(c=>({cardId:cardKey(c)}));}
    else if(code==='XC11'){kind='class-surrender';options=[{goods:stock(me.goods),minimum:1,maximum:3}];}
    else if(code==='R22'){kind='role-reset-tool';options=[{payments:me.hand.map(cardKey),tools:me.tools.filter(c=>c.exhausted).map(cardKey)}];}
    else if(['R18','R20'].includes(code)){kind='role-good';options=GOODS.filter(g=>(code==='R18'?bank:me.goods)[g.id]>0).map(g=>({goodId:g.id}));}
    else if(face.category==='tool'&&me.tools.some(c=>cardKey(c)===cardKey(selected))){
      const number=Number(code.slice(2));
      if(number>=7&&number<=12){kind='tool-class-good';options=GOODS.filter(g=>g.category===CATEGORIES[(number-1)%6].id&&bank[g.id]>0).map(g=>({goodId:g.id}));}
      else if(code==='XT13'){kind='tool-class-exchange';options=GOODS.filter(g=>me.goods[g.id]>0).flatMap(from=>GOODS.filter(to=>bank[to.id]>0&&to.category!==from.category).map(to=>({ownGoodId:from.id,goodId:to.id})));}
      else if(code==='XT14'){kind='tool-goods-card-swap';options=[{payments:me.hand.filter(c=>getCard(c.definitionId).category==='goods').map(cardKey),targets:discards('goods')}];}
    }
    return kind?{code,choice:{kind,options}}:null;
  }
  function goodsPicker(stock,field,{category=null}={}){
    const filtered=Object.fromEntries(GOODS.filter(g=>!category||g.category===category).map(g=>[g.id,stock[g.id]??0]));
    const option=(room.game.pending??localMaterialChoice())?.choice?.options[0],maximum=direction?faceOf().recipe.count:option?.capacity??option?.count??option?.maximum??2;
    return `<div class="hy-material-options hy-material-options--quantities">${materials({type:'goods',stock:filtered,minimum:0,maximum,raw:room.game.pending?.choice?.kind==='retain-goods'},{goods:selection[field]??zeros()},fields=>({type:'amount',fields:{field,id:fields.id,delta:fields.delta}}),{canIncreaseGood:id=>!direction||field!=='goods'||canAddTrade(id)})}</div>`;
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
  function choiceBrowser(label,items){
    return `<div class="hy-material-steps"><section class="hy-material-step"><h3>${esc(label)}</h3><div class="hy-material-options">${items.join('')}</div></section></div>`;
  }
  function cardPicker(label,values,key){
    const options=values.map(cardId=>({cardId})),index=values.indexOf(selection[key]);
    const choices=materials({type:'option',options},{optionIndex:index},fields=>({type:'field',fields:{key,value:values[fields.index]}}));
    return choices?`<section class="hy-material-step"><h3>${esc(label)}</h3><div class="hy-material-options">${choices}</div></section>`:'';
  }
  function selectionPrompt(p){
    const first=p.choice.options[0]??{};
    if(first.tools)return '点下方1张手牌，再点自己横置的道具。';
    if(first.payments)return '点下方货物手牌作费用，再选弃牌区的货物牌。';
    if(first.ownGoods||p.choice.kind==='tool-class-exchange')return '分别选定交出与换入的货物。';
    if(first.goods)return '用货物旁的加减选定数量。';
    const owned=new Set(own().hand.map(cardKey));
    return p.choice.options.length&&p.choice.options.every(value=>owned.has(value.cardId))?'点下方要弃掉的手牌。':'点对应物件选择，确认前可改选。';
  }
  function selectedText(p){return Object.keys(selection).length?selectionSummary():selectionPrompt(p);}
  function pendingBody(p){const first=p.choice.options[0]??{},kind=p.choice.kind;
    if(kind==='retain-goods')return goodsPicker(first.combined,'goods');
    if(first.goods)return goodsPicker(first.goods,'goods',{category:first.categoryId});
    if(first.ownGoods)return `<div class="hy-material-steps"><section class="hy-material-step"><h3>交出</h3>${goodsPicker(first.ownGoods,'give')}</section><section class="hy-material-step"><h3>换入</h3>${goodsPicker(first.bankGoods,'receive')}</section></div>`;
    if(first.tools)return '';
    if(p.choice.kind==='tool-class-exchange'){
      const options=p.choice.options,from=[...new Set(options.map(o=>o.ownGoodId))],to=[...new Set(options.filter(o=>o.ownGoodId===selection.ownGoodId).map(o=>o.goodId))];
      return materials({type:'exchange',own:from,other:to,otherLabel:'换入公库的1件'}, {ownGoodId:selection.ownGoodId,otherGoodId:selection.goodId},fields=>({type:'field',fields:{key:fields.field==='otherGoodId'?'goodId':'ownGoodId',value:fields.id}}));
    }
    if(first.payments)return cardPicker('取弃牌区的货物牌',first.targets,'takeCardId');
    const options=p.choice.options,index=options.findIndex(v=>JSON.stringify(v)===JSON.stringify(selection));
    const choices=materials({type:'option',options},{optionIndex:index},fields=>({type:'option',fields:{index:fields.index}}),{optionLabel:value=>value.branch?value.branch==='silver'?'支付2两':'交回1件货物':null});
    return choices;
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
    const member=id=>room.players.find(p=>p.id===id)?.name??'对手';let content='';
    if(replacement)content='<p class="hy-material-chosen">点下方已装备的道具，选择要替换的一件。</p>';
    else {
      if(targetNeeded)content+=room.game.players.filter(p=>p.id!==room.selfId).map(peer=>renderMaterialTarget({label:`${member(peer.id)} · ${peer.silver}两${peerEligible(code,peer)?'':' · 不符条件'}`,fields:{key:'targetId',value:peer.id},disabled:!can||!peerEligible(code,peer),selected:params.targetId===peer.id,renderAction:(type,label,fields,disabled,className)=>button('param',label,fields,disabled,className)})).join('');
      if(categoryNeeded&&(!targetNeeded||params.targetId)){
        const stock=targetNeeded?room.game.players.find(p=>p.id===params.targetId).goods:room.game.bankGoods;
        content+=choiceBrowser('选择类别',CATEGORIES.map(c=>{const stockCount=GOODS.filter(g=>g.category===c.id).reduce((sum,g)=>sum+stock[g.id],0);return renderMaterialTarget({label:`${c.name} · ${stockCount}件`,fields:{key:'categoryId',value:c.id},disabled:!can||stockCount<(code==='XC07'?2:1),selected:params.categoryId===c.id,renderAction:(type,label,fields,disabled,className)=>button('param',label,fields,disabled,className)});}));
      }
    }
    const ready=replacement?!!params.replaceCardId:(!targetNeeded||!!params.targetId)&&(!categoryNeeded||!!params.categoryId);
    const selected=replacement?params.replaceCardId&&getCard(own().tools.find(c=>cardKey(c)===params.replaceCardId)?.definitionId??face.id).name:[params.targetId&&member(params.targetId),params.categoryId&&categoryName(params.categoryId)].filter(Boolean).join(' · ');
    frame(face,face.name,content,{preview:`<p>${esc(selected||'请选择本次对象')}</p><p>${replacement?'安装免费，确认后替换旧装备':'确认前不消耗行动或银两'}</p>`,actions:button('close','取消')+button(replacement?'install':'use',replacement?'确认安装 · 0行动':`确认使用 · ${role&&code==='R22'?0:1}行动`,{},!ready||!can||role&&room.game.turnUsage.roleUsed)});
  }
  function frame(source,title,body,{preview='',actions=''}){
    work.hidden=true;
    const material=$('hy-task-materials');material.hidden=!body;
    material.classList.add('hy-object-selection','hy-object-expanded','hy-grouped-selection','hy-expansion-materials');
    material.classList.toggle('hy-card-selection',body.includes('hy-material-card'));
    $('hy-task-material-title').textContent=title+' · 选择本次材料';$('hy-material-rechoose').hidden=true;
    syncTaskMarkup($('hy-task-material-cards'),`<div class="hy-material-steps">${body}</div>`,true);root.querySelector('.yg-lower').classList.toggle('hy-has-materials',!!body);
    syncTaskMarkup($('yg-scene-content'),renderTableActionDraft({source:button('read',renderCard({definitionId:source.id},{interactive:false}),{definitionId:source.id},false,'hy-source-reader'),heading:esc(title),secondary:button('read','牌文',{definitionId:source.id}),description:`<p class="hy-decision-summary">${esc(source.summary??source.compactText??'')}</p>${preview}`,actions}),true);
  }
  function renderSelected(){const face=faceOf();if(!face)return;
    const me=own(),can=usable()&&room.game.turnPlayerId===room.selfId&&!room.game.pending&&room.game.stage==='use';
    const role=!!selected.roleId,isTool=face.category==='tool',installed=isTool&&me.tools.some(c=>cardKey(c)===cardKey(selected));
    if(direction){let quote=null,error='';try{quote=tradeQuote();}catch(e){error=e.message;}
      const recipe=face.recipe??{type:'fixed',goods:face.goods,count:count(face.goods)},fixed=recipe.type==='fixed';
      frame(face,`${face.name} · ${direction==='buy'?'买入':'卖出'}`,`${goodsPicker(direction==='buy'?room.game.bankGoods:me.goods,'goods',{category:recipe.type==='class'?recipe.category:null})}`,
        {preview:`<p>已选${count(selection.goods)}/${recipe.count}：${esc(named(selection.goods))}</p>${quote?`<p>印价${quote.printedPrice}${quote.bookLayers?' · 书算'+quote.bookLayers+'层':''}${quote.roleAdjustment?' · 角色'+quote.roleAdjustment:''}${quote.buyTax?' · 税'+quote.buyTax:''}${quote.temporaryFee?' · 临时格'+quote.temporaryFee:''} · ${direction==='buy'?'应付':'取得'}${direction==='buy'?quote.totalPayment:quote.saleProceeds}两</p>`:`<p>${esc(count(selection.goods)<recipe.count?'再选'+(recipe.count-count(selection.goods))+'件货物':error)}</p>`}`,actions:button('undo','撤1件',{},!count(selection.goods))+button('back','返回')+button('trade-confirm',`确认${direction==='buy'?'买入':'卖出'}`,{},!quote||!can)});return;}
    const replacement=isTool&&!installed&&me.tools.length>=3;
    if(room.game.stage==='use'&&(needsTarget(face.sourceCode)||needsCategory(face.sourceCode)||replacement)){
      parameterTray(face,{replacement,can,role});return;
    }
    const draft=localMaterialChoice();
    if(draft&&(!role||!room.game.turnUsage.roleUsed)){
      const usableTool=!installed||!selected.exhausted;
      frame(face,face.name,pendingBody(draft),{preview:`<p>${selectedText(draft)}</p><p>确认前不消耗行动或银两；可点物件改选。</p>`,actions:button('close','取消')+button('use',`${role?'发动角色':isTool?'使用道具':'确认使用'} · ${role&&face.sourceCode==='R22'?0:1}行动`,{},!can||!usableTool||!pendingReady(draft))});return;
    }
    const actions=room.game.stage==='draw'?button('start-use',!room.game.drawStarted?'先摸第一张 · 1行动':'进入用牌',{},!usable()):face.category==='goods'?button('trade','买入',{direction:'buy'},!can)+button('trade','卖出',{direction:'sell'},!can)
      :role?activeRoles.has(face.sourceCode)?button('use',`发动角色 · ${face.sourceCode==='R22'?0:1}行动`,{},!can||room.game.turnUsage.roleUsed):''
      :isTool&&!installed?button('install','安装 · 0行动',{},!can):button('use',`${isTool?'使用道具':'确认使用'} · 1行动`,{},!can||installed&&selected.exhausted);
    syncTaskMarkup($('yg-scene-content'),renderTableActionDraft({source:button('read',renderCard({definitionId:face.id},{interactive:false}),{definitionId:face.id},false,'hy-source-reader'),heading:esc(face.name),secondary:button('read','牌文',{definitionId:face.id}),description:`<p class="hy-decision-summary">${esc(face.summary??face.compactText??'')}</p>`,actions:actions+button('close','取消')}),true);
  }
  // Synchronize draft ownership before the parent decides whether to keep its
  // task DOM. Installed tools survive settlement, so ownership alone is not a
  // completion signal; the authoritative exhausted transition is.
  function syncView(next){
    room=next;
    const nowScope=`${room.roomId}:${room.matchId}`;
    if(scope!==nowScope){reset();candidate=null;choiceId=null;scope=nowScope;}
    if(selected&&!selectedOwned())reset();
    const tool=selected&&!selected.roleId?own()?.tools?.find(c=>cardKey(c)===cardKey(selected)):null;
    if(tool?.exhausted&&!selected.exhausted)reset();
    else if(tool)selected=tool;
    if(params.replaceCardId&&!own()?.tools?.some(c=>cardKey(c)===params.replaceCardId))delete params.replaceCardId;
  }
  function render(next){syncView(next);$('hy-task-materials').classList.remove('hy-expansion-materials','hy-card-selection');const expansion=isExpansion(room.game??room.hyakkiConfig);root.classList.toggle('ex-preview',expansion);if(expansion){$('yg-catalog').dataset.exCommand='catalog';$('yg-catalog').textContent='查看102种牌与24角色';}else {delete $('yg-catalog').dataset.exCommand;$('yg-catalog').textContent='查看完整51种卡牌';}if(!expansion){work.hidden=true;roles.hidden=true;dock.hidden=true;root.classList.remove('ex-working');delete root.dataset.exScene;return;}
    renderMarket();roleDock();if(room.game?.kind==='hyakki-opening-game'){renderOpening();return;}
    roles.hidden=true;delete root.dataset.exScene;root.querySelector('.yg-playfield').inert=false;
    work.hidden=true;root.classList.remove('ex-working');$('hy-task-materials').classList.remove('hy-expansion-materials');
    const p=room.game?.pending;
    if(newPending(p)){
      if(choiceId!==p.choice.id){choiceId=p.choice.id;selection=p.choice.kind==='retain-goods'?{goods:{...p.choice.defaultSelection}}:{};}
      const source=p.sourceRole?getRole(p.sourceRole.roleId):getCard(p.sourceCards[0]?.definitionId??`yousei.${p.code.toLowerCase()}`);
      const mine=p.actorId===room.selfId,receipt=p.choice.kind==='retain-goods',capacity=p.choice.options?.[0]?.capacity;
      frame(source,receipt?mine?`选择保留的货物 · 最多${capacity}件`:'等待保留货物':source.name,mine?pendingBody(p):`<p>等待${esc(room.players.find(m=>m.id===p.actorId)?.name??'伙伴')}完成选择。</p>`,
        {preview:mine?`<p>${receipt?`保留${count(selection.goods)}/${capacity}件：`:''}${selectedText(p)}</p><p>${receipt?`临时格费${count(selection.goods)>p.choice.options[0].ordinaryCapacity?p.choice.options[0].temporaryFee:0}两 · `:''}本步不再消耗行动</p>`:'',actions:mine?button('undo','撤1项',{},!usable())+button('pending-confirm','确认选择',{},!usable()||!pendingReady(p)):''});
      syncPhysicalSelection();return;
    }
    choiceId=null;if(!p&&selected)renderSelected();
    if(!p&&selected)syncPhysicalSelection();
    const me=own();if(me?.roleId==='yousei.role.r15'&&room.game.stage==='draw'&&!room.game.drawStarted&&!p&&room.game.turnPlayerId===room.selfId){$('yg-scene-content').insertAdjacentHTML('beforeend',button('inspect','鉴牌：付1两，先看2张',{},!usable()||me.silver<1||room.game.deckCount+room.game.discard.length<2));}
  }
  // Private hand ids and public equipped-card refs are aliases of the same
  // physical object. Submit the reference supplied by this choice, not a new id.
  function physicalMatches(candidateId,physicalId){return candidateId===physicalId||own()?.tools.some(card=>cardKey(card)===physicalId&&card.ref===candidateId);}
  function syncPhysicalSelection(){
    const p=room.game.pending??localMaterialChoice(),first=p?.choice?.options?.[0]??{},values=Object.values(selection);
    for(const node of root.querySelectorAll('#yg-hand [data-entity-id],#yg-tools [data-tool-id]')){
      const id=node.dataset.entityId??node.dataset.toolId,chosen=values.some(value=>physicalMatches(value,id))||params.replaceCardId===id||!p&&selected&&!selected.roleId&&cardKey(selected)===id;
      const candidates=first.tools?[...first.payments,...first.tools]:first.payments?first.payments:p?.choice?.options?.flatMap(option=>option.cardId?[option.cardId]:[])??[];
      node.classList.toggle('is-selected',chosen);node.classList.toggle('is-task-material',candidates.some(value=>physicalMatches(value,id)));
      (node.matches('button')?node:node.querySelector('button'))?.setAttribute('aria-pressed',String(chosen));
    }
  }
  function event(event){
    if(!room||!isExpansion(room.game??room.hyakkiConfig))return;
    const command=event.target.closest('[data-ex-command]'),hand=event.target.closest('#yg-hand [data-entity-id]'),tool=event.target.closest('#yg-tools [data-tool-id]');
    let intercept=!!command;
    const physicalId=hand?.dataset.entityId??tool?.dataset.toolId,pending=room.game.pending,materialChoice=pending??localMaterialChoice();
    if(physicalId&&materialChoice&&(!pending||newPending(pending)&&pending.actorId===room.selfId)&&usable()){
      const first=materialChoice.choice.options[0]??{};let key=null,value=null;
      if(first.tools){const payment=hand&&first.payments.find(id=>physicalMatches(id,physicalId)),resetTool=tool&&first.tools.find(id=>physicalMatches(id,physicalId));key=payment?'cardId':resetTool?'toolCardId':null;value=payment||resetTool;}
      else if(first.payments&&hand){value=first.payments.find(id=>physicalMatches(id,physicalId));if(value)key='payCardId';}
      else {const option=materialChoice.choice.options.find(o=>physicalMatches(o.cardId,physicalId));if(option){event.preventDefault();event.stopImmediatePropagation();selection=structuredClone(option);rerender();return;}}
      if(key){event.preventDefault();event.stopImmediatePropagation();selection[key]=value;rerender();return;}
    }
    if(tool&&selected&&!pending&&faceOf()?.category==='tool'&&!own().tools.some(c=>cardKey(c)===cardKey(selected))&&own().tools.length>=3){event.preventDefault();event.stopImmediatePropagation();params.replaceCardId=physicalId;rerender();return;}
    // The active original draft owns its legal materials, including expansion
    // receipts. Let its existing hand/tool handler select rather than play them.
    if(physicalId&&isLegacyMaterial(physicalId))return;
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
    else if(type==='trade'){direction=fields.direction;const f=faceOf();selection={goods:f.recipe?.type==='fixed'?{...f.recipe.goods}:zeros()};}
    else if(type==='undo')undoSelection();
    else if(type==='amount'){selection[fields.field]??=zeros();selection[fields.field][fields.id]=Math.max(0,selection[fields.field][fields.id]+fields.delta);}
    else if(type==='option')selection=structuredClone((room.game.pending??localMaterialChoice()).choice.options[fields.index]);
    else if(type==='field'){if(fields.key==='ownGoodId'&&selection.ownGoodId!==fields.value)delete selection.goodId;selection[fields.key]=fields.value;}
    else if(type==='param'){if(fields.key==='targetId'&&params.targetId!==fields.value)delete params.categoryId;params[fields.key]=fields.value;}
    else if(type==='param-back'){delete params.targetId;delete params.categoryId;}
    else if(type==='pending-confirm')return send('choose-effect',{selection:room.game.pending.choice.kind==='retain-goods'?selection.goods:selection});
    else if(type==='trade-confirm')return send(direction,{cardId:cardKey(selected),materials:selection.goods});
    else if(type==='inspect')return send('peek',{inspect:true});
    else if(type==='start-use')return send(room.game.drawStarted?'finish-draw':'peek');
    else if(type==='install'){if(own().tools.length>=3&&!params.replaceCardId)return feedback('请选择要替换的装备。');return send('install-tool',{cardId:cardKey(selected),...(params.replaceCardId?{replaceCardId:params.replaceCardId}:{})});}
    else if(type==='use'){const f=faceOf();if((/^XM|^R2[34]$/u.test(f.sourceCode))&&!params.targetId)return feedback('请先选择一名对手。');if(['XC07','XM05','XM06','R17'].includes(f.sourceCode)&&!params.categoryId)return feedback('请先选择类别。');
      const chosen=localMaterialChoice()?{...params,...selection}:params;
      return send(selected.roleId?'use-role':own().tools.some(t=>cardKey(t)===cardKey(selected))?'activate-tool':'play-character',selected.roleId?{params:chosen}:{cardId:cardKey(selected),params:chosen});}
    rerender();
  }
  const onResize=()=>{if(room&&isExpansion(room.game??room.hyakkiConfig))render(room);};
  document.defaultView.addEventListener('resize',onResize);
  root.addEventListener('click',event,true);
  return {syncView,render,hasDraft:()=>!!selected&&selectedOwned(),handlesPending:newPending,select(card){if(!room||!isExpansion(room.game)||!expansionCard(card))return false;clearLegacyDraft();reset();selected=card;rerender();return true;},destroy(){document.defaultView.removeEventListener('resize',onResize);room=null;root.removeEventListener('click',event,true);work.remove();roles.remove();dock.remove();}};
}
