'use strict';

// covers: lib/tenant-lifecycle/operation-window.js, lib/tenant-lifecycle/operation-window-readiness.js, lib/storage/postgres-connection.js
// Native PostgreSQL is opt-in. Counter controls below require no database.
const assert = require('node:assert/strict');
const { Client } = require('pg');
const windows = require('../lib/tenant-lifecycle/operation-window');
const { optInSuite } = require('./support/opt-in');
const fixture = require('./fixtures/operation-window-minimum-native');
const counters = require('./fixtures/operation-window-sql-counter');

describe('minimum-window SQL counter controls (no database)', function () {
  it('fails on an injected global digest and restores with an independent clean counter', async function () {
    const broken = counters.create();
    await broken.phase('public', async () => broken.record('SELECT string_agg(x.xmin::text,\',\') FROM pg_class x'));
    assert.throws(() => broken.assertHot('public', 1), /steady public operations/);
    const restored = counters.create();
    await restored.phase('public', async () => restored.record('SELECT 1'));
    assert.deepEqual(restored.assertHot('public', 1), { operations: 1, statements: 1, statementsPerOperation: 1 });
  });
  it('keeps cold admission separate and detects a repeated full admission', async function () {
    const counter = counters.create();
    await counter.phase('admission', async () => counter.record('SELECT /* operation-window-table */ 1'));
    await counter.phase('public', async () => counter.record('SELECT 1'));
    counter.assertHot('public', 1);
    await counter.phase('public', async () => counter.record('SELECT /* operation-window-ledger */ name FROM synthetic.schema_migrations'));
    assert.throws(() => counter.assertHot('public', 1), /steady public operations/);
    assert.throws(() => counter.assertHot('empty', 1), /observed real SQL/);
  });
});

optInSuite(process.env.NS_OPERATION_WINDOW_MINIMUM_DOCKER_TEST === '1',
  'NS_OPERATION_WINDOW_MINIMUM_DOCKER_TEST=1')('minimum operation window native contracts (fresh synthetic deployment grants)', function () {
  this.timeout(180000);
  const f = fixture.create();
  before(() => f.start());
  after(() => f.close());
  require('./fixtures/restore-transaction-fence-native')(f);
  const refuseBody = async fn => {
    let entered = false;
    await assert.rejects(fn(async () => { entered = true; }));
    assert.equal(entered, false, 'refusal must precede public body');
  };
  const active = () => f.operation(f.A);
  const resetWindow = () => f.sql('UPDATE ' + f.control('tenant_lifecycle_windows') + " SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id=$1", [f.A]);

  it('baseline capability matrix: every serving identity is restricted', async function () {
    const tableOID = (await f.sql('SELECT $1::regclass::oid AS oid', [f.control('tenant_lifecycle_windows')])).rows[0].oid;
    for (const kind of ['api', 'lifetime_api', 'operator', 'suppression']) {
      const client = new Client({ connectionString: f.urls[kind] }); await client.connect();
      try {
        const role = (await client.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0];
        assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
        assert.equal(role.rolcreatedb, false); assert.equal(role.rolcreaterole, false);
        assert.equal(role.rolreplication, false);
        await assert.rejects(client.query('ALTER TABLE ' + f.control('tenant_lifecycle_windows') + ' NO FORCE ROW LEVEL SECURITY'), { code: '42501' });
        assert.equal((await client.query('SELECT has_table_privilege(current_user,$1::oid,$2) AS allowed', [tableOID, 'UPDATE WITH GRANT OPTION'])).rows[0].allowed, false);
        await assert.rejects(client.query('SET ROLE ' + f.q(f.l.owner)), { code: '42501' });
      } finally { await client.end(); }
    }
  });

  (process.env.NS_OPERATION_WINDOW_BASELINE_COUNTER === '1' ? it : it.skip)('baseline counter bridge observes legacy epoch cost without asserting a minimum-path pass', async function () {
    await active();
    await f.counter.phase('baseline-public', async () => { for (let i = 0; i < 4; i++) await f.operation(i % 2 ? f.A : f.B); });
    const rows = f.counter.rows().filter(r => r.phase === 'baseline-public');
    assert.ok(rows.some(r => r.globalDigest), '7291 baseline must expose legacy global digest');
    assert.throws(() => f.counter.assertHot('baseline-public', 4), /steady public operations/);
    if (process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY) require('node:fs').writeFileSync(
      process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY + '/counter-baseline.json',
      JSON.stringify({ publicOperations: 4, rows, scope: 'owned clients only; migration clients excluded; no shared-stat reset' }), { flag: 'wx', mode: 0o600 });
  });

  it('uses live tenant RLS and preserves two-tenant isolation', async function () {
    for (const tenant of [f.A, f.B]) {
      await f.operation(tenant, async () => {
        const result = await f.lower.query('SELECT tenant_id FROM ' + f.control('tenant_lifecycle_windows'));
        assert.deepEqual(result.rows.map(r => r.tenant_id), [tenant]);
      });
    }
  });

  it('permits owned TEMP DDL but denies protected control DDL and owner adoption', async function () {
    const client = new Client({ connectionString: f.urls.api }); await client.connect();
    try {
      await client.query('CREATE TEMP TABLE minimum_owned (n integer)');
      await client.query('ALTER TABLE minimum_owned ADD COLUMN label text');
      await assert.rejects(client.query('ALTER TABLE ' + f.control('tenant_lifecycle_windows') + ' NO FORCE ROW LEVEL SECURITY'), { code: '42501' });
      await assert.rejects(client.query('SET ROLE ' + f.q(f.l.owner)), { code: '42501' });
    } finally { await client.end(); }
    await active();
  });

  it('refuses actually revoked SELECT after warm admission, then succeeds after regrant', async function () {
    await active();
    await f.sql('REVOKE SELECT ON ' + f.control('tenant_lifecycle_windows') + ' FROM ' + f.q(f.l.roles.api));
    try { await refuseBody(fn => f.lower.withTenant(f.A, fn)); }
    finally { await f.sql('GRANT SELECT ON ' + f.control('tenant_lifecycle_windows') + ' TO ' + f.q(f.l.roles.api)); }
    await active();
  });

  it('refuses elevated principal flags at admin pre-start and restores safely', async function () {
    await active();
    await f.sql('ALTER ROLE ' + f.q(f.l.roles.api) + ' CREATEDB');
    try { await assert.rejects(f.prestart(), error => ['LIFECYCLE_WINDOW_SCHEMA_UNSAFE', 'LIFECYCLE_WINDOW_ROLE_UNSAFE'].includes(error.code)); }
    finally { await f.sql('ALTER ROLE ' + f.q(f.l.roles.api) + ' NOCREATEDB'); }
    await active();
  });

  it('refuses a closed tenant after admission while the other tenant continues', async function () {
    await active();
    await f.sql('UPDATE ' + f.control('tenant_lifecycle_windows') + " SET phase='suspended',generation=generation+1,claim_id=$2,artifact_digest=$3 WHERE tenant_id=$1", [f.A, require('node:crypto').randomUUID(), 'a'.repeat(64)]);
    try {
      // Both serving admission and actual lower SQL observe the suspended generation.
      await refuseBody(fn => f.window.run(f.A, fn));
      await refuseBody(fn => f.lower.withTenant(f.A, fn));
      await f.operation(f.B);
    } finally { await resetWindow(); }
    await active();
  });

  it('refuses physical tenant SQL under an exclusive restore lock while B continues', async function () {
    await f.admin(async holder => {
      assert.equal((await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [f.locks[0].key])).rows[0].held, true);
      await refuseBody(fn => f.operation(f.A, fn));
      await f.operation(f.B);
    });
    await active();
  });

  // The transaction's own shared lock, not only the scope's earlier observation:
  // the replacement lock is taken after admission and the phase is still active.
  it('refuses a transaction opened inside an admitted scope while the replacement lock is held', async function () {
    let entered = false;
    await assert.rejects(f.window.run(f.A, () => f.admin(async holder => {
      assert.equal((await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [f.locks[0].key])).rows[0].held, true);
      try { await f.lower.withTenant(f.A, async () => { entered = true; }); }
      finally { await holder.query('SELECT pg_advisory_unlock($1::bigint)', [f.locks[0].key]); }
    })), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
    assert.equal(entered, false, 'refusal must precede public body');
    await active();
  });

  // The scope sends lock and generation read as separate statements of one
  // simple-protocol query. Each statement must take its own READ COMMITTED snapshot, so a
  // replacement committed while the lock waited is seen. The single-statement form is the
  // red control: its snapshot predates the lock.
  it('gives each statement of one simple query its own READ COMMITTED snapshot', async function () {
    const table = 'public.fence_snapshot_probe', key = '830099';
    await f.sql('CREATE TABLE ' + table + '(generation int)');
    try {
      const probe = text => f.admin(async writer => {
        await f.sql('TRUNCATE ' + table + '; INSERT INTO ' + table + ' VALUES (1)');
        await writer.query('BEGIN');
        await writer.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
        await writer.query('UPDATE ' + table + ' SET generation=2');
        const reading = f.admin(reader => reader.query(text));
        const end = Date.now() + 10000;
        while (!(await f.sql("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n) {
          if (Date.now() > end) throw new Error('READER_NEVER_WAITED');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await writer.query('COMMIT');
        const results = await reading;
        return results[results.length - 2].rows[0].generation;
      });
      const lock = 'SELECT pg_advisory_xact_lock_shared(' + key + '::bigint)';
      assert.equal(await probe('BEGIN ISOLATION LEVEL READ COMMITTED;' + lock + ';SELECT generation FROM ' + table + ';COMMIT'), 2);
      assert.equal(await probe('BEGIN ISOLATION LEVEL READ COMMITTED;' + lock.replace(')', ') AS held') +
        ',(SELECT generation FROM ' + table + ') AS generation;COMMIT'), 1, 'single statement keeps its pre-lock snapshot');
    } finally { await f.sql('DROP TABLE ' + table); }
  });

  it('takes a fresh generation observation without creating durable response markers', async function () {
    await active();
    const pending = async () => (await f.sql('SELECT operation_id FROM ' + f.control('tenant_lifecycle_operations') + ' WHERE tenant_id=$1 AND NOT finished', [f.A])).rows;
    const before = await pending();
    await f.counter.phase('warm-bodies-only', async () => {
      for (let i = 0; i < 4; i++) await f.window.run(f.A, () => f.window.assertCurrent(f.A));
    });
    assert.deepEqual(await pending(), before);
    f.counter.assertHot('warm-bodies-only', 4);
  });

  it('admin pre-start rejects unsafe structure until restored', async function () {
    await active();
    await f.sql('ALTER TABLE ' + f.control('tenant_lifecycle_windows') + ' NO FORCE ROW LEVEL SECURITY');
    try {
      await assert.rejects(f.prestart());
    } finally { await f.sql('ALTER TABLE ' + f.control('tenant_lifecycle_windows') + ' FORCE ROW LEVEL SECURITY'); }
    await f.prestart();
    const fresh = await f.openLower();
    try { await fresh.withTenant(f.A, () => fresh.query('SELECT 1')); }
    finally { await fresh.end(); }
  });

  it('refuses the application callback after an unconfirmed observation COMMIT', async function () {
    const pool = f.freshPool('lifetime_api');
    pool.on('connect', client => {
      const query = client.query.bind(client);
      client.query = async (...args) => {
        const result = await query(...args);
        // The observation is one simple-protocol query that ends with its COMMIT.
        if (args[0] === 'COMMIT' || typeof args[0] === 'string' && args[0].endsWith(';COMMIT')) throw Object.assign(new Error('synthetic COMMIT reply loss'), { code: 'OWNED_COMMIT_REPLY_LOST' });
        return result;
      };
    });
    const window = windows.create({ namespace: f.ns.control, locks: f.locks, pool });
    try {
      await refuseBody(fn => window.run(f.A, fn));
      await refuseBody(fn => window.run(f.A, fn));
    } finally { await window.close(); await pool.end(); }
  });

  it('counts the same warm SELECT through explicit read-only and unchanged writable public entries', async function () {
    const scope = require('../lib/storage/tenant-scope');
    const read = tenant => f.window.run(tenant, () => scope.withTenant(tenant,
      () => f.lower.readOnlyTransaction(() => f.lower.query('SELECT 1 AS x'))));
    const n = 4;
    async function measure (phase, operation) {
      await operation(f.A); await operation(f.B);
      await f.counter.phase(phase, async () => {
        for (let i = 0; i < n; i++) await operation(i % 2 ? f.A : f.B);
      });
      return f.counter.assertHot(phase, n);
    }
    const writable = await measure('same-writable-select', f.operation);
    const readonly = await measure('same-read-only-select', read);
    const directory = process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY;
    if (directory) require('node:fs').writeFileSync(directory + '/counter-read-only.json',
      JSON.stringify({ readonly, writable, phases: f.counter.rows().filter(row =>
        ['same-writable-select', 'same-read-only-select'].includes(row.phase)) }), { flag: 'wx', mode: 0o600 });
    assert.ok(readonly.statementsPerOperation <= 7, 'EXPLICIT_PUBLIC_READ_SQL_BUDGET');
  });

  it('does no full admission/global digest per warm public operation or unrelated catalogue growth', async function () {
    await active(); await f.operation(f.B);
    const n = 4;
    await f.counter.phase('public-before-growth', async () => { for (let i = 0; i < n; i++) await f.operation(i % 2 ? f.A : f.B); });
    const before = f.counter.assertHot('public-before-growth', n);
    await f.sql('CREATE SCHEMA minimum_unrelated; CREATE TABLE minimum_unrelated.unrelated (n integer)');
    await f.counter.phase('public-after-growth', async () => { for (let i = 0; i < n; i++) await f.operation(i % 2 ? f.A : f.B); });
    const after = f.counter.assertHot('public-after-growth', n);
    assert.equal(after.statements, before.statements, 'same public-operation denominator after unrelated DDL');
    if (process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY) require('node:fs').writeFileSync(
      process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY + '/counter-minimum.json',
      JSON.stringify({ before, after, rows: f.counter.rows(), scope: 'owned clients only; migration clients excluded; no shared-stat reset' }), { flag: 'wx', mode: 0o600 });
    assert.ok(f.counter.rows().some(r => r.phase === 'setup-admission' && r.fullAdmission), 'counter must see actual cold admission');
  });
});
