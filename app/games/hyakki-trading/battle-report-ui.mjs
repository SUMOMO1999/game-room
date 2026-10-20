import { buildBattleReport, discardProvenance } from './battle-report-model.mjs';
import { GOODS, getCard } from './content/definitions.mjs';
import { dialogEscape as esc } from './game-dialog-ui.mjs';

const button = (action, label, fields = {}, disabled = false) => `<button type="button" data-hy-battle="${action}" data-hy-battle-fields="${esc(JSON.stringify(fields))}" ${disabled ? 'disabled' : ''}>${label}</button>`;
const cardName = id => { try { return getCard(id).name; } catch { return null; } };
const playerName = (players, id) => players.find(player => player.id === id)?.name ?? '伙伴';
const signed = value => value > 0 ? `＋${value}` : `−${Math.abs(value)}`;

/** Render only identities and deltas that the public transport actually disclosed. */
export function publicGroupResult(group, players) {
  return (group.changes ?? []).map(change => {
    const parts = [];
    if (change.silver) parts.push(`银两${signed(change.silver)}`);
    for (const good of change.goods ?? []) {
      const label = GOODS.find(item => item.id === good.id)?.name;
      if (label && good.delta) parts.push(`${label}${signed(good.delta)}`);
    }
    if (change.handCount) parts.push(`手牌${signed(change.handCount)}`);
    for (const id of change.toolsAdded ?? []) if (cardName(id)) parts.push(`装入${cardName(id)}`);
    for (const id of change.toolsRemoved ?? []) if (cardName(id)) parts.push(`移除${cardName(id)}`);
    return parts.length ? `${playerName(players, change.seatId)}：${parts.join('，')}` : '';
  }).filter(Boolean);
}

function groupMarkup(group, entries, players, formatEvent) {
  const publicIds = new Set([group.sourceCardId, ...entries.flatMap(({event}) => [event.cardId, ...(event.cardIds ?? [])])].filter(id => cardName(id)));
  const results = publicGroupResult(group, players);
  const reasons = { used:'使用后弃置', 'draw-discarded':'摸看后弃置', replaced:'替换装备', payment:'作为费用', response:'用于回应', 'auction-unsold':'拍卖未成交', removed:'被移除' };
  const discarded = (group.discard?.added ?? []).filter(item => cardName(item.cardId)).map(item => `${item.actorSeatId?`${playerName(players,item.actorSeatId)} · `:''}${cardName(item.cardId)}${reasons[item.reason] ? ` · ${reasons[item.reason]}` : ' · 来源未记录'}`);
  return `<li class="hy-battle-step" data-history-sequence="${group.sequence}"><ol>${entries.map(({event}) => `<li>${esc(formatEvent(event, players))}</li>`).join('')}</ol>${publicIds.size ? `<div class="hy-battle-cards">${[...publicIds].map(id => `<button type="button" data-hy-read-card="${esc(id)}" aria-label="阅读${esc(cardName(id))}原牌文">${esc(cardName(id))} ↗</button>`).join('')}</div>` : ''}${results.length ? `<p class="hy-battle-result">${results.map(esc).join('<br>')}</p>` : ''}${discarded.length ? `<p class="hy-battle-discard">弃牌：${discarded.map(esc).join('；')}</p>` : ''}</li>`;
}

/** One inspector owner. Transport pages never become the reader's logical pages. */
export function mountBattleReport({ dialog, title, body, getContext, requestPage, formatEvent }) {
  let active = false, destroyed = false, epoch = 0, busy = false;
  let groups = new Map(), coverage = {}, loadedStart = 1, loadedHead = 0, targetHead = 0, origin = 1, earlierThan = null;
  let model = null, selectedPlayer = null, selectedTurn = null, following = true, error = '', lastScroll = 0, readingHead = 0;
  let reportContext = null;
  // A read-through cache of server public groups, scoped to this mounted identity.
  // Closing a reader cancels work; it does not force another download next time.
  let cacheScope = null, publicCache = new Map(), cachedCoverage = {};
  const context = () => getContext();
  const scopeOf = value => [value?.roomId, value?.game?.matchId, value?.selfId, value?.selfRole].join(':');
  const rebuild = () => {
    const current = context();
    const first = [...groups.values()].sort((a,b)=>a.sequence-b.sequence)[0];
    const explicit = first?.schemaVersion === 2 ? first.turn : null;
    const readingCoverage = explicit ? { ...coverage, startSequence:first.sequence,
      firstTurn:{id:explicit.id,number:explicit.number,round:explicit.round,ownerId:explicit.ownerSeatId},
      partialStart:first.sequence > origin || coverage.partialStart === true } : coverage;
    model = buildBattleReport([...groups.values()], { game:current.game, players:reportContext.matchPlayers ?? reportContext.players, coverage:readingCoverage });
    const players = model.players;
    if (following) {
      selectedPlayer = model.currentPlayerId ?? players[0]?.id ?? null;
      const player = players.find(item => item.id === selectedPlayer);
      selectedTurn = model.currentTurnId ?? player?.turns?.at(-1) ?? player?.turnIds?.at(-1) ?? null;
    } else if (!players.some(player => player.id === selectedPlayer)) selectedPlayer = players[0]?.id ?? null;
    const ownTurns = model.turns.filter(turn => turn.ownerId === selectedPlayer);
    if (!ownTurns.some(turn => turn.id === selectedTurn)) selectedTurn = ownTurns.at(-1)?.id ?? null;
  };
  function render({ resetScroll = false } = {}) {
    if (!active || destroyed) return;
    const old = body.querySelector('[data-hy-battle-scroll]');
    const top = resetScroll ? 0 : old?.scrollTop ?? 0;
    const turns = model?.turns.filter(turn => turn.ownerId === selectedPlayer) ?? [];
    const turn = turns.find(item => item.id === selectedTurn), index = turns.indexOf(turn);
    const players = model?.players ?? (reportContext.matchPlayers ?? reportContext.players ?? []);
    const pending = context()?.game?.pending;
    const responseDue = pending?.actorId === context()?.selfId;
    const packetGroups = new Map((turn?.groups ?? []).map(group => [group.sequence, group]));
    const entriesByGroup = new Map();
    for (const entry of turn?.entries ?? []) {
      const list = entriesByGroup.get(entry.sequence) ?? []; list.push(entry); entriesByGroup.set(entry.sequence, list);
    }
    const steps = [...entriesByGroup].map(([sequence, entries]) => groupMarkup(packetGroups.get(sequence) ?? groups.get(sequence) ?? { sequence }, entries, players, formatEvent));
    const turnLabel = turn ? `${playerName(players, selectedPlayer)} · 第${turn.playerTurnNumber ?? index + 1}回合${turn.ongoing ? ' · 进行中' : ''}` : `${playerName(players, selectedPlayer)} · 尚未轮到`;
    const incomplete = !!turn?.partial || !turn && !!model?.partial;
    const status = error || (busy ? '正在读取本局战况…' : model?.unassigned?.length ? '部分记录的回合归属不明确，请展开查看。' : !following && targetHead > readingHead ? '有新的战况；你正在阅读的回合保持原位。' : incomplete ? '部分历史尚未完整记录；缺失步骤不会补猜。' : loadedStart > origin ? '本回合已完整读取；更早回合可继续向前查看。' : '已读取至当前确认的步骤。');
    const unassigned = model?.unassigned?.length ? `<details class="hy-battle-unassigned"><summary>未归属回合的记录 · ${model.unassigned.length}组</summary><p>部分记录尚不能确定回合主人，以下内容未计入任何玩家回合。</p><ol class="hy-battle-steps">${model.unassigned.map(group => groupMarkup(group,group.events.map((event,index)=>({event,index,sequence:group.sequence})),players,formatEvent)).join('')}</ol></details>` : '';
    title.textContent = '战况';
    body.innerHTML = `<section class="hy-battle-report" aria-label="本局战况"><nav class="hy-battle-tabs" aria-label="玩家">${players.map(player => `<button type="button" data-hy-battle="player" data-hy-battle-fields="${esc(JSON.stringify({id:player.id}))}" aria-pressed="${player.id === selectedPlayer}">${esc(player.name)}</button>`).join('')}</nav><div class="hy-battle-page-controls"><div><strong>${esc(turnLabel)}</strong>${turn ? `<small>本局第${turn.number}回合 · 第${turn.round}轮</small>` : ''}</div><nav aria-label="该玩家的回合">${button('page','上一回合',{id:turns[index - 1]?.id,older:index <= 0}, index <= 0 && loadedStart <= origin || busy)}<span>${index < 0 ? 0 : (turn?.playerTurnNumber ?? index + 1)} / ${turns.at(-1)?.playerTurnNumber ?? turns.length}${loadedStart > origin ? '（可向前读取）' : ''}</span>${button('page','下一回合',{id:turns[index + 1]?.id},index < 0 || index === turns.length - 1)}</nav></div><div class="hy-battle-status" role="status"><span>${esc(status)}</span>${error ? button('retry','重试') : ''}${!following ? button('current','回到当前') : ''}${responseDue ? button('table','轮到你回应 · 回到桌面') : ''}</div><div class="hy-battle-scroll" data-hy-battle-scroll="true" tabindex="0" aria-label="${esc(turnLabel)}的完整过程"><ol class="hy-battle-steps">${steps.join('')}</ol>${!steps.length ? `<p>${busy ? '正在查找这一回合…' : turn?.ongoing ? '本回合尚未行动。' : '暂无可读取的步骤。'}</p>` : ''}${incomplete ? '<p class="hy-battle-partial">本页含未完整记录的历史。</p>' : ''}${unassigned}</div></section>`;
    const scroll = body.querySelector('[data-hy-battle-scroll]');
    scroll.scrollTop = following && !resetScroll ? scroll.scrollHeight : top;
    lastScroll = scroll.scrollTop;
  }
  async function load() {
    if (busy || !active || destroyed) return;
    busy = true; error = ''; const stamp = epoch, scope = scopeOf(reportContext), capturedHead = targetHead;
    render();
    let requests = 0;
    const live = () => active && !destroyed && stamp === epoch && scope === scopeOf(context());
    async function readRange(start, end) {
      let after = start;
      while (live() && after < end) {
        // History GETs are sequential and gently paced; no parallel identity burst.
        if (requests++) await new Promise(resolve => setTimeout(resolve,80));
        if (!live()) return;
        const page = await requestPage({ after, limit:50 });
        if (!live()) return;
        if (!page || !Array.isArray(page.groups)) throw new Error('本局战况暂时无法读取。请重试。');
        if (page.matchId && page.matchId !== reportContext.game.matchId || page.roomId && page.roomId !== reportContext.roomId) throw new Error('战况不属于当前牌局，请重新打开。');
        coverage = { ...coverage, ...(page.coverage ?? {}) };
        origin = Math.max(origin, coverage.startSequence ?? 1);
        for (const group of page.groups) if (Number.isSafeInteger(group.sequence) && group.sequence > start && group.sequence <= end) {
          const previous=groups.get(group.sequence);
          if(previous&&JSON.stringify(previous)!==JSON.stringify(group))throw new Error('同一步骤的战况不一致，请重新核对牌局。');
          groups.set(group.sequence, group);publicCache.set(group.sequence, group);
        }
        cachedCoverage={...coverage};
        const next = Math.min(end, Number(page.nextAfter));
        if (!Number.isSafeInteger(next) || next <= after) throw new Error('战况读取中断，已读内容已保留。请重试。');
        after = next;
        const sequences = [...groups.keys()];
        loadedStart = sequences.length ? Math.min(...sequences) : origin;
        loadedHead = sequences.length ? Math.max(...sequences) : 0;
        rebuild(); render();
        if (!page.hasMore && after < end) throw new Error('早期战况尚未完整载入。请重试。');
      }
    }
    try {
      if (!groups.size) await readRange(Math.max(0,capturedHead-50),capturedHead);
      else if (loadedHead < capturedHead) await readRange(loadedHead,capturedHead);
      while (live() && loadedStart > origin) {
        // Legacy groups need a continuous origin before their owner can be known.
        const legacy = [...groups.values()].some(group=>group.schemaVersion!==2 || !group.turn);
        const previous = earlierThan && model.turns.filter(turn=>turn.ownerId===selectedPlayer && turn.number<earlierThan).at(-1);
        if (previous) { selectedTurn=previous.id;earlierThan=null;rebuild();render({resetScroll:true}); }
        const selected = model.turns.find(turn=>turn.id===selectedTurn && turn.ownerId===selectedPlayer);
        if (!legacy && selected && !selected.partial && !earlierThan) break;
        await readRange(legacy?origin-1:Math.max(origin-1,loadedStart-51),loadedStart-1);
      }
      if(live()&&earlierThan){const previous=model.turns.filter(turn=>turn.ownerId===selectedPlayer&&turn.number<earlierThan).at(-1);if(previous)selectedTurn=previous.id;earlierThan=null;}
    } catch (cause) {
      if (active && stamp === epoch) error = cause.message || '战况暂时无法读取。请重试。';
    } finally {
      if (stamp === epoch) {
        busy = false;
        if (active) { rebuild(); render(); if (!error && targetHead > capturedHead) void load(); }
      }
    }
  }
  function close() {
    active = false; epoch++; busy = false; dialog.classList.remove('hy-battle-dialog');
    groups.clear(); model = null; reportContext = null;
  }
  const onClose = () => close();
  dialog.addEventListener('close', onClose);
  return {
    open() {
      if (destroyed || !context()?.game) return;
      close(); active = true; reportContext = context();
      const scope=scopeOf(reportContext);
      if(scope!==cacheScope){publicCache.clear();cachedCoverage={};cacheScope=scope;}
      groups = new Map([...publicCache].filter(([sequence])=>sequence<=reportContext.game.publicEventSequence));coverage={...cachedCoverage};origin=coverage.startSequence??1;
      loadedStart=groups.size?Math.min(...groups.keys()):origin;loadedHead=groups.size?Math.max(...groups.keys()):0;earlierThan=null;
      targetHead = Math.max(0, reportContext.game.publicEventSequence ?? 0);
      selectedPlayer = null; selectedTurn = null; following = true; error = ''; lastScroll = 0; readingHead = targetHead;
      dialog.classList.add('hy-battle-dialog'); rebuild(); render({resetScroll:true}); dialog.showModal(); void load();
    },
    sync() {
      if (!active || destroyed) return;
      if (scopeOf(reportContext) !== scopeOf(context())) return close();
      targetHead = Math.max(targetHead, context().game?.publicEventSequence ?? 0);
      rebuild(); render(); if (!busy && loadedHead < targetHead) void load();
    },
    handle(action, fields = {}) {
      if (!active || destroyed) return;
      if (action === 'table') { dialog.close(); return; }
      if (action === 'retry') { void load(); return; }
      if (action === 'current') following = true;
      if (action === 'player' && model.players.some(player => player.id === fields.id)) {
        following = false; readingHead = targetHead; selectedPlayer = fields.id;
        selectedTurn = model.turns.filter(turn => turn.ownerId === selectedPlayer).at(-1)?.id ?? null;
      }
      if (action === 'page' && fields.older && loadedStart>origin) { following=false;readingHead=targetHead;earlierThan=model.turns.find(turn=>turn.id===selectedTurn)?.number??Infinity; }
      else if (action === 'page' && model.turns.some(turn => turn.id === fields.id && turn.ownerId === selectedPlayer)) { following = false; readingHead = targetHead; selectedTurn = fields.id; }
      rebuild(); render({resetScroll:true});
      if(action==='player'||action==='page'||action==='current')void load();
    },
    scroll(node) {
      if (!active || node?.getAttribute?.('data-hy-battle-scroll') !== 'true') return;
      if (node.scrollTop < lastScroll - 2) { following = false; readingHead = targetHead; render(); }
      lastScroll = node.scrollTop;
    },
    close,
    invalidate() { close();publicCache.clear();cachedCoverage={};cacheScope=null; },
    discardOrigins(discard) {
      const same=cacheScope===scopeOf(context());
      const knownGroups=same?[...publicCache.values()].filter(group=>group.sequence<=(context()?.game?.publicEventSequence??0)):[];
      // Equal pile lengths or definitions cannot bridge a newer unobserved commit.
      const current=knownGroups.length>0&&Math.max(...knownGroups.map(group=>group.sequence))===context()?.game?.publicEventSequence;
      return {items:discardProvenance(current?knownGroups:[],discard),loaded:current};
    },
    destroy() { if (destroyed) return; close();publicCache.clear();cachedCoverage={};cacheScope=null;destroyed = true; dialog.removeEventListener('close', onClose); }
  };
}
