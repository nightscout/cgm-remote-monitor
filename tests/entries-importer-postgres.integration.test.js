'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const postgresConnection = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const { createPostgresTarget, importEntries } = require('../lib/import/entries');
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

  it('retains committed pages, rolls back an interrupted native page and reruns supplier history with exact fidelity', async function () {
    const control = process.env.NS_M1_IMPORT_CONTROL;
    if (control && (control !== 'drop-target-row' || process.env.NS_M1_ARCHIVE_CONTROL !== '1')) {
      throw new Error('M1 import control requires explicit archived drop-target-row selection');
    }
    await admin.query(`DELETE FROM "${name}".entries`);
    const clone = value => JSON.parse(JSON.stringify(value));
    const baseline = Array.from({ length: 4 }, (_, index) => ({
      _id: 'm1-import-' + index, date: index + 1, type: 'sgv', sgv: 110 + index,
      source: { app: 'synthetic-supplier', sequence: index },
      extension: { nullable: null, ordered: [3, 1, { preserved: false }] }
    }));
    const history = [
      { ...clone(baseline[0]), sgv: 151, srvModified: 10000, source: { app: 'synthetic-history', sequence: 0 } },
      { ...clone(baseline[1]), isValid: false, srvModified: 10000 }
    ];
    const expected = [history[0], history[1], baseline[2], baseline[3]];
    const source = {
      key: 'synthetic-supplier',
      async baseline ({ limit, skip }) { return clone(baseline.slice(skip, skip + limit)); },
      async history ({ cursor }) { return { docs: cursor < 10000 ? clone(history) : [], cursor: 10000 }; }
    };
    const physical = async tenant => (await admin.query(
      `SELECT tenant_id, id_kind, doc FROM "${name}".entries WHERE tenant_id = $1 ORDER BY "_id", id_kind`, [tenant])).rows;
    await createPostgresTarget({ connection, tenant: B, table }).writePage([
      { _id: baseline[0]._id, date: 1, sgv: 902, source: { app: 'synthetic-foreign' } }
    ]);
    const foreign = await physical(B);
    let interruption, interruptOnce = true;
    const observed = { ...connection, async query (sql, values) {
      const result = await connection.query(sql, values);
      if (interruptOnce && /^INSERT INTO /.test(sql) && values.some(value =>
        typeof value === 'string' && value.includes('"_id":"m1-import-2"'))) {
        interruptOnce = false;
        interruption = {
          inside: (await connection.query(`SELECT tenant_id, id_kind, doc FROM "${name}".entries WHERE tenant_id = $1 ORDER BY "_id", id_kind`, [A])).rows,
          outside: await physical(A)
        };
        throw new Error('synthetic-m1-after-native-insert');
      }
      return result;
    } };
    const nativeTarget = createPostgresTarget({ connection: observed, tenant: A, table });
    const receipts = [];
    const target = { async writePage (docs) {
      // This control is a defective supplied target, not a production ablation:
      // the importer sees success but the independent stored oracle sees loss.
      const forwarded = control ? docs.filter(doc => doc._id !== baseline[3]._id) : docs;
      const receipt = { submitted: docs.map(doc => doc._id), forwarded: forwarded.map(doc => doc._id), outcome: 'pending' };
      receipts.push(receipt);
      try { await nativeTarget.writePage(forwarded); receipt.outcome = 'committed'; }
      catch (error) { receipt.outcome = 'refused'; throw error; }
    } };
    const run = () => importEntries({ source, target, tenant: A, pageSize: 2, now: () => 10000 });
    let failure;
    try { await run(); } catch (error) { failure = error; }
    const interrupted = { A: await physical(A), B: await physical(B) };
    console.log('M1_IMPORT_INTERRUPTION ' + JSON.stringify({ interruption, receipts, interrupted }));
    assert.equal(failure && failure.message, 'synthetic-m1-after-native-insert', 'M1_IMPORT_REACHED actual insert then interruption');
    assert.deepEqual(interruption.inside.map(row => row.doc._id), baseline.slice(0, 3).map(doc => doc._id),
      'M1_IMPORT_REACHED later page row visible inside actual transaction');
    assert.deepEqual(interruption.outside.map(row => row.doc), baseline.slice(0, 2),
      'M1_IMPORT_BOUNDARY independent reader sees only earlier committed page');
    assert.deepEqual(interrupted.A.map(row => row.doc), baseline.slice(0, 2),
      'M1_IMPORT_ROLLBACK interrupted page absent, earlier committed page retained');
    assert.deepEqual(interrupted.B, foreign, 'M1_IMPORT_FOREIGN interruption preserves B');

    const result = await run();
    const completed = { A: await physical(A), B: await physical(B) };
    console.log('M1_IMPORT_COMPLETION ' + JSON.stringify({ control: control || null, result, receipts, completed }));
    assert.deepEqual(result, { baselineCount: 4, historyCount: 2, phase: 'done', cursor: 10000 },
      'M1_IMPORT_RECEIPT supplier algorithm completed baseline and history');
    assert.deepEqual(completed.B, foreign, 'M1_IMPORT_FOREIGN completed import preserves B');
    assert.ok(completed.A.every(row => row.id_kind === 'string' && row.tenant_id === A));
    assert.deepEqual(completed.A.map(row => row.doc), expected, 'M1_IMPORT_FIDELITY stored logical source/history rows');
    const replay = await run();
    const replayed = { A: await physical(A), B: await physical(B) };
    console.log('M1_IMPORT_REPLAY ' + JSON.stringify({ replay, receipts, replayed }));
    assert.deepEqual(replay, result, 'M1_IMPORT_RECEIPT complete replay receipt');
    assert.deepEqual(replayed, completed, 'M1_IMPORT_REPLAY exact stored fidelity without duplicates');
  });

});


// Separate opt-in owns source and restore-target containers; never uses caller DB.
require('./fixtures/populated-recovery/lab').install(
  optInSuite(process.env.NS_POPULATED_RECOVERY_DOCKER_TEST === '1', 'NS_POPULATED_RECOVERY_DOCKER_TEST=1'),
  it, before, beforeEach, after
);
