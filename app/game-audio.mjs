const PREFERENCE_KEY = 'game-room:audio:v1';
const DEFAULT_VOLUME = 0.45;
const MAX_VOICES = 12;
const CUE_BOOST = 1.75;
const MAX_MIX_PEAK = 0.5;
const PRIORITY_CUES = new Set(['turn','win','loss','draw-result']);
const PUBLIC_ACTION_CUES = new Set(['placement','flip','move','collision','roll','launch','flight','plane-finish']);
const LIMITS = { select: 90, sort: 250, undo: 180, restore: 250, split: 200, merge: 200, ready: 250, start: 700, pause: 400, resume: 400, flip: 100, move: 90, collision: 160, placement: 90, draw: 160, roll: 160, launch: 180, flight: 180, 'plane-finish': 350, turn: 1000, commit: 240, invalid: 500, chat: 850, win: 1500, loss: 1500, 'draw-result': 1500 };

// Original, short synthesized cues. No recordings, music, downloads or account data.
// [start offset, duration, pitch, end pitch, peak gain, oscillator shape]
const CUES = {
  select: [[0, 0.045, 950, 1220, 0.10, 'sine']],
  sort: [[0, 0.055, 430, 430, 0.10, 'triangle'], [0.065, 0.055, 570, 570, 0.10, 'triangle'], [0.13, 0.065, 720, 720, 0.10, 'triangle']],
  undo: [[0, 0.075, 700, 500, 0.10, 'sine'], [0.085, 0.075, 500, 390, 0.09, 'sine']],
  restore: [[0, 0.065, 510, 510, 0.10, 'triangle'], [0.075, 0.11, 350, 510, 0.10, 'sine']],
  split: [[0, 0.06, 900, 680, 0.10, 'triangle'], [0.075, 0.06, 500, 360, 0.10, 'triangle']],
  merge: [[0, 0.07, 400, 580, 0.10, 'triangle'], [0.075, 0.075, 680, 900, 0.10, 'triangle']],
  ready: [[0, 0.075, 620, 620, 0.10, 'sine'], [0.085, 0.10, 820, 820, 0.10, 'sine']],
  start: [[0, 0.10, 440, 440, 0.11, 'triangle'], [0.11, 0.10, 659, 659, 0.11, 'triangle'], [0.22, 0.15, 880, 880, 0.11, 'triangle']],
  pause: [[0, 0.08, 640, 640, 0.10, 'sine'], [0.095, 0.12, 480, 480, 0.10, 'sine']],
  resume: [[0, 0.08, 480, 480, 0.10, 'sine'], [0.095, 0.12, 640, 640, 0.10, 'sine']],
  flip: [[0, 0.055, 280, 650, 0.14, 'triangle'], [0.06, 0.045, 1050, 800, 0.07, 'sine']],
  move: [[0, 0.09, 480, 290, 0.13, 'triangle']],
  roll: [[0, 0.035, 350, 290, 0.10, 'triangle'], [0.06, 0.035, 470, 330, 0.10, 'triangle'], [0.12, 0.08, 600, 440, 0.12, 'triangle']],
  launch: [[0, 0.18, 300, 850, 0.12, 'sine']],
  flight: [[0, 0.16, 560, 1150, 0.10, 'sine'], [0.17, 0.09, 900, 650, 0.08, 'triangle']],
  'plane-finish': [[0, 0.10, 659, 659, 0.09, 'triangle'], [0.12, 0.17, 988, 988, 0.10, 'sine']],
  collision: [[0, 0.09, 170, 100, 0.14, 'triangle'], [0.006, 0.075, 930, 350, 0.08, 'triangle'], [0.11, 0.10, 260, 170, 0.10, 'triangle']],
  placement: [[0, 0.055, 670, 330, 0.13, 'triangle'], [0.006, 0.045, 1100, 780, 0.035, 'sine']],
  draw: [[0, 0.055, 380, 510, 0.10, 'triangle'], [0.065, 0.05, 510, 640, 0.075, 'triangle']],
  turn: [[0, 0.14, 523.25, 523.25, 0.10, 'sine'], [0.16, 0.18, 783.99, 783.99, 0.10, 'sine']],
  commit: [[0, 0.12, 659.25, 659.25, 0.085, 'sine'], [0.09, 0.14, 783.99, 783.99, 0.075, 'sine']],
  invalid: [[0, 0.12, 220, 185, 0.10, 'triangle']],
  chat: [[0, 0.085, 880, 1046.5, 0.055, 'sine'], [0.105, 0.11, 1174.66, 1174.66, 0.045, 'sine']],
  loss: [[0, 0.14, 392, 392, 0.07, 'sine'], [0.15, 0.20, 293.66, 261.63, 0.06, 'sine']],
  'draw-result': [[0, 0.13, 440, 440, 0.065, 'triangle'], [0.16, 0.13, 440, 440, 0.05, 'triangle']],
  win: [[0, 0.16, 523.25, 523.25, 0.10, 'sine'], [0.14, 0.16, 659.25, 659.25, 0.09, 'sine'],
    [0.28, 0.24, 783.99, 783.99, 0.10, 'sine']],
};

function defaultStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}
function defaultAudioContext() {
  try { return globalThis.AudioContext || globalThis.webkitAudioContext; } catch { return null; }
}
function clampVolume(value, fallback = DEFAULT_VOLUME) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}
function preference(storage) {
  try {
    const value = JSON.parse(storage?.getItem(PREFERENCE_KEY) || 'null');
    if (value?.version === 1) return { muted: value.muted === true, volume: clampVolume(value.volume) };
  } catch { /* Restricted or damaged storage must not prevent playing the game. */ }
  return { muted: false, volume: DEFAULT_VOLUME };
}

/**
 * Device-only audio. unlock() must run inside a trusted pointer/key handler.
 * Notifications can make one bounded resume attempt on an existing graph, but
 * cannot authorize audio or retain missed sounds. A local action can explicitly
 * pass { gesture: true } to retain one cue while its trusted resume is pending.
 */
export function createGameAudio({ storage = defaultStorage(), AudioContext = defaultAudioContext(),
  document = globalThis.document, window = globalThis.window ?? document?.defaultView,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
  resumeTimeoutMs = 1000 } = {}) {
  let { muted, volume } = preference(storage);
  let context = null, master = null, limiter = null, mixScale = 1, priorityUntil = 0, connected = false, unlocked = false, closed = false, attempt = null, rebuildOnGesture = false;
  let notificationRecoveryTried = false;
  const voices = new Set(), lastPlayed = new Map(), subscribers = new Set(), previewBindings = new Set();
  const hidden = () => document?.hidden === true || document?.visibilityState === 'hidden';
  const state = () => {
    const supported = typeof AudioContext === 'function';
    const contextState = closed ? 'closed' : context?.state ?? 'uninitialized';
    const audioReady = !closed && unlocked && !hidden() && contextState === 'running';
    return { supported, muted, volume, closed, contextState,
      unlocked: !closed && unlocked && contextState === 'running', ready: audioReady,
      suspended: !closed && Boolean(context) && contextState !== 'running',
      needsGesture: supported && !closed && !muted && volume > 0 && !audioReady };
  };
  function notify() {
    const value = state();
    for (const callback of subscribers) { try { callback(value); } catch { /* Audio controls cannot stop a game action. */ } }
  }
  function onStateChange(callback) {
    if (typeof callback !== 'function') return () => {};
    subscribers.add(callback); return () => subscribers.delete(callback);
  }
  function save() {
    try { storage?.setItem(PREFERENCE_KEY, JSON.stringify({ version: 1, muted, volume })); } catch { /* Optional preference. */ }
  }
  function disconnect(node) { try { node?.disconnect(); } catch { /* Already released. */ } }
  function release(voice) {
    if (!voices.delete(voice)) return;
    voice.oscillator.onended = null;
    disconnect(voice.oscillator); disconnect(voice.gain); updateMix();
  }
  function stopVoices({ preservePublicActions = false, reserve = 0 } = {}) {
    for (const voice of [...voices]) {
      if (preservePublicActions && PUBLIC_ACTION_CUES.has(voice.kind)) continue;
      try { voice.oscillator.stop(); } catch { /* An ended source cannot be stopped twice. */ }
      release(voice);
    }
    // Keep the newest finite public actions audible, reserving the same bounded
    // graph for the immediate turn/result. Never delay or queue a notification.
    if (preservePublicActions) while (voices.size + reserve > MAX_VOICES) {
      const oldest = voices.values().next().value;
      try { oldest.oscillator.stop(); } catch { /* Already ended. */ }
      release(oldest);
    }
  }
  function updateMix() {
    const next = Math.min(1, MAX_MIX_PEAK / Math.max(MAX_MIX_PEAK, [...voices].reduce((sum, voice) => sum + (voice.peak || 0), 0)));
    if (next === mixScale) return;
    mixScale = next; updateGain(true);
  }
  function updateGain(immediate = false) {
    if (!master || !context) return;
    try {
      master.gain.cancelScheduledValues(context.currentTime);
      const gain = muted ? 0 : volume * mixScale;
      if (immediate) master.gain.setValueAtTime(gain, context.currentTime);
      master.gain.setTargetAtTime(gain, context.currentTime, 0.01);
    } catch { /* A browser may have interrupted or closed the audio context. */ }
  }
  function discardContext() {
    const old = context;
    if (old) old.onstatechange = null;
    disconnect(master); disconnect(limiter); context = null; master = null; limiter = null; mixScale = 1; priorityUntil = 0; connected = false; unlocked = false; rebuildOnGesture = false;
    try { const closing = old?.close(); closing?.catch?.(() => {}); return closing; } catch { return undefined; }
  }
  function complete(record, ok, discard = false) {
    if (attempt !== record || record.done) return;
    record.done = true; attempt = null;
    try { clearTimeout?.(record.timer); } catch { /* Optional timer environment. */ }
    unlocked = Boolean(ok && record.trusted && !closed && !hidden() && context === record.context && context?.state === 'running');
    if (unlocked) notificationRecoveryTried = false;
    const cue = unlocked ? record.cue : null; record.cue = null;
    if (discard) discardContext();
    notify(); record.resolve(unlocked);
    if (cue) play(cue);
  }
  function revokeGesture({ suspend = false } = {}) {
    unlocked = false; notificationRecoveryTried = false; priorityUntil = 0; stopVoices();
    // A pending WebKit resume can resolve after focus returns. Do not let it
    // authorize playback or resurrect the discarded action cue.
    if (attempt) complete(attempt, false, true);
    rebuildOnGesture = Boolean(context);
    if (suspend && context?.state === 'running') {
      try { context.suspend?.()?.catch?.(() => {}); } catch { /* OS suspension is best effort. */ }
    }
    notify();
  }
  function visibilityChanged() { if (hidden()) revokeGesture({ suspend: true }); else notify(); }
  function pageHidden() { revokeGesture({ suspend: true }); }
  function windowBlurred() {
    // A visible window losing keyboard focus does not suspend an already
    // authorized running graph. Hidden pages and unfinished first activation
    // still revoke their grant; focus alone must never authorize late sounds.
    if (!hidden() && unlocked && !attempt && context?.state === 'running') notify();
    else pageHidden();
  }
  function pageReturned() {
    if (closed) return;
    // iOS can dispatch pageshow/focus after the first restoring tap. The earlier
    // suspension already revoked its old grant; do not cancel this new tap.
    if (hidden()) revokeGesture({ suspend: true });
    else { if (context?.state !== 'running') { unlocked = false; stopVoices(); } notify(); }
  }
  try { document?.addEventListener?.('visibilitychange', visibilityChanged); } catch { /* Non-browser environment. */ }
  try {
    window?.addEventListener?.('pagehide', pageHidden);
    window?.addEventListener?.('blur', windowBlurred);
    window?.addEventListener?.('pageshow', pageReturned);
    window?.addEventListener?.('focus', pageReturned);
  } catch { /* Non-browser environment. */ }

  function unlock() {
    if (closed || hidden() || typeof AudioContext !== 'function') return Promise.resolve(false);
    let activation;
    try { activation = document?.defaultView?.navigator?.userActivation ?? globalThis.navigator?.userActivation; } catch { /* Browser restriction. */ }
    if (activation?.isActive === false) return Promise.resolve(false);
    return beginAttempt(true);
  }
  function beginAttempt(trusted) {
    if (attempt) { if (trusted) attempt.trusted = true; return attempt.promise; }
    if (!trusted && (!context || context.state === 'closed' || rebuildOnGesture)) return Promise.resolve(false);
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    const record = { promise, resolve, context: null, timer: null, cue: null, done: false, trusted }; attempt = record;
    try {
      // A WebKit context can report running after foregrounding while its audio
      // clock has stopped. Rebuild only on a fresh trusted tap, never on a timer.
      if (context?.state === 'closed' || (trusted && rebuildOnGesture)) discardContext();
      if (!context) {
        context = new AudioContext({ latencyHint: 'interactive' });
        master = context.createGain(); master.gain.setValueAtTime(muted ? 0 : volume, context.currentTime);
        // The finite peak-sum mixer is the fallback; a compressor is an extra
        // hardware-supported guard, not a condition for hearing game actions.
        try {
          limiter = context.createDynamicsCompressor?.();
          if (limiter) {
            for (const [name, value] of Object.entries({threshold:-6,knee:0,ratio:12,attack:0.003,release:0.08})) limiter[name]?.setValueAtTime(value,context.currentTime);
            limiter.connect(context.destination);master.connect(limiter);
          } else master.connect(context.destination);
        } catch { disconnect(limiter);limiter=null;master.connect(context.destination); }
        connected = true;
      }
      record.context = context;
      const current = context;
      current.onstatechange = () => {
        if (closed || context !== current) return;
        if (current.state === 'running') {
          if (attempt?.context === current) complete(attempt, true);
          else notify(); // The OS alone cannot grant a new trusted gesture.
        } else {
          unlocked = false; stopVoices(); notify();
          if (attempt?.context === current && current.state !== 'suspended') complete(attempt, false);
        }
      };
      if (current.state === 'running') complete(record, true);
      else {
        // iOS can leave resume() pending forever after restoring a Home Screen
        // app. A finite attempt lets the next real tap create a healthy graph.
        const timeout = Number.isFinite(resumeTimeoutMs) ? Math.max(100, Math.min(3000, resumeTimeoutMs)) : 1000;
        record.timer = setTimeout?.(() => complete(record, false, true), timeout);
        Promise.resolve(current.resume()).then(() => complete(record, current.state === 'running'),
          () => complete(record, false));
      }
    } catch { complete(record, false, !connected); }
    return promise;
  }

  function play(kind, { gesture = false } = {}) {
    const cue = typeof kind === 'string' && Object.hasOwn(CUES, kind) ? CUES[kind] : null;
    if (!cue || closed || hidden() || muted || volume === 0) return false;
    if (!state().ready) {
      if (context?.state !== 'running') { unlocked = false; stopVoices(); }
      notify(); // A browser may omit statechange during an OS interruption.
      if (gesture && attempt?.trusted && !attempt.done && !['turn','chat'].includes(kind)) {
        attempt.cue = kind; return true;
      }
      if (context && context.state !== 'running' && !notificationRecoveryTried) {
        notificationRecoveryTried = true; void beginAttempt(false);
      }
      return false;
    }
    let clock;
    try { clock = now(); } catch { return false; }
    if (!Number.isFinite(clock)) return false;
    const previous = lastPlayed.get(kind);
    if (previous !== undefined && clock >= previous && clock - previous < LIMITS[kind]) return false;
    if (PRIORITY_CUES.has(kind)) { stopVoices({ preservePublicActions: true, reserve: cue.length }); priorityUntil = clock + Math.max(...cue.map(([offset,duration])=>offset+duration))*1000; }
    if (voices.size + cue.length > MAX_VOICES) return false;
    const duck = !PRIORITY_CUES.has(kind) && clock < priorityUntil ? 0.25 : 1;
    const created = [];
    try {
      const time = context.currentTime;
      for (const [offset, duration, pitch, endPitch, peak, shape] of cue) {
        const oscillator = context.createOscillator();
        const voice = { kind, oscillator, gain: null, peak: peak * CUE_BOOST * duck }; created.push(voice); voices.add(voice);
        const gain = context.createGain(); voice.gain = gain;
        const start = time + offset, end = start + duration;
        oscillator.type = shape;
        oscillator.frequency.setValueAtTime(pitch, start);
        oscillator.frequency.linearRampToValueAtTime(endPitch, end);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(voice.peak, start + Math.min(0.012, duration / 3));
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        oscillator.connect(gain); gain.connect(master);
        oscillator.onended = () => release(voice);
        voice.start = start; voice.end = end + 0.008;
      }
      updateMix();
      for (const voice of created) { voice.oscillator.start(voice.start); voice.oscillator.stop(voice.end); }
      lastPlayed.set(kind, clock);
      return true;
    } catch {
      for (const voice of created) {
        try { voice.oscillator.stop(); } catch { /* Failed source creation. */ }
        release(voice);
      }
      stopVoices(); discardContext(); notify();
      return false;
    }
  }

  function setMuted(value) {
    muted = Boolean(value); if (muted) { priorityUntil = 0; stopVoices(); if (attempt) attempt.cue = null; } updateGain(); save(); notify(); return state();
  }
  function setVolume(value) {
    volume = clampVolume(value, volume); if (volume === 0) { priorityUntil = 0; stopVoices(); if (attempt) attempt.cue = null; } updateGain(); save(); notify(); return state();
  }
  async function close() {
    if (closed) return;
    closed = true; unlocked = false; stopVoices(); lastPlayed.clear();
    if (attempt) complete(attempt, false);
    try { document?.removeEventListener?.('visibilitychange', visibilityChanged); } catch { /* Non-browser environment. */ }
    try {
      window?.removeEventListener?.('pagehide', pageHidden);
      window?.removeEventListener?.('blur', windowBlurred);
      window?.removeEventListener?.('pageshow', pageReturned);
      window?.removeEventListener?.('focus', pageReturned);
    } catch { /* Non-browser environment. */ }
    for (const cleanup of [...previewBindings]) cleanup();
    notify(); subscribers.clear();
    try { await discardContext(); } catch { /* Closing is best effort; gameplay must stay available. */ }
  }

  function armyCue(action) {
    if (action?.type === 'flip') return 'flip';
    if (action?.type === 'pickup') return 'move';
    if (action?.type !== 'move') return null;
    if (['capture','attacker-lost','mutual','mine-sacrifice','flag'].includes(action.outcome)) return 'collision';
    if (['friendly-reveal','protected-flag','ineligible-flag'].includes(action.outcome)) return 'flip';
    return 'move';
  }
  function phaseCue(previous,current,{baseline=false}={}) {
    if (baseline || !previous || !current || previous.roomId!==current.roomId || previous.selfId!==current.selfId
        || !Number.isSafeInteger(previous.revision) || !Number.isSafeInteger(current.revision) || current.revision<=previous.revision) return null;
    if (previous.phase==='waiting' && current.phase==='playing') return 'start';
    if (previous.matchId!==current.matchId) return null;
    if (previous.phase==='playing' && current.phase==='paused') return 'pause';
    if (previous.phase==='paused' && current.phase==='playing') return 'resume';
    return null;
  }
  async function preview(kind) {
    if (!Object.hasOwn(CUES,kind) || closed || hidden() || muted || volume === 0) return false;
    if (!await unlock()) return false;
    return play(kind,{gesture:true});
  }
  function bindPreview({select,button,status} = {}) {
    if (!select || !button || !status) return () => {};
    const names={select:'选牌',sort:'整理',undo:'撤销',restore:'还原',split:'拆组',merge:'拼组',ready:'准备',start:'开局',pause:'暂停',resume:'继续',placement:'落牌',draw:'摸牌',turn:'轮到你',commit:'确认出牌',invalid:'操作失败',chat:'发言',win:'获胜',loss:'落败','draw-result':'和局',flip:'翻棋',move:'走棋',collision:'碰撞'};
    let active=true;
    const updateStatus=value=>{if(active)status.textContent=!value.supported?'设备不支持音效':value.muted?'音效关':value.volume===0?'音量 0':`${Math.round(value.volume*100)}%`;};
    const unsubscribe=onStateChange(updateStatus);updateStatus(state());
    const click=async()=>{
      const kind=select.value, ok=await preview(kind);if(!active || closed || hidden())return;
      status.textContent=ok?`试听：${names[kind] || '音效'} · ${Math.round(volume*100)}%`
        :!state().supported?'设备不支持音效':muted?'音效关':volume===0?'音量 0':'点按启声';
    };
    button.addEventListener('click',click);
    const cleanup=()=>{active=false;unsubscribe();button.removeEventListener('click',click);previewBindings.delete(cleanup);};
    previewBindings.add(cleanup);return cleanup;
  }
  return { unlock, play, setMuted, setVolume, state, onStateChange, armyCue, phaseCue, preview, bindPreview, close };
}
