import { mountMarketMotion } from './night-market-motion.mjs';
import { GOODS, getCard } from './presentation-content.mjs';
import { assetPath } from './content/manifest.mjs';
import { renderGoodsIcon } from './digital-card-ui.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const colours = ['#587f62','#8c5b55','#626b8b','#a78350','#698880','#805c77'];
const portraits = ['c01','c03','m04','c10','c09','m06'];
const face = tool => getCard(tool.definitionId ?? tool.id);
// Presentation envelope contract: matching named breakpoints in night-market.css.
const AUCTION_FOCUS_MAX_WIDTH=1150,AUCTION_FOCUS_MAX_HEIGHT=620;

/** Keep the physical six-position home board separate from permanent +3 boards.
 * Goods still use the authority's ordinary-first allocation; no placement here
 * can buy capacity, occupy the temporary position or charge a player. */
export function renderStallStock(player) {
  const occupied = player.goods.flatMap(good => Array(good.count).fill(good.id));
  const warehouse = player.roleId === 'yousei.role.r10';
  const baseCapacity = warehouse ? 6 : 5;
  const stallCount = player.stallCount ?? Math.floor((player.ordinaryCapacity - baseCapacity) / 3);
  const slot = (goodId, index, temporary = false) => {
    const name = GOODS.find(good => good.id === goodId)?.name;
    const fee = temporary ? player.temporaryOccupied ? '已付2两' : '新占用2两' : '';
    const label = `${temporary ? '第6格，临时格，' + fee : '普通格' + (index + 1)}：${name ?? '空'}`;
    return `<span class="nm-stock-slot${goodId ? ' yg-owned-good' : ' is-empty'}${temporary ? ' is-temporary' : ''}" data-good-id="${goodId ?? ''}" data-stock-kind="${temporary ? 'temporary' : 'ordinary'}" ${name ? `title="${esc(name)}"` : ''} aria-label="${esc(label)}">${goodId ? renderGoodsIcon(goodId) : `<i aria-hidden="true">${temporary ? '空' : '＋'}</i>`}<small>${temporary ? '临时' : index + 1}</small></span>`;
  };
  const board = (label, slots, kind) => `<span class="nm-stall-board ${kind}" aria-label="${label}"><span class="nm-stall-caption">${label}</span><span class="nm-stall-grid">${slots}</span></span>`;
  const base = board('主摊', Array.from({length:5}, (_, i) => slot(occupied[i], i)).join('')
    + slot(occupied[player.ordinaryCapacity], 5, true), 'nm-base-stall');
  const expansions = Array.from({length:stallCount}, (_, boardIndex) => {
    const offset = baseCapacity + boardIndex * 3;
    return board(`扩摊${boardIndex + 1}${stallCount > 1 ? ' ↔' : ''}`, Array.from({length:3}, (_, i) => slot(occupied[offset + i], offset + i)).join(''), 'nm-expansion-stall');
  }).join('');
  const locked = board('扩摊 · 未解锁', Array.from({length:3}, () => '<span class="nm-stock-slot is-locked" aria-label="未解锁扩摊位，使用摊位许可证解锁"><i aria-hidden="true">锁</i></span>').join(''), 'nm-expansion-stall is-locked');
  const extra=warehouse?board('仓栈',slot(occupied[5],5),'nm-warehouse-stall'):'';
  const expansionStrip=`<span class="nm-stall-expansions" aria-label="永久扩摊">${expansions || locked}</span>`;
  // The role's one slot shares the existing lower row; it must not inherit a
  // horizontal page's 100% flex basis in the stock owner's vertical column.
  return base + (warehouse?`<span class="nm-warehouse-row">${extra}${expansionStrip}</span>`:expansionStrip);
}

/** Presentation only: real role-filtered views and the existing UI's event IDs. */
export function mountNightMarket({root}) {
  const document = root.ownerDocument, window = document.defaultView, $ = id => document.getElementById(id);
  let disposed = false;
  // Game gestures must not zoom the browser; local hand and dialog scrolling stay native.
  const gestureZoom = event => event.preventDefault();
  const wheelZoom = event => { if (event.ctrlKey) event.preventDefault(); };
  root.addEventListener('gesturestart', gestureZoom, {passive:false});
  root.addEventListener('gesturechange', gestureZoom, {passive:false});
  root.addEventListener('wheel', wheelZoom, {passive:false});
  document.body.classList.add('night-market-body'); root.classList.add('hy-night');
  const playfield = $('yg-playfield'), table = root.querySelector('.yg-table');
  const shop = document.createElement('section'); shop.className = 'nm-own-shop'; shop.setAttribute('aria-label','我的铺面与道具');
  shop.append($('yg-personal'));
  // One physical public wing; display:contents preserves the accepted large-screen grid.
  const publicZone=document.createElement('aside');publicZone.className='nm-public-zone';publicZone.setAttribute('aria-label','公共货物与牌堆');
  publicZone.append($('yg-public-stock'),root.querySelector('.yg-piles'));table.append(publicZone);
  root.querySelector('.yg-storage').remove();
  playfield.insertBefore($('yg-peer'),playfield.firstElementChild);
  const selfZone = document.createElement('section'); selfZone.className = 'nm-self-zone'; selfZone.setAttribute('aria-label','我的装备、手牌与摊位');
  selfZone.append($('yg-tool-zone'),$('yg-hand-section'),shop); table.after(selfZone);
  const ribbon=document.createElement('div'); ribbon.className='nm-action-ribbon';
  ribbon.append(root.querySelector('.yg-stage'),$('yg-track'));
  root.querySelector('.yg-centre').insertBefore(ribbon,$('yg-scene-content'));
  const header=root.querySelector('.yg-header');
  const roomLabel=$('yg-room-code');roomLabel.classList.add('nm-room-label');
  header.insertBefore(roomLabel,root.querySelector('.room-toolbar'));
  header.insertBefore(root.querySelector('.yg-time'),root.querySelector('.room-toolbar'));
  const hand = $('yg-hand-section');
  hand.insertAdjacentHTML('beforeend','<div id="nm-turn-actions" class="nm-turn-actions"></div>');
  root.querySelector('.yg-brand').insertAdjacentHTML('afterbegin','<i class="nm-brand-seal" aria-hidden="true">幽</i>');
  $('yg-shop-detail').querySelector('strong').remove();
  $('yg-shop-detail').setAttribute('aria-label','查看我的货物与公开商铺');
  // Money belongs to the right-hand stall. Equipment and the centre hand keep
  // their own fixed near-edge anchors when the stall gains expansion boards.
  const shopControls = document.createElement('div'); shopControls.className = 'nm-shop-controls';
  shopControls.append($('yg-shop-detail').querySelector('.yg-personal-heading'));
  shop.insertBefore(shopControls,shop.firstElementChild);
  shop.append($('yg-shop-note'));
  $('yg-exit').setAttribute('aria-label','离开夜市');
  $('yg-public-stock').querySelector('strong').textContent = '公共货栈';
  const toolbar = root.querySelector('.room-toolbar-actions');
  const members = document.createElement('button'); members.type = 'button'; members.dataset.hyAction = 'members'; members.className = 'nm-header-members'; members.setAttribute('aria-label','全部商铺');
  members.innerHTML = '<span class="nm-header-full">全部商铺</span><span class="nm-header-short" aria-hidden="true">商铺</span>';
  const history = document.createElement('button'); history.type = 'button'; history.dataset.hyAction = 'history'; history.className = 'nm-header-history'; history.textContent = '战况';
  const phoneHeader=window.matchMedia('(max-width:1150px) and (max-height:500px) and (orientation:landscape)');
  function syncPhoneHeader(){
    const peers=$('yg-peer');
    if(phoneHeader.matches){if(peers.parentElement!==header)header.insertBefore(peers,root.querySelector('.room-toolbar'));}
    else if(peers.parentElement!==playfield)playfield.insertBefore(peers,playfield.firstElementChild);
  }
  function syncHeader() {
    if(disposed)return;
    syncPhoneHeader();
    // The shared voice owner may prepend its group later. Reorder these same
    // controls instead of cloning event targets or introducing another history.
    if (toolbar.firstElementChild !== members || members.nextSibling !== history) {
      toolbar.insertBefore(history,toolbar.firstElementChild); toolbar.insertBefore(members,toolbar.firstElementChild);
    }
    root.style.setProperty('--nm-header-bottom',header.getBoundingClientRect().bottom+'px');
  }
  syncHeader();
  const toolbarObserver = new window.MutationObserver(syncHeader); toolbarObserver.observe(toolbar,{childList:true});
  const headerObserver = new window.ResizeObserver(syncHeader); headerObserver.observe(header);
  const removers = [];
  function listen(node,type,handler,options) { node.addEventListener(type,handler,options);removers.push(()=>node.removeEventListener(type,handler,options)); }
  let browse = null;
  function syncAuction() {
    if(disposed)return;
    const auction = root.querySelector('.hy-table-work[data-step-kind="auction"]');
    const width=window.visualViewport?.width??window.innerWidth,height=window.visualViewport?.height??window.innerHeight;
    // Source + readable bid form + three physical lots need a dedicated task
    // envelope when the surrounding piles/public stock consume tablet width.
    const phoneTable=width<=1150&&height<=500&&width>height;
    const focused=!phoneTable&&!!auction&&root.dataset.phase!=='waiting'&&width>height&&(height<=AUCTION_FOCUS_MAX_HEIGHT||width<=AUCTION_FOCUS_MAX_WIDTH);
    root.classList.toggle('nm-auction-focus',focused);
    for (const node of [selfZone,$('yg-peer'),root.querySelector('.yg-piles'),$('yg-public-stock')]) node.inert=focused;
    if (!auction) { if(browse)browse.controls.hidden=true;return; }
    const row=$('hy-task-material-cards'),heading=$('hy-task-materials')?.querySelector('.yg-hand-heading');
    if(!row||!heading)return;
    if(!browse){
      const controls=document.createElement('span');controls.className='nm-auction-browse';
      const previous=document.createElement('button');previous.type='button';previous.textContent='‹';previous.setAttribute('aria-label','查看上一张拍品');
      const position=document.createElement('span');position.setAttribute('aria-live','polite');
      const next=document.createElement('button');next.type='button';next.textContent='›';next.setAttribute('aria-label','查看下一张拍品');
      controls.append(previous,position,next);heading.append(controls);row.tabIndex=0;
      function update(){
        if(disposed)return;
        const cards=[...row.querySelectorAll('[data-auction-card-index]')],box=row.getBoundingClientRect();
        const visible=cards.map((card,index)=>({index,rect:card.getBoundingClientRect()})).filter(({rect})=>rect.left>=box.left-1&&rect.right<=box.right+1).map(({index})=>index);
        const first=visible[0]??0,last=visible.at(-1)??first;
        position.textContent=cards.length?`${first+1}${last>first?'–'+(last+1):''}/${cards.length}`:'';
        const max=Math.max(0,row.scrollWidth-row.clientWidth);previous.disabled=row.scrollLeft<=1;next.disabled=row.scrollLeft>=max-1;
      }
      function move(direction){
        if(disposed)return;
        const cards=[...row.querySelectorAll('[data-auction-card-index]')],box=row.getBoundingClientRect();if(!cards.length)return;
        const start=cards.findIndex(card=>card.getBoundingClientRect().left>=box.left-1);
        const index=Math.max(0,Math.min(cards.length-1,(start<0?cards.length-1:start)+direction));
        const left=row.scrollLeft+cards[index].getBoundingClientRect().left-box.left;
        if(row.scrollTo)row.scrollTo({left,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});else row.scrollLeft=left;
        update();
      }
      listen(previous,'click',()=>move(-1));listen(next,'click',()=>move(1));listen(row,'scroll',update,{passive:true});
      listen(row,'keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();move(event.key==='ArrowRight'?1:-1);}});
      browse={controls,update};
    }
    const cards=row.querySelectorAll('[data-auction-card-index]');browse.controls.hidden=cards.length<2;
    row.setAttribute('aria-label',cards.length?`${cards.length}张整组拍品，左右方向键浏览`:'整组拍卖货物');
    browse.update();
  }
  listen(window,'resize',()=>{syncHeader();syncAuction();});
  const economy=mountMarketMotion({root});
  $('yg-rotation').querySelector('h2').textContent='请横屏，展开夜市牌桌';
  $('yg-rotation').querySelector('p').textContent='桌游使用横屏。聊天、设置和退出仍在上方；转屏后继续原对局。';
  const cache = new Map();
  function markup(node, html) {
    if (cache.get(node)?.html === html && cache.get(node)?.first === node.firstElementChild) return;
    const scroll = node.scrollLeft;
    const expansionScroll = node.querySelector('.nm-stall-expansions')?.scrollLeft ?? 0;
    node.innerHTML = html; node.scrollLeft = scroll;
    const expansions = node.querySelector('.nm-stall-expansions');
    if (expansions) expansions.scrollLeft = expansionScroll;
    cache.set(node, {html,first:node.firstElementChild});
  }
  function render(view) {
    if(disposed)return;
    root.dataset.phase = view.phase;
    history.disabled = view.phase === 'waiting';
    const peers = view.selfRole === 'player' ? view.players.filter(p=>p.id!==view.selfId) : view.players;
    const peerNode = $('yg-peer'); peerNode.dataset.playerCount = peers.length;
    markup(peerNode, peers.map((player,peerIndex)=>{
      const index = view.players.indexOf(player), active = (view.decisionActorId ?? view.currentPlayerId) === player.id;
      return `<article class="nm-merchant${active?' is-current':''}${player.id==='empty-seat'?' is-empty':''}" data-public-player="${esc(player.id)}" style="--shop-color:${colours[index%6]}">
        <button type="button" class="nm-merchant-overview" data-player="${esc(player.id)}" aria-label="查看第${index+1}席${esc(player.name)}的公开商铺，${player.silver}两，手牌${player.handCount}张">
          <img class="nm-portrait" src="${assetPath(portraits[index%6])}" alt="" draggable="false"><span class="nm-peer-copy"><strong title="${esc(player.name)}">${esc(player.name)}</strong><b class="nm-money">${player.silver}<small>两</small></b><small>${index+1}席${active?view.decisionActorId?' · 决定中':' · 正在经营':''}${view.closing?.finalPlayerId===player.id?' · 末回合':''}</small><span class="nm-hand-count">▱ ${player.handCount}${player.goods.length===12?`<span class="ex-peer-index">${peerIndex+1}/${peers.length}</span>`:''}</span></span>
        </button>
        <div class="nm-peer-goods" data-goods-count="${player.goods.length}" role="group" aria-label="${player.goods.length}种货物，空间不足时左右滑动查看">${GOODS.filter(good=>player.goods.some(g=>g.id===good.id)).map(good=>{const count=player.goods.find(g=>g.id===good.id)?.count??0;return `<span class="nm-mini-good${count?'':' is-zero'}" data-good-id="${good.id}" title="${good.name}${count}件">${renderGoodsIcon(good.id)}<b>${count}</b></span>`;}).join('')}${player.goods.length===12&&player.goods.every(g=>!g.count)?'<small class="ex-peer-empty">暂无货物</small>':''}</div>
        <div class="nm-peer-tools" aria-label="${esc(player.name)}的已装道具">${player.tools.length?player.tools.map(tool=>`<button type="button" data-detail-id="${face(tool).id}" class="${tool.tapped?'is-tapped':''}" aria-label="${esc(face(tool).name)}，${tool.tapped?'已用':'可用'}，阅读牌文">${esc(face(tool).name)}${tool.tapped?' ↷':''}</button>${player.goods.length===12?`<span class="ex-peer-tool-label${tool.tapped?' is-tapped':''}" title="${esc(face(tool).name)}，${tool.tapped?'已用':'可用'}">${esc(face(tool).name)}${tool.tapped?' ↷':''}</span>`:''}`).join(''):'<small>尚未装备</small>'}${view.currentPlayerId===player.id&&view.bookLayers?`<small>书算${view.bookLayers}层</small>`:''}</div>
      </article>`;
    }).join(''));
    const self = view.selfRole === 'player' && view.players.find(p=>p.id===view.selfId);
    shop.hidden = !self; selfZone.hidden = !self;
    if (self) {
      markup($('yg-stock-slots'), renderStallStock(self));
      const count = self.goods.reduce((sum, good) => sum + good.count, 0);
      const expansions = self.stallCount ?? Math.floor((self.ordinaryCapacity - (self.roleId==='yousei.role.r10'?6:5)) / 3);
      $('yg-shop-note').textContent = `普通${Math.min(count, self.ordinaryCapacity)}/${self.ordinaryCapacity} · 临时格${self.temporaryOccupied ? '已占用，已付2两' : '空闲，每次2两'}${expansions > 1 ? ` · ${expansions}块扩摊可横滑 →` : ''}`;
      shop.dataset.silver = self.silver; shop.dataset.capacity = self.ordinaryCapacity;
    }
    $('yg-hand').classList.toggle('nm-crowded',view.hand.length>8);
    [...$('yg-hand').children].forEach((node,index)=>{
      node.style.setProperty('--nm-tilt',Math.max(-2,Math.min(2,(index-(view.hand.length-1)/2)*.45))+'deg');
      node.style.setProperty('--nm-z',index+1);
    });
    if(view.phase==='waiting')syncAuction();
    // The real page can render additional pending materials after this call.
    // End-turn controls are moved only after its full task markup is complete.
  }
  function syncActions() {
    if(disposed)return;
    syncHeader();syncAuction();
    const destination=$('nm-turn-actions');
    destination.replaceChildren();
    const end = root.querySelector('#yg-scene-content [data-hy-action="end-turn"]');
    if (end) { destination.append(end); end.classList.add('nm-end-turn'); }
    root.classList.toggle('nm-has-end-turn',!!end);
  }
  return {render,syncActions,capture:economy.capture,present:economy.present,cancel:economy.cancel,destroy(){if(disposed)return;disposed=true;economy.destroy();cache.clear();toolbarObserver.disconnect();headerObserver.disconnect();removers.forEach(remove=>remove());root.classList.remove('nm-auction-focus');root.style.removeProperty('--nm-header-bottom');root.removeEventListener('gesturestart',gestureZoom);root.removeEventListener('gesturechange',gestureZoom);root.removeEventListener('wheel',wheelZoom);document.body.classList.remove('night-market-body');}};
}
