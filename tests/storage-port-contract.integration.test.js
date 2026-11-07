'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const entriesRead = require('../lib/storage/postgres-entries-read');
const entriesWrite = require('../lib/storage/postgres-entries-write');
const entriesIntent = require('../lib/storage/postgres-entries-intent');
const collectionIntent = require('../lib/storage/postgres-collection-intent');
const connect = require('../lib/storage/postgres-connection');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const { and, cmp } = require('../lib/storage/filter');
const scope = require('../lib/storage/tenant-scope');
const intentStep = require('../lib/storage/write-intent');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '65a1b2c3d4e5f60718293a4b';
const raw = { options: { normalize: false } };
const ordered = { ...raw, sort: { order: 1 } };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
const unsupported = error => error.unsupported === true;

function documents () {
  return [
    { _id: new ObjectId(HEX), order: 1, label: 'objectid' },
    { _id: HEX, order: 2, label: 'string' },
    { _id: 'named', identifier: HEX, order: 3, label: 'identifier' },
    { _id: 'missing', order: 4, nested: { keep: null, drop: 1 } },
    { _id: 'null', order: 5, value: null },
    { _id: 'zero', order: 6, value: 0 },
    { _id: 'false', order: 7, value: false },
    { _id: 'text', order: 8, value: '0' }
  ];
}

async function ready (operation) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    try { return await operation(); } catch (error) { last = error; await delay(100); }
  }
  throw last;
}

optInSuite(process.env.NS_STORAGE_PORT_CONTRACT_DOCKER_TEST === '1',
  'NS_STORAGE_PORT_CONTRACT_DOCKER_TEST=1 with Docker')('actual storage port contract', function () {
  this.timeout(90000);
  const name = 'ns_port_test_' + randomUUID().replace(/-/g, '');
  const containers = [name + '_pg', name + '_mongo'];
  const role = name + '_app';
  const table = name + '.entries';
  let admin, connection, mongo, db, mode, pgURI;
  const ports = {};

  before(async function () {
    mode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const password = randomBytes(24).toString('hex');
    docker('run', '--detach', '--rm', '--name', containers[0], '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_PASSWORD=' + password, '--env', 'POSTGRES_DB=' + name, 'postgres:16');
    docker('run', '--detach', '--rm', '--name', containers[1], '--publish', '127.0.0.1::27017', '--ulimit', 'nofile=64000:64000', 'mongo:7.0');
    const pgPort = docker('port', containers[0], '5432/tcp').split(':').pop();
    const mongoPort = docker('port', containers[1], '27017/tcp').split(':').pop();
    const url = new URL('postgresql://127.0.0.1:' + pgPort + '/' + name);
    url.username = 'postgres';
    url.password = password;
    pgURI = url.toString();
    admin = await ready(async function () {
      const client = new Client({ connectionString: pgURI, connectionTimeoutMillis: 500 });
      try { await client.connect(); return client; } catch (error) { await client.end(); throw error; }
    });
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`CREATE SCHEMA "${name}"`);
    await admin.query(`SET search_path TO "${name}"`);
    await admin.query(fs.readFileSync(path.join(__dirname, 'fixtures/postgres/entries-identity-kinds.sql'), 'utf8'));
    await admin.query(`GRANT USAGE ON SCHEMA "${name}" TO "${role}"`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${name}".entries TO "${role}"`);
    url.username = role;
    connection = await connect({ connectionString: url.toString(), max: 2 });
    mongo = new MongoClient('mongodb://127.0.0.1:' + mongoPort, { serverSelectionTimeoutMS: 500 });
    await ready(() => mongo.connect());
    db = mongo.db(name);
    ports.pg = { read: entriesRead({ connection, table }), write: entriesWrite({ connection, table }),
      run: fn => connection.withTenant(A, fn) };
    const preview = collectionIntent({ connection, table, logical: 'entries' }).storage;
    ports['pg-preview'] = { read: preview, write: preview, run: fn => connection.withTenant(A, fn) };
    const storage = new MongoCollection({ store: { collection: n => db.collection(n), db }, bus: new EventEmitter() },
      { writeValidation: 'off' }, 'entries_a', 'entries', []);
    ports.mongo = { read: storage, write: storage, run: fn => scope.withTenant(A, fn) };
    const pgVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
    const mongoVersion = (await db.admin().buildInfo()).version;
    console.log('storage-port services: PostgreSQL ' + pgVersion + ', MongoDB ' + mongoVersion);
  });

  beforeEach(async function () {
    await admin.query(`DELETE FROM "${name}".entries`);
    for (const tenant of [A, B]) {
      for (const doc of documents()) {
        const row = encodeDocument(tenant === A ? doc : { ...doc, owner: 'tenant-b' });
        await admin.query(`INSERT INTO "${name}".entries (tenant_id, id_kind, doc) VALUES ($1, $2, $3)`,
          [tenant, row.id_kind, row.doc]);
      }
    }
    await db.collection('entries_a').deleteMany({});
    await db.collection('entries_a').insertMany(documents());
  });

  afterEach(async function () {
    assert.equal((await admin.query('SELECT 1 AS live')).rows[0].live, 1);
    assert.equal((await db.command({ ping: 1 })).ok, 1);
  });

  after(async function () {
    const failures = [];
    for (const close of [async () => { if (mongo) { try { if (db) await db.dropDatabase(); } finally { await mongo.close(); } } },
      async () => { if (connection) await connection.end(); }, async () => { if (admin) await admin.end(); }]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    for (const container of containers) {
      try { docker('rm', '--force', container); } catch (error) {
        if (!String(error.stderr).includes('No such container')) failures.push(error);
      }
    }
    if (mode !== undefined) scope.setTenancyMode(mode);
    if (failures.length) throw new globalThis.AggregateError(failures, 'storage-port cleanup failed');
  });

  for (const backend of ['mongo', 'pg', 'pg-preview']) {
    describe(backend + ' admitted contract', function () {
      const port = () => ports[backend];
      const run = fn => port().run(fn);
      const read = (method, ...args) => run(() => port().read[method](...args));
      const write = (method, ...args) => run(() => port().write[method](...args));

      it('preserves typed stored identities and chooses identifier before ObjectId before string', async function () {
        const rows = await read('findFiltered', and(), ordered);
        assert.ok(rows[0]._id instanceof ObjectId);
        assert.equal(rows[0]._id.toHexString(), HEX);
        assert.equal(rows[1]._id, HEX);
        assert.equal(rows[1].owner, undefined, 'a tenant A port must not return tenant B rows');
        assert.deepEqual(await read('findOne', HEX, undefined, { normalize: false }), [documents()[2]]);
        assert.equal((await read('findOne', HEX))[0].identifier, HEX);
        await write('deleteOne', HEX);
        assert.ok((await read('findOne', HEX, undefined, { normalize: false }))[0]._id instanceof ObjectId);
        await write('deleteOne', HEX);
        assert.equal((await read('findOne', HEX, undefined, { normalize: false }))[0]._id, HEX);
      });

      it('normalizes absent/null/false/zero identifiers only in the shown document', async function () {
        for (const [index, identifier] of [undefined, null, false, 0].entries()) {
          const doc = { _id: 'falsy-' + index, ...(identifier === undefined ? {} : { identifier }), value: index };
          assert.equal(await write('insertOne', { ...doc }, { normalize: false }), doc._id);
          assert.deepEqual(await read('findOne', doc._id, undefined, { normalize: false }), [doc]);
          assert.deepEqual(await read('findOne', doc._id), [{ identifier: doc._id, value: index }]);
          assert.deepEqual(await read('findOne', doc._id, undefined, { normalize: false }), [doc]);
        }
      });

      for (const [op, value, expected] of [
        ['eq', null, ['missing', 'null']], ['exists', false, ['missing']],
        ['eq', 0, ['zero']], ['eq', false, ['false']], ['eq', '0', ['text']],
        ['lte', null, ['missing', 'null']], ['gt', null, []],
        ['in', [0, false], ['zero', 'false']]
      ]) {
        it('keeps ' + op + ' ' + JSON.stringify(value) + ' distinct from other representations', async function () {
          const ast = and(cmp('gte', 'order', 4), cmp(op, 'value', value));
          const rows = await read('findFiltered', ast, ordered);
          assert.deepEqual(rows.map(doc => doc._id), expected);
          assert.equal(await read('count', ast), expected.length);
        });
      }

      it('projects only included fields, retaining typed _id and explicit null', async function () {
        const rows = await read('findFiltered', cmp('eq', '_id', 'null'), {
          ...raw, projection: { value: 1, absent: 1 }
        });
        assert.deepEqual(rows, [{ _id: 'null', value: null }]);
        const oid = await read('findFiltered', cmp('eq', '_id', new ObjectId(HEX)), {
          ...raw, projection: { label: 1 }
        });
        assert.deepEqual(oid, [{ _id: new ObjectId(HEX), label: 'objectid' }]);
      });

      it('orders scalar values with explicit pagination and the v3 filter definition', async function () {
        const opts = { ...raw, sort: { order: -1 }, limit: 2, skip: 1, projection: { order: 1 } };
        assert.deepEqual(await read('findFiltered', and(), opts), [
          { _id: 'false', order: 7 }, { _id: 'zero', order: 6 }
        ]);
        const args = { filter: [{ field: 'order', operator: 'gte', value: 4 }],
          ...opts, onlyValid: false };
        assert.deepEqual(await read('findMany', args), await read('findFiltered', cmp('gte', 'order', 4), opts));
      });

      it('reports actual changed/no-op/missing outcomes and distinguishes set-null from unset', async function () {
        assert.deepEqual(await write('updateOne', 'zero', { value: 0 }), { updated: 0 });
        assert.deepEqual(await write('updateOne', 'zero', { value: null, flag: false }), { updated: 1 });
        assert.deepEqual(await read('findOne', 'zero', undefined, { normalize: false }),
          [{ _id: 'zero', order: 6, value: null, flag: false }]);
        assert.deepEqual(await write('updateOne', 'zero', {}, { value: true }), { updated: 1 });
        assert.equal(Object.hasOwn((await read('findOne', 'zero', undefined, { normalize: false }))[0], 'value'), false);
        assert.deepEqual(await write('updateOne', 'absent', { value: 1 }), { updated: 0 });
        assert.deepEqual(await write('deleteMany', cmp('eq', '_id', 'zero')),
          { acknowledged: true, deletedCount: 1, deleted: 1 });
        assert.deepEqual(await write('deleteOne', 'zero'), { deleted: 0 });
      });

      for (const orderedBatch of [true, false]) {
        it('preserves ' + (orderedBatch ? 'ordered prefix' : 'unordered continuation') + ' after a duplicate batch item', async function () {
          const ops = ['prefix', 'duplicate', 'suffix'].map(label => ({
            filter: cmp('eq', 'label', 'new-' + label),
            doc: { _id: label === 'duplicate' ? 'zero' : label, label: 'new-' + label }
          }));
          await run(async function () {
            await assert.rejects(port().write.bulkUpsert(ops, { mode: 'replace', ordered: orderedBatch }), error => {
              assert.equal(error.code, 11000);
              assert.deepEqual(error.writeErrors.map(item => [item.index, item.code]), [[1, 11000]]);
              assert.equal(error.result.upsertedCount, orderedBatch ? 1 : 2);
              assert.equal(error.result.matchedCount, 0);
              assert.equal(error.result.modifiedCount, 0);
              assert.deepEqual(Object.keys(error.result.upsertedIds), orderedBatch ? ['0'] : ['0', '2']);
              return true;
            });
            const rows = await port().read.findFiltered(cmp('in', '_id', ['prefix', 'suffix']), { ...raw, sort: { label: 1 } });
            assert.deepEqual(rows.map(doc => doc._id), orderedBatch ? ['prefix'] : ['prefix', 'suffix']);
            assert.equal((await port().read.findOne('zero', undefined, { normalize: false }))[0].value, 0);
          });
        });
      }

      it('refuses unknown AST operations and unbound access', async function () {
        await assert.rejects(read('findFiltered', { op: 'unknown', field: 'value', value: 1 }), /unsupported operator/);
        await assert.rejects(async () => port().read.findFiltered(and(), raw), /no tenant bound/);
        assert.throws(() => scope.withTenant(A, () => scope.withTenant(B, () => {})), /cannot rebind/);
      });
    });
  }

  it('keeps PostgreSQL RLS binding independent of transaction ownership and reuses only the same scope', async function () {
    const reader = ports.pg.read;
    await connection.withTenant(A, async function () {
      const first = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await connection.withTenant(A, async function () {
        assert.equal((await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, first);
      });
      assert.ok((await reader.findFiltered(and(), raw)).every(doc => doc.owner === undefined));
      assert.throws(() => connection.withTenant(B, () => reader.findFiltered(and(), raw)), /cannot rebind/);
      assert.throws(() => connection.transaction(() => {}), /new transaction/);
    });
    const b = await connection.withTenant(B, () => reader.findFiltered(and(), raw));
    assert.equal(b.length, documents().length);
    assert.ok(b.every(doc => doc.owner === 'tenant-b'));
    const unbound = new Client({ connectionString: (() => {
      const url = new URL(pgURI); url.username = role; return url.toString();
    })() });
    await unbound.connect();
    try { assert.equal((await unbound.query(`SELECT * FROM "${name}".entries`)).rowCount, 0); }
    finally { await unbound.end(); }
  });

  it('does not manufacture Mongo row isolation or a rollback from tenant scope', async function () {
    const storage = ports.mongo.write;
    await assert.rejects(scope.withTenant(A, async function () {
      await storage.updateOne('zero', { value: 42 });
      throw new Error('synthetic caller failure');
    }), /synthetic caller failure/);
    const rows = await scope.withTenant(B, () => storage.findOne('zero', undefined, { normalize: false }));
    assert.equal(rows[0].value, 42, 'this handle stays on its explicitly selected collection under either scope');
  });

  it('rolls PostgreSQL changes back when an owned transaction fails', async function () {
    await assert.rejects(scope.withTenant(A, () => connection.transaction(async function () {
      await ports.pg.write.updateOne('zero', { value: 42 });
      throw new Error('synthetic caller failure');
    })), /synthetic caller failure/);
    assert.equal((await ports.pg.run(() => ports.pg.read.findOne('zero', undefined, { normalize: false })))[0].value, 0);
  });

  it('refuses PG projection/query shapes which the Mongo port admits', async function () {
    const cases = [
      [and(), { ...raw, projection: { label: 0 } }],
      [and(), { ...raw, projection: { label: 1, _id: 0 } }],
      [and(), { ...raw, limit: 1 }],
      [cmp('eq', 'nested.keep', null), raw],
      [cmp('re', 'label', '^object'), raw],
      [and(), { ...raw, v1: true }]
    ];
    for (const [ast, opts] of cases) {
      await ports.mongo.run(() => ports.mongo.read.findFiltered(ast, opts));
      await assert.rejects(ports.pg.run(() => ports.pg.read.findFiltered(ast, opts)), unsupported);
    }
    await assert.rejects(ports.pg.run(() => ports.pg.read.findNatural(and(), { limit: 1 })), unsupported);
  });

  it('refuses PG lossy representations and identity kinds without silently dropping fields', async function () {
    for (const [index, value] of [new Date(0), /synthetic/, Buffer.from('synthetic'), NaN, -0].entries()) {
      const doc = { _id: 'bson-' + index, value };
      await ports.mongo.run(() => ports.mongo.write.insertOne({ ...doc }, { normalize: false }));
      await assert.rejects(ports.pg.run(() => ports.pg.write.insertOne({ ...doc }, { normalize: false })), unsupported);
      assert.equal((await ports.pg.run(() => ports.pg.read.findOne(doc._id))).length, 0);
    }
    for (const id of [false, 0]) {
      await db.collection('entries_a').insertOne({ _id: id });
      const rows = await ports.mongo.run(() => ports.mongo.read.findFiltered(cmp('eq', '_id', id), raw));
      assert.deepEqual(rows, [{ _id: id }]);
      await assert.rejects(ports.pg.run(() => ports.pg.write.insertOne({ _id: id })), /identity requires/);
    }
    const submitted = { _id: null, label: 'null-submitted' };
    const identifier = await ports.mongo.run(() => ports.mongo.write.insertOne(submitted, { normalize: false }));
    assert.ok(submitted._id instanceof ObjectId);
    assert.equal(identifier, submitted._id.toHexString());
    assert.deepEqual(await ports.mongo.run(() => ports.mongo.read.findOne(identifier, undefined, { normalize: false })), [submitted]);
    await assert.rejects(ports.pg.run(() => ports.pg.write.insertOne({ _id: null })), /identity requires/);
  });

  it('keeps lower PG inclusion projections separate from top-level intent projections', async function () {
    const ast = cmp('eq', '_id', 'missing');
    const nested = { ...raw, projection: { 'nested.keep': 1, absent: 1 } };
    for (const backend of ['mongo', 'pg']) {
      assert.deepEqual(await ports[backend].run(() => ports[backend].read.findFiltered(ast, nested)),
        [{ _id: 'missing', nested: { keep: null } }]);
    }
    await assert.rejects(ports['pg-preview'].run(() => ports['pg-preview'].read.findFiltered(ast, nested)), /unsupported projection/);
    const opts = { ...raw, projection: { nested: 1, _id: 0 } };
    assert.deepEqual(await ports['pg-preview'].run(() => ports['pg-preview'].read.findFiltered(ast, opts)),
      await ports.mongo.run(() => ports.mongo.read.findFiltered(ast, opts)));
    await assert.rejects(ports.pg.run(() => ports.pg.read.findFiltered(ast, opts)), unsupported);
  });

  it('preserves backend/internal failures separately from unsupported representation', async function () {
    const missingTable = entriesRead({ connection, table: name + '.missing_table' });
    await assert.rejects(ports.pg.run(() => missingTable.findFiltered(and(), raw)), error =>
      error.code === '42P01' && error.unsupported !== true);
    const url = new URL(pgURI);
    url.username = role;
    const closed = await connect({ connectionString: url.toString() });
    await closed.end();
    await assert.rejects(scope.withTenant(A, () => entriesRead({ connection: closed, table }).findFiltered(and(), raw)), error =>
      /pool after calling end/.test(error.message) && error.unsupported !== true);
  });

  for (const backend of ['mongo', 'pg']) {
    it(backend + ' emits one logical result event for create/resend/no-op/delete with typed records', async function () {
      const bus = new EventEmitter(), events = [];
      bus.on(intentStep.INTENT_EVENT, event => events.push(event));
      const step = backend === 'pg' ? entriesIntent({ connection, table, bus })
        : intentStep.forCollectionIntent(ports.mongo.write, 'entries', 'v3', { bus });
      const run = fn => scope.withTenant(A, fn);
      const write = intent => run(() => step.write(intent));
      let result = await write({ op: 'create', docs: [{ _id: 'intent', identifier: 'intent', value: 0 }] });
      assert.equal(result.items[0].outcome, 'inserted');
      let stored = (await ports[backend].run(() => ports[backend].read.findOne('intent', undefined, { normalize: false })))[0];
      result = await write({ op: 'create', docs: [{ identifier: 'intent', value: 1 }], target: { identifier: 'intent', stored } });
      assert.equal(result.items[0].outcome, 'replaced');
      stored = (await ports[backend].run(() => ports[backend].read.findOne('intent', undefined, { normalize: false })))[0];
      result = await run(() => step.settle({ op: 'create' }, stored, 'unchanged', 'synthetic no-op'));
      assert.equal(result.items[0].outcome, 'unchanged');
      result = await write({ op: 'delete', form: 'permanent', target: { identifier: HEX } });
      assert.equal(result.items[0].outcome, 'deleted');
      assert.equal(events.length, 4);
      assert.deepEqual(events.map(event => event.counts.outcomes),
        [{ inserted: 1 }, { replaced: 1 }, { unchanged: 1 }, { deleted: 3 }]);
      assert.equal(events[3].records.length, 3);
      assert.equal(events[3].records.filter(record => record._id instanceof ObjectId).length, 1);
      assert.ok(events.every(event => event.collection === 'entries' && event.source === 'v3' && !event.collapsed));
      assert.ok(events.every(event => Object.isFrozen(event) && Object.isFrozen(event.records)));
    });
  }

  it('publishes the PG logical event after commit and none after a failed commit boundary', async function () {
    const bus = new EventEmitter(), observed = [];
    bus.on(intentStep.INTENT_EVENT, event => observed.push({ event,
      visible: admin.query(`SELECT doc FROM "${name}".entries WHERE tenant_id = $1 AND "_id" = 'committed'`, [A]) }));
    const step = entriesIntent({ connection, table, bus });
    await scope.withTenant(A, () => step.write({ op: 'create', docs: [{ _id: 'committed', value: false }] }));
    assert.equal(observed.length, 1);
    assert.equal((await observed[0].visible).rows[0].doc.value, false);
    const failed = entriesIntent({ connection: { ...connection,
      transaction: fn => connection.transaction(async function () { await fn(); throw new Error('synthetic commit failure'); }) }, table, bus });
    await assert.rejects(scope.withTenant(A, () => failed.write({ op: 'create', docs: [{ _id: 'rolled-back' }] })), /synthetic commit failure/);
    assert.equal(observed.length, 1);
    assert.deepEqual(await ports.pg.run(() => ports.pg.read.findOne('rolled-back')), []);
    await assert.rejects(ports.pg.run(() => step.write({ op: 'create', docs: [{ _id: 'nested' }] })), /new transaction/);
    assert.equal(observed.length, 1);
  });

  const intentFactories = [
    ['entries-v3', options => entriesIntent(options)],
    ['collection-v3', options => collectionIntent({ ...options, logical: 'entries' })],
    ['collection-legacy', options => collectionIntent({ ...options, logical: 'entries', source: 'v1/internal' })]
  ];
  for (const [adapter, create] of intentFactories) {
    it(adapter + ' shared identifying read preserves identifier then ObjectId then string priority', async function () {
      const step = create({ connection, table });
      const filter = { $or: [{ _id: new ObjectId(HEX) }, { _id: HEX }, { identifier: HEX }] };
      const rows = await ports.pg.run(() => step.storage.findOneFilter(filter, undefined, { normalize: false, limit: 3 }));
      assert.deepEqual(rows.map(doc => doc.label), ['identifier', 'objectid', 'string']);
      assert.ok(rows[1]._id instanceof ObjectId);
      assert.equal(typeof rows[2]._id, 'string');
      assert.equal((await ports.pg.run(() => step.storage.findOneFilter(filter)))[0].identifier, HEX);
      const other = await scope.withTenant(B, () => step.storage.findOneFilter(filter, undefined, { normalize: false }));
      assert.equal(other[0].owner, 'tenant-b');
    });

    it(adapter + ' shared projection preserves inclusion, exclusion and exact refusal classes', async function () {
      const step = create({ connection, table });
      const label = adapter === 'entries-v3' ? 'PostgreSQL entries intent' : 'PostgreSQL collection intent';
      const read = projection => ports.pg.run(() =>
        step.storage.findOneFilter({ _id: 'missing' }, projection, { normalize: false }));
      assert.deepEqual(await read({ nested: 1, _id: 0 }), [{ nested: { keep: null, drop: 1 } }]);
      assert.deepEqual(await read({ order: 0 }), [{ _id: 'missing', nested: { keep: null, drop: 1 } }]);
      assert.deepEqual(await read({ _id: 1 }), [{ _id: 'missing' }]);
      await assert.rejects(read({ 'nested.keep': 1 }), { name: 'TypeError', message: label + ': unsupported projection' });
      await assert.rejects(read({ nested: 1, order: 0 }), { name: 'TypeError', message: label + ': mixed projection' });
      await assert.rejects(ports.pg.run(() => step.storage.findOneFilter({}, undefined, { arbitrary: true })),
        { name: 'TypeError', message: label + ': unsupported findOneFilter option' });
    });

    it(adapter + ' common commit wrapper emits nothing for a mutating failed commit', async function () {
      const bus = new EventEmitter(), observed = [];
      bus.on(intentStep.INTENT_EVENT, event => observed.push(event));
      let mutated = false;
      const failed = create({ connection: { ...connection,
        transaction: fn => connection.transaction(async function () {
          const result = await fn();
          const inside = await connection.query(`SELECT doc FROM "${name}".entries WHERE doc->>'identifier' = 'rollback-common'`);
          assert.equal(inside.rows.length, 1, 'the control must reach a real mutation before forced failure');
          mutated = true;
          assert.equal(result.items[0].outcome, 'inserted');
          throw new Error('synthetic common commit failure');
        }) }, table, bus });
      await assert.rejects(scope.withTenant(A, () => failed.write({ op: 'create',
        docs: [{ _id: 'rollback-common', identifier: 'rollback-common', value: false, dateString: '2026-11-05T00:00:00.000+01:00' }] })), /synthetic common commit failure/);
      assert.equal(mutated, true);
      assert.equal(observed.length, 0, 'a failed commit must not publish a logical event');
      assert.deepEqual(await ports.pg.run(() => ports.pg.read.findOne('rollback-common')), []);
      assert.deepEqual(await scope.withTenant(B, () => ports.pg.read.findOne('rollback-common')), []);
    });

    it(adapter + ' common commit wrapper preserves committed results and synchronous settle without a transaction', async function () {
      const bus = new EventEmitter(), observed = [];
      let transactions = 0;
      const step = create({ connection: { ...connection,
        transaction (fn) { transactions++; return connection.transaction(fn); } }, table, bus });
      bus.on(intentStep.INTENT_EVENT, event => observed.push({ event,
        visible: admin.query(`SELECT doc FROM "${name}".entries WHERE tenant_id = $1 AND doc->>'identifier' = 'success-common'`, [A]) }));
      const written = await scope.withTenant(A, () => step.write({ op: 'create',
        docs: [{ _id: 'success-common', identifier: 'success-common', value: false, dateString: '2026-11-05T00:00:00.000+01:00' }] }));
      assert.equal(written.items[0].outcome, 'inserted');
      const committed = (await ports.pg.run(() => ports.pg.read.findOne('success-common', undefined, { normalize: false })))[0];
      assert.deepEqual(written.items[0]._id, committed._id);
      if (adapter === 'collection-legacy') {
        assert.ok(committed._id instanceof ObjectId);
        assert.equal(committed.utcOffset, 60, 'fixed parseZone fixture avoids host-timezone-dependent offset');
      }
      else assert.equal(committed._id, 'success-common');
      assert.equal(transactions, 1);
      assert.equal(observed.length, 1);
      assert.equal((await observed[0].visible).rows[0].doc.value, false);
      for (const outcome of ['unchanged', 'refused']) {
        const settled = scope.withTenant(A, () => step.settle({ op: 'create' },
          committed, outcome, 'synthetic settled intent'));
        assert.equal(typeof settled.then, 'undefined', 'settle stays synchronous');
        assert.equal(settled.items[0].outcome, outcome);
      }
      assert.equal(transactions, 1, 'settle must not manufacture transaction ownership');
      assert.equal(observed.length, 3);
      assert.ok(observed.every(value => value.event.collection === 'entries' &&
        value.event.source === (adapter === 'collection-legacy' ? 'v1/internal' : 'v3')));
      bus.on(intentStep.INTENT_EVENT, () => { throw new Error('synthetic observer failure'); });
      assert.doesNotThrow(() => scope.withTenant(A, () => step.settle({ op: 'create' },
        committed, 'unchanged', 'synthetic observer')));
      assert.equal(transactions, 1);
    });
  }

});
