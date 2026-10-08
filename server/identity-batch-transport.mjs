import { Agent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { IDENTITY_BATCH_ENDPOINT, IDENTITY_BATCH_LIMITS } from './identity-batch-wire.mjs';

const headerNames = ['accept', 'accept-encoding', 'content-digest', 'content-type',
  'signature-input', 'signature', 'x-agora-audience'];
const inputFields = ['method', 'headers', 'body', 'redirect', 'credentials', 'cache', 'signal'];
const unavailable = () => new Error('Identity batch transport unavailable');

function requestHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw unavailable();
  const headers = {}, seen = new Set(); let bytes = 0;
  for (const [name, value] of Object.entries(input)) {
    const field = name.toLowerCase();
    if (!headerNames.includes(field) || seen.has(field) || typeof value !== 'string'
      || !/^[\x20-\x7e]+$/.test(value)) throw unavailable();
    seen.add(field); headers[field] = value; bytes += name.length + value.length + 4;
  }
  if (seen.size !== headerNames.length || bytes > 8192 || headers.accept !== 'application/json'
    || headers['accept-encoding'] !== 'identity' || headers['content-type'] !== 'application/json'
    || headers['x-agora-audience'] !== 'agora.identity.batch.v1') throw unavailable();
  return headers;
}

function validRequest(url, options) {
  if (url !== IDENTITY_BATCH_ENDPOINT || !options || Object.keys(options).some(field => !inputFields.includes(field))
    || options.method !== 'POST' || options.redirect !== 'error' || options.credentials !== 'omit'
    || options.cache !== 'no-store' || !Buffer.isBuffer(options.body)
    || options.body.length > IDENTITY_BATCH_LIMITS.requestBytes || options.body.length < 1
    || options.signal !== undefined && (typeof options.signal?.aborted !== 'boolean'
      || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) {
    throw unavailable();
  }
  if (options.signal?.aborted) throw unavailable();
  const headers = { ...requestHeaders(options.headers), host: 'agora.sumomoli.com',
    'content-length': String(options.body.length) };
  // Account for native Node's one automatic Connection header as well.
  const totalBytes = Object.entries(headers).reduce((bytes, [name, value]) => bytes + name.length + value.length + 4, 0)
    + 'connection'.length + 'keep-alive'.length + 4;
  if (totalBytes > 8192) throw unavailable();
  return headers;
}

// Native HTTPS avoids fetch's automatic sec-fetch-mode/compression headers.
// URL/TLS/proxy settings are deliberately not configurable. The two factories
// below only enable tests to bridge the fixed target to an owned loopback server.
export function createIdentityBatchTransport({ requester = httpsRequest,
  agentFactory = () => new Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 1 }) } = {}) {
  if (typeof requester !== 'function' || typeof agentFactory !== 'function') throw new TypeError('Invalid identity batch transport');
  const agent = agentFactory();
  if (typeof agent?.destroy !== 'function') throw new TypeError('Identity batch transport requires an owned Agent');
  const jobs = new Set(); let closed = false, closing;

  const fetcher = (url, options) => new Promise((resolve, reject) => {
    let headers;
    try { if (closed) throw unavailable(); headers = validRequest(url, options); }
    catch { reject(unavailable()); return; }
    let finishClosed;
    const job = { request: null, message: null, requestClosed: false, messageClosed: false,
      delivered: false, failure: false, finished: false, closed: new Promise(accept => { finishClosed = accept; }) };
    const abort = () => {
      job.failure = true;
      job.request?.destroy(unavailable()); job.message?.destroy(unavailable());
    };
    const finish = () => {
      if (job.finished || !job.requestClosed || job.message && !job.messageClosed) return;
      job.finished = true; jobs.delete(job); options.signal?.removeEventListener('abort', abort);
      finishClosed();
      if (!job.delivered && job.failure) reject(unavailable());
    };
    jobs.add(job);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      job.request = requester(new URL(IDENTITY_BATCH_ENDPOINT), { method: 'POST', agent, headers });
      job.request.once('close', () => { job.requestClosed = true; finish(); });
      job.request.on('error', () => { job.failure = true; job.message?.destroy(unavailable()); });
      job.request.once('response', message => {
        job.message = message;
        message.once('close', () => { job.messageClosed = true; finish(); });
        message.on('error', () => { job.failure = true; job.request.destroy(unavailable()); });
        const status = message.statusCode;
        if (!Number.isInteger(status) || status < 200 || status > 599) { abort(); return; }
        if (status !== 200) {
          // The caller treats every machine status as unavailable. Stop an
          // unread error/redirect body and await actual close before delivery.
          job.delivered = true;
          job.request.destroy(); message.destroy();
          void job.closed.then(() => resolve(new Response(null, { status })));
          return;
        }
        try {
          const source = Readable.toWeb(message, { strategy: { highWaterMark: IDENTITY_BATCH_LIMITS.responseBytes,
            size: chunk => chunk.byteLength } }).getReader();
          let cancelled = false, released = false;
          const release = () => { if (!released) { released = true; source.releaseLock(); } };
          const body = new ReadableStream({
            async pull(controller) {
              try {
                const next = await source.read();
                if (cancelled) return;
                if (next.done) {
                  await job.closed; release(); if (!cancelled) controller.close();
                } else controller.enqueue(next.value);
              } catch {
                abort(); await job.closed; release();
                if (!cancelled) controller.error(unavailable());
              }
            },
            async cancel() {
              cancelled = true; abort();
              try { await source.cancel(); }
              finally { await job.closed; release(); }
            },
          }, { highWaterMark: 1 });
          const responseHeaders = {};
          for (const name of ['content-type', 'content-length', 'content-encoding']) {
            if (typeof message.headers[name] === 'string') responseHeaders[name] = message.headers[name];
          }
          const response = new Response(body, { status, headers: responseHeaders });
          job.delivered = true; resolve(response);
        } catch { abort(); }
      });
      if (options.signal?.aborted) abort();
      else job.request.end(options.body);
    } catch {
      job.failure = true;
      if (job.request) abort();
      else { job.requestClosed = true; finish(); }
    }
  });

  const close = () => {
    if (closing) return closing;
    closed = true;
    const settled = [...jobs].map(job => job.closed);
    for (const job of jobs) {
      job.failure = true; job.request?.destroy(unavailable()); job.message?.destroy(unavailable());
    }
    agent.destroy();
    closing = Promise.all(settled).then(() => undefined);
    return closing;
  };
  return Object.freeze({ fetcher, close, get occupancy() { return Object.freeze({ activeRequests: jobs.size, closed }); } });
}
