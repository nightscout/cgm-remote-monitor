'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { ObjectId } = require('mongodb');
const { context } = require('./fixtures/socket-forwarding/recording-context');
const { createHandlers } = require('../lib/server/socket-write-handlers');
const { createExecutor } = require('../lib/server/tenant-socket-write-executor');
const { createApiReceiver, createForwarder } = require('../lib/server/tenant-socket-forwarding');
const scope = require('../lib/storage/tenant-scope');
const pattern = require('./fixtures/socket-forwarding/patterns');
const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
const grants = { read: true, write: true, write_treatment: true };

// Compile the frozen pre-extraction source at its original module location:
// relative imports remain real canonical policies, no git or network needed.
function baseline (fixture) {
  const filename = require.resolve('../lib/server/websocket');
  const frozen = new Module(filename, module);
  frozen.filename = filename;
  frozen.paths = Module._nodeModulePaths(path.dirname(filename));
  frozen._compile(fs.readFileSync(path.join(__dirname, 'fixtures/socket-forwarding/websocket-e0a7c39f.js'), 'utf8'), filename);
  const handlers = {};
  let connected;
  const io = { sockets: { sockets: {}, on: (event, callback) => { connected = callback; } }, emit: () => {}, close: () => {} };
  const load = Module._load;
  try {
    Module._load = function (name, ...args) {
      return name === 'socket.io' ? () => ({ listen: () => io }) : load.call(this, name, ...args);
    };
    frozen.exports(fixture.env, fixture.ctx, {});
  } finally { Module._load = load; }
  const socket = { client: { id: 'synthetic' }, request: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    on: (event, callback) => { handlers[event] = callback; }, emit: () => {}, join: () => {} };
  connected(socket);
  return handlers;
}
const call = (handlers, event, payload) => new Promise(resolve => handlers[event](payload, (...args) => resolve(args)));
function norm (value, key) {
  if (value instanceof ObjectId) return { objectId: value.toHexString() };
  if (value instanceof Date) return { date: value.toISOString() };
  if (['srvCreated', 'srvModified'].includes(key) && typeof value === 'number' && value > 1e12) return 'server-clock';
  if (Array.isArray(value)) return value.map(v => norm(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, k)]));
  return value;
}
async function sequence (send, collections) {
  const add = pattern.addTreatment();
  // A stable explicit string id makes generated identity independent of wall
  // time; the pinned pattern still interprets the actual callback _id.
  add.data._id = 'synthetic-treatment';
  const replies = [];
  replies.push(await send('dbAdd', structuredClone(add)));
  const id = pattern.addedId(replies[0]);
  replies.push(await send('dbAdd', structuredClone(add)));
  assert.equal(pattern.addedId(replies[1]), id, 'retry names the same stored identity');
  assert.equal(collections.treatments.documents.length, 1, 'retry has one stored treatment');
  replies.push(await send('dbUpdate', pattern.updateTreatment(id)));
  assert(pattern.updated(replies.at(-1)));
  assert.equal(collections.treatments.documents[0].notes, 'synthetic-update');
  replies.push(await send('dbUpdateUnset', { collection: 'treatments', _id: id, data: { notes: true } }));
  assert.equal(collections.treatments.documents[0].notes, undefined);
  const device = pattern.addDeviceStatus(); device.data._id = 'synthetic-device';
  replies.push(await send('dbAdd', device));
  assert.equal(collections.devicestatus.documents.length, 1);
  const beforeRemove = norm({ treatments: collections.treatments.documents, devicestatus: collections.devicestatus.documents });
  replies.push(await send('dbRemove', { collection: 'treatments', _id: id }));
  assert.equal(collections.treatments.documents.length, 0);
  return { replies: norm(replies), beforeRemove };
}

describe('canonical socket DATA extraction and dormant API executor', function () {
  this.timeout(5000);
  it('matches frozen single-handler acknowledgements and stored values for pinned AAPS DATA pattern replay and four events', async function () {
    const before = context();
    const original = baseline(before);
    await call(original, 'authorize', pattern.authorization());
    const expected = await sequence((event, payload) => call(original, event, payload), before.collections);
    const after = context();
    const extracted = createHandlers({ ...after, authorizationFor: () => grants });
    assert.deepEqual(await sequence((event, payload) => call(extracted, event, payload), after.collections), expected);
  });
  it('forwards through the same committed write handlers and current socket authority with exact callback vectors', async function () {
    const fixture = context();
    const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try {
      const executeWrite = createExecutor({ contextForOperation: operation => {
        assert.equal(scope.currentTenant(), A);
        return { ...fixture, authorizationFor: () => operation.actor.permissions };
      } });
      const receive = createApiReceiver({ authenticateTransport: async () => true, resolveTenant: async () => A,
        authorizeSocket: async ({ tenant, credential }) => {
          assert.equal(credential.token, 'synthetic-client'); return { tenant, permissions: grants };
        }, executeWrite });
      const forwarder = createForwarder({ contextForSocket: () => ({ tenant: A, credential: { token: 'synthetic-client' } }),
        transport: envelope => receive({}, envelope) });
      await sequence(async (event, payload) => {
        let reply;
        const outcome = await forwarder.forward({ namespace: '/', event, args: [payload], acknowledge: (...args) => { reply = args; } });
        assert.equal(outcome.delivered, true);
        return reply;
      }, fixture.collections);
    } finally { scope.setTenancyMode(mode); }
  });
  it('withholds client acknowledgement until the canonical stored write completes', async function () {
    const fixture = context();
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const collection = fixture.collections.treatments;
    const insert = collection.insertOne;
    collection.insertOne = async doc => { entered(); await gate; return insert(doc); };
    const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try {
      const executeWrite = createExecutor({ contextForOperation: () => ({ ...fixture, authorizationFor: () => grants }) });
      const receive = createApiReceiver({ authenticateTransport: async () => true, resolveTenant: async () => A,
        authorizeSocket: async () => ({ tenant: A }), executeWrite });
      const forwarder = createForwarder({ contextForSocket: () => ({ tenant: A, credential: { token: 'synthetic-client' } }),
        transport: envelope => receive({}, envelope) });
      let acknowledged = false;
      const writing = forwarder.forward({ namespace: '/', event: 'dbAdd', args: [pattern.addTreatment()],
        acknowledge: () => { acknowledged = true; } });
      await started;
      try {
        assert.equal(collection.documents.length, 0);
        assert.equal(acknowledged, false, 'client acknowledgement preceded stored write');
      } finally { release(); }
      assert.deepEqual(await writing, { delivered: true });
      assert.equal(acknowledged, true); assert.equal(collection.documents.length, 1);
    } finally { scope.setTenancyMode(mode); }
  });
  it('refuses substituted cross-tenant role authority before acquiring storage and without acknowledgement', async function () {
    let acquired = false, acknowledged = false;
    const executeWrite = createExecutor({ contextForOperation: () => { acquired = true; return {}; } });
    const receive = createApiReceiver({ authenticateTransport: async () => true, resolveTenant: async () => A,
      authorizeSocket: async () => ({ tenant: B, permissions: grants }), executeWrite });
    const forwarder = createForwarder({ contextForSocket: () => ({ tenant: A, credential: { role: 'synthetic-role' } }),
      transport: envelope => receive({}, envelope) });
    const mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try {
      assert.deepEqual(await forwarder.forward({ namespace: '/', event: 'dbAdd', args: [pattern.addTreatment()],
        acknowledge: () => { acknowledged = true; } }), { delivered: false });
      assert.equal(acquired, false); assert.equal(acknowledged, false);
    } finally { scope.setTenancyMode(mode); }
  });
  it('uses the trusted storage port intentFactory and refuses a port without one', async function () {
    const fixture = context();
    let writes = 0;
    fixture.ctx.storagePorts = { resolve: ({ logical, source }) => {
      assert.equal(logical, 'treatments'); assert.equal(source, 'socket');
      return { storage: { findFiltered: async () => [] }, intentFactory: () => ({ write: async () => {
        writes++; return { removed: 0 };
      } }) };
    } };
    const handlers = createHandlers({ ...fixture, authorizationFor: () => grants });
    await call(handlers, 'dbRemove', { collection: 'treatments', _id: 'synthetic' });
    assert.equal(writes, 1, 'owned port write boundary must execute');
    fixture.ctx.storagePorts.resolve = () => ({ storage: { findFiltered: async () => [] } });
    const reply = await call(handlers, 'dbAdd', pattern.addTreatment());
    assert.equal(writes, 1, 'missing factory cannot fall back to a bare storage write');
    assert.equal(fixture.collections.treatments.documents.length, 0);
    assert(reply[0].error || reply[0].result !== 'success');
  });

  it('refuses ack and malformed DATA vectors before context acquisition', async function () {
    const execute = createExecutor({ contextForOperation: () => { throw new Error('must not acquire'); } });
    for (const [event, args] of [['ack', [1, 'group', 2]], ['dbAdd', []], ['dbRemove', [{}, {}]]]) {
      await assert.rejects(execute({ tenant: A, actor: { tenant: A }, source: 'socket', namespace: '/', event, args }),
        { code: 'SOCKET_FORWARD_MESSAGE_REFUSED' });
    }
  });
});
