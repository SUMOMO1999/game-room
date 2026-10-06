import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomClock } from './platform/room-clock.mjs';
import { createRoomSession, createRoomExit } from './platform/room-session.mjs';
import { mountRoomAudioControls } from './platform/room-audio-controls.mjs';
import { mountGameViewport } from './platform/room-viewport.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}
function timers() {
  let now = 0, serial = 0;
  const pending = new Map(), retired = new Map();
  return { pending, now: () => now, advance: ms => { now += ms; },
    set(callback, delay) { const id = ++serial; pending.set(id, {callback,delay}); return id; },
    clear(id) { if (pending.has(id)) retired.set(id, pending.get(id)); pending.delete(id); },
    tick() { for (const timer of [...pending.values()]) timer.callback(); },
    tickRetired() { for (const timer of [...retired.values()]) timer.callback(); },
  };
}
function clockView(overrides = {}) {
  return { roomId:'room', matchId:'match', phase:'playing', gameType:'army-flip', serverTime:1000,
    turnClock:{deadlineAt:3000,remainingMs:2000}, ...overrides };
}
test('room clock follows server snapshots, emits one expiry, freezes pause, and retires its timer', () => {
  const time = timers(), rendered = [];
  let expiries = 0;
  const clock = createRoomClock({now:time.now,setInterval:time.set,clearInterval:time.clear,
    onRender:state => rendered.push(state),onExpire:() => { expiries++; }});
  clock.receive(clockView());
  assert.equal(time.pending.size,1); assert.equal(clock.display().time,'00:02');
  time.advance(1500); time.tick(); assert.equal(clock.display().time,'00:01');
  clock.receive(clockView({serverTime:2500}));
  assert.equal(time.pending.size,1,'new snapshots keep one timer and rebase elapsed time');
  time.advance(500); time.tick(); time.tick(); assert.equal(expiries,1);
  clock.receive(clockView({phase:'paused',turnClock:{deadlineAt:null,remainingMs:9000}}));
  assert.equal(time.pending.size,0); assert.equal(clock.display().time,'00:09');
  const pausedRenders = rendered.length;
  time.advance(50000); time.tickRetired(); assert.equal(rendered.length,pausedRenders);
  assert.equal(clock.display().time,'00:09');
  clock.receive(clockView({serverTime:1000,turnClock:{deadlineAt:2000,remainingMs:1000}}));
  assert.equal(time.pending.size,1); time.advance(1000); time.tick(); assert.equal(expiries,2);
  clock.reset(); assert.equal(time.pending.size,0); assert.equal(clock.display().visible,false);
  const afterReset = rendered.length; time.tickRetired(); assert.equal(rendered.length,afterReset);
  clock.receive(clockView()); clock.destroy();
  const afterDestroy = rendered.length;
  clock.receive(clockView()); time.tickRetired(); assert.equal(time.pending.size,0);
  assert.equal(rendered.length,afterDestroy);
});
test('legacy, finished and invalid clock snapshots never create a ticking deadline', () => {
  const time = timers();
  const clock = createRoomClock({now:time.now,setInterval:time.set,clearInterval:time.clear});
  for (const view of [null,{phase:'playing'},clockView({phase:'finished'}),clockView({serverTime:null})]) {
    clock.receive(view); assert.equal(clock.display().visible,false); assert.equal(time.pending.size,0);
  }
});
test('clock disposal from an expiry callback cannot schedule a new timer or repeat the callback', () => {
  const time = timers(); let expiries = 0;
  const clock = createRoomClock({now:time.now,setInterval:time.set,clearInterval:time.clear,
    onExpire:() => { expiries++; clock.render(); clock.destroy(); }});
  clock.receive(clockView({serverTime:3000}));
  assert.equal(expiries,1); assert.equal(time.pending.size,0); assert.equal(clock.display().visible,false);
});
function sessionFixture() {
  let epoch = 1, state = {verification:'verified'}, client = {};
  const document = {hidden:false};
  const session = createRoomSession({document,accountGeneration:() => epoch,accountState:() => state,getClient:() => client});
  return {session,document,client:() => client,setClient:value => { client=value; },
    setEpoch:value => { epoch=value; },setState:value => { state=value; }};
}
test('page fences reject stale account, client, hidden page and failed verification independently', () => {
  const f = sessionFixture(), first = f.client(), fence = f.session.capture(first);
  assert.equal(f.session.current(fence),true);
  f.setEpoch(2); assert.equal(f.session.current(fence),false); f.setEpoch(1);
  f.setClient({}); assert.equal(f.session.current(fence),false); f.setClient(first);
  f.document.hidden=true; assert.equal(f.session.current(fence),false); f.document.hidden=false;
  f.setState({verification:'unavailable'}); assert.equal(f.session.current(fence),false);
  assert.equal(f.session.current(fence,{verified:false}),true);
  f.session.invalidate(); assert.equal(f.session.current(fence,{verified:false}),false);
});
test('bootstrap deduplicates work and an old completion cannot retire its pending successor', async () => {
  const f = sessionFixture(), old = deferred(), next = deferred();
  let prepared = 0, started = 0, oldTask, nextTask;
  const prepare = () => { prepared++; };
  const first = f.session.bootstrap(prepare,task => { oldTask=task; started++; return old.promise; });
  assert.equal(f.session.bootstrap(prepare,() => { throw new Error('duplicate bootstrap'); }),first);
  await Promise.resolve(); assert.equal(started,1); assert.equal(prepared,1);
  f.session.invalidate(); assert.equal(oldTask.controller.signal.aborted,true);
  const second = f.session.bootstrap(prepare,task => { nextTask=task; started++; return next.promise; });
  await Promise.resolve(); assert.equal(started,2);
  old.resolve(); await first;
  assert.equal(f.session.bootstrap(prepare,() => { throw new Error('old finally unlocked successor'); }),second);
  assert.equal(f.session.current(oldTask),false); assert.equal(f.session.current(nextTask),true);
  next.resolve(); await second;
  assert.equal(prepared,2);
});
test('identity drift before queued bootstrap and destruction never start private work', async () => {
  const f = sessionFixture(); let started = 0;
  const first = f.session.bootstrap(() => {},() => { started++; });
  f.setEpoch(2); await first; assert.equal(started,0);
  const next = f.session.bootstrap(() => {},() => { started++; });
  f.session.destroy(); await next;
  await f.session.bootstrap(() => { throw new Error('disposed prepare'); },() => { started++; });
  assert.equal(started,0); assert.equal(f.session.current(f.session.capture()),false);
});
test('unknown explicit leave retains one request body, deduplicates clicks and waits for confirmation to retry', async () => {
  const f = sessionFixture(), pending = deferred(), bodies = [], failures = [], forgotten = [];
  let revision = 5, nextId = 0, reconnects = 0, stopped = 0, left = 0, first = true;
  const client = {membership:{token:'test-token'},epoch:() => ({generation:1}),
    request:async (path,options) => { bodies.push(options.body); if (first) { first=false; return pending.promise; } return {left:true}; },
    stop:() => { stopped++; },connect:() => { reconnects++; }};
  f.setClient(client);
  const exit = createRoomExit({session:f.session,roomCode:'123456',getClient:f.client,
    getView:() => ({revision,selfId:'self'}),requestId:() => `leave-${++nextId}`,
    requireAcknowledgement:true,forgetMembership:(...fields) => forgotten.push(fields),
    onFailure:error => failures.push(error),onLeft:() => { left++; }});
  const firstAttempt = exit.run(); assert.equal(exit.run(),firstAttempt); assert.equal(bodies.length,1);
  pending.resolve({left:false}); assert.equal(await firstAttempt,false);
  assert.equal(failures.length,1); assert.equal(reconnects,1); assert.equal(bodies.length,1);
  revision=6;
  assert.equal(await exit.run(),true);
  assert.equal(bodies[0],bodies[1]); assert.equal(bodies[1].expectedRevision,5); assert.equal(nextId,1);
  assert.equal(left,1); assert.equal(stopped,1); assert.deepEqual(forgotten,[['123456','self']]);
});
test('retired leave acknowledgement cannot forget membership, navigate or unlock a new attempt', async () => {
  const f = sessionFixture(), old = deferred(), next = deferred();
  let forgotten = 0, pendingCalls = 0, left = 0, stopped = 0;
  const makeClient = promise => ({membership:{},epoch:() => ({}),request:() => promise,
    stop:() => { stopped++; },connect:() => { throw new Error('retired leave reconnected'); }});
  f.setClient(makeClient(old.promise));
  const exit = createRoomExit({session:f.session,roomCode:'123456',getClient:f.client,
    getView:() => ({revision:1,selfId:'self'}),requestId:() => 'test-leave',
    forgetMembership:() => { forgotten++; },onPending:() => { pendingCalls++; },onLeft:() => { left++; }});
  const first = exit.run();
  f.session.invalidate(); exit.reset(); f.setClient(makeClient(next.promise));
  const second = exit.run(); old.resolve({left:true}); assert.equal(await first,false);
  assert.equal(forgotten,0); assert.equal(stopped,0); assert.equal(left,0);
  assert.equal(exit.run(),second,'old finally must keep the new attempt locked'); assert.equal(pendingCalls,2);
  next.resolve({left:true}); assert.equal(await second,true); assert.equal(forgotten,1); assert.equal(left,1);
});
class Surface {
  handlers = new Map();
  addEventListener(type, handler) { const entries=this.handlers.get(type)||new Set(); entries.add(handler); this.handlers.set(type,entries); }
  removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
  emit(type, event = {}) { for (const handler of [...this.handlers.get(type)||[]]) handler(event); }
}
test('viewport recovery cancels its old timers, preserves button focus, and fully disposes listeners', () => {
  const window = new Surface(), document = new Surface(), time = timers();
  window.visualViewport = new Surface(); window.screen = {orientation:new Surface()};
  let synced = 0, recovered = 0;
  const viewport = mountGameViewport({window,document,sync:() => { synced++; },onRecover:() => { recovered++; },
    recoveryDelays:[120,350,750],setTimeout:time.set,clearTimeout:time.clear});
  assert.equal(synced,1);
  document.emit('focusout',{target:{matches:() => false}}); assert.equal(recovered,0);
  window.emit('orientationchange'); assert.equal(time.pending.size,3);
  document.emit('focusout',{target:{matches:() => true}}); assert.equal(recovered,2); assert.equal(time.pending.size,3);
  const latest = synced; time.tickRetired(); assert.equal(synced,latest);
  document.hidden=true; document.emit('visibilitychange'); assert.equal(recovered,2);
  document.hidden=false; document.emit('visibilitychange'); assert.equal(recovered,3);
  viewport.destroy(); const disposed = synced;
  time.tickRetired(); window.emit('resize'); window.visualViewport.emit('scroll'); window.screen.orientation.emit('change');
  viewport.recover(); assert.equal(time.pending.size,0); assert.equal(synced,disposed);
});
function audioFixture() {
  const document = new Surface(), toggle = new Surface(), volume = new Surface();
  const nodes = new Map([['sound-toggle',toggle],['sound-volume',volume]]);
  document.getElementById = id => nodes.get(id) || null;
  toggle.attributes = {}; toggle.setAttribute = (name,value) => { toggle.attributes[name]=value; };
  let state = {supported:true,muted:false,ready:false,needsGesture:true,volume:.45}, listener;
  const pending = deferred(), calls = [];
  const audio = {state:() => state,onStateChange:callback => { listener=callback; return () => { listener=null; }; },
    unlock:() => { calls.push('unlock'); return pending.promise; },play:kind => calls.push(kind),
    setMuted:muted => { state={...state,muted}; },setVolume:volume => { state={...state,volume}; },
    bindPreview:() => () => { calls.push('unbind-preview'); }};
  return {document,toggle,volume,pending,audio,calls,change:next => { state={...state,...next}; listener?.(state); }};
}
test('audio activation keeps a restoring tap audible and disposed controls ignore delayed unlock', async () => {
  const f = audioFixture(), controls = mountRoomAudioControls({audio:f.audio,document:f.document});
  assert.equal(f.toggle.textContent,'点按启声'); assert.equal(f.volume.value,'45');
  f.document.emit('pointerup',{isTrusted:false}); assert.deepEqual(f.calls,[]);
  f.document.emit('pointerup',{isTrusted:true,target:{closest:() => f.toggle}});
  f.change({ready:true,needsGesture:false}); f.toggle.emit('click');
  assert.equal(f.audio.state().muted,false,'the restoring release must not mute newly unlocked audio');
  controls.destroy(); f.pending.resolve(); await Promise.resolve();
  assert.equal(f.calls.includes('placement'),false,'a delayed unlock cannot play after disposal');
  const calls = f.calls.length; f.document.emit('keydown',{isTrusted:true}); f.toggle.emit('click');
  assert.equal(f.calls.length,calls);
  assert.equal(f.calls.filter(call => call==='unbind-preview').length,1);
});
