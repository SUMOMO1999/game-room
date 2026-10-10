// Real unified HTTP/SSE and encrypted SQLite; only local identity is synthetic.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readSettings } from '../server/config.mjs';
import { createUnifiedServer } from '../server/unified-http.mjs';
import { MockProvider } from '../server/auth.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('Local synthetic identities cannot run in production');
const directory = new URL('../.local/hyakki-live/', import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const keyFile = new URL('store-key', directory); let key;
try { key = (await readFile(keyFile, 'utf8')).trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  key = randomBytes(32).toString('base64url'); await writeFile(keyFile, key, { mode: 0o600, flag: 'wx' });
}
const port = process.env.GAME_ROOM_PORT || '4386';
const settings = readSettings({ GAME_ROOM_AUTH_MODE: 'mock', GAME_ROOM_HYAKKI_ENABLED: '1',
  GAME_ROOM_ORIGIN: `http://127.0.0.1:${port}`, GAME_ROOM_PORT: port, GAME_ROOM_HOST: '127.0.0.1',
  GAME_ROOM_STORE_PATH: fileURLToPath(new URL('rooms.sqlite', directory)), GAME_ROOM_STORE_KEY: key });
const provider = new MockProvider(settings);
const complete = provider.complete.bind(provider);
provider.complete = async (url, transaction) => {
  const identity = await complete(url, transaction);
  return { ...identity, sub: `local-${createHash('sha256').update(transaction.state).digest('hex')}` };
};
const server = createUnifiedServer({ settings, provider });
server.on('error', () => { console.error('幽街本机联机服务启动失败。'); process.exitCode = 1; });
server.listen(settings.port, settings.host, () => console.log(`幽街完整本机入口 ${settings.origin} · 虚构身份，实际保存与联机`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.shutdown());
