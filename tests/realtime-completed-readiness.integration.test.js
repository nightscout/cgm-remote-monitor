'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const { run } = require('../lib/migrations/postgres');
const readiness = require('../lib/server/serve/evaluator-readiness');
const columns = require('../lib/pgstream/realtime-receipt').COLUMNS;
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI, 'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('completed-output realtime native readiness scope', function () {
  this.timeout(30000);
  const prefix = 'rt_scope_' + crypto.randomBytes(6).toString('hex');
  const namespaces = { clock: prefix + '_clock', checkpoint: prefix + '_rt' };
  const source = prefix + '_ev', clinical = prefix + '_clinical', role = prefix + '_reader';
  const config = { namespaces, completedOutput: { namespace: source } };
  const table = '"' + namespaces.checkpoint + '".tenant_consumer_checkpoint';
  let admin, reader, connected = false, createdRole = false;
  before(async function () {
    admin = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, connectionTimeoutMillis: 5000 });await admin.connect();connected = true;
    for (const [namespace, catalogue] of [[namespaces.clock, require('../migrations/candidates/postgres-write-clock-v1.json')], [namespaces.checkpoint, require('../migrations/candidates/postgres-realtime-output-v2.json')], [source, require('../migrations/candidates/postgres-evaluator-work-v2.json')]]) {
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace, catalogue });
    }
    await admin.query('CREATE SCHEMA "' + clinical + '"');await admin.query('CREATE TABLE "' + clinical + '".entries (tenant_id uuid,value jsonb)');
    const password = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);createdRole = true;
    for (const namespace of [...Object.values(namespaces), source, clinical]) await admin.query('GRANT USAGE ON SCHEMA "' + namespace + '" TO "' + role + '"');
    await admin.query(`GRANT SELECT ON ${table},"${namespaces.checkpoint}".schema_migrations,"${namespaces.clock}".tenant_write_clock,"${namespaces.clock}".schema_migrations,"${source}".tenant_consumer_checkpoint TO "${role}"`);
    await admin.query(`GRANT UPDATE (${columns.map(column => '"' + column + '"').join(',')}) ON ${table} TO "${role}"`);
    const uri = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);uri.username = role;uri.password = password;
    reader = new Client({ connectionString: uri.toString(), connectionTimeoutMillis: 5000 });await reader.connect();
  });
  after(async function () {
    await reader?.end();
    if (admin) { try { if (connected) { for (const namespace of [...Object.values(namespaces), source, clinical]) await admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');if (createdRole) { await admin.query('DROP OWNED BY "' + role + '"');await admin.query('DROP ROLE "' + role + '"'); } } } finally { await admin.end(); } }
  });
  it('passes with no clinical access or legacy checkpoint UPDATE and refuses a revoked delivery column', async function () {
    await readiness.screen(reader, config);
    await assert.rejects(reader.query('SELECT * FROM "' + clinical + '".entries'), error => error.code === '42501');
    await assert.rejects(reader.query('UPDATE ' + table + ' SET projection=NULL'), error => error.code === '42501');
    await admin.query(`REVOKE UPDATE(output_received) ON ${table} FROM "${role}"`);
    try { await assert.rejects(readiness.screen(reader, config), /unsafe evaluator table privileges/); }
    finally { await admin.query(`GRANT UPDATE(output_received) ON ${table} TO "${role}"`); }
    await readiness.screen(reader, config);
  });
  it('rejects added clinical SELECT and obsolete checkpoint UPDATE, then passes restored grants', async function () {
    await readiness.screen(reader, config);
    await admin.query(`GRANT SELECT ON "${clinical}".entries TO "${role}"`);
    try { await assert.rejects(readiness.screen(reader, config), /unsafe evaluator scope/); }
    finally { await admin.query(`REVOKE SELECT ON "${clinical}".entries FROM "${role}"`); }
    await readiness.screen(reader, config);
    await admin.query(`GRANT UPDATE(checkpoint,projection,contract_digest) ON ${table} TO "${role}"`);
    try { await assert.rejects(readiness.screen(reader, config), /unsafe evaluator table privileges/); }
    finally { await admin.query(`REVOKE UPDATE(checkpoint,projection,contract_digest) ON ${table} FROM "${role}"`); }
    await readiness.screen(reader, config);
  });
  it('requires SELECT of the completed evaluator source without granting that source UPDATE', async function () {
    await admin.query(`REVOKE SELECT ON "${source}".tenant_consumer_checkpoint FROM "${role}"`);
    try { await assert.rejects(readiness.screen(reader, config), /unsafe evaluator table privileges/); }
    finally { await admin.query(`GRANT SELECT ON "${source}".tenant_consumer_checkpoint TO "${role}"`); }
    await readiness.screen(reader, config);
    await assert.rejects(reader.query('UPDATE "' + source + '".tenant_consumer_checkpoint SET projection=NULL'), error => error.code === '42501');
  });
});
