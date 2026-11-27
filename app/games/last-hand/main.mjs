import { defaults, settings } from './rules/match.mjs';
import { items, cast, itemDescription } from './rules/catalog.mjs';
import { bestSelection } from './rules/poker.mjs';
import { battleRelics, battlesPerChapter } from './rules/table.mjs';
import { drawTable, draftFor, effectReady, effectStatus, possibleSource } from './table-view.mjs';
import { dealMarket, playbackFor, syncAward } from './auction-playback.mjs';
import { arenaAmbience } from './ambience.mjs';
import { mountGestures } from './gestures.mjs';
import {
  el,
  paint,
  esc,
  button,
  notify,
  dialog,
  showDetail, closeDetail, followDetail, refreshDetail,
  getObj,
  saveObj,
  unique,
  gem,
} from './widgets.mjs';
import { foyer, setup, friends, waiting, lengthControls, healthControl } from './foyer.mjs';
import { timeControls, readTimers, togglePracticeLimit } from './timing.mjs';
import { book, closeBook, toggleBook, restoreBook, syncBook, auctionBill, battleBill } from './book.mjs';
import {
  createPractice,
  readPractice,
  savedPractice,
  practiceAction,
  practiceTick,
  reschedulePractice,
  rememberResult,
} from './practice.mjs';
import { lobbyHref } from './room-bridge.mjs';
import { request, connectRoom } from './online.mjs';
import { mountRoomSettings } from '../../platform/room-settings.mjs';
import { roomChatMarkup, mountRoomChat } from '../../room-chat.mjs';
import { showRoomTools, memberList, leaveConsequence } from './room-menu.mjs';
import { accountState, onAccountChange, loginHref, loadAccount, logoutAccount } from '../../account-client.mjs';
import { createGameAudio } from '../../game-audio.mjs';

const prefs = getObj('olh:pref:1') || {},
  audio = createGameAudio({ samples: {} });
const lastHealth = prefs.cfg?.health;
const preferredHealth = Number.isInteger(lastHealth) && lastHealth >= 5 && lastHealth <= 25 &&
  (prefs.healthRange === 1 || lastHealth !== 5) ? lastHealth : defaults.health;
let cfg = { ...defaults, ...prefs.cfg, health: preferredHealth },
  nick = prefs.nick || '牌友',
  v = null,
  d = null,
  room = null,
  connection = null,
  stage = null,
  playback = null,
  mode = 'home',
  busy = false,
  ticking = false,
  info = null,
  seenResult = null,
  online = true,
  confirmation = null,
  detail = null,
  sceneFault = '';
const ambience = arenaAmbience(() => audio.state());
audio.onStateChange(() => ambience.sync());
document.body.insertAdjacentHTML('beforeend', roomChatMarkup());
const chat = mountRoomChat({ onCue: kind => audio.play(kind), onUnavailable: error => {
  if (room && [401, 403, 404].includes(error.status)) document.dispatchEvent(new Event('last-hand-seat-ended'));
} });
const settingsMenu = mountRoomSettings({
  document,
  buttonId: 'settingsBtn',
  dialogId: 'settings',
  closeButtonId: 'closeSettings',
});
const picker = el('settings').querySelector('[data-theme-picker]');
if (picker) el('settings').querySelector('.settingsBody').append(picker);
audio.bindPreview({select: el('soundCue'), button: el('soundPreview'), status: el('previewStatus')});
el('leaveBtn').href = lobbyHref();
function updateTools() {
  showRoomTools({ room, view: v, mode, online, account: accountState() });
  refreshDetail('members', () => memberList(room, v));
}
onAccountChange(updateTools);
function savePrefs() {
  Object.assign(prefs, { cfg, nick, healthRange: 1 });
  saveObj('olh:pref:1', prefs);
}
const muted = audio.state().muted;
el('sound').checked = !muted;
el('volume').value = Math.round(audio.state().volume * 100);
el('motion').checked = prefs.reduced ?? matchMedia('(prefers-reduced-motion:reduce)').matches;
el('fast').checked = !!prefs.fast;
el('sound').onchange = (e) => {
  audio.setMuted(!e.target.checked);
  if (e.target.checked) audio.preview('select');
};
el('volume').oninput = (e) => audio.setVolume(+e.target.value / 100);
el('motion').onchange = (e) => {
  prefs.reduced = e.target.checked;
  savePrefs();
  scene();
};
el('fast').onchange = (e) => {
  prefs.fast = e.target.checked;
  savePrefs();
};
const nav = el('topTools');
el('sheet').querySelector('header button').onclick = () => el('sheet').close();
el('sheet').addEventListener('close', () => {
  if (!el('sheet').open) { detail = null; confirmation = null; }
});
el('settingsBtn').addEventListener('click', () => {
  chat.model.setOpen(false);
  updateTools();
  requestAnimationFrame(() => {
    const settingsDialog = el('settings');
    if (settingsDialog.open) settingsDialog.querySelector('.settingsBody').scrollTop = 0;
  });
  if (!room && !accountState().authenticated) void loadAccount().catch(() => {});
});
el('codexBtn').onclick = () => toggleBook(v);
el('bookSection').onchange = (event) => book(event.target.value, v);
nav.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el('bookPanel').hidden &&
      (event.target === el('codexBtn') || el('bookPanel').contains(event.target))) {
    event.preventDefault();
    closeBook();
  }
});
el('leaveBtn').addEventListener('click', stash);
const demoCast = [cast[0], cast[9], cast[2], cast[3], cast[1], cast[5]];
function previewCast() {
  const chosen = cast.find((p) => p.id === cfg.ego) || cast[0];
  return [chosen, ...demoCast.filter((p) => p.id !== chosen.id)].slice(0, 6);
}
function scene() {
  const reduced = el('motion').checked;
  el('world').classList.toggle('reduced', reduced);
  ambience.sync(v?.settings.arena || cfg.arena, !!v);
  if (!stage) return;
  let event = null;
  if (v?.phase === 'award')
    event = {
      kind: 'auction',
      serial: v.matchId + '/' + v.epoch,
      playback,
      award: v.award,
    };
  if (v?.phase === 'hit' && v.hit)
    event = { kind: 'strike', serial: v.epoch, attacker: v.hit.actor, target: v.hit.target };
  if (v?.phase === 'finish')
    event = { kind: 'finish', serial: v.epoch, winners: v.result.winnerIds };
  stage.update({
    arena: v?.settings.arena || cfg.arena,
    scoringVersion: v?.scoringVersion || 1,
    phase: v?.phase || 'home',
    reduced,
    event,
    selected: d?.card,
    market: v?.market || [],
    players: v
      ? v.players.map((p) => ({ ...p, mine: p.id === v.self }))
      : previewCast().map((p, i) => ({
          id: 'preview' + i,
          name: p.name,
          ego: p.id,
          mine: i === 0,
        })),
  });
}
async function initScene() {
  try {
    const { mountArena } = await import('./assets/arena.js');
    stage = mountArena(el('arena'), (e) => {
      sceneFault = e.message;
      notify('角色资源载入失败，可在设置重载场地');
    });
    el('world').dataset.physical = 'true';
    scene();
    Object.defineProperty(el('arena'), 'arenaStats', {
      configurable: true,
      get: () => ({ ...stage.stats(), fault: sceneFault }),
    });
  } catch (e) {
    delete el('world').dataset.physical;
    sceneFault = e.message;
    notify('立体场地未能载入，设置里可重载');
    console.error(e);
  }
}
const restoreScene = document.createElement('button');
restoreScene.className = 'sheetAction';
restoreScene.textContent = '重载场地';
restoreScene.onclick = () => {
  stage?.dispose();
  stage = null;
  delete el('world').dataset.physical;
  sceneFault = '';
  initScene();
};
el('settings').querySelector('.settingsBody').append(restoreScene);
function setEntry(html) {
  closeDetail();
  el('world').dataset.screen = 'home';
  delete el('world').dataset.phase;
  syncAward(null, null, true);
  el('route').hidden = true;
  updateTools();
  for (const id of [
    'scoreboard',
    'seatTags',
    'market',
    'center',
    'actions',
    'hand',
    'relics',
    'tools',
  ])
    paint(id, '');
  paint('home', html);
  el('home').hidden = false;
  syncBook(null);
  scene();
}
async function home() {
  connection?.close();
  connection = null;
  chat.clear();
  el('sheet').close();
  v = d = room = null;
  mode = 'home';
  history.replaceState(null, '', location.pathname);
  const saved = await savedPractice().catch(() => null);
  if (mode === 'home') setEntry('<a class="return" href="' + esc(lobbyHref()) + '">‹ 棋牌室大厅</a>' + foyer(saved));
}
async function showFriends(code = '') {
  mode = 'friends';
  info = await request();
  if (mode !== 'friends') return;
  if (info.signedOut) {
    const back = /^\d{6}$/.test(code) ? '/last-hand.html?code=' + code : '/last-hand.html';
    setEntry('<h2>朋友同桌</h2><p>用棋牌室账号登录，和朋友坐到同一桌。</p><div class="choices"><a class="gold" href="' +
      esc(loginHref(back)) + '">登录棋牌室</a>' + button('返回', 'home') + '</div>');
    return;
  }
  if (info.nickname) nick = info.nickname;
  setEntry(friends(info, nick, typeof code === 'string' ? code : ''));
  fillRoomNickname(el('joinName'));
}
// The public room supplies each member's nickname to every seat. The official
// same-origin entrance can also fill a verified profile before the first hand.
async function fillRoomNickname(field) {
  const original = field.value;
  let nickname;
  try {
    if (window.isSecureContext || location.protocol === 'http:') {
      const account = await loadAccount();
      if (account.authenticated) nickname = account.profile?.nickname;
    } else if (field.name === 'nick') {
      nickname = (await request()).nickname;
    }
  } catch { /* Offline practice keeps the nickname already in this browser. */ }
  if (nickname && field.isConnected && field !== document.activeElement && field.value === original) {
    field.value = nickname;
  }
}
function startSetup(remote) {
  if (cfg.health === 3) cfg = { ...cfg, health: defaults.health };
  mode = remote ? 'setupRoom' : 'setup';
  setEntry(setup(remote ? cfg : { ...cfg, matchMinutes: 0 }, nick, remote));
  fillRoomNickname(el('config').elements.nick);
}
function readSetup() {
  const form = el('config');
  const timers = readTimers(form);
  if (!timers) return false;
  const f = new FormData(form);
  nick = String(f.get('nick') || '')
    .trim()
    .slice(0, 16);
  if (!nick) throw Error('填写棋牌室昵称');
  cfg = settings({
    ...cfg,
    ...timers,
    seats: Number(f.get('seats')),
    mode: f.get('mode'),
    sections: Number(f.get('sections')),
    ego: f.get('ego'),
    arena: f.get('arena'),
    style: f.get('style'),
    health: Number(f.get('health')),
    tiers: f.get('tiers'),
    chips: Number(f.get('chips')),
    expansion: f.has('expansion'),
    public: f.has('public'),
    fast: false,
  });
  savePrefs();
  return true;
}
const draftKey = () => (v ? 'olh:draft:' + v.matchId + ':' + v.self : '');
function stash() {
  if (v && d) saveObj(draftKey(), d);
}
import {animateEvent,eventInfo,eventDecision,fitTableDecision} from './interaction-view.mjs';
let layoutFrame = 0;
let viewportChanged = false;
function scheduleTableLayout(redraw = false) {
  viewportChanged ||= redraw;
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    const refresh = viewportChanged;
    viewportChanged = false;
    if (refresh && v) render();
    else fitTableDecision();
  });
}
const eventLayout = new ResizeObserver(() => scheduleTableLayout());
for (const id of ['world','topTools','tableStatus','route','bookPanel','scoreboard','hand']) eventLayout.observe(el(id));
function render() {
  if (!v) return;
  drawTable(v, d, room);
  followDetail();
  syncBook(v);
  updateTools();
  fitTableDecision();
  scene();
  clock();
}
let lastAuctionKey = '', lastAuctionCue = '';
function clock() {
  if (!v || !el('clock')) return;
  const now = room?.pausedAt ?? Date.now();
  const cue = syncAward(v, playback, el('motion').checked, now);
  if (cue) {
    const key = v.matchId + '/' + v.epoch;
    if (key === lastAuctionKey && cue !== lastAuctionCue && !document.hidden) {
      const sound = cue.startsWith('roll-') ? 'roll' : cue.startsWith('land-') ? 'placement' :
        { compare: 'flip', winner: 'placement', collect: 'draw' }[cue];
      if (sound) audio.play(sound);
    }
    lastAuctionKey = key;
    lastAuctionCue = cue;
  }
  const txt =
    v.deadline == null ? '终场' : Math.max(0, Math.ceil((v.deadline - now) / 1000)) + ' 秒';
  if (el('clock').textContent !== txt) el('clock').textContent = txt;
  const tableClock = el('matchClock');
  if (!tableClock.hidden) {
    const left = Math.max(0, Math.ceil((v.matchDeadline - now) / 1000));
    const text = left ? '整桌剩余 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
      : v.phase === 'growth' ? '整桌时间到，正在结算' : '整桌时间到，本战后结算';
    if (tableClock.textContent !== text) tableClock.textContent = text;
  }
}
function receive(next) {
  if (!next) return;
  const old = v,
    reset = !old || next.epoch !== old.epoch || next.matchId !== old.matchId;
  const blindSource = old?.interaction?.stage === 'offer' && next.interaction?.blind
    ? document.querySelector('.eventSlot.blind .eventCard')?.getBoundingClientRect() : null;
  v = next;
  if (v.own && old?.matchId === v.matchId && old.phase === 'growth') {
    const acquired = v.own.relics.filter(id => !old.own?.relics.includes(id));
    if (acquired.length) notify('获得技能 · ' + acquired.map(id => items[id].name).join('、'));
  }
  if (reset || !playback) playback = playbackFor(v);
  else playback.deadline = v.deadline;
  if (reset) {
    closeDetail();
    const saved = getObj(draftKey());
    d = saved?.match === v.matchId && saved?.epoch === v.epoch ? saved : draftFor(v);
    if (
      v.phase === 'growth' &&
      d.loot &&
      d.loot !== v.growth.personal &&
      !v.growth.offers.includes(d.loot)
    )
      d.loot = null;
    if (old?.phase !== v.phase) {
      const sound = {
        growth: 'turn',
        auction: 'draw',
        award: 'turn',
        build: 'sort',
        peek: 'draw',
        reveal: 'flip',
        attack: 'turn',
        hit: v.hit?.blocked && !v.hit.actual ? 'placement' : 'collision',
        finish: v.result?.winnerIds.includes(v.self) ? 'win' : 'loss',
      };
      if (sound[v.phase]) audio.play(sound[v.phase]);
    }
  }
  if (v.status === 'finished' && v.own && seenResult !== v.matchId) {
    seenResult = v.matchId;
    rememberResult(v).then(() => syncBook(v, true)).catch(() => {
      seenResult = null;
      notify('战绩暂未保存');
    });
  }
  if (reset || old?.seq !== v.seq || !old || el('world').dataset.screen !== 'table') {
    render();
    if (reset && v.phase === 'interact') {
      const x = v.interaction;
      audio.play(x.stage === 'result' ? x.result.dice.length ? 'roll' : 'placement' : x.blind ? 'flip' : 'turn');
      animateEvent(v, el('motion').checked, blindSource);
    }
    if (reset && v.phase === 'auction') dealMarket(v, el('motion').checked);
  } else clock();
}
function acceptRoom(r) {
  room = r;
  mode = 'online';
  updateTools();
  if (['playing', 'paused', 'finished'].includes(r.phase) && r.game) {
    receive(r.game);
    stage?.pause(r.phase === 'paused' || document.hidden);
    updateTools();
    return;
  }
  v = d = null;
  if (r.phase === 'aborted') {
    setEntry(
      '<h2>牌桌已收场</h2><div class="choices">' +
        (r.selfId === r.hostId ? button('原桌再开', 'again', '', 'gold') : '') +
        button('返回棋牌室', 'exit') +
        '</div>',
    );
    return;
  }
  setEntry(waiting(r));
}
function sit(r) {
  connection?.close();
  chat.clear();
  online = false;
  v = d = null;
  acceptRoom(r);
  history.replaceState(null, '', '?room=' + r.roomCode);
  connection = connectRoom(r, acceptRoom, (on) => {
    chat.connection(on ? 'online' : 'offline');
    if (online !== on) {
      online = on;
      updateTools();
      notify(on ? '已接回原席位' : '连接中断，正在回座');
    }
  }, packet => chat.receive(packet));
  chat.attach(connection, r, accountState());
  chat.connection(online ? 'online' : 'offline');
}
async function tick() {
  if (ticking || busy || document.hidden || mode !== 'practice' || !v || v.status !== 'playing')
    return;
  ticking = true;
  const id = v.matchId;
  try {
    const next = await practiceTick(id, el('fast').checked);
    if (mode === 'practice' && v?.matchId === id) {
      if (next) receive(next);
      else await home();
    }
  } catch (e) {
    notify(e.message);
  } finally {
    ticking = false;
  }
}
setInterval(tick, 300);
setInterval(clock, 250);
async function send(m) {
  if (mode === 'practice') receive(await practiceAction(v, m));
  else if (mode === 'online') await connection.action('tableMove', { move: m });
}
function selection() {
  if (!v?.own || !v.actors.includes(v.self)) throw Error('请等桌面提示轮到你');
}
function itemInfo(id, target) {
  const x = items[id];
  showDetail(target,
    x.name,
    '<div class="itemLine">' +
      gem(id) +
      '<div><b>' +
      (x.aim === 'receive' ? '即时奖励' : x.kind === 'tool' ? '一次性道具' : '持续' + x.category) +
      '　' +
      ['', 'Ⅰ', 'Ⅱ', 'Ⅲ'][x.tier] +
      '</b><p>' +
      esc(itemDescription(id, v?.scoringVersion, v?.scoreOnly)) +
      '</p></div></div>',
  );
}
async function use(id, target) {
  if (!v?.own || !effectReady(id, v)) {
    itemInfo(id, target);
    return;
  }
  closeDetail();
  if (id === 'lantern') {
    await send({ type: 'light' });
    return;
  }
  if (v.phase === 'auction') {
    d.item = d.item === id ? null : id;
    if (d.item === 'insure') d.gold = Math.max(1, d.gold);
    if (d.item === 'tail') d.gold = 0;
    notify(d.item ? itemDescription(id, v?.scoringVersion, v?.scoreOnly) : '已收回道具');
    return;
  }
  d.item = d.item === id ? null : id;
  d.source = null;
}
async function effect(values = {}) {
  const item = d.item;
  await send({ type: 'effect', item, card: d.source, ...values });
  d.item = d.source = null;
  d.main = d.main.filter((x) => v.own.hand.some((c) => c.id === x) && x !== v.own.guard);
  audio.play('merge');
  notify(items[item].name + ' 已发动');
}
async function myCard(id) {
  const c = v.own?.hand.find((c) => c.id === id);
  if (!c) return;
  if (v.phase !== 'build' || !v.actors.includes(v.self)) return;
  if (d.item) {
    if (!possibleSource(d.item, c, v.own, d)) {
      notify('这张牌不符合当前能力');
      return;
    }
    let aim = items[d.item].aim;
    if (d.source && ['sample', 'pair'].includes(aim)) {
      await effect({ second: id });
      return;
    }
    d.source = id;
    if (['one', 'defend'].includes(aim)) await effect();
    return;
  }
  if (id === v.own.guard) {
    notify('这张牌已扣作防守');
    return;
  }
  if (d.main.includes(id)) d.main = d.main.filter((x) => x !== id);
  else if (d.main.length < 5) d.main.push(id);
  else notify('主手最多五张，先点一张收回');
}
function confirmAction(title, message, label, action) {
  confirmation = { code: room?.roomCode, match: room?.matchId, phase: room?.phase, role: room?.selfRole,
    consequence: room && leaveConsequence(room), account: accountState().userKey };
  dialog(title, '<p>' + esc(message) + '</p><div class="roomMenuActions">' +
    button('取消', 'cancelMenuAction') + button(label, action, '', 'destructive') + '</div>');
}
async function perform(act, val = '', target = null) {
  switch (act) {
    case 'exit':
      stash();
      location.assign(lobbyHref());
      return;
    case 'home':
      stash();
      await home();
      return;
    case 'back':
      if (mode === 'setupRoom') await showFriends();
      else await home();
      return;
    case 'setup':
      startSetup(false);
      return;
    case 'friends':
      await showFriends();
      return;
    case 'setupRoom':
      startSetup(true);
      return;
    case 'resume': {
      mode = 'practice';
      const saved = await readPractice(true);
      if (saved) receive(saved);
      else await home();
      return;
    }
    case 'startPractice': {
      if (!readSetup()) return;
      const existing = await savedPractice();
      if (existing && !existing.finished) {
        dialog(
          '另开新桌',
          '<p>原桌打到第 ' + existing.battle + ' 战，赛程 ' + existing.settings.sections * existing.perChapter +
            ' 战，' + (existing.settings.matchMinutes ? existing.settings.matchMinutes + ' 分钟限时' : '不限时') +
            '。另开将替换这份进度。</p><p>新桌 · ' + (cfg.mode === 'score' ? '积分赛' : '生存赛') +
            ' · ' + cfg.sections * 4 + ' 战' + (cfg.mode === 'survival' ? '后进入决胜消耗' : '') + ' · ' +
            (cfg.matchMinutes ? cfg.matchMinutes + ' 分钟限时' : '不限时') + '</p><div class="choices">' +
            button('按新设置另开', 'replacePractice', '', 'gold') +
            button('沿用原桌续打', 'keepPractice') +
            '</div>',
        );
        return;
      }
      mode = 'practice';
      v = null;
      receive(await createPractice(cfg, nick));
      audio.play('start');
      return;
    }
    case 'keepPractice':
      el('sheet').close();
      mode = 'practice';
      receive(await readPractice(true));
      return;
    case 'replacePractice':
      el('sheet').close();
      mode = 'practice';
      v = null;
      receive(await createPractice(cfg, nick));
      audio.play('start');
      return;
    case 'createRoom':
      if (!readSetup()) return;
      sit((await request('', { name: nick, settings: cfg, requestId: unique() })).view);
      return;
    case 'editTimers':
      if (room?.phase === 'waiting' && room.selfId === room.hostId)
        dialog('调整本桌赛程', '<form class="setup" id="roomTimers">' + lengthControls(room.tableOptions) +
          healthControl(room.tableOptions) + timeControls(room.tableOptions, true) +
          '</form>' + button('保存赛程', 'saveTimers', '', 'gold sheetAction'));
      return;
    case 'saveTimers': {
      if (room?.phase !== 'waiting' || room.selfId !== room.hostId) throw Error('开局前由房主调整时长');
      const timers = readTimers(el('roomTimers'));
      if (!timers) return;
      const sections = Number(el('roomTimers').elements.sections.value);
      const health = Number(el('roomTimers').elements.health.value);
      await connection.action('configure', { tableOptions: settings({ ...room.tableOptions, ...timers, sections, health }, room.tableOptions.health) });
      cfg = { ...cfg, ...timers, sections, health };
      savePrefs();
      el('sheet').close();
      return;
    }
    case 'rejoin':
      sit(await request('/' + val));
      return;
    case 'join':
    case 'spectate':
    case 'joinPublic': {
      const code = act === 'joinPublic' ? val : el('roomCode').value.trim();
      if (!/^\d{6}$/.test(code)) throw Error('输入六位桌号');
      nick = el('joinName').value.trim() || nick;
      savePrefs();
      sit(
        (
          await request('/' + code + '/join', {
            name: nick,
            role: act === 'spectate' ? 'spectator' : 'player',
            requestId: unique(),
          })
        ).view,
      );
      return;
    }
    case 'ready':
      await connection.action('ready', {
        ready: !room.players.find((p) => p.id === room.selfId).ready,
      });
      return;
    case 'beSpectator':
    case 'bePlayer':
      await connection.action('set-role', { role: act === 'bePlayer' ? 'player' : 'spectator' });
      return;
    case 'startRoom':
      await connection.action('start');
      return;
    case 'again':
      if (room) {
        await connection.action('rematch');
      } else {
        mode = 'practice';
        cfg = { ...v.settings, health: v.settings.health === 3 ? defaults.health : v.settings.health };
        v = null;
        receive(await createPractice(cfg, nick));
      }
      return;
    case 'members':
      showDetail(target, room ? '成员与积分' : '练习成员', memberList(room, v));
      return;
    case 'restartPractice':
      if (mode === 'practice') { stash(); v = d = null; startSetup(false); }
      return;
    case 'editPractice':
      if (mode === 'practice' && v?.status === 'playing') {
        detail = { schedule: v };
        dialog('调整练习赛程', '<form class="setup" id="practiceSchedule">' +
          lengthControls(v.settings, battlesPerChapter(v)) + timeControls(v.settings, false, true) +
          '</form>' + button('保存到当前练习', 'savePracticeSchedule', '', 'gold sheetAction'));
      }
      return;
    case 'savePracticeSchedule': {
      const form = el('practiceSchedule');
      const timers = readTimers(form);
      if (!timers) return;
      if (!detail?.schedule) return;
      const next = await reschedulePractice(detail.schedule, { ...timers, sections: Number(form.elements.sections.value) });
      cfg = { ...next.settings };
      savePrefs();
      el('sheet').close();
      receive(next);
      notify('已更新当前练习赛程');
      return;
    }
    case 'menuRules':
      await book('rules', v);
      el('codexBtn').focus({ preventScroll: true });
      return;
    case 'votePause':
      await connection.action('pause', { agree: !room.pause?.agreedIds.includes(room.selfId) });
      return;
    case 'resumeRoom':
      await connection.action('resume');
      return;
    case 'hostChoices':
      if (room?.selfId !== room?.hostId || !room) return;
      dialog('转交房主', '<p>选择接任房主的玩家。</p>' + room.players.filter(p => p.id !== room.selfId)
        .map(p => button(p.name, 'askTransfer', p.id, 'sheetAction')).join(''));
      return;
    case 'askTransfer': {
      const next = room?.players.find(p => p.id === val);
      if (!next) throw Error('这位玩家已经离开');
      confirmAction('转交房主', '将房主交给' + next.name + '？你会继续留在原座位。', '确认转交', 'transferHost');
      confirmation.target = val;
      return;
    }
    case 'transferHost':
      if (confirmation?.code !== room?.roomCode || !confirmation?.target) return;
      await connection.action('transferHost', { playerId: confirmation.target });
      el('sheet').close();
      notify('已转交房主');
      return;
    case 'takeHost':
      await connection.action('transferHost', { playerId: room.selfId });
      return;
    case 'leaveRoom':
      if (room) confirmAction('退出房间', leaveConsequence(room), '确认退出房间', 'confirmLeave');
      return;
    case 'confirmLeave':
      if (!room || !confirmation) return;
      if (confirmation.code !== room.roomCode || confirmation.match !== room.matchId ||
          confirmation.phase !== room.phase || confirmation.role !== room.selfRole ||
          confirmation.consequence !== leaveConsequence(room)) {
        confirmAction('牌桌状态已变化', leaveConsequence(room), '确认退出房间', 'confirmLeave');
        return;
      }
      await connection.action('leave');
      stash();
      location.replace(lobbyHref());
      return;
    case 'askLogout':
      confirmAction('退出棋牌登录', '退出当前入口的棋牌账号。房间座位会保留，之后可以重新登录回桌。', '确认退出登录', 'logout');
      return;
    case 'logout':
      if (!confirmation || confirmation.account !== accountState().userKey) return;
      stash();
      await logoutAccount();
      location.replace(lobbyHref());
      return;
    case 'cancelMenuAction':
      el('sheet').close();
      return;
    case 'invite': {
      const url = new URL(location.href);
      if (['localhost', '127.0.0.1'].includes(url.hostname)) {
        info ??= await request();
        if (info.lanHost) url.host = info.lanHost;
      }
      url.search = '?room=' + room.roomCode;
      showDetail(target,
        '邀请入席',
        '<p>朋友打开邀请链接，或输入桌号 <b>' +
          room.roomCode +
          '</b>。</p><input class="lineInput" id="inviteLink" readonly value="' +
          esc(url.href) +
          '">' +
          button('复制链接', 'copyInvite'),
      );
      return;
    }
    case 'copyInvite': {
      const input = el('inviteLink');
      input.select();
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
      else if (!document.execCommand('copy')) throw Error('请长按所选链接复制');
      notify('已复制邀请链接');
      return;
    }
    case 'chat':
      if (!chat.model.open) el('chat-toggle').click();
      return;
    case 'book':
      await book(val || 'hands', v);
      return;
    case 'chooseAvatar':
      dialog(
        '选择出场角色',
        '<div class="castPicker">' +
          cast
            .map((c) => {
              const occupant = v.players.find((p) => p.ego === c.id),
                locked = occupant && !occupant.bot && occupant.id !== v.self;
              return (
                '<button type="button" data-act="claimAvatar" data-val="' +
                c.id +
                '" ' +
                (locked ? 'disabled' : '') +
                '><img alt="" src="./assets/portraits/' +
                c.id +
                '.png"><b>' +
                c.name +
                '</b></button>'
              );
            })
            .join('') +
          '</div>',
      );
      return;
    case 'claimAvatar':
      await send({ type: 'avatar', ego: val });
      el('sheet').close();
      return;
    case 'inspectItem':
      itemInfo(val, target);
      return;
    case 'inspectSeat': {
      const p = v.players.find((x) => x.id === val);
      if (!p) return;
      showDetail(target,
        p.name,
        '<img class="profilePortrait" alt="" src="./assets/portraits/' +
          p.ego +
          '.png"><p>' +
          esc(cast.find((c) => c.id === p.ego).name) +
          (v.scoreOnly ? '　总排名第 ' + (1 + v.players.filter(other => other.score > p.score).length)
            : '　♥ ' + p.hp + ' / ' + p.maxHp) +
          '　银 ' +
          p.silver +
          '　金 ' +
          p.gold + (p.eventShield ? '　互动盾 ' + p.eventShield : '') + (p.eventAttack ? '　下次攻击 +' + p.eventAttack : '') +
          '</p><p>' +
          p.score +
          ' 分　·　' +
          p.handCount +
          ' 张手牌</p><div class="stamps">' +
          [...p.relics, ...p.tools]
            .map((id) => button(items[id].name, 'inspectItem', id))
            .join('') +
          '</div>' + (room && p.id === v.self && v.phase === 'auction' && v.battle === 1 &&
            v.batch === 1 && v.actors.includes(v.self) ? button('换角色', 'chooseAvatar') : ''),
      );
      return;
    }
    case 'selectLoot':
      selection();
      d.loot = val;
      break;
    case 'ledger':
      await send({ type: 'ledger' });
      break;
    case 'takeLoot':
    case 'emptyLoot':
      await send({ type: 'pick', item: act === 'emptyLoot' ? null : val });
      break;
    case 'lot':
      if (v.phase === 'auction' && v.actors.includes(v.self)) {
        d.card = val;
        audio.play('select');
      } else if (v.phase === 'award') auctionBill(v, target);
      break;
    case 'adjust': {
      selection();
      const k = val.startsWith('silver') ? 'silver' : 'gold';
      d[k] = Math.max(
        0,
        Math.min(v.own[k] + (k === 'silver' ? v.own.bank : 0), d[k] + (val.endsWith('+') ? 1 : -1)),
      );
      break;
    }
    case 'bid':
    case 'pass':
    case 'blind': {
      selection();
      const item =
        (act === 'bid' && ['tail', 'insure'].includes(d.item)) ||
        (act === 'blind' && d.item === 'peek') ||
        (act === 'pass' && d.item === 'reserve')
          ? d.item
          : null;
      await send({
        type: 'seal',
        kind: act,
        card: d.card,
        silver: act === 'bid' ? d.silver : 0,
        gold: act === 'bid' ? d.gold : 0,
        item,
      });
      audio.play('commit');
      break;
    }
    case 'peek':
      await send({ type: 'peek', card: val });
      break;
    case 'suggest':
      selection();
      d.main = bestSelection(
        v.own.hand,
        battleRelics(v.own),
        v.own.vow,
        v.own.guard,
        v.scoringVersion || 1,
        v.scoreOnly,
      ).ids;
      break;
    case 'hand':
      await myCard(val);
      break;
    case 'submit':
      await send({ type: 'submit', ids: d.main });
      break;
    case 'eventPick':
    case 'eventTarget':
    case 'eventPlay': {
      const preview = {match:v.matchId, epoch:v.epoch, seat:v.self, action:act, value:val};
      if (!eventDecision(v, preview)) return;
      d.eventChoice = preview;
      audio.play('select');
      break;
    }
    case 'eventConfirm': {
      const draft = d, preview = draft?.eventChoice;
      const move = eventDecision(v, preview);
      if (!move) return;
      draft.eventChoice = null;
      target.disabled = true;
      try {
        await send(move);
      } catch (error) {
        if (d === draft && eventDecision(v, preview)) draft.eventChoice = preview;
        throw error;
      } finally {
        if (d === draft) {
          stash();
          render();
          if (target.isConnected) target.disabled = !eventDecision(v, draft.eventChoice);
        }
      }
      return;
    }
    case 'eventInfo':
      eventInfo(v,val,target);
      return;
    case 'attack':
      await send({ type: 'attack', target: val });
      break;
    case 'item':
      await use(val, target);
      break;
    case 'cancelEffect':
      d.item = d.source = null;
      break;
    case 'effectNow':
      await effect();
      break;
    case 'effectOther':
      await effect({ other: val });
      break;
    case 'effectSuit':
      await effect({ suit: val });
      break;
    case 'effectRank':
      await effect({ rank: +val });
      break;
    case 'bag':
      if (!v.own || !['tools', 'relics'].includes(val)) return;
      showDetail(target,
        val === 'tools' ? '我的道具' : '我的技能',
        v.own[val].length
          ? [...new Set(v.own[val])].map(id => {
              const count = v.own[val].filter(key => key === id).length;
              return '<div class="itemLine">' + gem(id) + '<div><b>' + esc(items[id].name) +
                (count > 1 ? ' ×' + count : '') + '</b><p>' + esc(itemDescription(id, v.scoringVersion, v.scoreOnly)) +
                '</p><small>' + esc(effectStatus(id, v)) + '</small>' +
                (effectReady(id, v) ? button('使用', 'item', id) : '') + '</div></div>';
            }).join('')
          : '<p>' + (val === 'relics' ? v.chapterVersion >= 2 ? '每章第一、第三战后，从三件遗物中选一项技能。' : '进入下一章时可选取遗物。' : '共享选物时可领取道具。') + '</p>',
      );
      return;
    case 'inspectBoosts':
      showDetail(target,
        '本战生效的道具',
        [
          ...(v.own.boosts || []).map((effect) => 'once-' + effect),
          ...(v.own.adrenaline ? ['adrenaline'] : []),
        ]
          .map((id) => {
            const item = items[id];
            return (
              '<div class="itemLine">' +
              gem(item.id) +
              '<div><b>' +
              esc(item.name) +
              '</b><p>' +
              esc(itemDescription(id, v.scoringVersion, v.scoreOnly)) +
              '</p></div></div>'
            );
          })
          .join(''),
      );
      return;
    case 'auctionBill':
      auctionBill(v, target);
      return;
    case 'battleBill':
      battleBill(v, target);
      return;
    default:
      return;
  }
  if (v) {
    stash();
    render();
  }
}
async function handle(a, val, n) {
  if (busy) return;
  busy = true;
  try {
    await perform(a, val, n);
  } catch (e) {
    console.warn('[牌桌]', e.message);
    notify(e.message);
    if (mode === 'practice' && v) receive(await readPractice());
  } finally {
    busy = false;
  }
}
document.addEventListener('click', (e) => {
  const n = e.target.closest('[data-act]');
  if (!n || n.disabled) return;
  if (el('roomArrangement').contains(n)) settingsMenu.close({ restoreFocus: false });
  handle(n.dataset.act, n.dataset.val, n);
});
// Inspect an actionable piece without also submitting the tap that follows a long press.
function bindPieceDetails(root) {
  let hold, consumed;
  const piece = target => target.closest('[data-act="item"], [data-act="inspectItem"], [data-act="selectLoot"], [data-interaction-info], .seatRow');
  function cancel() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  }
  function inspect(node) {
    if (!node.isConnected || node.disabled) return;
    if (node.classList.contains('seatRow')) handle('inspectSeat', node.dataset.val, node);
    else if (node.dataset.interactionInfo) eventInfo(v,node.dataset.interactionInfo,node);
    else itemInfo(node.dataset.val, node);
    consumed = node;
  }
  root.addEventListener('pointerdown', event => {
    cancel();
    consumed = null;
    const node = piece(event.target);
    if (!node || event.button !== 0 || !event.isPrimary || event.pointerType === 'mouse') return;
    hold = {id:event.pointerId,x:event.clientX,y:event.clientY,timer:setTimeout(() => {
      inspect(node);
      cancel();
    }, 520)};
  });
  root.addEventListener('pointermove', event => {
    if (hold?.id === event.pointerId && Math.hypot(hold.x-event.clientX, hold.y-event.clientY) > 7) cancel();
  });
  window.addEventListener('pointerup', cancel);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  root.addEventListener('contextmenu', event => {
    const node = piece(event.target);
    if (!node) return;
    event.preventDefault();
    cancel();
    if (node !== consumed) inspect(node);
  });
  root.addEventListener('click', event => {
    if (!consumed || piece(event.target) !== consumed) return;
    consumed = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
bindPieceDetails(el('world'));
mountGestures(el('world'), { perform: handle });
document.addEventListener(
  'pointerdown',
  () => {
    audio.unlock();
    ambience.wake();
  },
  { once: true },
);
document.addEventListener('change', (e) => {
  if (e.target.name === 'useMatchLimit') togglePracticeLimit(e.target);
  if (e.target.name === 'mode') {
    const form = e.target.form;
    form.querySelector('[data-length-title]').textContent = e.target.value === 'survival' ? '生存赛决胜前长度' : '积分赛长度';
    form.querySelector('.survivalLength').hidden = e.target.value !== 'survival';
    form.elements.health.closest('label').hidden = e.target.value !== 'survival';
  }
  if (['arena', 'ego'].includes(e.target.name)) {
    cfg = { ...cfg, [e.target.name]: e.target.value };
    const picture = el('outfitPreview');
    if (picture) picture.src = './assets/portraits/' + cfg.ego + '.png';
    scene();
  }
});
new ResizeObserver(() => scheduleTableLayout(true)).observe(el('tableViewport'));
window.visualViewport?.addEventListener('resize', () => {
  stage?.resize();
});
document.addEventListener('visibilitychange', () => {
  stage?.pause(document.hidden || room?.phase === 'paused');
  ambience.sync();
  if (!document.hidden && mode === 'practice')
    readPractice(true).then((n) => {
      if (mode === 'practice' && n) receive(n);
    });
});
window.addEventListener('pagehide', () => {
  stash();
  stage?.pause(true);
  ambience.sync(undefined, false);
});
window.addEventListener('pageshow', () => {
  stage?.pause(room?.phase === 'paused');
  ambience.sync(v?.settings.arena || cfg.arena, !!v);
});
if (window.isSecureContext && 'serviceWorker' in navigator) {
  const cachePractice = () =>
    fetch('./offline-list.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (m) => m?.build && navigator.serviceWorker.register('./offline-worker.js?build=' + m.build),
      )
      .catch(() => {});
  if (document.readyState === 'complete') cachePractice();
  else window.addEventListener('load', cachePractice, { once: true });
}
document.addEventListener('last-hand-seat-ended', () => {
  if (!room) return;
  el('sheet').close();
  void home();
  notify('席位连接已结束，可从朋友同桌重新进入。');
});
const bootQuery = new URL(location.href).searchParams;
const initialCode = bootQuery.get('room');
await home();
restoreBook(v);
initScene();
if (/^\d{6}$/.test(initialCode || '')) {
  try {
    await loadAccount();
    sit(await request('/' + initialCode));
  } catch {
    await showFriends(initialCode);
  }
}

if (!initialCode && bootQuery.get('play') === 'friends') {
  const account = await loadAccount().catch(() => null);
  if (account?.authenticated) startSetup(true);
  else await showFriends().catch(e => notify(e.message));
}
