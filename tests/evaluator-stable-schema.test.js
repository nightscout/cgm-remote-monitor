'use strict';
// Decision stable-evaluator-runtime, integrated across the actual preview boot,
// the actual pgstream source and the actual receiver. Recording database,
// HTTP and clinical ports; no listener, PostgreSQL or producer.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), vm = require('node:vm');
const trustedWorker = require('../lib/trusted-worker/postgres');
const scope = require('../lib/storage/tenant-scope');
const nativeBoot = require('./fixtures/evaluator-native-recovery-protocol');
const native = require('./lib/clinical-stream-native');
const fakeBaseline = require('./lib/schema-baseline-fake');
const PREVIEW = require.resolve('../lib/server/serve/evaluator-preview');
const SOURCE = require.resolve('../lib/pgstream/evaluator');

// The DDL the bootstrap emits after `pgstream init` creates the slot, as
// replayed to an evaluator that already started (L1.0, reproduced in a
// disposable PostgreSQL): one transaction with CREATE TABLE plus two ALTER
// TABLE ... ROW LEVEL SECURITY, then one ALTER TABLE ... OWNER TO, both in the
// lifecycle/control schema. The second position is delivered twice.
const control = 'work_activity';
const ddl = (tag, objects) => ({ action: 'M', xid: 42, lsn: '0/1', prefix: 'pgstream.ddl',
  content: JSON.stringify({ ddl: 'synthetic', schema_name: control, command_tag: tag, objects: objects.map(type => ({ type, identity: control + '.tenant_lifecycle_recommission', schema: control })) }) });
const provisioning = [
  native.envelope([ddl('CREATE TABLE', ['table']), ddl('ALTER TABLE', ['table']), ddl('ALTER TABLE', ['table'])], '0/1E4D6E0'),
  native.envelope([ddl('ALTER TABLE', ['table'])], '0/1E4EBD0'),
  native.envelope([ddl('ALTER TABLE', ['table'])], '0/1E4EBD0')
];

function fixture ({ count = 3, previewText = fs.readFileSync(PREVIEW, 'utf8'), sourceText = fs.readFileSync(SOURCE, 'utf8'), baseline = { position: '0/2000000' } } = {}) {
  const ids = Array.from({ length: count }, (_, i) => '11111111-1111-4111-8111-' + String(i).padStart(12, '0'));
  const tenants = new Map(ids.map(id => [id, {}]));
  const calls = { readiness: 0, verify: 0, streamInvalidated: 0, runtimeInvalidated: 0, terminal: [] };
  const config = { tenants, registry: { namespace: 'work_registry' }, pgstream: nativeBoot.config({ slot: 'work_stream', bounds: { recoveryMs: 30000, stepMs: 5000, pendingMs: 30000 },
    receiver: { url: 'http://127.0.0.1:23999/', bindHost: '127.0.0.1', timeoutMs: 1000, maxBytes: 100000 }, streamRole: 'work_role' }),
  trustedWorker: { activity: control, clock: 'work_clock', settings: 'work_settings', operatorPolicy: 'work_policy' },
  namespaces: { ...Object.fromEntries(require('../lib/storage/clinical-stream-state').DOMAINS.map(domain => [domain, 'work_' + domain])), checkpoint: 'work_checkpoint', clock: 'work_clock' },
  connectionString: 'postgres://worker:synthetic@localhost/test', consumer: 'evaluator-work', consumers: {}, maxTenants: 20000, maxRows: 10000, maxBytes: 10000, pageSize: 64 };
  let handler, reader, sourceOpen, opened;
  const connection = { async readOnly (text, values) {
    const startup = fakeBaseline.answer(text, values, baseline); if (startup) return startup;
    if (text.includes('FROM pg_roles r CROSS JOIN pg_database')) return { rows: [{ rolsuper: false, rolbypassrls: false, rolreplication: true, nonowner: true, same_database: true, plugin: 'wal2json', grants: true, wal_status: 'reserved', restart_lsn: '0/1' }] };
    if (text.includes('pgstream.webhook_subscriptions')) {
      const url = 'http://127.0.0.1:23999/pgstream', actual = require(SOURCE);
      return { rows: [...actual.routes(config).map(route => ({ url, schema_name: route.schema, table_name: route.table, event_types: ['D', 'I', 'U'] })), { url, schema_name: '', table_name: '', event_types: ['B', 'C', 'M'] }] };
    }
    if (/FROM pg_class/.test(text)) { calls.verify++; return { rows: values[0].map(() => ({ secured: true, owns: false, writes: false })) }; }
    if (/WHERE false/.test(text)) return { rows: [] };
    if (/activity_version/.test(text)) return { rows: values[0].map(tenant => ({ tenant, activity_version: '1', paused: false, suspended: false, settings: 1, policy: 1, stamp: '1', deleted: '0' })) };
    return { rows: [{ version: 1, values: {}, generation: 1, policy: { deployment: {}, overrides: {} } }] };
  }, async end () {} };
  const store = { available: true, async own () {}, async admit () {}, async close () {}, async observeMany () {}, async complete () {}, assignment: undefined, witness: async () => [] };
  const server = { listen: (_port, _host, done) => done(), close: done => done(), once () {} };
  const runtime = { async close () {}, async invalidateTenant () { calls.runtimeInvalidated++; }, health: () => ({ tenants: [] }), markPending () {}, async resumeVerifications () {}, last () {}, isCurrent: () => false };
  const compileSource = () => {
    const local = Module.createRequire(SOURCE), output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + sourceText + '\n})', { filename: SOURCE })(name =>
      name === 'node:http' ? { createServer: fn => { handler = fn; return server; } } : name === './checkpoint' ? { create: () => store } : local(name), output, output.exports);
    return output.exports;
  };
  const mocks = {
    ...nativeBoot.mocks(),
    '../../storage/postgres-connection': Object.assign(async () => connection, { async readopt () {} }),
    '../../storage/postgres-durable-replay': () => ({ configureStream () {}, async invalidateStream () { calls.streamInvalidated++; }, async acceptTransaction () { return []; }, sourceAccess: () => ({}) }),
    '../../data/tenant-projection-evaluator': { domains: [] },
    './evaluator-runtime': async () => runtime,
    './evaluator-config': { registryEntry () {}, async withSettings () { return {}; } },
    './registry-tenant-set': { async openDemand () { return { tenants: new Map(), isActive: () => false, revision: () => 1, onRemove () {}, async close () {} }; } },
    // The role's one platform check, counted as its readiness.
    './platform-verification': require('./fixtures/platform-proof')(undefined, async () => { calls.readiness++; }),
    './evaluator-readiness': Object.assign(async () => { calls.readiness++; }, { async provisionTenant () {} }),
    '../../pool-membership': { async member () { return { configured: { leaseMs: 1000 }, async register () {}, async close () {} }; } },
    './evaluator-pool': { create: () => ({ start () {}, async refresh () {}, admits: () => true, reason: () => null, onChange () {}, close () {} }) },
    './pool-config': { pool: () => ({ max: 2 }), tenantReadiness: () => 'serve', startupConcurrency: () => 1 },
    '../../trusted-worker/postgres': { create (options) { reader = trustedWorker.create(options); return reader; } },
    '../../trusted-worker/lifecycle': async value => { await value.verify(); return { verify: () => value.verify(), async close () {} }; },
    '../../pgstream/evaluator': { async open (options) { sourceOpen = options; opened = await compileSource().open(options); return opened; } },
    './tenant-startup': { create: () => ({ async warm () {}, async close () {}, isReady: () => true, health: () => ({}) }) },
    './evaluator-consumers': { async prepare () { return { start () {}, async recover () {}, async close () {} }; } },
    '../../pgstream/activity-scheduler': { start: () => ({ async recover () {}, wake () {}, async close () {}, stats: () => ({}) }) },
    '../internal-api/clients': { completedOutput: () => ({ hintCompletedOutput () {} }) },
    './evaluator-inspection': () => () => ({}),
    '../../tenant-lifecycle/operation-window': { isWindow: () => true, isPendingVerification: () => false }
  };
  const loaded = new Module(PREVIEW, module); loaded.filename = PREVIEW; loaded.paths = Module._nodeModulePaths(path.dirname(PREVIEW));
  loaded.require = name => Object.hasOwn(mocks, name) ? mocks[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(previewText, PREVIEW);
  const options = { operationWindow: { currentGeneration: () => 1, trustedWorker: false } };
  async function send (body) {
    let status; const req = { method: 'POST', url: '/pgstream', async *[Symbol.asyncIterator] () { yield Buffer.from(JSON.stringify(body)); } };
    await handler(req, { writeHead (value) { status = value; return this; }, end () {} }); return status;
  }
  return { calls, ids, send, reader: () => reader, sourceOpen: () => sourceOpen, source: () => opened, boot: () => loaded.exports.boot(config, options) };
}

// The L1.1 criterion: replayed provisioning DDL after start is acknowledged
// with no invalidation, re-verification or runtime work.
async function replayCriterion (options) {
  const prior = scope.getTenancyMode(), f = fixture(options);
  let service;
  try {
    service = await f.boot();
    const before = { ...f.calls, readerInvalidations: { ...f.reader().health().invalidations } };
    const statuses = [];
    for (const body of provisioning) statuses.push(await f.send(body));
    const after = f.reader().health().invalidations;
    const observed = { statuses, streamInvalidated: f.calls.streamInvalidated - before.streamInvalidated, runtimeInvalidated: f.calls.runtimeInvalidated - before.runtimeInvalidated,
      readiness: f.calls.readiness - before.readiness, readerInvalidations: Object.values(after).reduce((a, b) => a + b, 0) - Object.values(before.readerInvalidations).reduce((a, b) => a + b, 0),
      health: f.source().health().schema ?? null };
    return observed;
  } finally { await service?.close(); scope.setTenancyMode(prior); }
}

describe('stable evaluator runtime: replayed provisioning DDL after start', function () {
  it('is acknowledged with no invalidation, re-verification or runtime work, and repeats are no-ops', async () => {
    const observed = await replayCriterion();
    assert.deepEqual(observed.statuses, [204, 204, 204]);
    assert.equal(observed.streamInvalidated, 0, 'NO_STREAM_INVALIDATION'); assert.equal(observed.runtimeInvalidated, 0, 'NO_RUNTIME_INVALIDATION');
    assert.equal(observed.readerInvalidations, 0, 'NO_TRUSTED_READER_INVALIDATION'); assert.equal(observed.readiness, 0, 'NO_REVERIFICATION_WHILE_SERVING');
    assert.deepEqual(observed.health, { phase: 'established', baseline: '0/2000000', acknowledged: 2, startupAcknowledged: 0, repeated: 1, terminalPosition: null });
  });
  it('stops the role with one typed terminal code for relevant DDL after the baseline', async () => {
    const prior = scope.getTenancyMode(), f = fixture({ baseline: { position: '0/1E4D6E0' } });
    let service;
    try {
      service = await f.boot(); let terminal = null; service.failure.then(error => { terminal = error.code; });
      assert.equal(await f.send(provisioning[0]), 204);
      assert.equal(await f.send(provisioning[1]), 503);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(terminal, 'EVALUATOR_SCHEMA_CHANGED_AFTER_STARTUP');
      assert.equal(f.calls.streamInvalidated + f.calls.runtimeInvalidated, 0, 'TERMINAL_IS_NOT_IN_PLACE_INVALIDATION');
      assert.equal(f.source().health().schemaBlocked, true);
    } finally { await service?.close(); scope.setTenancyMode(prior); }
  });
});
module.exports = { replayCriterion, provisioning };
