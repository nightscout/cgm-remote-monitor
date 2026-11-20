'use strict';
// Writer-driven evaluator start check (decision stable-evaluator-runtime): every
// ledger the evaluator reads, the lifecycle catalogue included, must equal the
// reviewed catalogue; any mismatch refuses with EVALUATOR_SCHEMA_REFUSED.
// Disposable PostgreSQL, synthetic schemas only.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const schema = require('../lib/writer-driven/schema');
const { run } = require('../lib/migrations/postgres');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;

optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI')('writer-driven evaluator start schema check', function () {
  this.timeout(60000);
  const suffix = randomBytes(4).toString('hex'), work = 'synthetic_sw_' + suffix, control = 'synthetic_sc_' + suffix;
  const catalogues = { [work]: require('../migrations/candidates/postgres-evaluator-work-v2.json'),
    [control]: require('../lib/tenant-lifecycle/postgres-candidate.json') };
  const ledgers = () => Object.entries(catalogues).map(([namespace, catalogue]) => ({ connectionString: uri, namespace, catalogue }));
  let admin;
  before(async function () {
    admin = new Client({ connectionString: uri }); await admin.connect();
    for (const [namespace, catalogue] of Object.entries(catalogues)) {
      await admin.query('CREATE SCHEMA "' + namespace + '"');
      await run('up', { direct: true, connectionString: uri, namespace, catalogue });
    }
  });
  after(async function () {
    for (const namespace of Object.keys(catalogues)) await admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await admin.end();
  });
  const refused = async (label, mutate, restore) => {
    await mutate();
    try { await assert.rejects(schema.check(ledgers()), error => error.code === schema.CODE, label); }
    finally { await restore(); }
    await schema.check(ledgers());
  };

  it('admits current ledgers, including the lifecycle catalogue', async function () {
    await schema.check(ledgers());
  });
  it('refuses a drifted, a pending and an unknown lifecycle migration with one typed code', async function () {
    const table = '"' + control + '".schema_migrations';
    const last = (await admin.query('SELECT name,checksum FROM ' + table + ' ORDER BY name COLLATE "C" DESC LIMIT 1')).rows[0];
    await refused('DRIFT', () => admin.query('UPDATE ' + table + ' SET checksum=$2 WHERE name=$1', [last.name, '0'.repeat(64)]),
      () => admin.query('UPDATE ' + table + ' SET checksum=$2 WHERE name=$1', [last.name, last.checksum]));
    const saved = (await admin.query('SELECT * FROM ' + table + ' WHERE name=$1', [last.name])).rows[0];
    const columns = Object.keys(saved);
    await refused('PENDING', () => admin.query('DELETE FROM ' + table + ' WHERE name=$1', [last.name]),
      () => admin.query('INSERT INTO ' + table + ' (' + columns.map(c => '"' + c + '"').join(',') + ') VALUES (' + columns.map((_, i) => '$' + (i + 1)).join(',') + ')', columns.map(c => saved[c])));
    await refused('UNKNOWN', () => admin.query('INSERT INTO ' + table + ' (' + columns.map(c => '"' + c + '"').join(',') + ') VALUES (' + columns.map((_, i) => '$' + (i + 1)).join(',') + ')',
      columns.map(c => c === 'name' ? 'zzzz_synthetic_unknown' : saved[c])),
    () => admin.query('DELETE FROM ' + table + " WHERE name='zzzz_synthetic_unknown'"));
  });
});
