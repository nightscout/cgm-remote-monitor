'use strict';

// The existing disposable PostgreSQL fixture supplies restricted data and
// maintenance principals. Only the process census is represented in memory.
// Window admission, locks, generation changes, snapshots and all COMMITs are real.
const assert = require('node:assert/strict');
const Module = require('node:module');
const { Client, Pool } = require('pg');
const maintenance = require('../../lib/tenant-lifecycle/maintenance-window');
const storage = require('../../lib/storage/postgres-connection');
const scope = require('../../lib/storage/tenant-scope');

const DIGEST = 'c'.repeat(64);
const data = 'synthetic_fence.values';
const effects = 'synthetic_fence.effects';

function selectController (fixture, pool) {
  const cohort = {}, pin = {};
  const participants = {
    async pin (selected, tenant) { assert.equal(selected, cohort); assert.equal(tenant, fixture.A); return pin; },
    async assertComplete (selected, tenant) { assert.equal(selected, cohort); assert.equal(tenant, fixture.A); },
    async operations () { return { operations: [] }; },
    async invalidate (selected, tenant) {
      assert.equal(selected, cohort);
      await fixture.window.invalidateTenant(tenant);
    },
    async releasePin (selected) { assert.equal(selected, pin); }
  };
  const load = Module._load;
  try {
    // create() captures this dependency synchronously, as in the maintenance
    // protocol tests. No process-wide substitution survives construction.
    Module._load = function (request, parent, ...other) {
      if (request === '../server/serve/operation-cohort' && parent.filename === require.resolve('../../lib/tenant-lifecycle/maintenance-window')) return participants;
      return load.call(this, request, parent, ...other);
    };
    return maintenance.create({ namespace: fixture.ns.control, locks: fixture.locks, pool, cohort, drainTimeoutMs: 8000 });
  } finally { Module._load = load; }
}

function gate () { return Promise.withResolvers(); }

// Observe worker failure while waiting for a specific real-query boundary.
// Release every deliberately held callback in the caller's finally block.
async function reached (signal, work, label) {
  let timeout;
  try {
    return await Promise.race([
      signal.promise,
      work.then(() => { throw new Error(label + ' was never reached'); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(label + ' timed out')), 6000); })
    ]);
  } finally { clearTimeout(timeout); }
}

function retryable (error) {
  assert.equal(error.code, 'LIFECYCLE_WINDOW_SUSPENDED');
  assert.equal(error.retryAfter, 1);
  return true;
}

module.exports = function register (fixture) {
  describe('transaction-scoped restore fence on native PostgreSQL', function () {
    let operatorPool, controller, lower, independent;
    let firstExclusiveAttempt, commitBarrier;

    function restore (value) {
      return controller.withRestore(fixture.A, { artifactDigest: DIGEST }, async ({ connection }) => {
        await connection.query('UPDATE ' + data + ' SET value=$2 WHERE tenant_id=$1', [fixture.A, value]);
      });
    }
    function read (tenant) {
      return lower.withTenant(tenant, async () => (await lower.query(
        'SELECT pg_backend_pid() AS pid, value FROM ' + data)).rows[0]);
    }
    function marker (label) {
      return lower.query('INSERT INTO ' + effects + ' VALUES ($1,$2)', [fixture.A, label]);
    }
    async function stored (label) {
      return (await fixture.sql('SELECT count(*)::integer AS count FROM ' + effects + ' WHERE label=$1', [label])).rows[0].count;
    }

    before(async function () {
      const role = fixture.q(fixture.l.roles.api), operator = fixture.q(fixture.l.roles.operator);
      await fixture.admin(async admin => {
        await admin.query('CREATE SCHEMA synthetic_fence');
        await admin.query('CREATE TABLE ' + data + ' (tenant_id uuid PRIMARY KEY, value text NOT NULL)');
        await admin.query('CREATE TABLE ' + effects + ' (tenant_id uuid NOT NULL, label text NOT NULL)');
        for (const table of [data, effects]) {
          await admin.query('ALTER TABLE ' + table + ' ENABLE ROW LEVEL SECURITY');
          await admin.query('ALTER TABLE ' + table + ' FORCE ROW LEVEL SECURITY');
          await admin.query('CREATE POLICY tenant ON ' + table + " USING (tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid)");
        }
        await admin.query('INSERT INTO ' + data + " VALUES ($1,'initial'),($2,'neighbour')", [fixture.A, fixture.B]);
        await admin.query('GRANT USAGE ON SCHEMA synthetic_fence TO ' + role + ',' + operator);
        await admin.query('GRANT SELECT ON ' + data + ' TO ' + role + ',' + operator);
        await admin.query('GRANT INSERT ON ' + effects + ' TO ' + role);
        await admin.query('GRANT UPDATE(value) ON ' + data + ' TO ' + operator);
        await admin.query('INSERT INTO ' + fixture.control('tenant_lifecycle_restore_authority') +
          ' (tenant_id,role_oid,active) VALUES ($1,$2::regrole::oid,true)', [fixture.A, fixture.l.roles.operator]);
      });
      class ObservedOperator extends Client {
        query (...args) {
          const result = super.query(...args);
          if (!firstExclusiveAttempt || !args[0]?.text?.includes('restore-exclusive-acquire')) return result;
          const observed = firstExclusiveAttempt;
          firstExclusiveAttempt = null;
          return result.then(value => { observed.resolve(value.rows[0].held); return value; });
        }
      }
      class ObservedData extends Client {
        query (...args) {
          if (!commitBarrier || args[0] !== 'COMMIT') return super.query(...args);
          const barrier = commitBarrier;
          commitBarrier = null;
          barrier.entered.resolve();
          return barrier.release.promise.then(() => super.query(...args));
        }
      }
      operatorPool = new Pool({ connectionString: fixture.urls.operator, max: 1, Client: ObservedOperator });
      controller = selectController(fixture, operatorPool);
      lower = await storage({ connectionString: fixture.urls.api, operationWindow: fixture.window, max: 1, Client: ObservedData });
      independent = await fixture.openLower();
    });

    after(async function () {
      await controller?.close();
      await operatorPool?.end();
      await independent?.end();
      await lower?.end();
    });

    for (const kind of ['ordinary', 'repeatable']) {
      it('refuses the ' + kind + ' effect crossing committed suspension and excludes data replacement until it ends', async function () {
        const checked = gate(), finish = gate(), attempt = gate();
        const old = await read(fixture.A);
        firstExclusiveAttempt = attempt;
        let restoring;
        const write = scope.withTenant(fixture.A, () => {
          async function body () {
            await marker(kind);
            checked.resolve();
            await finish.promise;
          }
          return kind === 'ordinary' ? lower.transaction(body) : lower.snapshotTransaction(body);
        });
        try {
          await reached(checked, write, 'effect inside admitted transaction');
          restoring = restore('after-' + kind);
          const acquired = await reached(attempt, restoring, 'maintenance replacement lock');
          assert.equal(acquired, false, 'REPLACEMENT_MUST_WAIT_FOR_CHECKED_TRANSACTION');
          const suspended = (await fixture.sql('SELECT phase FROM ' + fixture.control('tenant_lifecycle_windows') +
            ' WHERE tenant_id=$1', [fixture.A])).rows[0];
          assert.equal(suspended.phase, 'suspended');
          let entered = false;
          await assert.rejects(independent.withTenant(fixture.A, () => { entered = true; }), retryable);
          assert.equal(entered, false, 'new suspended write refused before callback');
          await independent.withTenant(fixture.B, async () => {
            assert.deepEqual((await independent.query('SELECT value FROM ' + data)).rows, [{value: 'neighbour'}]);
          });
          finish.resolve();
          await assert.rejects(write, retryable, 'GENERATION_CHANGE_MUST_REFUSE');
          await restoring;
          assert.equal(await stored(kind), 0, 'crossing effect must roll back');
          const next = await read(fixture.A);
          assert.equal(next.pid, old.pid, 'same physical data connection after restore');
          assert.equal(next.value, 'after-' + kind);
        } finally {
          finish.resolve();
          firstExclusiveAttempt = null;
          await Promise.allSettled([write, restoring]);
        }
      });
    }

    it('holds the final current-generation observation stable until its physical COMMIT', async function () {
      const entered = gate(), release = gate(), barrier = { entered, release };
      const before = (await fixture.sql('SELECT generation::text FROM ' + fixture.control('tenant_lifecycle_windows') +
        ' WHERE tenant_id=$1', [fixture.A])).rows[0].generation;
      const write = lower.withTenant(fixture.A, async () => {
        await marker('before-suspension'); commitBarrier = barrier;
      });
      let restoring;
      try {
        await reached(entered, write, 'physical COMMIT');
        restoring = restore('subsequent');
        // Suspension takes its nonblocking lock in the same generation domain
        // as the final observation. A conflict leaves the tenant serving.
        await assert.rejects(restoring, { code: 'LIFECYCLE_RESTORE_LOCK_BUSY' });
        assert.deepEqual((await fixture.sql('SELECT phase,generation::text FROM ' + fixture.control('tenant_lifecycle_windows') +
          ' WHERE tenant_id=$1', [fixture.A])).rows, [{phase: 'active', generation: before}]);
      } finally {
        commitBarrier = null; release.resolve();
        await Promise.allSettled([write, restoring]);
      }
      await write;
      assert.equal(await stored('before-suspension'), 1);
      await restore('subsequent');
      assert.equal((await read(fixture.A)).value, 'subsequent');
    });

    it('admits historical data in the same generation and refuses the same exported snapshot after restore', async function () {
      await read(fixture.A);
      await fixture.admin(async exporter => {
        await exporter.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const exported = (await exporter.query('SELECT pg_export_snapshot() AS name')).rows[0].name;
          const old = (await exporter.query('SELECT value FROM ' + data + ' WHERE tenant_id=$1', [fixture.A])).rows[0].value;
          await fixture.sql('UPDATE ' + data + " SET value='corrected' WHERE tenant_id=$1", [fixture.A]);
          const historical = fn => scope.withTenant(fixture.A, () => lower.importedSnapshotTransaction(exported, fn));
          assert.deepEqual(await historical(async () => (await lower.query('SELECT value FROM ' + data)).rows), [{ value: old }]);
          assert.equal((await read(fixture.A)).value, 'corrected');
          await restore('replaced');
          let entered = false;
          await assert.rejects(historical(() => { entered = true; }), retryable);
          assert.equal(entered, false, 'historical generation refused before caller receives data');
          assert.equal((await read(fixture.A)).value, 'replaced');
        } finally { await exporter.query('ROLLBACK'); }
      });
    });

    it('refuses an evaluator owner completion captured before restore on the same open owner socket', async function () {
      const captured = gate(), complete = gate();
      const owner = await lower.holdAdvisoryLock('932101');
      let entered = false, work;
      try {
        work = fixture.window.run(fixture.A, async () => {
          const generation = fixture.window.currentGeneration(fixture.A);
          captured.resolve(generation);
          await complete.promise;
          return owner.withTenantTransaction(fixture.A, async () => { entered = true; await marker('stale-completion'); });
        });
        const oldGeneration = await reached(captured, work, 'captured evaluator generation');
        const result = await restore('recommissioned');
        assert.notEqual(result.generation, oldGeneration);
        complete.resolve();
        await assert.rejects(work, retryable);
        assert.equal(entered, false);
        assert.equal(await stored('stale-completion'), 0);
        await fixture.window.run(fixture.A, () => owner.withTenantTransaction(fixture.A, () => marker('fresh-completion')));
        assert.equal(await stored('fresh-completion'), 1);
      } finally {
        complete.resolve(); await work?.catch(() => {});
        await owner.close();
      }
    });
  });
};
