'use strict';

const assert = require('node:assert/strict');
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
const scope = require('../lib/storage/tenant-scope');

describe('PostgreSQL entries write refusals', function () {
  it('refuses lossy or ambiguous input before sending SQL', async function () {
    let queries = 0;
    const writer = entriesWrite({ connection: { query () { queries++; throw new Error('unexpected query'); } } });
    const bad = error => error.unsupported === true;
    for (const value of [undefined, NaN, Infinity, -0, new Date(), new ObjectId(), /x/, {}, [], Buffer.from('x')]) {
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

  it('inserts scalar documents with preserved stored kind and normalizes only the input requested', async function () {
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

  it('rolls back failed operations, refuses unbound writes and does not retry duplicate keys', async function () {
    await assert.rejects(writer.insertOne({ _id: 'unbound' }), /tenant/i);
    await assert.rejects(writer.updateOne('named', { sgv: 1 }), /tenant/i);
    await assert.rejects(writer.deleteMany(and()), /tenant/i);
    await assert.rejects(inA(async function () {
      await writer.updateOne('named', { sgv: 1 });
      await writer.insertOne({ _id: HEX });
    }), error => error.code === '23505' && error.constraint === 'entries_pkey');
    await sameStored();
    await assert.rejects(inA(async function () {
      await writer.insertOne({ _id: 'rolled-back' });
      await writer.deleteMany(and());
      throw new Error('cancel operation');
    }), /cancel operation/);
    await sameStored();
    await same('updateOne', 'named', { sgv: 104 });
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
