import { createHash, randomBytes, sign } from 'node:crypto';

export const IDENTITY_BATCH_ENDPOINT = 'https://agora.sumomoli.com/api/identity/batch';
export const IDENTITY_BATCH_LIMITS = Object.freeze({ entries: 16, tokenCharacters: 8192,
  requestBytes: 147456, responseBytes: 32768 });
const REF = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9._-]{1,8192}$/;
const POLICY_FIELDS = ['version', 'revokedBefore', 'issuer', 'sub', 'clientId', 'authTime'];
const COMPONENTS = '("@method" "@scheme" "@authority" "@path" "content-digest" "content-type" "x-agora-audience")';
const decoder = new TextDecoder('utf-8', { fatal: true });

export class IdentityBatchWireFailure extends Error {
  constructor(code) { super(code); this.name = 'IdentityBatchWireFailure'; this.code = code; }
}
const demand = (condition, code) => { if (!condition) throw new IdentityBatchWireFailure(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, fields) => record(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field));
const milliseconds = value => Number.isSafeInteger(value) && value >= 0;
const ascii = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum
  && /^[\x20-\x7e]+$/.test(value);
const validRef = value => typeof value === 'string' && REF.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
export const identityBatchRef = () => randomBytes(32).toString('base64url');
export const identityBatchTokenValid = value => typeof value === 'string' && TOKEN.test(value);
export const identityBatchKeyIdValid = value => typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(value);

export function encodeIdentityBatch({ batchRef, entries }) {
  demand(validRef(batchRef) && Array.isArray(entries) && entries.length >= 1
    && entries.length <= IDENTITY_BATCH_LIMITS.entries, 'batch-shape');
  const seen = new Set();
  const encoded = entries.map(entry => {
    demand(exactKeys(entry, ['ref', 'accessToken', 'triggeredAtMs', 'queueUntilMs', 'deadlineMs'])
      && validRef(entry.ref) && !seen.has(entry.ref) && identityBatchTokenValid(entry.accessToken), 'entry-shape');
    seen.add(entry.ref);
    const { triggeredAtMs, queueUntilMs, deadlineMs } = entry;
    demand([triggeredAtMs, queueUntilMs, deadlineMs].every(milliseconds)
      && triggeredAtMs <= queueUntilMs && queueUntilMs <= deadlineMs
      && queueUntilMs - triggeredAtMs <= 4000 && deadlineMs - triggeredAtMs <= 8000, 'entry-deadline');
    return { ref: entry.ref, accessToken: entry.accessToken, triggeredAtMs, queueUntilMs, deadlineMs };
  });
  const body = Buffer.from(JSON.stringify({ version: 1, batchRef, entries: encoded }), 'utf8');
  demand(body.length <= IDENTITY_BATCH_LIMITS.requestBytes, 'request-limit');
  return body;
}

// adapter-1 freezes ASCII key IDs to 64 bytes. Production key pins, actual
// admission and the clock-bound proof remain separate from this local profile.
export function signIdentityBatch({ body, batchRef, keyId, privateKey, created, expires }) {
  demand(Buffer.isBuffer(body) && body.length <= IDENTITY_BATCH_LIMITS.requestBytes && validRef(batchRef), 'signed-body');
  demand(identityBatchKeyIdValid(keyId), 'key-id');
  demand(milliseconds(created) && milliseconds(expires) && created <= 999_999_999_999_999
    && expires <= 999_999_999_999_999 && expires - created >= 1 && expires - created <= 10, 'signature-lifetime');
  const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
  const parameters = `${COMPONENTS};created=${created};expires=${expires};nonce="${batchRef}";keyid="${keyId}";alg="ed25519"`;
  const base = ['"@method": POST', '"@scheme": https', '"@authority": agora.sumomoli.com',
    '"@path": /api/identity/batch', `"content-digest": ${digest}`, '"content-type": application/json',
    '"x-agora-audience": agora.identity.batch.v1', `"@signature-params": ${parameters}`].join('\n');
  let signature;
  try { signature = sign(null, Buffer.from(base, 'utf8'), privateKey); }
  catch { throw new IdentityBatchWireFailure('signing-unavailable'); }
  demand(signature.length === 64, 'signing-key');
  return Object.freeze({ Accept: 'application/json', 'Accept-Encoding': 'identity',
    'Content-Digest': digest, 'Content-Type': 'application/json',
    'X-Agora-Audience': 'agora.identity.batch.v1', 'Signature-Input': `agora=${parameters}`,
    Signature: `agora=:${signature.toString('base64')}:` });
}

// JSON.parse silently accepts duplicate names. Scan the bounded document before
// allocating its object graph, rejecting duplicates, excess nodes and nesting.
function rejectDuplicateKeys(text) {
  let position = 0, nodes = 0;
  const whitespace = () => { while (position < text.length && /[\t\n\r ]/.test(text[position])) position++; };
  const string = () => {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '\\') position++;
      else if (character === '"') return JSON.parse(text.slice(start, position));
    }
    throw new IdentityBatchWireFailure('response-json');
  };
  const value = depth => {
    demand(depth <= 4 && ++nodes <= 256, 'response-depth'); whitespace();
    if (text[position] === '{') {
      position++; whitespace(); const keys = new Set();
      if (text[position] !== '}') for (;;) {
        whitespace(); const key = string();
        demand(!keys.has(key), 'response-duplicate-key'); keys.add(key);
        whitespace(); position++; value(depth + 1); whitespace();
        if (text[position] !== ',') break;
        position++;
      }
      position++;
    } else if (text[position] === '[') {
      position++; whitespace();
      if (text[position] !== ']') for (;;) {
        value(depth + 1); whitespace();
        if (text[position] !== ',') break;
        position++;
      }
      position++;
    } else if (text[position] === '"') string();
    else while (position < text.length && !/[\s,}\]]/.test(text[position])) position++;
  };
  value(0);
}

function policyValid(policy) {
  return exactKeys(policy, POLICY_FIELDS) && policy.version === 1 && milliseconds(policy.revokedBefore)
    && milliseconds(policy.authTime) && typeof policy.issuer === 'string' && policy.issuer.length > 0
    && !/[\x00-\x1f\x7f]/.test(policy.issuer) && Buffer.byteLength(policy.issuer, 'utf8') <= 512
    && ascii(policy.sub, 128) && ascii(policy.clientId, 128);
}

export function decodeIdentityBatchResponse(body, batchRef, expectedRefs) {
  demand((Buffer.isBuffer(body) || body instanceof Uint8Array) && body.byteLength <= IDENTITY_BATCH_LIMITS.responseBytes,
    'response-limit');
  let text, response;
  try { text = decoder.decode(body); rejectDuplicateKeys(text); response = JSON.parse(text); }
  catch (error) { throw error instanceof IdentityBatchWireFailure ? error : new IdentityBatchWireFailure('response-json'); }
  demand(exactKeys(response, ['version', 'batchRef', 'entries']) && response.version === 1
    && response.batchRef === batchRef && expectedRefs instanceof Set && expectedRefs.size > 0
    && expectedRefs.size <= IDENTITY_BATCH_LIMITS.entries && Array.isArray(response.entries)
    && response.entries.length === expectedRefs.size, 'response-shape');
  const seen = new Set(), result = new Map();
  for (const entry of response.entries) {
    demand(record(entry) && validRef(entry.ref) && expectedRefs.has(entry.ref) && !seen.has(entry.ref), 'response-ref-set');
    seen.add(entry.ref);
    demand([200, 401, 503].includes(entry.status)
      && exactKeys(entry, entry.status === 200 ? ['ref', 'status', 'policy'] : ['ref', 'status']), 'response-item');
    if (entry.status === 200) demand(policyValid(entry.policy), 'response-policy');
    result.set(entry.ref, Object.freeze({ status: entry.status,
      ...(entry.status === 200 ? { policy: Object.freeze({ ...entry.policy }) } : {}) }));
  }
  demand(seen.size === expectedRefs.size, 'response-ref-set');
  return result;
}

export async function cancelIdentityBatchBody(response) {
  if (typeof response?.body?.cancel === 'function') await response.body.cancel();
}

export async function readIdentityBatchBody(response, { signal, onCleanup } = {}) {
  if (onCleanup !== undefined && typeof onCleanup !== 'function') {
    await cancelIdentityBatchBody(response);
    throw new TypeError('Identity body cleanup notification must be a function');
  }
  // Server-internal lifecycle notification, never an allow callback. A failed
  // notification still runs and awaits the real cleanup, then rejects output.
  let cleanupFailed = false, cleanupFailure;
  const notifyCleanup = () => {
    try {
      const result = onCleanup?.();
      if (typeof result?.then === 'function') {
        // A notification must finish synchronously. Rejecting an async hook
        // cannot interrupt the real cancel or become an unhandled rejection.
        Promise.resolve(result).catch(() => {});
        throw new TypeError('Identity body cleanup notification must be synchronous');
      }
    }
    catch (error) { if (!cleanupFailed) { cleanupFailed = true; cleanupFailure = error; } }
  };
  const length = response?.headers?.get?.('content-length');
  const type = response?.headers?.get?.('content-type');
  const encoding = response?.headers?.get?.('content-encoding');
  if (type !== 'application/json' || encoding !== null && encoding !== undefined && encoding !== 'identity'
    || length !== null && length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length)
      || !Number.isSafeInteger(Number(length)) || Number(length) > IDENTITY_BATCH_LIMITS.responseBytes)
    || typeof response?.body?.getReader !== 'function') {
    notifyCleanup();
    await cancelIdentityBatchBody(response);
    if (cleanupFailed) throw cleanupFailure;
    throw new IdentityBatchWireFailure('response-body');
  }
  const reader = response.body.getReader();
  // One fixed buffer also bounds overhead from adversarial one-byte or empty
  // chunks; collecting an arbitrary number of chunk objects would not.
  const buffer = Buffer.alloc(IDENTITY_BATCH_LIMITS.responseBytes);
  let bytes = 0, reads = 0, complete = false;
  let cancellation;
  const cancel = () => {
    if (cancellation) return;
    notifyCleanup();
    cancellation = Promise.resolve().then(() => reader.cancel()); cancellation.catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      demand(++reads <= IDENTITY_BATCH_LIMITS.responseBytes + 1, 'response-chunk-limit');
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      demand(chunk.value instanceof Uint8Array, 'response-chunk');
      demand(bytes + chunk.value.byteLength <= IDENTITY_BATCH_LIMITS.responseBytes, 'response-limit');
      buffer.set(chunk.value, bytes); bytes += chunk.value.byteLength;
    }
    demand(length === null || length === undefined || Number(length) === bytes, 'response-length');
    return buffer.subarray(0, bytes);
  } finally {
    // A cancelled reader is still owned until its actual cancel operation
    // settles. A timeout outside this function must not release its worker.
    signal?.removeEventListener('abort', cancel);
    if (!complete) cancel();
    try { if (cancellation) await cancellation; }
    finally { reader.releaseLock(); }
    if (cleanupFailed) throw cleanupFailure;
  }
}
