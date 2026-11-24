'use strict';

// covers: lib/migrations/postgres.js
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { run, concurrentIndex } = require('../lib/migrations/postgres');
const { checksum } = require('../lib/migrations/catalogue');
const { optInSuite } = require('./support/opt-in');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;

const TABLE = ['CREATE TABLE readings (tenant_id uuid NOT NULL, value integer NOT NULL)'];
const INDEX = ['CREATE INDEX readings_tenant_large ON readings (tenant_id, value) WHERE value > 10'];
const migration = (name, up) => ({ name, up, checksum: checksum(up) });
const catalogue = { version: 1, migrations: [migration('0001_readings', TABLE), migration('0002_readings_large', INDEX)] };

optInSuite(!!uri, 'NS_TEST_POSTGRES_ADMIN_URI')('index migrations on a populated table', function () {
  this.timeout(60000);
  const namespace = 'concurrent_' + randomBytes(6).toString('hex');
  const table = '"' + namespace + '".readings';
  const options = extra => ({ direct: true, connectionString: uri, namespace, catalogue, ...extra });
  let admin;
  const index = async () => (await admin.query(`SELECT i.indisvalid AS valid, i.indisunique AS "unique" FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname='readings_tenant_large'`, [namespace])).rows[0];
  const ledger = async () => (await admin.query('SELECT name FROM "' + namespace + '".schema_migrations ORDER BY name')).rows.map(row => row.name);

  before(async function () {
    admin = new Client({ connectionString: uri });
    await admin.connect();
    await run('up', options({ catalogue: { version: 1, migrations: [catalogue.migrations[0]] } }));
    await admin.query('INSERT INTO ' + table + " SELECT '11111111-1111-4111-8111-111111111111', n % 50 FROM generate_series(1, 2000) n");
  });
  after(async function () {
    if (!admin) return;
    await admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await admin.end();
  });

  it('selects only a migration that is one plain CREATE INDEX', function () {
    assert.deepEqual(concurrentIndex(INDEX), { name: 'readings_tenant_large',
      text: 'CREATE INDEX CONCURRENTLY readings_tenant_large ON readings (tenant_id, value) WHERE value > 10' });
    assert.equal(concurrentIndex(['CREATE UNIQUE INDEX "a_b" ON t (c)']).text, 'CREATE UNIQUE INDEX CONCURRENTLY "a_b" ON t (c)');
    for (const up of [TABLE, [...INDEX, ...INDEX], ['DROP INDEX readings_tenant_large'], ['CREATE INDEX CONCURRENTLY x ON t (c)'],
      ['ALTER TABLE t ADD COLUMN c integer']]) assert.equal(concurrentIndex(up), null);
  });

  it('replaces an INVALID leftover, lets a writer insert during the build and records the ledger row after the index is valid', async function () {
    // An interrupted attempt: an INVALID index of the migration's name and no ledger row.
    await assert.rejects(admin.query('CREATE UNIQUE INDEX CONCURRENTLY readings_tenant_large ON ' + table + ' (tenant_id)'), { code: '23505' });
    assert.deepEqual(await index(), { valid: false, unique: true });
    assert.deepEqual(await ledger(), ['0001_readings']);

    // A writer's open transaction holds the build in its wait phase. A plain
    // CREATE INDEX would queue a SHARE lock here and block the second writer.
    const holder = new Client({ connectionString: uri }), writer = new Client({ connectionString: uri, statement_timeout: 3000 });
    await holder.connect(); await writer.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('INSERT INTO ' + table + " VALUES ('11111111-1111-4111-8111-111111111111', 99)");
      let settled = false;
      const building = run('up', options()).finally(() => { settled = true; });
      building.catch(() => {});
      const locks = async () => (await admin.query(`SELECT l.mode, l.granted FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE a.application_name='nightscout-operator-migrations' AND l.locktype='relation' AND l.relation=$1::regclass`, [table])).rows;
      let seen = [];
      for (let i = 0; i < 100 && !seen.some(row => row.mode === 'ShareUpdateExclusiveLock' && row.granted); i++) { await delay(50); seen = await locks(); }
      assert.ok(seen.some(row => row.mode === 'ShareUpdateExclusiveLock' && row.granted), 'the build holds the concurrent-build lock: ' + JSON.stringify(seen));
      assert.ok(!seen.some(row => row.mode === 'ShareLock'), 'no write-blocking SHARE lock is requested');
      assert.equal(settled, false, 'the build waits for the open writer');
      await writer.query('INSERT INTO ' + table + " VALUES ('11111111-1111-4111-8111-111111111111', 98)");
      assert.deepEqual(await ledger(), ['0001_readings'], 'no ledger row before the index is valid');
      await holder.query('COMMIT');
      const state = await building;
      assert.equal(state.current, true);
      assert.deepEqual(state.done, ['0002_readings_large']);
    } finally {
      await holder.end(); await writer.end();
    }
    assert.deepEqual(await index(), { valid: true, unique: false }, 'the leftover was replaced by the catalogue index');
    assert.deepEqual(await ledger(), ['0001_readings', '0002_readings_large']);
    assert.equal((await run('check', options())).current, true);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM ' + table + ' WHERE value > 10 AND value IN (98, 99)')).rows[0].n, 2);
  });

  it('fails a build past its own bound without a ledger row, and the retry completes', async function () {
    await admin.query('DELETE FROM "' + namespace + "\".schema_migrations WHERE name='0002_readings_large'");
    const holder = new Client({ connectionString: uri });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('INSERT INTO ' + table + " VALUES ('11111111-1111-4111-8111-111111111111', 97)");
      // The runner library reports the build's statement timeout as the cause.
      await assert.rejects(run('up', options({ indexBuildTimeoutMs: 500 })), error => error.cause?.code === '57014');
      assert.deepEqual(await ledger(), ['0001_readings']);
    } finally { await holder.query('ROLLBACK'); await holder.end(); }
    const state = await run('up', options());
    assert.deepEqual(state.done, ['0002_readings_large']);
    assert.deepEqual(await index(), { valid: true, unique: false });
    await assert.rejects(run('up', options({ indexBuildTimeoutMs: 0 })), { code: 'MIG_OPTIONS' });
  });
});
