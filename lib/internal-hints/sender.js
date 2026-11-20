'use strict';

// The shared post-commit hint sender (spike S3). api, tenant-admin and admin
// call it after COMMIT; it never blocks, delays or fails the write.
//
// - Owner: contract.owner (slice.js sha256-modulo-v1) over K, the target role's
//   slice count. Ordinal i is addressed through the headless Service naming of
//   the StatefulSet (evaluator-<i>.evaluator, realtime-<i>.realtime-peers).
// - In one process that serves the target role (single tenant, or a combined
//   `serve api,evaluator`), the hint is a local function call, scheduled off
//   the caller's stack, with the same merge and bound rules as HTTP.
// - Fire and forget: send() returns undefined synchronously and never throws.
// - No retries. While a hint for (kind, tenant) is in flight, later hints for
//   it merge into one waiting hint, sent when the first settles.
// - At most maxInFlight requests per peer, over keep-alive connections. Waiting
//   hints per peer are bounded; an overflowed hint is dropped and counted.
// Every failure (refused, 404, 503, timeout, no such host) is counted and
// forgotten: the writer's pending mark and the owner's sweep recover it.
const http = require('node:http');
const contract = require('./contract');

const OUTCOMES = Object.freeze({ 202: 'accepted', 404: 'notFound', 421: 'misdirected', 503: 'notReady' });

function create ({ targets = {}, maxInFlight = 4, maxWaiting = 10000, timeoutMs = contract.TIMEOUT_MS,
  request = http.request, owner = contract.owner, schedule = setImmediate, agentOptions = {} } = {}) {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64 ||
      !Number.isSafeInteger(maxWaiting) || maxWaiting < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      typeof request !== 'function' || typeof owner !== 'function' || typeof schedule !== 'function') throw new TypeError('Internal hint sender: invalid settings');
  const roles = new Map();
  for (const [role, target] of Object.entries(targets)) {
    if (!target) continue;
    roles.set(role, checkTarget(role, target));
  }
  const counters = { hints: 0, merged: 0, queued: 0, dropped: 0, refused: 0, unconfigured: 0, local: 0,
    accepted: 0, notFound: 0, misdirected: 0, notReady: 0, rejected: 0, unreachable: 0, timeout: 0, errors: 0 };
  const peers = new Map();
  let closed = false;

  function peer (role, target, ordinal, local) {
    const key = role + '/' + (local ? 'local' : ordinal);
    let state = peers.get(key);
    if (!state) {
      const address = local ? null : target.address(ordinal);
      state = { key, local, handler: local ? target.local : null, address,
        agent: local ? null : new http.Agent({ keepAlive: true, maxSockets: maxInFlight, maxFreeSockets: maxInFlight, ...agentOptions }),
        inflight: 0, active: new Set(), waiting: new Map(), settled: new Set() };
      peers.set(key, state);
    }
    return state;
  }

  function post (state, kind, tenant, hint) {
    if (state.local) {
      return new Promise(resolve => schedule(() => {
        try { Promise.resolve(state.handler(kind, tenant, Object.freeze(hint))).then(() => resolve('accepted'), () => resolve('rejected')); }
        catch { resolve('rejected'); }
      }));
    }
    return new Promise(resolve => {
      let done = false;
      const finish = outcome => { if (!done) { done = true; resolve(outcome); } };
      try {
        const bytes = Buffer.from(JSON.stringify(contract.fit(kind, hint)));
        const endpoint = state.address.socketPath ? { socketPath: state.address.socketPath }
          : { hostname: state.address.hostname, port: state.address.port };
        const req = request({ ...endpoint, agent: state.agent, method: 'POST', path: contract.path(kind, tenant),
          headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
          res.on('error', () => finish('unreachable'));
          res.on('end', () => finish(OUTCOMES[res.statusCode] || 'rejected'));
          res.resume();
        });
        req.setTimeout(timeoutMs, () => { finish('timeout'); req.destroy(); });
        req.on('error', () => finish('unreachable'));
        req.end(bytes);
      } catch { finish('unreachable'); }
    });
  }

  function dispatch (state, key, kind, tenant, hint) {
    state.inflight++; state.active.add(key);
    const flight = post(state, kind, tenant, hint).then(outcome => {
      counters[outcome] = (counters[outcome] || 0) + 1;
    }, () => { counters.errors++; }).finally(() => {
      state.inflight--; state.active.delete(key); state.settled.delete(flight);
      pump(state);
    });
    state.settled.add(flight);
  }

  function pump (state) {
    if (closed) return;
    for (const [key, row] of state.waiting) {
      if (state.inflight >= maxInFlight) return;
      if (state.active.has(key)) continue;
      state.waiting.delete(key);
      dispatch(state, key, row.kind, row.tenant, row.hint);
    }
  }

  // send(kind, tenant, fields): after COMMIT. Returns undefined; never throws.
  function send (kind, tenant, fields) {
    try {
      if (closed) return;
      counters.hints++;
      if (!Object.hasOwn(contract.KINDS, kind) || typeof tenant !== 'string' || !contract.UUID.test(tenant)) { counters.refused++; return; }
      const role = contract.KINDS[kind].role, target = roles.get(role);
      if (!target) { counters.unconfigured++; return; }
      const ordinal = target.count === 1 ? 0 : owner(tenant, target.count);
      const local = !!target.local && (target.ordinal === undefined || target.ordinal === ordinal);
      if (local) counters.local++;
      const state = peer(role, target, ordinal, local);
      const key = kind + ' ' + tenant, hint = contract.normalize(kind, fields);
      const waiting = state.waiting.get(key);
      if (waiting) { waiting.hint = contract.merge(kind, waiting.hint, hint); counters.merged++; return; }
      if (state.active.has(key) || state.inflight >= maxInFlight) {
        if (state.waiting.size >= maxWaiting) { counters.dropped++; return; }
        state.waiting.set(key, { kind, tenant, hint }); counters.queued++; return;
      }
      dispatch(state, key, kind, tenant, hint);
    } catch { counters.errors++; }
  }

  return Object.freeze({
    send,
    changed: (tenant, fields) => send('changed', tenant, fields),
    storageEvents: (tenant, fields) => send('storage-events', tenant, fields),
    outputChanged: (tenant, fields) => send('output-changed', tenant, fields),
    stats () {
      const out = { ...counters, inflight: 0, waiting: 0 };
      for (const state of peers.values()) { out.inflight += state.inflight; out.waiting += state.waiting.size; }
      return Object.freeze(out);
    },
    // Settle what is in flight (each bounded by timeoutMs); drop what waits.
    async close () {
      closed = true;
      const flights = [];
      for (const state of peers.values()) { state.waiting.clear(); flights.push(...state.settled); }
      await Promise.allSettled(flights);
      for (const state of peers.values()) state.agent?.destroy();
    }
  });
}

// A target is {count, address(i)} for HTTP peers, {local} for a role this
// process serves, or both with {ordinal} when this process is one slice of K.
function checkTarget (role, target) {
  const count = target.count === undefined ? 1 : target.count;
  if (!Object.values(contract.KINDS).some(kind => kind.role === role)) throw new TypeError('Internal hint sender: unknown role ' + role);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1024) throw new TypeError('Internal hint sender: count must be 1..1024');
  if (target.local !== undefined && typeof target.local !== 'function') throw new TypeError('Internal hint sender: local must be a function');
  if (target.address !== undefined && typeof target.address !== 'function') throw new TypeError('Internal hint sender: address must be a function');
  if (!target.local && !target.address) throw new TypeError('Internal hint sender: a target needs local or address');
  if (target.ordinal !== undefined && (!Number.isSafeInteger(target.ordinal) || target.ordinal < 0)) throw new TypeError('Internal hint sender: invalid ordinal');
  if (target.ordinal !== undefined && count > 1 && !target.address) throw new TypeError('Internal hint sender: one slice of K needs the other slices\' addresses');
  // Addresses are resolved once per ordinal and checked up front, so a bad
  // template fails at configuration, never on the write path.
  const addresses = target.address ? Array.from({ length: count }, (_, i) => endpoint(target.address(i))) : null;
  return Object.freeze({ count, ordinal: target.ordinal, local: target.local, address: addresses ? i => addresses[i] : undefined });
}
function endpoint (value) {
  if (value && typeof value.socketPath === 'string' && value.socketPath.startsWith('/')) return Object.freeze({ socketPath: value.socketPath });
  let url;
  try { url = new URL(value && value.url); } catch { throw new TypeError('Internal hint sender: address is {url} or {socketPath}'); }
  if (url.protocol !== 'http:' || !url.hostname || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Internal hint sender: an address is http://host:port/');
  }
  return Object.freeze({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
}

module.exports = { create, checkTarget, endpoint, OUTCOMES };
