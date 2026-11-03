'use strict';

const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const { and, cmp } = require('../lib/storage/filter');
const connect = require('../lib/storage/postgres-connection');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const entriesRead = require('../lib/storage/postgres-entries-read');
const entriesWrite = require('../lib/storage/postgres-entries-write');
const entriesIntent = require('../lib/storage/postgres-entries-intent');
const intentStep = require('../lib/storage/write-intent');
const srvDates = require('../lib/server/srv-dates');
const scope = require('../lib/storage/tenant-scope');

describe('PostgreSQL entries write refusals', function () {
  it('accepts and serializes JSON-safe nested entry values', async function () {
    const calls = [];
    const connection = {
      async query (sql, values) { calls.push({ sql, values }); return { rowCount: 1 }; },
      async withSavepoint (operation) { return operation(); }
    };
    const writer = entriesWrite({ connection });
    const doc = { _id: 'nested', metadata: { source: 'import', values: [1, null, { ok: true }] } };

    await writer.insertOne(doc, { normalize: false });

    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].values[1]), doc);
  });

  it('refuses lossy or ambiguous input before sending SQL', async function () {
    let queries = 0;
    const writer = entriesWrite({ connection: { query () { queries++; throw new Error('unexpected query'); } } });
    const bad = error => error.unsupported === true;
    for (const value of [undefined, NaN, Infinity, -0, new Date(), new ObjectId(), /x/, Buffer.from('x')]) {
      await assert.rejects(writer.insertOne({ _id: 'bad', sgv: value }), bad);
      await assert.rejects(writer.updateOne('bad', { sgv: value }), bad);
    }
    for (const value of [{ nested: new Date() }, [new ObjectId()], { nested: undefined }]) {
      await assert.rejects(writer.insertOne({ _id: 'bad', sgv: value }), bad);
      await assert.rejects(writer.updateOne('bad', { sgv: value }), bad);
    }
    for (const field of ['a.b', '$inc', '_id', 'a\0b']) {
      await assert.rejects(writer.updateOne('bad', { [field]: 1 }), bad);
      await assert.rejects(writer.updateOne('bad', {}, { [field]: 1 }), bad);
    }
    await assert.rejects(writer.updateOne('bad', { sgv: 1 }, { sgv: 1 }), bad);
    await assert.rejects(writer.insertOne({ _id: 'bad', [Symbol('hidden')]: 1 }), bad);
    await assert.rejects(writer.updateMany(and(), { set: { sgv: 1 } }, { v1: true }), bad);
    await assert.rejects(writer.deleteMany(and(), { one: true }), bad);
    await assert.rejects(writer.deleteMany(null), /filter node/);
    await assert.rejects(writer.updateMany(and(), {}), /non-empty/);
    await assert.rejects(writer.insertOne({ _id: 'bad' }, { ordered: false }), bad);
    await assert.rejects(writer.bulkUpsert([{ filter: and(), doc: { nested: { date: new Date() } } }]), bad);
    await assert.rejects(writer.bulkUpsert([{ filter: and(), doc: { sgv: 1 }, setOnInsert: { sgv: 2 } }], { mode: 'merge' }), bad);
    await assert.rejects(writer.bulkUpsert([], { v1: true }), bad);
    await assert.rejects(writer.replaceFiltered(and(), { _id: 'bad', nested: { objectId: new ObjectId() } }), bad);
    await assert.rejects(writer.resolveEveryForm('id', 1001), bad);
    await assert.rejects(writer.resolveOr([], 1001), bad);
    await assert.rejects(writer.findByIds(Array.from({ length: 1001 }, (_, index) => 'id-' + index)), bad);
    assert.equal(queries, 0);
  });
});

const pgURI = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const mongoURI = process.env.CUSTOMCONNSTR_mongo;
const suite = pgURI && mongoURI ? describe : describe.skip;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '65a1b2c3d4e5f60718293a4b';

function documents () {
  return [
    { _id: new ObjectId(HEX), sgv: 100, retained: 'objectid' },
    { _id: HEX, sgv: 101, retained: 'string' },
    { _id: 'v3', identifier: HEX, sgv: 102, retained: 'v3' },
    { _id: 'custom', identifier: 'named', sgv: 103, obsolete: true },
    { _id: 'null', sgv: null, nested: { retained: [1, 2] } }
  ];
}

suite('PostgreSQL entries write differential (requires disposable PostgreSQL and MongoDB)', function () {
  this.timeout(30000);
  const name = 'ns_write_' + randomUUID().replace(/-/g, '');
  const role = name + '_app';
  const table = name + '.entries';
  let admin, store, mongo, mongoStore, reader, writer, mode;
  const inA = fn => store.withTenant(A, fn);
  const mongoA = (method, ...args) => scope.withTenant(A, () => mongoStore[method](...args));
  const raw = { sort: { _id: 1 }, options: { normalize: false } };

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
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${name}".entries TO "${role}"`);
    const url = new URL(pgURI);
    url.username = role;
    url.password = password;
    store = await connect({ connectionString: url.toString(), max: 2 });
    reader = entriesRead({ connection: store, table });
    writer = entriesWrite({ connection: store, table });
    mongo = new MongoClient(mongoURI);
    await mongo.connect();
    const db = mongo.db();
    mongoStore = new MongoCollection({ store: { collection: n => db.collection(n), db }, bus: new EventEmitter() },
      { writeValidation: 'off' }, name, 'entries', []);
  });

  beforeEach(async function () {
    await admin.query(`DELETE FROM "${name}".entries`);
    for (const [tenant, docs] of [[A, documents()], [B, documents().map(doc => ({ ...doc, sgv: 900 }))]]) {
      for (const doc of docs) {
        const row = encodeDocument(doc);
        await admin.query(`INSERT INTO "${name}".entries (tenant_id, id_kind, doc) VALUES ($1, $2, $3)`,
          [tenant, row.id_kind, row.doc]);
      }
    }
    await mongo.db().collection(name).deleteMany({});
    await mongo.db().collection(name).insertMany(documents());
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
        } finally { await admin.end(); }
      }
    } finally { if (mode !== undefined) scope.setTenancyMode(mode); }
  });

  async function sameStored () {
    assert.deepEqual(await inA(() => reader.findFiltered(and(), raw)), await mongoA('findFiltered', and(), raw));
    const b = await store.withTenant(B, () => reader.findFiltered(and(), raw));
    assert.equal(b.length, documents().length);
    assert.ok(b.every(doc => doc.sgv === 900), 'tenant B was not modified');
  }

  async function same (method, ...args) {
    const expected = await mongoA(method, ...args);
    assert.deepEqual(await inA(() => writer[method](...args)), expected);
    await sameStored();
    return expected;
  }

  it('inserts JSON documents with preserved stored kind and normalizes only the input requested', async function () {
    for (const id of ['new-string', new ObjectId()]) {
      for (const normalize of [true, false]) {
        const _id = typeof id === 'string' ? id + normalize : new ObjectId();
        const a = { _id, identifier: 'insert-' + _id, sgv: 110, isValid: false, note: null };
        const b = { ...a };
        assert.equal(await inA(() => writer.insertOne(a, { normalize })), await mongoA('insertOne', b, { normalize }));
        assert.deepEqual(a, b);
        await sameStored();
      }
    }
    const generated = { sgv: 111 };
    const identifier = await inA(() => writer.insertOne(generated, { normalize: false }));
    assert.ok(generated._id instanceof ObjectId);
    assert.equal(identifier, generated._id.toHexString());
    await mongoA('insertOne', { ...generated }, { normalize: false });
    await sameStored();

    await same('insertOne', {
      _id: 'nested-json', identifier: 'nested-json', metadata: { source: 'import', values: [1, null, { ok: true }] }
    }, { normalize: false });
    await same('updateOne', 'nested-json', { metadata: { source: 'reconciled', values: [{ ok: false }] } });
  });

  it('matches identifier preference, exact storedId and both kinds, with accurate no-op counts', async function () {
    await same('updateOne', HEX, { sgv: 120 });
    assert.equal((await inA(() => reader.findOne(HEX, {}, { normalize: false })))[0].retained, 'v3');
    await same('updateOne', HEX, { sgv: 121 }, undefined, HEX);
    await same('updateOne', HEX, { sgv: 122 }, undefined, new ObjectId(HEX));
    await same('updateOne', HEX, { sgv: 122 }, undefined, new ObjectId(HEX));
    await same('updateOne', 'named', { sgv: null }, { obsolete: 1, missing: 1 });
    await same('updateOne', 'null', { sgv: null });
    await same('updateOne', 'missing', { sgv: 1 });
    await same('updateOne', 'custom', {}, { missing: 1 });
  });

  it('updates and deletes strict filter matches without changing unrelated fields or tenant B', async function () {
    await same('updateMany', cmp('gte', 'sgv', 101), { set: { isValid: false }, unset: { obsolete: 1 } });
    await same('updateMany', cmp('gte', 'sgv', 101), { set: { isValid: false } });
    await same('updateMany', cmp('eq', 'sgv', null), { set: { note: 'keeps nested data' } });
    await same('deleteMany', cmp('eq', '_id', HEX));
    await same('deleteMany', cmp('eq', '_id', new ObjectId(HEX)));
    await same('deleteMany', cmp('eq', 'sgv', 9999));
    await same('deleteMany', and());
  });

  it('deletes the same single record as MongoDB before falling back to ObjectId then string', async function () {
    for (let i = 0; i < 4; i++) await same('deleteOne', HEX);
    await same('deleteOne', 'named');
    await same('deleteOne', 'null');
  });

  it('refuses data-dependent identifier sorting before changing any matching record', async function () {
    await admin.query(`UPDATE "${name}".entries SET doc = doc || '{"identifier":["ambiguous"]}'::jsonb` +
      ' WHERE tenant_id = $1 AND "_id" = $2', [A, 'custom']);
    const before = await inA(() => reader.findFiltered(and(), raw));
    await assert.rejects(inA(() => writer.updateOne('ambiguous', { sgv: 1 })), /identifier sort/);
    await assert.rejects(inA(() => writer.deleteOne('ambiguous')), /identifier sort/);
    assert.deepEqual(await inA(() => reader.findFiltered(and(), raw)), before);
    await mongo.db().collection(name).updateOne({ _id: 'custom' }, { $set: { identifier: ['ambiguous'] } });
    await same('updateOne', 'ambiguous', { sgv: 105 }, undefined, 'custom');
  });

  it('rolls back failed operations, refuses unbound writes and identifies only known duplicate keys', async function () {
    await assert.rejects(writer.insertOne({ _id: 'unbound' }), /tenant/i);
    await assert.rejects(writer.updateOne('named', { sgv: 1 }), /tenant/i);
    await assert.rejects(writer.deleteMany(and()), /tenant/i);
    await assert.rejects(inA(async function () {
      await writer.updateOne('named', { sgv: 1 });
      await writer.insertOne({ _id: HEX });
    }), error => error.code === 11000 && error.cause.constraint === 'entries_pkey');
    await sameStored();
    await assert.rejects(inA(async function () {
      await writer.insertOne({ _id: 'rolled-back' });
      await writer.deleteMany(and());
      throw new Error('cancel operation');
    }), /cancel operation/);
    await sameStored();
    await same('updateOne', 'named', { sgv: 104 });
  });

  it('merges repeated upserts in order, preserving omitted fields, insert-only values and typed identity', async function () {
    const filter = and(cmp('eq', 'sysTime', '2026-11-02T00:00:00Z'), cmp('eq', 'type', 'sgv'));
    const ops = [
      { filter, doc: { sgv: 120, retained: 'first', isValid: false }, setOnInsert: { _id: 'upsert', srvCreated: 1 } },
      { filter, doc: { sgv: 121, srvModified: 2 }, setOnInsert: { _id: 'ignored', srvCreated: 2 }, unset: { isValid: '' } }
    ];
    await same('bulkUpsert', ops, { mode: 'merge' });
    await same('bulkUpsert', ops.slice(1), { mode: 'merge' });
    const stored = (await inA(() => reader.findOne('upsert', {}, { normalize: false })))[0];
    assert.equal(stored.retained, 'first');
    assert.equal(stored.srvCreated, 1);
    assert.equal(stored.sgv, 121);
    assert.ok(!Object.hasOwn(stored, 'isValid'));
    await same('bulkUpsert', [], { mode: 'merge' });
  });

  it('replaces without retaining omitted fields, preserves identity, and does not resurrect without upsert', async function () {
    const filter = cmp('eq', '_id', 'custom');
    const replacement = { identifier: 'named', sgv: 130 };
    await same('replaceFiltered', filter, replacement);
    const mongoResult = await mongoA('replaceFiltered', filter, replacement);
    const pgResult = await inA(() => writer.replaceFiltered(filter, replacement));
    assert.equal(mongoResult.matchedCount, 1);
    assert.equal(mongoResult.modifiedCount, 1);
    assert.equal(pgResult.matchedCount, 1);
    assert.equal(pgResult.modifiedCount, 0);
    await sameStored();
    await same('replaceFiltered', cmp('eq', '_id', 'absent'), { sgv: 131 });
    await same('replaceFiltered', cmp('eq', '_id', 'absent'), { sgv: 131 }, { upsert: true });
    await same('replaceOne', HEX, { identifier: HEX, sgv: 132 });
    await same('replaceOne', HEX, { sgv: 133 }, new ObjectId(HEX));
    await same('replaceOne', 'missing', { _id: 'replacement-insert', identifier: 'missing', sgv: 134 });
    await assert.rejects(inA(() => writer.replaceFiltered(cmp('eq', '_id', 'new-id'),
      { _id: 'other-id' }, { upsert: true })), /changes upsert _id/);
    await assert.rejects(inA(() => writer.bulkUpsert([{
      filter: cmp('eq', '_id', 'new-id'), doc: { sgv: 1 }, setOnInsert: { _id: 'other-id' }
    }], { mode: 'merge' })), /changes upsert _id/);
    await sameStored();
    await same('bulkUpsert', [
      { filter: cmp('eq', '_id', 'custom'), doc: { identifier: 'named', sgv: 135 } },
      { filter: cmp('eq', '_id', 'bulk-replace'), doc: { _id: 'bulk-replace', sgv: 136 } },
      { filter: cmp('eq', '_id', 'custom'), doc: { note: 'merge override' }, merge: true },
      { remove: cmp('eq', '_id', 'bulk-replace') }
    ], { mode: 'replace' });
  });

  it('uses JSONB value equality for order-only replacement counts when _id is present', async function () {
    const filter = cmp('eq', '_id', 'ordered');
    await inA(() => writer.insertOne({ _id: 'ordered', first: 1, second: 2 }, { normalize: false }));
    const result = await inA(() => writer.replaceFiltered(filter, { _id: 'ordered', second: 2, first: 1 }));
    assert.equal(result.matchedCount, 1);
    assert.equal(result.modifiedCount, 0);
    const stored = (await inA(() => reader.findFiltered(filter, raw)))[0];
    assert.equal(stored.first, 1);
    assert.equal(stored.second, 2);
  });

  it('refuses over-cap update and delete matches without changing any rows', async function () {
    await admin.query(`INSERT INTO "${name}".entries (tenant_id, id_kind, doc)` +
      " SELECT $1, 'string', jsonb_build_object('_id', 'limit-' || n::text, 'batch', 'over-cap', 'sgv', 150)" +
      ' FROM generate_series(1, 1001) AS n', [A]);
    const filter = cmp('eq', 'batch', 'over-cap');
    const refused = error => error.unsupported === true && /write target limit of 1000 exceeded/.test(error.message);
    await assert.rejects(inA(() => writer.updateMany(filter, { set: { sgv: 151 } })), refused);
    let rows = await admin.query(`SELECT count(*) AS count FROM "${name}".entries` +
      " WHERE tenant_id = $1 AND doc ->> 'batch' = 'over-cap' AND doc ->> 'sgv' = '150'", [A]);
    assert.equal(Number(rows.rows[0].count), 1001);
    await assert.rejects(inA(() => writer.deleteMany(filter)), refused);
    await assert.rejects(inA(() => writer.replaceFiltered(filter, { sgv: 152 })),
      error => error.unsupported === true && /ambiguous replacement filter/.test(error.message));
    rows = await admin.query(`SELECT count(*) AS count FROM "${name}".entries` +
      " WHERE tenant_id = $1 AND doc ->> 'batch' = 'over-cap'", [A]);
    assert.equal(Number(rows.rows[0].count), 1001);
  });

  it('locks overlapping multi-row updates in the same stable order', async function () {
    await admin.query(`INSERT INTO "${name}".entries (tenant_id, id_kind, doc) VALUES` +
      ` ($1, 'string', '{"_id":"lock-c","lockBatch":true,"sgv":100}'),` +
      ` ($1, 'string', '{"_id":"lock-a","lockBatch":true,"sgv":100}'),` +
      ` ($1, 'string', '{"_id":"lock-b","lockBatch":true,"sgv":100}')`, [A]);
    const statements = [];
    let arrivals = 0;
    let release;
    const bothReady = new Promise(resolve => { release = resolve; });
    const observed = {
      ...store,
      async query (text, values) {
        if (text.startsWith('WITH locked AS')) {
          statements.push(text);
          if (++arrivals === 2) release();
          await bothReady;
        }
        return store.query(text, values);
      }
    };
    const concurrentWriter = entriesWrite({ connection: observed, table });
    const filter = cmp('eq', 'lockBatch', true);
    await Promise.all([
      inA(() => concurrentWriter.updateMany(filter, { set: { lockPass: 1 } })),
      inA(() => concurrentWriter.updateMany(filter, { set: { lockPass: 2 } }))
    ]);
    assert.equal(statements.length, 2);
    assert.ok(statements.every(sql => /ORDER BY tenant_id, id_kind, "_id" LIMIT \$\d+ FOR UPDATE/.test(sql)),
      'each concurrent update must lock rows in tenant/id-kind/id order');
    const rows = await admin.query(`SELECT doc ->> 'lockPass' AS pass FROM "${name}".entries` +
      " WHERE tenant_id = $1 AND doc ->> 'lockBatch' = 'true'", [A]);
    assert.equal(rows.rowCount, 3);
    assert.ok(rows.rows.every(row => row.pass === '1' || row.pass === '2'));
  });

  it('updates/removes every displayed form, scopes resolved identities, and reports over-cap resolution', async function () {
    await same('updateEveryForm', HEX.toUpperCase(), { note: 'upper-case address' });
    assert.deepEqual(new Set((await inA(() => writer.resolveEveryForm(HEX, 10))).map(String)), new Set([HEX, 'v3']));
    assert.equal(await inA(() => writer.resolveEveryForm(HEX, 2)), null);
    assert.deepEqual(await inA(() => writer.resolveOne(HEX)), ['v3']);
    await same('updateEveryForm', HEX, { isValid: false }, [new ObjectId(HEX)]);
    await same('deleteEveryForm', HEX, [HEX]);
    await same('updateEveryForm', HEX, { isValid: false });
    await same('deleteEveryForm', HEX);
    await same('deleteEveryForm', 'custom'); // Has its own identifier; not displayed as "custom".
    await same('deleteEveryForm', 'named');
    const filterDef = [{ field: 'sgv', operator: 'eq', value: null }];
    assert.deepEqual(await inA(() => writer.resolveOr(filterDef, 1)), ['null']);
    await same('deleteManyOr', filterDef, []);
    await same('deleteManyOr', filterDef, ['null']);
  });

  function bulkResult (result) {
    return Object.fromEntries(['upsertedIds', 'matchedCount', 'modifiedCount', 'upsertedCount'].map(key => [key, result[key]]));
  }

  it('exposes ordered prefixes and unordered continuation after duplicate _id, with a usable transaction', async function () {
    for (const ordered of [true, false]) {
      const suffix = String(ordered);
      const ops = [
        { filter: cmp('eq', '_id', 'prefix-' + suffix), doc: { _id: 'prefix-' + suffix, sgv: 140 } },
        { filter: cmp('eq', 'identifier', 'not-custom'), doc: { _id: 'custom', sgv: 141 } },
        { filter: cmp('eq', '_id', 'suffix-' + suffix), doc: { _id: 'suffix-' + suffix, sgv: 142 } }
      ];
      let actual, expected;
      try { await mongoA('bulkUpsert', ops, { ordered }); } catch (error) { expected = error; }
      await inA(async function () {
        try { await writer.bulkUpsert(ops, { ordered }); } catch (error) { actual = error; }
        assert.equal((await store.query('SELECT 1 AS usable')).rows[0].usable, 1);
      });
      assert.equal(actual.code, expected.code);
      assert.deepEqual(actual.writeErrors.map(error => [error.index, error.code]),
        expected.writeErrors.map(error => [error.index, error.code]));
      assert.deepEqual(actual.result, bulkResult(expected.result));
      await sameStored();
    }
  });

  async function uniqueIdentifiers () {
    await admin.query(`CREATE UNIQUE INDEX identifier_unique ON "${name}".entries (tenant_id, identifier)` +
      " WHERE jsonb_typeof(doc -> 'identifier') = 'string' AND identifier <> ''");
    await mongo.db().collection(name).createIndex({ identifier: 1 }, { name: 'identifier_unique', unique: true,
      partialFilterExpression: { identifier: { $type: 'string', $gt: '' } } });
  }

  it('recovers an identifier conflict using a savepoint so a caller can rematch only that operation', async function () {
    await uniqueIdentifiers();
    try {
      const conflict = { filter: cmp('eq', '_id', 'raced'), doc: { identifier: 'named', sgv: 150 } };
      await inA(async function () {
        await assert.rejects(writer.bulkUpsert([conflict], { mode: 'merge' }), error =>
          error.writeErrors.length === 1 && error.writeErrors[0].keyPattern.identifier === 1);
        assert.equal((await store.query('SELECT 1 AS usable')).rows[0].usable, 1);
      });
      await same('bulkUpsert', [{ ...conflict, filter: cmp('eq', 'identifier', 'named') }], { mode: 'merge' });
      await assert.rejects(inA(() => writer.insertOne({ _id: 'duplicate', identifier: 'named' })), error =>
        error.code === 11000 && error.keyPattern.identifier === 1);
      await sameStored();
    } finally {
      await admin.query(`DROP INDEX "${name}".identifier_unique`);
      await mongo.db().collection(name).dropIndex('identifier_unique');
    }
  });

  it('does not translate or retry an unrelated unique constraint', async function () {
    await admin.query(`CREATE UNIQUE INDEX unrelated_unique ON "${name}".entries (tenant_id, (doc ->> 'retained'))`);
    try {
      await assert.rejects(inA(() => writer.bulkUpsert([
        { filter: cmp('eq', '_id', 'other'), doc: { retained: 'v3' } }
      ])), error => error.code === '23505' && error.constraint === 'unrelated_unique');
      await sameStored();
    } finally { await admin.query(`DROP INDEX "${name}".unrelated_unique`); }
  });

  function cloneIntent (intent) {
    return { ...intent, docs: intent.docs && intent.docs.map(doc => ({ ...doc })),
      target: intent.target && { ...intent.target, stored: intent.target.stored && { ...intent.target.stored } } };
  }

  it('runs shared v3 matching and create/resend/PUT/PATCH/delete rules with the same named results and events', async function () {
    const pgBus = new EventEmitter(), mongoBus = new EventEmitter();
    const pgEvents = [], mongoEvents = [];
    pgBus.on(intentStep.INTENT_EVENT, event => pgEvents.push(event));
    mongoBus.on(intentStep.INTENT_EVENT, event => mongoEvents.push(event));
    const pgStep = entriesIntent({ connection: store, table, bus: pgBus });
    const mongoStep = intentStep.forCollectionIntent(mongoStore, 'entries', 'v3', { bus: mongoBus });
    const next = srvDates.next;
    srvDates.next = () => 1793664000000;
    async function compare (intent) {
      const eventCount = mongoEvents.length;
      assert.equal(pgEvents.length, eventCount);
      const expected = await scope.withTenant(A, () => mongoStep.write(cloneIntent(intent)));
      const actual = await scope.withTenant(A, () => pgStep.write(cloneIntent(intent)));
      if (Array.isArray(actual.removed) && Array.isArray(expected.removed)) {
        // unordered_membership: removed/resolved IDs keep their types, not their order.
        const typedIds = ids => ids.map(_id => {
          const row = encodeDocument({ _id });
          return JSON.stringify([row.id_kind, row.doc._id]);
        }).sort();
        assert.deepEqual(typedIds(actual.removed), typedIds(expected.removed));
        assert.deepEqual({ ...actual, removed: expected.removed }, expected);
      } else assert.deepEqual(actual, expected);
      assert.equal(pgEvents.length, mongoEvents.length);
      for (let index = eventCount; index < mongoEvents.length; index++) {
        const pgEvent = pgEvents[index], mongoEvent = mongoEvents[index];
        if (intent.op === 'delete' && actual.items.length === 1
          && Array.isArray(actual.removed) && actual.removed.length > 1) {
          // Resolved multi-record events are typed multisets; batch and single-record events remain ordered.
          const remaining = mongoEvent.records.slice();
          for (const record of pgEvent.records) {
            const match = remaining.findIndex(expectedRecord => isDeepStrictEqual(record, expectedRecord));
            assert.notEqual(match, -1, 'resolved event must contain the same full typed records');
            remaining.splice(match, 1);
          }
          assert.equal(remaining.length, 0, 'resolved event must preserve record multiplicity');
          assert.deepEqual({ ...pgEvent, records: mongoEvent.records }, mongoEvent);
        } else assert.deepEqual(pgEvent, mongoEvent);
      }
      await sameStored();
    }
    try {
      for (const identifier of [HEX, 'named', 'absent']) {
        const intent = { op: 'patch', docs: [{ sgv: 160 }], target: { identifier } };
        assert.deepEqual(await scope.withTenant(A, () => pgStep.match(intent)),
          await scope.withTenant(A, () => mongoStep.match(intent)));
      }
      await compare({ op: 'create', docs: [{ _id: 'intent-new', identifier: 'intent-new', sgv: 160 }], by: 'synthetic' });
      let stored = (await inA(() => reader.findOne('intent-new')))[0];
      await compare({ op: 'create', docs: [{ identifier: 'intent-new', sgv: 161 }],
        target: { identifier: 'intent-new', stored }, by: 'synthetic' });
      stored = (await inA(() => reader.findOne('intent-new')))[0];
      await compare({ op: 'patch', docs: [{ sgv: 162, subject: null }],
        target: { identifier: 'intent-new', stored }, by: 'synthetic' });
      stored = (await inA(() => reader.findOne('intent-new')))[0];
      await compare({ op: 'update', docs: [{ identifier: 'intent-new', sgv: 163 }],
        target: { identifier: 'intent-new', stored }, by: 'synthetic' });
      await compare({ op: 'delete', form: 'mark', target: { identifier: HEX }, by: 'synthetic' });
      await compare({ op: 'delete', form: 'permanent', target: { identifier: HEX } });
      await compare({ op: 'delete', form: 'permanent', target: { identifier: 'intent-new' } });
      const patch = { op: 'patch', docs: [{ identifier: 'named' }], target: { stored: { identifier: 'other' } } };
      assert.equal(await scope.withTenant(A, () => pgStep.identifierHeld(patch)),
        await scope.withTenant(A, () => mongoStep.identifierHeld(patch)));
      await compare({ op: 'prune', target: { filter: [{ field: 'sgv', operator: 'eq', value: 103 }] } });
    } finally { srvDates.next = next; }
  });

  it('publishes the shared intent event only after commit; rollback and nested boundaries publish nothing', async function () {
    const bus = new EventEmitter(), visible = [];
    let committed = false;
    const observed = { ...store, transaction: async fn => {
      const result = await store.transaction(fn);
      committed = true;
      return result;
    } };
    bus.on(intentStep.INTENT_EVENT, () => {
      visible.push({ committed, query: admin.query(`SELECT doc FROM "${name}".entries WHERE tenant_id = $1 AND "_id" = 'committed'`, [A]) });
    });
    const step = entriesIntent({ connection: observed, table, bus });
    await scope.withTenant(A, () => step.write({ op: 'create', docs: [{ _id: 'committed', sgv: 170 }] }));
    assert.equal(visible.length, 1);
    assert.equal(visible[0].committed, true);
    assert.equal((await visible[0].query).rows[0].doc.sgv, 170);
    await assert.rejects(scope.withTenant(A, () => step.write({
      op: 'create', docs: [{ _id: 'refused', sgv: 171, nested: { date: new Date() } }]
    })), /unsupported/);
    await assert.rejects(inA(() => step.write({ op: 'create', docs: [{ _id: 'nested' }] })), /new transaction/);
    assert.equal(visible.length, 1);
    assert.equal((await inA(() => reader.findOne('refused'))).length, 0);
    assert.throws(() => entriesIntent({ connection: store, table, source: 'v1/internal' }), /only.*v3/);
  });

  it('settles an actual concurrent identifier insert as one v3 resend after recovering the failed SQL statement', async function () {
    await uniqueIdentifiers();
    const next = srvDates.next;
    srvDates.next = () => 1793664000000;
    let unlock, locked, started, secondPid;
    const hold = new Promise(resolve => { unlock = resolve; });
    const firstLocked = new Promise(resolve => { locked = resolve; });
    const secondStarted = new Promise(resolve => { started = resolve; });
    const bus = new EventEmitter(), events = [];
    bus.on(intentStep.INTENT_EVENT, event => events.push(event));
    const observed = { ...store, transaction: fn => store.transaction(async function () {
      secondPid = (await store.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      started();
      return fn();
    }) };
    const step = entriesIntent({ connection: observed, table, bus });
    const winner = { _id: 'winner', identifier: 'raced-identifier', sgv: 180, srvCreated: 1, srvModified: 1 };
    const first = inA(async function () {
      await writer.insertOne({ ...winner }, { normalize: false });
      locked();
      await hold;
    });
    first.catch(locked);
    let second;
    try {
      await firstLocked;
      const intent = { op: 'create', docs: [{ _id: 'loser', identifier: 'raced-identifier', sgv: 181 }] };
      second = scope.withTenant(A, () => step.write(cloneIntent(intent)));
      second.catch(started);
      await secondStarted;
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const activity = await admin.query("SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [secondPid]);
        if (activity.rows[0] && activity.rows[0].waiting) { waiting = true; break; }
        await delay(10);
      }
      assert.ok(waiting, 'the contender must wait on the unique index held by the other transaction');
      assert.equal(events.length, 0);
      unlock();
      await first;
      const actual = await second;
      await mongoA('insertOne', { ...winner }, { normalize: false });
      const mongoStep = intentStep.forCollectionIntent(mongoStore, 'entries', 'v3');
      const expected = await scope.withTenant(A, () => mongoStep.write(cloneIntent(intent)));
      assert.deepEqual(actual, expected);
      assert.equal(actual.items[0].outcome, 'replaced');
      assert.equal(events.length, 1);
      await sameStored();
      await assert.rejects(scope.withTenant(A, () => step.write({
        ...cloneIntent(intent), canUpdate: false
      })), error => error.code === 11000);
      assert.equal(events.length, 1);
    } finally {
      unlock();
      await Promise.allSettled([first, second]);
      srvDates.next = next;
      await admin.query(`DROP INDEX "${name}".identifier_unique`);
      await mongo.db().collection(name).dropIndex('identifier_unique');
    }
  });

  it('serializes competing patches without losing fields', async function () {
    for (const [left, right] of [[{ left: 1 }, { right: 2 }], [{ sgv: 104 }, { sgv: 103 }]]) {
      let unlock, locked, started;
      const hold = new Promise(resolve => { unlock = resolve; });
      const firstLocked = new Promise(resolve => { locked = resolve; });
      const secondStarted = new Promise(resolve => { started = resolve; });
      let pidA, pidB;
      const first = inA(async function () {
        pidA = (await store.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await writer.updateOne('named', left);
        locked();
        await hold;
      });
      // Let an early failure unblock the barrier, retaining its rejection.
      first.catch(locked);
      await firstLocked;
      const second = inA(async function () {
        pidB = (await store.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const patch = writer.updateOne('named', right);
        started();
        await patch;
      });
      second.catch(started);
      try {
        await secondStarted;
        assert.notEqual(pidA, pidB, 'competing transactions use independent PostgreSQL connections');
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const activity = await admin.query("SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [pidB]);
          if (activity.rows[0].waiting) { waiting = true; break; }
          await delay(10);
        }
        assert.ok(waiting, 'the second statement must actually wait on the first transaction');
      } finally { unlock(); }
      await Promise.all([first, second]);
      await mongoA('updateOne', 'named', left);
      await mongoA('updateOne', 'named', right);
      await sameStored();
    }
  });

  it('allows tenant B to write its own overlapping ids without changing tenant A', async function () {
    await store.withTenant(B, async function () {
      assert.deepEqual(await writer.updateOne('named', { sgv: 901 }), { updated: 1 });
      assert.deepEqual(await writer.deleteMany(and()), { acknowledged: true, deletedCount: 5, deleted: 5 });
      assert.equal(await writer.insertOne({ _id: HEX, sgv: 902 }), HEX);
      assert.deepEqual(await reader.findFiltered(and(), raw), [{ _id: HEX, sgv: 902 }]);
    });
    assert.deepEqual(await inA(() => reader.findFiltered(and(), raw)), await mongoA('findFiltered', and(), raw));
  });
});
