'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { COOKIE, credential, createHumanHTTP } = require('../lib/human-session/http');
const streamAuthority = require('./fixtures/human-stream-authority');
const accessFixture = require('./fixtures/human-access-issuer');
const { createVerifier, createAuthentication } = require('../lib/tenant-authorization/access-token');
const socketHelper = require('../lib/human-session/socket');
const { create: createAuthority } = require('../lib/server/realtime/authority');
const { create: createProtocol } = require('../lib/server/realtime/protocol');
const tick = () => new Promise(resolve => setImmediate(resolve));
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function signed (key, claims, header = {}) {
  const input = encoded({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: key.kid, ...header }) + '.' + encoded(claims);
  return input + '.' + (await key.sign(Buffer.from(input))).toString('base64url');
}

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
  let token, headers, single, calls, actor, ctx, env;
  beforeEach(async function () {
    calls = [];
    single = streamAuthority({ tenant: 'single' });
    token = (await single.login()).token;
    headers = { host: 'nightscout.synthetic.invalid', origin: 'https://nightscout.synthetic.invalid', cookie: COOKIE + '=' + token };
    actor = (await single.engine.authenticate({ tenant: 'single', token, purpose: 'data' })).actor;
    env = { trustProxy: false, settings: { enable: [], isEnabled: () => false }, enclave: { isApiKeySet: () => true },
      name: 'synthetic', version: '16.0.0', entries_collection: 'entries', treatments_collection: 'treatments' };
    ctx = { bus: new EventEmitter(), store: { collection: () => { throw new Error('unexpected data write'); } },
      ddata: { sgvs: [], cals: [], devicestatus: [{ synthetic: true }], clone () {
        return { sgvs: this.sgvs.slice(), cals: [], devicestatus: this.devicestatus.slice(), dataWithRecentStatuses: () => ({ synthetic: true }) };
      } }, notifications: { ack (...args) { calls.push(['ack', args]); } }, levels: { WARN: 1, URGENT: 2 },
      authorization: { resolveAnonymous: callback => callback(null, { shiros: ['legacy-read'] }),
        checkMultiple: (permission, shiros) => shiros.includes('legacy-read') && permission === 'api:*:read',
        resolve: () => { throw new Error('human must not use legacy resolver'); } },
      humanSessions: null };
    const http = createHumanHTTP({ engine: single.worker(), provider: {}, resolver: { resolve: async () => 'single' },
      originFor: () => headers.origin, cookieKey: randomBytes(32) });
    ctx.humanSessions = { ...http, accepts: value => single.engine.accepts(value), async authenticate (input) {
      calls.push(['authenticate', input]);
      return http.authenticate(input);
    } };
  });

  it('requires cookie Origin and never promotes management purpose into data', async function () {
    assert.throws(() => socketHelper.select(ctx, new Socket({ cookie: COOKIE + '=' + token })), { code: 'HUMAN_SESSION_REFUSED' });
    const socket = new Socket(headers);
    const selected = socketHelper.select(ctx, socket);
    await socketHelper.current(ctx, socket, selected);
    assert.equal(calls[0][1].purpose, 'data');
    assert.equal(calls[0][1].activity, false);
    await single.engine.logout({ tenant: 'single', token });
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
    await single.engine.logout({ tenant: 'single', token });
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
    const response = await new Promise((resolve, reject) => {
      socket.receive('subscribe', { collections: ['entries', 'settings'] }, resolve).catch(reject);
    });
    assert.deepEqual(response.collections, ['entries']);
    assert.equal(socket.rooms.has('entries'), false);
    storage.emitCreate({ colName: 'entries', doc: { synthetic: true } });
    await tick();
    assert.equal(socket.sent.filter(event => event.name === 'create').length, 1);
    await single.engine.logout({ tenant: 'single', token });
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
    const response = await new Promise((resolve, reject) => {
      socket.receive('subscribe', {}, resolve).catch(reject);
    });
    assert.equal(response.read, true);
    assert.equal(socket.rooms.has('AlarmReceivers'), false);
    alarm.emitNotification({ level: 1, synthetic: true });
    await tick();
    assert.equal(socket.sent.filter(event => event.name === 'alarm').length, 1);
    await socket.receive('ack', 1, 'synthetic', 10);
    assert.equal(calls.filter(call => call[0] === 'ack').length, 1);
    await single.engine.logout({ tenant: 'single', token });
    alarm.emitNotification({ level: 1, synthetic: true });
    await tick();
    await socket.receive('ack', 1, 'synthetic', 10);
    assert.equal(calls.filter(call => call[0] === 'ack').length, 1);
    assert.equal(socket.sent.filter(event => event.name === 'alarm').length, 1);
  });

  it('consumes human data token in multitenant current authority after trusted tenant admission', async function () {
    let admitted = true, legacy = 0;
    const multi = streamAuthority({ tenant }), multiToken = (await multi.login()).token;
    const authority = createAuthority({ humanSessions: multi.worker(), secrets: { verifyLegacyCredential: async () => { legacy++; throw new Error(); } },
    authority: { subjectSnapshot: async () => null, authorize: async () => false },
    verifierContext: async tenant => ({ tenant }), admission: { allows: async () => admitted } });
    const operation = { tenant, namespace: '/', credential: { token: multiToken } };
    assert.equal((await authority.verify(operation)).principal.subjectId, actor.subject);
    await multi.engine.logout({ tenant, token: multiToken });
    await assert.rejects(authority.verify(operation), { code: 'HUMAN_SESSION_REFUSED' });
    admitted = false;
    await assert.rejects(authority.verify(operation), { code: 'SOCKET_AUTHORITY_REFUSED' });
    assert.equal(legacy, 0);
  });

  it('binds human cookie to actual multitenant protocol and refuses cookie Origin-less/mixed credential handshakes', async function () {
    const observed = [];
    const protocol = createProtocol({ humanSessionsEnabled: true, humanAccepts: value => single.engine.accepts(value),
      admission: { resolve: async () => tenant }, readCurrent: async () => ({ identity: 'synthetic' }),
      api: async (path, body) => { observed.push(body); return { permissions: { read: false, write: false, write_treatment: false, ack: false }, collections: [] }; },
      runtime: () => ({}), maxSockets: 10, domains: ['entries'] });
    await assert.rejects(protocol.prepare(new Socket({ host: headers.host, cookie: headers.cookie })), { code: 'REALTIME_HANDSHAKE_REFUSED' });
    const socket = new Socket(headers);
    await protocol.prepare(socket); protocol.bind(socket, '/'); await tick();
    assert.equal(observed[0].credential.humanToken, token);
    await socket.receive('authorize', { secret: 'synthetic-other-credential' });
    assert.equal(socket.disconnected, true);
    protocol.close();
  });

  function multiAuthority (multi, machine) {
    const counts = { legacy: 0, machine: 0 };
    const authority = createAuthority({ humanSessions: multi?.worker(),
      secrets: { async verifyLegacyCredential () { counts.legacy++; throw new Error('Unexpected legacy fallback'); } },
      accessTokens: { async authenticate (input) {
        counts.machine++;
        if (machine) return machine(input);
        throw new Error('Unexpected headless fallback');
      } },
      authority: { subjectSnapshot: async () => null, authorize: async () => false },
      verifierContext: async tenant => ({ tenant }), admission: { allows: async () => true } });
    return { authority, counts };
  }

  it('never sends a recognized signed-human signature failure to headless or legacy authentication', async function () {
    const multi = streamAuthority({ tenant }), issued = await multi.login();
    const parts = issued.token.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    const bad = parts.join('.'), f = multiAuthority(multi);
    assert.equal(multi.engine.accepts(bad), true, 'metadata selection must still choose human verification');
    await assert.rejects(f.authority.verify({ tenant, namespace: '/', credential: { token: bad } }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.deepEqual(f.counts, { legacy: 0, machine: 0 });
  });

  it('refuses foreign tenant, management purpose and current retired keys with no alternate verifier', async function () {
    const multi = streamAuthority({ tenant }), foreign = streamAuthority({ tenant: '22222222-2222-4222-8222-222222222222' });
    const f = multiAuthority(multi);
    const management = (await multi.login('management')).token;
    const foreignToken = (await foreign.login()).token;
    for (const value of [management, foreignToken]) {
      assert.equal(multi.engine.accepts(value), true);
      await assert.rejects(f.authority.verify({ tenant, namespace: '/', credential: { token: value } }), { code: 'HUMAN_SESSION_REFUSED' });
    }
    const data = (await multi.login()).token;
    multi.collection.document.keys.find(key => key.purpose === 'data').active = false;
    assert.equal(multi.crypto.access.verify({ tenant, token: data }).sub, 'synthetic-human', 'signature still verifies under cached trusted public key');
    await assert.rejects(f.authority.verify({ tenant, namespace: '/', credential: { token: data } }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    multi.collection.document.keys.find(key => key.purpose === 'data').active = true;
    assert.equal((await f.authority.verify({ tenant, namespace: '/', credential: { token: data } })).principal.subjectId, 'synthetic-human');
    assert.deepEqual(f.counts, { legacy: 0, machine: 0 });
  });

  it('keeps valid headless ns-access verification separate from the human issuer and audiences', async function () {
    const multi = streamAuthority({ tenant }), machine = accessFixture({ tenant, issuer: 'synthetic-headless-access',
      audiences: { data: 'synthetic-headless-data', management: 'synthetic-headless-management' } });
    const at = Math.floor(Date.now() / 1000);
    const machineToken = await machine.access.issue({ tenant, subject: 'synthetic-machine', session: 'machine-session',
      purpose: 'data', credentialVersion: 1, issuedAt: at, expiresAt: at + 600 });
    const verifyToken = createVerifier({ issuer: machine.issuer, audience: machine.audiences.data, purpose: 'data',
      maxLifetimeSeconds: 28800, resolveKey: (tenant, kid) => {
        const key = machine.keys.find(key => key.tenant === tenant && key.kid === kid);
        return key && { ...key, issuer: machine.issuer };
      } });
    const authenticate = createAuthentication({ verifyToken, snapshot: async () => ({ active: true, sessionActive: true,
      keyActive: true, credentialVersion: 1, sessionExpiresAt: at + 600, allows: permission => permission === 'api:*:read' }) });
    const f = multiAuthority(multi, authenticate);
    assert.equal(multi.engine.accepts(machineToken), false);
    const accepted = await f.authority.verify({ tenant, namespace: '/', credential: { token: machineToken } });
    assert.equal(accepted.principal.subjectId, 'synthetic-machine');
    assert.deepEqual(f.counts, { legacy: 0, machine: 1 });
    await assert.rejects(f.authority.verify({ tenant, namespace: '/', credential: { humanToken: machineToken } }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.deepEqual(f.counts, { legacy: 0, machine: 1 }, 'a cookie/explicit human marker cannot switch to the successful machine verifier');
  });

  it('forces wrong-issuer and provider-shaped cookie JWTs through the human verifier even when metadata selection refuses', async function () {
    const { kid: verifiedKid, ...claims } = single.crypto.access.verify({ tenant: 'single', token });
    const key = single.crypto.keys.find(key => key.purpose === 'data');
    assert.equal(verifiedKid, key.kid);
    const providerID = await signed(key, { iss: 'https://provider.synthetic.invalid', aud: 'provider-client',
      sub: 'provider-subject', iat: claims.iat, exp: claims.exp, nonce: 'synthetic-nonce' }, { typ: 'JWT' });
    const wrongIssuer = await signed(key, { ...claims, iss: 'foreign-nightscout-human-access' });
    const wrongType = await signed(key, claims, { typ: 'JWT' });
    for (const value of [providerID, wrongIssuer, wrongType]) {
      assert.equal(single.engine.accepts(value), false);
      const socket = new Socket({ ...headers, cookie: COOKIE + '=' + value });
      const selected = socketHelper.select(ctx, socket);
      assert.equal(selected.cookie, true);
      assert.equal(selected.token, value);
      await assert.rejects(socketHelper.current(ctx, socket, selected), { code: 'HUMAN_SESSION_REFUSED' });
    }
  });

  it('carries a refused cookie profile as humanToken through the actual protocol and refuses it at authority', async function () {
    const multi = streamAuthority({ tenant }), foreign = accessFixture({ tenant, issuer: 'foreign-human-access' });
    const at = Math.floor(Date.now() / 1000);
    const wrong = await foreign.access.issue({ tenant, subject: 'synthetic-human', session: 'foreign-session',
      purpose: 'data', credentialVersion: 1, issuedAt: at, expiresAt: at + 600 });
    const f = multiAuthority(multi), seen = [];
    const protocol = createProtocol({ humanSessionsEnabled: true, humanAccepts: value => multi.engine.accepts(value),
      admission: { resolve: async () => tenant }, readCurrent: async () => ({ identity: 'synthetic' }),
      api: async (path, body) => {
        seen.push(body.credential);
        try { const current = await f.authority.verify(body); return { permissions: current.permissions, collections: current.collections }; }
        catch (error) { assert.equal(error.code, 'HUMAN_SESSION_REFUSED'); return { denied: true }; }
      }, runtime: () => ({}), maxSockets: 10, domains: ['entries'] });
    const socket = new Socket({ ...headers, cookie: COOKIE + '=' + wrong });
    await protocol.prepare(socket); protocol.bind(socket, '/'); await tick();
    assert.deepEqual(seen, [{ humanToken: wrong }]);
    assert.equal(socket.disconnected, true);
    assert.deepEqual(f.counts, { legacy: 0, machine: 0 });
    protocol.close();
  });

  it('refuses explicit human markers when the human plane is disabled, malformed or mixed with another credential', async function () {
    const f = multiAuthority(null);
    await assert.rejects(f.authority.verify({ tenant, namespace: '/', credential: { humanToken: token } }), { code: 'SOCKET_CREDENTIAL_REFUSED' });
    assert.throws(() => socketHelper.select({ humanSessions: null }, new Socket({}), { humanToken: token }), { code: 'HUMAN_SESSION_REFUSED' });
    assert.throws(() => socketHelper.select(ctx, new Socket({}), { humanToken: '' }), { code: 'HUMAN_SESSION_REFUSED' });
    const multi = streamAuthority({ tenant }), enabled = multiAuthority(multi), value = (await multi.login()).token;
    await assert.rejects(enabled.authority.verify({ tenant, namespace: '/', credential: { humanToken: value, secret: 'synthetic-root-hash' } }), { code: 'SOCKET_CREDENTIAL_REFUSED' });
    await assert.rejects(enabled.authority.verify({ tenant: 'single', namespace: '/', credential: { humanToken: value } }), { code: 'SOCKET_AUTHORITY_REFUSED' });
    assert.deepEqual(enabled.counts, { legacy: 0, machine: 0 });
  });
});
