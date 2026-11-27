import { cast, arenas } from './rules/catalog.mjs';
import { chapterChoices, healthChoices } from './rules/match.mjs';
import { esc, button } from './widgets.mjs';
import { timeControls, matchSummary, decisionSummary } from './timing.mjs';
const option = (v, t, s) =>
  '<option value="' + esc(v) + '"' + (v === s ? ' selected' : '') + '>' + esc(t) + '</option>';
const select = (key, title, list, s, hidden = false) =>
  (hidden ? '<label hidden>' : '<label>') +
  title +
  '<select name="' +
  key +
  '">' +
  list.map(([v, t]) => option(v, t, s)).join('') +
  '</select></label>';
export function foyer(saved) {
  return (
    '<span class="sigil" aria-hidden="true">♠</span><h1>最后一手</h1><p>六席竞拍，暗中出价。<br>把抢来的牌，组成你最强的一手。</p><div class="choices">' +
    (saved && !saved.finished ? button('续打第 ' + saved.battle + ' 战', 'resume', '', 'gold') : '') +
    button('电脑练习', 'setup', '', '' + (saved && !saved.finished ? '' : 'gold')) +
    button('朋友同桌', 'friends') +
    '</div>'
  );
}
export function lengthControls(cfg, perChapter = 4) {
  const survival = cfg.mode === 'survival';
  return '<label class="lengthChoice span"><span data-length-title>' +
    (survival ? '生存赛决胜前长度' : '积分赛长度') + '</span><select name="sections">' +
    chapterChoices.map(n => option(n, n + ' 章 · ' + (n * perChapter) + ' 战', cfg.sections)).join('') + '</select></label>' +
    '<small class="survivalLength span"' + (survival ? '' : ' hidden') +
    '>满所选章数后，每战追加递增的决胜伤害。剩最后一席即可提前获胜。</small>';
}
export function healthControl(cfg) {
  const choices = cfg.health === 3 ? [3, ...healthChoices] : healthChoices;
  return select('health', '起始生命', choices.map(n => [n, n + ' 点' + (n === 3 ? '（旧桌）' : '')]),
    cfg.health, cfg.mode !== 'survival');
}
export function setup(cfg, nick, online) {
  const modes = [
    ['score', '积分赛'],
    ['survival', '生存赛'],
  ];
  return (
    button('‹ 返回', 'back', '', 'return') +
    '<h2>' +
    (online ? '开一桌给朋友' : '开一张练习桌') +
    '</h2><form class="setup" id="config">' +
    '<label>棋牌室昵称<input name="nick" maxlength="16" required value="' +
    esc(nick) +
    '"></label>' +
    select(
      'seats',
      '席位',
      [2, 3, 4, 5, 6].map((n) => [n, n + ' 席']),
      cfg.seats,
    ) +
    select('mode', '胜负', modes, cfg.mode) +
    lengthControls(cfg) +
    timeControls(cfg, false, !online) +
    '<label>你的角色<span class="outfitPick"><img id="outfitPreview" alt="" src="./assets/portraits/' +
    esc(cfg.ego) +
    '.png"><select name="ego">' +
    cast.map((c) => option(c.id, c.name, cfg.ego)).join('') +
    '</select></span></label>' +
    select(
      'arena',
      '竞技场',
      arenas.map((a) => [a.key, a.name]),
      cfg.arena,
    ) +
    healthControl(cfg) +
    select(
      'tiers',
      '遗物等级',
      [
        ['mixed', '混合'],
        ['rising', '由低到高'],
        ['falling', '由高到低'],
      ],
      cfg.tiers,
    ) +
    select(
      'style',
      '电脑打法',
      ['mixed', '争牌', '稳健', '构筑'].map((x) => [x, x === 'mixed' ? '各有偏好' : x]),
      cfg.style,
    ) +
    '<label>每战银筹<input name="chips" type="number" min="10" max="50" value="' +
    cfg.chips +
    '"></label><label class="check"><input type="checkbox" name="expansion" ' +
    (cfg.expansion ? 'checked' : '') +
    '> 加入原创 12 件</label>' +
    (online
      ? '<label class="check"><input type="checkbox" name="public" ' +
        (cfg.public ? 'checked' : '') +
        '> 出现在公开桌列表</label>'
      : '') +
    '</form><div class="choices">' +
    button(online ? '创建牌桌' : '入席开局', online ? 'createRoom' : 'startPractice', '', 'gold') +
    '</div>'
  );
}
export function friends(info, nick, code = '') {
  const rooms = info?.publicRooms || [],
    recent = info?.recent || [];
  return (
    button('‹ 主入口', 'home', '', 'return') +
    '<h2>朋友同桌</h2><div class="setup"><label>棋牌室昵称<input id="joinName" maxlength="16" value="' +
    esc(nick) +
    '"></label><label>六位桌号<input class="lineInput" id="roomCode" inputmode="numeric" maxlength="6" placeholder="000000" value="' +
    esc(code) +
    '"></label></div><div class="choices">' +
    button('加入', 'join', '', 'gold') +
    button('观战', 'spectate') +
    button('创建一桌', 'setupRoom') +
    '</div>' +
    (recent.length
      ? '<small>我的牌桌</small><div class="choices">' +
        recent
          .slice(0, 3)
          .map((r) => button('回 ' + r.roomCode + ' 桌', 'rejoin', r.roomCode))
          .join('') +
        '</div>'
      : '') +
    '<small>公开桌</small><div class="choices">' +
    (rooms.length
      ? rooms
          .slice(0, 4)
          .map((r) => button(r.host + ' · ' + r.occupied + '/' + r.seats, 'joinPublic', r.code))
          .join('')
      : '<small>现在没有等人的公开桌。</small>') +
    button('刷新', 'friends') +
    '</div>'
  );
}
export function waiting(v) {
  const host = v.selfId === v.hostId,
    viewer = v.selfRole === 'spectator',
    me = v.players.find((p) => p.id === v.selfId),
    s = v.tableOptions;
  return (
    '<small>朋友同桌　' +
    (s.public ? '公开桌' : '邀请桌') +
    '</small><h2>桌号 ' +
    esc(v.roomCode) +
    '</h2><p>' +
    esc(s.mode === 'score' ? '积分赛' : '生存赛') +
    ' · ' +
    s.seats +
    ' 席 · 空位由电脑入席</p><div class="roomTiming"><span>' +
    esc((s.mode === 'score' ? s.sections + ' 章 · ' + s.sections * 4 + ' 战。' : s.health + ' 点起始生命，第 ' + (s.sections * 4 + 1) + ' 战起追加决胜伤害。') + matchSummary(s) + decisionSummary(s)) + '</span>' +
    (host ? button('调整赛程', 'editTimers') : '') + '</div><div class="waitingSeats">' +
    Array.from({ length: s.seats }, (_, i) => {
      const p = v.players[i];
      return (
        '<div>' +
        esc(p?.name || '电脑空位') +
        '<small>' +
        (p ? (p.ready ? '已准备' : p.id === v.hostId ? '房主' : '已入席') : '开局加入') +
        '</small></div>'
      );
    }).join('') +
    '</div><div class="choices">' +
    (viewer
      ? button('入座', 'bePlayer')
      : button(me.ready ? '取消准备' : '准备好了', 'ready', '', '' + (me.ready ? '' : 'gold'))) +
    (host ? button('开局', 'startRoom', '', 'gold', !v.players.every((x) => x.ready)) : '') +
    button('邀请', 'invite') +
    button('聊天', 'chat') +
    button('退出房间', 'leaveRoom') +
    '</div>'
  );
}
