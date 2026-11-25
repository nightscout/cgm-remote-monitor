'use strict';

const { isDeepStrictEqual } = require('node:util');
const { credentialFor } = require('./authority');
const { createForwarder } = require('../tenant-socket-forwarding');
const windows = require('../../tenant-lifecycle/generation-scope');
const apiConst = require('../../api3/const');
const c = require('./contract');
const metrics = require('../../metrics');
const calcDelta = require('../../data/calcdelta');
const room = (tenant, namespace, collection = '*') => JSON.stringify([tenant, namespace, collection]);
// Publish on change (decision cost-proportional-to-activity), level-triggered.
// Per socket the protocol holds its rights, when they were last confirmed
// (authorizedAt) and the frame it was last sent (view: its sent revision).
// A socket is sent its tenant's current frame whenever it is behind it, its
// rights allow read, and its authorization is still valid: confirmed within
// authorizationValidMs and not past the credential's expiry. One fixed-rate
// sweep renews authorizations. An error (an api that cannot answer, a failed
// read, a slow client) withholds frames and never disconnects: the socket is
// sent the frame it is behind once the error has passed. Only a completed
// read that refuses the socket retires it.
// Decision no-realtime-fast-path: the frame stays the evaluator's output, and a
// socket that holds the previous frame is sent the change as a single site
// sends it (lib/data/calcdelta.js against the frame that socket last received).
// A new or re-authorized socket, a lost or out-of-order base, a settings
// identity change, a removed reading, and a change calcDelta cannot express (a
// devicestatus or dbstats change alone) get the full frame (delta:false).
const DEFAULT_RECHECK_MS = 30000;
const RECHECK_CONCURRENCY = 8;
const RETRY = Object.freeze({ minMs: 250, maxMs: 5000 });
// Codes that end a socket: each is a completed read that refused it. Anything
// else (pool pressure, timeouts, an api that cannot answer) is retried while
// the socket stays connected.
const REFUSALS = new Set(['REALTIME_SOCKET_REFUSED', 'REALTIME_CLIENT_DENIED', 'REALTIME_AUTHORITY_RESPONSE_REFUSED',
  'REALTIME_COLLECTION_REFUSED', 'REALTIME_DISPLAY_REFUSED', 'REALTIME_CLOSED', 'SOCKET_ADMISSION_REFUSED',
  'SOCKET_CREDENTIAL_REFUSED', 'SOCKET_NAMESPACE_REFUSED', 'SOCKET_ADMISSION_EXPANSION_RESTART', 'REALTIME_RESTART_REQUIRED']);
const refused = error => REFUSALS.has(error?.code) || windows.isSuspension(error);
// Decision realtime-no-socket-cap: there is no per-process socket total (a
// single site has none, and a process-wide total let reconnect ghosts shut
// every tenant out). Every server-side disconnect goes through one function
// that counts it under one of these causes; a refusal also records the code
// that caused it. Handshake refusals (engine allowRequest, namespace
// middleware) are not disconnects of a connected socket and are counted apart.
const CAUSES = Object.freeze({
  CLOSED: 'REALTIME_CLOSED_AT_BIND', NAMESPACE: 'REALTIME_NAMESPACE_REFUSED', UNPREPARED: 'REALTIME_HANDSHAKE_UNPREPARED',
  CREDENTIAL: 'REALTIME_CREDENTIAL_REFUSED', PRIME_REFUSED: 'REALTIME_PRIME_REFUSED', PRIME_WINDOW: 'REALTIME_PRIME_WINDOW_INVALIDATED',
  RECHECK_REFUSED: 'REALTIME_RECHECK_REFUSED', RECHECK_READ_LOST: 'REALTIME_RECHECK_READ_LOST',
  RETRO_WINDOW: 'REALTIME_RETRO_WINDOW_INVALIDATED', RETRO_REFUSED: 'REALTIME_RETRO_REFUSED', WRITE_WINDOW: 'REALTIME_WRITE_WINDOW_INVALIDATED',
  ALARM_READ_LOST: 'REALTIME_ALARM_READ_LOST', ALARM_REFUSED: 'REALTIME_ALARM_REFUSED',
  TENANT_INVALIDATED: 'REALTIME_TENANT_INVALIDATED', STORAGE_CONTINUITY:'REALTIME_STORAGE_CONTINUITY_LOST', UNAUTHORIZED_DEADLINE: 'REALTIME_UNAUTHORIZED_DEADLINE' });
// A socket that holds no authorization answer and has no authorization
// pending is closed after this long. A socket whose authorization waits on the
// api (not ready, timed out, warming) or on its tenant's warm is never closed
// by it: the deadline is re-armed instead.
const DEFAULT_UNAUTHORIZED_DEADLINE_MS = 60000;
const reasonOf = error => typeof error?.code === 'string' ? error.code : windows.isSuspension(error) ? 'LIFECYCLE_SUSPENSION' : 'UNSPECIFIED';
function origin (request) {
  const value = request.headers?.origin;
  if (value === undefined) return true; // native clients do not supply Origin
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/' &&
      parsed.protocol === (request.socket?.encrypted ? 'https:' : 'http:') && parsed.host.toLowerCase() === request.headers.host.toLowerCase();
  } catch { return false; }
}
// The view a main socket shows: the frame without its acquisition time, and
// the configuration that builds its status. Equal views send nothing.
function sameView (previous, next) {
  if (previous && previous === next) return true;
  if (!previous || previous.identity !== next.identity) return false;
  const view = frame => { const copy = { ...frame }; delete copy.lastUpdated; return copy; };
  return isDeepStrictEqual(view(previous.frame || {}), view(next.frame || {}));
}
// Every carrier the stock clients send is a signed JWT with `exp` (legacy
// exchanged token, access token, human session). The api verified it at
// authorization; the decoded claim only schedules the recheck that lapses it.
// The order of two published outputs, when both carry a numeric checkpoint
// (the completed output revision); null when they cannot be compared.
function order (base, next) {
  try { const a = BigInt(String(base.checkpoint)), b = BigInt(String(next.checkpoint)); return a < b ? -1 : a > b ? 1 : 0; }
  catch { return null; }
}
// A reading the base holds inside next's window that next no longer holds: a
// delete (or an edited value). A delta only adds readings, so such a change
// is sent as a full frame even when other rows changed in the same cycle.
// Device status is left to the single-site merge: next keeps the ten newest
// per device and type, so an older status leaving it is not a delete.
const readingKey = row => row.mills + '|' + (row.sgv ?? row.mgdl ?? '');
function readingRemoved (base, next) {
  return ['sgvs', 'mbgs', 'cals'].some(key => {
    const before = base[key], after = next[key];
    if (!Array.isArray(before) || !Array.isArray(after) || !before.length) return false;
    const floor = after.length ? Math.min(...after.map(row => row.mills)) : -Infinity, kept = new Set(after.map(readingKey));
    return before.some(row => row.mills >= floor && !kept.has(readingKey(row)));
  });
}
// The delta from the frame a socket holds (base) to next, or null for a full
// frame. calcDelta copies changed rows by reference and normalizes _id in
// place, so it runs on copies of the published arrays.
function deltaFrame (base, next) {
  if (!base?.frame || !next?.frame || base.identity !== next.identity || order(base, next) === 1 || readingRemoved(base.frame, next.frame)) return null;
  const copy = frame => { const value = { ...frame }; for (const key of ['treatments', 'food']) if (Array.isArray(value[key])) value[key] = value[key].map(row => ({ ...row })); return value; };
  const delta = calcDelta(copy(base.frame), copy(next.frame));
  return delta.delta === true ? delta : null;
}
// The profile a single site reports in status (lastProfileFromSwitch): the
// newest Profile Switch treatment created before now.
function profileSwitch (frame, at = Date.now()) {
  let latest = null, mills = -Infinity;
  for (const row of frame?.treatments || []) {
    if (row?.eventType !== 'Profile Switch') continue;
    const created = new Date(row.created_at).getTime();
    if (created < at && created > mills) { mills = created; latest = row.profile; }
  }
  return latest;
}
function expiryOf (credential) {
  let earliest = null;
  for (const value of Object.values(credential || {})) {
    const parts = typeof value === 'string' ? value.split('.') : [];
    if (parts.length !== 3) continue;
    try {
      const exp = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.exp;
      if (Number.isSafeInteger(exp) && exp > 0 && (earliest === null || exp * 1000 < earliest)) earliest = exp * 1000;
    } catch { /* not a JWT carrier: the periodic recheck covers it */ }
  }
  return earliest;
}
function create (options) {
  const { admission, api, readCurrent, runtime, domains, operationWindow, humanSessionsEnabled = false, humanAccepts,
    authorizationRecheckMs = DEFAULT_RECHECK_MS, unauthorizedDeadlineMs = DEFAULT_UNAUTHORIZED_DEADLINE_MS,
    retry = RETRY, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = options;
  // The revocation bound: a socket is sent frames only while its last
  // confirmation is younger than this. The sweep runs three times per recheck
  // interval and renews each authorization about once per interval (the api
  // load of one recheck per interval). A failed renewal withholds frames
  // immediately and makes the socket due for the next sweep.
  const authorizationValidMs = options.authorizationValidMs ?? Math.floor(authorizationRecheckMs * 1.5);
  const sweepMs = Math.max(1, Math.ceil(authorizationRecheckMs / 3)), renewAfterMs = authorizationRecheckMs - Math.floor(sweepMs / 2);
  if (Object.hasOwn(options, 'maxSockets')) throw new TypeError('Realtime has no per-process socket cap (decision realtime-no-socket-cap)');
  if ([admission?.resolve, api?.authorizeSocket, api?.executeSocketMutation, readCurrent, runtime].some(fn => typeof fn !== 'function') || !Array.isArray(domains)) throw new TypeError('Realtime protocol requires explicit bounded trusted adapters');
  if (!c.integer(unauthorizedDeadlineMs, 2147483647)) throw new TypeError('Realtime unauthorized-socket deadline required');
  if (operationWindow !== undefined && typeof operationWindow.run !== 'function') throw new TypeError('Realtime operation window required');
  if (humanSessionsEnabled && typeof humanAccepts !== 'function') throw new TypeError('Configured human socket metadata selector required');
  if (!c.integer(authorizationValidMs, 2147483647) || authorizationValidMs < authorizationRecheckMs) throw new TypeError('Realtime authorization validity must cover one recheck interval');
  if (!c.integer(authorizationRecheckMs, 2147483647) || !c.integer(retry?.minMs, 2147483647) || !c.integer(retry?.maxMs, 2147483647) || retry.maxMs < retry.minMs) throw new TypeError('Realtime authorization recheck and retry bounds required');
  const withOperation = (tenant, fn, onInvalidated) => operationWindow ? operationWindow.run(tenant, fn, {onInvalidated}) : fn();
  const states = new Set(), tenantStates = new Map(), prepared = new WeakMap(), interests = new Map(), storageInterests = new Map(); let closed = false;
  // Tenants with a socket left behind its tenant's frame by an error; the
  // runtime's level pass sends them the frame again (lagging()).
  const behind = new Set();
  // Socket totals are kept as they change: stats never walks the sockets.
  const totals = { primed: 0, authorized: 0 };
  function tracked (state) {
    let primed = false, rights = null;
    Object.defineProperties(state, {
      primed: { enumerable: true, get: () => primed, set (value) { value = !!value; if (states.has(state) && value !== primed) totals.primed += value ? 1 : -1; primed = value; } },
      rights: { enumerable: true, get: () => rights, set (value) { if (states.has(state) && !!value !== !!rights) totals.authorized += value ? 1 : -1; rights = value; } } });
    return state;
  }
  // Membership changes synchronously in both rosters. Keep live Set iteration
  // for fanout/alarm/invalidation, including sockets removed during callbacks;
  // recheck still snapshots its targets before awaiting authority.
  function * peers (tenant) {
    let local = tenantStates.get(tenant);
    while (local) {
      yield * local;
      // A callback can remove the last socket and bind a replacement while
      // this iterator is suspended. Follow the new roster, as the global Set
      // did, without retaining empty tenant rosters after disconnect.
      const next = tenantStates.get(tenant);
      if (next === local) break;
      local = next;
    }
  }
  function addState (state) {
    if (!tenantStates.has(state.tenant)) tenantStates.set(state.tenant, new Set());
    states.add(state); tenantStates.get(state.tenant).add(state);
  }
  function removeState (state) {
    if (states.has(state)) { if (state.primed) totals.primed--; if (state.rights) totals.authorized--; }
    states.delete(state);
    const local = tenantStates.get(state.tenant);
    if (!local) return;
    local.delete(state);
    if (!local.size) tenantStates.delete(state.tenant);
  }
  // Interest is registered before the first priming snapshot, including a
  // request still awaiting authority. A CDC hint cannot fall between that
  // snapshot and registration. Counts are cached, never roster scans.
  function interest (state) {
    const next = !closed && !state.closed && !state.retired && (!!state.rights || state.authorizing > 0);
    if (next === !!state.interested) return;
    const count = (interests.get(state.tenant) || 0) + (next ? 1 : -1);
    if (count) interests.set(state.tenant, count); else interests.delete(state.tenant);
    if(state.namespace==='/storage'){const count=(storageInterests.get(state.tenant)||0)+(next?1:-1);if(count)storageInterests.set(state.tenant,count);else storageInterests.delete(state.tenant);}
    state.interested = next;
  }
  const humanHandshakes = new WeakMap();
  const humanCredential = token => Object.freeze({ humanToken: token });
  // Per-tenant priming queues: concurrent connects share one authorization
  // per distinct credential and one operation window per batch, and a batch
  // that meets pool pressure is retried, never answered with a disconnect.
  const queues = new Map();
  const counters = { authorizeCalls: 0, framesSent: 0, deltaFrames: 0, fullFrames: 0, primeRetries: 0, invalidated: 0,
    recheckFailures: 0, withheld: 0, sweeps: 0, sweepsSkipped: 0, authorizeInFlight: 0, authorizeInFlightMax: 0,
    deadlineDeferred: 0, storageHints: 0, storageStale: 0, storageSent: 0 };
  // Per cause; per cause and refusal code; handshake refusals per code.
  const disconnects = {}, disconnectReasons = {}, handshakeRefusals = {};
  const bump = (table, key) => { table[key] = (table[key] || 0) + 1; };
  // One count per socket: a window invalidation can both call back and reject.
  const ended = new WeakSet();
  function disconnect (socket, cause, reason) {
    if (ended.has(socket)) return;
    ended.add(socket);
    bump(disconnects, cause);
    if (reason !== undefined) bump(disconnectReasons, cause + ':' + reason);
    // A namespace DISCONNECT disables the stock client's reconnect. Continuity
    // loss requires a fresh subscribe and APIv3 history read on reconnect.
    if (cause === CAUSES.STORAGE_CONTINUITY && socket.conn?.close) socket.conn.close(true);
    else socket.disconnect(true);
  }
  function writable (state) {
    const buffered = state.socket.conn?.writeBuffer || [];
    let bytes = 0;
    for (const packet of buffered) { const data=packet.data; bytes += typeof data === 'string' ? Buffer.byteLength(data) : Buffer.isBuffer(data) ? data.length : 0; }
    if (buffered.length >= 128 || bytes >= 4 * 1024 * 1024) c.fail('REALTIME_SLOW_CLIENT');
  }
  function send (state, event, value) {
    if (closed || state.closed) c.fail('REALTIME_CLOSED');
    writable(state);
    if (event === 'dataUpdate') counters.framesSent++;
    state.socket.emit(event, value);
  }
  function epoch (state, revision, primed = false) {
    if (closed || state.closed || state.revision !== revision || primed && !state.primed) c.fail('REALTIME_SOCKET_EPOCH_CHANGED');
  }
  function retire (state, cause, reason) {
    state.primed = false; state.retired = true; interest(state);
    disconnect(state.socket, cause, reason);
  }
  const keyOf = state => JSON.stringify([state.namespace, state.host, state.credential]);
  function validRights (rights) {
    if (rights.denied === true) c.fail('REALTIME_CLIENT_DENIED');
    if (!c.object(rights.permissions) || ['read', 'write', 'write_treatment', 'ack'].some(k => typeof rights.permissions[k] !== 'boolean') ||
        !Array.isArray(rights.collections) || rights.collections.some(col => !domains.includes(col))) c.fail('REALTIME_AUTHORITY_RESPONSE_REFUSED');
    if (rights.display && (!['mg/dl', 'mmol'].includes(rights.display.units) || typeof rights.display.showSeconds !== 'boolean')) c.fail('REALTIME_DISPLAY_REFUSED');
    return rights;
  }
  // The reads one batch of a tenant's sockets shares (a prime batch, a
  // recheck, an alarm): one tenant configuration read and one api call per
  // distinct (namespace, host, credential). Admission also checks the socket's
  // wire selectors and trusted peer, so each socket resolves its own request.
  function reads (tenant) {
    const calls = new Map(); let config;
    return {
      config: () => config || (config = Promise.resolve().then(() => readCurrent(tenant))),
      authorize (state) {
        const key = keyOf(state);
        if (!calls.has(key)) {
          counters.authorizeCalls++; counters.authorizeInFlight++;
          counters.authorizeInFlightMax = Math.max(counters.authorizeInFlightMax, counters.authorizeInFlight);
          calls.set(key, Promise.resolve(api.authorizeSocket({ host: state.host, tenant: state.tenant, namespace: state.namespace, credential: state.credential }))
            .finally(() => { counters.authorizeInFlight--; }).then(validRights));
        }
        return calls.get(key);
      }
    };
  }
  async function admitted (state, batch = reads(state.tenant)) {
    if (closed || state.closed || await admission.resolve(state.socket.request) !== state.tenant || !await batch.config()) c.fail('REALTIME_SOCKET_REFUSED');
  }
  async function current (state, batch = reads(state.tenant)) {
    const revision = state.revision;
    await admitted(state, batch);
    epoch(state, revision);
    const rights = await batch.authorize(state);
    epoch(state, revision);
    return rights;
  }
  // Every carrier the stock clients send is a signed JWT with `exp`: frames
  // stop at that instant, and the sweep's next recheck lets the api refuse it.
  function remember (state, rights, at = now()) {
    state.rights = rights; state.authorizedAt = at; state.expiresAt = expiryOf(state.credential); interest(state);
  }
  const valid = (state, at = now()) => state.authorizedAt !== null && at - state.authorizedAt < authorizationValidMs && (state.expiresAt === null || at < state.expiresAt);
  function dataFrame (state, next, rights, config, body = next.frame, status = true) {
    const frame = { ...body };
    if (status && (state.wantStatus || rights.display)) {
      const settings = config.env.settings.filteredSettings(config.env.settings);
      if (rights.display) { settings.units = rights.display.units; settings.showSeconds = rights.display.showSeconds; }
      frame.status = { status: 'ok', name: require('../../../package.json').name,
        version: require('../../../package.json').version, serverTime: new Date().toISOString(), apiEnabled: true,
        // The status route's view: typed operator values plus the single-site devicestatus defaults.
        settings, extendedSettings: config.env.settings.filteredSettings(config.env.extendedSettings) };
    }
    return frame;
  }
  const clients = tenant => { let count=0; for (const peer of peers(tenant)) if(peer.namespace==='/' && peer.primed && !peer.closed) count++; return count; };
  // One logical request owns its pending count through authority, parking and
  // frame retries. Reauthorization supersedes that request even while its
  // authority or frame read is in flight; their late answers cannot send.
  function requestCurrent (item) {
    const { state, revision } = item;
    return !closed && !state.closed && state.revision === revision && state.request === item;
  }
  function pruneQueue (tenant, entry) {
    if (entry.running || entry.pending.size || queues.get(tenant) !== entry) return;
    clearTimer(entry.timer); entry.timer = null; queues.delete(tenant);
  }
  // Resolves when this request is served, refused, superseded or cancelled.
  // A request that meets pressure stays pending while it is retried.
  function queue (state, message, callback, revision) {
    if (closed || state.closed) return Promise.resolve();
    state.request?.settle();
    let entry = queues.get(state.tenant);
    if (!entry) { entry = { pending: new Map(), running: null, attempt: 0, timer: null }; queues.set(state.tenant, entry); }
    let resolveDone, settled = false; const done = new Promise(resolve => { resolveDone = resolve; });
    const item = { state, message, callback, revision, settle () {
      if (settled) return;
      settled = true;
      if (state.request === item) state.request = null;
      if (entry.pending.get(state) === item) entry.pending.delete(state);
      state.authorizing--; interest(state); resolveDone(); pruneQueue(state.tenant, entry);
    } };
    state.request = item; state.authorizing++; interest(state);
    entry.pending.set(state, item);
    if (!entry.running && !entry.timer) entry.running = drain(state.tenant, entry);
    return done;
  }
  function abandon (entry) { for (const item of entry.pending.values()) item.settle(); entry.pending.clear(); }
  function later (tenant, entry) {
    counters.primeRetries++;
    const delay = Math.min(retry.maxMs, retry.minMs * 2 ** Math.min(entry.attempt++, 16));
    entry.timer = setTimer(() => { entry.timer = null; if (!closed && entry.pending.size && !entry.running) entry.running = drain(tenant, entry); },
      Math.round(delay / 2 + Math.random() * delay / 2));
    entry.timer?.unref?.();
  }
  async function drain (tenant, entry) {
    try {
      while (!closed && entry.pending.size) {
        const batch = [...entry.pending.values()]; entry.pending.clear();
        const retryable = (await prime(tenant, batch)).filter(requestCurrent);
        for (const item of batch) if (!retryable.includes(item)) item.settle();
        if (retryable.length) {
          for (const item of retryable) { if (!entry.pending.has(item.state)) entry.pending.set(item.state, item); else item.settle(); }
          later(tenant, entry); return;
        }
        entry.attempt = 0;
      }
    } finally {
      entry.running = null;
      pruneQueue(tenant, entry);
    }
  }
  function refuse (item, error) {
    const { state, callback } = item;
    if (!requestCurrent(item)) return;
    state.primed = false;
    if (!closed && !state.closed && typeof callback === 'function' && state.namespace !== '/') callback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
    if (requestCurrent(item)) retire(state, CAUSES.PRIME_REFUSED, reasonOf(error));
  }
  // Returns the items to retry later. Authorization runs outside the window
  // (it is the api's work); every send runs inside it.
  async function prime (tenant, batch) {
    const shared = reads(tenant), retryable = [], ready = [];
    await Promise.all(batch.map(async item => {
      const { state } = item;
      if (!requestCurrent(item)) return;
      // A batch that was retried keeps its authorization for one recheck
      // interval: waiting costs no api call.
      if (item.rights && now() - item.authorizedAt < authorizationRecheckMs) { ready.push(item); return; }
      try {
        const rights = await current(state, shared);
        if (!requestCurrent(item)) return;
        item.rights = rights; item.authorizedAt = now(); ready.push(item);
      }
      catch (error) { if (!requestCurrent(item)) return; if (refused(error)) refuse(item, error); else retryable.push(item); }
    }));
    const main = [];
    for (const item of ready) {
      const { state, message, callback, rights } = item;
      if (!requestCurrent(item)) continue;
      if (state.namespace === '/storage') {
        try {
          const selected = message.collections === undefined ? domains : message.collections;
          if (!Array.isArray(selected) || selected.some(value => typeof value !== 'string')) c.fail('REALTIME_COLLECTION_REFUSED');
          state.collections = [...new Set(selected)].filter(value => domains.includes(value) && rights.collections.includes(value));
          remember(state, rights, item.authorizedAt); state.primed = false;
          // Establish this session's high-water mark before becoming visible.
          for (const logical of state.collections) {
            if (!requestCurrent(item)) break;
            await state.socket.join(room(state.tenant, state.namespace, logical));
          }
          if (!requestCurrent(item)) continue;
          state.primed=true;
          if (typeof callback === 'function') callback(state.collections.length ? { success: true, collections: state.collections }
            : { success: false, message: apiConst.MSG.SOCKET_UNAUTHORIZED_TO_ANY });
        } catch (error) { refuse(item,error); }
      } else if (state.namespace === '/alarm') {
        remember(state, rights, item.authorizedAt); state.primed = rights.permissions.read;
        if (rights.permissions.read) await state.socket.join(room(state.tenant, state.namespace));
        if (!requestCurrent(item)) continue;
        if (typeof callback === 'function') callback({ success: true, message: 'Subscribed for alarms',
          ...(!state.credential.accessToken ? { read: rights.permissions.read, ack: rights.permissions.ack } : {}) });
      } else if (!rights.permissions.read) {
        remember(state, rights, item.authorizedAt); state.primed = false;
        send(state, 'connected'); if (typeof callback === 'function') callback(rights.permissions);
      } else {
        try {
          remember(state, rights, item.authorizedAt);
          await state.socket.join(room(state.tenant, state.namespace));
          if (!requestCurrent(item)) continue;
          // No frame sent yet: the socket is behind any frame its tenant holds.
          state.primed = true; state.view = null; main.push(item);
        } catch (error) { if (requestCurrent(item)) { if (refused(error)) refuse(item, error); else retryable.push(item); } }
      }
    }
    if (!main.length) return retryable;
    // The tenant's frame, when this process holds one, goes to the new
    // sockets now and before their acknowledgement, as a single site sends
    // it. A tenant with no frame yet answers at once: its sockets are sent
    // the frame when the runtime has read it (BF-233: a socket never reads
    // its tenant's output itself).
    try {
      await withOperation(tenant, () => deliver({ tenant, only: main.map(item => item.state) }),
        () => { for (const item of main) if (requestCurrent(item)) retire(item.state, CAUSES.PRIME_WINDOW); });
    } catch { behind.add(tenant); }
    for (const item of main) {
      const { state, callback, rights } = item;
      if (!requestCurrent(item) || !state.primed) continue;
      try { send(state, 'connected'); if (typeof callback === 'function') callback(rights.permissions); }
      catch { counters.withheld++; }
    }
    // The cell may be behind the durable output: have it checked now.
    const rt = runtime();
    if (typeof rt?.wake === 'function') rt.wake(tenant);
    return retryable;
  }
  // Revocation, role and display changes: one api call per distinct
  // credential among the tenant's sockets due a renewal. A refusal
  // disconnects. An inconclusive read keeps the socket connected but clears
  // its confirmation. Only a check started after that failure may renew it.
  async function recheck (tenant, { force = false } = {}) {
    const shared = reads(tenant), at = now(); let renewed = false;
    const targets = [...peers(tenant)].filter(state => state.primed && !state.closed && state.rights &&
      (force || at - state.authorizedAt >= renewAfterMs || !valid(state, at)));
    await Promise.all(targets.map(async state => {
      const revision = state.revision, authorizationEpoch = state.authorizationEpoch, before = state.rights;
      let rights;
      try { rights = await current(state, shared); }
      catch (error) {
        if (revision !== state.revision || state.closed || closed) return;
        if (refused(error)) { counters.invalidated++; retire(state, CAUSES.RECHECK_REFUSED, reasonOf(error)); }
        else {
          state.authorizedAt = null;
          state.authorizationEpoch++;
          counters.recheckFailures++;
        }
        return;
      }
      if (revision !== state.revision || authorizationEpoch !== state.authorizationEpoch || state.closed || closed) return;
      remember(state, rights);
      if (state.namespace === '/storage') {
        const removed = state.collections.filter(col => !rights.collections.includes(col));
        state.collections = state.collections.filter(col => rights.collections.includes(col));
        for (const logical of removed) await state.socket.leave(room(state.tenant, state.namespace, logical));
      } else if (!rights.permissions.read) { counters.invalidated++; retire(state, CAUSES.RECHECK_READ_LOST); }
      else if (state.namespace === '/') {
        // Changed rights or display: the next frame is a full one built for them.
        if (!isDeepStrictEqual(before.display, rights.display) || !isDeepStrictEqual(before.permissions, rights.permissions)) state.view = null;
        renewed = true;
      }
    }));
    // A renewed socket is sent whatever frame it fell behind while its
    // authorization could not be confirmed.
    if (renewed && !closed) await withOperation(tenant, () => deliver({ tenant })).catch(() => { behind.add(tenant); });
  }
  // One fixed-rate sweep, armed once here. A sweep still walking when the
  // next is due is not doubled, and a socket is rechecked only when its
  // confirmation is due a renewal.
  let sweepTimer = null, sweeping = null;
  function sweep () {
    if (closed) return;
    sweepTimer = setTimer(sweep, sweepMs); sweepTimer?.unref?.();
    if (sweeping) { counters.sweepsSkipped++; return; }
    counters.sweeps++;
    // A bounded number of tenants at a time. Measured at 1,000 tenants: all at
    // once put 1,000 authorizations in flight and hundreds timed out each sweep.
    sweeping = require('../serve/tenant-startup').limited([...tenantStates.keys()], RECHECK_CONCURRENCY, tenant => recheck(tenant)).finally(() => { sweeping = null; });
  }
  sweepTimer = setTimer(sweep, sweepMs); sweepTimer?.unref?.();
  // The unauthorized-socket deadline (decision realtime-no-socket-cap). It
  // closes a socket that has no authorization answer (state.rights) and no
  // request pending; a socket whose request is waiting (api not ready, timed
  // out or warming) is re-armed, never closed. A socket that was
  // answered keeps its connection whatever its rights: the stock web client
  // re-sends authorize on the same socket after the user signs in
  // (lib/client/hashauth.js updateSocketAuth), and a refusal already closed it.
  function armDeadline (state) {
    state.deadlineTimer = setTimer(() => {
      state.deadlineTimer = null;
      if (closed || state.closed || state.rights) return;
      if (state.authorizing > 0) { counters.deadlineDeferred++; armDeadline(state); return; }
      disconnect(state.socket, CAUSES.UNAUTHORIZED_DEADLINE);
    }, unauthorizedDeadlineMs);
    state.deadlineTimer?.unref?.();
  }
  function bind (socket, namespace) {
    if (closed) { disconnect(socket, CAUSES.CLOSED); return; }
    if (!['/', '/storage', '/alarm'].includes(namespace)) { disconnect(socket, CAUSES.NAMESPACE); return; }
    if (!prepared.has(socket)) { disconnect(socket, CAUSES.UNPREPARED); return; }
    const state = tracked({ socket, namespace, tenant: prepared.get(socket), host: socket.request.headers.host,
      credential: humanHandshakes.has(socket) ? humanCredential(humanHandshakes.get(socket)) : Object.freeze({}),
      wantStatus: false, revision: 0, collections: [], closed: false, authorizationEpoch: 0, authorizedAt: null, expiresAt: null, view: null,
      authorizing: 0, request: null, deadlineTimer: null });
    addState(state);
    socket.on('disconnect', () => { state.closed = true; state.request?.settle(); interest(state); clearTimer(state.deadlineTimer); state.deadlineTimer = null; removeState(state); });
    armDeadline(state);
    const authorize = (message, callback) => {
      try {
        const normalized = credentialFor(namespace, message);
        const human = humanHandshakes.get(socket);
        if (human && Object.values(normalized).some(value => value !== human)) c.fail('SOCKET_CREDENTIAL_REFUSED');
        const recognized = humanSessionsEnabled && Object.values(normalized).find(value => humanAccepts(value));
        if ((human || recognized || normalized.humanToken !== undefined) && Object.keys(normalized).length > 1) c.fail('SOCKET_CREDENTIAL_REFUSED');
        state.credential = human ? humanCredential(human) : recognized ? humanCredential(recognized) : normalized;
        state.wantStatus = message?.status === true; state.revision++; state.primed = false; state.rights = null; interest(state); state.view = null;
        state.collections = [];
        for (const old of socket.rooms || []) if (old !== socket.id) socket.leave(old);
        return queue(state, message || {}, callback, state.revision);
      } catch (error) { disconnect(socket, CAUSES.CREDENTIAL, reasonOf(error)); }
    };
    if (namespace === '/') {
      socket.on('authorize', authorize);
      socket.on('loadRetro', (options, callback) => withOperation(state.tenant, async () => {
        const revision = state.revision, authorizationEpoch = state.authorizationEpoch;
        try {
          // Retro is a rare client request: it is authorized when asked.
          if (!(await current(state)).permissions.read) c.fail('REALTIME_SOCKET_REFUSED');
          const next = runtime().last?.(state.tenant) || await runtime().refresh(state.tenant);
          const config = await readCurrent(state.tenant);
          if (closed || state.closed || !config || config.identity !== next.identity) c.fail('REALTIME_CYCLE_CHANGED');
          epoch(state, revision, true);
          if (authorizationEpoch !== state.authorizationEpoch) c.fail('SOCKET_ADMISSION_UNAVAILABLE');
          if (typeof callback === 'function') callback({ result: 'success' });
          send(state, 'retroUpdate', { devicestatus: next.frame.devicestatus });
        } catch { if (revision === state.revision && !closed && !state.closed && typeof callback === 'function') callback({ result: 'Not permitted' }); }
      }, () => disconnect(socket, CAUSES.RETRO_WINDOW)).catch(error => { disconnect(socket, CAUSES.RETRO_REFUSED, reasonOf(error)); }));
    } else socket.on('subscribe', authorize);
    if (namespace !== '/storage') createForwarder({
      withOperation: (tenant, fn) => withOperation(tenant, fn, () => disconnect(socket, CAUSES.WRITE_WINDOW)),
      async contextForSocket () {
        const revision = state.revision;
        await admitted(state);
        epoch(state, revision);
        return { tenant: state.tenant, credential: state.credential };
      },
      async transport (envelope) {
        const revision = state.revision;
        const response = await api.executeSocketMutation({ host: state.host, envelope });
        epoch(state, revision);
        return response;
      }
    }).bind(socket, namespace);
    if (namespace !== '/storage') queue(state, {}, undefined, 0);
  }
  // Level-triggered send. Every main socket of the tenant that is behind
  // `next` (the frame its tenant's cell holds), may read and holds a valid
  // authorization is sent it: the delta from the frame it was last sent, or
  // the full frame. One configuration read serves the whole pass, and only
  // when a socket has something to receive. A socket that cannot be sent to
  // is skipped, never disconnected.
  async function deliver ({ tenant, previous, next = runtime()?.last?.(tenant), assertCurrent, availableAt = null, only }) {
    if (assertCurrent !== undefined && typeof assertCurrent !== 'function') throw new TypeError('Realtime fanout epoch assertion required');
    const assertFanout = () => assertCurrent?.();
    if (!next) return;
    let samePrevious;
    const frames = new Map(), groups = new Map(), deltas = new Map(), bases = new Map(), delivered = [];
    function sharedSend (state, key, event, value) {
      writable(state);
      if (typeof state.socket.nsp?.to === 'function' && typeof state.socket.id === 'string') {
        if (!groups.has(key)) groups.set(key, { namespace: state.socket.nsp, ids: [], event, value });
        groups.get(key).ids.push(state.socket.id);
        if(event==='dataUpdate')counters.framesSent++;
      } else send(state,event,value);
    }
    // Sockets on the last publication share one comparison. A lagged socket
    // still compares its own view; no result survives this fanout invocation.
    const unchanged = view => {
      if (view !== previous) return sameView(view, next);
      if (samePrevious === undefined) samePrevious = sameView(previous, next);
      return samePrevious;
    };
    // One delta per distinct base the tenant's sockets hold (normally one:
    // the previous publication); a socket's base is the frame it was sent.
    // Bases with an equal view share one delta and one encoding. A single site
    // adds status to a delta only on a profile switch.
    const deltaFor = view => {
      if (!deltas.has(view)) {
        const equal = view && [...deltas.keys()].find(base => base && sameView(base, view));
        if (equal !== undefined) { deltas.set(view, deltas.get(equal)); bases.set(view, bases.get(equal)); }
        else {
          const delta = deltaFrame(view, next);
          deltas.set(view, delta && { delta, switched: profileSwitch(view.frame) !== profileSwitch(next.frame) }); bases.set(view, bases.size);
        }
      }
      return deltas.get(view);
    };
    let traced = { sent: 0, held: 0, delta: 0 };
    const at = now(), targets = [];
    for (const state of only || peers(tenant)) {
      if (state.namespace !== '/' || !state.primed || state.closed || !state.rights?.permissions.read || unchanged(state.view)) continue;
      // Never backwards: a socket already sent a later revision keeps it.
      if (state.view && order(state.view, next) === 1) continue;
      // Not confirmed in time: withheld until the sweep renews it (recheck).
      if (!valid(state, at)) { traced.held++; counters.withheld++; continue; }
      targets.push(state);
    }
    if (targets.length) {
      const config = await readCurrent(tenant);
      assertFanout();
      if (closed || !config || config.identity !== next.identity) { behind.add(tenant); c.fail('REALTIME_CYCLE_CHANGED'); }
      let count = null;
      for (const state of targets) {
        // The read above may have let another pass send this socket the frame.
        if (state.closed || !state.primed || !state.rights?.permissions.read || !valid(state) || unchanged(state.view) || state.view && order(state.view, next) === 1) continue;
        assertFanout();
        try {
          writable(state);
          const delta = deltaFor(state.view);
          const key = JSON.stringify([state.wantStatus, state.rights.display || null, delta ? bases.get(state.view) : null]);
          if (!frames.has(key)) frames.set(key, delta ? dataFrame(state, next, state.rights, config, delta.delta, delta.switched) : dataFrame(state, next, state.rights, config));
          // Socket.IO broadcasts encode once for the exact authorized socket-id
          // rooms. Distinct display preferences and bases retain distinct wire frames.
          sharedSend(state,'main:'+key,'dataUpdate',frames.get(key));
          traced.sent++; if (delta) traced.delta++;
          delivered.push(state);
          if (count === null) count = clients(tenant);
          send(state, 'clients', count);
        } catch { counters.withheld++; behind.add(tenant); }
      }
    }
    assertFanout();
    for (const group of groups.values()) group.namespace.to(group.ids).emit(group.event, group.value);
    // A socket's base moves only once its frame is sent: a fanout withdrawn
    // before the broadcast leaves every socket on the frame it holds.
    for (const state of delivered) state.view = next;
    counters.deltaFrames += traced.delta; counters.fullFrames += traced.sent - traced.delta;
    if (traced.sent && Number.isSafeInteger(availableAt)) metrics.lag('realtime', now() - availableAt);
    if (traced.sent || traced.held) require('../../diagnostics/clinical-stages').fromEnvironment().record('realtime.frame', { tenant, outputRevision: next?.outputRevision ?? next?.checkpoint ?? null, sent: traced.sent, held: traced.held, delta: traced.delta });
  }
  // Spike S2: `/storage` live events arrive from the api after its commit
  // (lib/server/realtime/storage-hint.js), as single tenant emits them. No
  // cursor and no history: a session starts live at subscribe. A socket held
  // while its authority is uncertain cannot be sent the event, so it is
  // disconnected and the client re-syncs over GET /api/v3/{col}/history.
  async function storageHint (hint) {
    const { tenant, generation, events } = require('./storage-hint').validate(hint);
    if (!c.uuid(tenant)) c.fail('REALTIME_STORAGE_REFUSED');
    counters.storageHints++;
    if (!storageInterests.has(tenant)) return { accepted: true, sent: 0 };
    return withOperation(tenant, async () => {
      if (closed || !await readCurrent(tenant)) c.fail('REALTIME_STORAGE_REFUSED');
      if (operationWindow?.currentGeneration && String(operationWindow.currentGeneration(tenant)) !== String(generation)) { counters.storageStale++; return { accepted: false, stale: true }; }
      let sent = 0;
      for (const state of peers(tenant)) {
        if (state.namespace !== '/storage' || !state.primed || state.closed || !state.collections.length) continue;
        const revision = state.revision;
        if (!valid(state) || hint.resync || events.some(change => change.event === 'changed' && state.collections.includes(change.colName))) {
          retire(state, CAUSES.STORAGE_CONTINUITY); continue;
        }
        try {
          epoch(state, revision, true);
          for (const change of events) if (state.collections.includes(change.colName)) { send(state, change.event, require('./storage-hint').wire(change)); sent++; }
        } catch { if (revision === state.revision) retire(state, CAUSES.STORAGE_CONTINUITY); }
      }
      counters.storageSent += sent;
      return { accepted: true, sent };
    });
  }
  async function alarm ({ tenant, notification }) {
    if (!c.uuid(tenant) || !c.object(notification) || !await readCurrent(tenant) || closed) c.fail('REALTIME_ALARM_REFUSED');
    // Alarms are rare and protected: each delivery rechecks current rights,
    // once per distinct credential among the tenant's alarm subscribers.
    const shared = reads(tenant);
    for (const state of peers(tenant)) if (state.namespace === '/alarm' && state.primed && !state.closed) {
      const revision = state.revision, authorizationEpoch = state.authorizationEpoch;
      try {
      const rights = await current(state, shared);
      if (!rights.permissions.read) { retire(state, CAUSES.ALARM_READ_LOST); continue; }
      if (closed || !await readCurrent(tenant)) c.fail('REALTIME_ALARM_REFUSED');
      epoch(state, revision, true);
      if (authorizationEpoch !== state.authorizationEpoch) c.fail('SOCKET_ADMISSION_UNAVAILABLE');
      remember(state, rights);
      const event = notification.clear ? 'clear_alarm' : notification.level === 1 ? 'alarm'
        : notification.level === 2 ? 'urgent_alarm' : notification.isAnnouncement ? 'announcement' : 'notification';
      send(state, event, notification);
      } catch (error) {
        if (!['REALTIME_CLIENT_DENIED', 'REALTIME_SOCKET_EPOCH_CHANGED'].includes(error.code)) throw error;
        if (revision === state.revision) retire(state, CAUSES.ALARM_REFUSED, error.code);
      }
    }
    return { accepted: true };
  }
  return Object.freeze({
    storageHint,
    storageWatched:tenant=>storageInterests.has(tenant),
    watched:tenant=>interests.has(tenant),
    watchedTenants:()=>[...interests.keys()],
    watchedCount:()=>interests.size,
    // source names the caller (admission, activity, role) in the reason counter.
    invalidateTenant (tenant, source = 'UNSPECIFIED') {
      for (const state of peers(tenant)) {
        counters.invalidated++;
        state.revision++; state.primed = false; state.closed = true; state.request?.settle(); interest(state); clearTimer(state.deadlineTimer);
        removeState(state);
        disconnect(state.socket, CAUSES.TENANT_INVALIDATED, source);
      }
      const entry = queues.get(tenant); if (entry) { abandon(entry); clearTimer(entry.timer); entry.timer = null; }
    },
    // Tenants with a socket an error left behind its frame, handed to the
    // runtime's level pass once.
    lagging () { const list = [...behind]; behind.clear(); return list; },
    // Revocation seam: an event that a tenant's authority changed rechecks
    // its sockets now instead of at the next periodic recheck.
    recheckTenant: tenant => recheck(tenant, { force: true }),
    // Counted by the socket server when it refuses an engine handshake or a
    // namespace connect (not a disconnect of a connected socket).
    handshakeRefused (code) { bump(handshakeRefusals, typeof code === 'string' ? code : 'UNSPECIFIED'); },
    async prepare (socket) {
      if (closed || !origin(socket.request)) c.fail('REALTIME_HANDSHAKE_REFUSED');
      if (humanSessionsEnabled) {
        const selected = require('../../human-session/http').credential(socket.request);
        if (selected && (selected.cookie || humanAccepts(selected.token))) {
          if (selected.cookie && typeof socket.request.headers.origin !== 'string') c.fail('REALTIME_HANDSHAKE_REFUSED');
          humanHandshakes.set(socket, selected.token);
        }
      }
      prepared.set(socket, await admission.resolve(socket.request));
    }, bind,
    fanout: operation => withOperation(operation.tenant, () => deliver(operation)),
    alarm: operation => withOperation(operation.tenant, () => alarm(operation)),
    stats: () => Object.freeze({ ...counters, sockets: states.size, primed: totals.primed,
      unauthorized: states.size - totals.authorized,
      queued: [...queues.values()].reduce((sum, entry) => sum + entry.pending.size, 0),
      disconnects: Object.freeze({ ...disconnects }), disconnectReasons: Object.freeze({ ...disconnectReasons }),
      handshakeRefusals: Object.freeze({ ...handshakeRefusals }) }),
    close () {
      closed = true; clearTimer(sweepTimer); sweepTimer = null;
      for (const entry of queues.values()) { clearTimer(entry.timer); abandon(entry); }
      // No server-side disconnect (BF-233): the socket server closes the
      // transports, so clients see a transport close and reconnect.
      for (const state of states) { state.closed = true; state.request?.settle(); interest(state); clearTimer(state.deadlineTimer); }
      states.clear(); tenantStates.clear(); interests.clear(); storageInterests.clear(); behind.clear(); totals.primed = 0; totals.authorized = 0;
    }
  });
}
module.exports = { create, origin, room, sameView, deltaFrame, profileSwitch, expiryOf, DEFAULT_RECHECK_MS, DEFAULT_UNAUTHORIZED_DEADLINE_MS, CAUSES };
