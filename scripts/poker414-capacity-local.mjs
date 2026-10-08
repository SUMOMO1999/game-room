// Bounded local capacity evidence: no cloud transport, credentials or deployment.
// Run once per numbered attempt; never overwrite prior observations.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SignJWT, createLocalJWKSet } from 'jose';
import { readSettings, SHARED_ISSUER } from '../server/config.mjs';
import { CognitoProvider, MockProvider } from '../server/auth.mjs';
import { IdentityPolicyClient, IDENTITY_POLICY_ENDPOINT } from '../server/identity-policy-client.mjs';
import { EncryptedStore, SQLiteAdapter } from '../server/storage.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { createGameRegistry, defaultGameRegistry } from '../app/game-registry.mjs';
import { getCard } from '../app/games/poker414-2/cards.mjs';
import { enumerateLegalPlays, chooseResponseCards } from '../app/games/poker414-2/patterns.mjs';
import { createCapacityClient } from './poker414-capacity-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), attempt = process.argv[2] || '1';
if (!['1', '2', 'driver-repair'].includes(attempt)) throw new Error('Use attempt 1, 2 or the single documented driver-repair run');
const output = path.join(root, `ops/poker414-release-2026-10-09/capacity-attempt-${attempt}.json`);
await mkdir(path.dirname(output), { recursive: true });
try { await stat(output); throw new Error('Evidence already exists; do not overwrite or rerun this attempt'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const durationMs = 60000, started = performance.now(), beganAt = new Date().toISOString();
const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
let phase = 'setup', scenarioStart = null, fatal = null, server, storage, directory, runtime, stopping = false;
const members = [], tasks = new Set(), results = { http: [], checks: [], policy: [], authorization: [], views: [], windows: [], actions: [],
  events: [], sqlite: {}, memory: [], streamBytes: {}, timers: [], cleanup: null }, tokenIdentities = new Map(), timers = new Set();
const guardTimers = new Set(), native = { setInterval, clearInterval };
const sources = ['server/runtime.mjs', 'server/unified-http.mjs', 'server/session-service.mjs', 'server/durable-rooms.mjs',
  'server/games/poker414-2/adapter.mjs', 'app/room-client.mjs', 'app/account-client.mjs', 'app/games/poker414-2/room-controller.mjs'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
const sourceBefore = await sourceHashes();
function track(operation) { const promise = Promise.resolve().then(operation).catch(error => { results.events.push({ phase, atMs: elapsed(), type: 'taskError', status: error.status ?? null, message: error.message }); }).finally(() => tasks.delete(promise)); tasks.add(promise); return promise; }
function observe(type, data) {
  const common = { phase, atMs: elapsed(), member: data.member };
  if (type === 'http') { results.http.push({ ...common, ...data }); return; }
  if (type === 'sseBytes') { results.streamBytes[data.member] = (results.streamBytes[data.member] || 0) + data.bytes; return; }
  if (type === 'view') {
    const view = data.view, game = view.game;
    if (view.gameType === 'poker414-2' && game) {
      try {
        assert.equal(Object.hasOwn(game, 'deck'), false);
        const hands = game.players.filter(player => Object.hasOwn(player, 'hand'));
        if (view.selfRole === 'player') { assert.equal(hands.length, 1); assert.equal(hands[0].id, view.selfId); }
        else assert.equal(hands.length, game.players.length);
        assert.ok(!JSON.stringify(view).includes('accessToken'));
      } catch (error) { fatal ||= { type: 'private-projection', atMs: elapsed(), message: error.message }; stopping = true; }
      const window = game.responseWindow;
      if (window && !results.windows.some(item => item.member === data.member && item.windowId === window.id))
        results.windows.push({ ...common, windowId: window.id, deadlineAt: window.deadlineAt, remainingMs: window.deadlineAt - Date.now(), action: window.action });
    }
    results.views.push({ ...common, revision: view.revision, gameType: view.gameType, stage: game?.stage ?? view.phase,
      eventSeq: game?.eventSeq ?? null, targetId: game?.target?.id ?? null, windowId: game?.responseWindow?.id ?? null,
      payloadBytes: Buffer.byteLength(JSON.stringify(view)) }); return;
  }
  results.events.push({ ...common, type, ...data });
}
// Instrument actual timers without shortening the server's watchdog/presence clock.
globalThis.setInterval = (callback, ms, ...args) => {
  const stack = new Error().stack || '', kind = stack.includes('unified-http.mjs') && ms === 15000 ? 'sse-watchdog'
    : stack.includes('durable-rooms.mjs') ? 'room-poll' : stack.includes('unified-http.mjs') ? 'http-housekeeping' : 'other';
  const handle = native.setInterval(() => { results.timers.push({ phase, atMs: elapsed(), kind, ms }); callback(...args); }, ms);
  guardTimers.add(handle); return handle;
};
globalThis.clearInterval = handle => { guardTimers.delete(handle); native.clearInterval(handle); };
const bucket = { tokens: 16, last: performance.now() };
async function syntheticPolicy(url, options) {
  assert.equal(url, IDENTITY_POLICY_ENDPOINT, 'The upstream is a local injected transport, never fetch');
  const identity = tokenIdentities.get(options.headers.Authorization?.slice(7)); assert.ok(identity);
  const current = performance.now(); bucket.tokens = Math.min(16, bucket.tokens + (current - bucket.last) * 12 / 1000); bucket.last = current;
  const item = { phase, atMs: elapsed(), project: identity.project, sub: identity.sub, status: null }; results.policy.push(item);
  if (bucket.tokens < 1) { item.status = 429; return new Response('{}', { status: 429 }); }
  bucket.tokens--;
  try { await sleep(50, undefined, { signal: options.signal }); item.status = 200;
    return new Response(JSON.stringify({ version: 1, revokedBefore: 0, issuer: identity.issuer, sub: identity.sub,
      clientId: identity.clientId, authTime: identity.authTime }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) { item.status = 'aborted'; throw error; }
  finally { item.endedAtMs = elapsed(); item.endedPhase = phase; }
}
const jwt = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function identity(sub, clientId, project = 'game') {
  const seconds = Math.floor(Date.now() / 1000), accessToken = await new SignJWT({ client_id: clientId, token_use: 'access', scope: 'openid', auth_time: seconds })
    .setProtectedHeader({ alg: 'RS256', kid: 'owned-capacity-key' }).setIssuer(SHARED_ISSUER).setSubject(sub)
    .setIssuedAt(seconds).setExpirationTime(seconds + 3600).sign(jwt.privateKey);
  const value = { issuer: SHARED_ISSUER, sub, clientId, authTime: seconds, accessToken, expiresAt: (seconds + 3600) * 1000 };
  tokenIdentities.set(accessToken, { ...value, project }); return value;
}
const stats = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return { count: sorted.length,
  min: sorted[0] ?? null, p50: sorted[Math.floor(sorted.length * .5)] ?? null, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? null, max: sorted.at(-1) ?? null }; };
async function until(test, timeout = 12000) { const end = performance.now() + timeout; while (!test()) { if (fatal) throw new Error(fatal.message); if (performance.now() >= end) return false; await sleep(25); } return true; }
function actionFields(view, type, fields = {}) { return { matchId: view.game.matchId, roundId: view.game.roundId, targetId: view.game.target?.id ?? null,
  ...(['hook', 'fork'].includes(type) ? { windowId: view.game.responseWindow?.id } : {}), ...fields }; }
async function act(member, type, fields = {}) {
  if (member.acting || stopping || !member.client || member.client.stopped) return;
  member.acting = true; const at = performance.now(), before = member.client.view;
  const result = { phase, atMs: elapsed(), member: member.label, type, roundId: before?.game?.roundId, targetId: before?.game?.target?.id ?? null, status: null };
  results.actions.push(result);
  try {
    await member.surface.controller.act(type, fields); result.status = 200;
    result.expectedEventSeq = member.client.view?.game?.eventSeq ?? null;
    result.receiptStatus = 'confirmed';
  } catch (error) { result.status = error.status ?? error.code ?? 'client-error'; result.message = error.message; }
  finally { result.elapsedMs = performance.now() - at; result.endedAtMs = elapsed(); member.acting = false; }
}
let settings, gameCode, oldCode;
try {
  directory = await mkdtemp(path.join(tmpdir(), 'poker414-capacity-'));
  settings = readSettings({ GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'localgamecapacity01', GAME_ROOM_IDENTITY_CHECK_INTERVAL_MS: '125', GAME_ROOM_IDENTITY_BATCH_ENABLED: '0' });
  storage = new EncryptedStore(new SQLiteAdapter(path.join(directory, 'store.sqlite')), randomBytes(32));
  for (const method of ['replace', 'guardedCAS', 'compareAndSwapMany', 'verifyGuards']) {
    const original = storage.adapter[method].bind(storage.adapter), metric = results.sqlite[method] = { calls: 0, conflicts: 0, failures: 0 };
    storage.adapter[method] = async (...args) => { metric.calls++; try { const value = await original(...args); if (value === false) metric.conflicts++; return value; } catch (error) { metric.failures++; throw error; } };
  }
  const checker = new CognitoProvider(settings, { jwks: createLocalJWKSet({ keys: [{ ...jwt.publicKey.export({ format: 'jwk' }), kid: 'owned-capacity-key', alg: 'RS256', use: 'sig' }] }), fetcher: syntheticPolicy });
  assert.ok(checker.policyClient instanceof IdentityPolicyClient); assert.equal(checker.policyClient.intervalMs, 125);
  const mock = new MockProvider(readSettings({ GAME_ROOM_AUTH_MODE: 'mock' })); let loginIdentity;
  const provider = { begin: (...args) => mock.begin(...args), complete: async () => loginIdentity,
    async check(value, options) { const item = { phase, atMs: elapsed(), sub: value.sub, status: null }; results.checks.push(item);
      try { const verified = await checker.check(value, options); item.status = 200; return verified; }
      catch (error) { item.status = error.status ?? null; throw error; } finally { item.endedAtMs = elapsed(); item.endedPhase = phase; } } };
  const registry = createGameRegistry(['rummikub', 'army-flip', 'flying-chess', 'draw-and-guess', 'poker414-2'].map(type => defaultGameRegistry.gameAdapter(type)));
  runtime = createRuntime(settings, { storage, provider, roomOptions: { gameRegistry: registry } });
  const authorize = runtime.sessions.authorize.bind(runtime.sessions);
  runtime.sessions.authorize = async (request, options = {}) => { const item = { phase, atMs: elapsed(), path: new URL(request.url).pathname, fresh: options.fresh ?? false, touch: options.touch ?? true, status: null }; results.authorization.push(item);
    try { const value = await authorize(request, options); item.status = 200; return value; }
    catch (error) { item.status = error.status ?? null; throw error; } finally { item.endedAtMs = elapsed(); item.endedPhase = phase; } };
  server = createUnifiedServer(runtime); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`; settings.origin = base; settings.callback = `${base}/auth/callback`; settings.postLogout = `${base}/`;
  async function request(route, member = {}, body) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { ...(member.cookie ? { Cookie: member.cookie } : {}), ...(body === undefined ? {} : { Origin: base, 'X-CSRF-Token': member.csrf ?? '', 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); observe('http', { member: member.label ?? 'setup-login', path: route.split('?')[0], method: body === undefined ? 'GET' : 'POST', status: response.status });
    return { response, data: text ? JSON.parse(text) : null };
  }
  async function login(index, game, role) {
    loginIdentity = await identity(`capacity-member-${index}`, settings.clientId);
    const start = await request('/auth/login'), destination = new URL(start.response.headers.get('location'));
    const returned = await request(destination.pathname + destination.search, { cookie: start.response.headers.getSetCookie()[0].split(';')[0] });
    assert.equal(returned.response.status, 303);
    const member = { label: `${game === 'poker414-2' ? role === 'spectator' ? 'observer' : 'player' : 'old'}-${index}`, game, role,
      cookie: returned.response.headers.getSetCookie().find(value => value.startsWith(settings.cookieName + '=')).split(';')[0] };
    const state = await request('/api/state', member); assert.equal(state.response.status, 200); member.csrf = state.data.csrf; members.push(member); return member;
  }
  for (let index = 0; index < 18; index++) await login(index, index < 16 ? 'poker414-2' : 'rummikub', index >= 8 && index < 16 ? 'spectator' : 'player');
  for (const member of members) {
    const first = member === members[0] || member === members[16];
    const code = member.game === 'poker414-2' ? gameCode : oldCode;
    const result = await request(first ? '/api/rooms' : `/api/rooms/${code}/join`, member,
      { name: member.label, requestId: randomUUID(), ...(first ? { gameType: member.game } : { role: member.role }) });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    member.code = result.data.roomCode ?? code;
    if (member === members[0]) gameCode = member.code; if (member === members[16]) oldCode = member.code;
  }
  // Establish seats in normal preparation before opening 18 long-lived streams.
  for (const member of [...members.slice(0, 8), ...members.slice(16)]) {
    const view = (await request(`/api/rooms/${member.code}`, member)).data.view;
    const ready = await request(`/api/rooms/${member.code}/actions`, member, { type: 'ready', ready: true, requestId: randomUUID(), expectedRevision: view.revision });
    assert.equal(ready.response.status, 200);
  }
  for (const member of members) {
    member.surface = await createCapacityClient({ appRoot: path.join(root, 'app'), base, member, observe });
    assert.ok(await until(() => member.client?.view && results.streamBytes[member.label] > 0, 12000), `client not ready: ${member.label}`);
  }
  for (const member of [members[16], members[0]]) await act(member, 'start');
  if (!await until(() => members[0].client?.view?.game?.stage === 'playing', 20000)) results.events.push({ phase, atMs: elapsed(), type: 'deal-not-confirmed' });
  phase = 'trajectory'; scenarioStart = performance.now();
  results.events.push({ phase, atMs: elapsed(), type: 'trajectory-start', online: members.filter(member => member.client && !member.client.stopped).length });
  const backgroundClients = ['agora', 'calendar'].map(project => ({ project, client: new IdentityPolicyClient({ fetcher: syntheticPolicy }), identity: null }));
  for (const item of backgroundClients) item.identity = await identity(`capacity-${item.project}-competitor`, `local${item.project}capacity01`, item.project);
  let tick = 0, burstSent = false, recovered = false, oldLastMove = 0;
  const interval = setInterval(() => {
    if (stopping || performance.now() - scenarioStart >= durationMs) return;
    const item = backgroundClients[tick++ % 2]; track(() => item.client.check(item.identity));
  }, 250); timers.add(interval);
  while (!stopping && performance.now() - scenarioStart < durationMs) {
    const passed = performance.now() - scenarioStart;
    results.memory.push({ atMs: elapsed(), rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed,
      alive: members.filter(member => member.client && !member.client.stopped).length });
    const observed = members.slice(0, 16).find(member => member.client?.view?.game?.stage === 'playing' && !member.client.stopped)?.client.view;
    const window = observed?.game?.responseWindow;
    if (!burstSent && window && window.deadlineAt - Date.now() > 500) {
      const eligible = members.slice(0, 8).filter(member => member.client?.view?.game?.responseWindow?.id === window.id && member.client.view.selfId !== observed.game.target.ownerId
        && chooseResponseCards(Array.from(member.client.view.game.players.find(player => player.id === member.client.view.selfId)?.hand ?? []), window.rank, window.action));
      if (eligible.length >= 2) { burstSent = true; results.events.push({ phase, atMs: elapsed(), type: 'response-burst', count: eligible.length });
        for (const member of eligible.slice(0, 3)) track(() => act(member, window.action)); }
    }
    if (observed) {
      const actor = members.slice(0, 8).find(member => member.client?.view?.selfId === observed.game.turnPlayerId && member.client.view.game?.stage === 'playing' && member.client.view.game.turnPlayerId === member.client.view.selfId && !member.client.stopped);
      if (actor && !actor.acting) {
        // Copy across the test VM boundary; production module validation stays strict.
        const own = structuredClone(actor.client.view.game), hand = own.players.find(player => player.id === actor.client.view.selfId)?.hand ?? [];
        const choices = hand.length ? enumerateLegalPlays(hand, own.target?.pattern ?? null) : [];
        if (!hand.length) { await sleep(1000); continue; }
        const full = members.slice(8, 16).find(member => !member.client.stopped && member.client.view?.game?.stage === 'playing')?.client.view?.game;
        const singles = choices.filter(play => play.pattern?.kind === 'single' && getCard(play.cardIds[0]).rank <= 15);
        const withResponders = !burstSent && full && singles.find(play => full.players.filter(player => player.id !== actor.client.view.selfId && chooseResponseCards(Array.from(player.hand ?? []), play.pattern.rank, 'fork')).length >= 2);
        const selected = withResponders || singles[0] || choices[0];
        track(() => act(actor, selected ? 'play' : 'pass', selected ? { cardIds: selected.cardIds } : {}));
      }
    }
    if (!recovered && passed > 20000) { recovered = true; const selected = members[15];
      results.events.push({ phase, atMs: elapsed(), type: 'injected-transport-EOF', member: selected.label }); selected.breakStream?.(); }
    if (passed > oldLastMove + 15000) { oldLastMove = passed;
      const old = members.slice(16).find(member => member.client?.view?.game?.turnPlayerId === member.client.view.selfId && !member.client.stopped);
      if (old) track(() => act(old, 'draw')); }
    if (Math.floor(passed / 1000) % 15 === 5) {
      const speaker = members.find(member => member.client && !member.client.stopped);
      if (speaker) track(() => speaker.client.sendChat({ text: '本机容量验证消息', requestId: randomUUID() }));
    }
    await sleep(1000);
  }
  clearInterval(interval); timers.delete(interval);
  phase = 'drain'; await Promise.all([...tasks]);
  results.events.push({ phase, atMs: elapsed(), type: 'trajectory-end', actualDurationMs: performance.now() - scenarioStart,
    responseBurstSent: burstSent, transportRecoveryInjected: recovered, online: members.filter(member => member.client && !member.client.stopped).length });
} catch (error) { fatal ||= { type: 'experiment', phase, atMs: elapsed(), name: error.name, message: error.message }; }
finally {
  phase = 'cleanup'; stopping = true;
  for (const timer of timers) clearInterval(timer); timers.clear();
  const clientCleanup = await Promise.all(members.map(async member => ({ member: member.label, ...(member.surface ? await member.surface.close() : { notOpened: true }) })));
  await Promise.allSettled([...tasks]);
  if (server) { server.closeAllConnections(); await server.shutdown().catch(error => { fatal ||= { type: 'cleanup', message: error.message }; }); }
  else storage?.close();
  let databaseClosed = !storage;
  if (storage) { try { storage.adapter.db.prepare('SELECT 1').get(); } catch { databaseClosed = true; } }
  await sleep(100);
  if (directory) await rm(directory, { recursive: true, force: true });
  let directoryRemoved = true; if (directory) { try { await stat(directory); directoryRemoved = false; } catch {} }
  results.cleanup = { databaseClosed, directoryRemoved, clientCleanup, timerCount: timers.size, serverIntervalsRemaining: guardTimers.size,
    allChecksSettled: results.checks.every(item => item.endedAtMs !== undefined) };
  for (const timer of guardTimers) native.clearInterval(timer);
  globalThis.setInterval = native.setInterval; globalThis.clearInterval = native.clearInterval;
  const sourceAfter = await sourceHashes();
  const activeChecks = results.checks.filter(item => item.phase === 'trajectory'), activePolicy = results.policy.filter(item => item.phase === 'trajectory');
  const failures = results.http.filter(item => item.status >= 400), windows = results.windows.filter(item => item.phase === 'trajectory');
  const summary = { status: fatal ? 'EXPERIMENT_FAILED' : failures.some(item => item.status === 503) || windows.some(item => item.remainingMs <= 0)
    ? 'LOCAL_CAPACITY_LIMIT_OBSERVED' : 'LOCAL_TRAJECTORY_COMPLETED', fatal,
    actionLatencyMs: stats(results.actions.filter(item => item.phase === 'trajectory' && item.status === 200).map(item => item.elapsedMs)),
    windowRemainingMs: stats(windows.map(item => item.remainingMs)), expiredOnArrival: windows.filter(item => item.remainingMs <= 0).length,
    logicalAuthorizationChecks: activeChecks.length, policyDispatches: activePolicy.length, batchEnvelopes: 0,
    logicalCheckMs: stats(activeChecks.map(item => item.endedAtMs - item.atMs)),
    upstreamByProject: Object.fromEntries(['game', 'calendar', 'agora'].map(project => [project, activePolicy.filter(item => item.project === project).length])),
    httpErrors: Object.fromEntries([...new Set(failures.map(item => item.status))].map(status => [status, failures.filter(item => item.status === status).length])),
    policy429: results.policy.filter(item => item.status === 429).length, identity503: results.checks.filter(item => item.status === 503 && item.endedPhase !== 'cleanup').length, cleanupCancelledChecks: results.checks.filter(item => item.status === 503 && item.endedPhase === 'cleanup').length,
    sseBytes: Object.values(results.streamBytes).reduce((sum, bytes) => sum + bytes, 0),
    deliveredViews: results.views.length, memoryRss: stats(results.memory.map(item => item.rss)),
    sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter) };
  await writeFile(output, JSON.stringify({ schema: 'game.poker414.local-capacity.v1', beganAt, finishedAt: new Date().toISOString(), attempt: attempt === 'driver-repair' ? 'driver-repair' : Number(attempt),
    method: { durationMs, actualRoomClient: true, actualController: true, actualAccountLifecycle: true, actualHttpSse: true, actualSessionService: true,
      storage: 'real isolated encrypted SQLite', players: 8, spectators: 8, oldGame: 'rummikub two players', identity: 'ephemeral locally signed JWT and local JWKS; real CognitoProvider and legacy IdentityPolicyClient',
      identityBatchEnabled: false, identityIntervalMs: 125, policyQueueMs: 4000, policyDeadlineMs: 8000, syntheticPolicyDelayMs: 50,
      sharedSyntheticRouteRps: 12, sharedSyntheticRouteBurst: 16, otherProjectsSyntheticRps: 4,
      successfulAuthorizationCache: false, realProviderCalls: 0, realCentralCapacityVerified: false, cloudWrites: 0,
      source: 'saved Agora 2026-10-08 check route applied proof; current shared headroom remains unknown',
      limitations: ['No real Agora/calendar browser business lifecycle', 'No phone, browser paint or network jitter simulation', 'No live production environment readback', 'Shared route token bucket is a local deterministic model, not AWS best-effort throttling'] },
    sourceBefore, sourceAfter, summary, results }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, ...summary, cleanup: results.cleanup }));
}
