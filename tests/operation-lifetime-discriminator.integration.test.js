'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- File paths are exclusively owned disposable synthetic fixture artifacts. */
// Owned native discriminator. These explicitly test-only marker lanes do not
// implement serving admission or replace the production operation window.
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { performance } = require('node:perf_hooks');
const createFixture = require('./fixtures/api-fixed-roster-serving');
const windows = require('../lib/tenant-lifecycle/operation-window');
const { optInSuite } = require('./support/opt-in');
const percentile = (samples, p) => samples.slice().sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)];
optInSuite(process.env.NS_OPERATION_LIFETIME_DOCKER_TEST === '1', 'NS_OPERATION_LIFETIME_DOCKER_TEST=1')(
  'operation lifetime marker serialization discriminator (not capacity acceptance)', function () {
    this.timeout(120000);
    const f = createFixture(), pools = [];
    before(() => f.setup());
    after(async () => { for (const pool of pools) await pool.end(); await f.cleanup(); });
    const pool = max => { const selected = new Pool({ connectionString: f.lifetimeConnectionString, max, application_name: 'owned-lifetime-discriminator' }); pools.push(selected); return selected; };
    it('measures bounded original operation registration and completion with no held response', async () => {
      const selected = pool(2), window = windows.create({ namespace: f.namespace, locks: f.locks, pool: selected });
      await window.ready();
      const samples = [], count = 128, start = performance.now();
      for (let i = 0; i < count; i++) { const started = performance.now(); await window.run(f.base.tenants[i % 2], async () => {}); samples.push(performance.now() - started); }
      const elapsed = performance.now() - start; await window.close();
      process.stdout.write('LIFETIME_ORIGINAL_MARKER ' + JSON.stringify({ operations: count, elapsedMs: elapsed, operationsPerSecond: count * 1000 / elapsed,
        p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99), scope: 'bounded functional microbenchmark; host not isolated' }) + '\n');
    });
    it('discriminates same-backend serial short transactions from response duration without changing marker RLS', async () => {
      const selected = pool(1), client = await selected.connect(), count = 128, tenant = f.base.tenants[0], key = f.locks[0].key;
      let tail = Promise.resolve();
      const serial = fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
      const tx = async fn => { await client.query('BEGIN'); try { await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
        const value = await fn(); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK'); throw error; } };
      const startSamples = [], finishSamples = [], operations = [], started = performance.now();
      try {
        assert.equal((await client.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS held', [key])).rows[0].held, true);
        await Promise.all(Array.from({ length: count }, () => serial(async () => {
          const start = performance.now(), operation = randomUUID();
          await tx(() => client.query('INSERT INTO preview_control.tenant_lifecycle_operations(tenant_id,operation_id,generation) VALUES($1,$2,1)', [tenant, operation]));
          startSamples.push(performance.now() - start); operations.push(operation);
        })));
        const pending = await tx(() => client.query('SELECT count(*)::int AS n,count(DISTINCT owner_pid)::int AS owners FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND finished=false', [tenant]));
        assert.equal(pending.rows[0].n, count); assert.equal(pending.rows[0].owners, 1);
        // All operation bodies may remain held outside this one backend's
        // transaction. Their pending rows still prevent maintenance data entry.
        await Promise.all(operations.map(operation => serial(async () => {
          const start = performance.now(); const result = await tx(() => client.query('UPDATE preview_control.tenant_lifecycle_operations SET finished=true WHERE tenant_id=$1 AND operation_id=$2 AND finished=false', [tenant, operation]));
          assert.equal(result.rowCount, 1); finishSamples.push(performance.now() - start);
        })));
        const elapsed = performance.now() - started;
        process.stdout.write('LIFETIME_SERIAL_MARKER ' + JSON.stringify({ operations: count, elapsedMs: elapsed, operationPairsPerSecond: count * 1000 / elapsed,
          registrationP50Ms: percentile(startSamples, 0.5), registrationP95Ms: percentile(startSamples, 0.95), registrationP99Ms: percentile(startSamples, 0.99),
          finishP50Ms: percentile(finishSamples, 0.5), finishP95Ms: percentile(finishSamples, 0.95), finishP99Ms: percentile(finishSamples, 0.99), physicalBackends: 1,
          scope: 'test-only short marker transactions; omits production admission and failure handling; not capacity acceptance' }) + '\n');
      } finally { await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [key]); client.release(); }
    });

    it('compares 1/2/4 prototype lanes through identical full production admission and held-body mix', async () => {
      const locks = [];
      for (let i = 1; i <= 16; i++) locks.push({ tenant: '33333333-3333-4333-8333-' + String(i).padStart(12, '0'), key: String(920000 + i) });
      await f.withAdmin(async client => {
        for (const lock of locks) await client.query("INSERT INTO preview_control.tenant_lifecycle_windows(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [lock.tenant, lock.key]);
      });
      for (const size of [1, 2, 4]) {
        const selected = pool(4), window = windows.create({ namespace: f.namespace, locks, pool: selected, leaseSessionCount: size });
        await window.ready();
        const samples = [], entrySamples = [], count = 128, concurrency = 16, start = performance.now();
        try {
          for (let offset = 0; offset < count; offset += concurrency) await Promise.all(Array.from({ length: concurrency }, async (_, n) => {
            const i = offset + n, began = performance.now();
            await window.run(locks[i % locks.length].tenant, async () => {
              entrySamples.push(performance.now() - began);
              if (i % 4 === 0) await new Promise(resolve => setTimeout(resolve, 20));
            });
            samples.push(performance.now() - began);
          }));
          const elapsed = performance.now() - start;
          assert(selected.totalCount <= size);
          process.stdout.write('LIFETIME_IDENTICAL_PATH_LANES ' + JSON.stringify({ lanes: size, operations: count, concurrency, heldBodyFraction: 0.25, heldBodyMs: 20,
            elapsedMs: elapsed, operationsPerSecond: count * 1000 / elapsed, physicalBackends: selected.totalCount,
            entryP50Ms: percentile(entrySamples, 0.5), entryP95Ms: percentile(entrySamples, 0.95),
            completionP50Ms: percentile(samples, 0.5), completionP95Ms: percentile(samples, 0.95),
            scope: 'same operation-window admission/markers; explicit shared session option; functional discriminator, host not isolated' }) + '\n');
        } finally { await window.close(); }
      }
    });

    it('expires queued registrations without later SQL or poisoning other operation lifetimes', async () => {
      const [A, B] = f.base.tenants, selected = pool(1); selected.options.connectionTimeoutMillis = 250;
      let release, observed;
      const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { observed = resolve; });
      let first = true;
      selected.on('connect', client => {
        const query = client.query.bind(client);
        client.query = async (...args) => {
          const text = typeof args[0] === 'string' ? args[0] : args[0].text, result = await query(...args);
          if (first && /^INSERT INTO .*tenant_lifecycle_operations/.test(text)) { first = false; observed(); await gate; }
          return result;
        };
      });
      const count = async () => f.withAdmin(async client => Number((await client.query('SELECT count(*) FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1', [B])).rows[0].count));
      const before = await count(), window = windows.create({ namespace: f.namespace, locks: f.locks, pool: selected, leaseSessionCount: 1 });
      const holding = window.run(A, async () => {}).then(value => ({ value }), error => ({ error })); await entered;
      try { await assert.rejects(window.run(B, async () => assert.fail('expired registration must not enter body')), { code: 'LIFECYCLE_WINDOW_QUEUE_TIMEOUT' }); }
      finally { release(); }
      assert.equal((await holding).error, undefined); await window.run(B, async () => {}); await window.close();
      assert.equal(await count(), before + 1, 'only the explicit healthy retry creates a marker');
    });
    const lossyPool = kind => {
      const selected = pool(1); let armed = true;
      selected.on('connect', client => {
        const query = client.query.bind(client); let current;
        client.query = async (...args) => {
          const text = typeof args[0] === 'string' ? args[0] : args[0].text;
          if (/^INSERT INTO .*tenant_lifecycle_operations/.test(text)) current = 'register';
          if (/^UPDATE .*tenant_lifecycle_operations SET finished/.test(text)) current = 'finish';
          const result = await query(...args);
          if (text === 'COMMIT' && current === kind && armed) { armed = false; throw Object.assign(new Error('OWNED_COMMIT_REPLY_LOST'), { code: 'OWNED_COMMIT_REPLY_LOST' }); }
          return result;
        };
      });
      return selected;
    };
    it('retains a real committed registration after lost reply and refuses replacement-owner completion', async () => {
      const tenant = f.base.tenants[0], selected = lossyPool('register');
      const window = windows.create({ namespace: f.namespace, locks: f.locks, pool: selected, leaseSessionCount: 1 });
      let entered = false;
      try { await assert.rejects(window.run(tenant, async () => { entered = true; })); assert.equal(entered, false); }
      finally { await window.close(); }
      const pending = await f.withAdmin(async client => (await client.query('SELECT operation_id,owner_pid,owner_birth::text FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND finished=false', [tenant])).rows);
      assert.equal(pending.length, 1);
      const replacement = pool(1), client = await replacement.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
        assert.equal((await client.query('UPDATE preview_control.tenant_lifecycle_operations SET finished=true WHERE tenant_id=$1 AND operation_id=$2', [tenant, pending[0].operation_id])).rowCount, 0, 'SAME_PID_BIRTH_RLS_REFUSES_REPLACEMENT_FINISH');
        await client.query('COMMIT');
      } finally { client.release(); }
      const controller = require('../lib/tenant-lifecycle/maintenance-window').create({ namespace: f.namespace, locks: f.locks, pool: f.operatorPool, cohort: f.cohort, drainTimeoutMs: 200 });
      try { await assert.rejects(controller.withRestore(tenant, { artifactDigest: 'd'.repeat(64) }, async () => assert.fail('orphan must exclude restore')), { code: 'LIFECYCLE_RESTORE_DRAIN_TIMEOUT' }); }
      finally { await controller.close(); }
    });
    it('reports a lost finish reply without reusing its owner session or rewriting its committed result', async () => {
      const tenant = f.base.tenants[1], selected = lossyPool('finish');
      const window = windows.create({ namespace: f.namespace, locks: f.locks, pool: selected, leaseSessionCount: 1 });
      let entered = false;
      try {
        await assert.rejects(window.run(tenant, async () => { entered = true; }), { code: 'LIFECYCLE_WINDOW_RELEASE_FAILED' }); assert(entered);
        await assert.rejects(window.run(tenant, async () => assert.fail('poisoned lane must not run')));
      } finally { await window.close(); }
      assert.equal((await f.withAdmin(async client => (await client.query('SELECT count(*)::int AS n FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND finished=false', [tenant])).rows[0])).n, 0);
      const replacement = windows.create({ namespace: f.namespace, locks: f.locks, pool: pool(1), leaseSessionCount: 1 });
      try { await replacement.run(tenant, async () => {}); } finally { await replacement.close(); }
    });

  });

for (const size of [1, 2, 4]) optInSuite(process.env.NS_OPERATION_LIFETIME_DOCKER_TEST === '1', 'NS_OPERATION_LIFETIME_DOCKER_TEST=1')(
  'actual API lifetime shared sessions with ' + size + ' bounded lease lanes', function () {
    this.timeout(120000);
    const fs = require('node:fs');
    const f = createFixture({ leaseSessions: size, environment: { NS_POOL_OPERATION_MAX: '4' } });
    const [A, B] = f.base.tenants; let a, b;
    const call = (id, tenant, method, route, token, body, headers) => f.base.http(f.current.get(id), tenant, method, route, token, body, headers);
    before(async () => { await f.setup(); a = await f.base.localToken(A); b = await f.base.localToken(B); });
    after(() => f.cleanup());
    it('preserves fresh current authorization and cross-tenant denial', async () => {
      await f.withAdmin(client => client.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=ARRAY['denied'] WHERE tenant_id=$1 AND name='viewer'", [A]));
      try {
        for (const id of ['api-1', 'api-2']) {
          assert.equal((await call(id, A, 'GET', '/api/v3/entries', a)).status, 403);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', a)).status, 401);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', b)).status, 200);
        }
      } finally { await f.withAdmin(client => client.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=ARRAY['api:entries:read','api:entries:create','api:entries:update'] WHERE tenant_id=$1 AND name='viewer'", [A])); }
    });
    it('serves beyond the lane bound while actual A responses fence restore and B continues', async () => {
      const count = size + 2, identifiers = Array.from({ length: count }, (_, i) => 'prototype-held-' + size + '-' + i);
      const replies = identifiers.map(identifier => call('api-1', A, 'POST', '/api/v3/entries', a,
        { identifier, app: 'synthetic-lifetime', type: 'sgv', date: Date.now(), utcOffset: 0, sgv: 125 }, { 'x-roster-hold': 'postcommit' }).then(value => ({ value }), error => ({ error })));
      try {
      await f.base.until(async () => f.withAdmin(async client => (await client.query("SELECT count(*)::int AS n FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=ANY($2::text[])", [A, identifiers])).rows[0].n === count), 'all actual writes commit beyond the lifetime lane bound');
      } catch (error) {
        f.current.get('api-1').child.kill('SIGUSR2');
        const results = await Promise.all(replies);
        process.stdout.write('LIFETIME_ACTUAL_DIAGNOSTIC ' + JSON.stringify({ results: results.map(row => ({ status: row.value?.status, body: row.value?.body, error: row.error?.code })), stderr: f.current.get('api-1').stderr }) + '\n');
        throw error;
      }
      assert(fs.existsSync(f.mark('held', 'api-1')));
      let entered = false;
      const restoring = f.restore(async () => { entered = true; return 'shared-lifetime-drain'; }).then(value => ({ value }), error => ({ error }));
      try {
        await f.base.until(async () => (await call('api-2', A, 'GET', '/api/v3/entries', a)).status !== 200, 'actual A suspension');
        assert.equal(entered, false, 'ALL_HELD_RESPONSES_STILL_FENCE_RESTORE');
        assert.equal((await call('api-1', B, 'GET', '/api/v3/entries', b)).status, 200, 'B uses the same worker while A responses remain held');
        assert.equal((await call('api-2', B, 'GET', '/api/v3/entries', b)).status, 200);
      } finally { f.current.get('api-1').child.kill('SIGUSR2'); }
      for (const reply of await Promise.all(replies)) { assert.equal(reply.error, undefined); assert.equal(reply.value.status, 201); }
      const result = await restoring; assert.equal(result.error, undefined, result.error?.code); assert.equal(result.value.state, 'activated'); assert(entered);
    });

    if (size === 4) it('control: early lifetime completion makes the held-response exclusion oracle fail', async () => {
      const identifier = 'prototype-early-release-control'; let responseFinished = false;
      const reply = call('api-1', A, 'POST', '/api/v3/entries', a,
        { identifier, app: 'synthetic-lifetime', type: 'sgv', date: Date.now(), utcOffset: 0, sgv: 125 },
        { 'x-roster-hold': 'postcommit', 'x-roster-release-lifetime': '1' }).then(value => { responseFinished = true; return value; });
      try {
        await f.base.until(async () => f.withAdmin(async client => (await client.query("SELECT count(*)::int AS n FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2", [A, identifier])).rows[0].n === 1), 'control actual data committed');
        let entered = false;
        assert.equal((await f.restore(async () => { entered = true; return 'deliberate-early-release'; })).state, 'activated');
        assert.equal(responseFinished, false);
        assert.throws(() => assert.equal(entered, false, 'ALL_HELD_RESPONSES_STILL_FENCE_RESTORE'), { code: 'ERR_ASSERTION' });
      } finally { f.current.get('api-1').child.kill('SIGUSR2'); }
      assert.equal((await reply).status, 201);
    });
    if (size === 4) it('refuses a clinical-write grant on its metadata-only lifetime identity', async () => {
      await f.withAdmin(client => client.query('GRANT UPDATE ON preview_clock.tenant_write_clock TO preview_lifetime_api'));
      try { await assert.rejects(f.restore(async () => assert.fail('unknown lifetime writer must not restore')), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' }); }
      finally { await f.withAdmin(client => client.query('REVOKE UPDATE ON preview_clock.tenant_write_clock FROM preview_lifetime_api')); }
    });
    if (size === 4) it('invalidates held wire responses on actual lease-backend death and keeps an orphan across worker replacement', async () => {
      const identifier = 'prototype-death-held';
      const reply = call('api-1', A, 'POST', '/api/v3/entries', a,
        { identifier, app: 'synthetic-lifetime', type: 'sgv', date: Date.now(), utcOffset: 0, sgv: 125 }, { 'x-roster-hold': 'postcommit' }).then(value => ({ value }), error => ({ error }));
      await f.base.until(async () => f.withAdmin(async client => (await client.query("SELECT count(*)::int AS n FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'=$2", [A, identifier])).rows[0].n === 1), 'postcommit wire held before backend death');
      const pending = await f.withAdmin(async client => (await client.query('SELECT DISTINCT owner_pid FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND finished=false', [A])).rows);
      assert.equal(pending.length, 1);
      let entered = false; const restoring = f.restore(async () => { entered = true; }).then(value => ({ value }), error => ({ error }));
      await f.base.until(async () => (await call('api-2', A, 'GET', '/api/v3/entries', a)).status !== 200, 'A restore suspended');
      await f.withAdmin(client => client.query('SELECT pg_terminate_backend($1)', [pending[0].owner_pid]));
      assert((await reply).error, 'lease death closes actual outstanding wire response');
      assert.equal((await call('api-2', B, 'GET', '/api/v3/entries', b)).status, 200);
      const old = f.current.get('api-1'); old.child.kill('SIGTERM'); await f.base.until(async () => old.exit !== null, 'old worker exited'); await f.start('api-1', { readinessTenant: B });
      assert.equal((await call('api-1', B, 'GET', '/api/v3/entries', b)).status, 200);
      const result = await restoring; assert.equal(result.error?.code, 'LIFECYCLE_RESTORE_DRAIN_TIMEOUT'); assert.equal(entered, false);
      assert((await f.withAdmin(async client => (await client.query('SELECT count(*)::int AS n FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND owner_pid=$2 AND finished=false', [A, pending[0].owner_pid])).rows[0])).n > 0);
    });
  });
