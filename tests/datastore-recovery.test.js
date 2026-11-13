'use strict';
// covers: lib/server/serve/datastore-recovery.js, lib/tenant-lifecycle/operation-window.js, lib/tenant-lifecycle/lifetime-sessions.js, lib/server/serve/operation-cohort.js, lib/server/serve/tenant-startup.js
// Source protocol and break-it controls for decision datastore-loss-recover-in-place.
// Recording clients only: tests/datastore-recovery.integration.test.js holds the PostgreSQL evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const roles = ['api', 'evaluator', 'realtime', 'tenant-admin'];
const RESTARTED = { postmaster_birth: '1700000999.000000' };

function load (relative, overrides = {}, mutate) {
  const file = path.resolve(__dirname, relative), output = { exports: {} };
  const original = require('node:module').createRequire(file);
  const source = fs.readFileSync(file, 'utf8'), changed = mutate ? mutate(source) : source;
  // A control whose replacement no longer matches the source would pass for the wrong reason.
  if (mutate && changed === source) throw new Error('control did not change ' + relative);
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: file })(
    name => Object.hasOwn(overrides, name) ? overrides[name] : original(name), output, output.exports);
  return output.exports;
}
const WINDOW = '../lib/tenant-lifecycle/operation-window.js', SUPERVISOR = '../lib/server/serve/datastore-recovery.js';

describe('Datastore recovery in place: source protocol and controls (not PostgreSQL evidence)', function () {
  describe('operation window', function () {
    async function restartedWindow (create) {
      const options = {}, f = fixture(options, create);
      assert.equal(await f.window.run(A, () => 1), 1);
      await f.window.probe();
      const before = f.window.datastore;
      options.datastore = RESTARTED;
      return { f, options, before };
    }
    it('refuses every operation and the probe after the postmaster changed, until recover re-admits it', async function () {
      const { f, before } = await restartedWindow();
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(f.window.run(A, () => assert.fail('body ran on an unadmitted datastore')), { code: 'LIFECYCLE_WINDOW_DATASTORE_CHANGED' });
        await assert.rejects(f.window.probe(), { code: 'LIFECYCLE_WINDOW_DATASTORE_CHANGED' });
      }
      assert.deepEqual(f.window.datastore, before, 'no operation adopts a datastore');
      let dropped = 0;
      const result = await f.window.recover({ beforeAdopt: async () => { dropped++; assert.deepEqual(f.window.datastore, before, 'cached state is dropped before adoption'); } });
      assert.deepEqual({ ...result }, { restarted: true, sessionsReplaced: 0 }); assert.equal(dropped, 1);
      assert.equal(f.window.datastore.postmaster_birth, RESTARTED.postmaster_birth);
      await f.window.probe(); assert.equal(await f.window.run(A, () => 2), 2);
    });
    it('runs the full catalogue admission again before adopting', async function () {
      const { f } = await restartedWindow();
      const before = f.log.filter(row => typeof row[0] === 'string' && row[0].includes('operation-window-role')).length;
      await f.window.recover();
      assert.equal(f.log.filter(row => typeof row[0] === 'string' && row[0].includes('operation-window-role')).length, before + 1);
    });
    it('does not drop cached state when the postmaster is the same one', async function () {
      const f = fixture(); await f.window.run(A, () => 1);
      const result = await f.window.recover({ beforeAdopt: () => assert.fail('same postmaster') });
      assert.equal(result.restarted, false);
    });
    it('adopts the same cluster at another address (a recreated database container)', async function () {
      const options = {}, f = fixture(options); await f.window.run(A, () => 1);
      options.datastore = { ...RESTARTED, server_address: '127.0.0.2', server_port: 5433 };
      assert.equal((await f.window.recover()).restarted, true);
      assert.equal(f.window.datastore.server_address, '127.0.0.2'); assert.equal(await f.window.run(A, () => 3), 3);
    });
    for (const [label, change, system] of [['a newly initialized cluster', {}, '7399999999999999999'], ['another database', { database_oid: '16999' }], ['a database of another name', { database: 'other' }]]) {
      it('refuses to adopt ' + label + ' in place', async function () {
        const options = {}, f = fixture(options); await f.window.run(A, () => 1);
        const before = f.window.datastore; options.datastore = { ...RESTARTED, ...change }; if (system) options.cluster = system;
        await assert.rejects(f.window.recover({ beforeAdopt: () => assert.fail('nothing is dropped for a refused datastore') }), { code: 'LIFECYCLE_WINDOW_DATASTORE_REPLACED' });
        assert.deepEqual(f.window.datastore, before);
        await assert.rejects(f.window.run(A, () => assert.fail('served another datastore')), { code: 'LIFECYCLE_WINDOW_DATASTORE_CHANGED' });
      });
    }
    it('control: without the lineage comparison a newly initialized cluster is adopted (the check above goes red)', async function () {
      const mutate = source => source.replace('!same(lineage(nextDatabase, nextCluster), lineage(database, cluster)) || ', '');
      const broken = load(WINDOW, {}, mutate);
      const options = {}, f = fixture(options, broken.create); await f.window.run(A, () => 1);
      options.datastore = RESTARTED; options.cluster = '7399999999999999999';
      await f.window.recover();
      assert.equal(f.window.datastore.postmaster_birth, RESTARTED.postmaster_birth, 'broken source adopted another cluster');
    });
    it('control: without recover the window stays refused however often it is asked (the J behaviour)', async function () {
      const { f } = await restartedWindow();
      for (let attempt = 0; attempt < 20; attempt++) await assert.rejects(f.window.run(B, () => 1), { code: 'LIFECYCLE_WINDOW_DATASTORE_CHANGED' });
    });
  });

  describe('lifetime sessions', function () {
    function pool () {
      const clients = [];
      return { clients, options: { max: 4, connectionTimeoutMillis: 0 }, connect: async () => {
        const client = new EventEmitter(); client.released = null; client.release = error => { client.released = error || true; };
        clients.push(client); return client;
      } };
    }
    it('keeps a lane whose backend was lost refused, counts it, and replaces it on reset', async function () {
      const p = pool(), sessions = require('../lib/tenant-lifecycle/lifetime-sessions').create({ pool: p, size: 1 });
      const first = await sessions.acquire(A);
      assert.equal(sessions.failed(), 0);
      const loss = Object.assign(new Error('terminating connection'), { code: '57P01' });
      first.client.emit('error', loss);
      assert.equal(sessions.failed(), 1);
      for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(sessions.acquire(A), error => error === loss);
      assert.equal(p.clients.length, 1, 'a lost lane opens no backend on its own');
      assert.equal(sessions.reset(), 1); assert.equal(sessions.failed(), 0);
      assert.equal(first.client.released, loss, 'the lost backend is returned to the pool as failed');
      assert.equal(first.client.listenerCount('error'), 0);
      const second = await sessions.acquire(A);
      assert.notEqual(second.client, first.client); assert.equal(p.clients.length, 2);
      assert.equal(await second.serial(() => 5), 5);
      assert.equal(sessions.reset(), 0, 'a healthy lane is never replaced');
      assert.equal((await sessions.acquire(A)).client, second.client);
      await sessions.close();
    });
    it('replaces a lane that never opened a backend', async function () {
      let refuse = true; const p = pool(), open = p.connect;
      p.connect = async () => { if (refuse) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); return open(); };
      const sessions = require('../lib/tenant-lifecycle/lifetime-sessions').create({ pool: p, size: 1 });
      await assert.rejects(sessions.acquire(A), { code: 'ECONNREFUSED' });
      refuse = false;
      await assert.rejects(sessions.acquire(A), { code: 'ECONNREFUSED' }, 'still the lost lane');
      assert.equal(sessions.reset(), 1);
      assert.ok((await sessions.acquire(A)).client);
      await sessions.close();
    });
    it('a poison after reset neither releases twice nor emits on the returned backend', async function () {
      const p = pool(), sessions = require('../lib/tenant-lifecycle/lifetime-sessions').create({ pool: p, size: 1 });
      const held = await sessions.acquire(A); let releases = 0;
      held.client.release = () => { releases++; };
      held.client.emit('error', new Error('lost')); sessions.reset();
      held.poison(new Error('late cleanup')); assert.equal(releases, 1);
      await sessions.close();
    });
  });

  describe('supervisor', function () {
    function harness ({ mutate, bound = 60000, source = SUPERVISOR } = {}) {
      const timers = [], events = [], state = { clock: 0, probe: null, recover: null, readopt: null, restarted: true, available: true, exhausted: [] };
      const contexts = [{ invalidateAll: async () => { events.push('invalidate-a'); }, resume: () => { events.push('resume-a'); } }, { invalidateAll: async () => { events.push('invalidate-b'); } }];
      const cohort = {
        window: {
          probe: async () => { events.push('probe'); if (state.probe) throw state.probe; },
          recover: async ({ beforeAdopt }) => {
            events.push('recover'); if (state.recover) throw state.recover;
            if (state.restarted) await beforeAdopt();
            events.push('adopt'); return { restarted: state.restarted, sessionsReplaced: 1 };
          }
        },
        contexts: () => contexts,
        datastoreUnavailable: () => { state.available = false; events.push('unavailable'); },
        datastoreRecovered: result => { state.available = true; events.push('recovered:' + result.restarted); }
      };
      const module = mutate ? load(source, {}, mutate) : require(source);
      const supervisor = module.create({ cohort, intervalMs: 5000, boundMs: bound, baseDelayMs: 250, maxDelayMs: 5000, attemptTimeoutMs: 1000,
        exhausted: code => state.exhausted.push(code), readopt: async () => { events.push('readopt'); if (state.readopt) throw state.readopt; return 3; },
        now: () => state.clock, random: () => 1, log: () => {},
        setTimer: (fn, delay) => { const timer = { fn, delay, unref () {} }; timers.push(timer); return timer; },
        clearTimer: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } });
      // Run the one planned timer, advancing the injected clock by its delay.
      return { supervisor, state, events, timers, module };
    }
    const lost = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    async function settle (h) { const delay = h.timers[0].delay; const timer = h.timers.shift(); h.state.clock += delay; await timer.fn(); await new Promise(resolve => setImmediate(resolve)); return delay; }

    it('probes on its interval and changes nothing while the probe passes', async function () {
      const h = harness(); h.supervisor.start();
      assert.equal(await settle(h), 5000); assert.equal(await settle(h), 5000);
      assert.deepEqual(h.events, ['probe', 'probe']); assert.equal(h.state.available, true);
      assert.equal(h.supervisor.state().state, 'serving');
      await h.supervisor.close();
    });
    it('reports unavailable at the first failed probe, backs off, and serves only after recover, readopt and a passing probe', async function () {
      const h = harness(); h.supervisor.start();
      h.state.probe = lost(); h.state.recover = lost();
      await settle(h);
      assert.deepEqual(h.events, ['probe', 'unavailable', 'recover']); assert.equal(h.state.available, false);
      const delays = [];
      for (let i = 0; i < 6; i++) delays.push(await settle(h));
      assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000, 5000], 'exponential, capped (random pinned to its upper edge)');
      assert.equal(h.state.available, false); assert.equal(h.supervisor.state().state, 'recovering');
      h.state.recover = null; h.state.readopt = lost(); h.events.length = 0;
      await settle(h);
      assert.deepEqual(h.events, ['recover', 'invalidate-a', 'invalidate-b', 'adopt', 'readopt']);
      assert.equal(h.state.available, false, 'a pool that cannot follow keeps the process unavailable');
      h.state.readopt = null; h.state.restarted = false; h.events.length = 0;
      await settle(h);
      assert.deepEqual(h.events, ['recover', 'adopt', 'readopt', 'probe'], 'probe still failing');
      assert.equal(h.state.available, false);
      h.state.probe = null; h.state.restarted = true; h.events.length = 0;
      await settle(h);
      assert.deepEqual(h.events, ['recover', 'invalidate-a', 'invalidate-b', 'adopt', 'readopt', 'probe', 'recovered:true', 'resume-a'],
        'state dropped before adoption; tenants warmed only once the process serves again');
      assert.equal(h.state.available, true); assert.equal(h.supervisor.state().state, 'serving');
      assert.equal(h.timers[0].delay, 5000);
      assert.deepEqual(h.state.exhausted, []);
      await h.supervisor.close();
    });
    it('calls the exhaustion handler once, after the bound and not before', async function () {
      const h = harness({ bound: 10000 }); h.supervisor.start();
      h.state.probe = lost(); h.state.recover = Object.assign(new Error('replaced'), { code: 'LIFECYCLE_WINDOW_DATASTORE_REPLACED' });
      await settle(h);
      const started = h.state.clock;
      while (h.timers.length) { assert.deepEqual(h.state.exhausted, [], 'not before the bound'); assert.ok(h.state.clock - started < 10000); await settle(h); }
      assert.deepEqual(h.state.exhausted, ['LIFECYCLE_WINDOW_DATASTORE_REPLACED']);
      assert.ok(h.state.clock - started >= 10000);
      assert.equal(h.supervisor.state().state, 'exhausted'); assert.equal(h.state.available, false);
      await h.supervisor.tick(); assert.equal(h.state.exhausted.length, 1);
      await h.supervisor.close();
    });
    it('a pool loss signal asks at once instead of at the next interval', async function () {
      const h = harness(); h.supervisor.start();
      assert.equal(h.timers[0].delay, 5000);
      h.supervisor.signal();
      assert.equal(h.timers.length, 1); assert.equal(h.timers[0].delay, 0);
      await h.supervisor.close();
    });
    it('refuses a role context that cannot drop its cached tenant state', async function () {
      const module = require(SUPERVISOR), events = [];
      const supervisor = module.create({ cohort: { window: { probe: async () => { throw lost(); }, recover: async ({ beforeAdopt }) => { await beforeAdopt(); events.push('adopt'); return { restarted: true, sessionsReplaced: 0 }; } },
        contexts: () => [{}], datastoreUnavailable () {}, datastoreRecovered () { events.push('recovered'); } }, exhausted () {}, readopt: async () => 0, log () {},
      setTimer: () => ({ unref () {} }), clearTimer () {} });
      await supervisor.tick();
      assert.deepEqual(events, []); assert.equal(supervisor.state().lastRefusal, 'DATASTORE_RECOVERY_CONTEXT_UNSUPPORTED');
      await supervisor.close();
    });
    it('control: a supervisor that does not mark the cohort unavailable leaves it reporting available while the probe fails', async function () {
      const h = harness({ mutate: source => source.replace('cohort.datastoreUnavailable();', '') }); h.supervisor.start();
      h.state.probe = lost(); h.state.recover = lost();
      await settle(h); await settle(h);
      assert.equal(h.state.available, true, 'broken source: health would stay green');
      await h.supervisor.close();
    });
    it('control: a supervisor that skips the drop of cached state adopts a restarted postmaster with the old tenant state', async function () {
      const h = harness({ mutate: source => source.replace('window.recover({ beforeAdopt: invalidateAll })', 'window.recover({ beforeAdopt: async () => {} })') }); h.supervisor.start();
      h.state.probe = lost(); await settle(h); h.state.probe = null;
      assert.equal(h.events.includes('invalidate-a'), false, 'broken source dropped nothing');
      assert.equal(h.events.includes('adopt'), true);
      await h.supervisor.close();
    });
    it('reads its two settings from the environment and refuses values outside their bounds', function () {
      const { settings } = require(SUPERVISOR);
      assert.deepEqual({ ...settings({}) }, { intervalMs: 5000, boundMs: 120000 });
      assert.deepEqual({ ...settings({ NS_DATASTORE_PROBE_INTERVAL_MS: '1000', NS_DATASTORE_RECOVERY_BOUND_MS: '30000' }) }, { intervalMs: 1000, boundMs: 30000 });
      for (const bad of [{ NS_DATASTORE_PROBE_INTERVAL_MS: '100' }, { NS_DATASTORE_PROBE_INTERVAL_MS: '5s' }, { NS_DATASTORE_RECOVERY_BOUND_MS: '0' }, { NS_DATASTORE_RECOVERY_BOUND_MS: '999' }]) {
        assert.throws(() => settings(bad), /a whole number from/);
      }
    });
  });

  describe('tenant startup', function () {
    const startup = require('../lib/server/serve/tenant-startup');
    it('drops a tenant without queueing a warm that could only fail, and warms it when asked', async function () {
      let initialized = 0, available = false;
      const cells = startup.create([A, B], undefined, async () => { if (!available) throw new Error('datastore down'); initialized++; },
        { readiness: 'serve', concurrency: 2, alert: () => {}, drainedLog: () => {} });
      available = true; await cells.warm(); await cells.drained();
      assert.equal(initialized, 2); assert.deepEqual(cells.tenants(), [A, B]);
      available = false;
      for (const tenant of cells.tenants()) cells.invalidateTenant(tenant, { warm: false });
      await cells.drained();
      assert.equal(cells.health().failed, 0, 'no warm ran against the lost datastore'); assert.equal(cells.isReady(A), false);
      available = true; await cells.warm(); await cells.drained();
      assert.equal(initialized, 4); assert.equal(cells.health().ready, true); assert.equal(cells.isReady(A), true);
      cells.close();
    });
    it('control: the default invalidation queues the warm at once, which fails while the datastore is down and holds the tenant failed', async function () {
      let available = true;
      const cells = startup.create([A], undefined, async () => { if (!available) throw new Error('datastore down'); },
        { readiness: 'serve', alert: () => {}, drainedLog: () => {} });
      await cells.warm(); await cells.drained();
      available = false; cells.invalidateTenant(A); await cells.drained();
      assert.equal(cells.health().failed, 1);
      available = true;
      await assert.rejects(cells.admit(A), { code: 'TENANT_UNAVAILABLE' }, 'refused for the failure back-off although the datastore is back');
      await cells.warm(); await cells.drained();
      await cells.admit(A);
      cells.close();
    });
  });

  describe('operation cohort', function () {
    async function setup () {
      const f = fixture(), invalidations = [];
      const lower = { ...require('../lib/storage/postgres-connection'), installOperationWindow: () => () => {}, cohortBackends: () => [],
        cohortSnapshot: async () => ({ datastore: f.window.datastore, backends: [] }) };
      const module = load('../lib/server/serve/operation-cohort.js', { '../../storage/postgres-connection': lower,
        ...Object.fromEntries(['preview-api', 'evaluator-preview', 'preview-realtime', 'owner-preview'].map((name, i) => ['./' + name, {
          boot: async () => ({ close: async () => {}, invalidateTenant: async tenant => invalidations.push([roles[i], tenant]), invalidateAll: async () => {} }) }])) });
      const cohort = await module.create({ window: f.window, names: roles, tenants: [A, B], namespaces: ['clinical'] });
      for (const role of roles) await cohort.boot(role, { tenantIds: [A, B] });
      cohort.complete();
      return { f, module, cohort, invalidations };
    }
    it('answers no invalidation or census while the datastore is unavailable, and again after recovery', async function () {
      const s = await setup();
      await s.module.invalidate(s.cohort, A); assert.equal(s.invalidations.length, 4);
      assert.equal(s.cohort.datastoreAvailable, true); assert.equal(s.cohort.contexts().length, 4);
      s.cohort.datastoreUnavailable();
      assert.equal(s.cohort.datastoreAvailable, false);
      await assert.rejects(s.module.invalidate(s.cohort, A), { code: 'RESTORE_COHORT_DATASTORE_UNAVAILABLE' });
      await assert.rejects(s.module.assertComplete(s.cohort, A, { client: { query: async () => assert.fail('no census while unavailable') } }), { code: 'RESTORE_COHORT_DATASTORE_UNAVAILABLE' });
      await assert.rejects(s.module.pin(s.cohort, A, {}), { code: 'RESTORE_COHORT_DATASTORE_UNAVAILABLE' });
      assert.equal(s.invalidations.length, 4);
      s.cohort.datastoreRecovered({ restarted: true });
      await s.module.invalidate(s.cohort, A); assert.equal(s.invalidations.length, 8);
      await s.cohort.close();
    });
  });
});
