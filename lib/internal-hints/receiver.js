'use strict';

// The receiving side of the v1 hint contracts (spike S3). handle(req, res)
// answers a hint path and returns true, or returns false for any other path so
// the private listener can dispatch it as before. It is meant to sit on the
// role's serve.internal listener beside the GET health handler
// (lib/server/internal-api/transport.js compose(), `serve`); it adds no
// authentication of its own, as decided in internal-service-contracts.
//
// Answers: 202 accepted for scheduling (no body); 400 malformed tenant id or a
// body that is not a JSON object; 404 a version or kind this process does not
// serve; 405 not POST; 413 over the kind's byte bound; 421 a tenant this
// process's slice does not own; 503 not ready, or the handler refused. A
// sender treats all but 202 alike: the sweep will catch it.
//
// A handler only schedules (for example scheduler.wake(tenant)); its result is
// not awaited past its synchronous return, and its fields are advisory.
const contract = require('./contract');

function create ({ handlers, owns = () => true, ready = () => true, timeoutMs = contract.TIMEOUT_MS } = {}) {
  if (!handlers || typeof handlers !== 'object' || !Object.keys(handlers).length ||
      Object.entries(handlers).some(([kind, fn]) => !Object.hasOwn(contract.KINDS, kind) || typeof fn !== 'function') ||
      typeof owns !== 'function' || typeof ready !== 'function') throw new TypeError('Internal hint receiver: handlers by kind required');
  const counters = { accepted: 0, malformed: 0, notFound: 0, tooLarge: 0, misdirected: 0, notReady: 0, failed: 0 };
  const answer = (res, status, counter) => {
    counters[counter]++;
    if (!res.headersSent) { res.writeHead(status, { 'content-length': 0, 'cache-control': 'no-store' }); res.end(); }
  };
  function handle (req, res) {
    const hit = contract.route(req.url);
    if (!hit) return false;
    if (req.method !== 'POST') { answer(res, 405, 'notFound'); req.resume(); return true; }
    if (hit.version !== contract.VERSION || !Object.hasOwn(handlers, hit.kind)) { answer(res, 404, 'notFound'); req.resume(); return true; }
    if (!contract.UUID.test(hit.tenant)) { answer(res, 400, 'malformed'); req.resume(); return true; }
    const max = contract.KINDS[hit.kind].maxBytes;
    if (Number(req.headers['content-length']) > max) { answer(res, 413, 'tooLarge'); req.resume(); return true; }
    const chunks = []; let size = 0, over = false;
    const timer = setTimeout(() => req.destroy(), timeoutMs);
    req.on('data', chunk => { size += chunk.length; if (size > max) over = true; else if (!over) chunks.push(chunk); });
    req.on('error', () => clearTimeout(timer));
    req.on('end', () => {
      clearTimeout(timer);
      if (over) return answer(res, 413, 'tooLarge');
      let body = {};
      if (size) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return answer(res, 400, 'malformed'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return answer(res, 400, 'malformed');
      }
      // A process serving several hint kinds answers each by its own role's
      // readiness and ownership (the kind is the second argument).
      if (ready(hit.kind) !== true) return answer(res, 503, 'notReady');
      if (owns(hit.tenant, hit.kind) !== true) return answer(res, 421, 'misdirected');
      try {
        const result = handlers[hit.kind](hit.tenant, Object.freeze(contract.normalize(hit.kind, body)));
        if (result && typeof result.catch === 'function') result.catch(() => { counters.failed++; });
      } catch { return answer(res, 503, 'failed'); }
      answer(res, 202, 'accepted');
    });
    return true;
  }
  return Object.freeze({ handle, stats: () => Object.freeze({ ...counters }) });
}

module.exports = { create };
