'use strict';
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const connect = require('../lib/storage/postgres-connection');
const recovery = require('../lib/pgstream/snapshot-recovery');
const waitForEntry = require('./fixtures/snapshot-recovery-entry');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const suite = optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI');
const TENANT = '11111111-1111-4111-8111-111111111111';
suite('PostgreSQL exact exported snapshot recovery', function () {
  this.timeout(15000);
  const name = 'ns_snapshot_' + randomUUID().replace(/-/g, ''), role = name + '_app', streamRole = name + '_stream';
  let admin, store, cfg, exportCfg, appURI, mode, mainSource;
  before(async function () {
    mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    cfg = { connectionString: uri, connectionTimeoutMillis: 2000, query_timeout: 3000 };
    admin = new Client(cfg); await admin.connect();
    const identity = new Client({ ...cfg, replication: 'database' }); await identity.connect();
    try { const row = (await identity.query('IDENTIFY_SYSTEM')).rows[0]; mainSource = { system_id: row.systemid, timeline: Number(row.timeline), database: row.dbname, slot: 'synthetic_main' }; }
    finally { await identity.end(); }
    // Each restricted role authenticates under the runner's real SCRAM policy.
    // Synthetic secrets stay in this fixture process and its private URI only.
    const appPassword = randomBytes(24).toString('hex'), streamPassword = randomBytes(24).toString('hex');
    await admin.query("CREATE ROLE " + role + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + appPassword + "'; CREATE ROLE " + streamRole + " LOGIN REPLICATION NOSUPERUSER NOBYPASSRLS PASSWORD '" + streamPassword + "'");
    const streamURI = new URL(uri); streamURI.username = streamRole; streamURI.password = streamPassword;
    exportCfg = { ...cfg, connectionString: streamURI.toString(), replication: 'database' };
    await admin.query('CREATE SCHEMA ' + name + '; CREATE TABLE ' + name + '.source(tenant_id uuid,id integer,value text); CREATE TABLE ' + name + '.saved(tenant_id uuid,value jsonb)');
    await admin.query('ALTER TABLE ' + name + '.source ENABLE ROW LEVEL SECURITY; ALTER TABLE ' + name + '.source FORCE ROW LEVEL SECURITY; CREATE POLICY tenant ON ' + name + '.source USING (tenant_id=NULLIF(current_setting(\'app.current_tenant_id\',true),\'\')::uuid)');
    await admin.query('GRANT USAGE ON SCHEMA ' + name + ' TO ' + role + '; GRANT SELECT ON ' + name + '.source TO ' + role + '; GRANT SELECT,INSERT,DELETE ON ' + name + '.saved TO ' + role);
    await admin.query('INSERT INTO ' + name + '.source VALUES($1,1,$2)', [TENANT, 'before']);
    const app = new URL(uri); app.username = role; app.password = appPassword; appURI = app.toString();
    store = await connect({ connectionString: appURI, connectionTimeoutMillis: 2000, query_timeout: 3000, max: 1 });
  });
  after(async function () {
    await store?.end();
    if (admin) { await admin.query('DROP SCHEMA IF EXISTS ' + name + ' CASCADE; DROP ROLE IF EXISTS ' + role + '; DROP ROLE IF EXISTS ' + streamRole); await admin.end(); }
    scope.setTenancyMode(mode);
  });
  function coordinator (extra = {}) { return recovery.create({ connection: store, createReplicationClient: () => new Client(exportCfg), createLockClient: () => new Client({ ...cfg, connectionString: appURI }), namespace: name, consumer: 'evaluator-snapshot', mainSource, generation: async () => 'epoch:7', timeoutMs: 3000, ...extra }); }
  it('imports before RLS queries and persists the old view despite a concurrent committed correction', async function () {
    const c = coordinator({ createReplicationClient: () => {
      const client = new Client(exportCfg), query = client.query.bind(client);
      client.query = async (sql, ...args) => {
        const result = await query(sql, ...args);
        if (sql.startsWith('CREATE_REPLICATION_SLOT')) await admin.query('UPDATE ' + name + '.source SET value=$1 WHERE tenant_id=$2 AND id=1', ['between-export-and-import', TENANT]);
        return result;
      };
      return client;
    } }); let descriptor;
    try {
      await scope.withTenant(TENANT, () => c.withSnapshot({ tenant: TENANT, fn: async boundary => {
        descriptor = boundary;
        await admin.query('UPDATE ' + name + '.source SET value=$1 WHERE tenant_id=$2 AND id=1', ['after', TENANT]);
        const rows = (await store.query('SELECT id,value FROM ' + name + '.source ORDER BY id')).rows;
        assert.deepEqual(rows, [{ id: 1, value: 'before' }], 'imported snapshot must retain exact pre-correction view');
        await store.query('INSERT INTO ' + name + '.saved VALUES($1,$2::jsonb)', [TENANT, JSON.stringify(rows)]);
      } }));
      assert.deepEqual((await admin.query('SELECT value FROM ' + name + '.saved')).rows[0].value, [{ id: 1, value: 'before' }]);
      assert.deepEqual(descriptor.source_identity, mainSource); assert.equal(descriptor.generation, 'epoch:7');
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name LIKE 'ns_recovery_%'")).rows[0].n, 0);
    } finally { await c.close(); }
  });
  it('holds the deployment recovery barrier through imported snapshot COMMIT', async function () {
    const c = coordinator();
    try {
      await scope.withTenant(TENANT, () => c.withSnapshot({ tenant: TENANT, fn: async () => {
        assert.equal((await admin.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS held', [c.lockKey(TENANT)])).rows[0].held, false);
      } }));
      assert.equal((await admin.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS held', [c.lockKey(TENANT)])).rows[0].held, true);
      await admin.query('SELECT pg_advisory_unlock_shared($1::bigint)', [c.lockKey(TENANT)]);
    } finally { await c.close(); }
  });
  it('refuses an exported name lost before import and commits no seed', async function () {
    const exporter = new Client({ ...cfg, replication: 'database' }); await exporter.connect();
    const exported = (await exporter.query('CREATE_REPLICATION_SLOT ' + name + ' TEMPORARY LOGICAL wal2json EXPORT_SNAPSHOT')).rows[0]; await exporter.end();
    await assert.rejects(scope.withTenant(TENANT, () => store.importedSnapshotTransaction(exported.snapshot_name, async () => {
      await store.query('INSERT INTO ' + name + '.saved VALUES($1,$2::jsonb)', [TENANT, '{}']);
    })), error => error.code === '22023');
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM ' + name + '.saved')).rows[0].n, 1);
  });
  it('deadline cancels a queued deployment lock without leaving a waiting backend', async function () {
    const c = coordinator({ timeoutMs: 100 });
    await admin.query('SELECT pg_advisory_lock($1::bigint)', [c.lockKey(TENANT)]);
    try {
      await assert.rejects(scope.withTenant(TENANT, () => c.withSnapshot({ tenant: TENANT, fn: () => assert.fail('locked recovery reached seed') })), /DEADLINE/);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'", [role])).rows[0].n, 0);
    } finally { await admin.query('SELECT pg_advisory_unlock($1::bigint)', [c.lockKey(TENANT)]); await c.close(); }
  });
  it('deadline kills a blocked exporter and releases its session lock and temporary slot', async function () {
    const writer = new Client(cfg); await writer.connect();
    await writer.query('BEGIN'); await writer.query('INSERT INTO ' + name + '.source VALUES($1,2,$2)', [TENANT, 'held']);
    const c = coordinator({ timeoutMs: 100 });
    try {
      await assert.rejects(scope.withTenant(TENANT, () => c.withSnapshot({ tenant: TENANT, fn: () => assert.fail('held export reached seed') })), /DEADLINE/);
      const locked = (await admin.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [c.lockKey(TENANT)])).rows[0].held;
      assert.equal(locked, true); await admin.query('SELECT pg_advisory_unlock($1::bigint)', [c.lockKey(TENANT)]);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name LIKE 'ns_recovery_%'")).rows[0].n, 0);
    } finally { await writer.query('ROLLBACK'); await writer.end(); await c.close(); }
  });
  it('refuses a deadline during delayed connection setup without entering the seed callback', async function () {
    let releaseConnect, enteredConnect, delayed=true,seedEntered=false,exports=0;
    const heldConnect=new Promise(resolve=>{releaseConnect=resolve;}),connected=new Promise(resolve=>{enteredConnect=resolve;});
    const c=coordinator({
      createLockClient:()=>{
        const client=new Client({...cfg,connectionString:appURI});
        if(delayed){delayed=false;const connect=client.connect.bind(client);client.connect=async()=>{await connect();enteredConnect();await heldConnect;};}
        return client;
      },
      createReplicationClient:()=>{exports++;return new Client(exportCfg);}
    });
    const pending=scope.withTenant(TENANT,()=>c.withSnapshot({tenant:TENANT,fn:()=>{seedEntered=true;assert.fail('setup refusal reached seed');}}));
    try{
      await waitForEntry(connected,pending);
      await assert.rejects(pending,/DEADLINE/);
      assert.equal(seedEntered,false);assert.equal(exports,0,'REFUSED_SETUP_MUST_NOT_EXPORT_SNAPSHOT');
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM '+name+'.saved')).rows[0].n,1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name LIKE 'ns_recovery_%'")).rows[0].n,0);
    }finally{releaseConnect();await c.close();}
  });
  it('deadline aborts the imported backend before a late callback can persist or COMMIT', async function () {
    const c=coordinator();let finish,entered,lateFinished;
    const started=new Promise(resolve=>{entered=resolve;}),lateSettled=new Promise(resolve=>{lateFinished=resolve;});
    const pending=scope.withTenant(TENANT,()=>c.withSnapshot({tenant:TENANT,fn:async()=>{
      entered();await new Promise(resolve=>{finish=resolve;});
      try{await store.query('INSERT INTO '+name+'.saved VALUES($1,$2::jsonb)',[TENANT,'{"late":true}']);}
      finally{lateFinished();}
    }}));
    try{
      // Refusal before entry rejects here explicitly instead of waiting forever
      // for a callback that cannot run. The normal setup budget remains bounded.
      await waitForEntry(started,pending);
      await assert.rejects(pending,/DEADLINE/);finish();await lateSettled;
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM '+name+'.saved')).rows[0].n,1);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name LIKE 'ns_recovery_%'")).rows[0].n,0);
    }finally{finish?.();await c.close();}
  });
});
