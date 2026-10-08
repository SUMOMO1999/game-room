import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { CognitoProvider } from './auth.mjs';
import { IdentityBatchClient } from './identity-batch-client.mjs';
import { createIdentityBatchTransport } from './identity-batch-transport.mjs';

// Startup only. Machine signing keys never enter the release, account state,
// OAuth client or business database. Refuse links and bound the actual open file.
export function readIdentityBatchKey(settings, env = process.env) {
  const file = settings.identityBatchKeyFile;
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Identity batch requires an absolute signing-key file');
  let descriptor;
  try {
    if (!lstatSync(file).isFile()) throw new Error();
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(descriptor);
    let credential = false;
    const directory = env.CREDENTIALS_DIRECTORY;
    if (directory && /^\/run\/credentials\/game-room(?:-preflight-[a-f0-9]{20})?\.service$/.test(directory)
        && file === `${directory}/identity-batch-key`) {
      const parent = lstatSync(dirname(file));
      credential = parent.isDirectory() && parent.uid === 0 && !(parent.mode & 0o022)
        && info.uid === 0 && !(info.mode & 0o337);
    }
    if (!info.isFile() || info.size < 1 || info.size > 2048
        || !credential && ((info.mode & 0o077) || process.getuid && info.uid !== process.getuid())) throw new Error();
    const contents = readFileSync(descriptor);
    if (contents.length > 2048) throw new Error();
    const key = createPrivateKey({ key: contents, format: 'pem', type: 'pkcs8' });
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key;
  } catch { throw new Error('Identity batch signing key must be an owned private Ed25519 file'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function createIdentityBatchRuntime(settings, { now = Date.now, env = process.env } = {}) {
  if (!settings.identityBatchEnabled) return null;
  if (settings.mode !== 'cognito') throw new Error('Identity batch requires the existing Cognito identity');
  const key = readIdentityBatchKey(settings, env);
  const transport = createIdentityBatchTransport();
  let client;
  try {
    client = new IdentityBatchClient({ enabled: true, keyId: settings.identityBatchKeyId,
      privateKey: key, fetcher: transport.fetcher, now });
    const provider = new CognitoProvider(settings, { now, policyClient: client });
    return { provider, async close() { client.close(); await transport.close(); } };
  } catch (error) {
    client?.close(); void transport.close(); throw error;
  }
}
