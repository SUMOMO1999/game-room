import { game, ui, lib, _status } from './native.mjs';
import { renderCard } from '../digital-card-ui.mjs';
import { getRole, getCard, expansionAsset } from '../presentation-content.mjs';
import { assetPath } from '../content/manifest.mjs';

export function tag(name, cls, text) {
  const node = document.createElement(name);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function action(key, label, run, disabled = false) {
  return { key, label, run, disabled };
}

function keyboard(node) {
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.addEventListener('keydown', (event) => {
    if (event.target === node && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      node.click();
    }
  });
}

export function printCard(node, id, config) {
  const face = getCard(id, config);
  const print = tag('span', 'm-print');
  print.innerHTML = renderCard({ definitionId: id }, { interactive: false, configuration: config });
  node.append(print);
  node.dataset.face = id;
  node.setAttribute('aria-label', face.name);
  node.title = face.name;
}
export function picture(role, i = 0) {
  return expansionAsset(role?.artPath || '/assets/hyakki/v2/' + ['c01', 'c03', 'm04', 'c10', 'c09', 'm06'][i % 6] + '.webp');
}

export function makeSeats(ids) {
  for (const seat of game.players) seat.remove();
  for (const node of [ui.me, ui.mebg]) node?.remove();
  game.players.length = 0;
  ui.create.players(ids.length);
  ui.create.me();
  ui.arena.classList.add('single-handcard');
  for (const [index, seat] of game.players.entries()) {
    seat.dataset.seat = ids[index];
    seat.setAttribute('role', 'group');
    keyboard(seat.node.avatar);
    seat.node.avatar.show();
    seat.node.equips.show();
    seat.node.equips.setAttribute('role', 'group');
    // The native observer calls this hook when a card enters/leaves equipment.
    // Merchant has three interchangeable tools and no weapon, armour or mount slots.
    seat.$handleEquipChange = () => {
      seat.node.equips.hidden = seat.node.equips.childElementCount === 0;
    };
    seat.$handleEquipChange();
    if (index) seat.style.setProperty('--m-seat-centre', String(1 - (index - 0.5) / (ids.length - 1)));
    seat.node.count.show();
    seat.node.identity.textContent = '';
    seat.node.merchantBadges = tag('small', 'm-seat-badges');
    seat.node.merchantSettlement = tag('output', 'm-settlement');
    seat.node.merchantSettlement.hidden = true;
    seat.append(seat.node.merchantBadges, seat.node.merchantSettlement);
    seat.node.silver = tag('span', 'm-wealth');
    seat.append(seat.node.silver);
    seat.node.stock = tag('span', 'm-stock-count');
    seat.append(seat.node.stock);
  }
}

export function paintSeat(seat, player, name, index, config, actor) {
  const role = player?.roleId && getRole(player.roleId, config);
  seat.node.avatar.style.backgroundImage = 'url("' + picture(role, index) + '")';
  seat.node.name.textContent = role?.name ?? name;
  seat.node.nameol.textContent = role ? name : '';
  seat.node.count.textContent = player?.handCount ?? player?.hand?.length ?? '·';
  seat.node.count.setAttribute('aria-label', '手牌 ' + seat.node.count.textContent + ' 张');
  seat.node.silver.textContent = player?.silver == null ? '' : player.silver + ' 两';
  seat.node.stock.textContent =
    player?.ordinaryCapacity == null
      ? ''
      : '货物 ' + Object.values(player.goods).reduce((a, b) => a + b, 0) + ' 件';
  seat.classList.toggle('m-turn', seat.dataset.seat === actor);
  seat.setAttribute(
    'aria-label',
    [name, role?.name, seat.node.silver.textContent, seat.node.stock.textContent].filter(Boolean).join('，')
  );
  seat.node.avatar.setAttribute('aria-label', seat.getAttribute('aria-label'));
}

// Use the native player's equipment zone. A chip delegates to the same merchant
// input as the installed card, including replacements and material selections.
export function paintEquipment(seat, player, own, config, sourceTool, pickTool) {
  const rack = seat.node.equips;
  const tools = player?.tools ?? [];
  rack.setAttribute('aria-label', (own ? '我的' : seat.node.name.textContent + '的') + '装备，' + tools.length + '件');
  const previous = new Map([...rack.children].map((c) => [c.dataset.slotKey, c]));
  for (const [index, tool] of tools.entries()) {
    const key = tool.cardId ?? (index + '/' + tool.definitionId);
    let chip = previous.get(key);
    if (!chip) {
      const face = getCard(tool.definitionId, config);
      chip = nativeCard(tool.definitionId, config, document.createDocumentFragment());
      chip.classList.add('m-equipped');
      chip.dataset.slotKey = key;
      chip.dataset.read = face.id;
      keyboard(chip);
      const image = tag('img', '');
      image.src = face.artPath ? expansionAsset(face.artPath) : assetPath(face.artId);
      image.alt = '';
      chip.append(image, tag('span', 'm-gear-name', face.name), tag('small', 'm-gear-state', '已用'));
    }
    if (rack.children[index] !== chip) rack.insertBefore(chip, rack.children[index] ?? null);
    previous.delete(key);
    const source = sourceTool(tool, own);
    const material = !!source && !source.disabled && (!own || source.classList.contains('is-task-material'));
    chip.classList.toggle('m-spent', tool.exhausted);
    chip.classList.toggle('m-material', material);
    chip.setAttribute('aria-pressed', String(!!source?.matches('.is-selected,[aria-pressed="true"]')));
    chip.querySelector('.m-gear-state').hidden = !tool.exhausted;
    chip.setAttribute('aria-label', chip.querySelector('.m-gear-name').textContent + (tool.exhausted ? '，本回合已用' : '，已装备'));
    chip.title = chip.getAttribute('aria-label');
    // While choosing a player, tapping their clothes or their tools picks the same
    // seat. When the rules offer individual tools, the tapped card takes priority.
    chip.merchantPick = () => {
      if (seat.classList.contains('selectable') && !material) seat.merchantPick();
      else pickTool(tool, own);
    };
  }
  for (const card of previous.values()) card.remove();
}

function nativeCard(definitionId, config, parent) {
  const card = ui.create.card(parent, undefined, true);
  lib.card[definitionId] ??= { type: 'merchant' };
  lib.translate[definitionId] = getCard(definitionId, config).name;
  card.init(['none', 0, definitionId]);
  return card;
}
function merchantCard(definitionId, config, parent) {
  const card = nativeCard(definitionId, config, parent);
  card.classList.add('m-card');
  printCard(card, definitionId, config);
  return card;
}

// Only public, committed plays animate. Private draws and reconnect snapshots never
// reconstruct an opponent's hand. The native player makes the same throw clone as combat.
const publicPlays = new Set([
  'trade-bought',
  'trade-sold',
  'character-played',
  'response-played',
  'tool-installed',
  'stall-expanded'
]);
export function showPublicPlay(events, config) {
  if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const event = events.findLast((e) => e.cardId && publicPlays.has(e.type));
  const seat = event && game.players.find((p) => p.dataset.seat === event.actorSeatId);
  if (!seat) return;
  const own = seat === game.me && [...ui.handcards1.children].find((n) => n.dataset.face === event.cardId);
  const card = own || merchantCard(event.cardId, config, document.createDocumentFragment());
  const start = (own || seat).getBoundingClientRect(),
    arena = ui.arena.getBoundingClientRect();
  const width = ui.handcards1.firstElementChild?.offsetWidth || 80;
  const left = (arena.width - width) / 2,
    top = Math.min(arena.height * 0.43, arena.height - 2.6 * width);
  const thrown = seat.$throwxy(card, left + 'px', top + 'px');
  thrown.classList.add('m-played');
  thrown.removeAttribute('data-instance');
  thrown.inert = true;
  thrown.setAttribute('aria-hidden', 'true');
  const delta =
    'translate(' +
    Math.round(start.left - arena.left - left) +
    'px,' +
    Math.round(start.top - arena.top - top) +
    'px) scale(.88)';
  const flight = thrown.animate(
    [
      { transform: delta, opacity: 0.6 },
      { transform: 'none', opacity: 1, offset: 0.48 },
      { transform: 'none', opacity: 1, offset: 0.75 },
      { transform: 'none', opacity: 0 }
    ],
    { duration: 610, easing: 'ease-out' }
  );
  flight.onfinish = flight.oncancel = () => thrown.remove();
}

export function handCards(cards, config, source, pick) {
  const existing = new Map([...ui.handcards1.children].map((card) => [card.dataset.instance, card]));
  let changed = false;
  for (const [i, card] of cards.entries()) {
    const id = card.cardId ?? card.id;
    let node = existing.get(id);
    if (!node) {
      node = merchantCard(card.definitionId, config, ui.handcards1);
      const badge = tag('span', 'm-sale-badge');
      badge.setAttribute('aria-hidden', 'true');
      badge.append(tag('span', '', '可卖'));
      node.append(badge);
      node.dataset.instance = id;
      keyboard(node);
      changed = true;
    }
    existing.delete(id);
    if (ui.handcards1.children[i] !== node) {
      ui.handcards1.insertBefore(node, ui.handcards1.children[i] ?? null);
      changed = true;
    }
    const command = source(id);
    node.classList.toggle(
      'selected',
      !!command?.matches('.is-selected,[aria-pressed="true"]') ||
        !!command?.querySelector('[aria-pressed="true"]')
    );
    node.classList.toggle('selectable', !!command?.classList.contains('is-task-material'));
    const sellable = !!command?.classList.contains('is-sellable');
    node.classList.toggle('m-sellable', sellable);
    node.setAttribute('aria-label', node.title + (sellable ? '，可卖出' : ''));
    node.setAttribute('aria-pressed', String(node.classList.contains('selected')));
    node.merchantPick = () => pick(id);
  }
  for (const unused of existing.values()) {
    unused.remove();
    changed = true;
  }
  if (changed) ui.updatehl();
}

export function nativeInputs() {
  // The engine calls these mode hooks from its original card, seat and candidate listeners.
  const activate = (node) => {
    if (node?.getAttribute('aria-disabled') !== 'true') node?.merchantPick?.();
  };
  Object.assign(_status.event.custom.replace, { card: activate, target: activate, button: activate });
  // The stock hand assumes 108px prints. Keep its selection/animation updates, then fit
  // the actual merchant prints without hiding the touch target of the preceding card.
  const updateNativeHand = ui.updatehl.bind(ui);
  ui.updatehl = () => {
    updateNativeHand();
    const row = ui.handcards1,
      cards = row?.children;
    if (!cards?.length) return;
    const width = cards[0].offsetWidth,
      available = ui.handcards1Container.clientWidth - 14;
    const count = cards.length;
    const step =
      count === 1
        ? 0
        : Math.min(
            width + 4,
            Math.max(Math.ceil(width * 0.73), Math.floor((available - width) / (count - 1)))
          );
    for (let i = 0; i < count; i++) {
      cards[i]._transform = 'translateX(' + i * step + 'px)';
      cards[i].style.transform = cards[i]._transform;
    }
    const span = (count - 1) * step + width + 4;
    row.style.width = span + 'px';
    ui.handcards1Container.classList.toggle('scrollh', span > available);
  };
}

export function makeChoice(item, parent, activate) {
  const node = ui.create.button(
    item.key,
    (_id, _type, position) => ui.create.div('.button.m-choice', position),
    parent
  );
  node.link = item.key;
  node.dataset.choice = item.key;
  keyboard(node);
  if (item.role) {
    const role = item.role;
    node.classList.add('m-role-choice');
    const art = tag('img', 'm-role-art');
    art.src = picture(role);
    art.alt = '';
    node.append(art);
    node.append(tag('strong', 'm-role-name', role.name), tag('small', 'm-role-ability', role.compactText));
  } else if (item.card) {
    node.classList.add('m-card-choice');
    printCard(node, item.card, item.config);
  } else {
    if (item.icon) {
      const icon = tag('img', 'm-good-icon');
      icon.src = item.icon.startsWith('/assets/') ? '.' + item.icon : item.icon;
      icon.alt = '';
      node.append(icon);
    }
    node.append(tag('span', '', item.label));
  }
  node.classList.toggle('selected', !!item.selected);
  node.classList.toggle('m-deliverable', !!item.ready);
  node.setAttribute('aria-pressed', String(!!item.selected));
  node.setAttribute('aria-label', item.label + (item.ready ? '，可交货' : ''));
  node.setAttribute('aria-disabled', String(!!item.disabled));
  if (item.read) node.dataset.read = item.read;
  node.merchantPick = () => activate(item.key);
  return node;
}

export function decisionSurface() {
  const dialog = ui.create.dialog('hidden', true, 'notouchscroll');
  dialog.classList.add('fixed', 'merchant-dialog');
  dialog.open();
  const content = dialog.content;
  const head = tag('h2', 'm-heading'),
    note = tag('p', 'm-note'),
    body = tag('section', 'm-body'),
    choices = tag('section', 'm-choices');
  const paging = tag('nav', 'm-page');
  const prev = tag('button', '', '‹'),
    next = tag('button', '', '›');
  prev.setAttribute('aria-label', '前一组候选');
  next.setAttribute('aria-label', '后一组候选');
  paging.append(prev, next);
  content.append(head, note, body, choices, paging);
  const advance = (direction) =>
    choices.scrollBy({ left: direction * Math.max(60, choices.clientWidth * 0.85), behavior: 'instant' });
  prev.onclick = () => advance(-1);
  next.onclick = () => advance(1);
  function pageControls() {
    paging.hidden = choices.scrollWidth <= choices.clientWidth + 2;
    prev.disabled = choices.scrollLeft <= 1;
    next.disabled = choices.scrollLeft + choices.clientWidth >= choices.scrollWidth - 2;
  }
  choices.addEventListener('scroll', pageControls, { passive: true });
  choices.addEventListener(
    'wheel',
    (event) => {
      if (paging.hidden || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const before = choices.scrollLeft;
      choices.scrollLeft += event.deltaY;
      if (choices.scrollLeft !== before) event.preventDefault();
    },
    { passive: false }
  );
  const observer = new ResizeObserver(pageControls);
  observer.observe(choices);
  let previousChoices,
    previousBody,
    previousControls,
    currentChoices = new Map(),
    currentCommands = [],
    bar;
  function draw(model) {
    dialog.hidden = !model.heading && !model.body && !model.choices?.length;
    dialog.dataset.kind = model.kind ?? 'idle';
    head.textContent = model.heading ?? '';
    note.textContent = model.note ?? '';
    note.hidden = !model.note;
    const bodyKey = model.bodyKey ?? model.body ?? '';
    if (bodyKey !== previousBody) {
      previousBody = bodyKey;
      body.replaceChildren();
      if (model.body) body.append(model.body);
    }
    body.hidden = !model.body;
    const items = model.choices ?? [];
    currentChoices = new Map(items.map((item) => [item.key, item]));
    const choicesKey = JSON.stringify(
      items.map(({ key, label, card, role, disabled, selected, ready, icon }) => [
        key,
        label,
        card,
        role?.id,
        disabled,
        selected,
        ready,
        icon
      ])
    );
    if (choicesKey !== previousChoices) {
      const sameGroup = choices.dataset.group === model.group && model.group;
      const offset = sameGroup ? choices.scrollLeft : 0;
      previousChoices = choicesKey;
      choices.dataset.group = model.group ?? '';
      choices.replaceChildren(
        ...items.map((item) =>
          makeChoice(item, document.createDocumentFragment(), (key) => currentChoices.get(key)?.run())
        )
      );
      choices.classList.toggle(
        'm-spread',
        items.some((item) => item.role || item.card)
      );
      choices.scrollLeft = offset;
    }
    choices.hidden = !items.length;
    pageControls();
    currentCommands = model.actions ?? [];
    const controlsKey = JSON.stringify([model.primary, currentCommands.map((v) => [v.key, v.label, v.disabled])]);
    if (controlsKey !== previousControls) {
      previousControls = controlsKey;
      // close() unregisters the old bar. Remove its fading node before the next decision becomes clickable.
      if (bar) {
        bar.close();
        bar.remove();
        bar = null;
      }
      if (currentCommands.length) {
        bar = ui.create.control(...currentCommands.map((v) => v.label), (_label, node) => {
          const cmd = currentCommands.find((item) => item.key === node.dataset.command);
          if (cmd && !cmd.disabled) cmd.run();
        });
        bar.classList.add('m-actions');
        const primary =
          model.primary ? currentCommands.findIndex(item => item.key === model.primary) : model.kind === 'confirm'
            ? 0
            : Math.max(
                0,
                currentCommands.findIndex(
                  (item) => !item.disabled && !/^(undo|minus|plus|back|cancel|reset)/.test(item.key)
                )
              );
        [...bar.children].forEach((node, index) => {
          const c = currentCommands[index];
          node.dataset.command = c.key;
          node.classList.toggle('m-primary', index === primary);
          node.setAttribute('aria-disabled', String(!!c.disabled));
          keyboard(node);
        });
      }
    }
  }
  return {
    draw,
    destroy() {
      observer.disconnect();
      bar?.close();
      dialog.close();
    }
  };
}
