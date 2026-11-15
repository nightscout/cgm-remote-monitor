'use strict';
// Source-only callback contract: real boot wiring, trusted reader and bootstrap;
// synthetic connection/role ports. No listeners, child processes or database.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const trustedWorker = require('../lib/trusted-worker/postgres');
const scope = require('../lib/storage/tenant-scope');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture (count, selected, ordinal = 0) {
  const ids = Array.from({ length: count }, (_, i) => '11111111-1111-4111-8111-' + String(i).padStart(12, '0'));
  const tenants = new Map(ids.map(id => [id, {}]));
  const calls = { scans: [], pages: [], invalidated: [], wakes: [], readiness: 0, verify: 0 };
  const state = { secured: true, holdReadiness: null, holdSettings: null, failPage: false };
  const connection = { async readOnly (text, values) {
    if (/FROM pg_class/.test(text)) { calls.verify++; return { rows: [1,2,3,4].map(() => ({ secured: state.secured, owns: false, writes: false })) }; }
    if (/WHERE false/.test(text)) return { rows: [] };
    if (/activity_version/.test(text)) {
      calls.scans.push([...values[0]]);
      return { rows: values[0].map(tenant => ({ tenant, activity_version: '1', paused: false, suspended: false, settings: 1, policy: 1, stamp: '1', deleted: '0' })) };
    }
    if (state.holdSettings) await state.holdSettings.promise;
    return { rows: [{ version: 1, values: {}, generation: 1, policy: { deployment: {}, overrides: {} } }] };
  }, async end () {} };
  const store = { async own () {}, async admit () {}, async close () {},
    async observeMany (page) { calls.pages.push(page); if (state.failPage) throw Error('SYNTHETIC_COMMIT_LOSS'); } };
  const gate = { start () {}, async refresh () {}, admits: tenant => !selected || ids.indexOf(tenant) % 2 === ordinal, reason: () => null, onChange () {}, close () {} };
  const member = { configured: { leaseMs: 1000 }, async register () {}, async close () {} };
  const runtime = { async close () {}, async invalidateTenant (id) { calls.invalidated.push(id); }, health: () => ({ tenants: [] }) };
  const profile = { digest: 'synthetic-profile', binding: { tenants: ids, lifecycleNamespace: 'work_activity', namespace: 'work_checkpoint', consumer: 'work', members: 2, membershipNamespace: 'work_membership', revision: 1, role: 'intake' }, assignment: { owner: tenant => ids.indexOf(tenant) % 2 } };
  const peers = [0,1].map(id => ({ id: String(id), roles: ['evaluator'], endpoint: {} }));
  const config = { tenants, registry: {}, pgstream: { bounds: { recoveryMs: 30000, stallMs: 5000, heartbeatMs: 1000 } },
    trustedWorker: { activity: 'work_activity', clock: 'work_clock', settings: 'work_settings', operatorPolicy: 'work_policy' },
    namespaces: { checkpoint: 'work_checkpoint' }, connectionString: 'postgres://worker:synthetic@localhost/test', consumer: 'work', consumers: {}, maxTenants: 20000 };
  if (selected) Object.assign(config, { partition: { partitioned: true, ordinal, namespace: 'work_membership', leaseMs: 3000 }, intakeStateSync: { assignmentRevision: 1 },
    selectedIntake: { profile, workers: ['0','1'], connectionString: 'postgres://intake:synthetic@localhost/test', controlConnectionString: 'postgres://control:synthetic@localhost/test' },
    consumers: { realtime: { partitionMetadata: {}, route: { id: 'synthetic-realtime' } } } });
  if (selected && ordinal === 1) { delete config.selectedIntake.connectionString; delete config.selectedIntake.controlConnectionString; }
  let callbacks, reader;
  const connect = Object.assign(async () => connection, { async readopt () {} });
  const readiness = Object.assign(async () => { calls.readiness++; if (state.holdReadiness) await state.holdReadiness.promise; }, { async provisionTenant () {} });
  const mocks = {
    '../../storage/postgres-connection': connect,
    '../../data/tenant-projection-evaluator': { domains: [] },
    './evaluator-runtime': async () => runtime,
    './evaluator-config': { registryEntry () {} },
    './registry-tenant-set': { async open () { return { tenants, revision: () => 1, activeIds: () => ids, waiting: () => 0, async follow () {}, async close () {} }; } },
    './evaluator-readiness': readiness,
    '../../pool-membership': { async member () { return member; } },
    './evaluator-pool': { create: () => gate },
    './pool-config': { pool: () => ({ max: 2 }), tenantReadiness: () => 'serve', startupConcurrency: () => 1 },
    '../../trusted-worker/postgres': { create (options) { reader = trustedWorker.create(options); return reader; } },
    '../../trusted-worker/lifecycle': async value => { await value.verify(); return { verify: () => value.verify(), version: () => 1, activateRefresh () {}, async close () {} }; },
    '../../pgstream/evaluator': { async open (options) { callbacks = options; return { store, async ready () { await state.atReady(); }, async close () {}, assertAvailable () {}, health: () => ({ healthy: true }) }; } },
    './tenant-startup': { create: () => ({ async warm () {}, async close () {}, isReady: () => true }) },
    './evaluator-consumers': { async prepare () { return { start () {}, async close () {} }; } },
    '../../pgstream/activity-scheduler': { start: () => ({ async recover () {}, wakeDelivery () {}, wake: (...args) => calls.wakes.push(args), async close () {} }) },
    '../internal-api/clients': { completedOutput: () => ({ hintCompletedOutput () {} }), pgstreamInput: () => ({}) },
    './evaluator-inspection': () => () => ({}),
    '../../pgstream/intake-profile': { validate: () => profile },
    '../../tenant-lifecycle/operation-window': { isWindow: () => true },
    './operation-cohort-manifest': { isParticipant: () => true },
    './evaluator-consumer-config': { endpoint: () => 'synthetic' },
    '../../pgstream/intake-state': { worker (options) { const value = { available: false, async synchronize () { if (!value.available) { await options.revalidate(); await options.reconcile(); value.available = true; } }, async close () {} }; return value; } },
    '../../pgstream/checkpoint': { create: () => store },
    '../../pgstream/input-hints': { router: () => () => {}, handler: () => () => {} }
  };
  const filename = require.resolve('../lib/server/serve/evaluator-' + (selected ? 'selected-' : '') + 'preview');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(mocks, name) ? mocks[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const options = selected ? { operationWindow: { namespace: 'work_activity', intakeProfileDigest: profile.digest }, intakeBinding () {}, partitionParticipants: peers, partitionParticipant: peers[ordinal] } : { operationWindow: {} };
  return { calls, state, ids, ownIds: selected ? ids.filter(tenant => profile.assignment.owner(tenant) === ordinal) : ids, store, reader: () => reader, callbacks: () => callbacks,
    async boot (atReady = async () => {}) { state.atReady = async () => { try { await atReady(); } catch (error) { state.error = error; throw error; } }; try { return await loaded.exports.boot(config, options); } catch (error) { throw state.error || error; } } };
}
describe('evaluator schema work bounds', function () {
  let prior;
  beforeEach(() => { prior = scope.getTenancyMode(); });
  afterEach(() => { scope.setTenancyMode(prior); });
  for (const selected of [false, true]) {
    const name = selected ? 'selected' : 'global';
    for (const count of [1, 65, 500]) for (const events of [0, 1, 4]) it(name + ' boot scans only once for durable recovery at cohort ' + count + ', events ' + events, async () => {
      const f = fixture(count, selected);
      const service = await f.boot(async () => {
        for (let event = 0; event < events; event++) await f.callbacks().onSchema(['work_clock']);
        assert.equal(f.calls.readiness, 1 + events, 'EVERY_SCHEMA_ACK_REVALIDATES');
        await f.callbacks().onRecovered(f.store);
        console.log(JSON.stringify({ entry: name, cohort: count, schemaEvents: events, scans: f.calls.scans.length, tenantVisits: f.calls.scans.flat().length, durableRows: f.calls.pages.flat().length }));
        assert.equal(f.calls.scans.length, 1, 'RECOVERY_RECONCILES_ONCE');
        assert.equal(f.calls.scans.flat().length, count, 'RECOVERY_COVERS_ENTIRE_COHORT');
        assert.equal(f.calls.pages.flat().length, count, 'DURABLE_BOOTSTRAP_COVERS_COHORT');
        assert(f.calls.pages.every(page => page.length <= 64), 'DURABLE_PAGES_STAY_BOUNDED');
      });
      await service.close();
    });
    it(name + ' schema refuses authority loss and fences an old settings read across revalidation', async () => {
      const f = fixture(2, selected); const service = await f.boot();
      try {
        await f.reader().verify(); await f.reader().scan(f.ids);
        const hold = deferred(); f.state.holdSettings = hold;
        const pending = f.reader().read(f.ids[0]); pending.catch(() => {});
        await f.callbacks().onSchema(['work_clock']);
        hold.resolve(); await assert.rejects(pending, /TRUSTED_WORKER_UNAVAILABLE/, 'OLD_SCHEMA_READ_NOT_CACHED');
        f.state.holdSettings = null;
        f.state.secured = false;
        await assert.rejects(f.callbacks().onSchema(['work_clock']), /TRUSTED_WORKER_UNAVAILABLE/, 'SCHEMA_AUTHORITY_LOSS_REFUSED');
        assert.equal(f.reader().state().available, false);
      } finally { await service.close(); }
    });
    it(name + ' schema ACK awaits validation, invalidates live instances and leaves metadata discovery to bounded scheduling', async () => {
      const f = fixture(65, selected); const service = await f.boot();
      try {
        await f.reader().verify(); const before = f.calls.scans.length;
        const hold = deferred(); f.state.holdReadiness = hold;
        let acked = false;
        const schema = f.callbacks().onSchema(['work_clock']).then(() => { acked = true; });
        assert.equal(f.reader().state().available, false, 'SCHEMA_FENCE_IS_IMMEDIATE');
        await Promise.resolve(); assert.equal(acked, false, 'SCHEMA_ACK_AWAITS_READINESS');
        hold.resolve(); await schema;
        assert.deepEqual(f.calls.invalidated, f.ownIds, 'LIVE_INSTANCES_STILL_DRAIN_AND_INVALIDATE');
        assert.equal(f.calls.scans.length, before, 'NO_EAGER_LIVE_SCHEMA_COHORT_SCAN');
        assert.deepEqual(f.calls.wakes.map(row => row[0]), f.ownIds, 'ALL_LIVE_TENANTS_REMAIN_SCHEDULED');
      } finally { await service.close(); }
    });
    for (const count of [1, 65, 500]) it(name + ' live acquisition rereads post-schema metadata in scheduler pages at cohort ' + count, async () => {
      const f = fixture(count, selected), service = await f.boot(); let scheduler;
      try {
        await f.callbacks().onSchema(['work_clock']);
        assert(f.ownIds.every(tenant => f.reader().current(tenant) === null));
        const ran = [];
        scheduler = require('../lib/pgstream/activity-scheduler').start({
          store: { nextDue: async () => null },
          scan: ids => f.reader().scan(ids),
          run: async tenant => { assert(f.reader().current(tenant), 'SCHEDULER_MUST_READ_FRESH_METADATA_BEFORE_ACQUISITION'); ran.push(tenant); },
          send: async () => {}, setTimer: () => ({ unref () {} }), clearTimer () {}
        });
        for (const tenant of f.ownIds) scheduler.wake(tenant, 'schema');
        // One turn admits at most four pages; continue the next bounded turn.
        await scheduler.drain(); await scheduler.drain();
        assert.deepEqual(ran, f.ownIds);
        assert(f.calls.scans.every(ids => ids.length <= 64), 'POST_SCHEMA_ACQUISITION_SCAN_STAYS_BOUNDED');
        assert.equal(f.calls.scans.flat().length, f.ownIds.length);
      } finally { await scheduler?.close(); await service.close(); }
    });
    it(name + ' recovery refuses an uncommitted bootstrap page', async () => {
      const f = fixture(65, selected); const service = await f.boot();
      try { f.state.failPage = true; await assert.rejects(f.callbacks().onRecovered(f.store), /SYNTHETIC_COMMIT_LOSS/); assert.equal(f.calls.pages.length, 1); }
      finally { await service.close(); }
    });
  }
  it('selected ordinal one reconciles its own slice before startup without an eager scan or intake bootstrap', async () => {
    const f = fixture(65, true, 1), service = await f.boot();
    try { assert.deepEqual(f.calls.scans, [f.ownIds]); assert.equal(f.calls.pages.length, 0); }
    finally { await service.close(); }
  });
});
