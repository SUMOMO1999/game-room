import { createFlyingPracticeSession, PRACTICE_LESSONS } from './practice-engine.mjs';
import { mountFlyingPage } from './page-ui.mjs';

const root = document.querySelector('#flying-root');
let session;
try {
  session = await createFlyingPracticeSession();
  await mountFlyingPage({ mode: 'practice', session, lessonOptions: PRACTICE_LESSONS });
  globalThis.addEventListener('pagehide', event => { if (!event.persisted) session.destroy(); });
} catch {
  session?.destroy();
  root.replaceChildren();
  const note = document.createElement('p');
  note.textContent = '练习暂时无法打开。请重新进入；正式朋友房间没有改变。';
  const exit = document.createElement('a');
  exit.href = './?practice=1'; exit.textContent = '返回大厅';
  root.append(note, exit);
}
