'use strict';

const { isDeepStrictEqual } = require('node:util');
const { credentialFor } = require('./authority');
const { createForwarder } = require('../tenant-socket-forwarding');
const { encodeDocument } = require('../../storage/postgres-identity');
const { normalizeDoc } = require('../../api3/storage/mongoCollection/utils');
const apiConst = require('../../api3/const');
const c = require('./contract');
const room = (tenant, namespace, collection = '*') => JSON.stringify([tenant, namespace, collection]);
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
function create ({ admission, api, readCurrent, runtime, maxSockets, domains }) {
  if ([admission?.resolve, api, readCurrent, runtime].some(fn => typeof fn !== 'function') || !c.integer(maxSockets) || !Array.isArray(domains)) throw new TypeError('Realtime protocol requires explicit bounded trusted adapters');
  const states = new Set(), prepared = new WeakMap(); let closed = false;
  function send (state, event, value) {
    if (closed || state.closed) c.fail('REALTIME_CLOSED');
    state.socket.emit(event, value);
  }
  function epoch (state, revision, primed = false) {
    if (closed || state.closed || state.revision !== revision || primed && !state.primed) c.fail('REALTIME_SOCKET_EPOCH_CHANGED');
  }
  async function current (state) {
    const revision = state.revision, credential = state.credential;
    if (closed || state.closed || await admission.resolve(state.socket.request) !== state.tenant || !await readCurrent(state.tenant)) c.fail('REALTIME_SOCKET_REFUSED');
    epoch(state, revision);
    const rights = await api('/authorize', { host: state.host, tenant: state.tenant, namespace: state.namespace, credential });
    epoch(state, revision);
    if (!c.object(rights.permissions) || ['read', 'write', 'write_treatment', 'ack'].some(k => typeof rights.permissions[k] !== 'boolean') ||
        !Array.isArray(rights.collections) || rights.collections.some(col => !domains.includes(col))) c.fail('REALTIME_AUTHORITY_RESPONSE_REFUSED');
    return rights;
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
      if (rights.display) {
        if (!['mg/dl', 'mmol'].includes(rights.display.units) || typeof rights.display.showSeconds !== 'boolean') c.fail('REALTIME_DISPLAY_REFUSED');
        settings.units = rights.display.units; settings.showSeconds = rights.display.showSeconds;
      }
      frame.status = { status: 'ok', name: require('../../../package.json').name,
        version: require('../../../package.json').version, serverTime: new Date().toISOString(), apiEnabled: true,
        settings, extendedSettings: config.env.extendedSettings };
    }
    return frame;
  }
  async function initial (state, message, callback, revision) {
    try {
      let rights = await current(state);
      if (revision !== state.revision || closed || state.closed) return;
      if (state.namespace === '/storage') {
        const selected = message.collections === undefined ? domains : message.collections;
        if (!Array.isArray(selected) || selected.some(value => typeof value !== 'string')) c.fail('REALTIME_COLLECTION_REFUSED');
        state.collections = [...new Set(selected)].filter(value => domains.includes(value) && rights.collections.includes(value));
        state.primed = true;
        for (const logical of state.collections) await state.socket.join(room(state.tenant, state.namespace, logical));
        if (closed || state.closed || revision !== state.revision) return;
        if (typeof callback === 'function') callback(state.collections.length ? { success: true, collections: state.collections }
          : { success: false, message: apiConst.MSG.SOCKET_UNAUTHORIZED_TO_ANY });
        return;
      }
      if (rights.permissions.read) {
        const next = await runtime().refresh(state.tenant);
        rights = await current(state); // current again after potentially slow acquisition
        const config = await frameFor(state, next);
        if (revision !== state.revision || !rights.permissions.read) c.fail('REALTIME_SOCKET_REFUSED');
        await state.socket.join(room(state.tenant, state.namespace)); state.primed = true;
        if (state.namespace === '/') {
          const frame = dataFrame(state, next, rights, config);
          if (revision !== state.revision) return;
          send(state, 'dataUpdate', frame);
          send(state, 'clients', [...states].filter(peer => peer.tenant === state.tenant && peer.namespace === '/' && peer.primed && !peer.closed).length);
        }
      }
      if (revision !== state.revision || closed || state.closed) return;
      if (state.namespace === '/') { send(state, 'connected'); if (typeof callback === 'function') callback(rights.permissions); }
      else if (typeof callback === 'function') callback({ success: true, message: 'Subscribed for alarms',
        ...(!state.credential.accessToken ? { read: rights.permissions.read, ack: rights.permissions.ack } : {}) });
    } catch {
      if (revision !== state.revision) return;
      state.primed = false;
      if (!closed && !state.closed && typeof callback === 'function' && state.namespace !== '/') callback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
      state.socket.disconnect(true);
    }
  }
  function bind (socket, namespace) {
    if (closed || states.size >= maxSockets || !['/', '/storage', '/alarm'].includes(namespace)) { socket.disconnect(true); return; }
    if (!prepared.has(socket)) { socket.disconnect(true); return; }
    const state = { socket, namespace, tenant: prepared.get(socket), host: socket.request.headers.host,
      credential: Object.freeze({}), wantStatus: false, revision: 0, primed: false, collections: [], closed: false };
    if (closed) { socket.disconnect(true); return; }
    states.add(state);
    socket.on('disconnect', () => { state.closed = true; states.delete(state); });
    const authorize = (message, callback) => {
      try {
        state.credential = credentialFor(namespace, message); state.wantStatus = message?.status === true; state.revision++; state.primed = false;
        state.collections = [];
        for (const old of socket.rooms || []) if (old !== socket.id) socket.leave(old);
        return initial(state, message || {}, callback, state.revision);
      } catch { socket.disconnect(true); }
    };
    if (namespace === '/') {
      socket.on('authorize', authorize);
      socket.on('loadRetro', async (options, callback) => {
        const revision = state.revision;
        try {
          if (!(await current(state)).permissions.read) c.fail('REALTIME_SOCKET_REFUSED');
          const next = await runtime().refresh(state.tenant);
          if (!(await current(state)).permissions.read) c.fail('REALTIME_SOCKET_REFUSED');
          await frameFor(state, next);
          epoch(state, revision, true);
          if (typeof callback === 'function') callback({ result: 'success' });
          send(state, 'retroUpdate', { devicestatus: next.frame.devicestatus });
        } catch { if (revision === state.revision && !closed && !state.closed && typeof callback === 'function') callback({ result: 'Not permitted' }); }
      });
    } else socket.on('subscribe', authorize);
    if (namespace !== '/storage') createForwarder({
      async contextForSocket () {
        const revision = state.revision;
        if (closed || state.closed || await admission.resolve(socket.request) !== state.tenant || !await readCurrent(state.tenant)) c.fail('REALTIME_SOCKET_REFUSED');
        epoch(state, revision);
        return { tenant: state.tenant, credential: state.credential };
      },
      async transport (envelope) {
        const revision = state.revision;
        const response = await api('/mutate', { host: state.host, envelope });
        epoch(state, revision);
        return response;
      }
    }).bind(socket, namespace);
    if (namespace !== '/storage') initial(state, {}, undefined, 0).catch(() => {});
  }
  async function fanout ({ tenant, previous, next }) {
    const changes = storageChanges(previous?.rows, next.rows);
    for (const state of states) {
      if (state.tenant !== tenant || !state.primed || state.closed) continue;
      const revision = state.revision;
      try {
        const rights = await current(state); const config = await frameFor(state, next);
        epoch(state, revision, true);
        if (state.namespace === '/storage') {
          const removed = state.collections.filter(col => !rights.collections.includes(col));
          state.collections = state.collections.filter(col => rights.collections.includes(col));
          for (const logical of removed) await state.socket.leave(room(state.tenant, state.namespace, logical));
          epoch(state, revision, true);
          for (const change of changes) if (state.collections.includes(change.domain)) send(state, change.event, change.value);
        } else if (state.namespace === '/') {
          if (!rights.permissions.read) c.fail('REALTIME_SOCKET_REFUSED');
          send(state, 'dataUpdate', dataFrame(state, next, rights, config));
          send(state, 'clients', [...states].filter(peer => peer.tenant === state.tenant && peer.namespace === '/' && peer.primed && !peer.closed).length);
        }
      } catch { if (revision === state.revision) { state.primed = false; state.socket.disconnect(true); } }
    }
  }
  async function alarm ({ tenant, notification }) {
    if (!c.uuid(tenant) || !c.object(notification) || !await readCurrent(tenant) || closed) c.fail('REALTIME_ALARM_REFUSED');
    for (const state of states) if (state.tenant === tenant && state.namespace === '/alarm' && state.primed && !state.closed) {
      const revision = state.revision;
      const rights = await current(state);
      if (!rights.permissions.read) { state.socket.disconnect(true); continue; }
      if (closed || !await readCurrent(tenant)) c.fail('REALTIME_ALARM_REFUSED');
      epoch(state, revision, true);
      const event = notification.clear ? 'clear_alarm' : notification.level === 1 ? 'alarm'
        : notification.level === 2 ? 'urgent_alarm' : notification.isAnnouncement ? 'announcement' : 'notification';
      send(state, event, notification);
    }
    return { accepted: true };
  }
  return Object.freeze({
    async prepare (socket) {
      if (closed || !origin(socket.request)) c.fail('REALTIME_HANDSHAKE_REFUSED');
      prepared.set(socket, await admission.resolve(socket.request));
    }, bind, fanout, alarm,
    close () { closed = true; for (const state of states) { state.closed = true; state.socket.disconnect(true); } states.clear(); }
  });
}
module.exports = { create, origin, room, storageChanges };
