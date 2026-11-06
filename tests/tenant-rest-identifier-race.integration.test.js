'use strict';

const assert = require('node:assert/strict');
const crudHTTP = require('./fixtures/entries-crud-http');
const raceGate = require('./fixtures/entries-identifier-race');
const identifierIndex = require('../lib/storage/identifier-index');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const { optInSuite } = require('./support/opt-in');

const BASE = 1793664000123;
const modes = ['replace', 'merge-except-treatments', 'acknowledge', 'refuse'];
const first = identifier => ({ identifier, date: BASE, utcOffset: 0, type: 'sgv', sgv: 101,
  device: 'synthetic-race', app: 'synthetic-race', retained: true,
  nested: { retained: false, removed: 1 } });
const second = identifier => ({ identifier, date: BASE, utcOffset: 0, type: 'sgv', sgv: 160,
  device: 'synthetic-race', app: 'synthetic-race', nested: { removed: null, added: 0 } });
const logicalFields = doc => Object.fromEntries(Object.entries(doc)
  .filter(([key]) => !['_id', 'srvCreated', 'srvModified', 'lastModified'].includes(key)));

optInSuite(process.env.NS_ENTRIES_CRUD_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_ENTRIES_CRUD_HTTP_TEST=1 with disposable PostgreSQL and MongoDB')(
  'API3 identifier index-on forced HTTP race differential', function () {
    this.timeout(30000);
    const lab = crudHTTP();
    before(async () => {
      await lab.open();
      await lab.mongoCollection.createIndex({ identifier: 1 }, identifierIndex.indexOptions());
      assert.equal((await identifierIndex.existingIndex(lab.mongoCollection)).unique, true);
      const index = await lab.admin.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'identifier_unique'`, [lab.name]);
      assert.equal(index.rows.length, 1);
      assert.match(index.rows[0].indexdef, /CREATE UNIQUE INDEX.*tenant_id.*identifier/);
    });
    after(() => lab.close());

    for (const mode of modes) {
      it('index-on ' + mode + ' settles a real duplicate race without hiding stored outcomes', async function () {
        const identifier = 'synthetic-race-' + mode;
        await lab.seed([]);
        const foreign = encodeDocument({ _id: 'foreign-same-id', ...first(identifier), sgv: 902 });
        await lab.admin.query(`INSERT INTO ${lab.table} (tenant_id,id_kind,doc) VALUES ($1,$2,$3)`,
          [lab.B, foreign.id_kind, foreign.doc]);
        const foreignBefore = await lab.rows(lab.B);
        const observed = {};

        for (const backend of ['mongo', 'pg']) {
          const gate = raceGate(lab, backend, mode);
          const http = (method, path, worker) => backend === 'mongo'
            ? lab.reference(method, path) : lab.http(method, path, { worker });
          let pendingFirst, pendingSecond;
          try {
            pendingFirst = http('post', '/entries', 0).send(first(identifier)).then(response => response);
            await gate.arrived(1);
            pendingSecond = http('post', '/entries', 1).send(second(identifier)).then(response => response);
            await gate.arrived(2);
            gate.release(0);
            const created = await pendingFirst;
            assert.equal(created.status, 201, 'first upload must commit before releasing the competing INSERT');
            const firstRows = backend === 'mongo'
              ? (await lab.mongoCollection.find({}).toArray()).map(encodeDocument)
              : (await lab.admin.query(`SELECT id_kind,doc FROM ${lab.table} WHERE tenant_id=$1`, [lab.A])).rows;
            assert.equal(firstRows.length, 1);
            assert.equal(firstRows[0].doc.sgv, 101);
            assert.equal(created.body.lastModified, firstRows[0].doc.srvModified);
            gate.release(1);
            const resent = await pendingSecond;
            assert.equal(resent.status, mode === 'refuse' ? 409 : 200, 'loser must follow the configured resend contract');
            assert.equal(gate.inserts, 2, 'retry must edit or settle the winning record rather than insert again');
            assert.deepEqual(gate.duplicateCodes, [backend === 'mongo' ? 11000 : '23505'], 'real unique-index duplicate must be observed');
            const rows = backend === 'mongo'
              ? (await lab.mongoCollection.find({}).toArray()).map(encodeDocument)
              : (await lab.admin.query(`SELECT id_kind,doc FROM ${lab.table} WHERE tenant_id=$1`, [lab.A])).rows;
            assert.equal(rows.length, 1, 'both replies must refer to one committed record');
            assert.equal(rows[0].id_kind, 'objectid');
            assert.equal(rows[0].doc._id, firstRows[0].doc._id, 'loser must retain the winner storage identity');
            assert.equal(rows[0].doc.srvCreated, firstRows[0].doc.srvCreated);
            const writes = mode === 'replace' || mode === 'merge-except-treatments';
            assert.equal(rows[0].doc.sgv, writes ? 160 : 101);
            if (writes) {
              assert.ok(rows[0].doc.srvModified > firstRows[0].doc.srvModified);
              assert.equal(resent.body.lastModified, rows[0].doc.srvModified);
              assert.equal(resent.body.isDeduplication, true);
              assert.deepEqual(rows[0].doc.nested, mode === 'replace'
                ? { removed: null, added: 0 } : { retained: false, added: 0 });
              assert.equal(Object.hasOwn(rows[0].doc, 'retained'), mode === 'merge-except-treatments');
            } else {
              assert.deepEqual(rows, firstRows, 'acknowledge/refuse must leave all stored values and clocks unchanged');
            }
            assert.deepEqual(await lab.rows(lab.B), foreignBefore, 'same identifier in another tenant must remain untouched');

            const beforeRefusal = JSON.stringify(rows);
            if (backend === 'mongo') lab.mongoGrants = ['api:entries:read'];
            else await lab.grants(['api:entries:read']);
            await http('post', '/entries', 0).send({ ...second(identifier), sgv: 199 }).expect(403);
            const afterRefusal = backend === 'mongo'
              ? (await lab.mongoCollection.find({}).toArray()).map(encodeDocument)
              : (await lab.admin.query(`SELECT id_kind,doc FROM ${lab.table} WHERE tenant_id=$1`, [lab.A])).rows;
            assert.equal(JSON.stringify(afterRefusal), beforeRefusal, 'current authority refusal must precede mutation');
            observed[backend] = { replies: [created, resent].map(response => ({
              status: response.status, body: logicalFields(response.body), location: response.headers.location
            })), document: logicalFields(rows[0].doc), idKind: rows[0].id_kind };
          } finally {
            gate.restore();
            await Promise.allSettled([pendingFirst, pendingSecond].filter(Boolean));
            lab.mongoGrants = lab.GRANTS;
            await lab.grants(lab.GRANTS);
          }
        }
        assert.deepEqual(observed.pg, observed.mongo, 'admitted replies and committed fields must match across actual backends');
      });
    }
  });
