'use strict';

// API v1 entries batches on the multitenant PostgreSQL line, over the shipping
// HTTP path and the api's own data connection options (DATA_CONNECTION):
// a batch either finishes or is refused with 503 and nothing written, never a
// 500 with a timed-out rollback.
const assert = require('node:assert/strict');
const { Client } = require('pg');
const crudHTTP = require('./fixtures/entries-crud-http');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const { DATA_CONNECTION } = require('../lib/server/serve/preview-api');
const { optInSuite } = require('./support/opt-in');

const STEP = 300000;
function batch (anchor, count, offset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const date = anchor - (offset + index) * STEP;
    return { type: 'sgv', device: 'synthetic-batch', direction: 'Flat', sgv: 100 + index % 50, date,
      dateString: new Date(date).toISOString() };
  });
}

optInSuite(process.env.NS_ENTRIES_CRUD_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_ENTRIES_CRUD_HTTP_TEST=1 with disposable PostgreSQL and MongoDB')(
  'API v1 entries batch deadlines on PostgreSQL', function () {
    this.timeout(60000);
    const lab = crudHTTP({ legacy: true, pool: { ...DATA_CONNECTION } });
    before(() => lab.open());
    beforeEach(() => lab.seed([]));
    after(() => lab.close());

    async function stored (tenant, device = 'synthetic-batch') {
      return Number((await lab.admin.query(`SELECT count(*) AS n FROM "${lab.name}".entries
        WHERE tenant_id = $1 AND doc->>'device' = $2`, [tenant, device])).rows[0].n);
    }
    async function settled () {
      // The evicted backend ends once its blocked statement returns.
      for (let attempt = 0; attempt < 50; attempt++) {
        const busy = (await lab.admin.query(`SELECT count(*) AS n FROM pg_stat_activity
          WHERE usename = $1 AND state <> 'idle'`, [lab.name + '_app'])).rows[0].n;
        if (Number(busy) === 0) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail('application backends did not settle');
    }

    it('refuses a batch whose statement misses the local deadline with 503, writes nothing and recovers', async function () {
      // A competing transaction holds the tenant's write clock row longer than
      // the 1 s query deadline plus a queued ROLLBACK's own 1 s deadline.
      const holder = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI });
      await holder.connect();
      const docs = batch(Date.now() - 60000, 3);
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM "${lab.name}_clock".tenant_write_clock WHERE tenant_id = $1 FOR UPDATE`, [lab.A]);
        const started = Date.now();
        const reply = await lab.legacyHttp('post', '/api/v1/entries').send(docs);
        const elapsed = Date.now() - started;
        assert.equal(reply.status, 503, 'REFUSED_NOT_500 ' + reply.text);
        assert.deepEqual(reply.body, { error: 'STORAGE_TIMEOUT' });
        assert.equal(reply.headers['retry-after'], '1');
        assert(elapsed < 2000, 'answered at the first deadline, not after a queued ROLLBACK (' + elapsed + ' ms)');
        await new Promise(resolve => setTimeout(resolve, 2500 - elapsed));
      } finally {
        await holder.query('COMMIT');
        await holder.end();
      }
      await settled();
      assert.equal(await stored(lab.A), 0, 'NOTHING_COMMITTED');
      const retry = await lab.legacyHttp('post', '/api/v1/entries').send(docs).expect(200);
      assert.equal(retry.body.length, 3);
      assert.equal(await stored(lab.A), 3, 'POOL_USABLE_AFTER_EVICTION');
    });

    it('finishes a day batch for a tenant that already holds a few thousand entries', async function () {
      const anchor = Date.now() - 60000;
      // 3,600 stored entries (12.5 days of 5-minute SGV), written directly.
      const old = batch(anchor - 400 * STEP, 3600).map(doc => encodeDocument({ ...doc, device: 'synthetic-stored',
        sysTime: doc.dateString, utcOffset: 0, _id: require('mongodb').ObjectId.createFromTime(Math.floor(doc.date / 1000)) }));
      await require('./fixtures/tenant-insertion-grants').withTenant(lab.admin, lab.A, () => lab.admin.query(
        `INSERT INTO "${lab.name}".entries (tenant_id, id_kind, doc)
         SELECT $1, kind, doc FROM unnest($2::text[], $3::jsonb[]) AS row(kind, doc)`,
        [lab.A, old.map(row => row.id_kind), old.map(row => JSON.stringify(row.doc))]));
      await lab.admin.query(`ANALYZE "${lab.name}".entries`);
      assert.equal(await stored(lab.A, 'synthetic-stored'), 3600);
      const jit = (await lab.admin.query('SELECT pg_jit_available() AS on')).rows[0].on;
      if (!jit) console.log('JIT_UNAVAILABLE: the JIT cost cliff is not exercised on this server');
      const reply = await lab.legacyHttp('post', '/api/v1/entries').send(batch(anchor, 288));
      assert.equal(reply.status, 200, 'DAY_BATCH_FINISHES ' + reply.text);
      assert.equal(await stored(lab.A), 288);
    });
  });
