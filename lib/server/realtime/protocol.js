'use strict';

const { isDeepStrictEqual } = require('node:util');
const { credentialFor } = require('./authority');
const { createForwarder } = require('../tenant-socket-forwarding');
const { encodeDocument } = require('../../storage/postgres-identity');
const { normalizeDoc } = require('../../api3/storage/mongoCollection/utils');
const windows = require('../../tenant-lifecycle/operation-window');
const apiConst = require('../../api3/const');
const c = require('./contract');
const room = (tenant, namespace, collection = '*') => JSON.stringify([tenant, namespace, collection]);
// Publish on change (decision cost-proportional-to-activity). A socket is
// authorized when it connects or re-authorizes, then again only on an event:
// the credential's expiry, the periodic revocation recheck, a pause, suspend
// or lifecycle invalidation. Frames are sent when the tenant's view changed;
// their shape (full frames, delta:false) is unchanged.
const DEFAULT_RECHECK_MS = 30000;
const RETRY = Object.freeze({ minMs: 250, maxMs: 5000 });
// Codes that end a socket. Anything else (pool pressure, timeouts, an api that
// cannot answer) is retried while the socket stays connected.
const REFUSALS = new Set(['REALTIME_SOCKET_REFUSED', 'REALTIME_CLIENT_DENIED', 'REALTIME_AUTHORITY_RESPONSE_REFUSED',
  'REALTIME_COLLECTION_REFUSED', 'REALTIME_DISPLAY_REFUSED', 'REALTIME_CLOSED', 'SOCKET_ADMISSION_REFUSED',
  'SOCKET_CREDENTIAL_REFUSED', 'SOCKET_NAMESPACE_REFUSED', 'SOCKET_ADMISSION_EXPANSION_RESTART', 'REALTIME_RESTART_REQUIRED']);
const refused = error => REFUSALS.has(error?.code) || windows.isSuspension(error);
function origin (request) {
  const value = request.headers?.origin;
  if (value === undefined) return true; // native clients do not supply Origin
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === '/' &&
      parsed.protocol === (request.socket?.encrypted ? 'https:' : 'http:') && parsed.host.toLowerCase() === request.headers.host.toLowerCase();
  } catch { return false; }
}
function storageChanges (previous, current) {
  const keyed = rows => new Map((rows || []).map(row => { const id = encodeDocument(row.document); return [JSON.stringify([row.domain, id.id_kind, id.doc._id]), row]; }));
  const old = keyed(previous), fresh = keyed(current), changes = [];
  for (const [key, row] of fresh) {
    const before = old.get(key);
    if (!before || !isDeepStrictEqual(before.document, row.document)) {
      const doc = { ...row.document }; normalizeDoc(doc);
      changes.push({ event: before ? 'update' : 'create', domain: row.domain, value: { colName: row.domain, doc } });
    }
  }
  for (const [key, row] of old) if (!fresh.has(key)) {
    const doc = { ...row.document }; normalizeDoc(doc);
    changes.push({ event: 'delete', domain: row.domain, value: { colName: row.domain, identifier: doc.identifier } });
  }
  return changes;
}
// The view a main socket shows: the frame without its acquisition time, and
// the configuration that builds its status. Equal views send nothing.
function sameView (previous, next) {
  if (!previous || previous.identity !== next.identity) return false;
  const view = frame => { const copy = { ...frame }; delete copy.lastUpdated; return copy; };
  return isDeepStrictEqual(view(previous.frame || {}), view(next.frame || {}));
}
// Every carrier the stock clients send is a signed JWT with `exp` (legacy
// exchanged token, access token, human session). The api verified it at
// authorization; the decoded claim only schedules the recheck that lapses it.
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
function create ({ admission, api, readCurrent, runtime, maxSockets, domains, operationWindow, humanSessionsEnabled = false, humanAccepts,
  authorizationRecheckMs = DEFAULT_RECHECK_MS, retry = RETRY, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if ([admission?.resolve, api?.authorizeSocket, api?.executeSocketMutation, readCurrent, runtime].some(fn => typeof fn !== 'function') || !c.integer(maxSockets) || !Array.isArray(domains)) throw new TypeError('Realtime protocol requires explicit bounded trusted adapters');
  if (operationWindow !== undefined && typeof operationWindow.run !== 'function') throw new TypeError('Realtime operation window required');
  if (humanSessionsEnabled && typeof humanAccepts !== 'function') throw new TypeError('Configured human socket metadata selector required');
  if (!c.integer(authorizationRecheckMs, 2147483647) || !c.integer(retry?.minMs, 2147483647) || !c.integer(retry?.maxMs, 2147483647) || retry.maxMs < retry.minMs) throw new TypeError('Realtime authorization recheck and retry bounds required');
  const withOperation = (tenant, fn, onInvalidated) => operationWindow ? operationWindow.run(tenant, fn, {onInvalidated}) : fn();
  const states = new Set(), prepared = new WeakMap(); let closed = false;
  const humanHandshakes = new WeakMap();
  const humanCredential = token => Object.freeze({ humanToken: token });
  // Per-tenant priming queues: concurrent connects share one authorization
  // per distinct credential and one operation window per batch, and a batch
  // that meets pool pressure is retried, never answered with a disconnect.
  const queues = new Map();
  const counters = { authorizeCalls: 0, framesSent: 0, primeRetries: 0, invalidated: 0 };
  function send (state, event, value) {
    if (closed || state.closed) c.fail('REALTIME_CLOSED');
    if (event === 'dataUpdate') counters.framesSent++;
    state.socket.emit(event, value);
  }
  function epoch (state, revision, primed = false) {
    if (closed || state.closed || state.revision !== revision || primed && !state.primed) c.fail('REALTIME_SOCKET_EPOCH_CHANGED');
  }
  function retire (state) {
    state.primed = false; clearTimer(state.expiryTimer); state.expiryTimer = null;
    state.socket.disconnect(true);
  }
  const keyOf = state => JSON.stringify([state.namespace, state.host, state.credential]);
  async function admitted (state) {
    if (closed || state.closed || await admission.resolve(state.socket.request) !== state.tenant || !await readCurrent(state.tenant)) c.fail('REALTIME_SOCKET_REFUSED');
  }
  function validRights (rights) {
    if (rights.denied === true) c.fail('REALTIME_CLIENT_DENIED');
    if (!c.object(rights.permissions) || ['read', 'write', 'write_treatment', 'ack'].some(k => typeof rights.permissions[k] !== 'boolean') ||
        !Array.isArray(rights.collections) || rights.collections.some(col => !domains.includes(col))) c.fail('REALTIME_AUTHORITY_RESPONSE_REFUSED');
    if (rights.display && (!['mg/dl', 'mmol'].includes(rights.display.units) || typeof rights.display.showSeconds !== 'boolean')) c.fail('REALTIME_DISPLAY_REFUSED');
    return rights;
  }
  // One api call per distinct (namespace, host, credential) within a batch.
  function authorities () {
    const calls = new Map();
    return state => {
      const key = keyOf(state);
      if (!calls.has(key)) {
        counters.authorizeCalls++;
        calls.set(key, Promise.resolve(api.authorizeSocket({ host: state.host, tenant: state.tenant, namespace: state.namespace, credential: state.credential })).then(validRights));
      }
      return calls.get(key);
    };
  }
  async function current (state, authorize = authorities()) {
    const revision = state.revision;
    await admitted(state);
    epoch(state, revision);
    const rights = await authorize(state);
    epoch(state, revision);
    return rights;
  }
  function remember (state, rights) {
    state.rights = rights; state.authorizedAt = now(); state.held = false;
    clearTimer(state.expiryTimer); state.expiryTimer = null;
    const expiresAt = expiryOf(state.credential);
    if (expiresAt !== null) {
      const revision = state.revision;
      state.expiryTimer = setTimer(() => { if (state.revision === revision && !state.closed) recheck(state.tenant, [state]).catch(() => {}); },
        Math.min(Math.max(expiresAt - now(), 0) + 1, 2147483647));
      state.expiryTimer?.unref?.();
    }
  }
  async function frameFor (state, next) {
    const config = await readCurrent(state.tenant);
    if (closed || state.closed || !config || config.identity !== next.identity) c.fail('REALTIME_CYCLE_CHANGED');
    return config;
  }
  function dataFrame (state, next, rights, config) {
    const frame = { ...next.frame };
    if (state.wantStatus || rights.display) {
      const settings = config.env.settings.filteredSettings(config.env.settings);
      if (rights.display) { settings.units = rights.display.units; settings.showSeconds = rights.display.showSeconds; }
      frame.status = { status: 'ok', name: require('../../../package.json').name,
        version: require('../../../package.json').version, serverTime: new Date().toISOString(), apiEnabled: true,
        settings, extendedSettings: config.env.extendedSettings };
    }
    return frame;
  }
  const clients = tenant => [...states].filter(peer => peer.tenant === tenant && peer.namespace === '/' && peer.primed && !peer.closed).length;
  // Resolves when this request is served or refused (or superseded); a
  // request that meets pressure stays pending while it is retried.
  function queue (state, message, callback, revision, resend = false) {
    if (closed || state.closed) return Promise.resolve();
    let entry = queues.get(state.tenant);
    if (!entry) { entry = { pending: new Map(), running: null, attempt: 0, timer: null }; queues.set(state.tenant, entry); }
    let settle; const done = new Promise(resolve => { settle = resolve; });
    entry.pending.get(state)?.settle();
    entry.pending.set(state, { state, message, callback, revision, resend, settle });
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
        const retryable = await prime(tenant, batch);
        for (const item of batch) if (!retryable.includes(item)) item.settle();
        if (retryable.length) {
          for (const item of retryable) { if (!entry.pending.has(item.state)) entry.pending.set(item.state, item); else item.settle(); }
          later(tenant, entry); return;
        }
        entry.attempt = 0;
      }
    } finally {
      entry.running = null;
      if (!entry.pending.size && !entry.timer) queues.delete(tenant);
    }
  }
  function refuse (item) {
    const { state, callback, revision } = item;
    if (revision !== state.revision) return;
    state.primed = false;
    if (!closed && !state.closed && typeof callback === 'function' && state.namespace !== '/') callback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
    retire(state);
  }
  // Returns the items to retry later. Authorization runs outside the window
  // (it is the api's work); data acquisition and every send run inside it.
  async function prime (tenant, batch) {
    const authorize = authorities(), retryable = [], ready = [];
    await Promise.all(batch.map(async item => {
      const { state, revision } = item;
      if (revision !== state.revision || closed || state.closed) return;
      try { ready.push({ ...item, rights: await current(state, authorize) }); }
      catch (error) { if (revision !== state.revision || closed || state.closed) return; if (refused(error)) refuse(item); else retryable.push(item); }
    }));
    const main = [];
    for (const item of ready) {
      const { state, message, callback, rights, revision } = item;
      if (revision !== state.revision || closed || state.closed) continue;
      if (state.namespace === '/storage') {
        try {
          const selected = message.collections === undefined ? domains : message.collections;
          if (!Array.isArray(selected) || selected.some(value => typeof value !== 'string')) c.fail('REALTIME_COLLECTION_REFUSED');
          state.collections = [...new Set(selected)].filter(value => domains.includes(value) && rights.collections.includes(value));
          remember(state, rights); state.primed = true;
          for (const logical of state.collections) await state.socket.join(room(state.tenant, state.namespace, logical));
          if (closed || state.closed || revision !== state.revision) continue;
          if (typeof callback === 'function') callback(state.collections.length ? { success: true, collections: state.collections }
            : { success: false, message: apiConst.MSG.SOCKET_UNAUTHORIZED_TO_ANY });
        } catch { refuse(item); }
      } else if (state.namespace === '/alarm') {
        remember(state, rights); state.primed = rights.permissions.read;
        if (rights.permissions.read) await state.socket.join(room(state.tenant, state.namespace));
        if (closed || state.closed || revision !== state.revision) continue;
        if (typeof callback === 'function') callback({ success: true, message: 'Subscribed for alarms',
          ...(!state.credential.accessToken ? { read: rights.permissions.read, ack: rights.permissions.ack } : {}) });
      } else if (!rights.permissions.read) {
        remember(state, rights); state.primed = false;
        send(state, 'connected'); if (typeof callback === 'function') callback(rights.permissions);
      } else main.push(item);
    }
    if (!main.length) return retryable;
    try {
      await withOperation(tenant, async () => {
        const next = await runtime().refresh(tenant);
        for (const item of main) {
          const { state, callback, rights, revision, resend } = item;
          if (revision !== state.revision || closed || state.closed) continue;
          try {
            const config = await frameFor(state, next);
            epoch(state, revision);
            remember(state, rights);
            if (!resend) await state.socket.join(room(state.tenant, state.namespace));
            state.primed = true; state.view = next;
            send(state, 'dataUpdate', dataFrame(state, next, rights, config));
            send(state, 'clients', clients(tenant));
            if (!resend) { send(state, 'connected'); if (typeof callback === 'function') callback(rights.permissions); }
          } catch (error) { if (revision === state.revision && !closed && !state.closed) { if (refused(error)) refuse(item); else retryable.push(item); } }
        }
      }, () => { for (const item of main) if (item.revision === item.state.revision) retire(item.state); });
    } catch (error) {
      for (const item of main) {
        if (item.revision !== item.state.revision || closed || item.state.closed || item.state.primed && item.state.view) continue;
        if (refused(error)) refuse(item); else retryable.push(item);
      }
    }
    return retryable;
  }
  // Revocation, role and display changes: one api call per distinct
  // credential among the tenant's primed sockets. A refusal disconnects; an
  // api that cannot answer holds the socket's frames until it can.
  async function recheck (tenant, selected) {
    const authorize = authorities();
    const targets = (selected || [...states].filter(state => state.tenant === tenant && state.primed && !state.closed))
      .filter(state => !state.closed && state.rights);
    await Promise.all(targets.map(async state => {
      const revision = state.revision, before = state.rights;
      let rights;
      try { rights = await current(state, authorize); }
      catch (error) {
        if (revision !== state.revision || state.closed || closed) return;
        if (refused(error)) { counters.invalidated++; retire(state); } else state.held = true;
        return;
      }
      if (revision !== state.revision || state.closed || closed) return;
      const wasHeld = state.held;
      remember(state, rights);
      if (state.namespace === '/storage') {
        const removed = state.collections.filter(col => !rights.collections.includes(col));
        state.collections = state.collections.filter(col => rights.collections.includes(col));
        for (const logical of removed) await state.socket.leave(room(state.tenant, state.namespace, logical));
      } else if (!rights.permissions.read) { counters.invalidated++; retire(state); }
      else if (state.namespace === '/' && (wasHeld || !isDeepStrictEqual(before.display, rights.display) || !isDeepStrictEqual(before.permissions, rights.permissions))) {
        queue(state, {}, undefined, revision, true);
      }
    }));
  }
  let sweepTimer = null;
  function sweep () {
    sweepTimer = null; if (closed) return;
    const tenants = new Set([...states].filter(state => state.primed && !state.closed).map(state => state.tenant));
    Promise.allSettled([...tenants].map(tenant => recheck(tenant))).finally(() => {
      if (!closed) { sweepTimer = setTimer(sweep, authorizationRecheckMs); sweepTimer?.unref?.(); }
    });
  }
  function bind (socket, namespace) {
    if (closed || states.size >= maxSockets || !['/', '/storage', '/alarm'].includes(namespace)) { socket.disconnect(true); return; }
    if (!prepared.has(socket)) { socket.disconnect(true); return; }
    const state = { socket, namespace, tenant: prepared.get(socket), host: socket.request.headers.host,
      credential: humanHandshakes.has(socket) ? humanCredential(humanHandshakes.get(socket)) : Object.freeze({}),
      wantStatus: false, revision: 0, primed: false, collections: [], closed: false, rights: null, held: false, expiryTimer: null, view: null };
    if (closed) { socket.disconnect(true); return; }
    states.add(state);
    if (!sweepTimer) { sweepTimer = setTimer(sweep, authorizationRecheckMs); sweepTimer?.unref?.(); }
    socket.on('disconnect', () => { state.closed = true; clearTimer(state.expiryTimer); states.delete(state); });
    const authorize = (message, callback) => {
      try {
        const normalized = credentialFor(namespace, message);
        const human = humanHandshakes.get(socket);
        if (human && Object.values(normalized).some(value => value !== human)) c.fail('SOCKET_CREDENTIAL_REFUSED');
        const recognized = humanSessionsEnabled && Object.values(normalized).find(value => humanAccepts(value));
        if ((human || recognized || normalized.humanToken !== undefined) && Object.keys(normalized).length > 1) c.fail('SOCKET_CREDENTIAL_REFUSED');
        state.credential = human ? humanCredential(human) : recognized ? humanCredential(recognized) : normalized;
        state.wantStatus = message?.status === true; state.revision++; state.primed = false; state.rights = null; state.view = null;
        clearTimer(state.expiryTimer); state.expiryTimer = null;
        state.collections = [];
        for (const old of socket.rooms || []) if (old !== socket.id) socket.leave(old);
        return queue(state, message || {}, callback, state.revision);
      } catch { socket.disconnect(true); }
    };
    if (namespace === '/') {
      socket.on('authorize', authorize);
      socket.on('loadRetro', (options, callback) => withOperation(state.tenant, async () => {
        const revision = state.revision;
        try {
          // Retro is a rare client request: it is authorized when asked.
          if (!(await current(state)).permissions.read) c.fail('REALTIME_SOCKET_REFUSED');
          const next = await runtime().refresh(state.tenant);
          await frameFor(state, next);
          epoch(state, revision, true);
          if (typeof callback === 'function') callback({ result: 'success' });
          send(state, 'retroUpdate', { devicestatus: next.frame.devicestatus });
        } catch { if (revision === state.revision && !closed && !state.closed && typeof callback === 'function') callback({ result: 'Not permitted' }); }
      }, () => socket.disconnect(true)).catch(() => { socket.disconnect(true); }));
    } else socket.on('subscribe', authorize);
    if (namespace !== '/storage') createForwarder({
      withOperation: (tenant, fn) => withOperation(tenant, fn, () => socket.disconnect(true)),
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
  async function fanout ({ tenant, previous, next }) {
    const changes = storageChanges(previous?.rows, next.rows);
    const config = await readCurrent(tenant);
    if (closed || !config || config.identity !== next.identity) c.fail('REALTIME_CYCLE_CHANGED');
    let count = null;
    for (const state of states) {
      if (state.tenant !== tenant || !state.primed || state.closed || !state.rights || state.held) continue;
      const revision = state.revision;
      try {
        epoch(state, revision, true);
        if (state.namespace === '/storage') {
          for (const change of changes) if (state.collections.includes(change.domain)) send(state, change.event, change.value);
        } else if (state.namespace === '/' && !sameView(state.view, next)) {
          if (!state.rights.permissions.read) c.fail('REALTIME_SOCKET_REFUSED');
          send(state, 'dataUpdate', dataFrame(state, next, state.rights, config)); state.view = next;
          if (count === null) count = clients(tenant);
          send(state, 'clients', count);
        }
      } catch { if (revision === state.revision) retire(state); }
    }
  }
  async function alarm ({ tenant, notification }) {
    if (!c.uuid(tenant) || !c.object(notification) || !await readCurrent(tenant) || closed) c.fail('REALTIME_ALARM_REFUSED');
    // Alarms are rare and protected: each delivery rechecks current rights,
    // once per distinct credential among the tenant's alarm subscribers.
    const authorize = authorities();
    for (const state of states) if (state.tenant === tenant && state.namespace === '/alarm' && state.primed && !state.closed) {
      const revision = state.revision;
      try {
      const rights = await current(state, authorize);
      if (!rights.permissions.read) { retire(state); continue; }
      if (closed || !await readCurrent(tenant)) c.fail('REALTIME_ALARM_REFUSED');
      epoch(state, revision, true);
      remember(state, rights);
      const event = notification.clear ? 'clear_alarm' : notification.level === 1 ? 'alarm'
        : notification.level === 2 ? 'urgent_alarm' : notification.isAnnouncement ? 'announcement' : 'notification';
      send(state, event, notification);
      } catch (error) {
        if (!['REALTIME_CLIENT_DENIED', 'REALTIME_SOCKET_EPOCH_CHANGED'].includes(error.code)) throw error;
        if (revision === state.revision) retire(state);
      }
    }
    return { accepted: true };
  }
  return Object.freeze({
    invalidateTenant (tenant) {
      for (const state of states) if (state.tenant === tenant) {
        counters.invalidated++;
        state.revision++; state.primed = false; state.closed = true; clearTimer(state.expiryTimer); state.socket.disconnect(true);
      }
      const entry = queues.get(tenant); if (entry) { abandon(entry); clearTimer(entry.timer); entry.timer = null; }
    },
    // Revocation seam: an event that a tenant's authority changed rechecks
    // its sockets now instead of at the next periodic recheck.
    recheckTenant: tenant => recheck(tenant),
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
    fanout: operation => withOperation(operation.tenant, () => fanout(operation)),
    alarm: operation => withOperation(operation.tenant, () => alarm(operation)),
    stats: () => Object.freeze({ ...counters, sockets: states.size, primed: [...states].filter(state => state.primed).length,
      queued: [...queues.values()].reduce((sum, entry) => sum + entry.pending.size, 0) }),
    close () {
      closed = true; clearTimer(sweepTimer); sweepTimer = null;
      for (const entry of queues.values()) { clearTimer(entry.timer); abandon(entry); }
      // No server-side disconnect (BF-233): the socket server closes the
      // transports, so clients see a transport close and reconnect.
      for (const state of states) { state.closed = true; clearTimer(state.expiryTimer); }
      states.clear();
    }
  });
}
module.exports = { create, origin, room, storageChanges, sameView, expiryOf, DEFAULT_RECHECK_MS };
