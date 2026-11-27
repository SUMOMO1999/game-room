import { action, tag } from './pieces.mjs';
import { getCard } from '../presentation-content.mjs';

const selector = 'button,input:not([type=hidden]),select,textarea';
const command = (node) =>
  node.dataset.hyAction || node.dataset.exCommand || node.dataset.e2Command || node.id;
const omitted = new Set(['read', 'catalog', 'decision-source', 'view-source', 'exchange-read']);
const plain = (node) => node?.textContent.trim().replace(/\s+/g, ' ') ?? '';
function fields(node) {
  return JSON.parse(node.dataset.hyFields || node.dataset.exFields || node.dataset.e2Fields || '{}');
}
function visibleIn(node, container) {
  for (let p = node; p && p !== container.parentElement; p = p.parentElement)
    if (p.hidden || p.style.display === 'none') return false;
  return true;
}
export function commandFrom(node, key) {
  const def = node.querySelector('[data-card-id]')?.dataset.cardId;
  const label = def ? getCard(def).name : plain(node) || node.getAttribute('aria-label') || node.title;
  return {
    ...action(key ?? command(node), label, () => node.click(), node.disabled),
    card: def,
    read: def,
    selected: node.matches('.is-selected,.selected,[aria-pressed="true"]')
  };
}

export function targetCommands(tray) {
  const result = new Map();
  if (tray.hidden) return result;
  for (const n of tray.querySelectorAll('button')) {
    const f = fields(n);
    const id =
      f.field === 'targetId'
        ? f.id
        : f.key === 'targetId'
          ? f.value
          : f.type === 'target'
            ? f.id
            : command(n) === 'native-borrow-target'
              ? f.targetId
              : null;
    if (id) result.set(id, n);
  }
  return result;
}

export function equipmentCommands(tray) {
  const result = new Map();
  if (!tray.hidden) {
    for (const node of tray.querySelectorAll('button[data-hy-action="draft-value"]')) {
      const value = fields(node);
      if (value.field === 'toolCardId') result.set(value.id, node);
    }
  }
  return result;
}

export function orderCommands(tray, pending) {
  const result = new Map();
  if (!tray.hidden) {
    for (const node of tray.querySelectorAll('[data-e2-command="order"],[data-e2-command="compass-choice"]')) {
      const { position, index } = fields(node);
      const slot = position ?? (pending?.choice?.kind === 'compass-position' ? pending.choice.options?.[index]?.position : undefined);
      if (Number.isInteger(slot)) result.set(slot, node);
    }
  }
  return result;
}

// Project only incoming public stock. A choice from a player or an auction lot
// may show the very same good, but has a different owner.
export function supplyCommands(root, room) {
  const result = new Map();
  const tray = root.querySelector('#hy-task-materials');
  if (tray.hidden) return result;
  const pending = room.game?.pending;
  if (pending && pending.actorId !== room.selfId) return result;
  const def = root.querySelector('#yg-scene-content .hy-source-reader [data-card-id]')?.dataset.cardId;
  const source = pending?.code ?? (def && getCard(def).sourceCode) ?? '';
  const kind = pending?.choice?.kind;
  const fromBank =
    ['artisan-good', 'tool-buy-good', 'benefit-good', 'tool-class-good'].includes(kind) ||
    (!pending && /^XT(0[7-9]|1[0-2])$/.test(source)) ||
    source === 'R18';
  const bankSteps =
    '.hy-benefit-goods, [data-exchange-step="to"], [data-material-flow="payment-good"] [data-material-step="good"]';
  for (const node of tray.querySelectorAll('button.hy-material-good')) {
    const fromExchange = source === 'XT13' && node.closest('[data-material-step="other"]');
    if (!fromBank && !fromExchange && !node.closest(bankSteps)) continue;
    const id = node.dataset.materialGood ?? node.querySelector('[data-goods-icon]')?.dataset.goodsIcon;
    if (id) result.set(id, node);
  }
  const isProcurement = kind === 'class-procure' || (!pending && /^XC0[1-6]$/.test(source));
  for (const node of tray.querySelectorAll('button[data-ex-command="amount"]')) {
    const { field, id, delta } = fields(node);
    if (delta === 1 && (field === 'receive' || (field === 'goods' && isProcurement))) {
      result.set(id, node);
    }
  }
  return result;
}

// Complex payment forms retain their original labels, quantities and validation. Their events
// go to the current merchant controller; no default values or private choices are inferred.
function formBody(container, root, nodes, sourceSelector = '#' + CSS.escape(container.id)) {
  const copy = container.cloneNode(true);
  copy.classList.add('m-form');
  copy.hidden = false;
  const copies = [...copy.querySelectorAll(selector)],
    originals = [...container.querySelectorAll(selector)];
  const ids = new Map();
  for (const element of [copy, ...copy.querySelectorAll('[id]')]) {
    if (element.id) {
      const original = element.id;
      element.id = 'm-field-' + original;
      ids.set(original, element.id);
    }
  }
  for (const attr of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'list']) {
    for (const el of copy.querySelectorAll('[' + attr + ']')) {
      el.setAttribute(
        attr,
        el
          .getAttribute(attr)
          .split(/\s+/)
          .map((id) => ids.get(id) ?? id)
          .join(' ')
      );
    }
  }
  copies.forEach((control, index) => {
    const original = originals[index];
    if (!nodes.includes(original)) {
      control.remove();
      return;
    }
    const live = () => root.querySelector(sourceSelector)?.querySelectorAll(selector)[index];
    if (
      control instanceof HTMLSelectElement ||
      control instanceof HTMLInputElement ||
      control instanceof HTMLTextAreaElement
    ) {
      control.value = original.value;
      if (control.type === 'checkbox') control.checked = original.checked;
      for (const kind of ['input', 'change'])
        control.addEventListener(kind, () => {
          const source = live();
          if (!source || source.disabled) return;
          source.value = control.value;
          if (control.type === 'checkbox') source.checked = control.checked;
          source.dispatchEvent(new Event(kind, { bubbles: true }));
        });
    } else control.onclick = () => live()?.click();
  });
  return copy;
}

export function merchantDecision({ root, room, flags, resetDraft, supplySources, orderSources }) {
  const scene = root.querySelector('#yg-scene-content');
  const tray = root.querySelector('#hy-task-materials');
  const materials = root.querySelector('#hy-task-material-cards');
  const data = room.game;
  const quoteSelector = '#yg-scene-content .e2-offer-terms';
  const quote = root.querySelector(quoteSelector);
  const sources = [...scene.querySelectorAll('button')].filter(
    (n) =>
      visibleIn(n, scene) &&
      !n.dataset.detailId &&
      !omitted.has(command(n)) &&
      !n.closest('.nt-object,.hy-source-reader,.e2-offer-terms')
  );
  const allMaterials = tray.hidden
    ? []
    : [...materials.querySelectorAll(selector)].filter((n) => visibleIn(n, materials));
  const onShelf = new Set([...supplySources.values(), ...orderSources.values()]);
  const directStock = allMaterials.length > 0 && allMaterials.every((n) => onShelf.has(n));
  const materialNodes = directStock ? [] : allMaterials;
  const actions = sources.map((n, i) => commandFrom(n, (command(n) ?? 'action') + '-' + i));
  const hasCards =
    materialNodes.length &&
    materialNodes.every((n) => n.dataset.materialCard && n.querySelector('[data-card-id]'));
  const targetList = targetCommands(tray);
  const gearList = equipmentCommands(tray);
  const tableTargets = new Set([...targetList.values(), ...gearList.values()]);
  const directTargets = materialNodes.length && materialNodes.every((n) => tableTargets.has(n));
  const choiceLabels = materialNodes.map((n) => plain(n));
  const simple =
    materialNodes.length &&
    materialNodes.length <= 14 &&
    materialNodes.every((n) => n.tagName === 'BUTTON') &&
    new Set(choiceLabels).size === choiceLabels.length &&
    !materials.querySelector('.hy-material-steps,.e2-live-exchange') &&
    !choiceLabels.some((label) => ['＋', '+', '−', '–', '－', '-'].includes(label));
  const choices =
    hasCards || (simple && !directTargets)
      ? materialNodes.map((n, i) => commandFrom(n, 'material-' + i))
      : [];
  let body, bodyKey;
  if (
    (materialNodes.length && !choices.length && !directTargets) ||
    (materials.querySelector('article[data-material-card]') && !tray.hidden)
  ) {
    body = formBody(materials, root, materialNodes);
    bodyKey = materials.innerHTML;
  }
  // Compound trades and room configuration can put actual controls directly in the scene.
  if (
    scene.querySelector('input:not([type=hidden]),select,textarea') ||
    scene.matches(':has(.e2-live-exchange)')
  ) {
    const nodes = [...scene.querySelectorAll(selector)].filter((n) => visibleIn(n, scene));
    const forms = formBody(scene, root, nodes);
    if (body) forms.append(body);
    body = forms;
    bodyKey = scene.innerHTML + (bodyKey ?? '');
    actions.length = 0;
  } else if (quote) {
    const trade = tag('section', 'm-quote');
    trade.append(formBody(quote, root, [...quote.querySelectorAll(selector)], quoteSelector));
    if (body) trade.append(body);
    body = trade;
    bodyKey = quote.outerHTML + (bodyKey ?? '');
  }
  const printed = scene.querySelector('.nt-object [data-card-id],.hy-source-reader [data-card-id]');
  const selectedCard = flags.selectedCard?.definitionId ?? printed?.dataset.cardId;
  const title =
    hasCards && data?.pending?.sourceRole?.roleId === 'yousei.role.r15'
      ? '鉴牌 · 选一张'
      : hasCards
        ? plain(tray.querySelector('#hy-task-material-title')) || '从摊开的牌中选择'
        : plain(scene.querySelector('h2,h3,.hy-task-heading')) ||
          plain(tray.hidden ? null : tray.querySelector('#hy-task-material-title')) ||
          (data?.pending ? '当前选择' : '经营');
  const description = [
    ...scene.querySelectorAll('.nt-description > p,.hy-decision-summary,.hy-work-preview,.yg-scene-note')
  ]
    .map(plain)
    .filter(Boolean);
  const selectedTarget = [...targetList.entries()].find(([, node]) =>
    node.matches('.is-selected,[aria-pressed="true"]')
  )?.[0];
  const selectedName = room.players.find((player) => player.id === selectedTarget)?.name;
  const note = directStock
    ? (orderSources.size ? (description[0] || '点公共货栈里的公单。') : '点公共货栈里亮起的货物，确认前可以改选。')
    : hasCards
    ? data?.pending?.sourceRole?.roleId === 'yousei.role.r15'
      ? '选一张，确认后决定留弃。'
      : plain(tray.querySelector('#hy-task-material-note'))
    : directTargets
      ? gearList.size
        ? '点对手面前亮起的道具选装备，确认前可以改选。'
        : selectedName
        ? '已选 ' + selectedName + ' · 可以改选。'
        : '点桌上亮起的商人选择对象。'
      : description.slice(0, 2).join('　') || (quote ? '' : plain(scene.querySelector('.nt-description')));
  if (
    (flags.draft || flags.routeTask) &&
    !data?.pending &&
    !actions.some((a) => /取消|收回|返回/.test(a.label))
  )
    actions.push(action('cancel', '收回', resetDraft));
  return {
    kind: hasCards ? 'spread' : 'decision',
    heading: title,
    note,
    body,
    bodyKey,
    choices,
    actions,
    preview: !body && !choices.length ? selectedCard : null,
    group: data?.pending?.decisionId ?? title
  };
}
