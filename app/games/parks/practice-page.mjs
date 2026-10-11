import { mountParksPage } from './game-ui.mjs';
import { createParksPracticeSession } from './practice-session.mjs';
import { parksCommand, parksCues } from './presentation.mjs';
import { PRACTICE_SELF, PRACTICE_STORAGE_KEY } from './practice-engine.mjs';
import { entryStorageKey } from '../../entry-path.mjs';
import { replacePracticeWithLobby } from '../../platform/practice-navigation.mjs';
import { escapeHtml as esc } from './card-ui.mjs';
import { LESSONS, createTutorialLesson, tutorialProgress, tutorialActionGuidance } from './tutorial-model.mjs';
import { chooseParksPracticeAction } from './practice-bot.mjs';

export function mountParksPractice({ tutorial = false } = {}) {
  const lessonId = new URL(location.href).searchParams.get('lesson'), lesson = tutorial ? LESSONS.find(value => value.id === lessonId) || LESSONS[0] : null;
  const soloEntry = !tutorial && new URL(location.href).searchParams.get('mode') === 'solo';
  const root = document.getElementById('parks-game-root'), key = entryStorageKey(tutorial ? `${PRACTICE_STORAGE_KEY}:tutorial:${lesson.id}` : soloEntry ? `${PRACTICE_STORAGE_KEY}:solo` : PRACTICE_STORAGE_KEY);
  const progressKey = `${key}:progress`;
  let session, game = null, last = null, closed = false, clock = performance.now(), timer, previous = null, lockHeld = false, releaseLock;
  let lessonComplete = false, courseControl;
  const ui = mountParksPage({ root, practice: true, tutorial,
    onAction(type, fields) {
      if (!lockHeld) throw new Error('这局练习正在另一窗口运行，请使用原窗口。');
      const intent = ['pause', 'resume'].includes(type) ? fields : parksCommand(game, type, fields);
      const result = session.act(type, intent); if (!result.ok) throw new Error(result.error);
      return result;
    }, onRestart: () => tutorial ? openCourses() : setup(false), onHint: () => ui.hint(tutorial ? tutorialProgress(game, lesson.id).suggestedAction : chooseParksPracticeAction(game)), onLeave() { dispose(); replacePracticeWithLobby(location); },
    onTutorialDescription: fields => tutorial ? tutorialActionGuidance(game, lesson.id, fields) : null,
    onTutorialControl(action) {
      if (action === 'next') nextCourse();
      else if (action === 'practice') { dispose(); location.assign('./parks-practice.html'); }
      else if (action === 'retry') retryLesson();
    }, onRefresh: () => location.reload(), onRetry: () => session.retryStorage(), onHistory: async () => {
      const result = session.snapshot().saved?.game.result;
      return { items: result ? [{ game: 'parks', self: { outcome: 'completed', score: result.scores.find(value => value.playerId === PRACTICE_SELF)?.score }, result }] : [] };
    } });
  const setupPanel = document.createElement('dialog'); setupPanel.id = 'pg-setup'; setupPanel.className = 'pg-dialog';
  setupPanel.innerHTML = `<header><h2>${tutorial ? '跟着走一趟' : '展开新的旅程'}</h2><button type="button" id="pg-setup-close" aria-label="取消重新开始">×</button></header><form id="pg-setup-form"><div class="pg-config-grid"><label>玩法<select name="mode"><option value="standard">基础版 · 2～5人</option><option value="teddy">双人 + 巡护员 Teddy</option><option value="solo">官方单人</option></select></label><label>同行人数<select name="players"><option value="2">2人（你 + 1名电脑）</option><option value="3">3人</option><option value="4">4人</option><option value="5">5人</option></select></label><label>露营<select name="camping"><option value="true">加入露营</option><option value="false">不含露营</option></select></label><label>志愿项目<select name="volunteers">${[0,1,2,3,4].map(n => `<option value="${n}">${n}个</option>`).join('')}</select></label><label>热忱<select name="passion"><option value="choose">开局二选一</option><option value="random">随机分配</option></select></label></div><p id="pg-setup-note">${tutorial ? '从真实的基础玩法开始。每一步都会说明现在为什么要选、选完会发生什么；你亲手操作，电脑正常同行。' : '电脑只使用自己的手牌和公开信息。旅程自动保存在本机，下次可以接着玩。'}</p><div class="pg-dialog-actions"><button type="button" id="pg-setup-cancel">取消</button><button type="submit" class="pg-primary">确认 · 开始旅程</button></div><p id="pg-setup-error" role="status"></p></form>`;
  root.append(setupPanel);
  if (tutorial) {
    courseControl = document.createElement('button'); courseControl.type = 'button'; courseControl.id = 'pg-course'; courseControl.className = 'pg-tutorial-control'; courseControl.textContent = `课程 ${LESSONS.indexOf(lesson) + 1}/${LESSONS.length}`;
    root.querySelector('.pg-header').insertBefore(courseControl, root.querySelector('.pg-header nav'));
    courseControl.addEventListener('click', openCourses);
    const courses = document.createElement('dialog'); courses.id = 'pg-courses'; courses.className = 'pg-dialog';
    courses.innerHTML = `<header><h2>亲手走一趟</h2><button type="button" data-course-close aria-label="继续当前课程">×</button></header><label>选择课程<select id="pg-course-select">${LESSONS.map(value => `<option value="${esc(value.id)}">${esc(value.title)}</option>`).join('')}</select></label><p id="pg-course-goal"></p><p id="pg-course-difference"></p><p>重做会替换本课进度；其他课程与完整练习会保留。</p><div class="pg-dialog-actions"><a href="./parks-practice.html">完整练习</a><button type="button" id="pg-course-retry">确认重做本课</button><button type="button" id="pg-course-go" class="pg-primary">进入课程</button></div><p id="pg-course-error" role="status"></p>`;
    root.append(courses);
    const select = courses.querySelector('select');
    const showInfo = () => { const value = LESSONS.find(item => item.id === select.value); courses.querySelector('#pg-course-goal').textContent = `${value.goal} ${value.instruction}`; courses.querySelector('#pg-course-difference').textContent = value.normalDifference; };
    select.addEventListener('change', showInfo);
    courses.querySelector('[data-course-close]').addEventListener('click', () => courses.close());
    courses.querySelector('#pg-course-go').addEventListener('click', () => {
      if (select.value === lesson.id) courses.close(); else changeCourse(select.value);
    });
    courses.querySelector('#pg-course-retry').addEventListener('click', () => {
      if (retryLesson()) courses.close();
    });
    courses.addEventListener('cancel', () => { courses.dataset.confirmRetry = ''; });
  }
  function changeCourse(id) { const url = new URL(location.href); url.searchParams.set('lesson', id); dispose(); location.replace(url.href); }
  function nextCourse() { const index = LESSONS.findIndex(value => value.id === lesson.id); if (index === 7 || index === LESSONS.length - 1) { dispose(); location.assign('./parks-practice.html'); } else changeCourse(LESSONS[index + 1].id); }
  function retryLesson() {
    if (!lockHeld) { ui.feedback('请回到持有本课的窗口重练。'); return false; }
    const result = session.start(); if (!result.ok) { ui.feedback(result.error); root.querySelector('#pg-course-error').textContent = result.error; return false; }
    ui.audio.play('start'); clock = performance.now(); return true;
  }
  function openCourses() { const panel = root.querySelector('#pg-courses'); for (const node of root.querySelectorAll('dialog[open]')) node.close(); panel.querySelector('select').value = lesson.id; panel.querySelector('select').dispatchEvent(new Event('change')); panel.dataset.confirmRetry = ''; panel.querySelector('#pg-course-error').textContent = ''; panel.showModal(); }
  const form = setupPanel.querySelector('form'); let empty = true;
  if (soloEntry) form.elements.mode.value = 'solo';
  function setup(first) { empty = first; for (const dialog of root.querySelectorAll('dialog[open]')) dialog.close();
    const snapshot = session.snapshot().saved;
    if (snapshot) { const config = snapshot.game.configuration; form.elements.mode.value = config.mode; form.elements.players.value = String(Math.max(2, snapshot.game.players.length)); form.elements.camping.value = String(config.camping); form.elements.volunteers.value = String(config.volunteerCount); form.elements.passion.value = config.passionChoice; }
    setupPanel.querySelector('#pg-setup-close').hidden = first; setupPanel.querySelector('#pg-setup-cancel').textContent = first ? '返回大厅' : '取消，继续原局';
    if (!first) setupPanel.querySelector('#pg-setup-note').textContent = '确认后将替换本机这局练习。取消会继续原局，不改牌、资源或进度。';
    modeChanged(); setupPanel.showModal();
  }
  function modeChanged() { const mode = form.elements.mode.value; form.elements.players.disabled = mode !== 'standard'; if (mode === 'teddy') form.elements.players.value = '2'; }
  form.elements.mode.addEventListener('change', modeChanged);
  form.addEventListener('submit', event => { event.preventDefault();
    if (!lockHeld) { setupPanel.querySelector('#pg-setup-error').textContent = '当前窗口不能写入练习存档。请关闭原窗口后刷新。'; return; }
    const configuration = { mode: form.elements.mode.value, camping: form.elements.camping.value === 'true', volunteerCount: Number(form.elements.volunteers.value), passionChoice: form.elements.passion.value };
    previous = null; const result = session.start({ configuration, playerCount: Number(form.elements.players.value) });
    if (!result.ok) { setupPanel.querySelector('#pg-setup-error').textContent = result.error; return; }
    empty = false; setupPanel.close(); ui.audio.play('start'); clock = performance.now();
  });
  function cancelSetup() { if (empty) { dispose(); replacePracticeWithLobby(location); } else setupPanel.close(); }
  setupPanel.querySelector('#pg-setup-close').addEventListener('click', cancelSetup); setupPanel.querySelector('#pg-setup-cancel').addEventListener('click', cancelSetup);
  setupPanel.addEventListener('cancel', event => { event.preventDefault(); cancelSetup(); });
  function wrap(value, saved) { return { roomId: saved.matchId, code: '', gameType: 'parks', selfId: PRACTICE_SELF, selfRole: 'player', hostId: PRACTICE_SELF,
    matchId: saved.matchId, phase: value.result ? 'finished' : value.window.paused ? 'paused' : 'playing', parksConfig: value.configuration,
    members: value.players.map((owner, index) => ({ id: owner.id, playerId: owner.id, name: index === 0 ? '你' : `电脑 ${index}`, role: 'player' })), game: value };
  }
  session = createParksPracticeSession({ storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) }, key, ...(tutorial ? { create: () => createTutorialLesson(lesson.id) } : {}), canWrite: () => lockHeld,
    onView(value, { saved, blocked }) { if (closed) return; game = value; last = saved;
      for (const cue of parksCues(previous, value, PRACTICE_SELF, 'player')) ui.audio.play(cue);
      previous = value;
      let tutorialGuide = null;
      if (tutorial) {
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem(progressKey)); } catch { /* Completion metadata never substitutes a game save. */ }
        const progress = tutorialProgress(value, lesson.id, { completedPreviously: stored?.matchId === saved.matchId && stored.complete === true });
        lessonComplete = progress.complete; tutorialGuide = progress.guidance;
        if (progress.complete && lockHeld) try { localStorage.setItem(progressKey, JSON.stringify({ matchId: saved.matchId, complete: true })); } catch { /* The verified game remains playable when optional progress storage fails. */ }
        courseControl.textContent = `课程 ${LESSONS.indexOf(lesson) + 1}/${LESSONS.length}`;
        courseControl.setAttribute('aria-label', `课程菜单：${lesson.title}${lessonComplete ? '，本课已完成' : ''}`);
      }
      ui.applyView(wrap(value, saved), { pending: false, canAct: !blocked && lockHeld, connection: 'online', tutorialGuide,
        tutorialBlock: blocked ? { heading: '先恢复存档，再继续', message: '保存结果尚未确认。先刷新核对原进度，当前窗口不会继续执行。', retryStorage: true }
          : !lockHeld ? { heading: '这个窗口仅供查看', message: '另一窗口持有本课。请回原窗口继续，或关闭原窗口后刷新接续。', retryStorage: false } : null });
    }, onFailure(message) { blockPractice(message, { retryStorage: true }); } });
  function blockPractice(message, { retryStorage = false } = {}) {
    ui.feedback(message);
    if (game && last) ui.applyView(wrap(game, last), { canAct: false, connection: 'offline',
      tutorialBlock: { heading: retryStorage ? '先恢复存档，再继续' : '这个窗口仅供查看', message, retryStorage } });
  }
  function restore() { const restored = session.read(); if (lockHeld && (restored.empty || !restored.ok)) {
    if (tutorial && restored.empty) { const started = session.start(); if (!started.ok) ui.feedback(started.error); }
    else if (tutorial) { openCourses(); root.querySelector('#pg-course-error').textContent = restored.error + ' 选择“确认重做本课”后才会替换。'; }
    else { setup(true); if (!restored.ok) setupPanel.querySelector('#pg-setup-note').textContent = restored.error; }
  } }
  if (navigator.locks?.request) void navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (closed) return;
    if (!lock) { restore(); blockPractice('另一窗口正在运行这局练习。请回原窗口继续，或关闭原窗口后刷新接续。'); return; }
    lockHeld = true; restore(); await new Promise(resolve => { releaseLock = resolve; }); lockHeld = false;
  }).catch(() => { restore(); blockPractice('无法取得本机存档锁。请关闭其他练习窗口后刷新。'); });
  else { restore(); blockPractice('此浏览器无法安全协调本机练习窗口。请使用新版 Chrome、Safari 或 Firefox。'); }
  const storageChanged = event => { if (event.key === key) session.externalChange(event.newValue); };
  window.addEventListener('storage', storageChanged);
  timer = setInterval(() => { if (closed) return; const now = performance.now(), elapsed = Math.min(2000, Math.max(0, now - clock)); clock = now;
    session.suspend(!lockHeld || document.hidden || ui.hasOpenPanel() || ui.isObscured() || tutorial && lessonComplete); session.tick(elapsed);
  }, 500);
  function dispose() { if (closed) return; closed = true; clearInterval(timer); releaseLock?.(); window.removeEventListener('storage', storageChanged); session.destroy(); ui.destroy(); setupPanel.remove(); root.querySelector('#pg-courses')?.remove(); }
  window.addEventListener('pagehide', dispose, { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  return { ui, session, dispose };
}

export function tutorialInstruction(game) {
  if (game.result) return '旅程完成了：点同行者查看公园、照片、热忱等计分。现在可以换成 Teddy、单人或露营再走一趟。';
  if (game.window.paused) return '旅程已暂停，打开设置恢复后从这一步继续。';
  if (game.window.responsibleSeatId !== PRACTICE_SELF) return '看电脑如何向前走；公开的资源、营火、照片和卡牌都能点开查看。';
  if (game.stage === 'move') return '第一步：选自己的徒步者，再点前方地点。看清目的地与营火状态，确认后移动并领取收益。';
  const op = game.opportunities.find(value => value.status === 'open' && value.ownerSeatId === PRACTICE_SELF);
  return ({ 'starting-passion': '先读两张热忱：它们是本局目标。选一张，确认后开始徒步。',
    'new-water': '这枚水可以进背包，也可以填一行水壶。填壶会触发该行收益，但本季不能再次填同一行。',
    base: '这就是落脚地点的基础行动，必须完成。点击要选的卡牌或收益，看下方费用，再确认。',
    gear: '刚才的行动触发了这件装备。它是额外收益，可以使用，也可以明确放弃。',
    'passion-branch': '目标达成了：现在选择永久能力，或终局计分。选择后本局不能切换。',
    'season-reward': '所有徒步者到终点后比较季节目标。先结清奖励，下一季的营火和水壶才会复原。',
    'teddy-order': '这次 Teddy 的两个颜色组都要移动，你先决定由哪组执行这张翻牌。',
    'park-instant': '游览公园已经支付并得分；这项即时奖励仍要在当前窗口结清。' }[op?.kind]) || '取消只撤销尚未确认的选择。结清这一步后，再结束回合。';
}

if (typeof document !== 'undefined' && document.getElementById('parks-game-root') && !document.body.hasAttribute('data-parks-tutorial')) mountParksPractice();
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
