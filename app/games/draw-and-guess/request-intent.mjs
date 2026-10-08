import { normalizeDrawAndGuessAnswer } from './matcher.mjs';

export function createWordbankRequestId(time = Date.now(), randomUUID = () => globalThis.crypto.randomUUID()) {
  if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('操作时间无效。');
  return `${time.toString(36)}-${randomUUID()}`;
}
export function canonicalWordbankRequest(operation, packId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('原操作内容无效。');
  function normalize(value, field) {
    if (typeof value === 'string' && ['answer', 'name'].includes(field)) return normalizeDrawAndGuessAnswer(value);
    if (Array.isArray(value)) return value.map(item => typeof item === 'string' && ['aliases', 'tags'].includes(field) ? normalizeDrawAndGuessAnswer(item) : normalize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, key)]));
    return value;
  }
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  const body = { ...input }; delete body.requestId;
  return canonical({ operation, packId, input: normalize(body) });
}
export async function canonicalWordbankRequestFingerprint(operation, packId, input, cryptoRef = globalThis.crypto) {
  const encoded = new TextEncoder().encode(canonicalWordbankRequest(operation, packId, input));
  const digest = await cryptoRef.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
