'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { COOKIE, credential } = require('../lib/human-session/http');
const socketHelper = require('../lib/human-session/socket');
const { create: createAuthority } = require('../lib/server/realtime/authority');
const { create: createProtocol } = require('../lib/server/realtime/protocol');
const tick = () => new Promise(resolve => setImmediate(resolve));

class Socket {
  constructor (headers = {}) {
    this.handlers = new Map(); this.sent = []; this.rooms = new Set(['synthetic-socket']);
    this.id = 'synthetic-socket'; this.client = { id: this.id }; this.disconnected = false;
    this.request = { method: 'GET', headers, rawHeaders: Object.entries(headers).flat(),
      socket: { remoteAddress: '127.0.0.1', encrypted: true } };
  }
  on (name, fn) { this.handlers.set(name, [...(this.handlers.get(name) || []), fn]); return this; }
  removeListener (name, fn) { this.handlers.set(name, (this.handlers.get(name) || []).filter(value => value !== fn)); return this; }
  removeAllListeners (name) { this.handlers.delete(name); return this; }
  receive (name, ...args) { return Promise.all((this.handlers.get(name) || []).map(fn => fn(...args))); }
  emit (name, value) { this.sent.push({ name, value }); return this; }
  join (room) { this.rooms.add(room); return this; }
  leave (room) { this.rooms.delete(room); return this; }
  compress () { return this; }
  disconnect () { this.disconnected = true; for (const fn of this.handlers.get('disconnect') || []) fn(); }
}

function fakeIO () {
  const namespaces = new Map();
  function namespace () {
    const events = new Map();
    return { sockets: {}, broadcasts: [], on (name, fn) { events.set(name, fn); },
      connect (socket) { events.get('connection')(socket); },
      to (room) { const self = this; return { compress () { return this; }, emit (name, value) { self.broadcasts.push({ room, name, value }); } }; } };
  }
  const sockets = namespace();
  return { sockets, listen () { return this; }, close () {}, emit () {}, to: room => sockets.to(room),
    of (name) { if (!namespaces.has(name)) namespaces.set(name, namespace()); return namespaces.get(name); } };
}

describe('human current authority on consumed socket factories (no listeners)', function () {
  const tenant = '11111111-1111-4111-8111-111111111111';
  const token = 'nsh_' + randomBytes(32).toString('base64url');
  const headers = { host: 'nightscout.synthetic.invalid', origin: 'https://nightscout.synthetic.invalid', cookie: COOKIE + '=' + token };
  let active, calls, actor, ctx, env;
  beforeEach(function () {
    active = true; calls = [];
    actor = { subject: 'synthetic-human', permissionGroups: [['api:*:read', 'notifications:*:ack']],
      allows: permission => permission.endsWith(':read') || permission === 'notifications:*:ack' };
    env = { trustProxy: false, settings: { enable: [], isEnabled: () => false }, enclave: { isApiKeySet: () => true },
      name: 'synthetic', version: '16.0.0', entries_collection: 'entries', treatments_collection: 'treatments' };
    ctx = { bus: new EventEmitter(), store: { collection: () => { throw new Error('unexpected data write'); } },
      ddata: { sgvs: [], cals: [], devicestatus: [{ synthetic: true }], clone () {
        return { sgvs: this.sgvs.slice(), cals: [], devicestatus: this.devicestatus.slice(), dataWithRecentStatuses: () => ({ synthetic: true }) };
      } }, notifications: { ack (...args) { calls.push(['ack', args]); } }, levels: { WARN: 1, URGENT: 2 },
      authorization: { resolveAnonymous: callback => callback(null, { shiros: ['legacy-read'] }),
        checkMultiple: (permission, shiros) => shiros.includes('legacy-read') && permission === 'api:*:read',
        resolve: () => { throw new Error('human must not use legacy resolver'); } },
      humanSessions: { credential, async authenticate (input) {
        calls.push(['authenticate', input]);
        if (!active || input.purpose !== 'data') throw Object.assign(new Error(), { code: 'HUMAN_SESSION_REFUSED' });
        return { actor };
      } } };
  });

  it('requires cookie Origin and never promotes management purpose into data', async function () {
    assert.throws(() => socketHelper.select(ctx, new Socket({ cookie: COOKIE + '=' + token })), { code: 'HUMAN_SESSION_REFUSED' });
    const socket = new Socket(headers);
    const selected = socketHelper.select(ctx, socket);
    await socketHelper.current(ctx, socket, selected);
    assert.equal(calls[0][1].purpose, 'data');
    assert.equal(calls[0][1].activity, false);
    active = false;
    await assert.rejects(socketHelper.current(ctx, socket, selected), { code: 'HUMAN_SESSION_REFUSED' });
  });

  it('keeps human main socket out of cached broadcast rooms and rechecks emission/retro/write after logout', async function () {
    const id = require.resolve('socket.io'), saved = require.cache[id];
    require(id);
    const original = require.cache[id].exports;
    const io = fakeIO();
    try {
      require.cache[id].exports = () => io;
      require('../lib/server/websocket')(env, ctx, {});
    } finally {
      require.cache[id].exports = original;
      if (!saved) delete require.cache[id];
    }
    const socket = new Socket(headers);
    io.sockets.connect(socket);
    ctx.bus.emit('data-processed');
    let authorization;
    await socket.receive('authorize', {}, result => { authorization = result; });
    await tick();
    assert.equal(authorization.read, true);
    assert.equal(socket.rooms.has('DataReceivers'), false);
    const initial = socket.sent.filter(event => event.name === 'dataUpdate').length;
    ctx.ddata.sgvs = [{ mills: 1, sgv: 100 }];
    ctx.bus.emit('data-processed');
    await tick();
    assert.equal(socket.sent.filter(event => event.name === 'dataUpdate').length, initial + 1);
    active = false;
    ctx.ddata.sgvs = [{ mills: 2, sgv: 101 }];
    ctx.bus.emit('data-processed');
    await tick();
    assert.equal(socket.sent.filter(event => event.name === 'dataUpdate').length, initial + 1);
    let retro, write;
    await socket.receive('loadRetro', {}, result => { retro = result; });
    await socket.receive('dbAdd', { collection: 'entries', data: [] }, result => { write = result; });
    assert.equal(retro.result, 'Not permitted');
    assert.equal(write.result, 'Not authorized');
    assert.equal(socket.sent.some(event => event.name === 'retroUpdate'), false);
  });

  it('checks current human grants for every storage delivery and never joins cached collection rooms', async function () {
    const app = { get: () => ['entries', 'settings'] }, io = fakeIO();
    const storage = new (require('../lib/api3/storageSocket'))(app, env, ctx);
    storage.init(io);
    const socket = new Socket(headers);
    io.of('/storage').connect(socket);
    let response;
    await socket.receive('subscribe', { collections: ['entries', 'settings'] }, value => { response = value; });
    assert.deepEqual(response.collections, ['entries']);
    assert.equal(socket.rooms.has('entries'), false);
    storage.emitCreate({ colName: 'entries', doc: { synthetic: true } });
    await tick();
    assert.equal(socket.sent.filter(event => event.name === 'create').length, 1);
    active = false;
    storage.emitCreate({ colName: 'entries', doc: { synthetic: true } });
    await tick();
    assert.equal(socket.sent.filter(event => event.name === 'create').length, 1);
  });

  it('prevents cookie anonymous alarm room admission and rechecks every alarm and ACK', async function () {
    const io = fakeIO();
    const alarm = new (require('../lib/api3/alarmSocket'))({}, env, ctx);
    alarm.init(io);
    const socket = new Socket(headers);
    io.of('/alarm').connect(socket);
    assert.equal(socket.rooms.has('AlarmReceivers'), false);
    let response;
    await socket.receive('subscribe', {}, value => { response = value; });
    assert.equal(response.read, true);
    assert.equal(socket.rooms.has('AlarmReceivers'), false);
    alarm.emitNotification({ level: 1, synthetic: true });
    await tick();
    assert.equal(socket.sent.filter(event => event.name === 'alarm').length, 1);
    await socket.receive('ack', 1, 'synthetic', 10);
    assert.equal(calls.filter(call => call[0] === 'ack').length, 1);
    active = false;
    alarm.emitNotification({ level: 1, synthetic: true });
    await tick();
    await socket.receive('ack', 1, 'synthetic', 10);
    assert.equal(calls.filter(call => call[0] === 'ack').length, 1);
    assert.equal(socket.sent.filter(event => event.name === 'alarm').length, 1);
  });

  it('consumes human data token in multitenant current authority after trusted tenant admission', async function () {
    let admitted = true, legacy = 0;
    const authority = createAuthority({ humanSessions: { async authenticate (input) {
      assert.equal(input.tenant, tenant); assert.equal(input.token, token); assert.equal(input.purpose, 'data');
      if (!active) throw Object.assign(new Error(), { code: 'HUMAN_SESSION_REFUSED' });
      return { actor };
    } }, secrets: { verifyLegacyCredential: async () => { legacy++; throw new Error(); } },
    authority: { subjectSnapshot: async () => null, authorize: async () => false },
    verifierContext: async tenant => ({ tenant }), admission: { allows: async () => admitted } });
    const operation = { tenant, namespace: '/', credential: { token } };
    assert.equal((await authority.verify(operation)).principal.subjectId, actor.subject);
    active = false;
    await assert.rejects(authority.verify(operation), { code: 'HUMAN_SESSION_REFUSED' });
    admitted = false;
    await assert.rejects(authority.verify(operation), { code: 'SOCKET_AUTHORITY_REFUSED' });
    assert.equal(legacy, 0);
  });

  it('binds human cookie to actual multitenant protocol and refuses cookie Origin-less/mixed credential handshakes', async function () {
    const observed = [];
    const protocol = createProtocol({ humanSessionsEnabled: true,
      admission: { resolve: async () => tenant }, readCurrent: async () => ({ identity: 'synthetic' }),
      api: async (path, body) => { observed.push(body); return { permissions: { read: false, write: false, write_treatment: false, ack: false }, collections: [] }; },
      runtime: () => ({}), maxSockets: 10, domains: ['entries'] });
    await assert.rejects(protocol.prepare(new Socket({ host: headers.host, cookie: headers.cookie })), { code: 'REALTIME_HANDSHAKE_REFUSED' });
    const socket = new Socket(headers);
    await protocol.prepare(socket); protocol.bind(socket, '/'); await tick();
    assert.equal(observed[0].credential.token, token);
    await socket.receive('authorize', { secret: 'synthetic-other-credential' });
    assert.equal(socket.disconnected, true);
    protocol.close();
  });
});
