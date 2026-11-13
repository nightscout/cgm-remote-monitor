'use strict';

// covers: lib/server/serve/preview-api.js, lib/server/serve/postgres-domains.js, lib/storage/postgres-entries-intent.js, lib/storage/postgres-connection.js, lib/server/srv-dates.js
// Source-prepared against the approved opt-in tenant commit-clock interface.
// Actual product commit must be reconfirmed before enabling this suite. No
// mixed enabled/old writers, import writers, multi-row mutation cursor ties,
// Kubernetes, or notification proof.
// Predictions/semantic ablations for the later controlled runtime slot:
// - Unmodified clock: unique persisted cursors and complete exclusive history.
//   Remove allocator serialization: equal-clock/history assertions must fail.
// - W1 holds clock through blocked data UPDATE; W2 waits on that exact backend.
//   Release clock before data COMMIT: W2 actual early success must fail the test.
// - Killed/constraint-failed data TX rolls its clock back. Advance floor in a
//   separate TX: floor/next-stamp assertions must fail after actual data refusal.
// - Missing/stale/unsafe clock refuses before bind. Remove startup check: an
//   actual listener bind must fail the test, rather than a setup exception.
// These ablations are NOT executed by importing or syntax-checking this file.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { optInSuite } = require('./support/opt-in');
const createFixture = require('./fixtures/tenant-commit-clock-http');
const enabled = process.env.NS_TENANT_COMMIT_CLOCK_HTTP_DOCKER_TEST === '1';
const entry = (identifier, sgv = 145) => ({ identifier, type: 'sgv', date: 1793664000000,
  utcOffset: 0, app: 'synthetic-commit-clock', sgv });

optInSuite(enabled, 'NS_TENANT_COMMIT_CLOCK_HTTP_DOCKER_TEST=1')(
  'opt-in tenant commit clock through actual REST CLI processes', function () {
    this.timeout(120000);
    const f = createFixture(), [A, B] = f.tenants;
    const clockOptions = () => ({ NS_PREVIEW_REPLICA_CONTROL: 'history-clock',
      NS_PREVIEW_REPLICA_CLOCK_MS: String(Date.now() + 3600000) });
    const call = (...args) => f.http(...args);
    async function seed (worker, token, id, tenant = A) {
      const response = await call(worker, tenant, 'POST', '/api/v3/entries', token, entry(id));
      assert.equal(response.status, 201, 'new synthetic seed must commit');
      return (await f.rows(tenant, id))[0];
    }
    async function history (worker, token, cursor, tenant = A, limit) {
      const response = await call(worker, tenant, 'GET', '/api/v3/entries/history/' + cursor + (limit ? '?limit=' + limit : ''), token);
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(response.body.result));
      return response.body.result;
    }
    before(() => f.setup());
    after(() => f.cleanup());
    afterEach(async function () {
      // Attempt all cleanup even if one rollback or child shutdown fails.
      const errors = [];
      try { await f.releaseControls(); } catch (error) { errors.push(error); }
      for (const worker of [...f.workers]) {
        try { await f.stop(worker); } catch (error) {
          // Keep the primary ready() failure without a second shutdown error
          // only for a confirmed startup refusal that never bound a listener.
          if (this.currentTest.state === 'failed' && worker.exit?.code === 78 &&
              worker.exit.signal === null && worker.port === undefined && !/Listening/.test(worker.stdout)) {
            f.workers.delete(worker);
            console.log('TENANT_COMMIT_CLOCK_STARTUP_REFUSAL_CLEANUP ' + JSON.stringify(worker.exit));
          } else {
            console.log('TENANT_COMMIT_CLOCK_CLEANUP_FAILURE ' + JSON.stringify(f.workerDiagnostic(worker)));
            errors.push(error);
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Clock HTTP case cleanup failed');
    });

    it('orders equal-clock writes across API processes and returns the later exclusive-history record', async function () {
      const options = clockOptions(), [first, second] = await f.pair(options);
      const token = await f.localToken(A), foreign = await f.foreignRows(B);
      const one = await seed(first, token, 'commit-clock-equal-one');
      assert.ok((await history(first, token, one.srvModified - 1)).some(doc => doc.identifier === one.identifier));
      const two = await seed(second, token, 'commit-clock-equal-two');
      assert.ok(two.srvModified > one.srvModified, 'distinct processes must not reuse the first issued cursor');
      for (const worker of [first, second]) {
        assert.ok((await history(worker, token, one.srvModified)).some(doc => doc.identifier === two.identifier));
      }
      assert.equal(await f.floor(A), two.srvModified);
      await f.stop(second);
      const restarted = f.start(options); await f.ready(restarted);
      const three = await seed(restarted, token, 'commit-clock-equal-restart');
      assert.ok(three.srvModified > two.srvModified);
      assert.deepEqual(await f.foreignRows(B), foreign);
      console.log('TENANT_COMMIT_CLOCK_EQUAL ' + JSON.stringify({ first: one.srvModified,
        second: two.srvModified, restarted: three.srvModified, exclusiveHistoryIncludesLater: true }));
    });

    it('holds the tenant clock through a blocked actual data update while another tenant progresses', async function () {
      const [first, second] = await f.pair(clockOptions());
      const token = await f.localToken(A), b = await f.localToken(B);
      const original = await seed(first, token, 'commit-clock-blocked-update');
      const blocker = await f.lockEntry(A, original.identifier);
      let w1, w2, dataWait, clockWait;
      try {
        w1 = f.tracked(call(first, A, 'PATCH', '/api/v3/entries/' + original.identifier, token, { sgv: 146 }));
        dataWait = await f.waitForBlocked(w1, blocker.pid, 'data-update');
        await f.assertClockHeld(A);
        w2 = f.tracked(call(second, A, 'POST', '/api/v3/entries', token, entry('commit-clock-blocked-second', 147)));
        clockWait = await f.waitForBlocked(w2, dataWait.pid, 'clock-select', dataWait.deadline);
        const progress = f.tracked(call(second, B, 'POST', '/api/v3/entries', b, entry('commit-clock-independent-b', 175)));
        await f.completed(progress, 201, 'different tenant', dataWait.deadline);
        const current = await history(second, token, original.srvModified);
        assert.equal(current.some(doc => doc.identifier === original.identifier), false, 'uncommitted update is not visible');
        assert.equal(current.some(doc => doc.identifier === 'commit-clock-blocked-second'), false, 'clock-blocked insertion is not visible');
        assert.ok(Date.now() < dataWait.deadline, 'barrier proof must finish before the shared transaction budget');
        assert.equal(w1.settled, false); assert.equal(w2.settled, false);
      } finally { await blocker.release(); }
      assert.ok(w1 && w2 && dataWait && clockWait, 'actual data and clock waits must both be established');
      assert.equal((await w1.promise).response?.status, 200, 'first update commits after release');
      assert.equal((await w2.promise).response?.status, 201, 'same-tenant insertion follows first commit');
      const updated = (await f.rows(A, original.identifier))[0], later = (await f.rows(A, 'commit-clock-blocked-second'))[0];
      assert.equal(updated.sgv, 146);
      assert.ok(updated.srvModified > original.srvModified);
      assert.ok(later.srvModified > updated.srvModified);
      for (const worker of [first, second]) assert.ok((await history(worker, token, updated.srvModified))
        .some(doc => doc.identifier === later.identifier));
      assert.equal(await f.floor(A), later.srvModified);
      assert.equal((await f.rows(B, 'commit-clock-independent-b'))[0].sgv, 175);
      console.log('TENANT_COMMIT_CLOCK_BLOCKED ' + JSON.stringify({
        dataWait: dataWait.kind, clockWait: clockWait.kind, before: original.srvModified,
        firstCommit: updated.srvModified, secondCommit: later.srvModified, differentTenantProgressed: true }));
    });

    it('characterizes Node SIGKILL rollback with explicit release of the original data blocker', async function () {
      const [first, second] = await f.pair(clockOptions());
      const token = await f.localToken(A), original = await seed(first, token, 'commit-clock-nodekill-update');
      const floorBefore = await f.floor(A), foreign = await f.foreignRows(B);
      const settings = await f.connectionSettings();
      const blocker = await f.lockEntry(A, original.identifier);
      let w1, w2, dataWait;
      try {
        w1 = f.tracked(call(first, A, 'PATCH', '/api/v3/entries/' + original.identifier, token, { sgv: 199 }));
        dataWait = await f.waitForBlocked(w1, blocker.pid, 'data-update');
        await f.assertClockHeld(A);
        w2 = f.tracked(call(second, A, 'POST', '/api/v3/entries', token, entry('commit-clock-after-nodekill', 148)));
        await f.waitForBlocked(w2, dataWait.pid, 'clock-select', dataWait.deadline);
        assert.ok(Date.now() < dataWait.deadline, 'Node kill occurs within the shared pre-timeout budget');
        await f.kill(first);
        assert.ok((await w1.promise).error, 'killed Node writer produces transport failure, not success');
        // A closed Node socket need not be detected while PostgreSQL waits on a
        // row lock. Observe default behavior; do not assert prompt backend exit.
        const backend = await f.backendState(dataWait.pid);
        const immediatelyAfterKill = { backendPresent: backend !== null,
          waitEventType: backend?.wait_event_type || null, waitEvent: backend?.wait_event || null,
          backendState: backend?.state || null, secondWriterCompleted: w2.settled,
          secondWriterStatus: w2.response?.status || null };
        // Declared recovery intervention: release the ORIGINAL independent row
        // lock. No pg_terminate_backend or DB-setting change occurs in this case.
        await blocker.release();
        await f.completed(w2, 201, 'clock waiter after declared data-lock release', dataWait.deadline);
        assert.deepEqual((await f.rows(A, original.identifier))[0], original,
          'Node-killed writer must not commit partial data after the lock is released');
        const survivor = (await f.rows(A, 'commit-clock-after-nodekill'))[0];
        assert.equal(survivor.srvModified, floorBefore + 1, 'aborted clock allocation rolls back with data');
        assert.equal(await f.floor(A), survivor.srvModified);
        assert.deepEqual(await f.foreignRows(B), foreign);
        assert.ok((await history(second, token, floorBefore)).some(doc => doc.identifier === survivor.identifier));
        console.log('TENANT_COMMIT_CLOCK_NODE_KILL ' + JSON.stringify({
          operatorConnectionSettings: settings, apiStatementTimeoutMsFromSource: 5000,
          immediatelyAfterKill, originalDataBlockerExplicitlyReleased: true,
          before: floorBefore, survivor: survivor.srvModified, killedRowUnchanged: true }));
      } finally { await blocker.release(); }
    });

    it('survives an operator-terminated PostgreSQL writer with rollback and healthy follow-up', async function () {
      const monitor = process.env.NS_TENANT_CLOCK_ABORT_MONITOR;
      if (monitor) assert.ok(require('node:path').isAbsolute(monitor) && !/\s/.test(monitor),
        'diagnostic monitor must be an explicit absolute path without whitespace');
      const [first, second] = await f.pair(clockOptions(), monitor ? { NODE_OPTIONS: '--require ' + monitor } : {});
      const token = await f.localToken(A), original = await seed(first, token, 'commit-clock-backend-update');
      const floorBefore = await f.floor(A), foreign = await f.foreignRows(B);
      const blocker = await f.lockEntry(A, original.identifier);
      let w1, w2, dataWait;
      try {
        w1 = f.tracked(call(first, A, 'PATCH', '/api/v3/entries/' + original.identifier, token, { sgv: 199 }));
        dataWait = await f.waitForBlocked(w1, blocker.pid, 'data-update');
        await f.assertClockHeld(A);
        w2 = f.tracked(call(second, A, 'POST', '/api/v3/entries', token, entry('commit-clock-after-backend-abort', 149)));
        await f.waitForBlocked(w2, dataWait.pid, 'clock-select', dataWait.deadline);
        assert.ok(Date.now() < dataWait.deadline, 'operator abort occurs within the shared pre-timeout budget');
        assert.equal(await f.terminateBackend(dataWait.pid, first), true, 'operator terminates the exact observed W1 database backend');
        // W2 must commit while the original data-row locker is STILL held.
        await f.completed(w2, 201, 'clock waiter after operator backend termination', dataWait.deadline);
        const failed = await w1.promise;
        assert.equal(failed.error, null, 'database abort must propagate as HTTP failure, not process loss');
        if (failed.response.status === 503) {
          assert.deepEqual(failed.response.body, { error: 'STORAGE_UNAVAILABLE' },
            'typed unavailable cause retains the existing sanitized response');
        } else {
          assert.equal(failed.response.status, 500, 'only existing sanitized storage failure contracts are accepted');
          assert.deepEqual(failed.response.body, { status: 500, message: 'Database error' });
        }
        const publicFailure = JSON.stringify(failed.response.body);
        assert.ok(!publicFailure.includes(token), 'public failure must not disclose the data credential');
        assert.doesNotMatch(publicFailure, /postgres(?:ql)?:\/\/|node_modules|Connection terminated|uncaughtException/,
          'public failure must not expose connection internals or stack');
        assert.deepEqual((await f.rows(A, original.identifier))[0], original);
        const survivor = (await f.rows(A, 'commit-clock-after-backend-abort'))[0];
        assert.equal(survivor.srvModified, floorBefore + 1, 'operator-aborted allocation rolls back in the same transaction');
        assert.equal(await f.floor(A), survivor.srvModified);
        assert.deepEqual(await f.foreignRows(B), foreign);
        assert.ok((await history(second, token, floorBefore)).some(doc => doc.identifier === survivor.identifier));
        console.log('TENANT_COMMIT_CLOCK_OPERATOR_BACKEND_ABORT ' + JSON.stringify({
          termination: 'operator pg_terminate_backend of observed W1',
          firstWriterOutcome: 'HTTP-' + failed.response.status,
          originalDataLockStillHeld: true, before: floorBefore, survivor: survivor.srvModified,
          killedRowUnchanged: true }));
      } finally { await blocker.release(); }
      assert.equal(first.exit, null, 'API worker must survive its checked-out connection failure');
      const read = await call(first, A, 'GET', '/api/v3/entries/' + original.identifier, token);
      assert.equal(read.status, 200, 'same API process must acquire a healthy connection for a read');
      assert.equal(read.body.result.sgv, original.sgv);
      const afterAbort = (await f.rows(A, 'commit-clock-after-backend-abort'))[0];
      const followup = await seed(first, token, 'commit-clock-recovered-worker', A);
      assert.ok(followup.srvModified > afterAbort.srvModified, 'same process must commit beyond the survivor cursor');
      assert.ok((await history(second, token, afterAbort.srvModified))
        .some(doc => doc.identifier === followup.identifier), 'other API sees the recovered worker write after that cursor');
      assert.equal(await f.floor(A), followup.srvModified);
      assert.deepEqual(await f.foreignRows(B), foreign);
      assert.equal(first.exit, null, 'same API worker remains alive after the follow-up write');
      const diagnostic = f.workerDiagnostic(first);
      assert.equal(diagnostic.fatalMonitor, null, 'no uncaught exception observed by optional passive monitor');
      assert.equal(diagnostic.stderrSignals.unhandledError, false, 'no unhandled emitter error');
      console.log('TENANT_COMMIT_CLOCK_BACKEND_RECOVERY ' + JSON.stringify({
        sameProcessRead: 200, sameProcessWrite: 201, followupStamp: followup.srvModified,
        diagnostic, normalStrictShutdownRequired: true
      }));
      // Both workers remain tracked for the normal strict exit0/socket checks.
    });

    it('rolls back the clock when an actual PostgreSQL data constraint rejects insertion', async function () {
      const [first] = await f.pair(clockOptions());
      const token = await f.localToken(A);
      await seed(first, token, 'commit-clock-before-constraint');
      const before = await f.floor(A), foreign = await f.foreignRows(B);
      await f.admin.query("ALTER TABLE preview_data.entries ADD CONSTRAINT clock_http_reject CHECK (doc->>'identifier'<>'commit-clock-constraint-fail')");
      try {
        const rejected = await call(first, A, 'POST', '/api/v3/entries', token, entry('commit-clock-constraint-fail'));
        assert.ok(rejected.status >= 400 && rejected.status < 600, 'actual constraint failure must refuse HTTP success');
        assert.equal((await f.rows(A, 'commit-clock-constraint-fail')).length, 0);
        assert.equal(await f.floor(A), before, 'failed data insert must not commit a clock allocation');
        console.log('TENANT_COMMIT_CLOCK_CONSTRAINT ' + JSON.stringify({ status: rejected.status, floorUnchanged: true }));
      } finally { await f.admin.query('ALTER TABLE preview_data.entries DROP CONSTRAINT clock_http_reject'); }
      const next = await seed(first, token, 'commit-clock-after-constraint');
      assert.equal(next.srvModified, before + 1);
      assert.deepEqual(await f.foreignRows(B), foreign);
    });

    it('pages individual committed API3 writes without skipping same-clock records', async function () {
      const [first, second] = await f.pair(clockOptions()), token = await f.localToken(A);
      const cursor = await f.floor(A), expected = [];
      for (let i = 0; i < 6; i++) {
        const stored = await seed(i % 2 ? second : first, token, 'commit-clock-page-' + i);
        expected.push(stored);
      }
      assert.equal(new Set(expected.map(doc => doc.srvModified)).size, expected.length);
      let next = cursor;
      const seen = [];
      for (let i = 0; i <= expected.length; i++) {
        const page = await history(i % 2 ? second : first, token, next, A, 1);
        if (!page.length) break;
        assert.equal(page.length, 1);
        assert.ok(page[0].srvModified > next);
        next = page[0].srvModified;
        seen.push(page[0].identifier);
      }
      assert.deepEqual(seen, expected.map(doc => doc.identifier));
    });

    it('refuses missing, stale or unsafe operator-provisioned clock state before binding', async function () {
      const [first] = await f.pair(clockOptions()), token = await f.localToken(A);
      await seed(first, token, 'commit-clock-startup-baseline');
      for (const worker of [...f.workers]) await f.stop(worker);
      const before = await f.floor(A);
      await f.admin.query('DELETE FROM preview_clock.tenant_write_clock WHERE tenant_id=$1', [A]);
      try { await f.refused(f.configuration()); }
      finally { await f.admin.query('INSERT INTO preview_clock.tenant_write_clock VALUES ($1,$2)', [A, before]); }
      await f.admin.query('UPDATE preview_clock.tenant_write_clock SET last_stamp=0 WHERE tenant_id=$1', [A]);
      try { await f.refused(f.configuration()); }
      finally { await f.admin.query('UPDATE preview_clock.tenant_write_clock SET last_stamp=$1 WHERE tenant_id=$2', [before, A]); }
      await f.admin.query('GRANT INSERT ON preview_clock.tenant_write_clock TO preview_app');
      try { await f.refused(f.configuration()); }
      finally { await f.admin.query('REVOKE INSERT ON preview_clock.tenant_write_clock FROM preview_app'); }
      await f.admin.query('ALTER TABLE preview_clock.tenant_write_clock NO FORCE ROW LEVEL SECURITY');
      try { await f.refused(f.configuration()); }
      finally { await f.admin.query('ALTER TABLE preview_clock.tenant_write_clock FORCE ROW LEVEL SECURITY'); }
      assert.equal(await f.floor(A), before, 'startup admission checks must not change the stored clock');
      const [restored] = await f.pair(clockOptions());
      assert.equal((await call(restored, A, 'GET', '/api/v3/entries', token)).status, 200);
    });

    optInSuite(process.env.NS_TENANT_COMMIT_CLOCK_BENCHMARK === '1', 'NS_TENANT_COMMIT_CLOCK_BENCHMARK=1')(
      'explicit tenant clock HTTP workload (no performance threshold)', function () {
        it('reports end-to-end successful request latency and throughput', async function () {
          const sampleCount = Number(process.env.NS_TENANT_COMMIT_CLOCK_SAMPLES || 40);
          const concurrency = Number(process.env.NS_TENANT_COMMIT_CLOCK_CONCURRENCY || 4);
          assert.ok(Number.isSafeInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 1000);
          assert.ok(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 16);
          const warmupRequests = 8;
          // OFF is an optional descriptive baseline, never a correctness claim
          // for multiple uncoordinated writers. Each mode has independent data.
          const clockModes = process.env.NS_TENANT_COMMIT_CLOCK_OFF_BASELINE === '1' ? [false, true] : [true];
          const cohorts = clockModes.flatMap(clockEnabled =>
            ['single-hot-tenant', 'balanced-two-tenants'].map(cohort => ({ clockEnabled, cohort })));
          for (const { clockEnabled, cohort } of cohorts) {
            // Fresh services/data for EACH cohort: no +1h allocator fixtures,
            // and no hot-first/balanced-second shared cache/data history.
            const bench = createFixture({ clockEnabled });
            try {
              await bench.setup();
              const config = bench.configuration();
              assert.equal(Object.hasOwn(config, 'writeClock'), clockEnabled);
              assert.equal(Object.hasOwn(config.postgres.namespaces, 'clock'), clockEnabled);
              const initialClockFloors = await Promise.all(bench.tenants.map(tenant => bench.floor(tenant)));
              const workers = await bench.pair();
              const credentials = await Promise.all(bench.tenants.map(tenant => bench.localToken(tenant)));
              const postgresVersion = (await bench.admin.query('SHOW server_version')).rows[0].server_version;
              const benchCall = (...args) => bench.http(...args);
              // Explicit small warmup exercises every process/tenant pairing
              // twice. It does not establish steady state or cache equivalence.
              for (let i = 0; i < warmupRequests; i++) {
                const tenantIndex = i % bench.tenants.length;
                const workerIndex = Math.floor(i / bench.tenants.length) % workers.length;
                const response = await benchCall(workers[workerIndex], bench.tenants[tenantIndex], 'POST',
                  '/api/v3/entries', credentials[tenantIndex], entry('commit-clock-warmup-' + i));
                assert.equal(response.status, 201, 'explicit warmup must perform successful actual writes');
              }
              const floorToWallClock = [];
              for (const [index, tenant] of bench.tenants.entries()) {
                const floor = await bench.floor(tenant);
                const entriesWatermark = await bench.storedEntriesWatermark(tenant), wallClockMs = Date.now();
                floorToWallClock.push({ tenant: index, floor, entriesWatermark, wallClockMs,
                  leadMs: entriesWatermark - wallClockMs });
              }
              const payloads = Array.from({ length: sampleCount }, (_, i) => entry('commit-clock-bench-' + cohort + '-' + i));
              const payloadSizes = payloads.map(payload => Buffer.byteLength(JSON.stringify(payload)));
              const perTenantSamples = [0, 0];
              const samples = [], started = performance.now();
              let issued = 0;
              async function work () {
                while (issued < sampleCount) {
                  const i = issued++, tenantIndex = cohort === 'single-hot-tenant' ? 0 : i % bench.tenants.length;
                  // Decouple tenant and process selection: consecutive writes
                  // for the same tenant reach both independent clock users.
                  const workerIndex = Math.floor(i / bench.tenants.length) % workers.length;
                  perTenantSamples[tenantIndex]++;
                  const begin = performance.now();
                  try {
                    const response = await benchCall(workers[workerIndex], bench.tenants[tenantIndex], 'POST',
                      '/api/v3/entries', credentials[tenantIndex], payloads[i]);
                    samples.push({ ok: response.status === 201, ms: performance.now() - begin, retries: 0, status: response.status });
                  } catch { samples.push({ ok: false, ms: performance.now() - begin, retries: 0, transportError: true }); }
                }
              }
              await Promise.all(Array.from({ length: concurrency }, work));
              const result = createFixture.metrics(samples, performance.now() - started, {
                cohort, clockEnabled, sampleCount, concurrency, configuredTenants: bench.tenants.length, processes: workers.length,
                configuration: { role: 'api', writeClock: config.writeClock ?? 'omitted',
                  namespaces: config.postgres.namespaces, domains: config.domains,
                  legacy: config.legacy, context: config.context, resolution: config.resolution.mode,
                  accessTokenIssuer: config.accessTokens.issuer, accessTokenAudience: config.accessTokens.audience,
                  unusedClockSchemaProvisioned: !clockEnabled },
                nodeVersion: process.version, postgresVersion, freshFixturePerCohort: true,
                initialClockFloors, floorToWallClock, warmupRequests,
                warmupPurpose: 'exercise each process/tenant pairing; not a steady-state proof', retryPolicy: 'none', credentialKind: 'tenant data token with current persisted authority',
                distribution: 'tenant choice independent of alternating API process pairs', operation: 'API3 individual entries POST',
                payloadBytes: { minimum: Math.min(...payloadSizes), maximum: Math.max(...payloadSizes) },
                perTenantSamples: perTenantSamples.map((count, index) => ({ tenant: index, count }))
              });
              console.log('TENANT_COMMIT_CLOCK_BENCHMARK ' + JSON.stringify(result));
              assert.equal(result.successful + result.errors, sampleCount, 'report every issued request; no hidden retries');
              assert.ok(result.successful > 0, 'healthy workload must execute successful actual HTTP writes');
              assert.equal(result.errors, 0, 'healthy bounded workload must report no failed requests');
            } finally { await bench.cleanup(); }
          }
        });
      });
  });
