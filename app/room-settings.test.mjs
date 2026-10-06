import test from 'node:test';
import assert from 'node:assert/strict';
import { mountRoomSettings } from './platform/room-settings.mjs';
import { mountRoomAudioControls } from './platform/room-audio-controls.mjs';

// Only DOM movement and event order are modeled. This does not substitute for
// the browser's geometry, native focus behavior or a real phone's audio gate.
class Surface {
  listeners = new Map();
  addEventListener(type, handler, options = {}) {
    const entries = this.listeners.get(type) || [];
    entries.push({ handler, capture: options === true || Boolean(options.capture) });
    this.listeners.set(type, entries);
  }
  removeEventListener(type, handler, options = {}) {
    const capture = options === true || Boolean(options.capture);
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.handler !== handler || entry.capture !== capture));
  }
  emit(type, detail = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...detail };
    const path = []; for (let node = this; node; node = node.parentElement) path.push(node);
    for (const capture of [true, false]) {
      for (const node of capture ? [...path].reverse() : path) {
        for (const entry of [...node.listeners.get(type) || []]) if (entry.capture === capture) entry.handler(event);
        if (event.stopped) break;
      }
      if (event.stopped) break;
    }
    return event;
  }
}
function fixture() {
  const document = new Surface(), nodes = new Map();
  document.hidden = false; document.defaultView = new Surface(); document.activeElement = null;
  document.getElementById = id => nodes.get(id) || null;
  document.querySelector = selector => selector === 'dialog[open]' ? [...nodes.values()].find(node => node.tag === 'dialog' && node.open) || null : null;
  function node(id, parent = null, tag = 'button') {
    const result = new Surface(); Object.assign(result, { id, tag, parentElement: null, children: [], attributes: {}, disabled: false, open: false, value: '' });
    nodes.set(id, result);
    result.classList = { add() {} };
    result.setAttribute = (name, value) => { result.attributes[name] = String(value); };
    result.focus = () => { document.activeElement = result; };
    result.contains = target => target === result || result.children.some(child => child.contains(target));
    result.closest = selector => selector === `#${id}` ? result : result.parentElement?.closest?.(selector) || null;
    result.append = child => {
      if (child.parentElement?.children) child.parentElement.children = child.parentElement.children.filter(existing => existing !== child);
      child.parentElement = result; result.children.push(child);
    };
    result.insertBefore = (child, next) => {
      result.append(child); result.children.pop(); result.children.splice(result.children.indexOf(next), 0, child);
    };
    Object.defineProperty(result, 'nextSibling', { get: () => result.parentElement?.children?.[result.parentElement.children.indexOf(result) + 1] || null });
    result.showModal = () => { result.open = true; };
    result.close = () => { if (!result.open) return; result.open = false; result.emit('close'); };
    result.click = () => { if (!result.disabled) result.emit('click'); };
    parent?.append(result); return result;
  }
  const header = node('header', null, 'header'); header.parentElement = document;
  const toggle = node('settings', header), chat = node('chat', header), exit = node('exit', header);
  const dialog = node('settings-dialog', null, 'dialog'); dialog.parentElement = document;
  const closeButton = node('settings-close', dialog), audioSlot = node('audio-slot', dialog), helpSlot = node('help-slot', dialog);
  const sound = node('sound-toggle', header), rules = node('rules', header), rulesDialog = node('rules-dialog', null, 'dialog');
  rulesDialog.parentElement = document;
  const settings = () => mountRoomSettings({ document, buttonId: 'settings', dialogId: 'settings-dialog', closeButtonId: 'settings-close',
    controlIds: [{ id: 'sound-toggle', containerId: 'audio-slot' }, { id: 'rules', containerId: 'help-slot', dismiss: true }] });
  return { document, node, header, toggle, dialog, closeButton, audioSlot, helpSlot, sound, rules, rulesDialog, chat, exit, settings };
}

test('settings moves the original controls and leaves chat, exit and disabled permissions with their owners', () => {
  const f = fixture(); let soundClicks = 0, exitClicks = 0;
  f.sound.addEventListener('click', () => { soundClicks++; }); f.exit.addEventListener('click', () => { exitClicks++; });
  f.sound.disabled = true; const settings = f.settings();
  assert.equal(f.document.getElementById('sound-toggle'), f.sound);
  assert.equal(f.sound.parentElement, f.audioSlot); assert.equal(f.rules.parentElement, f.helpSlot);
  assert.equal(f.chat.parentElement, f.header); assert.equal(f.exit.parentElement, f.header);
  f.toggle.click(); assert.equal(f.dialog.open, true); assert.equal(f.toggle.attributes['aria-expanded'], 'true');
  f.sound.click(); assert.equal(soundClicks, 0); assert.equal(f.sound.disabled, true);
  f.sound.disabled = false; f.sound.click(); assert.equal(soundClicks, 1);
  f.exit.click(); assert.equal(exitClicks, 1);
  settings.destroy();
});

test('rule capture closes settings before its existing handler opens the rule modal, without two modal layers', () => {
  const f = fixture(), order = [];
  // Install the game's existing handler first; registration order cannot bypass capture.
  f.rules.addEventListener('click', () => { order.push(f.dialog.open); f.rulesDialog.showModal(); });
  f.settings(); f.toggle.click(); f.rules.click();
  assert.deepEqual(order, [false]); assert.equal(f.dialog.open, false); assert.equal(f.rulesDialog.open, true);
  assert.equal(f.toggle.attributes['aria-expanded'], 'false'); assert.notEqual(f.document.activeElement, f.toggle);
  f.rulesDialog.close(); assert.equal(f.document.querySelector('dialog[open]'), null);
  f.toggle.click(); assert.equal(f.dialog.open, true); assert.equal(f.rulesDialog.open, false);
});

test('closing and Escape dismiss settings, and Escape does not reach the game keyboard handler', () => {
  const f = fixture(); let gameEscapes = 0;
  f.document.addEventListener('keydown', event => { if (event.key === 'Escape') gameEscapes++; });
  f.settings(); f.toggle.click(); f.closeButton.click();
  assert.equal(f.dialog.open, false); assert.equal(f.document.activeElement, f.toggle);
  f.toggle.click(); f.dialog.emit('keydown', { key: 'Escape' });
  assert.equal(gameEscapes, 0);
  const cancellation = f.dialog.emit('cancel');
  assert.equal(cancellation.defaultPrevented, true); assert.equal(f.dialog.open, false);
  assert.equal(f.toggle.attributes['aria-expanded'], 'false');
});

test('background and pagehide close settings without restoring hidden-page focus', () => {
  const f = fixture(), settings = f.settings(); f.document.activeElement = f.chat;
  settings.open(); f.document.hidden = true; f.document.emit('visibilitychange');
  assert.equal(f.dialog.open, false); assert.equal(f.document.activeElement, f.chat);
  settings.open(); assert.equal(f.dialog.open, false);
  f.document.hidden = false; settings.open(); f.document.defaultView.emit('pagehide');
  assert.equal(f.dialog.open, false); assert.equal(f.document.activeElement, f.chat);
});

test('destroy restores node order, removes only its own handlers and makes old settings inert', () => {
  const f = fixture(), original = [...f.header.children]; let rulesClicks = 0;
  f.rules.addEventListener('click', () => { rulesClicks++; });
  const first = f.settings(); first.open(); first.destroy(); first.destroy();
  assert.deepEqual(f.header.children, original); f.toggle.click(); first.open(); assert.equal(f.dialog.open, false);
  f.rules.click(); assert.equal(rulesClicks, 1);
  const second = f.settings(); f.toggle.click(); assert.equal(f.dialog.open, true);
  f.rules.click(); assert.equal(f.dialog.open, false); assert.equal(rulesClicks, 2);
  second.destroy();
});

test('invalid assembly is rejected before controls or trigger attributes are changed', () => {
  const f = fixture(), original = [...f.header.children];
  assert.throws(() => mountRoomSettings({ document: f.document, buttonId: 'settings', dialogId: 'settings-dialog',
    controlIds: ['sound-toggle', { id: 'rules', containerId: 'missing' }] }), TypeError);
  assert.deepEqual(f.header.children, original); assert.equal(f.toggle.attributes['aria-expanded'], undefined);
  assert.throws(() => mountRoomSettings({ document: f.document, buttonId: 'settings', dialogId: 'settings-dialog',
    controlIds: ['sound-toggle'], dismissIds: ['missing'] }), TypeError);
  assert.deepEqual(f.header.children, original);
});

test('the actual shared audio controller retains mute and volume state through settings movement and remount', async () => {
  const f = fixture(), volume = f.node('sound-volume', f.header, 'input');
  let state = { supported: true, ready: true, muted: false, needsGesture: false, volume: .65 };
  const listeners = new Set(), played = [];
  const notify = () => listeners.forEach(listener => listener());
  const audio = { state: () => state, onStateChange: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    unlock: async () => {}, play: kind => { played.push(kind); }, setMuted: muted => { state = { ...state, muted }; notify(); },
    setVolume: value => { state = { ...state, volume: value }; notify(); } };
  const controls = mountRoomAudioControls({ audio, document: f.document });
  const settings = mountRoomSettings({ document: f.document, buttonId: 'settings', dialogId: 'settings-dialog',
    controlIds: [{ id: 'sound-toggle', containerId: 'audio-slot' }, { id: 'sound-volume', containerId: 'audio-slot' }] });
  settings.open(); assert.equal(volume.value, '65'); f.sound.click(); assert.equal(state.muted, true);
  volume.value = '30'; volume.emit('input'); assert.equal(state.volume, .3);
  settings.close(); settings.open(); assert.equal(f.sound.attributes['aria-pressed'], 'false'); assert.equal(volume.value, '30');
  f.sound.click(); await Promise.resolve(); await Promise.resolve(); assert.equal(state.muted, false); assert.deepEqual(played, ['placement']);
  settings.destroy(); assert.equal(state.volume, .3); assert.equal(state.muted, false);
  volume.value = '55'; volume.emit('input'); assert.equal(state.volume, .55, 'destroying settings does not destroy the audio owner');
  controls.destroy();
});

test('a third board entry can keep its own confirmation and option state without a game branch in settings', () => {
  const f = fixture(), route = f.node('route-option', f.header, 'select'), reset = f.node('reset-board', f.header);
  const confirmation = f.node('reset-confirmation', null, 'dialog'); confirmation.parentElement = f.document;
  const confirm = f.node('confirm-reset', confirmation), cancel = f.node('cancel-reset', confirmation);
  route.value = 'long-route'; let restarts = 0;
  reset.addEventListener('click', () => { assert.equal(f.dialog.open, false); confirmation.showModal(); });
  confirm.addEventListener('click', () => { restarts++; confirmation.close(); });
  cancel.addEventListener('click', () => confirmation.close());
  const settings = mountRoomSettings({ document: f.document, buttonId: 'settings', dialogId: 'settings-dialog',
    controlIds: ['route-option', { id: 'reset-board', dismiss: true }] });
  settings.open(); reset.click(); assert.equal(confirmation.open, true); assert.equal(restarts, 0); assert.equal(route.value, 'long-route');
  cancel.click(); assert.equal(restarts, 0); settings.open(); reset.click(); confirm.click();
  assert.equal(restarts, 1); assert.equal(route.value, 'long-route'); settings.destroy();
});
