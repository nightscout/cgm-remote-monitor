'use strict';
// readStatement runs on its own pool whose backends start with
// default_transaction_read_only=on (maintainer decision 2026-11-20): PostgreSQL
// refuses a write in those implicit transactions with SQLSTATE 25006, still at
// one statement per read. Disposable PostgreSQL, synthetic rows only.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const connect = require('../lib/storage/postgres-connection');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;

optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI')('readStatement read-only pool', function () {
  this.timeout(30000);
  const suffix = randomBytes(4).toString('hex'), schema = 'synthetic_read_' + suffix, role = 'synthetic_read_' + suffix;
  let admin, url;
  const writes = {
    'SELECT … FOR UPDATE': `SELECT id FROM ${schema}.work WHERE id=1 FOR UPDATE`,
    'a function that writes': `SELECT ${schema}.bump() AS value`,
    nextval: `SELECT nextval('${schema}.seq') AS value`
  };
  const value = async () => (await admin.query(`SELECT value FROM ${schema}.work WHERE id=1`)).rows[0].value;
  before(async function () {
    admin = new Client({ connectionString: uri }); await admin.connect();
    const password = randomBytes(18).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.work(id int PRIMARY KEY, value int NOT NULL); INSERT INTO ${schema}.work VALUES (1, 0);
      CREATE SEQUENCE ${schema}.seq;
      CREATE FUNCTION ${schema}.bump() RETURNS int LANGUAGE sql AS $$ UPDATE ${schema}.work SET value=value+1 WHERE id=1 RETURNING value $$;
      GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT, UPDATE ON ${schema}.work TO ${role}; GRANT USAGE, SELECT, UPDATE ON ${schema}.seq TO ${role};`);
    const parsed = new URL(uri); parsed.username = role; parsed.password = password; url = parsed.toString();
  });
  after(async function () {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  });

  it('PostgreSQL refuses every write through readStatement with 25006, at one statement per read', async function () {
    const store = await connect({ connectionString: url, max: 2, application_name: 'synthetic-read-statement' });
    try {
      const first = await store.readStatement(`SELECT value FROM ${schema}.work WHERE id=$1`, [1]);
      assert.equal(first.rows[0].value, 0);
      for (const [name, text] of Object.entries(writes)) {
        await assert.rejects(store.readStatement(text, []), error => error.code === '25006', 'READ_ONLY_REFUSES ' + name);
      }
      assert.equal(await value(), 0, 'NO_WRITE_COMMITTED');
    } finally { await store.end(); }
  });

  it('one statement per read on the read backend', async function () {
    const seen = [];
    class Counting extends require('pg').Client {
      query (...args) { seen.push(typeof args[0] === 'string' ? args[0] : args[0].text); return super.query(...args); }
    }
    const store = await connect({ connectionString: url, max: 1, Client: Counting, application_name: 'synthetic-read-statement' });
    try {
      await store.readStatement(`SELECT value FROM ${schema}.work WHERE id=$1`, [1]);
      const mark = seen.length;
      await store.readStatement(`SELECT value FROM ${schema}.work WHERE id=$1`, [1]);
      assert.deepEqual(seen.slice(mark), [`SELECT value FROM ${schema}.work WHERE id=$1`], 'ONE_STATEMENT_PER_READ');
    } finally { await store.end(); }
  });

  it('RED control: without the read-only start option and its backend check, the same write commits', async function () {
    const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
    const name = require.resolve('../lib/storage/postgres-connection');
    const original = fs.readFileSync(name, 'utf8'), cuts = [["'-c default_transaction_read_only=on'", "''"], ["if (mode !== 'on') throw", 'if (false) throw']];
    let source = original;
    for (const [needle, replacement] of cuts) { assert.equal(source.split(needle).length, 2, 'CONTROL_ANCHOR ' + needle); source = source.replace(needle, replacement); }
    const loaded = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + source + '\n})', { filename: name })(createRequire(name), loaded, loaded.exports);
    const open = await loaded.exports({ connectionString: url, max: 2, application_name: 'synthetic-read-statement' });
    try {
      const result = await open.readStatement(writes['a function that writes'], []);
      assert.equal(result.rows[0].value, 1, 'RED: the write went through');
      assert.equal(await value(), 1);
    } finally {
      await open.end();
      await admin.query(`UPDATE ${schema}.work SET value=0 WHERE id=1`);
    }
  });
});
