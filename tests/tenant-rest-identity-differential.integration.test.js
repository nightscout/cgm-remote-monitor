'use strict';

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const crudHTTP = require('./fixtures/entries-crud-http');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const { optInSuite } = require('./support/opt-in');

const BASE = 1793664000123;
const HEX = '65a1b2c3d4e5f60718293a4b';
const kinds = [
  ['ObjectId', () => new ObjectId(HEX), HEX, 'objectid'],
  ['hex string', () => HEX, HEX, 'string'],
  ['custom string', () => 'synthetic-imported-entry', 'synthetic-imported-entry', 'string']
];
const identifiers = [['absent', undefined], ['null', null], ['empty', ''], ['false', false], ['zero', 0]];

// Clocks are independently allocated by the shipping write paths. Keep identity
// and every other stored field in the comparison, and assert each clock against
// its own persisted outcome below rather than treating it as semantic equality.
function withoutAllocatedClocks (value) {
  if (Array.isArray(value)) return value.map(withoutAllocatedClocks);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['srvModified', 'lastModified'].includes(key))
    .map(([key, item]) => [key, withoutAllocatedClocks(item)]));
}

optInSuite(process.env.NS_ENTRIES_CRUD_HTTP_TEST === '1' &&
  !!process.env.NS_TEST_POSTGRES_ADMIN_URI && !!process.env.CUSTOMCONNSTR_mongo,
'NS_ENTRIES_CRUD_HTTP_TEST=1 with disposable PostgreSQL and MongoDB')(
  'API3 imported identity fallback actual HTTP differential', function () {
    this.timeout(30000);
    const lab = crudHTTP();
    before(() => lab.open());
    after(() => lab.close());

    async function stored () {
      const pg = (await lab.admin.query(`SELECT id_kind, doc FROM ${lab.table} WHERE tenant_id = $1`, [lab.A])).rows;
      const mongo = (await lab.mongoCollection.find({}).toArray()).map(encodeDocument);
      assert.deepEqual(withoutAllocatedClocks(pg), withoutAllocatedClocks(mongo), 'raw identities and stored fields');
      return { pg, mongo };
    }

    async function same (method, shown, status, body) {
      const path = '/entries/' + shown;
      let expected = lab.reference(method, path);
      let actual = lab.http(method, path, { worker: 1 });
      if (body !== undefined) { expected = expected.send(body); actual = actual.send(body); }
      const reference = await expected.expect(status);
      const candidate = await actual.expect(status);
      assert.deepEqual(withoutAllocatedClocks(candidate.body), withoutAllocatedClocks(reference.body), 'HTTP reply');
      const state = await stored();
      for (const [response, rows] of [[reference, state.mongo], [candidate, state.pg]]) {
        if (response.body.result && !Array.isArray(response.body.result)) {
          assert.equal(response.body.result.identifier, shown);
          assert.equal(response.body.result.srvModified, rows[0].doc.srvModified);
        }
        if (response.body.lastModified !== undefined) {
          assert.equal(response.body.lastModified, rows[0].doc.srvModified);
        }
      }
      return state;
    }

    for (const [kind, makeID, shown, storedKind] of kinds) {
      for (const [label, identifier] of identifiers) {
        it('identity fallback ' + kind + ' with ' + label + ' identifier survives read, patch, replace and delete', async function () {
          const doc = { _id: makeID(), date: BASE, utcOffset: 0, type: 'sgv', sgv: 123,
            app: 'synthetic', srvCreated: BASE, srvModified: BASE, retained: true,
            ...(identifier === undefined ? {} : { identifier }) };
          await lab.seed([doc]);
          const foreign = await lab.rows(lab.B);
          await same('get', shown, 200);

          const patched = await same('patch', shown, 200, { sgv: 124, extension: { value: false } });
          assert.equal(patched.pg.length, 1, 'PATCH must edit the imported record, not create another');
          assert.equal(patched.pg[0].id_kind, storedKind);
          assert.equal(patched.pg[0].doc._id, shown);
          assert.equal(patched.pg[0].doc.sgv, 124);
          assert.equal(Object.hasOwn(patched.pg[0].doc, 'identifier'), identifier !== undefined);
          if (identifier !== undefined) assert.equal(patched.pg[0].doc.identifier, identifier);
          assert.equal(patched.pg[0].doc.srvCreated, BASE);
          assert.ok(patched.pg[0].doc.srvModified > BASE);
          await same('get', shown, 200);

          const replaced = await same('put', shown, 200, {
            date: BASE, utcOffset: 0, type: 'sgv', sgv: 125, app: 'synthetic', replacement: true
          });
          assert.equal(replaced.pg.length, 1, 'PUT must replace the imported record, not insert a second identity');
          assert.equal(replaced.pg[0].id_kind, storedKind);
          assert.equal(replaced.pg[0].doc._id, shown);
          assert.equal(replaced.pg[0].doc.identifier, shown);
          assert.equal(replaced.pg[0].doc.sgv, 125);
          assert.equal(Object.hasOwn(replaced.pg[0].doc, 'retained'), false);
          assert.equal(Object.hasOwn(replaced.pg[0].doc, 'extension'), false);
          assert.equal(replaced.pg[0].doc.srvCreated, BASE);
          await same('get', shown, 200);

          const deleted = await same('delete', shown, 200);
          assert.equal(deleted.pg[0].id_kind, storedKind);
          assert.equal(deleted.pg[0].doc.isValid, false);
          await same('get', shown, 410);
          const removed = await same('delete', shown + '?permanent=true', 200);
          assert.deepEqual(removed.pg, []);
          await same('get', shown, 404);
          assert.deepEqual(await lab.rows(lab.B), foreign, 'foreign tenant same identity must remain untouched');
        });
      }
    }
  });
