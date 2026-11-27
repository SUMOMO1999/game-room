import { tag, action } from './pieces.mjs';
import { CATEGORIES } from '../content/expansion-one.mjs';
import { getPublicOrder } from '../content/expansion-two.mjs';
import { goodsFor, getGood, getRole, getCard } from '../presentation-content.mjs';
import { stallBoards } from '../night-market-ui.mjs';
import { cardKey, turnOrder } from '../game-ui-model.mjs';

function icon(good) {
  const img = tag('img', 'm-good-icon');
  img.src = '.' + good.icon;
  img.alt = '';
  return img;
}
function marketGrid(goods, counts, pick) {
  const panel = tag('section', 'm-market-grid');
  for (const group of CATEGORIES) {
    const items = goods.filter((x) => x.category === group.id);
    if (!items.length) continue;
    const cell = tag('section', 'm-family');
    cell.append(tag('h3', '', group.name));
    for (const good of items) {
      const row = tag(pick ? 'button' : 'span', 'm-good-row');
      row.dataset.good = good.id;
      if (pick) {
        row.type = 'button';
        row.onclick = () => pick(good.id);
      }
      row.append(icon(good), tag('span', '', good.name), tag('b', '', String(counts[good.id] ?? 0)));
      cell.append(row);
    }
    panel.append(cell);
  }
  return panel;
}

function canRefine(room) {
  const g = room.game;
  const player = g.players.find((p) => p.id === room.selfId);
  return room.phase === 'playing' && !g.pending && g.turnPlayerId === room.selfId && g.stage === 'use' &&
    !g.refiningUsed && g.remainingActions > 0 &&
    Object.entries(player?.goods ?? {}).some(([id, n]) => n > (player.refined?.[id] ?? 0));
}

export function publicMarket(pick, route, showMarket, orderInput) {
  const node = tag('aside', 'm-supply');
  node.setAttribute('aria-label', '公共货栈');
  node.hidden = true;
  const title = tag('h2', '', '公共货栈');
  const routes = tag('nav', 'm-market-actions');
  routes.setAttribute('aria-label', '商路风云');
  function shortcut(key, label, run) {
    const button = tag('button', '', label);
    button.type = 'button';
    button.dataset.route = key;
    button.onclick = run;
    routes.append(button);
    return button;
  }
  const orders = shortcut('orders', '公单', showMarket);
  const refine = shortcut('refining', '精制', () => route('refining'));
  const exchange = shortcut('exchange', '商会', () => route('exchange'));
  const slips = tag('section', 'm-public-orders');
  slips.setAttribute('aria-label', '桌上公单');
  node.append(title, routes, slips);
  let catalog, grid, orderKey;
  function update(room, choices, canChoose, orderChoices, ready) {
    const game = room?.game;
    node.hidden = !game?.bankGoods;
    if (node.hidden) return;
    const goods = goodsFor(game);
    if (goods !== catalog) {
      catalog = goods;
      grid?.remove();
      grid = marketGrid(goods, game.bankGoods, pick);
      node.insertBefore(grid, routes);
    }
    for (const row of grid.querySelectorAll('[data-good]')) {
      const value = String(game.bankGoods[row.dataset.good] ?? 0);
      if (row.lastChild.textContent !== value) row.lastChild.textContent = value;
      const source = choices.get(row.dataset.good);
      row.disabled = !source || source.disabled;
      if (source) {
        const quantity = source.closest('article.hy-material-quantity');
        const selected = quantity ? quantity.classList.contains('is-selected') : source.matches('.is-selected,[aria-pressed="true"]');
        row.setAttribute('aria-pressed', String(selected));
      } else row.removeAttribute('aria-pressed');
    }
    const modules = game.configuration?.modules;
    orders.hidden = !modules?.orders;
    orders.classList.toggle('m-deliverable', ready.size > 0);
    orders.textContent = ready.size ? '公单 · 可交' : '公单';
    refine.hidden = !modules?.refining;
    exchange.hidden = !modules?.exchange;
    routes.hidden = orders.hidden && refine.hidden && exchange.hidden;
    const offers = game.exchangeMarket?.offers.length ?? 0;
    exchange.textContent = offers ? '商会 ' + offers : '商会';
    refine.disabled = !canChoose || !canRefine(room);
    refine.title = refine.disabled ? '自己的用牌阶段可花1行动精制普通货，每回合一次' : '选择要精制的普通货';
    exchange.disabled = !canChoose;
    slips.hidden = orders.hidden;
    const current = game.publicOrders?.orders ?? [];
    const key = JSON.stringify(current.map(({id, position, generation}) => [id, position, generation]));
    if (orderKey !== key) {
      orderKey = key;
      slips.replaceChildren(...current.map((order) => {
        const face = getPublicOrder(order.id);
        const item = tag('button', 'm-order-slip');
        item.type = 'button';
        item.dataset.order = order.id;
        item.title = face.name + ' · ' + face.summary;
        item.append(tag('span', '', face.name), tag('b', '', face.silver + '两'));
        item.onclick = () => orderInput.pick(order);
        return item;
      }));
    }
    for (const [index, item] of [...slips.children].entries()) {
      const source = orderChoices.get(current[index].position);
      item.disabled = !orderInput.enabled(current[index]);
      item.classList.toggle('m-target-order', !!source && !source.disabled);
      const deliverable = ready.has(current[index].position);
      item.classList.toggle('m-deliverable', deliverable);
      item.setAttribute('aria-label', item.title + (deliverable ? '，可交货' : ''));
    }
  }
  return { node, update };
}

export function market(room, close, route, canChoose, ordersOnly, ready, orderInput) {
  const g = room.game;
  const choices = [];
  for (const order of g.publicOrders?.orders ?? []) {
    const card = getPublicOrder(order.id);
    choices.push({
      ...action(
        'order-' + order.position,
        card.name + ' · ' + card.silver + '两' + (ordersOnly ? '　' + card.summary : ''),
        () => orderInput.pick(order),
        !orderInput.enabled(order)
      ),
      ready: ready.has(order.position)
    });
  }
  const actions = [];
  if (!ordersOnly && g.exchangeMarket)
    actions.push(
      action('exchange', '商会挂牌', () => route('exchange'), !canChoose)
    );
  actions.push(action('back', '回牌桌', close));
  return {
    kind: 'market',
    heading: ordersOnly ? '桌上公单' : '公共货栈',
    body: ordersOnly ? null : marketGrid(goodsFor(g), g.bankGoods),
    bodyKey: ordersOnly ? 'public-orders' : JSON.stringify([g.configuration?.packId, g.bankGoods]),
    choices,
    actions
  };
}

export function inventoryLayout(p, g) {
  const goods = goodsFor(g).map((good) => ({ id: good.id, count: p.goods[good.id] ?? 0 }));
  const boards = stallBoards({ ...p, goods });
  return [boards.main, boards.extra, ...boards.expansions].filter(Boolean);
}

// Narrow tables show one of the same native seats as the wide table.
export function opponentPager() {
  const node = tag('nav', 'm-peer-nav');
  node.setAttribute('aria-label', '切换对手');
  const page = tag('small', 'm-peer-page');
  let seats = [], shown, lastActor, lastTargets;
  function show(seat) {
    shown = seat?.dataset.seat;
    for (const item of seats) item.toggleAttribute('data-peer-current', item === seat);
    node.hidden = seats.length < 2;
    if (seat) page.textContent = (seats.indexOf(seat) + 1) + '/' + seats.length;
  }
  for (const [step, label, arrow] of [[-1, '上一位对手', '‹'], [1, '下一位对手', '›']]) {
    const button = tag('button', '', arrow);
    button.type = 'button';
    button.dataset.peerStep = String(step);
    button.setAttribute('aria-label', label);
    button.title = label;
    if (step === 1) button.append(page);
    button.onclick = () => {
      const index = seats.findIndex((seat) => seat.dataset.seat === shown);
      if (seats.length) show(seats[(index + step + seats.length) % seats.length]);
    };
    node.append(button);
  }
  function update(peers, actor, inspecting) {
    seats = peers;
    const candidates = peers.filter((seat) => seat.classList.contains('selectable') || seat.querySelector('.m-equipped.m-material'));
    const selection = candidates.map((seat) => seat.dataset.seat).join('/');
    let seat = peers.find((item) => item.dataset.seat === shown);
    if (selection && selection !== lastTargets && !candidates.includes(seat)) seat = candidates[0];
    else if (!selection && !inspecting && actor !== lastActor) seat = peers.find((item) => item.dataset.seat === actor) ?? seat;
    lastActor = actor;
    lastTargets = selection;
    show(seat ?? peers[0]);
  }
  return { node, update, show };
}

// Only the public player projection supplies the goods on another merchant's counter.
export function opponentStall(inspect) {
  const node = tag('section', 'm-peer-stall');
  node.hidden = true;
  const heading = tag('button', 'm-stall-label');
  heading.type = 'button';
  const capacity = tag('b', 'm-stall-capacity');
  const temporary = tag('span', 'm-stall-temporary', '临');
  heading.append(tag('span', 'm-stall-name', '货摊'), capacity, temporary);
  const list = tag('span', 'm-stall-list');
  const more = tag('span', 'm-stall-more');
  const empty = tag('span', 'm-stall-empty', '空摊');
  node.append(heading, list, empty);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    inspect();
  });
  let catalog;
  const stacks = new Map();
  function update(player, game, name) {
    node.hidden = !player?.goods;
    if (node.hidden) return;
    const definitions = goodsFor(game);
    if (definitions !== catalog) {
      catalog = definitions;
      stacks.clear();
      list.replaceChildren();
      for (const family of CATEGORIES) {
        for (const item of catalog.filter((good) => good.category === family.id)) {
          const chip = tag('span', 'm-stall-stack');
          chip.dataset.good = item.id;
          chip.dataset.category = family.id;
          const number = tag('b', 'm-stall-quantity');
          const quality = tag('small', 'm-stall-quality');
          chip.append(icon(item), tag('span', 'm-goods-name', item.name),
            tag('small', 'm-goods-class', family.name), number, quality);
          list.append(chip);
          stacks.set(item.id, { item, family, chip, number, quality });
        }
      }
      list.append(more);
    }
    let total = 0, kinds = 0;
    for (const [id, stack] of stacks) {
      const count = player.goods[id] ?? 0;
      const refined = player.refined?.[id] ?? 0;
      total += count;
      if (count) kinds++;
      stack.chip.toggleAttribute('data-preview', count > 0 && kinds <= 3);
      if (count === stack.count && refined === stack.refined) continue;
      Object.assign(stack, { count, refined });
      stack.chip.hidden = count === 0;
      stack.number.textContent = String(count);
      stack.quality.hidden = !refined;
      stack.quality.textContent = refined ? '精' + refined : '';
      stack.chip.title = stack.family.name + ' · ' + stack.item.name + ' ' + count + ' 件' +
        (refined ? '，其中 ' + refined + ' 件精制' : '');
      stack.chip.setAttribute('aria-label', stack.chip.title);
    }
    const ordinary = Math.min(total, player.ordinaryCapacity) + '/' + player.ordinaryCapacity;
    capacity.textContent = ordinary;
    temporary.hidden = !player.temporaryOccupied;
    empty.hidden = total > 0;
    list.hidden = !total;
    node.toggleAttribute('data-dense', kinds > 6);
    more.hidden = kinds <= 3;
    if (kinds > 3) {
      more.textContent = '+' + (kinds - 3);
      more.setAttribute('aria-label', '另有' + (kinds - 3) + '种货物，点开查看');
    }
    node.setAttribute('aria-label', name + '的货摊');
    heading.setAttribute('aria-label', '查看' + name + '的货摊，普通位 ' + ordinary +
      (player.temporaryOccupied ? '，临时位已用' : '，临时位空闲'));
    heading.title = heading.getAttribute('aria-label');
  }
  return { node, update };
}

export function bins(p, g, compact = false) {
  const section = tag('section', compact ? 'm-pocket-bins' : 'm-bins');
  for (const part of inventoryLayout(p, g)) {
    const rack = tag('section', 'm-rack');
    rack.append(tag('h3', '', part.name));
    for (const slot of part.slots) {
      const item = slot.good && getGood(slot.good.id);
      const group = item && CATEGORIES.find((c) => c.id === item.category);
      const box = tag(compact && item ? 'button' : 'span', 'm-bin' + (slot.temporary ? ' m-temp' : ''));
      const label =
        (slot.temporary ? '临时格' : '货位' + (slot.index + 1)) +
        (item ? ' · ' + group.name + ' · ' + (slot.good.refined ? '精制' : '') + item.name : ' · 空');
      box.title = label;
      box.setAttribute('aria-label', label);
      if (item) {
        if (compact) {
          box.type = 'button';
          box.dataset.good = item.id;
          box.dataset.quality = slot.good.refined ? 'refined' : 'ordinary';
        }
        box.append(icon(item));
        if (!compact) box.append(tag('small', '', group.name), tag('b', '', item.name));
        if (slot.good.refined) box.append(tag('em', '', '精'));
      } else box.textContent = slot.temporary ? '临' : compact ? '·' : '空';
      rack.append(box);
    }
    section.append(rack);
  }
  return section;
}
export function seatDetails({ room, player, name, own, roleSource, useTool, close, route }) {
  const g = room.game,
    role = player.roleId && getRole(player.roleId, g.configuration);
  const position = turnOrder(g).findIndex((p) => p.id === player.id) + 1;
  const notes = [
    position && '第' + position + '手',
    g.closing?.finalPlayerId === player.id && '末回合',
    g.turnPlayerId === player.id && g.bookLayers > 0 && '书算' + g.bookLayers + '层',
    role && role.name + '　' + role.summary
  ].filter(Boolean);
  const show = () => {
    close();
    roleSource?.click();
  };
  const choices = (player.tools ?? []).map((t) =>
    action('tool-' + cardKey(t), getCard(t.definitionId, g.configuration).name + (t.exhausted ? ' · 已用' : ''), () =>
      useTool(t, own)
    )
  );
  const actions = [];
  if (own && roleSource) actions.push(action('skill', '角色能力', show, roleSource.disabled));
  if (own && g.configuration?.modules?.refining)
    actions.push(
      action(
        'refine',
        '精制货物',
        () => route('refining'),
        !canRefine(room)
      )
    );
  if (own && g.exchangeMarket)
    actions.push(
      action('exchange', '商会挂牌', () => route('exchange'), !!g.pending || room.phase !== 'playing')
    );
  actions.push(action('back', '回牌桌', close));
  const inventory = bins(player, g);
  if (!own) inventory.classList.add('m-peer-inventory');
  return {
    kind: 'stock',
    heading: name + '的货摊 · ' + player.silver + '两',
    note: notes.join(' · '),
    body: inventory,
    bodyKey: JSON.stringify([player.id, player.goods, player.refined, player.ordinaryCapacity]),
    choices,
    actions
  };
}
