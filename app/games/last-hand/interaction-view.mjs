import { eventCards } from './rules/interaction-cards.mjs';
import { el, esc, button, showDetail, ranked, suit } from './widgets.mjs';
import { eventHint } from './display-copy.mjs';

const byId = (v, id) => v.players.find((p) => p.id === id)?.name || '牌友';
const who = (v, id) => esc(byId(v, id));
const rate = '本桌每人每次所得奖分按 10 分换 1 银，零头再换 1 银。';
export function eventInfo(v, id, trigger) {
  const card = eventCards[id];
  if (!card) return;
  showDetail(
    trigger,
    card.name,
    '<p>' +
      esc(card.rules) +
      '</p>' +
      (!v?.scoreOnly && !card.survival ? '<p>' + rate + '</p>' : ''),
  );
}
export function gainsText(line) {
  const fields = [
    ['points', '分'],
    ['silver', '银'],
    ['hp', '血'],
    ['attack', '攻'],
    ['shield', '盾'],
  ];
  return fields
    .filter(([key]) => line[key])
    .map(
      ([key, label]) =>
        (line[key] > 0 ? '+' : '−') + Math.abs(line[key]) + label,
    )
    .join(' ');
}
export function resultDetails(v, result) {
  if (!result) return '';
  return (
    '<p>' +
    result.facts.map(esc).join(' · ') +
    '</p><div class="eventLedger">' +
    result.gains
      .map(
        (g) =>
          '<div><b>' +
          who(v, g.id) +
          '</b> ' +
          esc(gainsText(g) || '收支持平') +
          (v.scoreOnly ? ' · 总分 ' + g.total : '') +
          '</div>',
      )
      .join('') +
    '</div>'
  );
}
// A preview belongs to one seat and one decision. Only eventConfirm sends its move.
export function eventDecision(v, preview) {
  const x = v?.interaction;
  if (!x || !preview || preview.epoch !== v.epoch || preview.match !== v.matchId ||
      preview.seat !== v.self || !x.actors.includes(v.self)) return null;
  const value = preview.value;
  if (x.stage === 'offer' && preview.action === 'eventPick' &&
      x.offers.some((_, i) => String(i) === value))
    return {type:'eventPick',slot:Number(value)};
  if (x.stage === 'target' && preview.action === 'eventTarget' && x.targets.includes(value))
    return {type:'eventTarget',target:value};
  if (x.stage === 'play' && preview.action === 'eventPlay' && x.options.some(o => o.value === value))
    return {type:'eventPlay',choice:value};
  return null;
}
function offer(v, x, can, choice) {
  return (
    '<div class="eventOffers">' +
    x.offers
      .map((id, i) => {
        const card = eventCards[id];
        const title = card?.name || '翻暗牌';
        const choose = can ? 'eventPick' : card ? 'eventInfo' : '';
        return (
          '<div class="eventSlot ' +
          (card ? card.family : 'blind') +
          '"><button type="button" class="eventCard" ' +
          (can ? 'aria-pressed="' + (choice?.slot === i) + '" ' : '') +
          (choose
            ? 'data-act="' + choose + '" data-val="' + esc(can ? i : id) + '"'
            : 'disabled') +
          (card ? ' data-interaction-info="' + id + '"' : '') +
          ' aria-label="' +
          esc(title) +
          '">' +
          '<span class="eventMark" aria-hidden="true">' +
          (card ? esc(card.mark) : '？') +
          '</span><b>' +
          esc(title) +
          '</b>' +
          '<small>' +
          (card ? esc(eventHint(card, v.scoreOnly)) : '确认后揭晓') +
          '</small></button>' +
          (card
            ? '<button type="button" class="eventHelp" data-act="eventInfo" data-val="' +
              id +
              '" aria-label="' +
              esc(title) +
              '玩法">ⓘ</button>'
            : '') +
          '</div>'
        );
      })
      .join('') +
    '</div>'
  );
}
function eventChoice(label, action, value, seatName, selected) {
  return '<button type="button" class="' + (seatName ? 'eventSeatChoice' : '') + '" data-act="' + action + '" data-val="' + esc(value) +
    '" aria-pressed="' + selected + '"><span>' + esc(label) + '</span></button>';
}
function argument(v, x, card, can, choice) {
  if (x.stage === 'target')
    return (
      '<p>' +
      (can ? '选一位牌友' : '等发起人选牌友') +
      '</p>' +
      (can
        ? '<div class="eventOptions">' +
          x.targets
            .map((id) => eventChoice(byId(v, id), 'eventTarget', id, true, choice?.target === id))
            .join('') +
          '</div>'
        : '')
    );
  const hiddenColor = ['colorBluff', 'ambush'].includes(card.id);
  const own = x.ownChoice;
  let prompt = x.participants.includes(v.self)
    ? '各自暗选'
    : '等牌友揭晓';
  if (hiddenColor && can)
    prompt = x.host === v.self ? '藏一种颜色' : '猜对方藏的颜色';
  const privateLabel = own == null ? '' : x.ownLabel || own;
  const tally = x.ready.length + '/' + x.participants.length + ' 已锁定';
  return (
    '<p class="eventPrompt">' +
    (own != null ? '你已锁定 ' + esc(privateLabel) : esc(prompt)) +
    ' <span>' +
    esc(tally) +
    '</span></p>' +
    (x.openDie
      ? '<div class="eventOpenDie" aria-label="第一骰 ' +
        x.openDie +
        '">第一骰 ' +
        ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][x.openDie] +
        '</div>'
      : '') +
    (can
      ? '<div class="eventOptions">' +
        x.options.map((o) => eventChoice(o.label, 'eventPlay', o.value,
          v.players.some(p => p.id === o.value), choice?.choice === o.value)).join('') +
        '</div>'
      : '')
  );
}
function receipt(v, x) {
  const r = x.result;
  const dice = r.dice
    .map(
      (n) =>
        '<b class="eventDie" aria-label="' +
        n +
        '点">' +
        ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][n] +
        '</b>',
    )
    .join('');
  const answers = r.answers
    .map(
      (a) =>
        '<span class="eventAnswer"><em>' +
        who(v, a.id) +
        '</em><b>' +
        esc(a.label) +
        '</b></span>',
    )
    .join('');
  const gains = r.gains
    .filter((g) => gainsText(g))
    .map(
      (g) =>
        '<span class="eventGain" data-gain-seat="' +
        esc(g.id) +
        '"><em>' +
        who(v, g.id) +
        '</em><b>' +
        esc(gainsText(g)) +
        '</b></span>',
    )
    .join('');
  return (
    '<div class="eventResult" data-stage="result">' +
    (answers
      ? '<div class="eventAnswers" aria-label="同时亮出选择">' +
        answers +
        '</div>'
      : '') +
    (dice ? '<div class="eventDice">' + dice + '</div>' : '') +
    (r.facts.length
      ? '<p class="eventFacts">' + r.facts.map(esc).join(' · ') + '</p>'
      : '') +
    '<div class="eventGains" aria-label="本次收支">' +
    (gains || '本次收支持平') +
    '</div></div>'
  );
}
export function interactionPanel(v, preview) {
  const x = v.interaction,
    card = eventCards[x.event],
    can = x.actors.includes(v.self);
  const role = x.role === 'top' ? '本手头名' : '本手末名';
  const title = card?.name || (can ? '选互动牌' : '等发起人选牌');
  const choice = eventDecision(v, preview);
  let body;
  if (x.stage === 'offer') body = offer(v, x, can, choice);
  else if (x.stage === 'result') body = receipt(v, x);
  else body = argument(v, x, card, can, choice);
  let previewText = '';
  if (choice?.type === 'eventPick') {
    const selected = eventCards[x.offers[choice.slot]];
    previewText = selected ? eventHint(selected, v.scoreOnly, true) : '牌面保密，确认后翻开并发动。';
  }
  const confirmLabel = x.stage === 'offer' ? (choice?.slot === 2 ? '确认翻牌' : '确认选牌') :
    x.stage === 'target' ? '确认人选' : '确认锁定';
  return (
    '<section class="central eventPanel" data-stage="' +
    x.stage +
    '" data-role="' +
    x.role +
    '">' +
    '<div class="eventHeading"><span>' +
    role +
    ' · <b>' +
    who(v, x.host) +
    '</b></span>' +
    (x.target ? '<span>↔ ' + who(v, x.target) + '</span>' : '') +
    '</div>' +
    '<h2>' +
    (card
      ? '<i class="revealedMark ' +
        (x.blind ? 'turned' : '') +
        '" aria-hidden="true">' +
        esc(card.mark) +
        '</i>'
      : '') +
    esc(title) +
    (card
      ? '<button class="eventRuleButton" data-act="eventInfo" data-val="' +
        card.id +
        '" aria-label="查看互动玩法">ⓘ</button>'
      : '') +
    '</h2><div class="eventBody">' +
    (card && x.stage !== 'result'
      ? '<p class="eventRules">' + esc(eventHint(card, v.scoreOnly, true)) + '</p>'
      : '') +
    body +
    (can && x.stage === 'offer' ? '<p class="eventPreview" aria-live="polite">' + esc(previewText || '点牌看效果') + '</p>' : '') +
    '</div>' + (can && x.stage !== 'result' ? '<div class="eventDecision">' +
      button(confirmLabel, 'eventConfirm', '', 'gold', !choice) + '</div>' : '') +
    '</section>'
  );
}
export function handReminder(v) {
  const mine = v.showdown.find((r) => r.id === v.self);
  const high =
    v.showdown.find((r) => r.rank === 1 && r.id !== v.self) || v.showdown[0];
  const row = (name, r) =>
    r
      ? '<div class="eventHand"><b>' +
        name +
        '</b><span class="eventPips">' +
        r.main
          .map(
            (c) =>
              '<span class="' +
              (['h', 'd'].includes(c.suit) ? 'red' : '') +
              '">' +
              esc(ranked(c.rank) + suit(c.suit)) +
              '</span>',
          )
          .join('') +
        '</span><b>' +
        r.points +
        '分</b></div>'
      : '';
  return (
    '<div class="eventHands">' +
    row('我的主手', mine) +
    row('本战最高', high) +
    '</div>'
  );
}
// Animate the same settled wallet changes all clients receive. Never roll another outcome here.
export function animateEvent(v, reduced, blindSource) {
  const x = v.interaction;
  if (!x || reduced || !el('world').animate) return;
  const nodes = [...document.querySelectorAll('#seatTags [data-seat]')];
  function rect(node) {
    const b = node?.getBoundingClientRect();
    return b?.width
      ? { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      : null;
  }
  const center = rect(document.querySelector('.eventPanel h2'));
  if (!center) return;
  if (blindSource?.width) {
    const card=eventCards[x.event];
    const element=document.createElement('div');
    element.className='eventReveal';
    element.setAttribute('aria-hidden','true');
    element.innerHTML='<div><span class="eventRevealBack"></span><span class="eventRevealFace"><b>'+esc(card.mark)+'</b>'+esc(card.name)+'</span></div>';
    Object.assign(element.style,{left:center.x+'px',top:center.y+'px'});
    document.body.append(element);
    const sx=blindSource.left+blindSource.width/2-center.x;
    const sy=blindSource.top+blindSource.height/2-center.y;
    const moving=element.animate([
      {transform:'translate(calc(-50% + '+sx+'px),calc(-50% + '+sy+'px)) scale(.75)',opacity:1},
      {transform:'translate(-50%,-50%) scale(1)',opacity:1,offset:.32},
      {transform:'translate(-50%,-50%) scale(1)',opacity:1,offset:.78},
      {transform:'translate(-50%,-60%) scale(.88)',opacity:0}
    ],{duration:1050,easing:'ease-in-out'});
    element.firstElementChild.animate([{transform:'rotateY(0deg)'},{transform:'rotateY(180deg)'}],
      {duration:620,delay:160,fill:'forwards',easing:'ease-in-out'});
    moving.onfinish=moving.oncancel=()=>element.remove();
  }
  for (const die of document.querySelectorAll('.eventDie')) {
    const glyphs='⚀⚁⚂⚃⚄⚅';
    const value=glyphs.indexOf(die.textContent);
    if (value<0) continue;
    const reel=document.createElement('span');reel.setAttribute('aria-hidden','true');reel.className='eventDiceReel';
    for(const offset of [2,4,1,3,5,0]){
      const face=document.createElement('i');face.textContent=glyphs[(value+offset)%6];reel.append(face);
    }
    die.append(reel);
    const rolling=reel.animate([{transform:'translateY(0)'},{transform:'translateY(-83.33333%)'}],
      {duration:680,easing:'steps(5, end)',fill:'forwards'});
    rolling.onfinish=rolling.oncancel=()=>reel.remove();
  }
  const pos = (id) => rect(nodes.find((n) => n.dataset.seat === id));
  function travel(from, to, value, delay) {
    if (!from || !to) return;
    const piece = document.createElement('span');
    piece.setAttribute('aria-hidden', 'true');
    piece.className = 'eventFlight';
    piece.textContent = value;
    Object.assign(piece.style, { left: from.x + 'px', top: from.y + 'px' });
    document.body.append(piece);
    const dx = to.x - from.x,
      dy = to.y - from.y;
    const flight = piece.animate(
      [
        { opacity: 0, transform: 'translate(-50%, -50%) scale(.6)' },
        { opacity: 1, offset: 0.18 },
        { opacity: 1, offset: 0.76 },
        {
          opacity: 0,
          transform:
            'translate(calc(-50% + ' +
            dx +
            'px),calc(-50% + ' +
            dy +
            'px)) scale(1.15)',
        },
      ],
      { duration: 920, delay, easing: 'ease-in-out', fill: 'backwards' },
    );
    flight.onfinish = flight.oncancel = () => piece.remove();
  }
  if (x.stage === 'result') {
    const lines = x.result.gains;
    lines.forEach((g, i) => {
      if (g.silver < 0)
        travel(pos(g.id), center, Math.abs(g.silver) + '银', i * 65);
      const earned = gainsText({ ...g, silver: Math.max(0, g.silver) });
      if (earned)
        travel(
          center,
          pos(g.id),
          earned,
          lines.some((p) => p.silver < 0) ? 1050 + i * 65 : 500 + i * 65,
        );
    });
  } else if (x.target) travel(pos(x.host), pos(x.target), '✦', 40);
}

// Leave dense rosters, an open guide, and both comparison hands in their measured spaces.
export function fitTableDecision() {
  const world = el('world'), center = el('center');
  const w = world.getBoundingClientRect();
  const tools = el('topTools').getBoundingClientRect();
  const status = el('tableStatus')?.getBoundingClientRect();
  world.style.setProperty('--tools-inset', Math.ceil(w.right - tools.left + 5) + 'px');
  world.style.setProperty('--status-end', Math.max(0, Math.ceil((status?.right || w.left) - w.left + 5)) + 'px');
  const reward = world.dataset.phase === 'growth';
  if ((!reward && world.dataset.phase !== 'interact') || center.hidden) return;
  const c = center.getBoundingClientRect();
  if (!w.width || !c.width) return;
  const portrait = w.height > w.width;
  const obstacles = ['topTools','bookPanel','route', ...(portrait ? ['scoreboard'] : [])];
  let top = 8;
  for (const id of obstacles) {
    const node=el(id);
    if (!node || node.hidden) continue;
    const b=node.getBoundingClientRect();
    if (b.width && b.right>c.left && b.left<c.right) top=Math.max(top,b.bottom-w.top+4);
  }
  const hand = el('hand').getBoundingClientRect();
  const bottom = hand.height ? Math.max(0,w.bottom-hand.top+5) : 8;
  world.style.setProperty('--decision-top',Math.ceil(top)+'px');
  world.style.setProperty('--decision-bottom',Math.ceil(bottom)+'px');
  if (reward) return;
  // Safari can keep an old intrinsic button height after a rotation. Size the
  // hit area from the painted lines, including long names at larger text sizes.
  for (const label of center.querySelectorAll('.eventOptions button > span')) {
    const range = document.createRange();
    range.selectNodeContents(label);
    const lines = Array.from(range.getClientRects()).filter(line => line.width && line.height);
    if (!lines.length) continue;
    const button = label.parentElement;
    const style = getComputedStyle(button);
    const verticalInset = ['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth']
      .reduce((sum, key) => sum + parseFloat(style[key]), 0);
    const height = Math.ceil(Math.max(...lines.map(line => line.bottom)) -
      Math.min(...lines.map(line => line.top)) + verticalInset + 2) + 'px';
    if (button.style.getPropertyValue('--option-height') !== height)
      button.style.setProperty('--option-height', height);
  }
}

