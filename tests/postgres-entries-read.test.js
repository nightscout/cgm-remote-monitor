'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const readOperation = require('../lib/api3/generic/read/operation');
const FieldsProjector = require('../lib/api3/shared/fieldsProjector');
const { and, or, cmp } = require('../lib/storage/filter');
const connect = require('../lib/storage/postgres-connection');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const entriesRead = require('../lib/storage/postgres-entries-read');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

// Differential: the same documents in a scratch mongod collection (read through
// the real API v3 storage) and in tenant A of the generated typed-identity
// entries candidate (tests/fixtures/postgres/entries-identity-kinds.sql, a
// verbatim copy of the emitter's --identity-kinds output), read through the
// actual tenant-bound connection as a SELECT-only NOSUPERUSER NOBYPASSRLS role.
// Tenant B holds overlapping ids with different values, so a leak changes an
// answer. Requires both disposable databases; skipped (not passed) otherwise.
const pgURI = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const mongoURI = process.env.CUSTOMCONNSTR_mongo;
const suite = optInSuite(pgURI && mongoURI, 'NS_TEST_POSTGRES_ADMIN_URI and CUSTOMCONNSTR_mongo');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const H1 = '65a1b2c3d4e5f60718293a4b';
const H2 = '65a1b2c3d4e5f60718293a4c';
const H3 = '0123456789abcdef01234567';

function documents () {
  return [
    { _id: new ObjectId(H1), identifier: 'id-a', type: 'sgv', sgv: 100, date: 1000, dateString: '2026-11-02T00:00:00Z' },
    { _id: H1, type: 'sgv', sgv: 101, date: 1001 },
    { _id: new ObjectId(H2), identifier: null, type: 'sgv', sgv: '120', date: 1002 },
    { _id: new ObjectId(H3), identifier: 'id-a', sgv: 99, date: 999 },
    { _id: 'uuid-1', identifier: '', type: 'mbg', sgv: null, date: 1003 },
    { _id: 'uuid-2', type: 'cal', date: 1004 },
    { _id: 'Z-upper', type: 'sgv', sgv: [1, 200], date: 1005 },
    { _id: 'a-lower', sgv: [null, 5], date: 1006 },
    { _id: '\u00e9-accent', sgv: {}, date: 1007 },
    { _id: 'b-bool', sgv: true, date: 1008, isValid: false },
    { _id: 'c-bool', sgv: false, date: 1009, isValid: true },
    { _id: 'd-frac', sgv: -0.5, date: 1010.5, dateString: 'Z' },
    { _id: 'e-str', sgv: 'Loop', date: 'not-a-number', dateString: 'a' },
    { _id: 'f-nested', sgv: [[100]], date: 1011, dateString: '\u00e9' },
    { _id: 'g-nodate', sgv: 7 },
    { _id: 'h-nulldate', sgv: 8, date: null },
    { _id: 'invalid-numeric', sgv: 150, date: 1012, isValid: false }
  ];
}

suite('PostgreSQL entries read matches mongod (requires NS_TEST_POSTGRES_ADMIN_URI and CUSTOMCONNSTR_mongo)', function () {
  this.timeout(30000);
  const name = 'ns_read_' + randomUUID().replace(/-/g, '');
  const role = name + '_app';
  const table = name + '.entries';
  let admin, store, mongo, mongoStore, reader, mode;

  before(async function () {
    mode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    admin = new Client({ connectionString: pgURI });
    await admin.connect();
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE SCHEMA "${name}"`);
    await admin.query(`SET search_path TO "${name}"`);
    await admin.query(fs.readFileSync(path.join(__dirname, 'fixtures/postgres/entries-identity-kinds.sql'), 'utf8'));
    await admin.query(`GRANT USAGE ON SCHEMA "${name}" TO "${role}"`);
    await admin.query(`GRANT SELECT ON "${name}".entries TO "${role}"`);
    for (const [tenant, docs] of [[A, documents()], [B, documents().map(doc =>
      ({ ...doc, sgv: typeof doc.sgv === 'number' ? doc.sgv + 1000 : 'tenant-b' }))
      .concat([{ _id: 'only-b', identifier: 'id-a', sgv: 100, date: 1000 }])]]) {
      for (const doc of docs) {
        const row = encodeDocument(doc);
        await admin.query('INSERT INTO entries (tenant_id, id_kind, doc) VALUES ($1, $2, $3)', [tenant, row.id_kind, row.doc]);
      }
    }
    const url = new URL(pgURI);
    url.username = role;
    url.password = password;
    store = await connect({ connectionString: url.toString(), max: 2 });
    reader = entriesRead({ connection: store, table });

    mongo = new MongoClient(mongoURI);
    await mongo.connect();
    const db = mongo.db();
    await db.collection(name).insertMany(documents());
    mongoStore = new MongoCollection({ store: { collection: n => db.collection(n), db }, bus: new EventEmitter() },
      { writeValidation: 'off' }, name, 'entries', []);
  });

  after(async function () {
    try {
      if (mongo) {
        try { await mongo.db().collection(name).drop(); } finally { await mongo.close(); }
      }
      if (store) await store.end();
      if (admin) {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
        } finally {
          await admin.end();
        }
      }
    } finally {
      if (mode !== undefined) scope.setTenancyMode(mode);
    }
  });

  const inA = fn => store.withTenant(A, fn);
  // MongoDB has no tenant column: its scratch collection holds only tenant A.
  const mongoA = (method, ...args) => scope.withTenant(A, () => mongoStore[method](...args));
  const raw = { sort: { _id: 1 }, options: { normalize: false } };

  async function same (method, ...args) {
    const expected = await mongoA(method, ...args);
    const actual = await inA(() => reader[method](...args));
    assert.deepStrictEqual(actual, expected, `${method} ${JSON.stringify(args)}`);
    return actual;
  }

  async function sameFindMany (args) {
    const expected = await mongoA('findMany', args);
    const actual = await inA(() => reader.findMany(args));
    assert.deepStrictEqual(actual, expected, `findMany ${JSON.stringify(args)}`);
    return actual;
  }

  const filters = [
    and(),
    ...['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].flatMap(op =>
      [100, 5, '120', 'Loop', null, true, false, -0.5].map(value => cmp(op, 'sgv', value))),
    cmp('in', 'sgv', [100, null]), cmp('in', 'sgv', []), cmp('in', 'sgv', ['Loop', true, 200]),
    cmp('nin', 'sgv', [100]), cmp('nin', 'sgv', []), cmp('nin', 'sgv', [null, 5]),
    cmp('exists', 'sgv', true), cmp('exists', 'sgv', false), cmp('exists', 'date', false),
    ...['string', 2, 'number', 'bool', 8, 'null', 10].map(value => cmp('type', 'sgv', value)),
    cmp('nottype', 'sgv', 'array'),
    and(cmp('in', 'identifier', [null, '']), cmp('nottype', 'identifier', 'array')),
    or(cmp('eq', 'sgv', 100), cmp('exists', 'sgv', false)),
    and(cmp('gte', 'date', 1001), cmp('lt', 'date', 1009), or(cmp('eq', 'type', 'sgv'), cmp('eq', 'type', 'mbg'))),
    cmp('gte', 'dateString', 'a'), cmp('lt', 'dateString', '\u00e9'), cmp('gt', 'dateString', 'Z'),
    cmp('eq', 'identifier', 'id-a'), cmp('ne', 'identifier', null), cmp('eq', 'isValid', false), cmp('ne', 'isValid', false),
    cmp('eq', '_id', new ObjectId(H1)), cmp('eq', '_id', H1), cmp('in', '_id', [new ObjectId(H1), H1, 'uuid-1']),
    cmp('ne', '_id', new ObjectId(H1)), cmp('nin', '_id', [H1, 'b-bool']), cmp('gt', '_id', 'b'),
    cmp('gte', '_id', new ObjectId(H2)), cmp('lt', '_id', new ObjectId(H2)), cmp('lte', '_id', 'zzz'),
    cmp('eq', '_id', 5), cmp('eq', '_id', null), cmp('ne', '_id', null), cmp('lte', '_id', null),
    cmp('exists', '_id', true), cmp('exists', '_id', false)
  ];

  it('selects and counts what mongod selects for every supported filter', async function () {
    let nonEmpty = 0;
    for (const ast of filters) {
      if ((await same('findFiltered', ast, raw)).length) nonEmpty++;
      await same('count', ast);
    }
    assert.ok(nonEmpty > filters.length / 2, 'the matrix exercises matches, not only empty answers');
  });

  it('matches API3 findMany filters, validity, projection, ordering and pagination', async function () {
    const page = await sameFindMany({
      filter: [{ field: 'sgv', operator: 'gte', value: 100 }],
      sort: { date: 1, _id: 1 },
      limit: 2,
      skip: 1,
      projection: { sgv: 1, date: 1, identifier: 1 },
      onlyValid: true
    });
    assert.equal(page.length, 2);
    assert.ok(!page.some(doc => doc.identifier === 'invalid-numeric'));
    assert.ok(page.some(doc => doc.identifier === 'Z-upper'));

    const includingInvalid = await sameFindMany({
      filter: [{ field: 'sgv', operator: 'gte', value: 100 }],
      sort: { date: 1, _id: 1 },
      limit: 20,
      skip: 0,
      onlyValid: false
    });
    assert.ok(includingInvalid.some(doc => doc.identifier === 'invalid-numeric'));

    const nullAndMissing = await sameFindMany({
      filter: [{ field: 'sgv', operator: 'eq', value: null }],
      sort: { _id: 1 },
      limit: 20,
      skip: 0,
      onlyValid: false,
      options: { normalize: false }
    });
    assert.ok(nullAndMissing.some(doc => doc._id === 'uuid-1'));
    assert.ok(nullAndMissing.some(doc => doc._id === 'uuid-2'));
    assert.ok(nullAndMissing.some(doc => doc._id === 'a-lower'));

    const stringBracket = await sameFindMany({
      filter: [{ field: 'sgv', operator: 'eq', value: '120' }],
      sort: { _id: 1 },
      limit: 20,
      skip: 0,
      onlyValid: false,
      options: { normalize: false }
    });
    assert.deepEqual(stringBracket.map(doc => doc._id.toHexString()), [H2]);

    const inValues = await sameFindMany({
      filter: [{ field: 'type', operator: 'in', value: 'sgv|mbg' }],
      sort: { date: -1, _id: -1 },
      limit: 3,
      skip: 2,
      projection: { type: 1, date: 1 },
      onlyValid: true
    });
    assert.equal(inValues.length, 3);

    await assert.rejects(inA(() => reader.findMany({
      filter: [{ field: 'sgv', operator: 're', value: '.*' }],
      sort: { _id: 1 },
      limit: 1,
      skip: 0
    })), error => error.unsupported === true);
    await assert.rejects(inA(() => reader.findMany({
      filter: [{ field: '__proto__', operator: 'eq', value: 'unmatched' }],
      sort: { _id: 1 },
      limit: 1,
      skip: 0
    })), error => error.unsupported === true);
    await assert.rejects(inA(() => reader.findMany({
      filter: [],
      limit: 1,
      skip: 0
    })), /unsupported findMany sort/);
  });

  it('orders across type brackets and both _id kinds, with skip and limit', async function () {
    const scalars = cmp('nin', '_id', ['Z-upper', 'a-lower', '\u00e9-accent', 'f-nested']);
    for (const sort of [{ date: 1, _id: 1 }, { date: -1, _id: -1 }, { sgv: 1, _id: 1 }, { sgv: -1, _id: 1 },
      { dateString: 1, _id: -1 }, { isValid: -1, _id: 1 }, { _id: -1 }]) {
      await same('findFiltered', scalars, { sort, options: { normalize: false } });
      await same('findFiltered', scalars, { sort, skip: 2, limit: 3, options: { normalize: false } });
      await same('findFiltered', scalars, { sort, skip: '1', limit: '4' });
      await same('findFiltered', scalars, { sort, limit: 0 });
      await same('findFiltered', scalars, { sort, skip: 100, limit: 1 });
    }
  });

  it('refuses a sort over arrays or subdocuments that mongod would order by its own rules', async function () {
    const opts = { sort: { sgv: 1, _id: 1 }, limit: 1, options: { normalize: false } };
    assert.equal((await mongoA('findFiltered', and(), opts)).length, 1);
    await assert.rejects(inA(() => reader.findFiltered(and(), opts)), error => error.unsupported === true);
    // Refused even when the page itself would hold no array: the order depends on it.
    // MongoDB orders [1, 200] ascending by its least element, before 7.
    const page = cmp('in', '_id', ['g-nodate', 'Z-upper']);
    const second = { ...opts, skip: 1 };
    assert.deepEqual((await mongoA('findFiltered', page, second)).map(doc => doc._id), ['g-nodate']);
    await assert.rejects(inA(() => reader.findFiltered(page, second)), /sort over an array or subdocument/);
  });

  it('finds one record by identifier as API v3 does, normalized and raw', async function () {
    for (const identifier of ['id-a', H1, H1.toUpperCase(), H2, H3, 'uuid-1', 'uuid-2', 'missing', '']) {
      for (const options of [undefined, { normalize: false }]) {
        await same('findOne', identifier, undefined, options);
        await same('findOne', identifier, {}, options);
      }
    }
    const [doc] = await inA(() => reader.findOne(H1, undefined, { normalize: false }));
    assert.ok(doc._id instanceof ObjectId, 'the ObjectId copy, not its same-spelling string');
  });

  it('normalizes listed documents as find.js does', async function () {
    await same('findFiltered', and(), { sort: { _id: 1 } });
  });

  it('serves projected and conditional entry reads through the API3 handler', async function () {
    const doc = {
      _id: 'handler-entry',
      identifier: 'handler-entry',
      sgv: 123,
      uploader: { battery: 80, type: 'phone', radios: [{ id: 'loop', signal: 4 }, { id: 'pump', signal: 8 }] },
      srvCreated: 1700000000000,
      srvModified: 1700000000000
    };
    await mongo.db().collection(name).insertOne(doc);
    const row = encodeDocument(doc);
    await admin.query(
      'INSERT INTO "' + name + '".entries (tenant_id, id_kind, doc) VALUES ($1, $2, $3)',
      [A, row.id_kind, row.doc]
    );

    function response () {
      return {
        headers: {},
        statusCode: 200,
        headersSent: false,
        setHeader (key, value) { this.headers[key] = value; return this; },
        status (code) { this.statusCode = code; return this; },
        format (formats) { formats.json(); return this; },
        json (body) { this.body = body; this.headersSent = true; return this; },
        send (body) { this.body = body; this.headersSent = true; return this; },
        end () { this.headersSent = true; return this; }
      };
    }

    async function readWithHandler (fields, ifModifiedSince) {
      const req = {
        query: { fields },
        params: { identifier: doc.identifier },
        get: name => name === 'If-Modified-Since' ? ifModifiedSince : undefined
      };
      const res = response();
      const app = { get: () => false };
      const col = {
        colName: 'entries',
        storage: reader,
        resolveDates: stored => new Date(stored.srvModified)
      };
      const operation = readOperation({}, { apiV3DataWarnings: false }, app, col);
      await inA(() => operation(req, res));
      return res;
    }

    const projected = await readWithHandler('uploader.battery');
    assert.equal(projected.statusCode, 200);
    assert.deepEqual(projected.body.result, { uploader: { battery: 80 } });
    assert.equal(projected.headers['Last-Modified'], new Date(doc.srvModified).toUTCString());
    await same('findOne', doc.identifier, new FieldsProjector('uploader.battery').storageProjection());

    for (const fields of ['uploader.radios.id', 'uploader.missing']) {
      const actual = await inA(() => reader.findOne(doc.identifier,
        new FieldsProjector(fields).storageProjection()));
      const expected = await mongoA('findOne', doc.identifier,
        new FieldsProjector(fields).storageProjection());
      assert.deepStrictEqual(actual, expected, `projected ${fields}`);
    }

    for (const fields of ['_id', '_id,uploader.battery']) {
      const projection = new FieldsProjector(fields).storageProjection();
      const actual = await inA(() => reader.findOne(doc.identifier, projection, { normalize: false }));
      const expected = await mongoA('findOne', doc.identifier, projection, { normalize: false });
      assert.deepStrictEqual(actual, expected, `projected ${fields}`);
    }

    const unchanged = await readWithHandler('sgv',
      new Date(Math.ceil(doc.srvModified / 1000) * 1000).toUTCString());
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, undefined);
  });

  it('reads only the bound tenant and refuses an unbound read', async function () {
    const b = await store.withTenant(B, () => reader.findFiltered(cmp('eq', 'identifier', 'id-a'), raw));
    assert.deepEqual(b.map(doc => [String(doc._id), doc.sgv]), [['only-b', 100], [H3, 1099], [H1, 1100]]);
    assert.equal(await store.withTenant(B, () => reader.count(and())), documents().length + 1);
    await assert.rejects(reader.count(and()), /tenant/i);
  });
});
