'use strict';

// postgres-connection scanTenants on actual PostgreSQL: one READ ONLY round
// trip, each tenant read under its own forced-RLS binding by a NOSUPERUSER
// NOBYPASSRLS identity. Synthetic tenants only.
// covers: lib/storage/postgres-connection.js
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const { optInSuite } = require('./support/opt-in');

optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI && /test/i.test(new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI || 'postgres://x/none').pathname),
  'disposable NS_TEST_POSTGRES_ADMIN_URI (database name containing "test")')('postgres tenant scan (realtime change hints)', function () {
  this.timeout(30000);
  const schema = 'scan_' + randomUUID().replace(/-/g, '').slice(0, 12), role = schema + '_reader';
  const tenants = [randomUUID(), randomUUID(), randomUUID()];
  let admin, connection, prior;
  before(async function () {
    prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
    admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await admin.connect();
    const password = randomBytes(18).toString('hex');
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".clock (tenant_id uuid PRIMARY KEY, last_stamp bigint NOT NULL)`);
    await admin.query(`ALTER TABLE "${schema}".clock ENABLE ROW LEVEL SECURITY`);
    await admin.query(`ALTER TABLE "${schema}".clock FORCE ROW LEVEL SECURITY`);
    await admin.query(`CREATE POLICY isolation ON "${schema}".clock USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)`);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`GRANT SELECT ON "${schema}".clock TO "${role}"`);
    await admin.query(`CREATE SEQUENCE "${schema}".counter`);
    await admin.query(`GRANT USAGE ON SEQUENCE "${schema}".counter TO "${role}"`);
    await admin.query(`INSERT INTO "${schema}".clock VALUES ($1, 11), ($2, 22)`, tenants.slice(0, 2));
    const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = role; url.password = password;
    connection = await connect({ connectionString: url.toString(), max: 1 });
  });
  after(async function () {
    if (connection) await connection.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(`DROP OWNED BY "${role}"`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
    scope.setTenancyMode(prior);
  });
  it('returns each tenant its own rows only, in one round trip', async function () {
    const before = (await admin.query("SELECT xact_commit::bigint AS n FROM pg_stat_database WHERE datname=current_database()")).rows[0].n;
    // No WHERE clause: RLS alone scopes each statement to the tenant bound before it.
    const found = await connection.scanTenants(tenants, `SELECT last_stamp::text AS stamp FROM "${schema}".clock`);
    assert.deepEqual([...found].map(([t, rows]) => [t, rows.map(r => r.stamp)]), [[tenants[0], ['11']], [tenants[1], ['22']], [tenants[2], []]]);
    const after = (await admin.query("SELECT xact_commit::bigint AS n FROM pg_stat_database WHERE datname=current_database()")).rows[0].n;
    assert.ok(Number(after) - Number(before) <= 3, 'one scan transaction (plus the two counter reads)');
  });
  it('refuses multi-statement, parameterised or non-SELECT text and duplicate or non-UUID tenants', async function () {
    for (const text of ['SELECT 1; SELECT 2', 'SELECT $1', 'DELETE FROM x', "SELECT E'\\x'"]) await assert.rejects(connection.scanTenants(tenants, text), /fixed parameterless SELECT/);
    await assert.rejects(connection.scanTenants([tenants[0], tenants[0]], 'SELECT 1'), /distinct UUID/);
    await assert.rejects(connection.scanTenants(["x'); DROP TABLE y; --"], 'SELECT 1'), /distinct UUID/);
  });
  it('is READ ONLY', async function () {
    await assert.rejects(connection.scanTenants([tenants[0]], `SELECT nextval('"${schema}".counter')`), /read-only transaction/);
  });
});
