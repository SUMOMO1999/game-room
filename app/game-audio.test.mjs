import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeSourceSync as readFileSync } from './test-support/runtime-source.mjs';
import { createGameAudio } from './game-audio.mjs';
import { mountRoomAudioControls } from './platform/room-audio-controls.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  let clock = 1000;
  const values = new Map(), writes = [], contexts = [], listeners = new Map(), windowListeners = new Map(), timers = new Map();
  let timerSerial = 0;
  const document = { hidden: false, visibilityState: 'visible',
    defaultView: { navigator: { userActivation: { isActive: true } },
      addEventListener(type, callback) { windowListeners.set(type, callback); },
      removeEventListener(type, callback) { if (windowListeners.get(type) === callback) windowListeners.delete(type); } },
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); } };
  const storage = { getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); writes.push([key, value]); } };
  if (options.preference !== undefined) values.set('game-room:audio:v1', options.preference);
  function parameter() {
    return { calls: [],
      setValueAtTime(value, at) { assert.ok(Number.isFinite(value) && Number.isFinite(at)); this.calls.push(['set', value, at]); },
      linearRampToValueAtTime(value, at) { assert.ok(Number.isFinite(value) && Number.isFinite(at)); this.calls.push(['linear', value, at]); },
      exponentialRampToValueAtTime(value, at) { assert.ok(value > 0 && Number.isFinite(value) && Number.isFinite(at)); this.calls.push(['exponential', value, at]); },
      cancelScheduledValues(at) { this.calls.push(['cancel', at]); },
      setTargetAtTime(value, at, constant) { this.calls.push(['target', value, at, constant]); } };
  }
  class AudioContext {
    constructor() {
      if (options.constructorFailure) throw new Error('No audio hardware');
      this.state = options.initialState || 'suspended'; this.currentTime = 42;
      this.destination = {}; this.gains = []; this.oscillators = []; this.compressors = []; this.resumeCalls = 0; this.closeCalls = 0; this.suspendCalls = 0; this.onstatechange = null;
      contexts.push(this);
    }
    createGain() {
      if (options.gainFailure) throw new Error('Gain unavailable');
      const gain = { gain: parameter(), disconnected: false, connect(target) { if (options.connectFailure) throw new Error('Destination closed'); assert.ok(target); this.target=target; },
        disconnect() { this.disconnected = true; } };
      this.gains.push(gain); return gain;
    }
    createDynamicsCompressor() {
      if (options.compressorFailure) throw new Error('Compressor unavailable');
      if (!options.compressor) return undefined;
      const node={threshold:parameter(),knee:parameter(),ratio:parameter(),attack:parameter(),release:parameter(),
        connect(target){this.target=target;},disconnect(){this.disconnected=true;}};
      this.compressors.push(node);return node;
    }
    createOscillator() {
      if (options.oscillatorFailure) throw new Error('Audio interrupted');
      const oscillator = { frequency: parameter(), starts: [], stops: [], disconnected: false, onended: null,
        connect(target) { assert.ok(target); }, disconnect() { this.disconnected = true; },
        start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at); },
        finish() { this.onended?.(); } };
      this.oscillators.push(oscillator); return oscillator;
    }
    async resume() {
      ++this.resumeCalls;
      if (options.resumeFailure) throw new Error('User activation denied');
      if (options.resumePending) await options.resumePending.promise;
      if (!options.resumeStaysSuspended) this.state = 'running';
    }
    transition(state) { this.state = state; this.onstatechange?.(); }
    async suspend() { ++this.suspendCalls; this.transition('suspended'); }
    async close() { ++this.closeCalls; this.transition('closed'); if (options.closeFailure) throw new Error('Already closed'); }
  }
  const audio = createGameAudio({ storage: options.storage || storage, AudioContext: options.AudioContext ?? AudioContext,
    document, now: () => clock,
    setTimeout(callback, delay) { const id = ++timerSerial; timers.set(id, { at: clock + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  return { audio, document, contexts, writes, values, options,
    advance(ms) { clock += ms; },
    tick(ms) { clock += ms; for (const [id, item] of [...timers]) if (item.at <= clock && timers.has(id)) { timers.delete(id); item.callback(); } },
    page(type) { windowListeners.get(type)?.(); },
    timers, windowListeners,
    visibility(hidden) { document.hidden = hidden; document.visibilityState = hidden ? 'hidden' : 'visible'; listeners.get('visibilitychange')?.(); },
    listeners, finish() { for (const context of contexts) for (const source of context.oscillators) source.finish(); } };
}

function bindActualPageGestures(filename, document, audio) {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  assert.match(source, /mountRoomAudioControls\(\{\s*audio,\s*document/, `${filename}: actual shared audio controls are mounted`);
  document.getElementById = () => null;
  return mountRoomAudioControls({ document, audio });
}

test('actual game entries unlock on the first trusted touch release, share one context, and stay closed after disposal', async t => {
  for (const filename of ['app.mjs', 'army-room.mjs', 'army-practice.mjs', 'games/flying-chess/page-ui.mjs', 'games/poker414-2/page-ui.mjs']) {
    for (const release of ['pointerup', 'touchend']) await t.test(`${filename}: ${release}`, async subtest => {
      const pending = deferred(), f = fixture({ resumePending: pending });
      subtest.after(() => f.audio.close());
      const activation = f.document.defaultView.navigator.userActivation;
      const emit = (type, isTrusted = true) => f.listeners.get(type)?.({ isTrusted, pointerType: 'touch', target: { closest: () => null } });
      const settle = () => new Promise(resolve => setImmediate(resolve));
      bindActualPageGestures(filename, f.document, f.audio);
      activation.isActive = true;
      for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend']) emit(type, false);
      await settle(); assert.equal(f.contexts.length, 0, 'untrusted release cannot authorize sound');

      // A non-mouse pointer receives browser activation on release, not down.
      activation.isActive = false; emit('pointerdown'); emit('touchstart');
      await settle(); assert.equal(f.contexts.length, 0);
      activation.isActive = true; emit(release); emit('pointerup'); emit('touchend');
      assert.equal(f.contexts.length, 1, 'the first activated release creates its audio context');
      assert.equal(f.contexts[0].resumeCalls, 1, 'overlapping release handlers share the pending resume');
      assert.equal(f.audio.state().ready, false);
      pending.resolve(); await settle(); assert.equal(f.audio.state().ready, true);
      assert.equal(f.contexts[0].oscillators.length, 0, 'unlocking does not replay missed notification cues');
      emit('pointerup'); emit('touchend'); await settle();
      assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].resumeCalls, 1);

      await f.audio.close();
      for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend']) emit(type);
      await settle(); assert.equal(f.contexts.length, 1); assert.equal(f.audio.state().ready, false);
      assert.equal(f.contexts[0].state, 'closed'); assert.equal(f.contexts[0].closeCalls, 1);
      assert.ok(f.contexts[0].gains.every(node => node.disconnected)); assert.equal(f.timers.size, 0);
    });
  }
});

test('opening or reconnecting a game cannot create audio or queue cues before the first gesture', async () => {
  const { audio, contexts } = fixture();
  assert.equal(audio.state().muted, false); assert.equal(audio.state().volume, 0.45);
  for (const kind of ['placement', 'draw', 'turn', 'commit', 'invalid', 'chat', 'win', 'loss', 'draw-result']) assert.equal(audio.play(kind), false);
  assert.equal(contexts.length, 0);
  assert.equal(await audio.unlock(), true);
  assert.equal(contexts.length, 1); assert.equal(contexts[0].oscillators.length, 0);
  assert.equal(audio.play('placement'), true);
  await audio.close();
});

test('unlock refuses a known inactive gesture and hidden pages', async () => {
  const { audio, document, contexts, visibility } = fixture();
  document.defaultView.navigator.userActivation.isActive = false;
  assert.equal(await audio.unlock(), false); assert.equal(contexts.length, 0);
  document.defaultView.navigator.userActivation.isActive = true; visibility(true);
  assert.equal(await audio.unlock(), false); assert.equal(contexts.length, 0);
  visibility(false); assert.equal(await audio.unlock(), true);
  await audio.close();
});

test('browsers without the userActivation API still rely on their own resume permission', async () => {
  const { audio, document, contexts } = fixture();
  delete document.defaultView.navigator.userActivation;
  assert.equal(await audio.unlock(), true); assert.equal(contexts[0].resumeCalls, 1);
  await audio.close();
});

test('simultaneous gesture handlers share one initialization without replaying a blocked cue', async () => {
  const resumePending = deferred(), { audio, contexts } = fixture({ resumePending });
  const first = audio.unlock(), second = audio.unlock();
  assert.equal(contexts.length, 1); assert.equal(contexts[0].resumeCalls, 1);
  assert.equal(audio.play('turn'), false);
  resumePending.resolve(); assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(contexts[0].oscillators.length, 0); await audio.close();
});

test('all game cues stay brief and bounded, and ended sources release their nodes', async () => {
  const { audio, contexts, finish, advance } = fixture(); await audio.unlock();
  for (const kind of ['placement', 'draw', 'turn', 'commit', 'invalid', 'chat', 'win', 'loss', 'draw-result']) {
    advance(2000); assert.equal(audio.play(kind), true);
    for (const source of contexts[0].oscillators) {
      assert.ok(source.starts[0] >= 42); assert.ok(source.stops[0] - 42 < 0.65);
    }
    finish();
    assert.ok(contexts[0].oscillators.every((source) => source.disconnected));
    assert.ok(contexts[0].gains.slice(1).every((gain) => gain.disconnected));
  }
  assert.equal(audio.play('music'), false); assert.equal(audio.play({}), false);
  await audio.close();
});

test('rapid dragging and repeated turn notifications are throttled without suppressing the next valid action', async () => {
  const { audio, contexts, advance, finish } = fixture(); await audio.unlock();
  assert.equal(audio.play('placement'), true); const count = contexts[0].oscillators.length;
  for (let index = 0; index < 30; ++index) assert.equal(audio.play('placement'), false);
  assert.equal(contexts[0].oscillators.length, count); finish(); advance(100);
  assert.equal(audio.play('placement'), true); finish();
  assert.equal(audio.play('turn'), true); finish(); advance(300);
  assert.equal(audio.play('turn'), false); advance(800); assert.equal(audio.play('turn'), true);
  await audio.close();
});

test('overlapping delayed cues have a finite voice budget and playback recovers after completion', async () => {
  const { audio, contexts, advance, finish } = fixture(); await audio.unlock();
  for (let index = 0; index < 6; ++index) { advance(100); assert.equal(audio.play('placement'), true); }
  const count = contexts[0].oscillators.length;
  advance(100); assert.equal(audio.play('placement'), false); assert.equal(contexts[0].oscillators.length, count);
  finish(); assert.equal(audio.play('placement'), true); await audio.close();
});

test('muting immediately stops active cues and saves only this device sound preference', async () => {
  const { audio, contexts, writes, advance } = fixture(); await audio.unlock(); audio.play('win');
  audio.setMuted(true);
  assert.ok(contexts[0].oscillators.every((source) => source.disconnected && source.stops.length === 2));
  assert.equal(audio.play('placement'), false);
  assert.deepEqual(writes.at(-1), ['game-room:audio:v1', '{"version":1,"muted":true,"volume":0.45}']);
  audio.setMuted(false); advance(2000); assert.equal(audio.play('placement'), true);
  await audio.close();
});

test('volume is clamped, zero is silent, and invalid settings do not poison the audio graph', async () => {
  const { audio, contexts, advance } = fixture(); await audio.unlock();
  assert.equal(audio.setVolume(9).volume, 1); assert.equal(audio.setVolume(-2).volume, 0);
  assert.equal(audio.play('draw'), false);
  assert.equal(audio.setVolume(NaN).volume, 0); assert.equal(audio.setVolume(Infinity).volume, 0);
  assert.equal(audio.setVolume('0.8').volume, 0);
  assert.equal(audio.setVolume(0.3).volume, 0.3); advance(2000); assert.equal(audio.play('draw'), true);
  assert.deepEqual(contexts[0].gains[0].gain.calls.at(-1), ['target', 0.3, 42, 0.01]);
  await audio.close();
});

test('saved preferences restore safely; malformed or incompatible records use defaults', async () => {
  for (const preference of ['not-json', '{"version":2,"volume":0.9,"muted":true}', 'null']) {
    const { audio } = fixture({ preference }); assert.equal(audio.state().volume, 0.45); assert.equal(audio.state().muted, false); await audio.close();
  }
  const { audio } = fixture({ preference: '{"version":1,"volume":15,"muted":true,"account":"ignored"}' });
  assert.equal(audio.state().volume, 1); assert.equal(audio.state().muted, true); await audio.close();
});

test('storage refusal and absent audio hardware cannot break gameplay', async () => {
  const storage = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Full'); } };
  const { audio } = fixture({ storage, AudioContext: false });
  assert.equal(audio.state().supported, false); assert.equal(await audio.unlock(), false);
  assert.equal(audio.play('draw'), false); assert.doesNotThrow(() => audio.setMuted(true));
  assert.doesNotThrow(() => audio.setVolume(0.25)); await audio.close();
});

test('visibility loss cancels active and future notes; returning alone never replays them', async () => {
  const { audio, contexts, visibility, advance } = fixture(); await audio.unlock(); audio.play('win');
  visibility(true); assert.equal(audio.state().ready, false);
  assert.ok(contexts[0].oscillators.every((source) => source.disconnected));
  advance(2000); assert.equal(audio.play('turn'), false);
  const count = contexts[0].oscillators.length; visibility(false);
  assert.equal(audio.play('turn'), false); assert.equal(contexts[0].oscillators.length, count);
  await audio.unlock(); assert.equal(audio.play('turn'), true); await audio.close();
});

test('an interrupted notification can resume its graph but still needs a gesture before playback', async () => {
  const { audio, contexts } = fixture(); await audio.unlock();
  contexts[0].state = 'suspended'; const calls = contexts[0].resumeCalls;
  assert.equal(audio.state().ready, false); assert.equal(audio.play('placement'), false);
  assert.equal(contexts[0].resumeCalls, calls + 1); assert.equal(audio.state().ready, false); await audio.unlock();
  assert.equal(audio.play('placement'), true); await audio.close();
});

test('audio construction, resume, synthesis and close failures are handled without throwing or queuing', async () => {
  const construction = fixture({ constructorFailure: true }); assert.equal(await construction.audio.unlock(), false); await construction.audio.close();
  const gain = fixture({ gainFailure: true }); assert.equal(await gain.audio.unlock(), false); assert.equal(gain.contexts[0].state, 'closed');
  gain.options.gainFailure = false; assert.equal(await gain.audio.unlock(), true); assert.equal(gain.contexts.length, 2); await gain.audio.close();
  const connection = fixture({ connectFailure: true }); assert.equal(await connection.audio.unlock(), false);
  assert.equal(connection.contexts[0].state, 'closed'); assert.equal(connection.contexts[0].gains[0].disconnected, true);
  connection.options.connectFailure = false; assert.equal(await connection.audio.unlock(), true); await connection.audio.close();
  const resume = fixture({ resumeFailure: true }); assert.equal(await resume.audio.unlock(), false);
  resume.options.resumeFailure = false; assert.equal(await resume.audio.unlock(), true); assert.equal(resume.contexts.length, 1); await resume.audio.close();
  const synthesis = fixture({ oscillatorFailure: true, closeFailure: true }); await synthesis.audio.unlock();
  assert.equal(synthesis.audio.play('draw'), false); synthesis.options.oscillatorFailure = false;
  assert.equal(synthesis.audio.state().ready, false); assert.equal(await synthesis.audio.unlock(), true);
  assert.equal(synthesis.audio.play('draw'), true); await synthesis.audio.close();
});

test('close is idempotent and late unlock completion cannot resurrect or play a closed instance', async () => {
  const resumePending = deferred(), { audio, contexts, listeners } = fixture({ resumePending });
  const pending = audio.unlock(); await audio.close();
  resumePending.resolve(); assert.equal(await pending, false);
  assert.equal(audio.state().closed, true); assert.equal(audio.state().ready, false);
  assert.equal(await audio.unlock(), false); assert.equal(audio.play('win'), false);
  assert.equal(listeners.size, 0); await audio.close(); assert.equal(contexts[0].closeCalls, 1);
});

test('placement, draw, turn, chat and the three game outcomes have distinct synthesized signatures',async()=>{
  const f=fixture();await f.audio.unlock();const signatures=[];
  for(const kind of ['placement','draw','turn','chat','win','loss','draw-result']) {
    const start=f.contexts[0].oscillators.length;f.advance(2000);assert.equal(f.audio.play(kind),true);
    signatures.push(JSON.stringify(f.contexts[0].oscillators.slice(start).map(source=>({shape:source.type,pitch:source.frequency.calls,times:[source.starts[0],source.stops[0]]}))));f.finish();
  }
  assert.equal(new Set(signatures).size,7);f.visibility(true);f.advance(2000);assert.equal(f.audio.play('chat'),false);assert.equal(f.audio.play('loss'),false);assert.equal(f.audio.play('draw-result'),false);await f.audio.close();
});


test('Home Screen reopening shows sound awaiting a gesture even when the device preference is on', async () => {
  const f = fixture();
  assert.equal(f.audio.state().muted, false);
  assert.equal(f.audio.state().needsGesture, true);
  assert.equal(f.audio.state().contextState, 'uninitialized');
  const states = [];
  const unsubscribe = f.audio.onStateChange(state => states.push(state));
  await f.audio.unlock(); assert.equal(f.audio.state().needsGesture, false);
  assert.equal(f.audio.state().contextState, 'running');
  f.audio.play('win'); f.page('pagehide');
  assert.equal(f.audio.state().needsGesture, true);
  assert.equal(f.audio.state().suspended, true);
  assert.equal(f.contexts[0].suspendCalls, 1);
  f.page('pageshow'); f.page('focus');
  const resumeCalls = f.contexts[0].resumeCalls;
  assert.equal(f.audio.play('turn'), false);
  assert.equal(f.contexts[0].resumeCalls, resumeCalls);
  assert.equal(f.contexts[0].oscillators.length, 3);
  await f.audio.unlock(); assert.equal(f.audio.state().ready, true);
  assert.ok(states.some(state => state.needsGesture && !state.ready));
  unsubscribe(); await f.audio.close();
  assert.equal(f.windowListeners.size, 0);
});

test('iOS suspended and interrupted state changes revoke readiness and notify the sound controls', async () => {
  const f = fixture(), states = [];
  f.audio.onStateChange(state => states.push(state));
  for (const interruption of ['suspended', 'interrupted']) {
    await f.audio.unlock(); f.advance(2000); f.audio.play('win');
    const oldSources = [...f.contexts[0].oscillators], calls = f.contexts[0].resumeCalls;
    f.contexts[0].transition(interruption);
    assert.equal(f.audio.state().unlocked, false); assert.equal(f.audio.state().ready, false);
    assert.equal(f.audio.state().contextState, interruption); assert.equal(f.audio.state().needsGesture, true);
    assert.ok(oldSources.every(source => source.disconnected));
    f.contexts[0].transition('running');
    assert.equal(f.audio.state().ready, false); assert.equal(f.audio.play('placement'), false);
    assert.equal(f.contexts[0].resumeCalls, calls);
  }
  await f.audio.unlock(); assert.equal(f.audio.state().ready, true);
  assert.ok(states.some(state => state.contextState === 'interrupted' && state.needsGesture));
  await f.audio.close();
});

test('the first action gesture can produce its local cue once resume succeeds without an extra switch tap', async () => {
  const resumePending = deferred(), f = fixture({ resumePending });
  const pending = f.audio.unlock();
  assert.equal(f.audio.state().ready, false);
  assert.equal(f.audio.play('placement', { gesture: true }), true);
  assert.equal(f.audio.play('turn', { gesture: true }), false);
  assert.equal(f.audio.play('chat', { gesture: true }), false);
  assert.equal(f.contexts[0].oscillators.length, 0);
  resumePending.resolve(); assert.equal(await pending, true);
  assert.equal(f.contexts[0].oscillators.length, 2);
  assert.equal(f.audio.state().ready, true); await f.audio.close();
});

test('a hanging WebKit resume times out and later taps rebuild audio while stale completion stays silent', async () => {
  const firstResume = deferred(), f = fixture({ resumePending: firstResume });
  const first = f.audio.unlock(); f.audio.play('placement', { gesture: true });
  f.tick(999); assert.equal(f.audio.state().contextState, 'suspended');
  f.tick(1); assert.equal(await first, false);
  assert.equal(f.audio.state().contextState, 'uninitialized'); assert.equal(f.contexts[0].closeCalls, 1);
  f.options.resumePending = null;
  assert.equal(await f.audio.unlock(), true); assert.equal(f.contexts.length, 2);
  firstResume.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.contexts[0].oscillators.length, 0); assert.equal(f.contexts[1].oscillators.length, 0);
  assert.equal(f.audio.state().ready, true);
  assert.equal(f.audio.play('placement'), true); assert.equal(f.contexts[1].oscillators.length, 2);
  await f.audio.close();
});

test('WebKit actual running state resolves a stuck resume promise without falsely waiting for its callback', async () => {
  const resumePending = deferred(), f = fixture({ resumePending });
  const pending = f.audio.unlock(); f.audio.play('draw', { gesture: true });
  f.contexts[0].transition('running'); assert.equal(await pending, true);
  assert.equal(f.audio.state().ready, true); assert.equal(f.contexts[0].oscillators.length, 2);
  assert.equal(f.timers.size, 0);
  resumePending.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.contexts[0].oscillators.length, 2); await f.audio.close();
});

test('resume rejection and interruption cancel retained actions and a subsequent trusted tap recovers', async () => {
  const rejection = fixture({ resumeFailure: true });
  const pending = rejection.audio.unlock(); rejection.audio.play('placement', { gesture: true });
  assert.equal(await pending, false); assert.equal(rejection.audio.state().needsGesture, true);
  assert.equal(rejection.contexts[0].oscillators.length, 0);
  rejection.options.resumeFailure = false; assert.equal(await rejection.audio.unlock(), true);
  assert.equal(rejection.contexts[0].oscillators.length, 0); await rejection.audio.close();
  const resumePending = deferred(), f = fixture({ resumePending });
  const interrupted = f.audio.unlock(); f.audio.play('draw', { gesture: true });
  f.contexts[0].transition('interrupted'); assert.equal(await interrupted, false);
  resumePending.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.audio.state().ready, false); assert.equal(f.contexts[0].oscillators.length, 0);
  assert.equal(await f.audio.unlock(), true); assert.equal(f.audio.play('draw'), true); await f.audio.close();
});

test('background, loss of focus, mute and zero volume discard pending gesture audio without missed replay', async () => {
  for (const revoke of [f => f.visibility(true), f => f.page('pagehide'), f => f.page('blur'),
    f => f.audio.setMuted(true), f => f.audio.setVolume(0)]) {
    const resumePending = deferred(), f = fixture({ resumePending });
    const pending = f.audio.unlock(); f.audio.play('draw', { gesture: true }); revoke(f);
    resumePending.resolve(); await pending;
    assert.ok(f.contexts.every(context => context.oscillators.length === 0));
    f.visibility(false); f.audio.setMuted(false); f.audio.setVolume(0.45);
    await f.audio.unlock(); assert.ok(f.contexts.every(context => context.oscillators.length === 0));
    await f.audio.close();
  }
});

test('a visible window blur and focus keep already activated audio audible without another gesture', async () => {
  const f = fixture(); await f.audio.unlock();
  const context = f.contexts[0], resumeCalls = context.resumeCalls;
  f.document.defaultView.navigator.userActivation.isActive = false;
  f.page('blur'); f.page('focus');
  assert.equal(f.document.hidden, false);
  assert.equal(f.audio.state().ready, true); assert.equal(f.audio.state().needsGesture, false);
  assert.equal(context.suspendCalls, 0); assert.equal(context.closeCalls, 0);
  assert.equal(context.resumeCalls, resumeCalls); assert.equal(f.contexts.length, 1);
  assert.equal(f.audio.play('turn'), true); assert.equal(f.audio.play('chat'), true);
  assert.equal(context.oscillators.length, 4);
  await f.audio.close(); assert.equal(f.windowListeners.size, 0); assert.equal(f.listeners.size, 0);
});

test('visible blur never unlocks a new or interrupted graph and later hidden/pagehide still revoke old activation', async () => {
  for (const revoke of [f => f.visibility(true), f => f.page('pagehide')]) {
    const f = fixture(); f.page('blur'); f.page('focus');
    assert.equal(f.contexts.length, 0); assert.equal(f.audio.play('turn'), false);
    await f.audio.unlock(); f.page('blur'); revoke(f);
    f.visibility(false); f.page('focus');
    assert.equal(f.audio.state().ready, false); assert.equal(f.audio.play('chat'), false);
    assert.equal(f.contexts[0].suspendCalls, 1);
    await f.audio.close();
  }
  const f = fixture(); await f.audio.unlock(); f.contexts[0].transition('interrupted');
  f.page('blur'); f.page('focus');
  assert.equal(f.audio.state().ready, false); assert.equal(f.audio.state().needsGesture, true);
  assert.equal(f.audio.play('turn'), false);
  assert.equal(f.contexts.length, 1); await f.audio.close();
});

test('one pending gesture retains only its latest action and control subscribers cannot break playback', async () => {
  const resumePending = deferred(), f = fixture({ resumePending });
  f.audio.onStateChange(() => { throw new Error('Detached controls'); });
  const first = f.audio.unlock(), second = f.audio.unlock();
  assert.equal(f.contexts.length, 1); assert.equal(f.contexts[0].resumeCalls, 1);
  f.audio.play('placement', { gesture: true }); f.audio.play('draw', { gesture: true });
  resumePending.resolve(); assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(f.contexts[0].oscillators.length, 2);
  assert.deepEqual(f.contexts[0].oscillators[0].frequency.calls[0], ['set', 380, 42]);
  await f.audio.close();
});

test('foreground recovery rebuilds an old running context only inside the next trusted tap', async () => {
  const f = fixture(); await f.audio.unlock(); f.audio.play('win'); const old = f.contexts[0];
  f.visibility(true); f.visibility(false);
  // Models WebKit's old graph reporting running again while its clock is stuck.
  old.transition('running'); f.page('pageshow'); f.page('focus');
  assert.equal(f.audio.state().ready, false); assert.equal(f.audio.play('turn'), false);
  assert.equal(f.contexts.length, 1); assert.equal(old.closeCalls, 0);
  f.document.defaultView.navigator.userActivation.isActive = false;
  assert.equal(await f.audio.unlock(), false); assert.equal(f.contexts.length, 1);
  f.document.defaultView.navigator.userActivation.isActive = true;
  assert.equal(await f.audio.unlock(), true); assert.equal(old.closeCalls, 1); assert.equal(f.contexts.length, 2);
  assert.equal(old.oscillators.length, 3); assert.equal(f.contexts[1].oscillators.length, 0);
  assert.equal(f.audio.play('placement'), true); await f.audio.close();
});

test('late pageshow and focus cannot cancel a fresh restoring action or turn sound off again', async () => {
  const f = fixture(); await f.audio.unlock(); f.page('pagehide');
  const resumePending = deferred(); f.options.resumePending = resumePending;
  const pending = f.audio.unlock(); f.audio.play('draw', { gesture: true });
  f.page('pageshow'); f.page('focus');
  assert.equal(f.contexts.length, 2); assert.equal(f.contexts[1].closeCalls, 0);
  resumePending.resolve(); assert.equal(await pending, true);
  assert.equal(f.contexts[1].oscillators.length, 2);
  f.page('focus'); f.page('pageshow'); assert.equal(f.audio.state().ready, true);
  assert.equal(f.contexts[1].oscillators.length, 2); await f.audio.close();
});

test('a missing statechange is detected by the next sound and immediately refreshes controls', async () => {
  const f = fixture(), states = []; f.audio.onStateChange(state => states.push(state));
  await f.audio.unlock(); f.audio.play('win'); const oldSources = [...f.contexts[0].oscillators];
  f.contexts[0].state = 'interrupted'; f.options.resumeFailure = true;
  assert.equal(f.audio.play('chat'), false);
  assert.ok(states.at(-1).needsGesture); assert.equal(states.at(-1).ready, false);
  assert.ok(oldSources.every(source => source.disconnected));
  await Promise.resolve(); await Promise.resolve(); assert.equal(f.audio.state().ready, false);
  await f.audio.close();
});

test('notification recovery coalesces a burst and never queues chat or turn history', async () => {
  const f = fixture(); await f.audio.unlock(); const resumePending = deferred(); f.options.resumePending = resumePending;
  f.contexts[0].transition('suspended'); const calls = f.contexts[0].resumeCalls;
  for (let i = 0; i < 30; ++i) assert.equal(f.audio.play(i % 2 ? 'chat' : 'turn'), false);
  assert.equal(f.contexts[0].resumeCalls, calls + 1); assert.equal(f.timers.size, 1);
  resumePending.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.audio.state().contextState, 'running'); assert.equal(f.audio.state().ready, false);
  assert.equal(f.contexts[0].oscillators.length, 0); assert.equal(f.timers.size, 0);
  await f.audio.unlock(); assert.equal(f.audio.play('placement'), true); await f.audio.close();
});

test('a trusted tap may take over pending notification recovery and retain only its local action', async () => {
  const f = fixture(); await f.audio.unlock(); const resumePending = deferred(); f.options.resumePending = resumePending;
  f.contexts[0].transition('interrupted'); assert.equal(f.audio.play('turn'), false);
  assert.equal(f.audio.play('draw', { gesture: true }), false);
  const pending = f.audio.unlock(); assert.equal(f.audio.play('draw', { gesture: true }), true);
  resumePending.resolve(); assert.equal(await pending, true);
  assert.equal(f.contexts[0].oscillators.length, 2);
  assert.deepEqual(f.contexts[0].oscillators[0].frequency.calls[0], ['set', 380, 42]); await f.audio.close();
});

test('a queued initial suspended event cannot cancel a resume that is still pending', async () => {
  const resumePending = deferred(), f = fixture({ resumePending });
  const pending = f.audio.unlock(); f.audio.play('placement', { gesture: true });
  f.contexts[0].transition('suspended'); assert.equal(f.timers.size, 1);
  resumePending.resolve(); assert.equal(await pending, true); assert.equal(f.contexts[0].oscillators.length, 2);
  await f.audio.close();
});

test('resume completion without actual running state stays locked and discards the local cue', async () => {
  const f = fixture({ resumeStaysSuspended: true });
  const pending = f.audio.unlock(); f.audio.play('draw', { gesture: true });
  assert.equal(await pending, false); assert.equal(f.audio.state().needsGesture, true);
  assert.equal(f.contexts[0].oscillators.length, 0); assert.equal(f.timers.size, 0); await f.audio.close();
});

test('a failed synthesis graph stops other voices, reports locked, and rebuilds on a later tap', async () => {
  const f = fixture(), states = []; f.audio.onStateChange(state => states.push(state)); await f.audio.unlock();
  f.audio.play('win'); f.options.oscillatorFailure = true; assert.equal(f.audio.play('draw'), false);
  assert.equal(states.at(-1).ready, false); assert.equal(states.at(-1).needsGesture, true);
  assert.ok(f.contexts[0].oscillators.every(source => source.disconnected)); assert.equal(f.contexts[0].closeCalls, 1);
  f.options.oscillatorFailure = false; assert.equal(await f.audio.unlock(), true); assert.equal(f.contexts.length, 2);
  assert.equal(f.contexts[1].oscillators.length, 0); assert.equal(f.audio.play('draw'), true); await f.audio.close();
});

test('denied notification recovery is attempted only once until a trusted input restores audio', async () => {
  const f = fixture(); await f.audio.unlock(); f.options.resumeFailure = true;
  f.contexts[0].transition('suspended'); const calls = f.contexts[0].resumeCalls;
  assert.equal(f.audio.play('turn'), false); await Promise.resolve(); await Promise.resolve();
  for (let i = 0; i < 30; ++i) { f.advance(2000); assert.equal(f.audio.play('chat'), false); }
  assert.equal(f.contexts[0].resumeCalls, calls + 1); assert.equal(f.timers.size, 0);
  f.options.resumeFailure = false; await f.audio.unlock(); assert.equal(f.audio.state().ready, true);
  f.contexts[0].transition('interrupted'); assert.equal(f.audio.play('turn'), false);
  assert.equal(f.contexts[0].resumeCalls, calls + 3); await f.audio.close();
});

test('a timed-out notification resume cannot revive audio or replay after the next tap rebuilds it', async () => {
  const f = fixture(); await f.audio.unlock(); const resumePending = deferred(); f.options.resumePending = resumePending;
  f.contexts[0].transition('suspended'); assert.equal(f.audio.play('chat'), false);
  f.tick(1000); assert.equal(f.audio.state().needsGesture, true); assert.equal(f.contexts[0].closeCalls, 1);
  assert.equal(f.audio.play('turn'), false); assert.equal(f.contexts.length, 1);
  f.options.resumePending = null; assert.equal(await f.audio.unlock(), true); assert.equal(f.contexts.length, 2);
  resumePending.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.audio.state().ready, true); assert.ok(f.contexts.every(context => context.oscillators.length === 0));
  assert.equal(f.timers.size, 0); await f.audio.close();
});

const CARD_ACTION_CUES=['card-hook','card-fork','card-bomb','card-rocket','card-pass'];
const ACTION_CUES=['select','sort','undo','restore','split','merge','ready','start','pause','resume','flip','move','collision',...CARD_ACTION_CUES];
const gainPeak=node=>Math.max(0,...node.gain.calls.filter(call=>call[0]==='exponential').map(call=>call[1]));
const masterValue=context=>context.gains[0].gain.calls.filter(call=>['set','target'].includes(call[0])).at(-1)[1];

test('basic action classes sound different, remain short, and increase energy without migrating the saved volume',async()=>{
  const signatures=new Set(),f=fixture();await f.audio.unlock();assert.equal(f.audio.state().volume,.45);
  for(const kind of ACTION_CUES){f.advance(2000);const context=f.contexts[0],before=context.oscillators.length;
    assert.equal(f.audio.play(kind,{gesture:true}),true,kind);
    const sources=context.oscillators.slice(before);assert.ok(sources.length>0 && sources.length<=3);
    assert.ok(sources.every(source=>source.stops[0]-42<.55));
    signatures.add(JSON.stringify(sources.map(source=>[source.type,...source.frequency.calls])));f.finish();
  }
  assert.equal(signatures.size,ACTION_CUES.length);
  f.advance(2000);f.audio.play('placement');const peak=gainPeak(f.contexts[0].gains.at(-2));
  assert.ok(peak>.13*1.4 && peak<=.13*2,'original placement should be stronger, with bounded gain');
  assert.equal(f.audio.state().volume,.45);assert.equal(f.writes.length,0);await f.audio.close();
});

test('fallback mixer bounds simultaneous peak sum at full volume and preserves the finite twelve-source budget',async()=>{
  const f=fixture();await f.audio.unlock();f.audio.setVolume(1);
  for(let i=0;i<6;i++){f.advance(100);assert.equal(f.audio.play('placement'),true);
    const active=f.contexts[0].gains.slice(1).filter(node=>!node.disconnected),sum=active.reduce((n,node)=>n+gainPeak(node),0);
    assert.ok(sum*masterValue(f.contexts[0])<=.5000001,'all scheduled peaks must remain bounded, even without a compressor');
  }
  assert.equal(f.contexts[0].oscillators.filter(node=>!node.disconnected).length,12);
  f.advance(100);assert.equal(f.audio.play('placement'),false);f.finish();
  assert.equal(masterValue(f.contexts[0]),1);f.advance(100);assert.equal(f.audio.play('placement'),true);await f.audio.close();
});

test('turn and result cues preempt crowded action sounds and quieter local clicks cannot mask the new turn',async()=>{
  const f=fixture();await f.audio.unlock();for(let i=0;i<12;i++){f.advance(100);f.audio.play('select');}
  const old=[...f.contexts[0].oscillators];assert.equal(f.audio.play('turn'),true);assert.ok(old.every(source=>source.disconnected));
  f.advance(100);
  assert.equal(f.audio.play('select'),true);const reduced=gainPeak(f.contexts[0].gains.at(-1));assert.ok(reduced<.06);
  assert.equal(f.audio.play('win'),true);assert.ok(f.contexts[0].oscillators.slice(0,-3).every(source=>source.disconnected));
  f.visibility(true);f.visibility(false);await f.audio.unlock();f.advance(100);
  assert.equal(f.audio.play('select'),true);assert.ok(gainPeak(f.contexts.at(-1).gains.at(-1))>.1,'backgrounding clears the old priority envelope');await f.audio.close();
});

test('a public action scheduled in the same event survives the following turn or result cue',async()=>{
  for(const action of ['placement','flip','move','collision',...CARD_ACTION_CUES])for(const priority of ['turn','win','loss','draw-result']){
    const f=fixture();await f.audio.unlock();f.audio.setVolume(1);
    assert.equal(f.audio.play('select'),true);const old=[...f.contexts[0].oscillators];
    assert.equal(f.audio.play(action),true);const actionSources=f.contexts[0].oscillators.slice(old.length);
    assert.equal(f.audio.play(priority),true);
    assert.ok(old.every(source=>source.disconnected),'ordinary local clicks yield immediately');
    assert.ok(actionSources.every(source=>!source.disconnected && source.stops.length===1),action+' must retain its scheduled short sound before '+priority);
    const active=f.contexts[0].gains.slice(1).filter(node=>!node.disconnected);
    assert.ok(active.reduce((n,node)=>n+gainPeak(node),0)*masterValue(f.contexts[0])<=.5000001);
    assert.ok(f.contexts[0].oscillators.filter(source=>!source.disconnected).length<=12);
    f.visibility(true);assert.ok(f.contexts[0].oscillators.every(source=>source.disconnected));
    f.visibility(false);assert.equal(await f.audio.unlock(),true);assert.equal(f.contexts.at(-1).oscillators.length,0,'foregrounding cannot replay public actions');await f.audio.close();
  }
});

test('a full public-action graph evicts only its oldest voices to reserve the immediate priority cue',async()=>{
  const f=fixture();await f.audio.unlock();f.audio.setVolume(1);
  for(let i=0;i<6;i++){f.advance(100);assert.equal(f.audio.play('placement'),true);}
  const old=[...f.contexts[0].oscillators];assert.equal(old.length,12);
  assert.equal(f.audio.play('win'),true);
  assert.ok(old.slice(0,3).every(source=>source.disconnected));
  assert.ok(old.slice(3).every(source=>!source.disconnected && source.stops.length===1),'newest public voices retain their finite schedule');
  assert.equal(f.contexts[0].oscillators.filter(source=>!source.disconnected).length,12);
  const active=f.contexts[0].gains.slice(1).filter(node=>!node.disconnected);
  assert.ok(active.reduce((n,node)=>n+gainPeak(node),0)*masterValue(f.contexts[0])<=.5000001);
  f.audio.setMuted(true);assert.ok(f.contexts[0].oscillators.every(source=>source.disconnected));
  f.audio.setMuted(false);f.finish();assert.equal(f.contexts[0].oscillators.length,15,'no deferred queue may replay an evicted action');await f.audio.close();
});

test('optional hardware compressor is configured and released, while unsupported or failing hardware keeps the bounded fallback',async()=>{
  for(const options of [{compressor:true},{compressorFailure:true},{}]){const f=fixture(options);assert.equal(await f.audio.unlock(),true);
    assert.equal(f.audio.play('collision'),true);const context=f.contexts[0];
    const active=context.gains.slice(1).filter(node=>!node.disconnected);assert.ok(active.reduce((n,node)=>n+gainPeak(node),0)*masterValue(context)<=.5000001);
    if(options.compressor){const node=context.compressors[0];assert.equal(context.gains[0].target,node);assert.equal(node.target,context.destination);
      assert.ok(node.ratio.calls[0][1]>=10);assert.ok(node.attack.calls[0][1]<=.005);await f.audio.close();assert.equal(node.disconnected,true);
    }else{assert.equal(context.gains[0].target,context.destination);await f.audio.close();}
  }
});

test('every new basic cue stays silent before activation, while muted, at zero volume, hidden, and after close',async()=>{
  const f=fixture();for(const kind of ACTION_CUES)assert.equal(f.audio.play(kind,{gesture:true}),false);assert.equal(f.contexts.length,0);
  await f.audio.unlock();f.audio.setMuted(true);for(const kind of ACTION_CUES)assert.equal(f.audio.play(kind,{gesture:true}),false);
  f.audio.setMuted(false);f.audio.setVolume(0);for(const kind of ACTION_CUES)assert.equal(f.audio.play(kind,{gesture:true}),false);
  f.audio.setVolume(.45);f.visibility(true);for(const kind of ACTION_CUES)assert.equal(f.audio.play(kind,{gesture:true}),false);
  f.visibility(false);for(const kind of ACTION_CUES)assert.equal(f.audio.play(kind),false);
  assert.equal(f.contexts.flatMap(context=>context.oscillators).length,0);await f.audio.unlock();assert.equal(f.audio.play('sort'),true);
  await f.audio.close();for(const kind of ACTION_CUES)assert.equal(f.audio.play(kind),false);
});

test('action throttling schedules one selection sound for rapid taps, then allows a later intentional tap',async()=>{
  const f=fixture();await f.audio.unlock();assert.equal(f.audio.play('select'),true);
  for(let i=0;i<40;i++)assert.equal(f.audio.play('select'),false);
  assert.equal(f.contexts[0].oscillators.length,1);f.finish();f.advance(100);assert.equal(f.audio.play('select'),true);await f.audio.close();
});

test('card response cues throttle repeated events independently and permit the next deliberate action', async () => {
  for (const kind of CARD_ACTION_CUES) {
    const f = fixture(); await f.audio.unlock();
    assert.equal(f.audio.play(kind), true, kind);
    const count = f.contexts[0].oscillators.length;
    for (let repeat = 0; repeat < 20; repeat++) assert.equal(f.audio.play(kind), false, kind);
    assert.equal(f.contexts[0].oscillators.length, count);
    f.finish(); f.advance(1000);
    assert.equal(f.audio.play(kind), true, kind);
    await f.audio.close();
  }
});

test('card cue auditions identify all five actions while retaining the common saved volume', async () => {
  const f = fixture({ preference: '{"version":1,"volume":0.3,"muted":false}' });
  const button = new EventTarget(), select = { value: '' }, status = { textContent: '' };
  const unbind = f.audio.bindPreview({ button, select, status });
  for (const [kind, label] of [['card-hook', '勾牌'], ['card-fork', '叉牌'], ['card-bomb', '炸弹'], ['card-rocket', '火箭'], ['card-pass', '不出']]) {
    select.value = kind; button.dispatchEvent(new Event('click'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(status.textContent, `试听：${label} · 30%`);
    f.finish(); f.advance(1000);
  }
  assert.equal(f.writes.length, 0);
  unbind(); await f.audio.close();
});

test('audition uses the current saved level, respects silence, and requires a real fresh browser activation',async()=>{
  const f=fixture({preference:'{"version":1,"volume":0.3,"muted":false}'});
  f.document.defaultView.navigator.userActivation.isActive=false;assert.equal(await f.audio.preview('turn'),false);assert.equal(f.contexts.length,0);
  f.document.defaultView.navigator.userActivation.isActive=true;assert.equal(await f.audio.preview('turn'),true);
  assert.equal(masterValue(f.contexts[0]),.3);f.finish();f.audio.setMuted(true);assert.equal(await f.audio.preview('move'),false);
  f.audio.setMuted(false);f.audio.setVolume(0);assert.equal(await f.audio.preview('move'),false);f.audio.setVolume(.75);f.advance(2000);
  assert.equal(await f.audio.preview('move'),true);assert.equal(masterValue(f.contexts[0]),.75);
  f.visibility(true);assert.equal(await f.audio.preview('win'),false);await f.audio.close();assert.equal(await f.audio.preview('win'),false);
});

test('audition bindings report the chosen event and current percentage, and a removed control cannot play later',async()=>{
  const f=fixture(),button=new EventTarget(),select={value:'collision'},status={textContent:''};
  const unbind=f.audio.bindPreview({button,select,status});button.dispatchEvent(new Event('click'));await new Promise(resolve=>setImmediate(resolve));
  assert.match(status.textContent,/碰撞.*45%/);f.finish();f.audio.setMuted(true);button.dispatchEvent(new Event('click'));await new Promise(resolve=>setImmediate(resolve));assert.match(status.textContent,/音效关/);
  f.audio.setMuted(false);f.audio.setVolume(0);button.dispatchEvent(new Event('click'));await new Promise(resolve=>setImmediate(resolve));assert.match(status.textContent,/音量 0/);
  f.audio.setVolume(.45);const count=f.contexts[0].oscillators.length;unbind();button.dispatchEvent(new Event('click'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.contexts[0].oscillators.length,count);await f.audio.close();
});

test('a pending audition discarded by pagehide cannot play or report successful sound after foregrounding',async()=>{
  const pending=deferred(),f=fixture({resumePending:pending}),button=new EventTarget(),status={textContent:'original'};
  f.audio.bindPreview({button,select:{value:'start'},status});button.dispatchEvent(new Event('click'));f.page('pagehide');pending.resolve();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.contexts[0].oscillators.length,0);assert.doesNotMatch(status.textContent,/试听：/);
  await f.audio.close();
});

test('army action classification separates flips, noncombat moves, and captures without inferring hidden identities',async()=>{
  const f=fixture();assert.equal(f.audio.armyCue({type:'flip'}),'flip');assert.equal(f.audio.armyCue({type:'pickup'}),'move');
  for(const outcome of ['move','flag-pickup'])assert.equal(f.audio.armyCue({type:'move',outcome}),'move');
  for(const outcome of ['capture','attacker-lost','mutual','mine-sacrifice','flag'])assert.equal(f.audio.armyCue({type:'move',outcome}),'collision');
  for(const outcome of ['friendly-reveal','protected-flag','ineligible-flag'])assert.equal(f.audio.armyCue({type:'move',outcome}),'flip');
  assert.equal(f.audio.armyCue({type:'timeout'}),null);assert.equal(f.audio.armyCue(null),null);await f.audio.close();
});

test('phase cues sound only new authoritative start, pause and resume transitions, never recovery or metadata',async()=>{
  const f=fixture(),waiting={roomId:'r',matchId:null,selfId:'p',revision:1,phase:'waiting'},playing={...waiting,matchId:'m',revision:2,phase:'playing'},paused={...playing,revision:3,phase:'paused'},resumed={...playing,revision:4};
  assert.equal(f.audio.phaseCue(waiting,playing),'start');assert.equal(f.audio.phaseCue(playing,paused),'pause');assert.equal(f.audio.phaseCue(paused,resumed),'resume');
  for(const [previous,current,opts] of [[null,playing],[playing,paused,{baseline:true}],[playing,{...paused,roomId:'other'}],[playing,{...paused,selfId:'other'}],[playing,{...paused,matchId:'other'}],[paused,paused],[playing,{...playing,revision:3}],[paused,{...resumed,revision:undefined}]])assert.equal(f.audio.phaseCue(previous,current,opts),null);
  await f.audio.close();
});

test('unsupported devices report an honest audition status rather than suggesting the disabled enable switch',async()=>{
  const f=fixture({AudioContext:null}),button=new EventTarget(),status={textContent:''};
  // null deliberately asks for the fixture default; a non-function disables it.
  await f.audio.close();const unsupported=createGameAudio({AudioContext:{},document:f.document});
  unsupported.bindPreview({button,select:{value:'turn'},status});assert.match(status.textContent,/设备不支持/);
  button.dispatchEvent(new Event('click'));await new Promise(resolve=>setImmediate(resolve));assert.match(status.textContent,/设备不支持/);await unsupported.close();
});
