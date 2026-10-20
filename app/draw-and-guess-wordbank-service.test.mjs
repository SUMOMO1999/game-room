import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EncryptedStore, MemoryAdapter, SQLiteAdapter, identityKey } from '../server/storage.mjs';
import { createDrawAndGuessWordbank, createWordbankRequestId, validateDrawAndGuessWordbankSnapshot, validateDrawAndGuessWordbankState } from '../server/content/draw-and-guess-wordbank.mjs';
import { DRAW_AND_GUESS_CATEGORIES, DRAW_AND_GUESS_ORIGINAL_SEED, DRAW_AND_GUESS_PREVIOUS_6408_SEED, DRAW_AND_GUESS_PREVIOUS_14400_SEED, DRAW_AND_GUESS_PREVIOUS_CLASSIFIED_SEED, DRAW_AND_GUESS_PREVIOUS_CATEGORIES, DRAW_AND_GUESS_SEED } from '../server/content/draw-and-guess-seed.mjs';
import { DRAW_AND_GUESS_QUALITY_REMOVALS } from '../server/content/draw-and-guess-quality-replacements.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { readSettings } from '../server/config.mjs';
import { validateDrawingRecoveryReferences, verifyLiveStore, backupStore, verifyBackup, restoreStore } from '../server/backup.mjs';

const actors = [0, 1, 2].map(index => ({ userKey: identityKey('urn:wordbank-service-test', String(index)), member: true, displayName: '同名伙伴' }));
const code = expected => error => error.code === expected;
const addition = (id = 'dg-test-boat', answer = '纸船') => ({ type: 'word.add', id, answer, category: 'custom', difficulty: 'easy', aliases: [], tags: [] });

function fixture(t, { sqlite = false, limits = {}, maxCasAttempts, protectedReference = null } = {}) {
  let time = 1791300000000;
  const now = () => time;
  const directory = sqlite ? mkdtempSync(join(tmpdir(), 'game-wordbank-service-')) : null;
  const key = randomBytes(32), adapter = sqlite ? new SQLiteAdapter(join(directory, 'content.sqlite'), { now }) : new MemoryAdapter({ now });
  const storage = new EncryptedStore(adapter, key, now);
  let service = createDrawAndGuessWordbank({ storage, now, limits, protectedReference, ...(maxCasAttempts ? { maxCasAttempts } : {}) });
  t.after(() => { storage.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const request = () => { const requestId = createWordbankRequestId(time); time++; return requestId; };
  const create = async (actor = actors[0], visibility = 'shared') => service.create(actor, { requestId: request(), name: '虚构内容测试', visibility });
  const change = async (packId, operations, actor = actors[0]) => {
    const current = await service.get(actor, packId);
    return service.change(actor, packId, { requestId: request(), expectedDraftRevision: current.draftRevision, operations });
  };
  const publish = async (packId, actor = actors[0]) => {
    const pack = await service.get(actor, packId);
    const preview = await service.preview(actor, packId, { expectedDraftRevision: pack.draftRevision, expectedPublishedHead: pack.publishedHead });
    return service.publish(actor, packId, { requestId: request(), expectedDraftRevision: pack.draftRevision, expectedPublishedHead: pack.publishedHead, previewHash: preview.previewHash });
  };
  const verifyQuota = async () => {
    const all = (await Promise.all(['wordbank-packs', 'wordbank-releases', 'wordbank-index'].map(scope => storage.scan(scope)))).flat();
    const actual = all.reduce((total, saved) => total + Buffer.byteLength(JSON.stringify(saved.value)), 0);
    const quota = await storage.get('wordbank-index', 'quota');
    assert.equal(quota.usedBytes, actual, 'quota must count drafts, releases, intents, receipts, history and its own record');
    return actual;
  };
  return { storage, service, now, request, create, change, publish, verifyQuota, directory, key, storePath: directory ? join(directory, 'content.sqlite') : null,
    advance: milliseconds => { time += milliseconds; },
    reopen: () => { service = createDrawAndGuessWordbank({ storage, now, limits, protectedReference }); return service; },
    wrap: transaction => createDrawAndGuessWordbank({ storage: { read: storage.read.bind(storage), compareAndSwapMany: transaction }, now, limits, protectedReference, maxCasAttempts: maxCasAttempts ?? 3 }) };
}

for (const sqlite of [false, true]) {
  const environment = sqlite ? 'SQLite' : 'Memory';
  test(`${environment}: valid members coedit public content; private authors, names and request receipts remain independent`, async t => {
    const f = fixture(t, { sqlite }), shared = await f.create(), privatePack = await f.create(actors[0], 'private');
    await f.change(shared.packId, [addition()], actors[1]);
    assert.equal((await f.service.get(actors[0], shared.packId)).draft.words[0].answer, '纸船');
    await assert.rejects(f.service.get(actors[1], privatePack.packId), code('PACK_UNAVAILABLE'));
    await assert.rejects(f.change(privatePack.packId, [addition()], actors[1]), code('PACK_UNAVAILABLE'));
    const outsider = { ...actors[2], member: false };
    await assert.rejects(f.service.list(outsider), code('MEMBER_REQUIRED'));
    assert.equal((await f.service.list(actors[1])).packs.some(pack => pack.id === privatePack.packId), false);
    const visible = JSON.stringify(await f.service.get(actors[1], shared.packId));
    for (const actor of actors) assert.equal(visible.includes(actor.userKey), false);
    await assert.rejects(f.service.create(actors[0], { requestId: f.request(), name: '伪造', visibility: 'private', userKey: actors[1].userKey }), code('INVALID_INPUT'));
    await f.verifyQuota();
  });

  test(`${environment}: two editors competing for one draft revision commit only one complete batch`, async t => {
    const f = fixture(t, { sqlite }), { packId } = await f.create();
    const inputs = [0, 1].map(index => ({ requestId: f.request(), expectedDraftRevision: 0, operations: [addition(`dg-test-${index}`, index ? '风车' : '纸船')] }));
    const results = await Promise.allSettled(inputs.map((input, index) => f.service.change(actors[index], packId, input)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DRAFT_CONFLICT');
    const pack = await f.service.get(actors[0], packId);
    assert.equal(pack.draftRevision, 1); assert.equal(pack.draft.words.length, 1);
    await f.verifyQuota();
  });

  test(`${environment}: an invalid or ambiguous row leaves the complete existing draft unchanged`, async t => {
    const f = fixture(t, { sqlite }), { packId } = await f.create();
    await f.change(packId, [addition()]); const before = await f.service.get(actors[0], packId);
    const input = { requestId: f.request(), expectedDraftRevision: before.draftRevision, operations: [addition('dg-test-second', '风车'), addition('dg-test-third', '纸 船')] };
    await assert.rejects(f.service.change(actors[0], packId, input), error => error.code === 'CONTENT_INVALID' && error.details.some(detail => detail.code === 'term-ambiguous'));
    const after = await f.service.get(actors[0], packId);
    assert.deepEqual(after, before);
    const receipt = await f.service.queryRequest(actors[0], { requestId: input.requestId, operation: 'change', packId, originalInput: input });
    assert.equal(receipt.status, 'rejected');
    await assert.rejects(f.service.change(actors[0], packId, input), code('CONTENT_INVALID'));
    await f.verifyQuota();
  });

  test(`${environment}: same owner request is normalized, immutable and bound across operations and packs`, async t => {
    const f = fixture(t, { sqlite });
    const input = { requestId: f.request(), name: '　虚构内容　', visibility: 'shared' };
    const first = await f.service.create(actors[0], input);
    const retry = await f.service.create(actors[0], { ...input, name: '虚构内容' });
    assert.equal(retry.packId, first.packId); assert.equal(retry.duplicate, true);
    await assert.rejects(f.service.create(actors[0], { ...input, visibility: 'private' }), code('REQUEST_ID_REUSED'));
    await assert.rejects(f.service.change(actors[0], first.packId, { requestId: input.requestId, expectedDraftRevision: 0, operations: [addition()] }), code('REQUEST_ID_REUSED'));
    const independent = await f.service.create(actors[1], input);
    assert.notEqual(independent.packId, first.packId);
    assert.equal((await f.service.queryRequest(actors[2], { requestId: input.requestId, operation: 'create', originalInput: input })).status, 'unknown');
    await f.verifyQuota();
  });

  test(`${environment}: preview is read-only, head CAS prevents stale publication and successful releases remain frozen`, async t => {
    const f = fixture(t, { sqlite }), { packId } = await f.create(); await f.change(packId, [addition()]);
    const before = await f.verifyQuota(), pack = await f.service.get(actors[0], packId);
    const preview = await f.service.preview(actors[0], packId, { expectedDraftRevision: 1, expectedPublishedHead: null });
    assert.equal(await f.verifyQuota(), before); assert.equal(preview.report.valid, true);
    const input = { requestId: f.request(), expectedDraftRevision: 1, expectedPublishedHead: null, previewHash: preview.previewHash };
    const first = await f.service.publish(actors[1], packId, input);
    assert.equal(first.publishedHead, 1);
    const original = await f.service.getRelease(actors[0], packId, 1);
    assert.equal(original.words[0].status, 'reviewed');
    await assert.rejects(f.service.publish(actors[0], packId, { ...input, requestId: f.request() }), code('HEAD_CONFLICT'));
    await f.change(packId, [{ type: 'word.update', id: 'dg-test-boat', patch: { answer: '风车' } }]);
    const second = await f.publish(packId); assert.equal(second.publishedHead, 2);
    assert.deepEqual(await f.service.getRelease(actors[0], packId, 1), original);
    const next = await f.service.getRelease(actors[0], packId, 2);
    assert.equal(next.words[0].answer, '风车'); assert.equal(next.words[0].id, original.words[0].id);
    assert.equal(next.words[0].definitionVersion, 2);
    assert.equal(pack.publishedHead, null); await f.verifyQuota();
  });

  test(`${environment}: restore verifies current unpublished revision and creates a new draft before a new publication`, async t => {
    const f = fixture(t, { sqlite }), { packId } = await f.create(); await f.change(packId, [addition()]); await f.publish(packId);
    await f.change(packId, [{ type: 'word.update', id: 'dg-test-boat', patch: { answer: '风车' } }]);
    const before = await f.service.previewRestore(actors[0], packId, { version: 1, expectedDraftRevision: 2, expectedPublishedHead: 1 });
    await f.change(packId, [addition('dg-test-flower', '纸花')], actors[1]);
    await assert.rejects(f.service.restore(actors[0], packId, { requestId: f.request(), version: 1, expectedDraftRevision: 2, expectedPublishedHead: 1, diffHash: before.diffHash }), code('DRAFT_CONFLICT'));
    const current = await f.service.get(actors[0], packId);
    const preview = await f.service.previewRestore(actors[0], packId, { version: 1, expectedDraftRevision: current.draftRevision, expectedPublishedHead: 1 });
    const restored = await f.service.restore(actors[0], packId, { requestId: f.request(), version: 1, expectedDraftRevision: current.draftRevision, expectedPublishedHead: 1, diffHash: preview.diffHash });
    assert.equal(restored.draftRevision, current.draftRevision + 1); assert.equal(restored.publishedHead, 1);
    const draft = await f.service.get(actors[0], packId); assert.equal(draft.draft.words[0].answer, '纸船'); assert.equal(draft.draft.words[0].status, 'draft');
    assert.ok(draft.draft.words[0].definitionVersion > 2);
    assert.equal((await f.publish(packId)).publishedHead, 2); await f.verifyQuota();
  });

  test(`${environment}: last shared slot and private limits are fenced across different trusted owners`, async t => {
    const f = fixture(t, { sqlite, limits: { sharedPacks: 1, privatePacks: 1 } });
    const outcomes = await Promise.allSettled([f.create(actors[0]), f.create(actors[1])]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'PACK_QUOTA');
    await f.create(actors[0], 'private'); await assert.rejects(f.create(actors[0], 'private'), code('PACK_QUOTA'));
    await f.create(actors[1], 'private'); await f.verifyQuota();
  });

  test(`${environment}: referenced releases survive bounded version pruning until their exact deadline expires`, async t => {
    const f = fixture(t, { sqlite, limits: { versions: 2 } }), { packId } = await f.create(); await f.change(packId, [addition()]); await f.publish(packId);
    await f.service.retainRelease(actors[0], packId, 1, { referenceId: 'dg-room-test', expiresAt: f.now() + 1000 });
    await f.publish(packId); await f.publish(packId);
    assert.equal((await f.service.getRelease(actors[0], packId, 1)).version, 1);
    assert.deepEqual((await f.service.get(actors[0], packId)).versions.map(entry => entry.version), [1, 2, 3]);
    f.advance(1001); await f.publish(packId);
    await assert.rejects(f.service.getRelease(actors[0], packId, 1), code('RELEASE_UNAVAILABLE'));
    assert.equal(await f.storage.get('wordbank-releases', `${packId}:1`), null);
    assert.deepEqual((await f.service.get(actors[0], packId)).versions.map(entry => entry.version), [3, 4]);
    await f.verifyQuota();
  });

  test(`${environment}: expired reference renews from the actual waiting snapshot and keeps its older adopted release until room removal`, async t => {
    let f; const observed = [];
    const protectedReference = async reference => {
      observed.push(reference);
      const room = await f.storage.read('rooms', reference.referenceId.slice(5));
      if (!room || !room.value.waiting || room.value.packId !== reference.packId || room.value.version !== reference.version) return null;
      return { expiresAt: room.value.expiresAt, guard: { scope: 'rooms', id: reference.referenceId.slice(5), expectedVersion: room.version, validUntil: room.value.expiresAt } };
    };
    f = fixture(t, { sqlite, limits: { versions: 1 }, protectedReference });
    const { packId } = await f.create(); await f.change(packId, [addition()]); await f.publish(packId);
    const roomId = 'waiting-test', roomDeadline = f.now() + 10000;
    await f.storage.put('rooms', roomId, { waiting: true, packId, version: 1, expiresAt: roomDeadline });
    await f.service.retainRelease(actors[0], packId, 1, { referenceId: `room-${roomId}`, expiresAt: f.now() + 1000 });
    f.advance(1001); await f.publish(packId);
    assert.deepEqual(observed.map(reference => [reference.packId, reference.referenceId, reference.version]), [[packId, 'room-waiting-test', 1]]);
    assert.equal((await f.storage.get('wordbank-packs', packId)).references[0].expiresAt, roomDeadline);
    assert.equal((await f.service.getRelease(actors[0], packId, 1)).version, 1);
    const savedRoom = await f.storage.read('rooms', roomId); assert.equal(savedRoom.value.expiresAt, roomDeadline, 'content GC never extends room lifetime');
    assert.equal(await f.storage.compareAndSwapMany({ changes: [{ scope: 'rooms', id: roomId, expectedVersion: savedRoom.version, value: null }] }), true);
    f.advance(10000); await f.publish(packId);
    await assert.rejects(f.service.getRelease(actors[0], packId, 1), code('RELEASE_UNAVAILABLE')); await f.verifyQuota();
  });

  test(`${environment}: preparing a different release followed by real room CAS conflict retains the current waiting version and a complete backup`, async t => {
    let runtime;
    const f = fixture(t, { sqlite, limits: { versions: 1 }, protectedReference: reference => runtime.rooms.getContentReference(reference) });
    runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), { storage: f.storage, now: f.now, wordbanks: f.service,
      drawingEnabled: true, roomOptions: { pollIntervalMs: 0, serverRandomInt: () => 0 }, chatOptions: { pollIntervalMs: 0 } });
    try {
      await runtime.wordbankReady; await runtime.canvases.ready;
      const host = await runtime.rooms.createRoom(actors[0].userKey, '虚构画者', 'reference-create', 'draw-and-guess');
      await runtime.rooms.joinRoom(host.roomCode, actors[1].userKey, '虚构猜者', 'reference-join');
      await f.publish('dg-base');
      const current = await runtime.rooms.getView(host.roomCode, actors[0].userKey), replace = f.storage.replaceCAS.bind(f.storage);
      let raced = false;
      f.storage.replaceCAS = async (scope, id, version, next, expiresAt) => {
        if (!raced && scope === 'rooms' && next.snapshot?.drawConfig?.contentSelection?.version === 2) {
          raced = true;
          const peer = await runtime.rooms.getView(host.roomCode, actors[1].userKey);
          await runtime.rooms.action(host.roomCode, actors[1].userKey, { type: 'ready', ready: true, requestId: 'reference-competing-ready', expectedRevision: peer.revision });
        }
        return replace(scope, id, version, next, expiresAt);
      };
      await assert.rejects(runtime.rooms.action(host.roomCode, actors[0].userKey, { type: 'configure', requestId: 'reference-configure-v2', expectedRevision: current.revision,
        drawConfig: { ...current.drawConfig, contentSelection: { ...current.drawConfig.contentSelection, version: 2 } } }), code('REVISION_CONFLICT'));
      assert.equal(raced, true);
      const room = (await f.storage.read('rooms', current.roomId)).value.snapshot, pack = await f.storage.get('wordbank-packs', 'dg-base');
      assert.equal(room.drawConfig.contentSelection.version, 1);
      assert.deepEqual(pack.references.filter(reference => reference.referenceId === `room-${room.roomId}`).map(reference => reference.version).sort(), [1, 2]);
      const state = { packs: [pack], releases: (await f.storage.scan('wordbank-releases')).map(row => row.value), index: (await f.storage.scan('wordbank-index')).map(row => row.value) };
      assert.doesNotThrow(() => validateDrawAndGuessWordbankState(state));
      assert.equal(validateDrawingRecoveryReferences({ rooms: [room], canvases: [], wordbankState: state, summaries: [] }), true);
      await f.publish('dg-base'); assert.equal((await f.service.getRelease(actors[0], 'dg-base', 1)).version, 1);
      if (sqlite) {
        assert.doesNotThrow(() => verifyLiveStore({ sourcePath: f.storePath, key: f.key }));
        const artifact = join(f.directory, 'waiting-cas-conflict-backup.sqlite');
        await backupStore({ sourcePath: f.storePath, destinationPath: artifact, key: f.key, now: f.now });
        assert.equal(verifyBackup({ sourcePath: artifact, key: f.key }).manifest.scopes.length, 18);
      }
      const duplicate = structuredClone(pack); duplicate.references.push(structuredClone(pack.references[0]));
      assert.throws(() => validateDrawAndGuessWordbankSnapshot('wordbank-packs', duplicate), TypeError);
      await f.verifyQuota();
    } finally {
      await runtime.canvases?.close(); await runtime.chat.close(); await runtime.rooms.close();
    }
  });

  test(`${environment}: room revision race rolls back candidate release, reference renewal, head and receipt as one transaction`, async t => {
    let f;
    const protectedReference = async reference => {
      const room = await f.storage.read('rooms', reference.referenceId.slice(5));
      return { expiresAt: f.now() + 10000, guard: { scope: 'rooms', id: 'room-race', expectedVersion: room.version } };
    };
    f = fixture(t, { sqlite, limits: { versions: 1 }, maxCasAttempts: 1, protectedReference });
    const { packId } = await f.create(); await f.change(packId, [addition()]); await f.publish(packId);
    await f.storage.put('rooms', 'room-race', { waiting: true });
    await f.service.retainRelease(actors[0], packId, 1, { referenceId: 'room-room-race', expiresAt: f.now() + 1000 }); f.advance(1001);
    const before = await f.storage.get('wordbank-packs', packId), preview = await f.service.preview(actors[0], packId, { expectedDraftRevision: 1, expectedPublishedHead: 1 });
    const requestId = f.request(); let raced = false;
    const competing = f.wrap(async transaction => {
      if (transaction.guards.some(guard => guard.scope === 'rooms')) {
        raced = true; await f.storage.put('rooms', 'room-race', { waiting: false });
      }
      return f.storage.compareAndSwapMany(transaction);
    });
    await assert.rejects(competing.publish(actors[0], packId, { requestId, expectedDraftRevision: 1, expectedPublishedHead: 1, previewHash: preview.previewHash }), code('REQUEST_UNKNOWN'));
    assert.equal(raced, true); assert.deepEqual(await f.storage.get('wordbank-packs', packId), before);
    assert.equal(await f.storage.get('wordbank-releases', `${packId}:2`), null);
    assert.equal((await f.service.getRelease(actors[0], packId, 1)).version, 1);
    assert.equal((await f.service.queryRequest(actors[0], { requestId, operation: 'publish', packId, originalInput: { expectedDraftRevision: 1, expectedPublishedHead: 1, previewHash: preview.previewHash } })).status, 'unknown');
    await f.verifyQuota();
  });

  test(`${environment}: seed import is atomic and restart-safe; optional initial system publication never overwrites member edits`, async t => {
    const f = fixture(t, { sqlite });
    const first = await f.service.ensureSeed({ publishInitial: true }); assert.equal(first.publishedHead, 1);
    const release = await f.service.getRelease(actors[0], 'dg-base', 1);
    assert.equal(release.words.length, DRAW_AND_GUESS_SEED.length); assert.equal(release.publicationSource, 'system-seed'); assert.equal(release.publisher.displayCode, 'system-seed');
    await f.change('dg-base', [{ type: 'word.update', id: release.words[0].id, patch: { answer: '晴雨伞' } }], actors[1]);
    const current = await f.service.get(actors[0], 'dg-base'); const restarted = f.reopen();
    assert.equal((await restarted.ensureSeed({ publishInitial: true })).imported, false);
    assert.deepEqual(await restarted.get(actors[0], 'dg-base'), current);
    assert.equal((await restarted.getRelease(actors[0], 'dg-base', 1)).words[0].answer, '雨伞'); await f.verifyQuota();
  });
}

test('expired waiting snapshots may be conservatively protected without renewing their expired room deadline', async t => {
  let f;
  const protectedReference = async reference => {
    const room = await f.storage.read('rooms', reference.referenceId.slice(5));
    return { expiresAt: f.now() + 8 * 60 * 60 * 1000, guard: { scope: 'rooms', id: 'expired-waiting', expectedVersion: room.version } };
  };
  f = fixture(t, { limits: { versions: 1 }, protectedReference });
  const { packId } = await f.create(); await f.change(packId, [addition()]); await f.publish(packId);
  const deadline = f.now() + 1000; await f.storage.put('rooms', 'expired-waiting', { waiting: true, roomExpiresAt: deadline });
  await f.service.retainRelease(actors[0], packId, 1, { referenceId: 'room-expired-waiting', expiresAt: deadline });
  f.advance(1001); await f.publish(packId);
  assert.equal((await f.service.getRelease(actors[0], packId, 1)).version, 1);
  assert.equal((await f.storage.get('rooms', 'expired-waiting')).roomExpiresAt, deadline);
  assert.ok((await f.storage.get('wordbank-packs', packId)).references[0].expiresAt > f.now()); await f.verifyQuota();
});

test('legacy legal nicknames with markup or emoji never invalidate a trusted identity or change its actual profile', async t => {
  const f = fixture(t), runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), { storage: f.storage, now: f.now, wordbanks: f.service,
    drawingEnabled: false, roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  try {
    for (const displayName of ['<伙伴>', '👩‍🎨', '🌟伙伴']) {
      const profile = await runtime.rooms.setProfile(actors[0].userKey, displayName), trustedActor = { ...actors[0], displayName: profile.nickname };
      const { packId } = await f.service.create(trustedActor, { requestId: f.request(), name: '昵称兼容库', visibility: 'private' });
      await f.change(packId, [addition()], trustedActor);
      const pack = await f.service.get(trustedActor, packId);
      assert.equal(pack.owned, true); assert.equal(pack.history[0].actor.displayName, displayName === '🌟伙伴' ? displayName : '伙伴');
      assert.equal(JSON.stringify(pack).includes(actors[0].userKey), false); await assert.rejects(f.service.get(actors[1], packId), code('PACK_UNAVAILABLE'));
      assert.equal((await f.service.list(trustedActor)).packs.some(value => value.id === packId), true);
      assert.deepEqual(await runtime.rooms.ensureProfile(actors[0].userKey), profile, 'wordbank labels must not rename an existing account profile');
    }
    await f.verifyQuota();
  } finally { await runtime.chat.close(); await runtime.rooms.close(); }
});

test('expired interrupted create markers remain signed backup data but do not resurrect a collected waiting release', async t => {
  let runtime;
  const f = fixture(t, { sqlite: true, limits: { versions: 1 }, protectedReference: reference => runtime.rooms.getContentReference(reference) });
  runtime = createRuntime(readSettings({ GAME_ROOM_AUTH_MODE: 'mock' }), { storage: f.storage, now: f.now, wordbanks: f.service,
    drawingEnabled: true, roomOptions: { pollIntervalMs: 0 }, chatOptions: { pollIntervalMs: 0 } });
  try {
    await runtime.wordbankReady; await runtime.canvases.ready;
    const original = f.storage.putIfAbsent.bind(f.storage);
    f.storage.putIfAbsent = async (scope, ...args) => { if (scope === 'rooms') throw new Error('Synthetic interrupted create after durable pending marker'); return original(scope, ...args); };
    await assert.rejects(runtime.rooms.createRoom(actors[0].userKey, '虚构伙伴', 'reference-pending-create', 'draw-and-guess'));
    f.storage.putIfAbsent = original;
    f.advance(7 * 24 * 60 * 60 * 1000 + 1); await f.publish('dg-base');
    assert.equal(await f.storage.get('wordbank-releases', 'dg-base:1'), null);
    assert.equal((await f.storage.scan('room-requests')).length, 0, 'expired pending cannot be retried as a live create');
    assert.doesNotThrow(() => verifyLiveStore({ sourcePath: f.storePath, key: f.key, now: f.now }));
    const artifact = join(f.directory, 'expired-pending-backup.sqlite');
    await backupStore({ sourcePath: f.storePath, destinationPath: artifact, key: f.key, now: f.now });
    const verified = verifyBackup({ sourcePath: artifact, key: f.key });
    assert.ok(verified.rows.some(row => row.key.startsWith('room-requests:')), 'expired rows remain encrypted and signed rather than silently removed');
    assert.equal(verified.manifest.createdAt, f.now());
    const restoredPath = join(f.directory, 'expired-pending-restored.sqlite');
    restoreStore({ sourcePath: artifact, destinationPath: restoredPath, key: f.key, offline: true });
    const restored = new EncryptedStore(new SQLiteAdapter(restoredPath, { now: f.now }), f.key, f.now);
    try {
      const operationKey = createHash('sha256').update(`${actors[0].userKey}\0reference-pending-create`).digest('hex');
      assert.equal(await restored.read('room-requests', operationKey), null);
      assert.equal((await restored.scan('room-requests')).length, 0);
      assert.equal((await restored.adapter.entries('room-requests')).length, 1, 'physical signed marker exists but is not live business state');
    } finally { restored.close(); }
    await f.verifyQuota();
  } finally {
    await runtime.canvases.close(); await runtime.chat.close(); await runtime.rooms.close();
  }
});

test('missing or faulty room protection integration conservatively retains old versions rather than treating failure as a missing room', async t => {
  const f = fixture(t, { limits: { versions: 1 } }), { packId } = await f.create(); await f.change(packId, [addition()]); await f.publish(packId);
  await f.service.retainRelease(actors[0], packId, 1, { referenceId: 'room-unknown-waiting', expiresAt: f.now() + 1000 });
  f.advance(1001); await f.publish(packId);
  assert.equal((await f.service.getRelease(actors[0], packId, 1)).version, 1);
  await f.service.retainRelease(actors[0], packId, 2, { referenceId: 'room-another-waiting', expiresAt: f.now() + 1000 });
  assert.equal((await f.storage.get('wordbank-packs', packId)).references.some(reference => reference.referenceId === 'room-unknown-waiting'), true);
  const broken = createDrawAndGuessWordbank({ storage: f.storage, now: f.now, limits: { versions: 1 }, protectedReference: async () => ({ expiresAt: f.now() + 9 * 24 * 60 * 60 * 1000, guard: {} }) });
  const pack = await f.service.get(actors[0], packId), preview = await broken.preview(actors[0], packId, { expectedDraftRevision: pack.draftRevision, expectedPublishedHead: pack.publishedHead });
  await assert.rejects(broken.publish(actors[0], packId, { requestId: f.request(), expectedDraftRevision: pack.draftRevision, expectedPublishedHead: pack.publishedHead, previewHash: preview.previewHash }), code('CONTENT_REFERENCE_UNAVAILABLE'));
  assert.equal((await f.service.get(actors[0], packId)).publishedHead, 2); assert.equal(await f.storage.get('wordbank-releases', `${packId}:3`), null); await f.verifyQuota();
});

test('large expired room reference backlogs stay bounded by the real 64-key transaction limit and remaining releases stay charged', async t => {
  let f, calls = 0;
  const protectedReference = async reference => {
    calls++; const roomId = reference.referenceId.slice(5), saved = await f.storage.read('rooms', roomId);
    return { expiresAt: f.now() + 10000, guard: { scope: 'rooms', id: roomId, expectedVersion: saved.version } };
  };
  f = fixture(t, { limits: { versions: 1 }, protectedReference });
  const { packId } = await f.create(); await f.change(packId, [addition()]); await f.publish(packId);
  const deadline = f.now() + 1000;
  for (let index = 0; index < 61; index++) {
    const roomId = `waiting-${index}`; await f.storage.put('rooms', roomId, { waiting: true });
    await f.service.retainRelease(actors[0], packId, 1, { referenceId: `room-${roomId}`, expiresAt: deadline });
  }
  f.advance(1001); await f.publish(packId); assert.equal(calls, 60);
  assert.equal((await f.storage.get('wordbank-packs', packId)).references.length, 61);
  assert.equal((await f.service.getRelease(actors[0], packId, 1)).version, 1); await f.verifyQuota();
  await f.publish(packId); assert.equal(calls, 61);
  assert.equal(await f.storage.get('wordbank-releases', `${packId}:2`), null); await f.verifyQuota();
});

test('expired receipts and bounded watermark never silently reinterpret an original ID as a new operation', async t => {
  const f = fixture(t, { limits: { receipts: 2 } });
  const first = { requestId: f.request(), name: '最早词库', visibility: 'private' }; await f.service.create(actors[0], first);
  await f.create(actors[0], 'private'); await f.create(actors[0], 'private');
  assert.equal((await f.service.queryRequest(actors[0], { requestId: first.requestId, operation: 'create', originalInput: first })).status, 'unknown');
  await assert.rejects(f.service.create(actors[0], first), code('REQUEST_UNKNOWN'));
  f.advance(24 * 60 * 60 * 1000);
  await assert.rejects(f.service.create(actors[0], first), code('REQUEST_EXPIRED'));
  const future = { requestId: createWordbankRequestId(f.now() + 5 * 60 * 1000 + 1), name: '未来', visibility: 'shared' };
  await assert.rejects(f.service.create(actors[0], future), code('REQUEST_FUTURE'));
  const saved = await f.storage.get('wordbank-index', `owner-${actors[0].userKey}`);
  assert.ok(saved.receipts.length <= 2); assert.ok(saved.prunedBefore >= parseInt(first.requestId.split('-')[0], 36)); await f.verifyQuota();
});

test('lost successful response resolves only from original durable receipt without duplicate content after a new service instance', async t => {
  const f = fixture(t), { packId } = await f.create();
  const faulty = f.wrap(async transaction => {
    const committed = await f.storage.compareAndSwapMany(transaction);
    if (transaction.changes.some(change => change.scope === 'wordbank-packs')) throw new Error('Synthetic lost response after commit');
    return committed;
  });
  const input = { requestId: f.request(), expectedDraftRevision: 0, operations: [addition()] };
  await assert.rejects(faulty.change(actors[0], packId, input), code('UNKNOWN_RESULT'));
  const restarted = f.reopen(), receipt = await restarted.queryRequest(actors[0], { requestId: input.requestId, operation: 'change', packId, originalInput: input });
  assert.equal(receipt.status, 'committed'); assert.equal(receipt.result.draftRevision, 1);
  assert.equal((await restarted.change(actors[0], packId, input)).duplicate, true);
  assert.equal((await restarted.get(actors[0], packId)).draft.words.length, 1); await f.verifyQuota();
});

test('unknown failed commit remains fenced and charged after restart; no implicit original-request continuation', async t => {
  const f = fixture(t), { packId } = await f.create();
  const faulty = f.wrap(async transaction => {
    if (transaction.changes.some(change => change.scope === 'wordbank-packs')) throw new Error('Synthetic failure before commit');
    return f.storage.compareAndSwapMany(transaction);
  });
  const input = { requestId: f.request(), expectedDraftRevision: 0, operations: [addition()] };
  await assert.rejects(faulty.change(actors[0], packId, input), code('UNKNOWN_RESULT'));
  const restarted = f.reopen();
  assert.equal((await restarted.queryRequest(actors[0], { requestId: input.requestId, operation: 'change', packId, originalInput: input })).status, 'unknown');
  await assert.rejects(restarted.change(actors[0], packId, input), code('REQUEST_UNKNOWN'));
  assert.equal((await restarted.get(actors[0], packId)).draftRevision, 0);
  assert.equal((await restarted.get(actors[0], packId)).draft.words.length, 0); await f.verifyQuota();
});

test('failed head transaction never leaves an orphan release or successful version directory', async t => {
  const f = fixture(t, { maxCasAttempts: 1 }), { packId } = await f.create(); await f.change(packId, [addition()]);
  const faulty = f.wrap(transaction => transaction.changes.some(change => change.scope === 'wordbank-releases') ? Promise.resolve(false) : f.storage.compareAndSwapMany(transaction));
  const preview = await faulty.preview(actors[0], packId, { expectedDraftRevision: 1, expectedPublishedHead: null });
  const input = { requestId: f.request(), expectedDraftRevision: 1, expectedPublishedHead: null, previewHash: preview.previewHash };
  await assert.rejects(faulty.publish(actors[0], packId, input), code('REQUEST_UNKNOWN'));
  assert.equal(await f.storage.get('wordbank-releases', `${packId}:1`), null);
  const pack = await f.service.get(actors[0], packId); assert.equal(pack.publishedHead, null); assert.deepEqual(pack.versions, []);
  await f.verifyQuota();
});

test('draft category/word lifecycle respects confirmations, source ownership and counting caps', async t => {
  const f = fixture(t, { limits: { categories: 2, sharedWords: 2 } }), { packId } = await f.create();
  await f.change(packId, [{ type: 'category.add', id: 'objects', name: '物件' }, { ...addition(), category: 'objects' }]);
  await assert.rejects(f.change(packId, [{ type: 'category.status', id: 'objects', status: 'disabled', confirmedAffectedCount: 0 }]), code('IMPACT_CONFIRMATION'));
  await f.change(packId, [{ type: 'category.rename', id: 'objects', name: '日常小物' }, { type: 'category.status', id: 'objects', status: 'disabled', confirmedAffectedCount: 1 }]);
  const hidden = await f.service.preview(actors[0], packId, { expectedDraftRevision: 2, expectedPublishedHead: null }); assert.equal(hidden.report.valid, false);
  await f.change(packId, [{ type: 'category.status', id: 'objects', status: 'active' }, { type: 'word.retire', id: 'dg-test-boat', confirmed: true }, addition('dg-test-flower', '纸花')]);
  await assert.rejects(f.change(packId, [addition('dg-test-third', '风车')]), code('PACK_COUNT_LIMIT'));
  const published = await f.publish(packId), release = await f.service.getRelease(actors[0], packId, published.publishedHead);
  assert.equal(release.words.find(word => word.id === 'dg-test-boat').status, 'retired');
  assert.equal(release.categories.find(category => category.id === 'objects').name, '日常小物');
  await assert.rejects(f.change(packId, [{ type: 'word.update', id: 'dg-test-flower', patch: { source: '伪造审核' } }]), code('INVALID_INPUT'));
  await f.verifyQuota();
});

test('global bytes include durable failed-intent metadata and prevent a second package from crossing the hard limit', async t => {
  const f = fixture(t, { limits: { totalBytes: 1800 } });
  await f.create(actors[0], 'private');
  await assert.rejects(f.create(actors[0], 'private'), error => ['GLOBAL_QUOTA', 'UNKNOWN_RESULT'].includes(error.code));
  const used = await f.verifyQuota(); assert.ok(used <= 1800);
  assert.equal((await f.service.list(actors[0])).packs.length, 1);
});

test('draft-only seed mode never silently publishes on a later initialization call', async t => {
  const f = fixture(t); await f.service.ensureSeed();
  assert.equal((await f.service.get(actors[0], 'dg-base')).publishedHead, null);
  assert.equal((await f.reopen().ensureSeed({ publishInitial: true })).imported, false);
  assert.equal((await f.service.get(actors[0], 'dg-base')).publishedHead, null);
  assert.throws(() => createDrawAndGuessWordbank({ storage: { read() {} } }), TypeError);
  await f.verifyQuota();
});

test('private author may explicitly copy a published version to a separate public draft; other members cannot copy private content', async t => {
  const f = fixture(t), privatePack = await f.create(actors[0], 'private'); await f.change(privatePack.packId, [addition()]); await f.publish(privatePack.packId);
  const input = { requestId: f.request(), name: '明确共享的副本', visibility: 'shared', sourcePackId: privatePack.packId, sourceVersion: 1 };
  await assert.rejects(f.service.copy(actors[1], input), code('PACK_UNAVAILABLE'));
  const copied = await f.service.copy(actors[0], input), content = await f.service.get(actors[1], copied.packId);
  assert.equal(content.publishedHead, null); assert.equal(content.draft.words[0].status, 'draft');
  assert.equal(content.draft.words[0].id, 'dg-test-boat'); assert.equal(content.draft.words[0].packId, copied.packId);
  await f.change(privatePack.packId, [{ type: 'word.update', id: 'dg-test-boat', patch: { answer: '风车' } }]);
  assert.equal((await f.service.get(actors[1], copied.packId)).draft.words[0].answer, '纸船');
  assert.equal((await f.service.copy(actors[0], input)).packId, copied.packId);
  await f.verifyQuota();
});

test('backup verification accepts exact active state and rejects wrong quota, orphan releases, missing heads and forged owners', async t => {
  const f = fixture(t), { packId } = await f.create(actors[0], 'private'); await f.change(packId, [addition()]); await f.publish(packId);
  const state = { packs: (await f.storage.scan('wordbank-packs')).map(record => record.value),
    releases: (await f.storage.scan('wordbank-releases')).map(record => record.value), index: (await f.storage.scan('wordbank-index')).map(record => record.value) };
  assert.equal(validateDrawAndGuessWordbankState(state), state);
  const badQuota = structuredClone(state); badQuota.index.find(value => 'usedBytes' in value).usedBytes++;
  assert.throws(() => validateDrawAndGuessWordbankState(badQuota), TypeError);
  assert.throws(() => validateDrawAndGuessWordbankState({ ...state, releases: [] }), TypeError);
  const orphan = structuredClone(state); orphan.releases.push({ ...orphan.releases[0], version: 99 });
  assert.throws(() => validateDrawAndGuessWordbankState(orphan), TypeError);
  const forgedOwner = structuredClone(state); forgedOwner.index.find(value => 'usedBytes' in value).packs[0].ownerKey = actors[1].userKey;
  assert.throws(() => validateDrawAndGuessWordbankState(forgedOwner), TypeError);
  const brokenHead = structuredClone(state.packs[0]); brokenHead.publishedHead = 2;
  assert.throws(() => validateDrawAndGuessWordbankSnapshot('wordbank-packs', brokenHead), TypeError);
  const leakedField = structuredClone(state.packs[0]); leakedField.draft.words[0].authorUserKey = actors[0].userKey;
  assert.throws(() => validateDrawAndGuessWordbankSnapshot('wordbank-packs', leakedField), TypeError);
  assert.equal(validateDrawAndGuessWordbankState({ packs: [], releases: [], index: [] }).packs.length, 0);
});

test('a genuinely fresh Node process reopens encrypted SQLite and preserves seed edits, immutable release and exact receipts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wordbank-restart-process-')), path = join(directory, 'content.sqlite'), key = randomBytes(32);
  const time = 1791300000000, now = () => time;
  const storage = new EncryptedStore(new SQLiteAdapter(path, { now }), key, now);
  const service = createDrawAndGuessWordbank({ storage, now });
  let closed = false;
  t.after(() => { if (!closed) storage.close(); rmSync(directory, { recursive: true, force: true }); });
  await service.ensureSeed({ publishInitial: true });
  const input = { requestId: createWordbankRequestId(time), expectedDraftRevision: 0,
    operations: [{ type: 'word.update', id: 'dg-base-0001', patch: { answer: '晴雨伞' } }] };
  await service.change(actors[0], 'dg-base', input); storage.close(); closed = true;
  const source = `
    import {EncryptedStore,SQLiteAdapter} from './server/storage.mjs';
    import {createDrawAndGuessWordbank} from './server/content/draw-and-guess-wordbank.mjs';
    import {readFileSync} from 'node:fs';
    const {path,keyHex,time,actor,input}=JSON.parse(readFileSync(0,'utf8'));
    const now=()=>time, storage=new EncryptedStore(new SQLiteAdapter(path,{now}),Buffer.from(keyHex,'hex'),now);
    const service=createDrawAndGuessWordbank({storage,now});
    const imported=await service.ensureSeed({publishInitial:true}), pack=await service.get(actor,'dg-base');
    const old=await service.getRelease(actor,'dg-base',1), receipt=await service.queryRequest(actor,{requestId:input.requestId,operation:'change',packId:'dg-base',originalInput:input});
    console.log(JSON.stringify({imported:imported.imported,draft:pack.draft.words[0].answer,old:old.words[0].answer,revision:pack.draftRevision,receipt:receipt.status}));
    storage.close();`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source],
    { cwd: new URL('..', import.meta.url), input: JSON.stringify({ path, keyHex: key.toString('hex'), time, actor: actors[0], input }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(output), { imported: false, draft: '晴雨伞', old: '雨伞', revision: 1, receipt: 'committed' });
});

// A real schema-1 legacy snapshot, not the new ensureSeed path, drives upgrades.
const contentCanonical = value => Array.isArray(value) ? `[${value.map(contentCanonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${contentCanonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const contentHash = value => createHash('sha256').update(contentCanonical(value)).digest('hex');
function assertProtectedDifficultyMerge(actual,before) {
  const previous=new Map(DRAW_AND_GUESS_PREVIOUS_14400_SEED.map(word=>[word.id,word]));
  const current=new Map(DRAW_AND_GUESS_SEED.map(word=>[word.id,word])),actualById=new Map(actual.map(word=>[word.id,word]));
  const removed=new Set(DRAW_AND_GUESS_QUALITY_REMOVALS.map(word=>word.id));
  for(const saved of before) {
    if(contentCanonical(saved)===contentCanonical(previous.get(saved.id))) {
      if(removed.has(saved.id))assert.equal(actualById.has(saved.id),false,'approved unchanged rejected word is absent');
      else assert.deepEqual(actualById.get(saved.id),current.get(saved.id));
    } else assert.deepEqual(actualById.get(saved.id),saved,'member changes must be preserved');
  }
}
async function legacySeed(f, { published = true, retired = false, expanded6408 = false, expanded14400 = false, classified14400 = false } = {}) {
  const categories=structuredClone(expanded6408||expanded14400||classified14400 ? DRAW_AND_GUESS_PREVIOUS_CATEGORIES : DRAW_AND_GUESS_PREVIOUS_CATEGORIES.slice(0,8)),
    words=structuredClone(classified14400?DRAW_AND_GUESS_PREVIOUS_CLASSIFIED_SEED:expanded14400?DRAW_AND_GUESS_PREVIOUS_14400_SEED:expanded6408 ? DRAW_AND_GUESS_PREVIOUS_6408_SEED : DRAW_AND_GUESS_ORIGINAL_SEED);
  const release={schemaVersion:1,packId:'dg-base',version:1,name:'基础词库',categories,words,
    contentHash:contentHash({name:'基础词库',categories,words}),publishedAt:f.now(),publicationSource:'system-seed',
    publisher:{displayName:'系统基础词库',displayCode:'system-seed'}};
  const pack={schemaVersion:1,id:'dg-base',name:'基础词库',visibility:'shared',ownerKey:null,retired,draftRevision:0,
    draft:{categories,words},publishedHead:published?1:null,versions:published?[{version:1,hash:release.contentHash,publishedAt:f.now()}]:[],references:[],history:[],
    seed:{version:1,hash:contentHash({categories,words}),...(published?{initialPublished:true}:{})},...(published?{lastPublishedVersion:1}:{})};
  const quota={schemaVersion:1,usedBytes:0,packs:[{packId:'dg-base',visibility:'shared',ownerKey:null}]};
  const size=value=>Buffer.byteLength(JSON.stringify(value));
  for(let n=0;n<10;n++)quota.usedBytes=size(pack)+(published?size(release):0)+size(quota);
  await f.storage.put('wordbank-packs','dg-base',pack);
  if(published)await f.storage.put('wordbank-releases','dg-base:1',release);
  await f.storage.put('wordbank-index','quota',quota);
  await f.verifyQuota(); return release;
}
for(const sqlite of [false,true]) {
  test(`${sqlite?'SQLite':'Memory'}: seed expansion merges pending draft and published head independently and is a zero-write restart`,async t=>{
    const f=fixture(t,{sqlite}),old=await legacySeed(f);
    await f.change('dg-base',[
      {type:'word.update',id:'dg-base-0001',patch:{answer:'发布晴雨伞',aliases:['晴雨两用伞']}},
      {type:'word.retire',id:'dg-base-0002',confirmed:true},
    ]);await f.publish('dg-base');
    const published=await f.service.getRelease(actors[0],'dg-base',2);
    const newWord=DRAW_AND_GUESS_SEED[560];
    await f.change('dg-base',[
      {type:'word.update',id:'dg-base-0001',patch:{answer:'未发布晴雨伞',aliases:['本人待定伞']}},
      {type:'word.add',id:'partner-existing-term',answer:newWord.answer,aliases:[],category:'daily',difficulty:'normal',tags:[]},
      {type:'category.add',id:'home',name:'伙伴已改居家分类'},
    ]);
    const before=await f.service.get(actors[0],'dg-base');
    const result=await f.reopen().ensureSeed({publishInitial:true});assert.equal(result.upgraded,true);assert.equal(result.publishedHead,3);
    assert.equal(result.draft.semanticCollision,1);assert.equal(result.draft.retiredPreserved,1);
    const after=await f.service.get(actors[0],'dg-base'),release=await f.service.getRelease(actors[0],'dg-base',3);
    assert.equal(after.draft.words.find(w=>w.id==='dg-base-0001').answer,'未发布晴雨伞');
    assert.deepEqual(after.draft.words.find(w=>w.id==='dg-base-0001'),before.draft.words.find(w=>w.id==='dg-base-0001'));
    assert.equal(release.words.find(w=>w.id==='dg-base-0001').answer,'发布晴雨伞');
    assert.equal(after.draft.words.find(w=>w.id==='dg-base-0002').status,'retired');
    assert.equal(release.words.find(w=>w.id==='dg-base-0002').status,'retired');
    assert.equal(after.draft.words.some(w=>w.id===newWord.id),false);
    assert.equal(after.draft.words.find(w=>w.id==='partner-existing-term').status,'draft');
    assert.equal(release.words.some(w=>w.id===newWord.id),true);
    assert.equal(after.draft.categories.find(c=>c.id==='home').name,'伙伴已改居家分类');
    assert.equal(release.categories.find(c=>c.id==='home').name,DRAW_AND_GUESS_CATEGORIES.find(c=>c.id==='home').name);
    assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',1),old);
    assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',2),published);
    const stable=await f.storage.read('wordbank-packs','dg-base'),stableQuota=await f.storage.read('wordbank-index','quota');
    assert.equal((await f.reopen().ensureSeed({publishInitial:true})).imported,false);
    assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),stable);assert.deepEqual(await f.storage.read('wordbank-index','quota'),stableQuota);
    await f.verifyQuota();
    const state={packs:(await f.storage.scan('wordbank-packs')).map(r=>r.value),releases:(await f.storage.scan('wordbank-releases')).map(r=>r.value),index:(await f.storage.scan('wordbank-index')).map(r=>r.value)};
    assert.doesNotThrow(()=>validateDrawAndGuessWordbankState(state));
    if(sqlite){
      const backup=join(f.directory,'expanded-backup.sqlite'),restored=join(f.directory,'expanded-restored.sqlite');
      await backupStore({sourcePath:f.storePath,destinationPath:backup,key:f.key,now:f.now});
      restoreStore({sourcePath:backup,destinationPath:restored,key:f.key,offline:true});
      const storage=new EncryptedStore(new SQLiteAdapter(restored,{now:f.now}),f.key,f.now);t.after(()=>storage.close());
      const reopened=createDrawAndGuessWordbank({storage,now:f.now});
      assert.deepEqual(await reopened.getRelease(actors[0],'dg-base',1),old);
      assert.deepEqual(await reopened.get(actors[0],'dg-base'),after);
      assert.equal((await reopened.ensureSeed({publishInitial:true})).imported,false);
    }
  });
  test(`${sqlite?'SQLite':'Memory'}: legacy expansion CAS race commits exactly once and preserves old retained release`,async t=>{
    const f=fixture(t,{sqlite});const old=await legacySeed(f);
    await f.service.retainRelease(actors[0],'dg-base',1,{referenceId:'room-legacy-waiting',expiresAt:f.now()+3600000});
    const result=await Promise.all([f.service.ensureSeed({publishInitial:true}),f.reopen().ensureSeed({publishInitial:true})]);
    assert.equal(result.filter(r=>r.upgraded).length,1);
    assert.equal((await f.service.get(actors[0],'dg-base')).publishedHead,2);
    assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',1),old);
    assert.equal((await f.storage.get('wordbank-packs','dg-base')).references[0].version,1);
    await f.verifyQuota();
  });
}
test('seed upgrade capacity or CAS rejection leaves the complete legacy state unchanged',async t=>{
  const f=fixture(t);await legacySeed(f);
  const before=await f.storage.read('wordbank-packs','dg-base'),quota=await f.storage.read('wordbank-index','quota');
  const capped=createDrawAndGuessWordbank({storage:f.storage,now:f.now,limits:{sharedWords:600}});
  await assert.rejects(capped.ensureSeed({publishInitial:true}),code('PACK_COUNT_LIMIT'));
  const neverCommit=f.wrap(()=>Promise.resolve(false));await assert.rejects(neverCommit.ensureSeed({publishInitial:true}),code('CONTENT_BUSY'));
  assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),before);assert.deepEqual(await f.storage.read('wordbank-index','quota'),quota);
  assert.equal(await f.storage.get('wordbank-releases','dg-base:2'),null);await f.verifyQuota();
});
test('a deliberately unpublished or retired legacy pack stays unpublished or retired after expansion',async t=>{
  for(const options of [{published:false},{retired:true}]){
    const f=fixture(t);await legacySeed(f,options);await f.service.ensureSeed({publishInitial:true});
    const pack=await f.service.get(actors[0],'dg-base');
    assert.equal(pack.publishedHead,options.published===false?null:1);assert.equal(pack.retired,options.retired===true);
    assert.equal(await f.storage.get('wordbank-releases','dg-base:2'),null);await f.verifyQuota();
  }
});
test('new rooms use expanded normal categories; an already selected room keeps its exact version and categories',async t=>{
  const f=fixture(t);await f.service.ensureSeed({publishInitial:true});
  // Use the production defaults for all non-content fields, not a second config schema.
  const runtime=createRuntime(readSettings({GAME_ROOM_AUTH_MODE:'mock'}),{storage:f.storage,now:f.now,wordbanks:f.service,drawingEnabled:true,roomOptions:{pollIntervalMs:0},chatOptions:{pollIntervalMs:0}});
  t.after(async()=>{await runtime.canvases.close();await runtime.chat.close();await runtime.rooms.close();});
  await runtime.wordbankReady;
  const created=await runtime.rooms.createRoom(actors[0].userKey,'虚构扩量画者','expanded-default-room','draw-and-guess');
  const selection=created.view.drawConfig.contentSelection;
  assert.ok(selection.categoryIds.includes('life-action'));assert.ok(selection.categoryIds.includes('fruit-veg'));assert.ok(selection.categoryIds.length>5);
  const release=await f.service.getRelease(actors[0],'dg-base',selection.version);
  const eligible=release.words.filter(w=>selection.categoryIds.includes(w.category)&&selection.difficulties.includes(w.difficulty)&&w.status==='reviewed');
  assert.ok(eligible.length>=1000);
  const persisted=await f.storage.read('rooms',created.view.roomId);
  await f.service.ensureSeed({publishInitial:true});
  assert.deepEqual(await f.storage.read('rooms',created.view.roomId),persisted);
});

test('a live legacy match and a waiting version remain frozen while a clean upgraded new room receives the full expanded default pool',async t=>{
  const f=fixture(t),runtime=createRuntime(readSettings({GAME_ROOM_AUTH_MODE:'mock'}),{storage:f.storage,now:f.now,wordbanks:f.service,drawingEnabled:true,
    roomOptions:{pollIntervalMs:0,serverRandomInt:()=>0},chatOptions:{pollIntervalMs:0}});
  t.after(async()=>{await runtime.canvases.close();await runtime.chat.close();await runtime.rooms.close();});
  await runtime.wordbankReady;await runtime.canvases.ready;await legacySeed(f);
  const ongoing=await runtime.rooms.createRoom(actors[0].userKey,'旧版画者','legacy-live-create','draw-and-guess');
  await runtime.rooms.joinRoom(ongoing.roomCode,actors[1].userKey,'旧版猜者','legacy-live-join');
  const act=async(user,type,fields={})=>{
    const view=await runtime.rooms.getView(ongoing.roomCode,user);
    return runtime.rooms.action(ongoing.roomCode,user,{type,requestId:randomBytes(16).toString('hex'),expectedRevision:view.revision,...fields});
  };
  await act(actors[0].userKey,'ready',{ready:true});await act(actors[1].userKey,'ready',{ready:true});await act(actors[0].userKey,'start');
  const waiting=await runtime.rooms.createRoom(actors[2].userKey,'旧版等待','legacy-wait-create','draw-and-guess');
  const oldLive=await f.storage.read('rooms',ongoing.view.roomId),oldWaiting=await f.storage.read('rooms',waiting.view.roomId);
  const frozen=structuredClone(oldLive.value.snapshot.game.frozenCandidates);
  assert.equal(frozen.length,12);assert.equal(oldLive.value.snapshot.drawConfig.contentSelection.version,1);
  const oldRelease=await f.service.getRelease(actors[0],'dg-base',1);
  const upgraded=await f.reopen().ensureSeed({publishInitial:true});assert.equal(upgraded.publishedHead,2);
  assert.deepEqual(await f.storage.read('rooms',ongoing.view.roomId),oldLive);
  assert.deepEqual(await f.storage.read('rooms',waiting.view.roomId),oldWaiting);
  assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',1),oldRelease);
  const added=await runtime.rooms.createRoom(actors[0].userKey,'新版画者','expanded-after-upgrade','draw-and-guess');
  assert.equal(added.view.drawConfig.contentSelection.version,2);
  const selection=added.view.drawConfig.contentSelection,release=await f.service.getRelease(actors[0],'dg-base',2);
  assert.equal(release.words.length,DRAW_AND_GUESS_SEED.length);
  const eligible=release.words.filter(w=>selection.categoryIds.includes(w.category)&&selection.difficulties.includes(w.difficulty));
  const expected=DRAW_AND_GUESS_SEED.filter(w=>!['friends','screen','idiom-abstract'].includes(w.category)&&['easy','normal'].includes(w.difficulty));
  assert.equal(eligible.length,expected.length);assert.ok(eligible.length>=1000);
  const choose=await runtime.rooms.getView(ongoing.roomCode,actors[0].userKey);
  await act(actors[0].userKey,'choose',{matchId:choose.matchId,turnId:choose.game.turnId,candidateId:choose.game.candidates[0].id});
  assert.deepEqual((await f.storage.get('rooms',ongoing.view.roomId)).snapshot.game.frozenCandidates,frozen);
  await f.verifyQuota();
});

for (const sqlite of [false,true]) {
  test(`${sqlite?'SQLite':'Memory'}: exact 6408 predecessor upgrades current quality content independently without changing old versions`,async t=>{
    const f=fixture(t,{sqlite}),initial=await legacySeed(f,{expanded6408:true});
    assert.equal(initial.words.length,6408);
    const originalSaved=await f.storage.get('wordbank-packs','dg-base');
    assert.equal(originalSaved.seed.hash,'65bd1fd391bb324a1ba84e2777e47e3b439a4a0bed8450c314d160f67d2d58bd');
    await f.change('dg-base',[
      {type:'word.update',id:'dg-base-0001',patch:{answer:'已发布晴雨两用大伞'}},
      {type:'word.retire',id:'dg-base-0002',confirmed:true},
    ]);await f.publish('dg-base');
    const published=await f.service.getRelease(actors[0],'dg-base',2);
    await f.service.retainRelease(actors[0],'dg-base',2,{referenceId:'room-6408-frozen',expiresAt:f.now()+3600000});
    const oldIds=new Set(DRAW_AND_GUESS_PREVIOUS_6408_SEED.map(word=>word.id));
    const additions=DRAW_AND_GUESS_SEED.filter(word=>!oldIds.has(word.id)),addition=additions[0];
    await f.change('dg-base',[
      {type:'word.update',id:'dg-base-0001',patch:{answer:'还没发布的雨伞'}},
      {type:'word.add',id:'partner-400-collision',answer:addition.answer,category:'friends',difficulty:'normal',aliases:[],tags:[]},
    ]);
    const draftBefore=await f.service.get(actors[0],'dg-base');
    const upgraded=await f.reopen().ensureSeed({publishInitial:true});
    assert.equal(upgraded.upgraded,true);assert.equal(upgraded.publishedHead,3);
    assert.equal(upgraded.release.added,additions.length);assert.equal(upgraded.draft.added,additions.length-1);
    assert.equal(upgraded.draft.semanticCollision,1);assert.equal(upgraded.draft.retiredPreserved,1);
    const after=await f.service.get(actors[0],'dg-base'),release=await f.service.getRelease(actors[0],'dg-base',3);
    assert.equal(release.words.length,DRAW_AND_GUESS_SEED.length);assert.equal(after.draft.words.length,DRAW_AND_GUESS_SEED.length);
    assert.equal(release.words.find(w=>w.id==='dg-base-0001').answer,'已发布晴雨两用大伞');
    assert.equal(after.draft.words.find(w=>w.id==='dg-base-0001').answer,'还没发布的雨伞');
    assert.equal(after.draft.words.find(w=>w.id==='partner-400-collision').status,'draft');
    assert.equal(release.words.some(w=>w.id==='partner-400-collision'),false);
    assertProtectedDifficultyMerge(after.draft.words,draftBefore.draft.words.slice(0,6408));
    assertProtectedDifficultyMerge(release.words,published.words);
    assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',1),initial);
    assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',2),published);
    assert.equal((await f.storage.get('wordbank-packs','dg-base')).references[0].version,2);
    const saved=await f.storage.read('wordbank-packs','dg-base'),quota=await f.storage.read('wordbank-index','quota');
    const noWrites=f.wrap(()=>{throw Error('Restart must not write');});
    assert.equal((await noWrites.ensureSeed({publishInitial:true})).imported,false);
    assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),saved);
    assert.deepEqual(await f.storage.read('wordbank-index','quota'),quota);
    // Quality removal intentionally reduces bytes; exact content and quota remain verified.
    await f.verifyQuota();
    const state={packs:(await f.storage.scan('wordbank-packs')).map(r=>r.value),releases:(await f.storage.scan('wordbank-releases')).map(r=>r.value),index:(await f.storage.scan('wordbank-index')).map(r=>r.value)};
    assert.doesNotThrow(()=>validateDrawAndGuessWordbankState(state));
    if (sqlite) {
      const backup=join(f.directory,'400-backup.sqlite'),restored=join(f.directory,'400-restored.sqlite');
      await backupStore({sourcePath:f.storePath,destinationPath:backup,key:f.key,now:f.now});
      restoreStore({sourcePath:backup,destinationPath:restored,key:f.key,offline:true});
      const storage=new EncryptedStore(new SQLiteAdapter(restored,{now:f.now}),f.key,f.now);t.after(()=>storage.close());
      const reopened=createDrawAndGuessWordbank({storage,now:f.now});
      assert.deepEqual(await reopened.get(actors[0],'dg-base'),after);
      assert.deepEqual(await reopened.getRelease(actors[0],'dg-base',2),published);
      assert.equal((await reopened.ensureSeed({publishInitial:true})).imported,false);
    }
  });
}
test('6408 upgrade rejects unknown source hashes and failed transactions with zero partial additions',async t=>{
  const f=fixture(t);await legacySeed(f,{expanded6408:true});
  const before=await f.storage.read('wordbank-packs','dg-base'),quota=await f.storage.read('wordbank-index','quota');
  await assert.rejects(f.wrap(()=>false).ensureSeed({publishInitial:true}),code('CONTENT_BUSY'));
  assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),before);
  assert.deepEqual(await f.storage.read('wordbank-index','quota'),quota);
  const unknown=structuredClone(before.value);unknown.seed.hash='f'.repeat(64);
  await f.storage.put('wordbank-packs','dg-base',unknown);
  const unknownSaved=await f.storage.read('wordbank-packs','dg-base');
  await assert.rejects(f.service.ensureSeed({publishInitial:true}),code('SEED_VERSION_UNKNOWN'));
  assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),unknownSaved);
  assert.equal(await f.storage.get('wordbank-releases','dg-base:2'),null);
});

for(const sqlite of [false,true])test(`${sqlite?'SQLite':'Memory'}: approved common difficulty upgrade protects full member definitions and merges draft/publication independently`,async t=>{
  const f=fixture(t,{sqlite}),initial=await legacySeed(f,{expanded14400:true});
  assert.equal((await f.storage.get('wordbank-packs','dg-base')).seed.hash,'50d838083e330dda763175023669168fce483b383ea0704f9ca9c65c46031554');
  const previous=new Map(DRAW_AND_GUESS_PREVIOUS_14400_SEED.map(word=>[word.id,word]));
  const demoted=DRAW_AND_GUESS_SEED.filter(word=>word.difficulty==='hard'&&previous.get(word.id).difficulty!=='hard');
  const promoted=DRAW_AND_GUESS_SEED.find(word=>word.difficulty==='normal'&&previous.get(word.id).difficulty==='hard');
  assert.ok(demoted.length>1000);assert.ok(promoted);
  await f.change('dg-base',[
    {type:'word.update',id:demoted[0].id,patch:{answer:'会员发布的独有词条'}},
    {type:'word.update',id:demoted[1].id,patch:{aliases:[...demoted[1].aliases,'会员发布的独有别名']}},
    {type:'word.update',id:demoted[2].id,patch:{tags:['会员独有标签']}},
    {type:'word.update',id:demoted[3].id,patch:{category:'friends'}},
    {type:'word.update',id:demoted[4].id,patch:{difficulty:'easy'}},
    {type:'word.retire',id:demoted[5].id,confirmed:true},
    {type:'word.add',id:'quality-member-published',answer:'会员发布的小纸灯',category:'friends',difficulty:'normal',aliases:[],tags:[]},
  ]);await f.publish('dg-base');
  const published=await f.service.getRelease(actors[0],'dg-base',2),oldRecords=await Promise.all([1,2].map(version=>f.storage.read('wordbank-releases',`dg-base:${version}`)));
  await f.change('dg-base',[
    {type:'word.update',id:demoted[0].id,patch:{answer:'会员尚未发布的独有词条'}},
    {type:'word.update',id:demoted[6].id,patch:{tags:['尚未发布的标签']}},
    {type:'word.add',id:'quality-member-draft',answer:'会员尚未发布的小风车',category:'friends',difficulty:'normal',aliases:[],tags:[]},
  ]);
  const draftBefore=await f.service.get(actors[0],'dg-base'),result=await f.reopen().ensureSeed({publishInitial:true});
  assert.equal(result.upgraded,true);assert.equal(result.publishedHead,3);assert.equal(result.draft.added,0);assert.equal(result.release.added,0);
  assert.ok(result.draft.difficultyUpdated>1000);assert.ok(result.release.difficultyUpdated>1000);
  const after=await f.service.get(actors[0],'dg-base'),release=await f.service.getRelease(actors[0],'dg-base',3);
  assert.equal(after.draft.words.length,DRAW_AND_GUESS_SEED.length+2);assert.equal(release.words.length,DRAW_AND_GUESS_SEED.length+1);
  assertProtectedDifficultyMerge(after.draft.words,draftBefore.draft.words);assertProtectedDifficultyMerge(release.words,published.words);
  assert.equal(after.draft.words.find(word=>word.id===demoted[0].id).answer,'会员尚未发布的独有词条');
  assert.equal(release.words.find(word=>word.id===demoted[0].id).answer,'会员发布的独有词条');
  assert.equal(release.words.find(word=>word.id===demoted[6].id).difficulty,'hard');
  assert.equal(after.draft.words.find(word=>word.id===demoted[6].id).status,'draft');
  assert.equal(release.words.some(word=>word.id==='quality-member-draft'),false);
  assert.equal(after.draft.words.find(word=>word.id==='quality-member-draft').status,'draft');
  for(const value of [after.draft,release])assert.equal(value.words.find(word=>word.id===promoted.id).difficulty,'normal');
  assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',1),initial);assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',2),published);
  for(const [index,saved]of oldRecords.entries())assert.deepEqual(await f.storage.read('wordbank-releases',`dg-base:${index+1}`),saved);
  const pack=await f.storage.read('wordbank-packs','dg-base'),quota=await f.storage.read('wordbank-index','quota');
  assert.equal((await f.wrap(()=>{throw Error('quality restart must not write');}).ensureSeed({publishInitial:true})).imported,false);
  assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),pack);assert.deepEqual(await f.storage.read('wordbank-index','quota'),quota);await f.verifyQuota();
  if(sqlite) {
    const backup=join(f.directory,'quality.sqlite'),restored=join(f.directory,'quality-restored.sqlite');
    await backupStore({sourcePath:f.storePath,destinationPath:backup,key:f.key,now:f.now});restoreStore({sourcePath:backup,destinationPath:restored,key:f.key,offline:true});
    const child=`import{EncryptedStore,SQLiteAdapter}from'./server/storage.mjs';import{createDrawAndGuessWordbank}from'./server/content/draw-and-guess-wordbank.mjs';
      const[path,key,actor]=process.argv.slice(1),now=()=>1791300000000,storage=new EncryptedStore(new SQLiteAdapter(path,{now}),Buffer.from(key,'base64url'),now);
      const service=createDrawAndGuessWordbank({storage,now});await service.ensureSeed({publishInitial:true});
      process.stdout.write(JSON.stringify({pack:await service.get(JSON.parse(actor),'dg-base'),release:await service.getRelease(JSON.parse(actor),'dg-base',3)}));storage.close();`;
    const recovered=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',child,restored,f.key.toString('base64url'),JSON.stringify(actors[0])],{cwd:process.cwd(),encoding:'utf8',maxBuffer:16*1024*1024}));
    // JSON transport preserves content, not the summarizer's null prototypes.
    assert.deepEqual(recovered.pack,JSON.parse(JSON.stringify(after)));assert.deepEqual(recovered.release,release);
  }
});

test('known 14400 quality source rejects unknown hashes and failed CAS without partial difficulty changes',async t=>{
  const f=fixture(t);await legacySeed(f,{expanded14400:true});
  const before=await f.storage.read('wordbank-packs','dg-base'),quota=await f.storage.read('wordbank-index','quota'),release=await f.storage.read('wordbank-releases','dg-base:1');
  await assert.rejects(f.wrap(()=>false).ensureSeed({publishInitial:true}),code('CONTENT_BUSY'));
  assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),before);assert.deepEqual(await f.storage.read('wordbank-index','quota'),quota);
  assert.deepEqual(await f.storage.read('wordbank-releases','dg-base:1'),release);assert.equal(await f.storage.get('wordbank-releases','dg-base:2'),null);
  const unknown=structuredClone(before.value);unknown.seed.hash='f'.repeat(64);await f.storage.put('wordbank-packs','dg-base',unknown);
  const saved=await f.storage.read('wordbank-packs','dg-base');await assert.rejects(f.service.ensureSeed({publishInitial:true}),code('SEED_VERSION_UNKNOWN'));
  assert.deepEqual(await f.storage.read('wordbank-packs','dg-base'),saved);assert.equal(await f.storage.get('wordbank-releases','dg-base:2'),null);
});

test('quality upgrade preserves a real waiting version and an active frozen normal word that is now a challenge',async t=>{
  const f=fixture(t);await legacySeed(f,{expanded14400:true});
  const [{createDurableRoomStore},{createDrawingContentAssembly}]=await Promise.all([import('../server/durable-rooms.mjs'),import('../server/games/draw-and-guess/content-assembly.mjs')]);
  const home=DRAW_AND_GUESS_PREVIOUS_14400_SEED.filter(word=>word.category==='home'&&['easy','normal'].includes(word.difficulty)),
    target=home.findIndex(word=>word.answer==='真空压缩收纳袋');assert.ok(target>=0);let samples=0;
  const assembly=createDrawingContentAssembly({wordbanks:f.service,ready:Promise.resolve(),enabled:true,now:f.now,serverRandomInt:()=>samples++===0?target:0});
  const rooms=createDurableRoomStore({storage:f.storage,now:f.now,...assembly,pollIntervalMs:0,serverRandomInt:()=>0});t.after(()=>rooms.close());
  const created=await rooms.createRoom(actors[0].userKey,'旧画者','quality-live-room','draw-and-guess'),roomCode=created.roomCode;
  await rooms.joinRoom(roomCode,actors[1].userKey,'旧猜者','quality-live-peer');
  const action=async(user,type,extra={})=>rooms.action(roomCode,user,{type,requestId:randomBytes(16).toString('hex'),expectedRevision:(await rooms.getView(roomCode,user)).revision,...extra});
  await action(actors[0].userKey,'configure',{drawConfig:{...(await rooms.getView(roomCode,actors[0].userKey)).drawConfig,rounds:1,candidateCount:5,
    contentSelection:{packId:'dg-base',version:1,categoryIds:['home'],difficulties:['easy','normal']}}});
  for(const actor of actors.slice(0,2))await action(actor.userKey,'ready',{ready:true});await action(actors[0].userKey,'start');
  const choice=await rooms.getView(roomCode,actors[0].userKey);assert.equal(choice.game.candidates[0].answer,'真空压缩收纳袋');
  await action(actors[0].userKey,'choose',{matchId:choice.matchId,turnId:choice.game.turnId,candidateId:choice.game.candidates[0].id});
  const waiting=await rooms.createRoom(actors[2].userKey,'旧等待者','quality-waiting-room','draw-and-guess');
  const frozen=await f.storage.read('rooms',created.view.roomId),wait=await f.storage.read('rooms',waiting.view.roomId),oldRelease=await f.storage.read('wordbank-releases','dg-base:1');
  assert.equal((await f.service.ensureSeed({publishInitial:true})).publishedHead,2);
  assert.deepEqual(await f.storage.read('rooms',created.view.roomId),frozen);assert.deepEqual(await f.storage.read('rooms',waiting.view.roomId),wait);
  assert.deepEqual(await f.storage.read('wordbank-releases','dg-base:1'),oldRelease);
  const resumed=await rooms.getView(roomCode,actors[0].userKey);assert.equal(resumed.game.word.answer,'真空压缩收纳袋');
  assert.equal(resumed.game.word.difficulty,'normal');assert.equal((await rooms.getView(waiting.roomCode,actors[2].userKey)).drawConfig.contentSelection.version,1);
  const fresh=await rooms.createRoom(actors[1].userKey,'新等待者','quality-new-room','draw-and-guess'),selection=fresh.view.drawConfig.contentSelection;
  assert.equal(selection.version,2);const release=await f.service.getRelease(actors[1],'dg-base',2),word=release.words.find(word=>word.answer==='真空压缩收纳袋');
  assert.equal(word,undefined,'the awkward answer is replaced, not merely moved to hard');await f.verifyQuota();
});

for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'Memory'}: shipped classified seed replaces and removes rejected system words while preserving member content`, async t => {
  const f = fixture(t, { sqlite }), old = await legacySeed(f, { classified14400: true });
  const previous = new Map(DRAW_AND_GUESS_PREVIOUS_CLASSIFIED_SEED.map(word => [word.id, word]));
  const replacements = DRAW_AND_GUESS_SEED.filter(word => word.answer !== previous.get(word.id).answer);
  assert.ok(replacements.length >= 10, 'a difficulty-only update is not a content replacement');
  const [edited, retired, conflict, pending, untouched] = replacements;
  const [removeEdited,removeRetired,removePending,removeUntouched]=DRAW_AND_GUESS_QUALITY_REMOVALS;
  assert.ok(removeUntouched);
  await f.change('dg-base', [
    { type: 'word.update', id: edited.id, patch: { answer: '朋友保存的独有词目', aliases: ['朋友独有别名'] } },
    { type: 'word.retire', id: retired.id, confirmed: true },
    { type: 'word.add', id: 'member-replacement-alias', answer: '朋友自己添加的题目', aliases: [conflict.answer], category: 'friends', difficulty: 'normal', tags: [] },
    { type: 'category.rename', id: 'home', name: '朋友自定的居家类' },
    { type: 'word.update', id: removeEdited.id, patch: { answer: '朋友改好的独立题目' } },
    { type: 'word.retire', id: removeRetired.id, confirmed: true },
  ]);
  await f.publish('dg-base');
  const memberPublication = await f.service.getRelease(actors[0], 'dg-base', 2);
  await f.change('dg-base', [
    { type: 'word.update', id: pending.id, patch: { tags: ['仅草稿修改'] } },
    { type: 'word.update', id: removePending.id, patch: { answer: '只在草稿里的朋友新词' } },
  ]);
  const before = await f.service.get(actors[0], 'dg-base');
  const privatePack = await f.create(actors[1], 'private');
  const privateBefore = await f.service.get(actors[1], privatePack.packId);
  const result = await f.reopen().ensureSeed({ publishInitial: true });
  const after = await f.service.get(actors[0], 'dg-base'), release = await f.service.getRelease(actors[0], 'dg-base', 3);
  assert.equal(after.draft.words.length,DRAW_AND_GUESS_SEED.length+4); assert.equal(release.words.length,DRAW_AND_GUESS_SEED.length+3);
  assert.equal(result.draft.removed,DRAW_AND_GUESS_QUALITY_REMOVALS.length-3);
  assert.equal(result.release.removed,DRAW_AND_GUESS_QUALITY_REMOVALS.length-2);
  assert.equal(after.draft.words.some(word=>word.id===removeUntouched.id),false);
  assert.equal(release.words.some(word=>word.id===removePending.id),false);
  for(const id of [removeEdited.id,removeRetired.id,removePending.id])assert.deepEqual(after.draft.words.find(word=>word.id===id),before.draft.words.find(word=>word.id===id));
  for(const id of [removeEdited.id,removeRetired.id])assert.deepEqual(release.words.find(word=>word.id===id),memberPublication.words.find(word=>word.id===id));
  assert.equal(result.draft.replacementConflicts, 1); assert.equal(result.release.replacementConflicts, 1);
  assert.equal(result.draft.replaced, replacements.length - 4);
  assert.equal(result.release.replaced, replacements.length - 3);
  for (const id of [edited.id, retired.id, pending.id, conflict.id, 'member-replacement-alias'])
    assert.deepEqual(after.draft.words.find(word => word.id === id), before.draft.words.find(word => word.id === id), id);
  assert.deepEqual(after.draft.words.find(word => word.id === untouched.id), untouched);
  assert.deepEqual(release.words.find(word => word.id === pending.id), pending);
  assert.equal(after.draft.categories.find(category => category.id === 'home').name, '朋友自定的居家类');
  assert.deepEqual(await f.service.getRelease(actors[0], 'dg-base', 1), old);
  assert.deepEqual(await f.service.getRelease(actors[0], 'dg-base', 2), memberPublication);
  assert.deepEqual(await f.service.get(actors[1], privatePack.packId), privateBefore);
  assert.equal((await f.wrap(() => { throw Error('repeat must not write'); }).ensureSeed({ publishInitial: true })).imported, false);
  await f.verifyQuota();
});

// Default selection is immutable release metadata, not a room-wide toggle.
for (const sqlite of [false, true]) test(`${sqlite ? 'SQLite' : 'Memory'}: category defaults publish explicitly and preserve old rooms and release contents`, async t => {
  const {defaultDrawingCategoryIds} = await import('./games/draw-and-guess/content-defaults.mjs');
  const f=fixture(t,{sqlite});await f.service.ensureSeed({publishInitial:true});
  const oldRelease=await f.service.getRelease(actors[0],'dg-base',1);
  const [{createDurableRoomStore},{createDrawingContentAssembly}]=await Promise.all([import('../server/durable-rooms.mjs'),import('../server/games/draw-and-guess/content-assembly.mjs')]);
  const assembly=createDrawingContentAssembly({wordbanks:f.service,ready:Promise.resolve(),enabled:true,now:f.now,serverRandomInt:()=>0});
  const rooms=createDurableRoomStore({storage:f.storage,now:f.now,...assembly,pollIntervalMs:0,serverRandomInt:()=>0});t.after(()=>rooms.close());
  const waiting=await rooms.createRoom(actors[0].userKey,'原房间','default-original-room','draw-and-guess');
  const oldRoom=await f.storage.read('rooms',waiting.view.roomId);
  const revision=(await f.service.get(actors[0],'dg-base')).draftRevision;
  await assert.rejects(f.change('dg-base',[{type:'category.default',id:'screen',selected:'yes'}]),code('CATEGORY_DEFAULT'));
  assert.equal((await f.service.get(actors[0],'dg-base')).draftRevision,revision);
  await f.change('dg-base',[{type:'category.default',id:'daily',selected:false},{type:'category.default',id:'screen',selected:true},{type:'category.default',id:'idiom-abstract',selected:true}]);
  assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',1),oldRelease);
  assert.equal((await f.service.get(actors[0],'dg-base')).publishedHead,1);
  await f.publish('dg-base');const release=await f.service.getRelease(actors[0],'dg-base',2);
  assert.deepEqual(release.words,oldRelease.words);assert.deepEqual(await f.service.getRelease(actors[0],'dg-base',1),oldRelease);
  const selected=defaultDrawingCategoryIds(release.categories);assert.ok(selected.includes('screen'));assert.ok(selected.includes('idiom-abstract'));assert.ok(!selected.includes('daily'));
  const fresh=await rooms.createRoom(actors[1].userKey,'新房间','default-new-room','draw-and-guess');
  assert.equal(fresh.view.drawConfig.contentSelection.version,2);assert.deepEqual(fresh.view.drawConfig.contentSelection.categoryIds,selected);
  assert.deepEqual(await f.storage.read('rooms',waiting.view.roomId),oldRoom);
  validateDrawAndGuessWordbankSnapshot('wordbank-packs',await f.storage.get('wordbank-packs','dg-base'));
  validateDrawAndGuessWordbankSnapshot('wordbank-releases',await f.storage.get('wordbank-releases','dg-base:2'));
  const active=release.categories.filter(c=>c.status==='active');await f.change('dg-base',active.map(c=>({type:'category.default',id:c.id,selected:false})));
  const current=await f.service.get(actors[0],'dg-base'),preview=await f.service.preview(actors[0],'dg-base',{expectedDraftRevision:current.draftRevision,expectedPublishedHead:2});
  assert.ok(preview.report.errors.some(e=>e.code==='empty-default-categories'));
  await assert.rejects(f.publish('dg-base'),code('CONTENT_INVALID'));
  assert.equal((await f.service.get(actors[0],'dg-base')).publishedHead,2);await f.verifyQuota();
});
