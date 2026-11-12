'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), { Pool } = require('pg');
const { create } = require('../lib/diagnostics/m7');
const createFixture = require('./fixtures/api-fixed-roster-serving');
const { optInSuite } = require('./support/opt-in');
const captured = worker => worker.stdout.split('\n').filter(line => line.startsWith('NS_M7_DIAGNOSTICS ')).flatMap(line => {
  try { return [JSON.parse(line.slice('NS_M7_DIAGNOSTICS '.length))]; } catch { return []; }
});
const outcomes = [];
for (const enabled of [false, true]) optInSuite(process.env.NS_M7_DIAGNOSTICS_DOCKER_TEST === '1', 'NS_M7_DIAGNOSTICS_DOCKER_TEST=1')(
  'M7 diagnostics actual CLI ' + (enabled ? 'enabled' : 'default off'), function () {
    this.timeout(120000);
    const f = createFixture({ leaseSessions: 1, environment: enabled ? { NS_M7_DIAGNOSTICS: '1', NS_M7_DIAGNOSTICS_INTERVAL_MS: '1000',
      ...(process.env.NS_M7_DIAGNOSTICS_TEST_PRELOAD ? { NODE_OPTIONS: '--require ' + process.env.NS_M7_DIAGNOSTICS_TEST_PRELOAD + ' --require ' + path.join(__dirname, 'fixtures/api-fixed-roster-controls.js') } : {}) } : {} });
    const [A, B] = f.base.tenants; let a, b;
    const call = (id, tenant, method, path, token, body, headers) => f.base.http(f.current.get(id), tenant, method, path, token, body, headers);
    before(async () => { await f.setup(); a = await f.base.localToken(A); b = await f.base.localToken(B); });
    after(() => f.cleanup());
    if (enabled) it('observes real held-pool waiting, acquisition wait and pg_sleep separately from checkedout', async () => {
      const pool = new Pool({ connectionString: f.lifetimeConnectionString, max: 1 }), diag = create({ enabled: true, intervalMs: 60000,
        sinkFactory: () => ({ state: () => 'ready', send: (bytes, callback) => { callback(true); return true; }, close () {} }) });
      diag.configureRoles(['api']); diag.observePool(pool, 'storage');
      let first, queued, second;
      try {
        first = await pool.connect(); queued = pool.connect();
        await f.base.until(async () => pool.waitingCount === 1, 'real pool waiter');
        let snapshot = diag.snapshot(); assert.equal(snapshot.pools.storage.checkedout, 1); assert.equal(snapshot.pools.storage.waiting, 1); assert.equal(snapshot.pools.storage.activeSQL, 0);
        await new Promise(resolve => setTimeout(resolve, 100)); first.release(); first = null; second = await queued; queued = null; second.release(); second = null;
        snapshot = diag.snapshot(); assert(snapshot.durations['pool.wait_storage'].maxMs >= 80);
        const sleeping = pool.query('SELECT pg_sleep(0.2)');
        await f.base.until(async () => diag.snapshot().pools.storage.activeSQL === 1, 'actual outstanding SQL query');
        assert.equal(diag.snapshot().pools.storage.checkedout, 1); await sleeping;
        snapshot = diag.snapshot(); assert.equal(snapshot.pools.storage.activeSQL, 0); assert.equal(snapshot.pools.storage.checkedout, 0); assert.equal(snapshot.pools.storage.idle, 1);
        assert(snapshot.durations['pool.query_storage'].maxMs >= 180); assert.equal(snapshot.pools.storage.sqlStatus, 'MEASURED');
        await assert.rejects(pool.query('SELECT 1/0'), { code: '22012' }); assert.equal(diag.snapshot().pools.storage.activeSQL, 0);
      } finally { if (first) first.release(); if (queued) second = await queued.catch(() => null); if (second) second.release(); await pool.end(); diag.close(); }
    });
    it('preserves stored results/errors and restore drain while separating held responses from SQL', async () => {
      const identifier = 'diagnostics-held-response'; let responseFinished = false;
      const initialSnapshots = captured(f.current.get('api-1')).length;
      const pending = call('api-1', A, 'POST', '/api/v3/entries', a,
        { identifier, app: 'synthetic-diagnostics', type: 'sgv', date: Date.now(), utcOffset: 0, sgv: 125 }, { 'x-roster-hold': 'postcommit' })
        .then(value => { responseFinished = true; return { value }; }, error => ({ error }));
      await f.base.until(async () => f.withAdmin(async client => (await client.query("SELECT count(*)::int AS n FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2", [A, identifier])).rows[0].n === 1), 'actual stored write before wire completion');
      const stored = await f.withAdmin(async client => (await client.query("SELECT doc FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2", [A, identifier])).rows[0].doc);
      assert.equal(stored.sgv, 125);
      // Snapshot cadence is not request duration: hold the exact same
      // controlled lifetime ON/OFF rather than inferring elapsed time from it.
      await new Promise(resolve => setTimeout(resolve, 1100));
      let held;
      if (enabled) {
        await f.base.until(async () => { held = captured(f.current.get('api-1')).slice(initialSnapshots).findLast(row => row.gauges['window.outer_bodies'].value > 0 && row.pools.storage.activeSQL === 0 && row.pools.operation.activeSQL === 0); return !!held; }, 'held response diagnostic snapshot');
        assert.equal(held.pools.operation.status, 'MEASURED'); assert.equal(held.pools.operation.sqlStatus, 'MEASURED'); assert.equal(held.pools.storage.sqlStatus, 'MEASURED'); assert(held.pools.operation.checkedout >= 1); assert(held.gauges['lifetime.lease_holders'].value >= 1);
        assert(held.durations['window.admission'].count > 0); assert(held.durations['window.register'].count > 0); assert(held.durations['api.authorize'].count > 0);
        assert.equal(held.gauges['lifetime.critical_active'].value, 0); assert(Buffer.byteLength(JSON.stringify(held)) < 8192);
        assert(!JSON.stringify(held).includes(a)); assert(!JSON.stringify(held).includes(A)); assert(!JSON.stringify(held).includes(identifier));
      } else { assert.equal(captured(f.current.get('api-1')).length, 0); }
      let entered = false;
      const restoring = f.restore(async () => { entered = true; return 'diagnostic-drain'; }).then(value => ({ value }), error => ({ error }));
      let Bstatus;
      try {
        await f.base.until(async () => (await call('api-2', A, 'GET', '/api/v3/entries', a)).status !== 200, 'A suspended during held response');
        assert.equal(entered, false); assert.equal(responseFinished, false); Bstatus = (await call('api-1', B, 'GET', '/api/v3/entries', b)).status; assert.equal(Bstatus, 200);
      } finally { f.current.get('api-1').child.kill('SIGUSR2'); }
      const response = await pending, restored = await restoring;
      assert.equal(response.error, undefined); assert.equal(response.value.status, 201); assert.equal(restored.error, undefined, restored.error?.code); assert.equal(restored.value.state, 'activated');
      const denied = await call('api-1', B, 'GET', '/api/v3/entries', a); assert.equal(denied.status, 401);
      if (enabled) await f.base.until(async () => captured(f.current.get('api-1')).some(row => row.gauges['window.outer_bodies'].value === 0 && row.durations['window.body_response_inclusive'].maxMs >= 900 && row.durations['window.complete_inclusive'].count > held.durations['window.complete_inclusive'].count), 'completion duration observed after actual response drain');
      outcomes.push({ storedSGV: stored.sgv, write: response.value.status, B: Bstatus, wrongTenant: denied.status, restore: restored.value.state });
      if (outcomes.length === 2) assert.deepEqual(outcomes[1], outcomes[0], 'SAME_SOURCE_ON_OFF_RESULTS_AND_DRAIN');
    });
  });
