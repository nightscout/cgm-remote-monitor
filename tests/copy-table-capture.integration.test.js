'use strict';

// The lifecycle COPY capture (lib/tenant-lifecycle/copy-table.js) returns the
// exact CSV PostgreSQL sent, for an export larger than one network read. The
// client's CopyData payloads are views of a reusable buffer; captured without a
// copy, later reads overwrote them (reproduced: about 84 KB of device status
// failed to parse, the record split by a CopyData header).
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const copy = require('../lib/tenant-lifecycle/copy-table');

const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const A = '0c0e0000-0000-4000-8000-00000000000a';

optInSuite(!!uri, 'NS_TEST_POSTGRES_ADMIN_URI (disposable PostgreSQL)')('lifecycle COPY capture', function () {
  this.timeout(60000);
  const ns = 'copycap_' + randomBytes(4).toString('hex');
  let admin;
  before(async () => {
    admin = new Client({ connectionString: uri }); await admin.connect();
    await admin.query(`CREATE SCHEMA "${ns}"`);
    await admin.query(`CREATE TABLE "${ns}".docs (tenant_id uuid NOT NULL, doc jsonb NOT NULL, n integer NOT NULL)`);
    await admin.query(`INSERT INTO "${ns}".docs SELECT $1, jsonb_build_object('_id', 'd' || i, 'note', 'say "G" here', 'values',
      (SELECT jsonb_agg(100 + (i + k) % 37) FROM generate_series(1, 48) k)), i FROM generate_series(1, 2000) i`, [A]);
  });
  after(async () => { if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${ns}" CASCADE`); await admin.end(); } });

  it('captures an export larger than one read exactly as PostgreSQL sends it', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
      await copy.configure(admin);
      const columns = [{ name: 'tenant_id', oid: 2950 }, { name: 'doc', oid: 3802 }, { name: 'n', oid: 23 }];
      const text = await copy.capture(admin, ns, 'docs', columns);
      assert.ok(text.length > 500000, 'many network reads');
      const rows = copy.rows(text, columns);
      assert.equal(rows.length, 2000);
      const stored = (await admin.query(`SELECT doc, n FROM "${ns}".docs ORDER BY n`)).rows;
      assert.deepStrictEqual(rows.map(row => ({ doc: row.doc, n: row.n })).sort((a, b) => a.n - b.n), stored);
    } finally { await admin.query('ROLLBACK'); }
  });
});
