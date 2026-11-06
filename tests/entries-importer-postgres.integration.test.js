'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const postgresConnection = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const { createPostgresTarget } = require('../lib/import/entries');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const pgURI = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const suite = optInSuite(pgURI, 'NS_TEST_POSTGRES_ADMIN_URI');

suite('PostgreSQL one-time entries import target (requires disposable PostgreSQL)', function () {
  this.timeout(30000);
  const name = 'ns_import_' + crypto.randomUUID().replace(/-/g, '');
  const role = name + '_app';
  const table = name + '.entries';
  let admin, connection, mode;

  before(async function () {
    mode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    admin = new Client({ connectionString: pgURI });
    await admin.connect();
    const password = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE SCHEMA "${name}"`);
    await admin.query(`SET search_path TO "${name}"`);
    await admin.query(fs.readFileSync(path.join(__dirname, 'fixtures/postgres/entries-identity-kinds.sql'), 'utf8'));
    await admin.query(`GRANT USAGE ON SCHEMA "${name}" TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${name}".entries TO "${role}"`);
    const url = new URL(pgURI);
    url.username = role;
    url.password = password;
    connection = await postgresConnection({ connectionString: url.toString(), max: 2 });
  });

  after(async function () {
    if (connection) await connection.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
    if (mode) scope.setTenancyMode(mode);
  });

  it('replaces source values atomically, preserves tenant boundaries and is safe to replay', async function () {
    const targetA = createPostgresTarget({ connection, tenant: A, table });
    const targetB = createPostgresTarget({ connection, tenant: B, table });
    await targetA.writePage([
      { _id: 'shared', date: 1, sgv: 100, source: { app: 'import' } },
      { _id: 'a-only', date: 2, sgv: 101 }
    ]);
    await targetA.writePage([{ _id: 'shared', date: 3, sgv: 102, isValid: false }]);
    await targetB.writePage([{ _id: 'shared', date: 4, sgv: 200 }]);
    await targetA.writePage([{ _id: 'shared', date: 3, sgv: 102, isValid: false }]);

    const rowsA = await connection.withTenant(A, async () =>
      (await connection.query(`SELECT doc FROM "${name}".entries ORDER BY "_id"`)).rows.map(row => row.doc));
    const rowsB = await connection.withTenant(B, async () =>
      (await connection.query(`SELECT doc FROM "${name}".entries ORDER BY "_id"`)).rows.map(row => row.doc));
    assert.deepEqual(rowsA, [
      { _id: 'a-only', date: 2, sgv: 101 },
      { _id: 'shared', date: 3, sgv: 102, isValid: false }
    ]);
    assert.deepEqual(rowsB, [{ _id: 'shared', date: 4, sgv: 200 }]);
  });
});


// Separate opt-in owns source and restore-target containers; never uses caller DB.
require('./fixtures/populated-recovery/lab').install(
  optInSuite(process.env.NS_POPULATED_RECOVERY_DOCKER_TEST === '1', 'NS_POPULATED_RECOVERY_DOCKER_TEST=1'),
  it, before, beforeEach, after
);
