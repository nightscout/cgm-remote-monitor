'use strict';
// Decision ack-path-tenant-independent, on a disposable PostgreSQL with
// wal_level=logical and wal2json (synthetic tenants only):
//  - a stream receipt for tenant B commits while tenant A's exact snapshot
//    recovery is held open; A's own receipt waits for A's recovery (the
//    per-tenant ordering guarantee) and commits after it;
//  - a first-seen tenant's receipt is durable without in-memory admission;
//  - a tenant under restore (exclusive lifecycle lock) is still refused.
// Each has a red arm: the former single per-consumer recovery key, and the
// receipt without in-transaction initialization.
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs'), vm = require('node:vm');
const { Client, Pool } = require('pg');
const { optInSuite } = require('./support/opt-in');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const recoveryFactory = require('../lib/pgstream/snapshot-recovery');
const authority = require('../lib/pgstream/receipt-authority');
const rules = require('../lib/tenant-registry/rules');
const native = require('./lib/clinical-stream-native');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const initialDigest = 'c'.repeat(64), generation = 'd'.repeat(32);
const settle = (promise, ms) => Promise.race([promise.then(() => 'done', () => 'refused'), new Promise(resolve => setTimeout(() => resolve('pending'), ms))]);

optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI')('acknowledgement independent of another tenant\'s recovery', function () {
  this.timeout(30000);
  let admin, pool, store, cohort, recovery, lifecycle, fence, mode, mainSource, appRole;
  before(async function () {
    mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin = new Client({ connectionString: uri }); await admin.connect();
    const identity = new Client({ connectionString: uri, replication: 'database' }); await identity.connect();
    try { const row = (await identity.query('IDENTIFY_SYSTEM')).rows[0]; mainSource = { system_id: String(row.systemid), timeline: Number(row.timeline), database: row.dbname, slot: 'synthetic_main' }; }
    finally { await identity.end(); }
    pool = new Pool({ connectionString: uri, max: 4 });
    cohort = await require('./fixtures/clinical-native-cohort').create({ admin, pool, prefix: 'synthetic_ack_' + randomBytes(4).toString('hex'), tenants: [A, B, C] });
    // Freshly provisioned rows, as tenant provisioning writes them.
    await admin.query('UPDATE ' + cohort.table + ' SET projection=NULL,checkpoint=0,contract_digest=$2 WHERE consumer=$1', [cohort.consumer, initialDigest]);
    await admin.query('UPDATE ' + cohort.table + ' SET work_version=0,projection=NULL WHERE consumer=$1 AND tenant_id=$2', [cohort.consumer + '-completed', C]);
    lifecycle = cohort.prefix + '_control';
    await admin.query('CREATE SCHEMA ' + lifecycle + ';CREATE TABLE ' + lifecycle + '.tenant_lifecycle_windows(tenant_id uuid PRIMARY KEY,lock_key bigint UNIQUE,generation bigint,phase text)');
    for (const tenant of [A, B, C]) await admin.query('INSERT INTO ' + lifecycle + ".tenant_lifecycle_windows VALUES($1,$2,1,'active')", [tenant, rules.lockKey(tenant)]);
    fence = authority.create({ namespace: lifecycle, generation, available: () => true });
    // The imported-snapshot store is an ordinary application role, as in serving.
    appRole = cohort.prefix + '_app'; const password = randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE ' + appRole + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
    const app = new URL(uri); app.username = appRole; app.password = password;
    store = await connect({ connectionString: app.toString(), max: 2, connectionTimeoutMillis: 2000, query_timeout: 5000 });
    recovery = recoveryFactory.create({ connection: store, createReplicationClient: () => new Client({ connectionString: uri, replication: 'database' }),
      createLockClient: () => new Client({ connectionString: uri }), namespace: cohort.table.split('.')[0], consumer: cohort.consumer, mainSource,
      generation: async () => generation + ':1', timeoutMs: 10000 });
  });
  after(async function () {
    await recovery?.close(); await store?.end();
    await cohort?.close(); if (lifecycle) await admin.query('DROP SCHEMA IF EXISTS ' + lifecycle + ' CASCADE');
    if (appRole) await admin.query('DROP ROLE IF EXISTS ' + appRole);
    await pool?.end(); await admin?.end(); scope.setTenancyMode(mode);
  });
  const sql = () => require('../lib/storage/clinical-stream-sql');
  function receipt (tenant, id, { lockKey = recovery.lockKey, module = sql() } = {}) {
    return module.acceptTransaction({ ...cohort.sqlOptions(native.source, { assertFence: fence, lockKey }), initialDigest,
      envelope: native.envelope([{ ...native.row(id, 100, 'I', tenant), schema: cohort.domains.entries.split('.')[0] }]) });
  }
  async function holdRecovery (tenant, body) {
    let entered, release; const inside = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
    const running = scope.withTenant(tenant, () => recovery.withSnapshot({ tenant, fn: async () => { entered(); await held; return 'recovered'; } }));
    await inside;
    try { return await body(); } finally { release(); assert.equal(await running, 'recovered'); }
  }

  it('commits B\'s receipt while A\'s exact recovery is held, and orders A\'s receipt after A\'s recovery', async function () {
    await holdRecovery(A, async () => {
      assert.equal(await settle(receipt(B, 'b1'), 3000), 'done', 'OTHER_TENANT_ACK_MUST_NOT_WAIT_FOR_RECOVERY');
      const own = receipt(A, 'a1'); own.catch(() => {});
      assert.equal(await settle(own, 500), 'pending', 'SAME_TENANT_RECEIPT_MUST_WAIT_FOR_ITS_RECOVERY');
      return { own };
    }).then(async ({ own }) => assert.equal(await settle(own, 3000), 'done', 'SAME_TENANT_RECEIPT_COMMITS_AFTER_RECOVERY'));
    assert.equal((await cohort.output(B)).work_observed[5], '1');
  });

  it('control: the former single per-consumer recovery key blocks B behind A (base behaviour, red)', async function () {
    // Base 5d248eac: recovery and every receipt shared one key per (namespace, consumer).
    const key = createHash('sha256').update(JSON.stringify(['nightscout-clinical-recovery-v1', cohort.table.split('.')[0], cohort.consumer])).digest().readBigInt64BE().toString();
    const holder = new Client({ connectionString: uri }); await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::bigint)', [key]);
      const blocked = receipt(B, 'b2', { lockKey: () => key }); blocked.catch(() => {});
      assert.equal(await settle(blocked, 1000), 'pending', 'SINGLE_KEY_CONTROL_MUST_BLOCK_OTHER_TENANT');
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      assert.equal(await settle(blocked, 3000), 'done');
    } finally { await holder.end(); }
  });

  it('stores a first-seen tenant\'s receipt durably without in-memory admission; removing in-receipt initialization is red', async function () {
    const file = require.resolve('../lib/storage/clinical-stream-sql'), text = fs.readFileSync(file, 'utf8'), needle = ',rawDeliveryTenants,admit:true,defer:true});';
    assert.equal(text.split(needle).length, 2);
    const broken = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + text.replace(needle, ',rawDeliveryTenants,defer:true});') + '\n})', { filename: file })(require('node:module').createRequire(file), broken, broken.exports);
    await assert.rejects(receipt(C, 'c0', { module: broken.exports }), /EVALUATOR_TYPED_ADMISSION_REQUIRED/);
    assert.equal((await cohort.output(C)).work_observed[5], null, 'refused receipt leaves no partial row');
    await receipt(C, 'c1');
    const completed = (await admin.query('SELECT work_version,work_observed,work_pending_at FROM ' + cohort.table + ' WHERE tenant_id=$1 AND consumer=$2', [C, cohort.consumer + '-completed'])).rows[0];
    assert.equal(completed.work_version, 2); assert.equal(completed.work_observed[5], '1'); assert.notEqual(completed.work_pending_at, null, 'FIRST_SEEN_RECEIPT_MUST_BE_DURABLY_PENDING');
  });

  it('still refuses the receipt of a tenant under restore while another tenant is acknowledged', async function () {
    const restore = new Client({ connectionString: uri }); await restore.connect();
    try {
      await restore.query('SELECT pg_advisory_lock($1::bigint)', [rules.lockKey(A)]);
      await assert.rejects(receipt(A, 'a-restore'), /CLINICAL_STREAM_MAINTENANCE_FENCE/);
      assert.equal(await settle(receipt(B, 'b-restore'), 3000), 'done');
    } finally { await restore.query('SELECT pg_advisory_unlock_all()'); await restore.end(); }
    assert.equal(await settle(receipt(A, 'a-after-restore'), 3000), 'done');
  });
});
