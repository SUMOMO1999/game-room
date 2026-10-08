import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSettings } from '../server/config.mjs';
import { readIdentityBatchKey, createIdentityBatchRuntime } from '../server/identity-batch-runtime.mjs';

const base = { GAME_ROOM_AUTH_MODE: 'cognito', GAME_ROOM_CLIENT_ID: 'ownclient12345678' };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'identity-batch-settings-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'signing-key.pem');
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const env = { ...base, GAME_ROOM_IDENTITY_BATCH_ENABLED: '1',
    GAME_ROOM_IDENTITY_BATCH_KEY_ID: 'game-room-test-v1', GAME_ROOM_IDENTITY_BATCH_KEY_FILE: file };
  return { directory, file, env };
}

test('identity batching remains explicitly disabled without reading or transmitting a signing credential', () => {
  const settings = readSettings({ ...base, GAME_ROOM_IDENTITY_BATCH_KEY_FILE: '/nonexistent/private-key' });
  assert.equal(settings.identityBatchEnabled, false);
  assert.equal(Object.hasOwn(settings, 'identityBatchKeyFile'), false);
  assert.equal(createIdentityBatchRuntime(settings), null);
});

test('batch startup accepts only explicit Cognito mode, frozen caller identifiers and an absolute file', t => {
  const f = fixture(t);
  for (const change of [{ GAME_ROOM_IDENTITY_BATCH_ENABLED: 'true' }, { GAME_ROOM_AUTH_MODE: 'mock' },
    { GAME_ROOM_IDENTITY_BATCH_KEY_ID: '' }, { GAME_ROOM_IDENTITY_BATCH_KEY_ID: 'Uppercase' },
    { GAME_ROOM_IDENTITY_BATCH_KEY_ID: 'g'.repeat(65) }, { GAME_ROOM_IDENTITY_BATCH_KEY_FILE: 'relative.pem' }]) {
    assert.throws(() => readSettings({ ...f.env, ...change }));
  }
  const settings = readSettings(f.env);
  assert.equal(settings.identityBatchEnabled, true);
  assert.equal(readIdentityBatchKey(settings, {}).asymmetricKeyType, 'ed25519');
});

test('startup refuses exposed, linked, oversized, non-private or wrong-algorithm key files', t => {
  const f = fixture(t), settings = readSettings(f.env);
  const rejected = () => assert.throws(() => readIdentityBatchKey(settings, {}), /owned private Ed25519/);
  chmodSync(f.file, 0o644); rejected(); chmodSync(f.file, 0o600);
  const link = join(f.directory, 'linked.pem'); symlinkSync(f.file, link);
  assert.throws(() => readIdentityBatchKey({ ...settings, identityBatchKeyFile: link }, {}));
  assert.throws(() => readIdentityBatchKey({ ...settings, identityBatchKeyFile: f.directory }, {}));
  writeFileSync(f.file, 'x'.repeat(2049)); rejected();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(f.file, privateKey.export({ format: 'pem', type: 'pkcs8' })); rejected();
  writeFileSync(f.file, publicKey.export({ format: 'pem', type: 'spki' })); rejected();
});

test('a valid owned batch runtime composes the real provider and closes its transport without network work', async t => {
  const f = fixture(t), runtime = createIdentityBatchRuntime(readSettings(f.env), { env: {} });
  assert.equal(runtime.provider.usesBatchIdentity, true);
  assert.equal(runtime.provider.policyClient.occupancy.logicalWaiters, 0);
  await runtime.close(); await runtime.close();
});
