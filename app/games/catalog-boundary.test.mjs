import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPresentationCatalog, gamePresentations, gamePresentation } from './catalog.mjs';
import { gameInfo, gameAdapter } from '../game-registry.mjs';
import { gameDetails, roomHref } from '../game-routing.mjs';
import { publicAssetPaths } from '../../server/public-assets.mjs';
import { buildRelease, releaseSources } from '../../scripts/build-release.mjs';
import { createServer } from '../server.mjs';
import { readSettings } from '../../server/config.mjs';
import { createRuntime } from '../../server/runtime.mjs';
import { createUnifiedServer } from '../../server/unified-http.mjs';
import { MockProvider } from '../../server/auth.mjs';
import { EncryptedStore, MemoryAdapter } from '../../server/storage.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const privatePaths = ['server/games/rummikub/adapter.mjs', 'server/games/army-flip/adapter.mjs',
  'games/rummikub/multiplayer.mjs', 'games/army-flip/rules.mjs', 'multiplayer-rules.mjs',
  'army-rules.mjs', 'rooms.mjs', 'game-registry.mjs', 'games/catalog-boundary.test.mjs',
  'games/rummikub/test-support/secret.mjs', 'games/rummikub/fixtures/secret.mjs',
  'infra/game-room-identity-batch.conf'];
// 414 is a local-only candidate until its authenticated room adapter is wired.
const unreleased414Paths = ['poker414-preview.html', ...['cards.mjs','art.mjs','rules.mjs','patterns.mjs','page-ui.mjs','preview.mjs','styles.css','test-support/preview-fixtures.mjs'].map(file => `games/poker414-2/${file}`)];
function metadataOnly(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(metadataOnly);
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(metadataOnly);
}

test('browser game catalog contains only immutable presentation metadata matching server types, routes and capacities', () => {
  const source = readFileSync(join(projectRoot, 'app/games/catalog.mjs'), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/\bimport\s*(?:\(|[{*'"\w])/.test(source), false, 'catalog must not import an executable game module');
  const allowed = ['gameType', 'name', 'page', 'minPlayers', 'maxPlayers', 'practicePage', 'scoreKind', 'timeout', 'assets', 'route'].sort();
  for (const game of gamePresentations()) {
    assert.deepEqual(Object.keys(game).sort(), allowed); assert.equal(metadataOnly(game), true);
    assert.equal(Object.isFrozen(game), true); assert.equal(Object.isFrozen(game.assets), true);
    assert.equal(Object.isFrozen(game.timeout), true); assert.equal(Object.isFrozen(game.route), true);
    assert.deepEqual(gameInfo(game.gameType), { gameType: game.gameType, minPlayers: game.minPlayers, maxPlayers: game.maxPlayers });
    assert.equal(gameAdapter(game.gameType).gameType, game.gameType);
    assert.deepEqual(gameDetails(game.gameType), game.route);
    assert.equal(roomHref('123456', game.gameType), `./${game.page}?code=123456`);
    assert.deepEqual(Object.keys(game.timeout).sort(), ['action', 'hint']);
    for (const forbidden of ['engine', 'privateView', 'spectatorView', 'board', 'pool', 'rack', 'ruleVersions', 'secret']) assert.equal(Object.hasOwn(game, forbidden), false);
  }
  const definition = { ...gamePresentation('rummikub') }; delete definition.route;
  for (const field of ['engine', 'privateView', 'secret']) assert.throws(() => createPresentationCatalog([{ ...definition, [field]: { secret: 'private' } }]), TypeError);
  assert.throws(() => createPresentationCatalog([{ ...definition, timeout: { ...definition.timeout, secret: 'private' } }]), TypeError);
});

test('unknown game directory entries and routes reject instead of selecting a Rummikub fallback', () => {
  for (const value of ['unknown', 'constructor', '__proto__', null, 0, {}, 'RUMMIKUB']) {
    assert.throws(() => gamePresentation(value), TypeError);
    assert.throws(() => gameDetails(value), TypeError);
    assert.throws(() => roomHref('123456', value), TypeError);
    assert.throws(() => gameInfo(value), TypeError);
  }
});

test('all declared public paths exist; old aliases and canonical modules are public while full engines and fixtures are denied', () => {
  const assets = publicAssetPaths();
  for (const path of assets) assert.equal(statSync(join(projectRoot, 'app', path)).isFile(), true, path);
  for (const game of gamePresentations()) for (const path of [game.page, game.practicePage, ...game.assets].filter(Boolean)) assert.ok(assets.includes(path), path);
  for (const path of ['rules.mjs', 'games/rummikub/rules.mjs', 'table-layout.mjs', 'games/rummikub/table-layout.mjs',
    'army-board.mjs', 'games/army-flip/board.mjs', 'army-presentation.mjs', 'games/army-flip/presentation.mjs']) assert.ok(assets.includes(path), path);
  for (const path of unreleased414Paths) assert.equal(assets.includes(path), false, path);
  for (const path of privatePaths) {
    assert.equal(assets.includes(path), false, path);
    assert.throws(() => publicAssetPaths([{ assets: [path] }], []), TypeError, path);
  }
  for (const directory of ['tests', '__tests__', 'fixtures', '__fixtures__', 'private', 'test-support', 'server', 'node_modules'])
    assert.throws(() => publicAssetPaths([{ assets: [`games/rummikub/${directory}/data.mjs`] }], []), TypeError, directory);
  for (const path of ['../server/storage.mjs', '/games/rummikub/rules.mjs', 'games//rummikub/rules.mjs', 'games/./rummikub/rules.mjs'])
    assert.throws(() => publicAssetPaths([{ assets: [path] }], []), TypeError, path);
});

test('release packaging recursively retains canonical runtime modules and excludes nested tests and fixture directories', t => {
  const directory = mkdtempSync(join(tmpdir(), 'game-catalog-release-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'source');
  const fixtureFiles = ['package.json', 'package-lock.json', 'app/index.html', 'app/games/demo/public.mjs',
    'server/games/demo/adapter.mjs', 'app/games/demo/engine.test.mjs', 'app/games/demo/test-support/helper.mjs',
    'app/games/demo/tests/test.mjs', 'app/games/demo/fixtures/data.mjs', 'server/test-support/secret.mjs',
    'server/games/demo/__fixtures__/secret.mjs',
    ...['production-start.mjs', 'production-preflight.mjs', 'initialize-store-key.mjs', 'store-backup.mjs', 'store-restore.mjs', 'scheduled-backup.mjs', 'release-compatibility.mjs'].map(file => `scripts/${file}`),
    ...['Caddyfile', 'game-room.service', 'game-room-identity-batch.conf', 'game-room-backup.service', 'game-room-backup.timer', 'runtime.env.example', 'install-release.sh', 'activate-release.sh'].map(file => `infra/${file}`)];
  for (const path of fixtureFiles) { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, 'synthetic packaging fixture\n'); }
  const sources = releaseSources(root);
  assert.ok(sources.includes('app/games/demo/public.mjs')); assert.ok(sources.includes('server/games/demo/adapter.mjs'));
  assert.ok(sources.includes('infra/game-room-identity-batch.conf'));
  assert.equal(sources.some(path => /(?:^|\/)(?:test-support|tests|fixtures|__tests__|__fixtures__)(?:\/|$)|\.test\.mjs$/.test(path)), false);
  const release = buildRelease({ projectRoot: root, outputRoot: join(directory, 'artifacts') });
  const members = execFileSync('tar', ['-tzf', release.artifact], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(members.sort(), [...sources, 'release-manifest.json'].sort());
  assert.equal(releaseSources(projectRoot).includes('app/games/catalog-boundary.test.mjs'), false);
});

function request(base, path, host) {
  return new Promise((accept, reject) => {
    const outgoing = http.get(base + path, { headers: { Host: host } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }); outgoing.on('error', reject);
  });
}
async function listen(server, t) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown ? server.shutdown() : new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())));
  return `http://127.0.0.1:${server.address().port}`;
}
for (const mode of ['legacy', 'unified']) test(`${mode} HTTP serves canonical and alias assets but returns 404 for nested private engines and fixture paths`, async t => {
  let server, host;
  if (mode === 'legacy') server = createServer({ settings: readSettings({ GAME_ROOM_AUTH_MODE: 'legacy' }) });
  else {
    const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_ORIGIN: 'http://127.0.0.1:39073' });
    const storage = new EncryptedStore(new MemoryAdapter(), randomBytes(32));
    const runtime = createRuntime(settings, { storage, provider: new MockProvider(settings), roomOptions: { pollIntervalMs: 0 } });
    server = createUnifiedServer(runtime); host = new URL(settings.origin).host;
  }
  const base = await listen(server, t); host ??= new URL(base).host;
  for (const path of ['games/catalog.mjs', 'rules.mjs', 'games/rummikub/rules.mjs', 'army-board.mjs', 'games/army-flip/board.mjs']) {
    const response = await request(base, '/' + path, host);
    assert.equal(response.status, 200, path); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body, readFileSync(join(projectRoot, 'app', path), 'utf8'));
  }
  for (const path of [...privatePaths, ...unreleased414Paths]) {
    const response = await request(base, '/' + path, host);
    assert.equal(response.status, 404, path); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.includes('private authoritative state'), false, path);
  }
});
