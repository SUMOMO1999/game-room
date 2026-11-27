import { ui, game, _status } from './native.mjs';
import {
  tag,
  action,
  printCard,
  makeSeats,
  paintSeat,
  paintEquipment,
  handCards,
  showPublicPlay,
  nativeInputs,
  decisionSurface
} from './pieces.mjs';
import { merchantDecision, targetCommands, equipmentCommands, supplyCommands, orderCommands } from './merchant-choices.mjs';
import { market, publicMarket, opponentPager, opponentStall, seatDetails, bins } from './stock.mjs';
import { saleMaterials, paintSaleMaterials, pickSalePiece } from './sale-materials.mjs';
import { practiceBook, editionName, allModules } from './practice-book.mjs';
import { getCard, getRole } from '../presentation-content.mjs';
import { cardKey } from '../game-ui-model.mjs';
function nav(key, label, handler, right = false) {
  const el = ui.create.system(label, handler, right);
  el.dataset.nav = key;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.onkeydown = (e) => {
    if (['Enter', ' '].includes(e.key)) {
      e.preventDefault();
      el.click();
    }
  };
  return el;
}
export function mountMerchantDesk({ root, practice, dispatch, openRoute, resetDraft, publicEventText, readyOrders, inOrderDraft, saleDraft, inspectDiscard, invite, showMembers, showTurnOrder }) {
  const by = (id) => document.getElementById(id);
  const local = (selector) => root.querySelector(selector);
  const native = decisionSurface();
  const events = new AbortController();
  const listen = (node, type, handler, options = {}) =>
    node.addEventListener(type, handler, { ...options, signal: events.signal });
  nativeInputs();
  let room,
    flags,
    seats,
    panel = null,
    chosenRole,
    amount,
    previousScope,
    sessionScope,
    lastSequence,
    receiptText = '';
  const g = () => room?.game;
  const mine = () => g()?.players.find((p) => p.id === room.selfId);
  const name = (id) => room?.players.find((p) => p.id === id)?.name ?? '商人';
  const ownTurn = () => g()?.turnPlayerId === room.selfId && !g().pending && room.phase === 'playing';
  const usable = () => flags?.available && !flags.pendingRequest;
  const canStartTrade = () => room?.selfRole === 'player' && usable() && room.phase === 'playing' && !g()?.pending && !flags.draft && !flags.routeTask;
  const configuration = () => g()?.configuration ?? g()?.opening?.configuration ?? room?.hyakkiConfig;
  const openPracticeSetup = () => local('button[data-hy-action="practice-restart"]')?.click();
  function chooseFullSetup() {
    openPracticeSetup();
    // The existing setup owns the confirmation and any replacement of a saved game.
    for (const [id, value] of [['hy-practice-pack', 'trade-routes-v1'], ['hy-practice-variant', 'all']]) {
      const select = by(id);
      if (select && [...select.options].some((item) => item.value === value)) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
  const book = practiceBook(root, practice ? chooseFullSetup : null);
  function openBook() {
    if (room) book.open(configuration());
  }
  let fullEntry = practice && new URL(location.href).searchParams.get('practice') === 'full';
  listen(by('yg-hand-filter'), 'change', () => queueMicrotask(draw));
  function send(type, fields = {}) {
    if (usable()) return dispatch(type, fields);
  }
  function close() {
    panel = null;
    draw();
  }
  function route(kind, ref) {
    panel = null;
    openRoute(kind, ref);
    draw();
  }
  function open(kind, id) {
    panel = { kind, id };
    draw();
  }
  function read(id) {
    if (id) {
      panel = { kind: 'read', id, back: panel?.kind === 'read' ? panel.back : panel };
      draw();
    }
  }
  function sourceCard(id) {
    return local('#yg-hand [data-entity-id="' + CSS.escape(id) + '"]');
  }
  function pickCard(id) {
    if (!usable()) return;
    panel = null;
    const node = sourceCard(id);
    (node?.querySelector('button') ?? node)?.click();
  }
  let targetTools = new Map();
  function sourceTool(card, own) {
    if (own) return local('#yg-tools [data-tool-id="' + CSS.escape(cardKey(card)) + '"]');
    return targetTools.get(card.ref);
  }
  function tool(card, own) {
    const source = usable() && sourceTool(card, own);
    if (source && !source.disabled && (!own || source.classList.contains('is-task-material') ||
        (ownTurn() && (!card.exhausted || flags.draft)))) {
      panel = null;
      source.click();
    } else read(card.definitionId);
  }
  let supplySources = new Map();
  let orderSources = new Map();
  let availableOrders = new Map();
  let deliverable = new Set(), saleHint = null;
  const orderSpace = matchMedia('(min-width: 651px) and (min-height: 651px)');
  listen(orderSpace, 'change', draw);
  // The public slips and the enlarged list must act on the same live card or tool.
  const orderInput = {
    enabled(order) {
      const source = availableOrders.get(order.position);
      return source ? !source.disabled : canStartTrade() || (usable() && inOrderDraft());
    },
    pick(order) {
      const live = g()?.publicOrders?.orders.find(item => item.position === order.position);
      if (!live || live.generation !== order.generation || live.id !== order.id || !orderInput.enabled(order)) return;
      const source = availableOrders.get(order.position);
      if (source) {
        panel = null;
        source.click();
      } else route('orders', order);
    }
  };
  const supply = publicMarket((id) => supplySources.get(id)?.click(), route, () => open('orders'), orderInput);
  const peerPager = opponentPager();
  ui.arena.append(supply.node, peerPager.node);
  const stock = tag('section', 'm-pocket');
  stock.dataset.nav = 'stock';
  ui.arena.append(stock);
  stock.onclick = (event) => {
    const slot = event.target.closest('button[data-good]');
    if (slot && saleHint) pickSalePiece(by('hy-task-materials'), slot, saleHint);
    else open('stock', room.selfId);
  };
  const clock = tag('span', 'm-turn-clock'),
    status = tag('span', 'm-turn-info');
  const label = tag('button', 'm-table-title');
  label.type = 'button';
  label.dataset.nav = 'book';
  label.onclick = openBook;
  const edition = tag('small', 'm-edition');
  label.append(tag('span', '', '幽街商人'), edition);
  const turnBar = tag('header', 'm-turn-bar');
  turnBar.append(status, clock);
  ui.system1.after(turnBar);
  ui.system1.prepend(label);
  const membersButton = nav('members', '商铺', () => showMembers());
  if (!practice) ui.window.classList.add('merchant-friends');
  const inviteButton = practice ? null : tag('button', 'room-toolbar-action', '邀请');
  const turnButton = tag('button', 'm-order-button');
  turnButton.type = 'button';
  turnButton.setAttribute('aria-label', '查看出手顺序');
  status.replaceWith(turnButton);
  turnButton.append(status);
  turnButton.onclick = showTurnOrder;
  const marketButton = nav('market', '货栈', () => g()?.bankGoods && open('market'));
  nav('history', '账簿', () => {
    close();
    local('.nm-header-history')?.click();
  });
  if (practice) nav(
    'settings',
    '设置',
    () => {
      close();
      by('yg-settings')?.click();
    },
    true
  );
  if (practice) nav('exit', '离开', () => by('yg-exit')?.click(), true);
  else {
    // Keep these controls in the room root so chat, media and the existing exit handlers own every click.
    const toolbar = local('.room-toolbar');
    toolbar.classList.add('m-room-toolbar');
    inviteButton.type = 'button';
    inviteButton.dataset.nav = 'invite';
    inviteButton.onclick = invite;
    toolbar.prepend(inviteButton);
    const sizeToolbar = () => {
      const width = Math.ceil(toolbar.getBoundingClientRect().width) + 'px';
      ui.system2.style.width = width;
      ui.window.style.setProperty('--m-room-tools', width);
    };
    const toolbarSize = new ResizeObserver(sizeToolbar);
    toolbarSize.observe(toolbar);
    events.signal.addEventListener('abort', () => toolbarSize.disconnect(), {once:true});
    root.append(toolbar);
  }
  const ballot = by('hy-room-control');
  if (ballot) root.append(ballot);
  const pile = tag('button', 'm-pile');
  pile.type = 'button';
  pile.dataset.nav = 'pile';
  const back = tag('i', 'm-cardback');
  pile.append(back, tag('span', '', '牌堆'), tag('small', ''));
  const discard = tag('button', 'm-pile m-discard');
  discard.type = 'button';
  discard.dataset.nav = 'discard';
  const discardTop = tag('i', 'm-discard-top');
  const discardCount = tag('small', '');
  discard.append(discardTop, tag('span', '', '弃牌堆'), discardCount);
  discard.onclick = () => inspectDiscard();
  const piles = tag('section', 'm-piles');
  piles.setAttribute('aria-label', '公共牌堆');
  piles.append(pile, discard);
  ui.arena.append(piles);
  pile.onclick = () => {
    if (!g()?.bankGoods) return;
    if (ownTurn() && g().stage === 'draw' && !panel && !flags.draft && !flags.routeTask) send('peek');
    else open('pile');
  };
  const receipt = tag('output', 'm-receipt');
  ui.arena.append(receipt);
  const toast = tag('output', 'm-toast');
  toast.hidden = true;
  toast.setAttribute('aria-live', 'polite');
  ui.window.append(toast);
  let toastTimer;
  function notice(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3000);
  }
  function clockTick() {
    const value = by('yg-clock')?.textContent?.trim();
    const remaining = g()?.opening && g().clock;
    clock.title = remaining ? '选角倒计时' : by('yg-clock-label')?.textContent ?? '';
    clock.textContent = value && value !== '--:--' && room?.phase === 'playing' ? value : '';
  }
  const timer = setInterval(clockTick, 500);
  const closeAction = () => action('back', '回牌桌', close);
  const roleSource = () => local('[data-ex-command="role"]');
  function inspectModel() {
    if (panel.kind === 'read') {
      const face = getCard(panel.id, g()?.configuration);
      const body = tag('section', 'm-read');
      const card = tag('span', 'm-sample');
      printCard(card, face.id, g()?.configuration);
      body.append(card);
      const copy = tag('section', 'm-read-copy');
      for (const line of [face.summary, ...(face.details ?? []), face.example].filter(Boolean))
        copy.append(tag('p', '', line));
      body.append(copy);
      return {
        kind: 'reader',
        heading: face.name,
        body,
        bodyKey: 'read/' + face.id,
        actions: [
          action('back', '收起', () => {
            panel = panel.back ?? null;
            draw();
          })
        ]
      };
    }
    if (panel.kind === 'end')
      return {
        kind: 'confirm',
        heading: '结束本回合？',
        note: '还剩 ' + g().remainingActions + ' 次行动。' + (flags.idleReward ? '现在结束 +1 两。' : '现在结束没有奖励。'),
        actions: [
          action('continue', '继续经营', close),
          action('end-ok', '结束回合', () => {
            panel = null;
            send('end-turn');
          })
        ]
      };
    if (panel.kind === 'market' || panel.kind === 'orders')
      return market(room, close, route, canStartTrade(), panel.kind === 'orders', deliverable, orderInput);
    if (panel.kind === 'stock') {
      const player = g()?.players?.find((p) => p.id === panel.id);
      if (player?.goods)
        return seatDetails({
          room,
          player,
          name: name(player.id),
          own: player.id === room.selfId,
          roleSource: roleSource(),
          useTool: tool,
          close,
          route: (...args) => route(...args)
        });
    }
    if (panel.kind === 'pile') {
      const cards = g().discard ?? [];
      return {
        kind: 'spread',
        heading: '牌堆 ' + g().deckCount + ' 张 · 弃牌 ' + cards.length + ' 张',
        choices: cards
          .slice()
          .reverse()
          .map((c) => ({
            ...action(cardKey(c), getCard(c.definitionId).name, () => read(c.definitionId)),
            card: c.definitionId,
            read: c.definitionId,
            config: g().configuration
          })),
        group: 'discard',
        actions: [closeAction()]
      };
    }
    panel = null;
  }
  function currentModel() {
    const data = g();
    if (panel) {
      const view = inspectModel();
      if (view) return view;
    }
    if (!data || room.phase === 'waiting') {
      const box = local('#yg-scene-content');
      const model = merchantDecision({ root, room, flags, resetDraft, supplySources, orderSources });
      return {
        ...model,
        kind: 'waiting',
        heading: '准备开市',
        note: room.players.map(p => p.name + (p.id === room.hostId ? '（房主）' : '') + ' · ' + (p.ready ? '已准备' : '待准备')).join('　') + (room.players.length < 2 ? '　等待第二位伙伴' : ''),
        actions:
          model.actions.length || model.body
            ? model.actions
            : [...box.querySelectorAll('button')].map((b, i) =>
                action('wait-' + i, b.textContent, () => b.click(), b.disabled)
              )
      };
    }
    if (['finished', 'aborted'].includes(room.phase) && data.result) {
      const ranks = tag('ol', 'm-ranks');
      for (const entry of [...(data.result.wealth ?? [])].sort((a, b) => b.silver - a.silver)) {
        const li = tag('li', '');
        li.append(tag('span', '', name(entry.playerId)), tag('b', '', entry.silver + ' 两'));
        ranks.append(li);
      }
      const again = local(
        '#yg-scene-content [data-hy-action="practice-restart"],#yg-scene-content [data-hy-action="rematch"]'
      );
      return {
        kind: 'closing',
        heading: data.result.aborted ? '本局已取消' : '收市 · ' + data.result.winnerIds.map(name).join('、') + '胜出',
        body: ranks,
        bodyKey: JSON.stringify(data.result),
        actions: again
          ? [action('rematch', practice ? '再来一局' : '回准备室', () => again.click(), again.disabled)]
          : []
      };
    }
    if (room.phase === 'paused') return {
      kind: 'waiting', heading: '夜市暂停', note: local('#hy-stage-note')?.textContent || (data.holds?.capacity ? '记录已满，牌局已保留。' : data.holds?.manual ? '全桌已同意暂停，牌局保留七天。' : '伙伴暂时离线，牌局保留三十分钟。'),
      actions: []
    };
    if (data.opening) {
      const self = data.opening.self,
        locked = self?.confirmedRoleId;
      const current = locked ?? chosenRole;
      return {
        kind: 'opening',
        heading: !self || locked ? '等同桌入席' : '选一位商人入席',
        note: [current && getRole(current, data.opening.configuration).summary, '到时自动选角', data.opening.confirmed.filter(p => p.confirmed).length + '／' + data.opening.confirmed.length + ' 人已确认'].filter(Boolean).join(' · '),
        choices: (self?.candidates ?? []).map((id) => {
          const role = getRole(id, data.opening.configuration);
          return {
            ...action(
              id,
              role.name,
              () => {
                chosenRole = id;
                draw();
              },
              !!locked
            ),
            role,
            selected: id === current,
            read: id
          };
        }),
        actions:
          !self || locked
            ? []
            : [
                action(
                  'confirm-role',
                  '入席',
                  () =>
                    send('confirm-role', {
                      openingId: data.matchId,
                      candidateId: self.candidateId,
                      roleId: current
                    }),
                  !current || !usable()
                ),
                ...(practice ? [action('setup', '开局设置', openPracticeSetup)] : [])
              ]
      };
    }
    const p = data.pending;
    if (p?.auction && p.stage === 'bidding') {
      const own = p.actorId === room.selfId,
        choice = own && p.decision?.options?.find((o) => o.type === 'bid');
      const price = choice ? Math.max(choice.minimum, Math.min(choice.maximum, Number.isFinite(amount) ? amount : choice.minimum)) : 0;
      const adjust = (n) => {
        amount = Number.isFinite(price) ? Math.max(choice.minimum, Math.min(choice.maximum, price + n)) : choice.minimum;
        const field = ui.arena.querySelector('.m-bid-price input');
        if (field) field.value = String(amount);
        draw();
      };
      const body = choice ? tag('label', 'm-bid-price', '我的出价') : null;
      let valid = true;
      if (choice) {
        const field = tag('input');
        field.type = 'number'; field.inputMode = 'numeric';
        field.min = String(choice.minimum); field.max = String(choice.maximum);
        field.step = '1'; field.value = String(amount ?? price);
        valid = Number.isSafeInteger(amount ?? price) && (amount ?? price) >= choice.minimum && (amount ?? price) <= choice.maximum;
        field.oninput = () => { amount = field.valueAsNumber; draw(); };
        body.append(field, document.createTextNode('两'));
      }
      return {
        kind: 'auction', body, bodyKey: 'bid/' + p.decisionId + '/' + (choice ? choice.minimum + '/' + choice.maximum : 'watch'),
        heading: own ? '轮到你竞价' : name(p.actorId) + '正在竞价',
        note: p.auction.highestBidderId
          ? name(p.auction.highestBidderId) + '已出 ' + p.auction.highestBid + ' 两'
          : '尚未有人出价',
        choices: (p.pool ?? []).map((c) => ({
          ...action(cardKey(c), getCard(c.definitionId).name, () => read(c.definitionId)),
          card: c.definitionId,
          config: data.configuration,
          read: c.definitionId
        })),
        actions: !own
          ? []
          : [
              ...(choice
                ? [
                    action('minus', '−', () => adjust(-1), price <= choice.minimum),
                    action('bid', valid ? '出 ' + price + ' 两' : '确认出价', () => send('bid', { amount: price }), !valid || !usable()),
                    action('plus', '＋', () => adjust(1), price >= choice.maximum)
                  ]
                : []),
              action('pass-bid', '放弃竞价', () => send('pass-bid'))
            ]
      };
    }
    if (ownTurn() && !flags.draft && !flags.routeTask && room.phase === 'playing') {
      const actions = [];
      if (data.stage === 'draw') {
        const inspect = local('#yg-scene-content [data-ex-command="inspect"]');
        if (inspect) actions.push(action('inspect', '鉴牌 · 1两', () => inspect.click(), inspect.disabled));
        actions.push(
          action(
            'peek',
            data.drawStarted ? '再摸一张' : '摸第一张',
            () => send('peek'),
            !usable() || (!data.deckCount && !data.discard.length)
          )
        );
        if (data.drawStarted || (!data.deckCount && !data.discard.length))
          actions.push(action('finish-draw', '进入用牌', () => send('finish-draw')));
      }
      if (data.stage === 'use' || data.drawStarted || (!data.deckCount && !data.discard.length))
        actions.push(action('end', flags.idleReward ? '结束回合 +1两' : '结束回合', () => open('end')));
      return { kind: 'idle', heading: '', actions };
    }
    if (!ownTurn() && !p && !flags.draft && !flags.routeTask && room.phase === 'playing')
      return { kind: 'idle', heading: '', actions: [] };
    return merchantDecision({ root, room, flags, resetDraft, supplySources, orderSources });
  }
  let pocketKey = '',
    idsKey = '';
  function draw() {
    if (!room) return;
    const data = g(),
      roster = room.players ?? [];
    const index = roster.findIndex((p) => p.id === room.selfId);
    const order = index > 0 ? [...roster.slice(index), ...roster.slice(0, index)] : roster;
    const spectator = room.selfRole === 'spectator';
    const ids = [...(spectator ? [''] : []), ...order.map(p => p.id)];
    ui.arena.toggleAttribute('data-spectating', spectator);
    if (ids.length && idsKey !== ids.join('/')) {
      idsKey = ids.join('/');
      makeSeats(ids);
      seats = game.players;
      ui.arena.style.setProperty('--m-peer-count', String(Math.max(1, seats.length - 1)));
      for (const seat of seats.slice(1)) {
        seat.merchantStall = opponentStall(() => {
          peerPager.show(seat);
          open('stock', seat.dataset.seat);
        });
        seat.append(seat.merchantStall.node);
      }
    }
    const actor = data?.pending?.actorId ?? data?.turnPlayerId;
    const targets = targetCommands(by('hy-task-materials'));
    targetTools = equipmentCommands(by('hy-task-materials'));
    order.forEach((p, i) => {
      const seat = seats[i + (spectator ? 1 : 0)],
        value = data?.players.find((item) => item.id === p.id);
      paintSeat(seat, value, p.name, i, data?.configuration ?? data?.opening?.configuration, actor);
      const badges = [p.id === data?.closing?.finalPlayerId ? '末回合' : '',
        p.id === data?.turnPlayerId && data?.bookLayers ? '书算' + data.bookLayers + '层' : ''].filter(Boolean);
      seat.node.merchantBadges.textContent = badges.join(' · ');
      seat.node.merchantBadges.hidden = !badges.length;
      paintEquipment(seat, value, p.id === room.selfId, data?.configuration, sourceTool, tool);
      seat.merchantStall?.update(value, data, p.name);
      const target = targets.get(p.id);
      seat.classList.toggle('selectable', !!target && !target.disabled);
      seat.classList.toggle('m-chosen', !!target?.matches('.is-selected,[aria-pressed="true"]'));
      seat.merchantPick = () => {
        if (i || spectator) peerPager.show(seat);
        if (targets.has(p.id)) targets.get(p.id).click();
        else if (value?.goods) open('stock', p.id);
      };
    });
    peerPager.update(seats?.slice(1) ?? [], actor, !!panel);
    if (seats?.length) handCards((mine()?.hand ?? []).filter(card => sourceCard(cardKey(card))), data?.configuration, sourceCard, pickCard);
    const showStock = !!mine()?.goods;
    supplySources = !panel && usable() ? supplyCommands(root, room) : new Map();
    availableOrders = usable() ? orderCommands(by('hy-task-materials'), data?.pending) : new Map();
    orderSources = !panel && orderSpace.matches ? availableOrders : new Map();
    deliverable = new Set(usable() ? readyOrders() : []);
    saleHint = !panel && usable() && showStock ? saleMaterials(mine(), saleDraft()) : null;
    ui.arena.toggleAttribute('data-selling', !!saleHint);
    supply.update(room, supplySources, canStartTrade(), orderSources, deliverable);
    membersButton.textContent = practice ? '商铺' : room.roomCode + ' · ' + room.players.length + '人 ' + (room.spectators?.length ?? 0) + '观';
    if (!practice) {
      const guests = room.spectators?.length ?? 0;
      membersButton.dataset.roomCode = room.roomCode;
      membersButton.dataset.seats = '商铺 ' + room.players.length + '人' + (guests ? ' ' + guests + '观' : '');
      membersButton.setAttribute('aria-label', '商铺 · 房间 ' + room.roomCode + ' · ' + room.players.length + ' 位玩家 · ' + guests + ' 位观众');
    }
    membersButton.title = room.players.length + ' 位玩家 · ' + (room.spectators?.length ?? 0) + ' 位观众';
    if (inviteButton) inviteButton.setAttribute('aria-label', '复制房间邀请');
    turnButton.disabled = by('hy-settings-turn-order')?.hidden ?? true;
    const editionLabel = editionName(configuration());
    edition.textContent = (practice ? '本机练习 · ' : '') + editionLabel + ' · 牌册';
    label.setAttribute('aria-label', editionLabel + ' · 本局牌册');
    ui.arena.toggleAttribute('data-supply', !supply.node.hidden);
    stock.hidden = !showStock;
    piles.hidden = !data?.bankGoods;
    marketButton.hidden = supply.node.hidden;
    if (showStock) {
      const me = mine(),
        stockKey = JSON.stringify([me.goods, me.refined, me.ordinaryCapacity, me.roleId]);
      if (pocketKey !== stockKey) {
        pocketKey = stockKey;
        const inspectStock = tag('button', 'm-pocket-title', '我的货摊');
        inspectStock.type = 'button';
        stock.replaceChildren(inspectStock, bins(me, data, true));
        stock.setAttribute('aria-label', '我的货摊，普通货位' + me.ordinaryCapacity + '格');
      }
    }
    if (!piles.hidden) {
      const cards = data.discard ?? [], top = cards.at(-1)?.definitionId;
      pile.querySelector('small').textContent = data.deckCount + ' 张';
      discardCount.textContent = cards.length + ' 张';
      if (top !== discardTop.dataset.face) {
        discardTop.replaceChildren();
        if (top) printCard(discardTop, top, data.configuration);
        else delete discardTop.dataset.face;
      }
      discard.setAttribute('aria-label', '查看弃牌堆，' + cards.length + '张' + (top ? '，顶牌' + getCard(top).name : ''));
    }
    let stage = data?.stage === 'draw' ? '取牌' : '用牌';
    if (data?.opening) stage = '选角';
    else if (room.phase === 'finished') stage = '收市';
    else if (!data) stage = '准备';
    else if (data.pending?.auction && data.pending.stage === 'bidding') stage = '竞价';
    status.textContent = data?.opening
      ? '开市选角'
      : data?.turnNumber && room.phase !== 'finished'
        ? '第 ' +
          data.turnNumber +
          ' 手　' +
          (actor === room.selfId ? '轮到你' : name(actor)) +
          ' · ' +
          stage +
          (ownTurn() ? '　余 ' + data.remainingActions + '／共 ' + data.actionLimit + ' 步' : '')
        : stage;
    if (data?.pending && room.phase === 'playing' && !data.opening) {
      const p = data.pending;
      const verb = p.auction ? '出价' : p.response ? '回应' : p.choice?.kind?.includes('good') ? '选货' : p.kind === 'peek' ? '看牌' : '选择';
      status.textContent = (actor === room.selfId ? '等你' : name(actor) + ' · ') + verb;
    } else if (room.phase === 'paused') status.textContent = '夜市暂停';
    document.body.dataset.stage = data?.stage ?? room.phase;
    ui.arena.dataset.phase = room.phase;
    const model = currentModel();
    if (saleHint) model.primary = model.actions?.find(item => /^(submit|quality-confirm|trade-confirm|native-confirm)-/.test(item.key))?.key;
    if (model.preview && !model.body) {
      const card = tag('button', 'm-sample');
      printCard(card, model.preview, data?.configuration);
      card.onclick = () => read(model.preview);
      model.body = card;
      model.bodyKey = 'preview/' + model.preview;
    }
    const inspecting = practice && ['reader', 'market', 'stock', 'spread'].includes(model.kind) && !!panel;
    if (document.body.hasAttribute('data-merchant-reading') !== inspecting) {
      document.body.toggleAttribute('data-merchant-reading', inspecting);
      window.dispatchEvent(new Event('merchant-reading'));
    }
    native.draw(model);
    paintSaleMaterials(stock, ui.arena, saleHint);
    reserveActions();
    receipt.textContent = receiptText;
    receipt.hidden = !receiptText || model.kind !== 'idle';
    clockTick();
  }
  function update(next, options) {
    const data = next.game;
    const match = [next.roomId, next.matchId, next.selfId].join('/');
    const scope = [
      match,
      next.phase,
      data?.stage,
      data?.turnId,
      data?.actionsUsed,
      data?.pending?.decisionId
    ].join('/');
    if (match !== sessionScope) {
      sessionScope = match;
      peerPager.update([]);
      panel = null;
      chosenRole = null;
      lastSequence = undefined;
      receiptText = '';
    }
    if (scope !== previousScope) {
      previousScope = scope;
      amount = null;
      if (panel?.kind === 'end') panel = null;
    }
    if (data?.lastPublicEvents?.length && data.publicEventSequence !== lastSequence) {
      if (lastSequence !== undefined && data.publicEventSequence > lastSequence)
        showPublicPlay(data.lastPublicEvents, data.configuration);
      const event =
        data.lastPublicEvents.filter((e) => !['turn-started', 'draw-finished'].includes(e.type)).at(-1) ??
        data.lastPublicEvents.at(-1);
      receiptText = publicEventText(event, next.players);
      lastSequence = data.publicEventSequence;
    }
    room = next;
    flags = options;
    ui.window.hidden = false;
    draw();
    if (fullEntry && data) {
      fullEntry = false;
      if (!allModules(configuration())) queueMicrotask(chooseFullSetup);
    }
  }
  function showSettlement(previous, next) {
    if (!seats || !previous || !next) return;
    for (const seat of seats) {
      const id = seat.dataset.seat;
      const old = previous.players.find(p => p.id === id);
      const current = next.players.find(p => p.id === id);
      if (!old?.goods || !current?.goods) continue;
      const delta = current.silver - old.silver;
      const goods = Object.keys(current.goods).reduce((sum, good) => sum + current.goods[good] - (old.goods[good] ?? 0), 0);
      const changes = [[delta,'两'],[goods,'货']].filter(([n]) => n).map(([n, unit]) => (n > 0 ? '+' : '−') + Math.abs(n) + unit);
      if (!changes.length) continue;
      const notice = seat.node.merchantSettlement;
      clearTimeout(notice.expiry);
      notice.textContent = changes.join(' ');
      notice.hidden = false;
      notice.expiry = setTimeout(() => { notice.hidden = true; }, 1500);
    }
  }
  function conceal() {
    panel = null;
    room = null;
    book.close();
    ui.window.hidden = true;
    supply.update(null);
    for (const seat of seats ?? []) seat.merchantStall?.update(null);
    stock.replaceChildren();
    pocketKey = '';
    native.draw({});
    for (const c of [...(ui.handcards1?.children ?? [])]) c.remove();
  }
  let press,
    held = false,
    start;
  const clear = () => {
    clearTimeout(press);
    press = null;
  };
  function readTarget(el) {
    if (el.closest('.m-peer-stall')) return null;
    const node = el.closest('[data-read],[data-face],.player[data-seat]');
    return (
      node?.dataset.read ??
      node?.dataset.face ??
      g()?.players.find((p) => p.id === node?.dataset.seat)?.roleId
    );
  }
  listen(ui.window, 'contextmenu', (e) => {
    const id = readTarget(e.target);
    if (id) {
      e.preventDefault();
      read(id);
    }
  });
  listen(
    ui.window,
    'pointerdown',
    (e) => {
      clear();
      held = false;
      start = [e.clientX, e.clientY];
      const id = readTarget(e.target);
      if (e.button === 0 && id)
        press = setTimeout(() => {
          held = true;
          read(id);
        }, 550);
    },
    { capture: true }
  );
  listen(
    ui.window,
    'pointermove',
    (e) => {
      if (press && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 8) clear();
    },
    { passive: true }
  );
  for (const t of ['pointerup', 'pointercancel']) listen(window, t, clear);
  listen(
    ui.window,
    'click',
    (e) => {
      if (held) {
        held = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true }
  );
  listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || root.querySelector('dialog[open]')) return;
    if (panel) {
      e.preventDefault();
      close();
    } else if (flags?.draft || flags?.routeTask) {
      e.preventDefault();
      resetDraft();
    }
  });
  listen(window, 'merchant-clock-error', (event) => notice(event.detail));
  function reserveActions() {
    // CSS positions the hand, actions and receipt together as device insets change.
    ui.arena.style.setProperty('--m-controls-height', ui.control.offsetHeight + 'px');
  }
  const resized = new ResizeObserver(() => {
    if (game.me) ui.updatehl();
    reserveActions();
  });
  resized.observe(ui.arena);
  resized.observe(ui.control);
  const shelfSize = new ResizeObserver(() => {
    ui.arena.style.setProperty('--m-supply-height', supply.node.offsetHeight + 'px');
  });
  shelfSize.observe(supply.node);
  return {
    update,
    showSettlement,
    openBook,
    notice,
    conceal,
    captureChoiceScroll: () => null,
    restoreChoiceScroll() {},
    destroy() {
      clear();
      clearTimeout(toastTimer);
      clearInterval(timer);
      events.abort();
      resized.disconnect();
      shelfSize.disconnect();
      peerPager.node.remove();
      native.destroy();
      book.destroy();
    }
  };
}
