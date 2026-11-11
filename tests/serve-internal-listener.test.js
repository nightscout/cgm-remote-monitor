'use strict';

// One serve.internal per role process (decision internal-listener-ory-pattern).
// The actual serve/index start() with stand-in role boots: the roles' code
// decides the contracts, the listener opens before the roles boot, a
// co-resident caller reaches api during realtime's boot, a role cannot bind a
// contract it does not own, and an unbound contract refuses start-up. Actual
// UDS listener, production transport, contracts and alarm handlers; the role
// contexts are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const listenerConfig = require('../lib/server/internal-api/listener-config');
const internalListener = require('../lib/server/serve/internal-listener');
const clients = require('../lib/server/internal-api/clients');
const contracts = require('../lib/server/internal-api/contracts');

const A = '11111111-1111-4111-8111-111111111111';
const BOUNDS = { maxMessageBytes: 100000, operationTimeoutMs: 2000 };
const routes = service => Object.values(service.operations).map(operation => 'POST ' + operation.path);

function load (relative, overrides, mutate) {
  const file = path.resolve(__dirname, relative), output = { exports: {} };
  const source = fs.readFileSync(file, 'utf8'), changed = mutate ? mutate(source) : source;
  if (mutate && changed === source) throw new Error('Mutation marker must match actual source');
  const original = Module.createRequire(file);
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: file })(
    name => Object.hasOwn(overrides, name) ? overrides[name] : original(name), output, output.exports);
  return output.exports;
}
function runtime () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-internal-')); fs.chmodSync(dir, 0o700);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// serve/index with stand-in roles. `roles` maps role -> async boot(config, internal) -> ctx.
function serve (roles, internalModule = internalListener) {
  return load('../lib/server/serve/index.js', {
    './listeners': { resolve: () => [], close: async () => {} },
    './internal-listener': internalModule,
    ...Object.fromEntries([['api', 'preview-api'], ['realtime', 'preview-realtime'], ['evaluator', 'evaluator-preview'], ['tenant-admin', 'owner-preview']]
      .map(([role, file]) => ['./' + file, { boot: config => roles[role](config) }]))
  });
}
const authority = { permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: ['entries'] };

describe('serve.internal: one private listener per role process', function () {
  this.timeout(10000);
  it('composes the contracts the roles own on one listener, before the roles boot; a co-resident caller reaches api during realtime boot', async function () {
    const r = runtime(), events = [], delivered = [];
    const internal = listenerConfig.resolve(['api', 'realtime'], { NS_SERVE_INTERNAL_SOCKET: path.join(r.dir, 'api+realtime.sock') });
    const roles = {
      async api () {
        events.push('boot:api');
        return { internal: { 'socket-authority': { create: token => ({
          async authorizeSocket (request, body) { assert.equal(request.transport, token); events.push('authorize:' + body.tenant); return authority; },
          async executeSocketMutation () { throw new Error('unused'); } }) } }, close: async () => events.push('close:api') };
      },
      async realtime (config) {
        events.push('boot:realtime');
        // As preview-realtime warms its tenants: the api peer is this process's listener.
        const reply = await clients.socketAuthority(config.api).authorizeSocket({ host: 'a.test', tenant: A, namespace: '/', credential: {} });
        assert.deepEqual(reply, authority);
        return { internal: { 'alarm-delivery': { create: token => require('../lib/server/realtime/alarm-transport').operations({ token, deliver: async value => delivered.push(value) }) } },
          close: async () => events.push('close:realtime') };
      }
    };
    try {
      const running = await serve(roles).start(['api', 'realtime'], {}, null, {}, { internal,
        preview: { socketForwarding: BOUNDS }, realtimePreview: { ...BOUNDS, api: internal.peer('api', { maxBytes: BOUNDS.maxMessageBytes, timeoutMs: BOUNDS.operationTimeoutMs }) } });
      assert.deepEqual([...running.internalListener.routes].sort(), [...routes(contracts.socketAuthority), ...routes(contracts.alarmDelivery)].sort(), 'INTERNAL_ROUTES_FROM_ROLE_CODE');
      assert.deepEqual(events, ['boot:api', 'boot:realtime', 'authorize:' + A]);
      const peer = internal.peer('realtime', { maxBytes: 100000, timeoutMs: 2000 });
      assert.equal(peer.socketPath, path.join(r.dir, 'api+realtime.sock'), 'realtime is reached on the same listener');
      assert.deepEqual(await clients.alarmDelivery(peer).deliverAlarm({ tenant: A, id: A, attempt: 1, notification: { title: 'synthetic' }, receipts: [] }),
        { accepted: true, receipt: null, clearedRequestIds: [] });
      assert.equal(delivered.length, 1);
      await running.stop();
      assert.equal(fs.existsSync(peer.socketPath), false, 'listener closed and unlinked on stop');
    } finally { r.cleanup(); }
  });
  it('opens no private listener when the process serves no internal contract', async function () {
    const running = await serve({ async evaluator () { return { close: async () => {} }; } }).start(['evaluator'], {}, null, {}, { evaluatorPreview: { namespaces: { checkpoint: 'e' } } });
    assert.equal(running.internalListener, undefined);
    await running.stop();
  });
  it('refuses at start-up a role that binds a contract it does not own, or leaves an owned contract unbound', async function () {
    const r = runtime();
    try {
      const internal = listenerConfig.resolve(['realtime', 'evaluator'], { NS_SERVE_INTERNAL_SOCKET: path.join(r.dir, 'rt.sock') });
      const alarm = token => require('../lib/server/realtime/alarm-transport').operations({ token, deliver: async () => {} });
      // evaluator offers realtime's alarm-delivery handlers on the shared listener.
      const unowned = serve({ async realtime () { return { close: async () => {} }; },
        async evaluator () { return { internal: { 'alarm-delivery': { create: alarm } }, close: async () => {} }; } });
      await assert.rejects(unowned.start(['realtime', 'evaluator'], {}, null, {}, { internal, realtimePreview: { ...BOUNDS, namespaces: { checkpoint: 'r' } }, evaluatorPreview: { namespaces: { checkpoint: 'e' } } }),
        { code: 'INTERNAL_API_CONTRACT_UNOWNED' }, 'INTERNAL_UNOWNED_CONTRACT_REFUSED');
      const absent = serve({ async realtime () { return { internal: { 'alarm-delivery': { create: alarm } }, close: async () => {} }; },
        async evaluator () { return { internal: { 'socket-authority': { create: () => ({}) } }, close: async () => {} }; } });
      await assert.rejects(absent.start(['realtime', 'evaluator'], {}, null, {}, { internal, realtimePreview: { ...BOUNDS, namespaces: { checkpoint: 'r' } }, evaluatorPreview: { namespaces: { checkpoint: 'e' } } }),
        { code: 'INTERNAL_API_CONTRACT_UNOWNED' }, 'a contract this process does not serve');
      assert.equal(fs.existsSync(path.join(r.dir, 'rt.sock')), false, 'the listener is closed again after a refused start-up');
      const unbound = serve({ async realtime () { return { close: async () => {} }; }, async evaluator () { return { close: async () => {} }; } });
      await assert.rejects(unbound.start(['realtime', 'evaluator'], {}, null, {}, { internal, realtimePreview: { ...BOUNDS, namespaces: { checkpoint: 'r' } }, evaluatorPreview: { namespaces: { checkpoint: 'e' } } }),
        { code: 'INTERNAL_API_CONTRACT_UNBOUND' });
    } finally { r.cleanup(); }
  });
  it('plans contracts from role code only, refusing a contract on a role that does not own it', function () {
    const participant = { roles: ['evaluator'], endpoint: { socketPath: '/srv/e.sock', maxBytes: 1000, timeoutMs: 1000 } };
    assert.deepEqual(internalListener.plan(['evaluator'], { participant }).map(row => row.id), ['lifecycle-participant']);
    assert.deepEqual(internalListener.plan(['evaluator'], {}), []);
    assert.deepEqual(internalListener.plan(['api'], { preview: {} }), [], 'socket-authority only with socket forwarding');
    assert.deepEqual(internalListener.plan(['evaluator'], { preview: { socketForwarding: BOUNDS }, realtimePreview: BOUNDS }), [],
      'another role\'s settings cannot place its contract on this process');
    assert.throws(() => internalListener.plan(['evaluator'], { participant: { ...participant, roles: ['api'] } }), { code: 'INTERNAL_API_CONTRACT_UNOWNED' });
    assert.deepEqual(Object.keys(internalListener.OWNED).sort(), [...listenerConfig.ROLES].sort());
  });
  it('control: without the ownership check, a role binding a foreign contract is accepted', async function () {
    const r = runtime();
    try {
      const mutant = load('../lib/server/serve/internal-listener.js', {}, source => source.replace("if (!OWNED[role] || !OWNED[role].includes(id) || !slot || !slot.row.roles.includes(role)) fail('INTERNAL_API_CONTRACT_UNOWNED', role + ' ' + id);",
        "if (!slot) fail('INTERNAL_API_CONTRACT_UNOWNED', role + ' ' + id);"));
      const internal = listenerConfig.resolve(['realtime', 'evaluator'], { NS_SERVE_INTERNAL_SOCKET: path.join(r.dir, 'rt.sock') });
      const alarm = token => require('../lib/server/realtime/alarm-transport').operations({ token, deliver: async () => {} });
      const running = await serve({ async realtime () { return { close: async () => {} }; },
        async evaluator () { return { internal: { 'alarm-delivery': { create: alarm } }, close: async () => {} }; } }, mutant)
        .start(['realtime', 'evaluator'], {}, null, {}, { internal, realtimePreview: { ...BOUNDS, namespaces: { checkpoint: 'r' } }, evaluatorPreview: { namespaces: { checkpoint: 'e' } } });
      await running.stop();
    } finally { r.cleanup(); }
  });
});
