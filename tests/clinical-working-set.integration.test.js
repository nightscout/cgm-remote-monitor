'use strict';
// Explicit local PostgreSQL capability. No implicit database, listener or Docker.
const assert = require('node:assert/strict');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const replayFactory = require('../lib/storage/postgres-durable-replay');
const stream = require('../lib/storage/clinical-stream-state');
const policy = require('../lib/storage/clinical-working-set-policy');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const tenantStats = require('../lib/storage/postgres-tenant-stats');
const at = Date.UTC(2026, 10, 16, 12), DAY = 86400000, env = { extendedSettings: {} }, limits = { maxRows: 30, maxBytes: 200000 };
const brokenModule = require('./lib/clinical-working-set/control');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const enabled = !!process.env.CLINICAL_WINDOW_PG_SOCKET;
(enabled ? describe : describe.skip)('native clinically sufficient bounded bootstrap/recovery', function () {
  this.timeout(20000);
  let db, connection, handle, previous, queries = [], domains, oldRows, sourceCount;
  const checkpoint = 'synthetic_window_work.tenant_consumer_checkpoint';
  before(async () => {
    previous = scope.getTenancyMode();scope.setTenancyMode('multi');
    db = new Client({ host: process.env.CLINICAL_WINDOW_PG_SOCKET, user: 'postgres', database: 'postgres' });await db.connect();
    for (const domain of [...stream.DOMAINS, 'work', 'clock']) await db.query('DROP SCHEMA IF EXISTS synthetic_window_' + domain + ' CASCADE');
    await db.query('DROP ROLE IF EXISTS synthetic_window_reader');
    await db.query('CREATE ROLE synthetic_window_reader NOLOGIN');
    domains = Object.fromEntries(stream.DOMAINS.map(domain => [domain, 'synthetic_window_' + domain + '.' + domain]));
    for (const [domain, table] of Object.entries(domains)) {
      const schema = 'synthetic_window_' + domain;
      await db.query('CREATE SCHEMA ' + schema + '; CREATE TABLE ' + table + ' (tenant_id uuid NOT NULL,id_kind text NOT NULL,"_id" text NOT NULL,doc jsonb NOT NULL,insertion_ordinal bigint NOT NULL,storage_bytes bigint NOT NULL,PRIMARY KEY(tenant_id,id_kind,"_id")); ALTER TABLE ' + table + ' ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant ON ' + table + " USING (tenant_id=current_setting('synthetic.tenant')::uuid); GRANT USAGE ON SCHEMA " + schema + ' TO synthetic_window_reader; GRANT SELECT ON ' + table + ' TO synthetic_window_reader');
    }
    await db.query('CREATE SCHEMA synthetic_window_work; CREATE TABLE ' + checkpoint + ' (tenant_id uuid,consumer text,checkpoint bigint,contract_digest text,projection jsonb,PRIMARY KEY(tenant_id,consumer)); GRANT USAGE ON SCHEMA synthetic_window_work TO synthetic_window_reader; GRANT SELECT,UPDATE ON ' + checkpoint + ' TO synthetic_window_reader');
    oldRows = Array.from({ length: 2000 }, (_, i) => ({ _id: 'history-' + i, date: at - 500 * DAY - i, type: 'sgv', sgv: 200, srvModified: 10, isValid: i % 2 === 0 }));
    for (const [tenant, id, date, sgv] of [[A, 'current', at - 60000, 123], [B, 'other-tenant', at, 399]]) {
      await db.query('INSERT INTO ' + domains.entries + " SELECT $1,'string',doc->>'_id',doc,row_number() OVER (),pg_column_size(doc) FROM jsonb_array_elements($2::jsonb) doc", [tenant, JSON.stringify([...(tenant === A ? oldRows : []), { _id: id, date, type: 'sgv', sgv, srvModified: 10 }])]);
    }
    for (const doc of [{ _id: 'profile-old', startDate: '2020', units: 'mg/dl' }, { _id: 'profile-new', startDate: '2026', units: 'mg/dl' }]) await db.query('INSERT INTO ' + domains.profile + " VALUES ($1,'string',$2,$3,1,pg_column_size($3::jsonb))", [A, doc._id, doc]);
    const olderStatus = { _id: 'older-status', created_at: new Date(at - 36 * 3600000).toISOString() };
    await db.query('INSERT INTO ' + domains.devicestatus + " VALUES ($1,'string',$2,$3,1,pg_column_size($3::jsonb))", [A, olderStatus._id, olderStatus]);
    await db.query('CREATE SCHEMA synthetic_window_clock; CREATE TABLE synthetic_window_clock.tenant_write_clock(tenant_id uuid PRIMARY KEY,last_stamp bigint,last_delete_stamp bigint); GRANT USAGE ON SCHEMA synthetic_window_clock TO synthetic_window_reader; GRANT SELECT ON synthetic_window_clock.tenant_write_clock TO synthetic_window_reader');
    await db.query('INSERT INTO synthetic_window_clock.tenant_write_clock VALUES ($1,10,0),($2,10,0)', [A, B]);
    await db.query("INSERT INTO " + checkpoint + " VALUES ($1,'evaluator-synthetic',0,'',NULL),($2,'evaluator-synthetic',0,'',NULL)", [A, B]);
    connection = {
      async query(text, values) { queries.push(text);await db.query("SELECT set_config('synthetic.tenant',$1,false)", [scope.requireTenant('native window query')]);return db.query(text, values); },
      async snapshotTransaction(fn) { await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try { const result = await fn();await db.query('COMMIT');return result; } catch (error) { await db.query('ROLLBACK');throw error; } }
    };
    handle = replayFactory({ connection, checkpointTable: checkpoint, clockTable: 'synthetic_window_clock.tenant_write_clock', domains, consumer: 'evaluator-synthetic', projectionVersion: 'clinical-current-rows-v1', pageSize: 5, maxRows: limits.maxRows, stream: true });
    sourceCount = (await db.query('SELECT count(*)::text AS n FROM ' + domains.entries)).rows[0].n;
    await db.query('SET ROLE synthetic_window_reader');
  });
  after(async () => { try { await db?.end(); } finally { scope.setTenancyMode(previous); } });
  const reconcile = (tenant = A, extra = {}) => scope.withTenant(tenant, () => handle.reconcile({ ...limits, signature: true, policy: policy.create(env, at), ...extra }));
  it('admits only needed historical rows under a nonowner read-only clinical role and preserves authoritative storage bytes', async () => {
    const result = await reconcile();assert.equal(result.rows.filter(r => r.domain === 'entries').length, 1);assert.equal(result.rows.find(r => r.domain === 'entries').document.sgv, 123);
    assert.equal(result.rows.find(r => r.domain === 'profile').document._id, 'profile-new');assert(!result.rows.some(r => r.domain === 'devicestatus'));
    const stats = await scope.withTenant(A, () => tenantStats({ connection, tables: domains }).read(A));assert(stats.dataSize > 100000, 'WHOLE_HISTORY_BYTES_PRESERVED');assert.equal(result.stats, undefined);
    assert(!queries.some(q => /^DELETE|^INSERT INTO synthetic_window_entries/.test(q)), 'NO_SOURCE_MUTATION_FROM_CACHE');
    const b = await reconcile(B);assert.equal(b.rows.find(r => r.domain === 'entries').document.sgv, 399);
  });
  it('warm/default engine answers match unbounded-source engine and expiry performs no source range/census reacquisition', async () => {
    const safeEnv = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
    const language = require('../lib/language')(), stats = () => tenantStats({ connection, tables: domains }).read(A);
    const component = evaluator({ tenant: A, replay: handle, connection, env: safeEnv, language, dbstats: stats, maxRows: limits.maxRows, maxBytes: limits.maxBytes, includeFrame: true });
    const clock = require('./lib/views-replay/clock');clock.install();clock.pin(at);
    try {
      queries = [];const actual = await component.evaluate({ at });assert.equal(actual.properties.bgnow.mean, 123);assert.equal(actual.frame.sgvs.length, 1);
      assert(!queries.some(q => q.includes('snapshot_source') || q.includes('information_schema')), 'WARM_INPUT_MUST_NOT_REACQUIRE_RAW_ROWS');
      const sourceRows = [];
      for (const [domain, table] of Object.entries(domains)) {
        const docs = await scope.withTenant(A, () => connection.query('SELECT doc FROM ' + table));
        sourceRows.push(...docs.rows.map(r => ({ domain, document: r.doc })));
      }
      const fullReplay = { async reconcile() { return { checkpoint: 10, rows: sourceRows, stats: await stats() }; } };
      const full = evaluator({ tenant: A, replay: fullReplay, connection, env: safeEnv, language, dbstats: stats, maxRows: 3000, maxBytes: 1000000, includeFrame: true });
      const baseline = await full.evaluate({ at });assert.deepEqual(actual.properties, baseline.properties);assert.deepEqual(actual.frame, baseline.frame);
      queries = [];const later = at + 2 * DAY;clock.pin(later);const expired = await component.evaluateTime({ at: later });assert.equal(expired.frame.sgvs.length, 0);assert.equal(expired.checkpoint, 10);
      assert(!queries.some(q => q.includes('snapshot_source') || q.includes('information_schema') || q.includes('sum(pg_column_size')), 'EXPIRY_MUST_USE_ONLY_DERIVED_STATE');
      component.close();full.close();
    } finally { clock.uninstall(); }
  });
  it('settings expansion and cold/restore invalidation recover bounded historical dependencies, rather than silently completing missing state', async () => {
    queries = [];const widened = await reconcile(A, { policy: policy.create({ extendedSettings: { devicestatus: { days: 2 } } }, at + 1) });
    assert(widened.rows.some(r => r.document._id === 'older-status'));assert(queries.some(q => q.includes('snapshot_source')), 'LEGITIMATE_SETTINGS_HISTORY_FETCH');
    await scope.withTenant(A, () => connection.query('UPDATE ' + checkpoint + ' SET projection=NULL WHERE tenant_id=$1', [A]));
    queries = [];const restored = await reconcile();assert.equal(restored.rows.find(r => r.domain === 'entries').document.sgv, 123);assert(queries.some(q => q.includes('snapshot_source')), 'EXPLICIT_REBUILD_AFTER_CACHE_LOSS');
    const stats = await scope.withTenant(A, () => tenantStats({ connection, tables: domains }).read(A));assert(stats.dataSize > 100000);
    await db.query('RESET ROLE');assert.equal((await db.query('SELECT count(*)::text AS n FROM ' + domains.entries)).rows[0].n, sourceCount);await db.query('SET ROLE synthetic_window_reader');
  });
  it('control: losing the window predicate fails old-history admission; restored SQL passes', async () => {
    const broken = brokenModule('../lib/storage/postgres-durable-replay', 'const boundedSource = policy ? await windowSourceSql(policy) : null;', 'const boundedSource = null;');
    await scope.withTenant(A, () => connection.query('UPDATE ' + checkpoint + ' SET projection=NULL WHERE tenant_id=$1', [A]));
    const bad = broken({ connection, checkpointTable: checkpoint, clockTable: 'synthetic_window_clock.tenant_write_clock', domains, consumer: 'evaluator-synthetic', projectionVersion: 'clinical-current-rows-v1', pageSize: 5, maxRows: limits.maxRows, stream: true });
    await assert.rejects(scope.withTenant(A, () => bad.reconcile({ ...limits, signature: true, policy: policy.create(env, at) })), /REPLAY_SNAPSHOT_ROW_BOUND/);
    await reconcile();
  });
});
