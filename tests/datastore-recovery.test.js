'use strict';
// covers: lib/server/serve/datastore-recovery.js, lib/server/serve/datastore-probe.js, lib/server/serve/tenant-startup.js
// Source protocol and break-it controls for decision datastore-loss-recover-in-place.
// Recording clients only: tests/datastore-recovery.integration.test.js holds the PostgreSQL evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

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
const SUPERVISOR = '../lib/server/serve/datastore-recovery.js';

describe('Datastore recovery in place: source protocol and controls (not PostgreSQL evidence)', function () {
  describe('plain role connection probe', function () {
    function fixture (mutate) {
      const observed = { database: 'test', database_oid: '16384', server_address: '127.0.0.1/32', server_port: 5432, postmaster_birth: '100' };
      const state = { cluster: '7100000000000000001' };
      class Driver extends EventEmitter {
        async connect () {}
        async end () {}
        async query (sql) { return { rows: [sql.includes('pg_control_system') ? { cluster: state.cluster } : { ...observed }] }; }
      }
      const path = '../lib/server/serve/datastore-probe.js';
      return { observed, state, probe: load(path, {}, mutate).create({ options: {}, Driver }) };
    }
    for (const [field, change] of [['database', 'other'], ['database_oid', '16500'], ['cluster', '7200000000000000001']]) {
      it('refuses a different ' + field + ' before adopting or serving', async function () {
        const f = fixture();
        const initial = await f.probe.probe();
        if (field === 'cluster') f.state.cluster = change; else f.observed[field] = change;
        await assert.rejects(f.probe.readmit(), { code: 'DATASTORE_PROBE_REPLACED' });
        assert.deepEqual(f.probe.admitted, initial);
      });
    }
    it('control: removes cluster comparison and observes a different cluster accepted', async function () {
      const f = fixture(source => source.replace('system !== admittedCluster || ', ''));
      await f.probe.probe();
      f.state.cluster = '7200000000000000001';
      assert.equal((await f.probe.readmit()).restarted, false);
    });
    it('re-admits a moved endpoint on the same database and cluster', async function () {
      const f = fixture();
      const initial = await f.probe.probe();
      f.observed.server_address = '127.0.0.2/32';
      await assert.rejects(f.probe.probe(), { code: 'DATASTORE_PROBE_RESTARTED' });
      const seen = await f.probe.readmit();
      assert.equal(seen.restarted, true);
      assert.deepEqual(f.probe.admitted, initial);
      f.probe.adopt(seen.current);
      assert.deepEqual(await f.probe.probe(), seen.current);
    });
  });

  describe('generation admissions across a datastore withdrawal', function () {
    const recovery = require('../lib/server/serve/datastore-recovery');
    const protocol = require('./fixtures/operation-window-runtime-protocol');
    const refused = { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' };
    function fixture () {
      const target = recovery.availability(() => [], () => undefined);
      const { window, client } = protocol({ available: () => target.available, availabilityEpoch: () => target.epoch });
      return { target, window, client };
    }
    it('leaves active scopes, detached database reservations and released receipts invalid after a transient withdrawal', async function () {
      const { target, window, client } = fixture();
      const lease = await window.acquireClient(client, A);
      let receipt;
      try {
        await window.run(A, async () => {}, { onScope: value => { receipt = value; } });
        assert.equal(window.readinessReceiptCurrent(receipt), true);
        await window.run(A, async () => {
          const previous = target.epoch;
          assert.equal(window.current(A), true);
          target.datastoreUnavailable();
          const withdrawn = target.epoch;
          assert.notEqual(withdrawn, previous);
          target.datastoreUnavailable(); target.datastoreRecovered();
          assert.equal(target.epoch, withdrawn);
          assert.equal(window.current(A), false);
          assert.equal(window.readinessReceiptCurrent(receipt), false);
          assert.throws(() => window.assertCurrent(A), refused);
          await assert.rejects(window.run(A, () => assert.fail('stale nested scope')), refused);
          await assert.rejects(window.assertClient(client, A, lease), refused);
        });
        await window.run(A, async () => assert.equal(window.current(A), true));
        assert.equal(window.readinessReceiptCurrent(receipt), false);
      } finally { lease.close(); await window.close(); }
    });
    it('cannot admit a generation observation whose transaction finishes after recovery', async function () {
      const { target, window, client } = fixture();
      const query = client.query;
      let entered, release;
      const observing = new Promise(resolve => { entered = resolve; });
      const resume = new Promise(resolve => { release = resolve; });
      client.query = async (sql, values) => {
        if (sql === 'COMMIT') { entered(); await resume; }
        return query(sql, values);
      };
      try {
        const pending = window.run(A, () => assert.fail('PRE_LOSS_OBSERVATION_ENTERED_BODY'));
        await observing; target.datastoreUnavailable(); target.datastoreRecovered(); release();
        await assert.rejects(pending, refused);
        await window.run(A, async () => assert.equal(window.current(A), true));
      } finally { release(); await window.close(); }
    });
  });

  describe('supervisor', function () {
    function harness ({ mutate, bound = 60000, timeout = 1000 } = {}) {
      const timers = [], events = [];
      const state = { clock: 0, probe: null, recover: null, restarted: true, available: true, exhausted: [] };
      const contexts = [{ invalidateAll: async () => { events.push('invalidate-a'); }, resume: () => events.push('resume-a') },
        { invalidateAll: async () => { events.push('invalidate-b'); } }];
      const target = {
        contexts: () => contexts,
        datastoreUnavailable: () => { state.available = false; events.push('unavailable'); },
        datastoreRecovered: seen => { state.available = true; events.push('recovered:' + seen.restarted); }
      };
      const probe = {
        probe: async () => { events.push('probe'); if (state.probe) throw state.probe; },
        readmit: async () => { events.push('recover'); if (state.recover) throw state.recover; return { restarted: state.restarted, current: {} }; },
        adopt: () => events.push('adopt')
      };
      const module = load(SUPERVISOR, {}, mutate);
      const supervisor = module.create({ target, probe, intervalMs: 5000, boundMs: bound, baseDelayMs: 250, maxDelayMs: 5000, attemptTimeoutMs: timeout,
        exhausted: code => state.exhausted.push(code),
        now: () => state.clock, random: () => 1, log: () => {},
        setTimer: (fn, delay) => { const timer = { fn, delay, unref () {} }; timers.push(timer); return timer; },
        clearTimer: timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); } });
      // Run the one planned timer, advancing the injected clock by its delay.
      return { supervisor, state, events, timers, probe, contexts };
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
    it('backs off while unavailable and invalidates cached state before publishing the new datastore', async function () {
      const h = harness();
      h.supervisor.start();
      h.state.probe = lost(); h.state.recover = lost();
      await settle(h);
      assert.equal(h.state.available, false);
      assert.deepEqual(h.events, ['probe', 'unavailable', 'recover']);
      assert.equal(await settle(h), 500);
      h.state.recover = null; h.events.length = 0; await settle(h);
      assert.deepEqual(h.events, ['recover', 'invalidate-a', 'invalidate-b', 'adopt', 'recovered:true', 'resume-a']);
      assert.equal(h.state.available, true);
      await h.supervisor.close();
    });
    it('keeps the same postmaster’s cached tenant state on a transient connection failure', async function () {
      const h = harness();
      h.state.restarted = false; h.state.probe = lost();
      await h.supervisor.tick();
      assert.deepEqual(h.events, ['probe', 'unavailable', 'recover', 'adopt', 'recovered:false', 'resume-a']);
      await h.supervisor.close();
    });
    it('calls the exhaustion handler once, after the bound and not before', async function () {
      const h = harness({ bound: 10000 }); h.supervisor.start();
      h.state.probe = lost(); h.state.recover = Object.assign(new Error('replaced'), { code: 'DATASTORE_PROBE_REPLACED' });
      await settle(h);
      const started = h.state.clock;
      while (h.timers.length) { assert.deepEqual(h.state.exhausted, [], 'not before the bound'); assert.ok(h.state.clock - started < 10000); await settle(h); }
      assert.deepEqual(h.state.exhausted, ['DATASTORE_PROBE_REPLACED']);
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
      const h = harness();
      h.contexts.push({}); h.state.probe = lost();
      await h.supervisor.tick();
      assert.equal(h.state.available, false);
      assert.equal(h.supervisor.state().lastRefusal, 'DATASTORE_RECOVERY_CONTEXT_UNSUPPORTED');
      assert(!h.events.includes('adopt'));
      await h.supervisor.close();
    });
    for (const [needle, symptom] of [['target.datastoreUnavailable();', 'available'], ['if (seen.restarted) await bounded(invalidateAll);', 'stale cache']]) {
      it('control: observes ' + symptom + ' after removal of its recovery transition', async function () {
        const h = harness({ mutate: source => source.replace(needle, '') });
        h.state.probe = lost();
        if (symptom === 'available') h.state.recover = lost();
        await h.supervisor.tick();
        if (symptom === 'available') assert.equal(h.state.available, true);
        else { assert(h.events.includes('adopt')); assert(!h.events.includes('invalidate-a')); }
        await h.supervisor.close();
      });
    }
    for (const operation of ['probe', 'readmit']) {
      it('retains custody of a timed-out ' + operation + ' without concurrent retries or late adoption', async function () {
        const h = harness({ bound: 10, timeout: 5 });
        let release, attempts = 0;
        const held = new Promise(resolve => { release = resolve; });
        h.state.probe = lost();
        h.probe[operation] = async () => { attempts++; await held; return { restarted: true, current: {} }; };
        try {
          await h.supervisor.tick();
          assert.equal(h.supervisor.state().pendingSteps, 1);
          h.state.clock = 20; await h.supervisor.tick();
          assert.equal(attempts, 1);
          assert.deepEqual(h.state.exhausted, ['DATASTORE_RECOVERY_STEP_PENDING']);
          await assert.rejects(h.supervisor.close(), { code: 'DATASTORE_RECOVERY_DRAIN_UNCONFIRMED' });
          release(); await new Promise(resolve => setImmediate(resolve));
          assert(!h.events.includes('adopt')); assert.equal(h.state.available, false);
        } finally { release(); await h.supervisor.close().catch(() => {}); }
      });
    }
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
    it('removes queued warm work during recovery', async function () {
      const calls = []; let release, started;
      const firstStarted = new Promise(resolve => { started = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      const cells = startup.create([A, B], undefined, async tenant => {
        calls.push(tenant); if (tenant === A) { started(); await held; }
      }, { readiness: 'serve', concurrency: 1, alert: () => {}, drainedLog: () => {} });
      try {
        await cells.warm(); await firstStarted;
        cells.invalidateTenant(B, { warm: false }); release(); await cells.drained();
        assert.deepEqual(calls, [A], 'RECOVERY_DROPS_ALREADY_QUEUED_WARM');
        assert.equal(cells.isReady(B), false);
        await cells.warm(); await cells.drained();
        assert.deepEqual(calls, [A, B], 'RECOVERY_RESUME_EXPLICITLY_REWARMS');
      } finally { release(); await cells.close(); }
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

});

describe('supplemental PostgreSQL cluster lineage metadata', function () {
  const datastore = require('../lib/storage/postgres-datastore');
  it('requires one canonical signed bigint string without coercing malformed metadata', async function () {
    for (const cluster of ['7000000000000000001', '-7000000000000000001']) assert.equal(await datastore.cluster({ query: async () => ({ rows: [{ cluster }] }) }), cluster);
    for (const cluster of [null, 1, ['7000000000000000001'], '0', '01', '-0', '1.5', '9223372036854775808', '-9223372036854775809']) {
      await assert.rejects(datastore.cluster({ query: async () => ({ rows: [{ cluster }] }) }), /cluster identity unavailable/);
    }
    for (const rows of [[], [{ cluster: '1' }, { cluster: '1' }]]) await assert.rejects(datastore.cluster({ query: async () => ({ rows }) }), /cluster identity unavailable/);
  });
  it('propagates a denied metadata query instead of falling back to endpoint identity', async function () {
    const refusal = Object.assign(Error('SYNTHETIC_PRIVILEGE_REFUSAL'), { code: '42501' });
    await assert.rejects(datastore.cluster({ query: async () => { throw refusal; } }), error => error === refusal);
  });
});
