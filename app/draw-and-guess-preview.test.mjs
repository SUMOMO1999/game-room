import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDrawingPreview } from '../tools/draw-and-guess-step0/preview-server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'drawing-preview-review-'));
  const preview = await createDrawingPreview({ directory });
  t.after(async () => { await preview.close(); await rm(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    preview.server.once('error', reject);
    preview.server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${preview.server.address().port}`;
  const json = async (path, body, headers = {}) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, value: await response.json(), headers: response.headers };
  };
  return { ...preview, directory, origin, json };
}

async function addWord(system, bank, text) {
  const input = { expectedRevision: bank.revision, category: bank.categories[0].id, difficulty: 'normal', lines: text };
  const preview = await system.json('/lab/words/preview', input);
  assert.equal(preview.status, 200, JSON.stringify(preview.value));
  const saved = await system.json('/lab/words/save', input);
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  return saved.value;
}

test('drawing Step 0 serves a clearly isolated page and no production routes or private source files', async t => {
  const system = await fixture(t);
  for (const path of ['/start', '/paint', '/wordbank']) {
    const response = await fetch(system.origin + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await response.text();
    assert.match(html, /本机操作样板/);
    assert.match(html, /虚构成员/);
    assert.match(html, /服务重启会重置/);
  }
  for (const path of ['/api/state', '/api/rooms', '/auth/login', '/server/storage.mjs', '/server/content/draw-and-guess-seed.mjs', '/preview-server.mjs']) {
    const response = await fetch(system.origin + path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('set-cookie'), null, path);
    await response.arrayBuffer();
  }
  const bank = await system.json('/lab/words');
  assert.equal(bank.value.prototype, true);
  assert.equal(bank.value.persistence, 'memory-reset-on-server-restart');
  assert.ok(bank.value.words.length >= 560);
});

test('Step 0 rejects foreign Origin, absent Origin and foreign Host before wordbank mutation', async t => {
  const system = await fixture(t), before = (await system.json('/lab/words')).value;
  const input = { expectedRevision: before.revision, name: '原型审查新增分类' };
  for (const origin of ['https://example.test', 'null', '']) {
    const result = await system.json('/lab/words/category', input, { origin });
    assert.equal(result.status, 403);
  }
  const status = await new Promise((resolve, reject) => {
    const request = http.get(system.origin + '/lab/words', { headers: { host: 'foreign.example.test' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(status, 403);
  const after = (await system.json('/lab/words')).value;
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.categories, before.categories);
});

test('wordbank stale revision and conflicting batch leave the complete sample untouched', async t => {
  const system = await fixture(t), before = (await system.json('/lab/words')).value;
  const bank = await addWord(system, before, '隔离画笔试验道具');
  const stale = await system.json('/lab/words/save', {
    expectedRevision: before.revision, category: before.categories[0].id, difficulty: 'normal', lines: '不会偷偷加入的词',
  });
  assert.equal(stale.status, 409);
  const duplicate = await system.json('/lab/words/save', {
    expectedRevision: bank.revision, category: bank.categories[0].id, difficulty: 'normal',
    lines: `${bank.words[0].answer}\n整批拒绝不保存的词`,
  });
  assert.equal(duplicate.status, 422);
  assert.equal(duplicate.value.report.valid, false);
  const after = (await system.json('/lab/words')).value;
  assert.equal(after.revision, bank.revision);
  assert.deepEqual(after.words, bank.words);
});

test('sample version restore guards newer unpublished edits and never erases immutable saved versions', async t => {
  const system = await fixture(t), initial = (await system.json('/lab/words')).value;
  const first = await addWord(system, initial, '版本保留试验道具');
  const published = await system.json('/lab/words/publish', { expectedRevision: first.revision });
  assert.equal(published.status, 200);
  const second = await addWord(system, published.value, '尚未发布的伙伴词条');
  const stale = await system.json('/lab/words/restore', { expectedRevision: published.value.revision, versionId: initial.versions[0].id });
  assert.equal(stale.status, 409);
  assert.deepEqual((await system.json('/lab/words')).value.words, second.words);
  const restored = await system.json('/lab/words/restore', { expectedRevision: second.revision, versionId: initial.versions[0].id });
  assert.equal(restored.status, 200);
  assert.ok(restored.value.revision > second.revision);
  assert.deepEqual(restored.value.words, initial.words);
  assert.deepEqual(restored.value.versions, published.value.versions);
});

test('real split HTTP UTF-8 input saves the same visible Chinese answer without replacement characters', async t => {
  const system = await fixture(t), initial = (await system.json('/lab/words')).value;
  const answer = '分块中文试验道具';
  const bytes = Buffer.from(JSON.stringify({ expectedRevision: initial.revision, category: initial.categories[0].id, difficulty: 'normal', lines: answer }));
  const cut = bytes.indexOf(Buffer.from(answer)) + 1;
  const result = await new Promise((resolve, reject) => {
    const request = http.request(system.origin + '/lab/words/save', {
      method: 'POST', headers: { origin: system.origin, 'content-type': 'application/json', 'content-length': bytes.length },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.write(bytes.subarray(0, cut));
    setTimeout(() => request.end(bytes.subarray(cut)), 15);
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.words.at(-1).answer, answer);
  assert.equal(result.value.words.some(word => word.answer.includes('\uFFFD')), false);
});

test('preview canvas confirms two batches of one stroke, undoes the whole stroke, and fences old writers', async t => {
  const system = await fixture(t);
  const acquired = await system.json('/lab/acquire?labUser=drawer', { deviceId: 'preview-device-a' });
  assert.equal(acquired.status, 200);
  const input = {
    deviceId: 'preview-device-a', leaseGeneration: acquired.value.leaseGeneration, clearGeneration: 0,
    expectedSequence: 0, requestId: 'preview-first',
    operations: [{ strokeId: 'preview-device-a-stroke-1', tool: 'pen', color: '#ed2634', width: 10, points: [[0.1, 0.1], [0.2, 0.2]] }],
  };
  assert.equal((await system.json('/lab/append?labUser=drawer', input)).status, 200);
  assert.equal((await system.json('/lab/append?labUser=drawer', {
    ...input, expectedSequence: 1, requestId: 'preview-second',
    operations: [{ ...input.operations[0], points: [[0.3, 0.3], [0.4, 0.4]] }],
  })).status, 200);
  const read = await system.json('/lab/read?labUser=spectator-1');
  assert.equal(read.value.strokes.length, 1);
  assert.equal(read.value.pointCount, 4);
  assert.equal((await system.json('/lab/undo?labUser=drawer', { ...input, operations: undefined, expectedSequence: 2, requestId: 'preview-undo' })).status, 200);
  assert.equal((await system.json('/lab/read?labUser=guesser-1')).value.pointCount, 0);
  assert.equal((await system.json('/lab/acquire?labUser=drawer', { deviceId: 'preview-device-b' })).status, 200);
  assert.equal((await system.json('/lab/append?labUser=drawer', { ...input, expectedSequence: 3, requestId: 'preview-old-device' })).status, 409);
  assert.equal((await system.json('/lab/append?labUser=spectator-1', input)).status, 403);
  assert.equal((await system.json('/lab/read?labUser=not-a-member')).status, 401);
});
