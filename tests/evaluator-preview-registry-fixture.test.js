'use strict';
// Actual NEW fixture source with recording setup dependencies; no PG, Vault,
// network, child, or native lifecycle proof. Shared realtime labs stay unchanged.
// covers: tests/fixtures/evaluator-preview-registry-lab.js
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const { EventEmitter } = require('node:events');
function fixture () {
  const calls = [], roles = new Set(), provisionedIds = new Set(); let inheritedResets = 0, lab;
  const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
  const namespaces = Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','settings','clock'].map(k => [k, 'protocol_' + k]));
  const registry = { ...Object.fromEntries(['registry','legacy','secrets','authorization','access','control','settings','operatorPolicy'].map(k => [k, 'provisioned_' + k.toLowerCase()])), clock: namespaces.clock };
  const admin = { async query (text, values) {
    calls.push({ text, values });
    const create = /^CREATE ROLE "([^"]+)"/.exec(text); if (create) roles.add(create[1]);
    const drop = /^DROP ROLE "([^"]+)"/.exec(text); if (drop) roles.delete(drop[1]);
    return { rows: [], rowCount: 2 };
  } };
  const base = () => (lab = { name: 'evaluator_protocol', A, B, namespaces, domains: Object.keys(namespaces).filter(k => k !== 'clock'),
    tables: Object.fromEntries(require('../lib/data/tenant-projection-evaluator').domains.map(k => [k, namespaces[k] + '.' + k])),
    replayNamespace: 'protocol_replay', reader: {}, admin,
    async open () { await lab.reset(); }, async reset () { inheritedResets++; calls.push({ text: 'INHERITED_RESET' }); },
    async close () { calls.push({ text: 'BASE_CLOSE' }); }, checkpoint: async () => ({ checkpoint: 0 }), physical: async () => ({}) });
  const parsed = require('../lib/server/serve/evaluator-config');
  const parser = { ...parsed, async withSettings (current, selected, tenant) { calls.push({ identity: { current, selected, tenant } }); return { identity: 'actual-export-sentinel' }; } };
  const filename = require.resolve('./fixtures/evaluator-preview-registry-lab');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => {
    if (name === 'node:child_process') return { fork (file, args, options) {
      calls.push({ worker: { file, args, options } });
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = 0;
      queueMicrotask(() => child.emit('message', { ready: true })); return child;
    }, spawn () { throw Error('UNEXPECTED_CLI_CHILD'); } };
    if (name === './pgstream-native') return {
      capability: () => ({ binary: '/synthetic/pinned-pgstream', sha256: 'f'.repeat(64), receiverPort: 19421, subscriptionsPort: 19422 }),
      configuration: ({prefix, capability}) => ({ binaryEnv: 'NS_RT_BOOTSTRAP_PGSTREAM_BINARY', configFileEnv: 'NS_RT_BOOTSTRAP_PGSTREAM_CONFIG', receiverPort: capability.receiverPort, slot: prefix + '_stream', streamRole: prefix + '_stream', bounds: { heartbeatMs: 1000, stallMs: 5000, stepMs: 5000, stopMs: 2000, recoveryMs: 30000, pendingMs: 30000, maxRestarts: 3 } }),
      async setup(options) { calls.push({ producer: options }); return { environment: { NS_RT_BOOTSTRAP_PGSTREAM_BINARY: '/synthetic/pinned-pgstream', NS_RT_BOOTSTRAP_PGSTREAM_CONFIG: path.join(options.directory, 'synthetic-stream.json') }, async close() { calls.push({ text: 'PRODUCER_CLOSE' }); } }; }
    };
    if (name === '../../lib/migrations/postgres') return { async run(action, options) { calls.push({ migration: {action, ...options} }); } };
    if (name === './m5-current-state-proof') return base;
    if (name === '../../lib/storage/postgres-durable-replay') return options => { calls.push({ replay: options }); return { digest: 'a'.repeat(64) }; };
    if (name === '../../lib/server/serve/evaluator-config') return { ...parser, parse(value, source) { return parser.parse(value, {...source,NS_RT_BOOTSTRAP_PGSTREAM_BINARY:'/synthetic/pinned-pgstream'}); } };
    if (name === './provisioned-tenants') return { async create (options) {
      calls.push({ setup: options });
      return { namespaces: registry, registryGrants: settings => require('../lib/tenant-registry/postgres').grants({ namespace: registry.registry, ...settings }),
        async provision (spec) { assert(!provisionedIds.has(spec.id)); provisionedIds.add(spec.id); calls.push({ provision: spec }); },
        provisioning: { async get (id) { return provisionedIds.has(id) ? { state: 'active' } : null; } },
        async close () { calls.push({ text: 'PROVISIONING_CLOSE' }); } };
    } };
    return Module.prototype.require.call(loaded, name);
  };
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return { create: loaded.exports, calls, roles, provisionedIds, inheritedResets: () => inheritedResets };
}
describe('independent registry evaluator fixture setup', function () {
  let prior, uri;
  beforeEach(() => { prior = scope.getTenancyMode(); scope.setTenancyMode('multi'); uri = process.env.NS_TEST_POSTGRES_ADMIN_URI; process.env.NS_TEST_POSTGRES_ADMIN_URI = 'postgres://synthetic:synthetic@127.0.0.1/evaluator_protocol_test'; });
  afterEach(() => { scope.setTenancyMode(prior); if (uri === undefined) delete process.env.NS_TEST_POSTGRES_ADMIN_URI; else process.env.NS_TEST_POSTGRES_ADMIN_URI = uri; });
  it('strictly provisions once, then resets existing clocks/checkpoints without recreating membership', async function () {
    const f = fixture(), lab = f.create();
    try {
      await lab.open(); assert.equal(f.inheritedResets(), 1);
      const first = f.calls.findIndex(c => c.setup), cleared = f.calls.findIndex(c => c.text?.startsWith('DELETE FROM "protocol_clock"'));
      assert(cleared >= 0 && cleared < first, 'inherited priming must be removed before strict provisioning');
      assert.equal(f.calls.filter(c => c.provision).length, 2); assert.equal(f.provisionedIds.size, 2);
      const owner = f.calls.find(c => c.text?.includes('_registry_owner') && c.text.startsWith('CREATE ROLE'));
      assert(owner.text.includes('NOLOGIN'));
      await lab.reset(); await lab.provisionPreview();
      assert.equal(f.inheritedResets(), 1, 'registry reset never deletes provisioned rows through inherited reset');
      assert.equal(f.calls.filter(c => c.provision).length, 2, 'reset never reprovisions existing ids');
      assert(!f.calls.some(c => c.text?.includes('ON CONFLICT')));
      const descriptors=f.calls.find(c=>c.setup).setup.checkpoints;assert.equal(descriptors.length,2);assert(descriptors.some(row=>row.consumer.endsWith('-completed')),'TYPED_OUTPUT_ACTUALLY_PROVISIONED');
      assert(f.calls.some(c=>c.migration?.catalogue?.migrations.some(row=>row.name==='0002_evaluator_typed_work')));
      assert(f.calls.some(c => c.text?.startsWith('UPDATE "protocol_clock"')));
      assert(f.calls.some(c => c.text?.startsWith('UPDATE "protocol_replay".tenant_consumer_checkpoint')));
    } finally { await lab.close(); }
    assert.equal(f.roles.size, 0); assert(f.calls.findIndex(c => c.text === 'PROVISIONING_CLOSE') < f.calls.findIndex(c => c.text === 'BASE_CLOSE'));
  });
  it('uses actual registry parser shape, separate settings credential and exported async identity resolution', async function () {
    const f = fixture(), lab = f.create();
    try {
      await lab.open(); const configured = lab.configure();
      assert(!Object.hasOwn(configured.document, 'tenants')); assert(configured.document.registry); assert(configured.document.tenantSettings);
      const value = configured.identity(lab.A); assert(value instanceof Promise); assert.equal(await value, 'actual-export-sentinel');
      const delegated = f.calls.find(c => c.identity).identity;
      assert.equal(delegated.selected.tenant, lab.A); assert.equal(delegated.tenant, lab.A); assert.equal(delegated.current.tenants.size, 0);
      assert.notEqual(new URL(delegated.current.connectionString).username, new URL(delegated.current.tenantSettings.connectionString).username);
      await lab.worker(configured);
      const worker = f.calls.find(c => c.worker).worker;
      assert.equal(path.basename(worker.file), 'evaluator-preview-worker.js', 'shared worker is reused unchanged');
      assert(!Object.hasOwn(worker.options.env, 'MULTITENANT_STATIC_TENANTS'));
      assert.equal(worker.options.env.MULTITENANT_EVALUATOR_CONFIG, configured.file);
      assert(worker.options.env.NS_EVALUATOR_FIXTURE_SETTINGS);
      assert(worker.options.env.MULTITENANT_OPERATION_CONFIG);
      assert.equal(worker.options.env.NS_RT_BOOTSTRAP_PGSTREAM_CONFIG.endsWith('synthetic-stream.json'),true);
      assert(f.calls.some(c=>c.producer),'REAL_PRODUCT_SETUP_REQUIRED_BEFORE_CHILD');
      assert(f.calls.some(c => c.text?.includes('tenant_registry_tenants(uuid, integer)')));
      assert(!f.calls.some(c => c.text?.startsWith('GRANT SELECT ON "provisioned_registry".tenant_registry,')));
    } finally { await lab.close(); }
  });
});
