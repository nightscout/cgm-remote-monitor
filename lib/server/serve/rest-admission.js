'use strict';

// Bounded REST admission for the multitenant api role's consumer listener.
//
// Purpose: when REST traffic exceeds what one api process can serve, refuse the
// excess quickly instead of letting it queue on PostgreSQL pool waits and the
// event loop. The api process also answers realtime's socket-authority calls on
// its private listener (serve.internal), and those calls share the same pools;
// an unbounded REST queue delays them and, with them, realtime frame delivery.
//
// Mechanism: at most `concurrency` requests run their handlers at once. Up to
// `queue` more wait (each at most `queueTimeoutMs`) for a slot. Every other
// request, and a waiting request whose deadline passes, receives
// 503 REST_ADMISSION_REFUSED with Retry-After before any route handler runs, so
// a refused write has no storage effect and the client sees a definite
// non-acceptance. An admitted request keeps today's semantics: it is never
// answered by this limiter afterwards.
//
// Scope: only the express app it is installed on. serve.internal (socket
// forwarding, lifecycle status, evaluator and realtime contracts) and the
// realtime role's sockets are separate listeners and are not counted.
//
// A slot is released when the response closes (finished or aborted). A handler
// that keeps working after its client disconnected is no longer counted.
//
//   NS_API_REST_CONCURRENCY             handlers running at once; unset = no limit (default)
//   NS_API_REST_QUEUE                   requests that may wait for a slot (default 0: refuse at once)
//   NS_API_REST_QUEUE_TIMEOUT_MS        longest wait for a slot before refusal (default 1000)
//   NS_API_REST_RETRY_AFTER_SECONDS     Retry-After on a refusal (default 1)
const { PreviewConfigError } = require('./preview-config-error');
const { AsyncResource } = require('node:async_hooks');

const LIMITS = Object.freeze({ concurrency: 100000, queue: 100000, queueTimeoutMs: 60000, retryAfterSeconds: 3600 });
const DEFAULTS = Object.freeze({ queue: 0, queueTimeoutMs: 1000, retryAfterSeconds: 1 });
const NAMES = Object.freeze({ concurrency: 'NS_API_REST_CONCURRENCY', queue: 'NS_API_REST_QUEUE',
  queueTimeoutMs: 'NS_API_REST_QUEUE_TIMEOUT_MS', retryAfterSeconds: 'NS_API_REST_RETRY_AFTER_SECONDS' });

function integer (source, name, fallback, lower, upper) {
  const raw = source?.[name];
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw) || Number(raw) < lower || Number(raw) > upper) {
    throw new PreviewConfigError('invalid ' + name + ': a whole number from ' + lower + ' to ' + upper + ' is required');
  }
  return Number(raw);
}

// The selected bound from the process environment, or null when REST admission
// is not limited. Refuses a queue/timeout/Retry-After setting without a limit,
// so a partial configuration is never silently ignored.
function settings (source = process.env) {
  const concurrency = integer(source, NAMES.concurrency, null, 1, LIMITS.concurrency);
  if (concurrency === null) {
    const stray = ['queue', 'queueTimeoutMs', 'retryAfterSeconds'].find(key => source?.[NAMES[key]] !== undefined && source[NAMES[key]] !== '');
    if (stray) throw new PreviewConfigError(NAMES[stray] + ' requires ' + NAMES.concurrency);
    return null;
  }
  return Object.freeze({ concurrency,
    queue: integer(source, NAMES.queue, DEFAULTS.queue, 0, LIMITS.queue),
    queueTimeoutMs: integer(source, NAMES.queueTimeoutMs, DEFAULTS.queueTimeoutMs, 1, LIMITS.queueTimeoutMs),
    retryAfterSeconds: integer(source, NAMES.retryAfterSeconds, DEFAULTS.retryAfterSeconds, 1, LIMITS.retryAfterSeconds) });
}

const BODY = JSON.stringify({ status: 503, error: 'REST_ADMISSION_REFUSED', message: 'The server is busy. The request was not processed; retry later.' });

function create ({ concurrency, queue = 0, queueTimeoutMs = DEFAULTS.queueTimeoutMs, retryAfterSeconds = DEFAULTS.retryAfterSeconds,
  diagnostics = require('../../diagnostics/m7') } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(queue) || queue < 0 ||
      !Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1 || !Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new TypeError('REST admission requires explicit positive bounds');
  }
  let inflight = 0;
  const waiting = [];
  const counters = { admitted: 0, queued: 0, refused: 0, expired: 0, abandoned: 0 };

  function refuse (res) {
    counters.refused++; diagnostics.delta('api.rest_refused', 1);
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    res.statusCode = 503;
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(BODY);
  }
  function admit (res, next) {
    inflight++; counters.admitted++; diagnostics.delta('api.rest_inflight', 1);
    let released = false;
    res.once('close', () => {
      if (released) return;
      released = true; inflight--; diagnostics.delta('api.rest_inflight', -1);
      drain();
    });
    next();
  }
  function drain () {
    while (inflight < concurrency && waiting.length) {
      const entry = waiting.shift();
      clearTimeout(entry.timer); entry.res.removeListener('close', entry.abandon);
      diagnostics.delta('api.rest_waiting', -1);
      admit(entry.res, entry.next);
    }
  }
  function middleware (req, res, next) {
    if (inflight < concurrency && !waiting.length) return admit(res, next);
    if (waiting.length >= queue) return refuse(res);
    counters.queued++; diagnostics.delta('api.rest_waiting', 1);
    // A queued request continues in its own async context. drain() runs inside
    // the releasing request's 'close' listener; calling next() there would hand
    // this request the other request's AsyncLocalStorage state (its tenant
    // operation-window scope), and the window refuses a scope it does not own.
    const entry = { res, next: AsyncResource.bind(next) };
    const leave = () => {
      const index = waiting.indexOf(entry);
      if (index < 0) return false;
      waiting.splice(index, 1); clearTimeout(entry.timer); res.removeListener('close', entry.abandon);
      diagnostics.delta('api.rest_waiting', -1);
      return true;
    };
    entry.abandon = () => { if (leave()) counters.abandoned++; };
    entry.timer = setTimeout(() => { if (leave()) { counters.expired++; refuse(res); } }, queueTimeoutMs);
    entry.timer.unref?.();
    res.once('close', entry.abandon);
    waiting.push(entry);
  }
  function stats () {
    return Object.freeze({ concurrency, queue, queueTimeoutMs, retryAfterSeconds, inflight, waiting: waiting.length, ...counters });
  }
  return Object.freeze({ middleware, stats });
}

module.exports = { settings, create, NAMES, DEFAULTS, LIMITS };
