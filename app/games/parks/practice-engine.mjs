import { createGame, applyGameAction, nextSystemStep, applySystemStep, stateProblem, pauseGame, resumeGame, normalizeConfiguration } from './rules/index.mjs';
import { privateView } from './view.mjs';
import { chooseParksPracticeAction } from './practice-bot.mjs';
export const PRACTICE_SELF = '00000000000000000000000000000001';
export const PRACTICE_BOTS = Object.freeze(Array.from({ length: 4 }, (_, i) => (i + 2).toString(16).padStart(32, '0')));
export const PRACTICE_STORAGE_KEY = 'game-room:parks:practice:v1';
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validSeed = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
export function randomStream(seed) {
  if (!validSeed(seed)) throw new RangeError('练习随机种子无效。');
  let state = seed;
  return { get state() { return state; }, randomInt(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 0xffffffff) throw new RangeError('随机上限无效。');
    const ceiling = Math.floor(0x100000000 / limit) * limit;
    do { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; } while (state >= ceiling);
    return state % limit;
  } };
}
export function practiceProblem(saved) {
  if (!exact(saved, ['version', 'kind', 'matchId', 'logicalNow', 'rngState', 'game']) || saved.version !== 1 || saved.kind !== 'parks-local-practice'
    || typeof saved.matchId !== 'string' || !/^[0-9a-f]{32}$/u.test(saved.matchId) || !Number.isSafeInteger(saved.logicalNow) || saved.logicalNow < 0 || !validSeed(saved.rngState)) return '本机练习存档字段无效。';
  const issue = stateProblem(saved.game); if (issue) return issue;
  if (saved.game.matchId !== saved.matchId || saved.game.committedAt > saved.logicalNow || saved.game.players.some((owner, index) => owner.id !== [PRACTICE_SELF, ...PRACTICE_BOTS][index])) return '本机练习身份或时间无效。';
  return null;
}
export function decodeParksPractice(raw) {
  try { if (typeof raw !== 'string' || raw.length > 524288) return null; const saved = JSON.parse(raw); return practiceProblem(saved) ? null : saved; } catch { return null; }
}
export function encodeParksPractice(saved) { const issue = practiceProblem(saved); if (issue) throw new Error(issue); return JSON.stringify(saved); }
export function createParksPractice({ configuration = {}, playerCount = 2, seed, requestId = () => globalThis.crypto.randomUUID().replaceAll('-', '') } = {}) {
  if (!Number.isSafeInteger(playerCount) || playerCount < 2 || playerCount > 5) throw new RangeError('练习人数须为2至5。');
  const config = normalizeConfiguration(configuration), count = config.mode === 'solo' ? 1 : config.mode === 'teddy' ? 2 : playerCount;
  const initial = seed ?? (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  if (!validSeed(initial)) throw new RangeError('练习随机种子无效。');
  const rng = randomStream(initial), matchId = requestId();
  const game = createGame([PRACTICE_SELF, ...PRACTICE_BOTS.slice(0, count - 1)], { matchId, now: 0, serverRandomInt: limit => rng.randomInt(limit), configuration: config });
  const saved = { version: 1, kind: 'parks-local-practice', matchId, logicalNow: 0, rngState: rng.state, game };
  const issue = practiceProblem(saved); if (issue) throw new Error(issue); return saved;
}
function mutateSaved(saved, operation) {
  const issue = practiceProblem(saved); if (issue) return { ok: false, saved, error: issue };
  const logicalNow = saved.logicalNow + 1;
  if (!Number.isSafeInteger(logicalNow)) return { ok: false, saved, error: '本机练习逻辑时间无效。' };
  const rng = randomStream(saved.rngState), result = operation(saved.game, { now: logicalNow, serverRandomInt: limit => rng.randomInt(limit) });
  return result.ok ? { ...result, saved: { ...saved, logicalNow, game: result.state, rngState: rng.state } } : { ...result, saved };
}
export const applyParksPracticeAction = (saved, intent) => mutateSaved(saved, (game, context) => applyGameAction(game, PRACTICE_SELF, intent, context));
export function advanceParksPractice(saved, { elapsedMs = 0, maxSteps = 16 } = {}) {
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 2000 || !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 16) throw new RangeError('练习推进范围无效。');
  const issue = practiceProblem(saved); if (issue) return { ok: false, saved, error: issue };
  // Local practice has no thinking deadline. Wall time controls scheduling,
  // while only committed commands advance the saved logical clock.
  let next = saved, steps = 0;
  for (; steps < maxSteps; steps += 1) {
    if (next.game.status !== 'playing' || next.game.decisionWindow.paused) break;
    const window = next.game.decisionWindow;
    const step = nextSystemStep(next.game);
    let result;
    if (step) result = mutateSaved(next, (game, context) => applySystemStep(game, step, context));
    else if (window.responsibleSeatId && window.responsibleSeatId !== PRACTICE_SELF) {
      const action = chooseParksPracticeAction(privateView(next.game, window.responsibleSeatId, { now: next.logicalNow }));
      if (!action) return { ok: false, saved: next, error: '电脑没有合法行动，保留当前材料。' };
      result = mutateSaved(next, (game, context) => applyGameAction(game, window.responsibleSeatId, action, context));
    } else break;
    if (!result.ok) return result; next = result.saved;
  }
  return { ok: true, saved: next, steps, yielded: steps === maxSteps };
}
export function parksPracticeView(saved) {
  const view = privateView(saved.game, PRACTICE_SELF, { now: saved.logicalNow });
  view.practice = true; view.window.deadlineAt = null; view.window.remainingMs = null;
  return view;
}
export const pauseParksPractice = saved => mutateSaved(saved, (game, context) => pauseGame(game, { ...context, cause: 'manual' }));
export const resumeParksPractice = saved => mutateSaved(saved, (game, context) => resumeGame(game, context));
