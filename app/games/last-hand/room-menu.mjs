import { el, esc, paint, button } from './widgets.mjs';
import { battlesPerChapter } from './rules/table.mjs';
import { decisionSummary, matchSummary } from './timing.mjs';
import { lobbyHref } from './room-bridge.mjs';

const phaseNames = { waiting: '准备中', playing: '对局中', paused: '已暂停', finished: '已结算', aborted: '已中止' };
const group = html => '<div class="roomMenuActions">' + html + '</div>';
const roleName = room => room.selfRole === 'spectator' ? '观众' : room.selfId === room.hostId ? '房主' : '玩家';
const link = (name, href) => '<a href="' + esc(href) + '">' + esc(name) + '</a>';

export function showRoomTools({ room, view, mode, online, account }) {
  const practice = mode === 'practice' && !!view;
  const status = room ? room.roomCode + ' · ' + roleName(room) : practice ? '本机练习' : '';
  const state = room ? (online ? '已连接' : '重连中') : '';
  paint('tableStatus', room ? '<span>' + esc(room.roomCode) + '</span> <span class="roomMeta"><span>' + roleName(room) + '</span><span>' + state + '</span></span>' : esc(status));
  el('routeStatus').textContent = [status, state].filter(Boolean).join(' · ');
  el('fastOption').hidden = !!room;
  const arrangement = room ? '房间安排' : practice ? '练习安排' : '棋牌室';
  const where = room ? '桌号 ' + status + ' · ' + phaseNames[room.phase] + ' · ' + state :
    practice ? '练习保存在当前浏览器，返回后可以续打。' : '';
  let html = '<h3>' + arrangement + '</h3>' + (where ? '<p>' + esc(where) + '</p>' : '') +
    group(link('返回棋牌室', lobbyHref()) +
      (room || practice ? button(room ? '成员与积分' : '练习成员', 'members') : '') +
      (room ? button('邀请朋友', 'invite') : ''));
  const options = room?.tableOptions || view?.settings;
  if (options) {
    const battles = options.sections * (view ? battlesPerChapter(view) : 4);
    const length = options.mode === 'score'
      ? '积分赛 ' + options.sections + ' 章 · ' + battles + ' 战。'
      : '生存赛，起始生命 ' + options.health + '。最后一席获胜，第 ' + (battles + 1) + ' 战起追加决胜伤害。';
    html += '<p>' + esc(length + matchSummary(options) + decisionSummary(options)) + '</p>';
  }
  if (room) {
    const player = room.selfRole === 'player', host = room.selfId === room.hostId;
    let actions = '';
    if (host && room.phase === 'waiting') actions += button('调整时长', 'editTimers');
    if (room.phase === 'waiting' && !host && (player || room.players.length < options.seats))
      actions += button(player ? '转为观众' : '入座', player ? 'beSpectator' : 'bePlayer');
    if (player && room.phase === 'playing') {
      const agreed = room.pause?.agreedIds.includes(room.selfId);
      actions += button(agreed ? '撤回暂停同意' : room.pause ? '同意暂停' : '申请暂停', 'votePause');
    }
    if (player && room.phase === 'paused') actions += button('继续对局', 'resumeRoom');
    if (host && room.players.length > 1) actions += button('转交房主', 'hostChoices');
    if (!host && room.hostCanTakeOver && player) actions += button('接任房主', 'takeHost');
    html += group(actions + button('退出房间', 'leaveRoom', '', 'destructive'));
    if (room.pause) html += '<p>暂停同意 ' + room.pause.agreedIds.length + ' / ' + room.players.length + '</p>';
  } else if (practice) html += group((view.status === 'playing' ? button('调整练习赛程', 'editPractice') : '') + button('重新开始练习', 'restartPractice'));
  html += group(button('游戏规则', 'menuRules') +
    (mode !== 'home' ? button('游戏主菜单', 'home') : '') +
    link('返回 Agora', 'https://agora.sumomoli.com/#projects') +
    (account.authenticated ? button('退出棋牌登录', 'askLogout') : ''));
  paint('roomArrangement', html);
  const paused = room?.phase === 'paused';
  const vote = !!room?.pause;
  paint('pauseNotice', paused || vote
    ? '<span>' + (paused ? '牌局已暂停' : '暂停表决 ' + room.pause.agreedIds.length + '/' + room.players.length) + '</span>' +
      (room.selfRole === 'player' ? button(paused ? '继续对局' : room.pause.agreedIds.includes(room.selfId) ? '撤回' : '同意', paused ? 'resumeRoom' : 'votePause') : '')
    : '');
  for (const id of ['market', 'actions', 'hand', 'relics', 'tools', 'seatTags']) el(id).inert = !!paused;
}

export function memberList(room, view) {
  const row = (name, role, detail) => '<li><strong>' + esc(name) + '</strong><span>' +
    esc([role, detail].filter(Boolean).join(' · ')) + '</span></li>';
  const inGame = new Map((view?.players || []).map(p => [p.id, p]));
  let rows = '';
  for (const p of room?.players || []) {
    const seat = inGame.get(p.id);
    rows += row(p.name, p.id === room.hostId ? '房主' : '玩家',
      [p.connected ? '在线' : '离线', seat ? seat.score + ' 分' : p.ready ? '已准备' : '未准备'].join(' · '));
  }
  for (const p of view?.players || []) {
    if (!room || p.bot) rows += row(p.name, p.bot ? '电脑' : '我', p.score + ' 分');
  }
  for (const p of room?.spectators || []) rows += row(p.name, '观众', p.connected ? '在线' : '离线');
  return '<ul class="roomMembers">' + rows + '</ul>';
}

export function leaveConsequence(room) {
  if (room.selfRole === 'spectator') return '你会退出观战，其他人可以继续玩。';
  const active = ['playing', 'paused'].includes(room.phase);
  const closure = room.players.length === 1 ? '你是最后一位玩家，房间会关闭。' :
    room.selfId === room.hostId ? '房主会转交给留在桌上的玩家。' : '';
  return (active ? '退出会中止这一局，全桌不计输赢。' : '退出会释放你的座位。') + closure;
}
