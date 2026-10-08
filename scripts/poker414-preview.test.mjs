import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get } from 'node:http';
import { startPoker414Preview } from './poker414-preview.mjs';

async function withPreview(run) {
  const preview = await startPoker414Preview({ port: 0 });
  try { await run(preview); } finally { await preview.close(); }
}
function post(origin, body, headers = {}) {
  return fetch(`${origin}/api/rooms/414000/chat`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('本机小样仅监听IPv4 loopback，首页明确合成，白名单阻止私有模块', async () => {
  await withPreview(async ({ server, origin }) => {
    assert.equal(server.address().address, '127.0.0.1');
    const root = await fetch(`${origin}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /全部身份、房号、牌局、聊天及分数均为合成数据/);
    const style = await fetch(`${origin}/styles.css`);
    assert.equal(style.status, 200);
    assert.match(style.headers.get('content-type'), /text\/css/);
    assert.equal(style.headers.get('cache-control'), 'no-store');
    for (const path of ['/server/config.mjs', '/games/poker414-2/rules.mjs', '/ops/harness.json', '/rooms.mjs', '/.env']) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
    }
    const wrongHostStatus = await new Promise((accept, reject) => {
      get(`${origin}/`, { headers: { Host: 'example.test' } }, response => {
        response.resume(); accept(response.statusCode);
      }).once('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
  });
});

test('聊天沿当前协议读取、分页、发送并以原请求编号确认同一条消息', async () => {
  await withPreview(async ({ origin }) => {
    const initial = await (await fetch(`${origin}/api/rooms/414000/chat?limit=1`)).json();
    assert.equal(initial.roomId, '414-preview-room');
    assert.equal(initial.messages.length, 1);
    assert.equal(initial.hasMore, true);
    const body = { text: '这是我的示范消息', requestId: 'preview-test-001' };
    const sent = await (await post(origin, body)).json();
    assert.equal(sent.message.playerId, 'preview-self');
    assert.equal(sent.message.requestId, body.requestId);
    assert.equal(sent.message.text, body.text);
    assert.deepEqual(await (await post(origin, body)).json(), sent);
    const after = await (await fetch(`${origin}/api/rooms/414000/chat?after=2`)).json();
    assert.deepEqual(after.messages, [sent.message]);
    const before = await (await fetch(`${origin}/api/rooms/414000/chat?before=3`)).json();
    assert.equal(before.messages.length, 2);
    assert.equal((await post(origin, { ...body, text: '另一条内容' })).status, 409);
    const all = await (await fetch(`${origin}/api/rooms/414000/chat`)).json();
    assert.equal(all.messages.length, 3);
  });
});

test('聊天拒绝跨来源、非JSON、未知字段及非法游标', async () => {
  await withPreview(async ({ origin }) => {
    const body = { text: '示范', requestId: 'preview-test-002' };
    assert.equal((await post(origin, body, { Origin: 'https://example.test' })).status, 403);
    assert.equal((await post(origin, body, { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await post(origin, { ...body, playerId: 'another-seat' })).status, 400);
    assert.equal((await post(origin, '{')).status, 400);
    for (const query of ['limit=101', 'after=0&before=1', 'limit=1&limit=2', 'token=secret', 'after=-1']) {
      assert.equal((await fetch(`${origin}/api/rooms/414000/chat?${query}`)).status, 400, query);
    }
    assert.equal((await fetch(`${origin}/api/rooms/123456/chat`)).status, 404);
  });
});

test('消息长度、换行和字节上限沿用真实校验，超大正文保留可读错误', async () => {
  await withPreview(async ({ origin }) => {
    for (const text of [' ', '字'.repeat(501), 'a\nb\nc\nd', 'a\u0000b']) {
      assert.equal((await post(origin, { text, requestId: 'preview-test-003' })).status, 400);
    }
    assert.equal((await post(origin, { text: '字'.repeat(500), requestId: 'preview-test-004' })).status, 200);
    const oversized = await post(origin, { text: 'a'.repeat(5000), requestId: 'preview-test-005' });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).message, /过大/);
  });
});

test('每个本机进程的聊天相互独立，不从正式账号或已有预览恢复', async () => {
  await withPreview(async ({ origin }) => {
    await post(origin, { text: '只属于一个实例', requestId: 'preview-test-006' });
    await withPreview(async ({ origin: second }) => {
      const packet = await (await fetch(`${second}/api/rooms/414000/chat`)).json();
      assert.equal(packet.messages.length, 2);
      assert.equal(packet.messages.some(message => message.text === '只属于一个实例'), false);
    });
  });
});

test('模拟伙伴和本人消息共享唯一序号，模拟端点不能指定身份或跨来源写入', async () => {
  await withPreview(async ({ origin }) => {
    const peer = (body, headers = {}) => fetch(`${origin}/api/rooms/414000/preview-message`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const received = await (await peer({ text: '你先出，我看着。' })).json();
    assert.equal(received.message.playerId, 'preview-friend-1');
    assert.equal(received.message.name, '示范伙伴1');
    assert.equal(Object.hasOwn(received.message, 'requestId'), false);
    assert.equal(received.message.chatSequence, 3);
    const sent = await (await post(origin, { text: '好！', requestId: 'preview-after-peer' })).json();
    assert.equal(sent.message.chatSequence, 4);
    assert.notEqual(received.message.messageId, sent.message.messageId);
    const history = await (await fetch(`${origin}/api/rooms/414000/chat?after=2`)).json();
    assert.deepEqual(history.messages, [received.message, sent.message]);
    for (const body of [{ text: '冒名', playerId: 'preview-self' }, { text: '冒名', name: '别人' },
      { text: '冒名', requestId: 'preview-after-peer' }, { text: '乱序', chatSequence: 4 }, { text: '' }]) {
      assert.equal((await peer(body)).status, 400);
    }
    assert.equal((await peer({ text: '跨站' }, { Origin: 'https://example.test' })).status, 403);
    assert.equal((await peer({ text: '类型' }, { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await fetch(`${origin}/api/rooms/414000/preview-message`)).status, 405);
    assert.equal((await fetch(`${origin}/server/chat.mjs`)).status, 404);
  });
});

test('拒绝非法端口和production启动，不创建正式服务', async () => {
  for (const port of [-1, 65536, 3.2, '4371']) await assert.rejects(startPoker414Preview({ port }), /端口/);
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(startPoker414Preview({ port: 0 }), /production/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
