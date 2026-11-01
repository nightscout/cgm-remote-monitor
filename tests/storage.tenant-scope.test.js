'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const writeStep = require('../lib/storage/write-step');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const { describeForEachBackend } = require('./support/backends');

// The mode is process-wide and the suite runs in one process, almost all of it
// single-tenant, so every test that switches it puts it back.
async function inMode (mode, fn) {
  const previous = scope.getTenancyMode();
  scope.setTenancyMode(mode);
  try {
    return await fn();
  } finally {
    scope.setTenancyMode(previous);
  }
}

describe('the tenant scope', function () {

  it('defaults to single-tenant, which is what `nightscout single` runs', function () {
    assert.equal(scope.getTenancyMode(), 'single');
  });

  it('refuses a mode it does not have', function () {
    assert.throws(() => scope.setTenancyMode('multitenant'), /'single' or 'multi'/);
    assert.equal(scope.getTenancyMode(), 'single');
  });

  it('is not read from the environment: the entrypoint owns the mode', function () {
    const id = require.resolve('../lib/storage/tenant-scope');
    const loaded = require.cache[id];
    const saved = process.env.TENANCY_MODE;
    process.env.TENANCY_MODE = 'multi';
    try {
      delete require.cache[id];
      assert.equal(require('../lib/storage/tenant-scope').getTenancyMode(), 'single');
    } finally {
      // Every other module holds the loaded instance; put it back.
      require.cache[id] = loaded;
      if (saved === undefined) delete process.env.TENANCY_MODE; else process.env.TENANCY_MODE = saved;
    }
  });

  describe('single-tenant', function () {

    it('resolves an unbound operation to SINGLE_TENANT rather than throwing', function () {
      assert.equal(scope.currentTenant(), undefined);
      assert.equal(scope.requireTenant('entries.find'), scope.SINGLE_TENANT);
    });

    it('refuses to bind a tenant id', function () {
      assert.throws(() => scope.withTenant('acme', () => {}), /cannot bind a tenant id/);
    });

    it('accepts SINGLE_TENANT as an explicit binding', function () {
      assert.equal(scope.withTenant(scope.SINGLE_TENANT, () => scope.currentTenant()), scope.SINGLE_TENANT);
    });

    it('cannot put SINGLE_TENANT into a document or a log line', function () {
      assert.equal(JSON.stringify({ tenant: scope.SINGLE_TENANT }), '{}');
      assert.throws(() => '' + scope.SINGLE_TENANT, TypeError);
    });
  });

  describe('multitenant', function () {

    it('throws on an unbound operation, and names it', async function () {
      await inMode('multi', function () {
        assert.throws(() => scope.requireTenant('entries.findFiltered'), function (err) {
          assert.match(err.message, /entries\.findFiltered/);
          assert.match(err.message, /no tenant bound/);
          return true;
        });
      });
    });

    it('binds for the duration of the callback, across awaits', async function () {
      await inMode('multi', async function () {
        const seen = await scope.withTenant('acme', async function () {
          await new Promise(resolve => setImmediate(resolve));
          return scope.currentTenant();
        });
        assert.equal(seen, 'acme');
        assert.equal(scope.currentTenant(), undefined);
      });
    });

    it('refuses to rebind a different tenant inside a scope, and allows the same one', async function () {
      await inMode('multi', function () {
        assert.throws(() => scope.withTenant('acme', () => scope.withTenant('other', () => {})), /cannot rebind/);
        assert.equal(scope.withTenant('acme', () => scope.withTenant('acme', () => scope.currentTenant())), 'acme');
      });
    });

    it('refuses SINGLE_TENANT and malformed tenant ids', async function () {
      await inMode('multi', function () {
        assert.throws(() => scope.withTenant(scope.SINGLE_TENANT, () => {}), /not a binding/);
        assert.throws(() => scope.withTenant('', () => {}), /non-empty string/);
        assert.throws(() => scope.withTenant(null, () => {}), /non-empty string/);
        assert.throws(() => scope.withTenant(42, () => {}), /non-empty string/);
      });
    });
  });

  describe('the storage choke points', function () {

    // A driver collection that records what reached it.
    function fakeCtx () {
      const calls = [];
      const collection = {
        collectionName: 'entries'
        , find () { calls.push('find'); return { toArray: async () => [] }; }
        , countDocuments: async () => { calls.push('countDocuments'); return 0; }
        , insertOne: async () => { calls.push('insertOne'); return { acknowledged: true, insertedId: 'x' }; }
      };
      return { calls, collection, store: { collection: () => collection, ensureIndexes: () => {} } };
    }

    it('MongoCollection refuses an unbound read under multi before the driver sees it', async function () {
      const ctx = fakeCtx();
      const storage = new MongoCollection(ctx, {}, 'entries', 'entries', [ ]);
      await inMode('multi', async function () {
        await assert.rejects(async () => storage.findFiltered(null, {}), /entries\.findFiltered/);
        await assert.rejects(async () => storage.count(null), /entries\.count/);
        await assert.rejects(async () => storage.insertOne({ a: 1 }), /entries\.insertOne/);
      });
      assert.deepEqual(ctx.calls, []);
    });

    it('a write-step handle refuses unbound reads and writes under multi', async function () {
      const ctx = fakeCtx();
      const handle = writeStep.collection(ctx.collection, { name: 'entries', source: 'v1/internal' });
      await inMode('multi', async function () {
        assert.throws(() => handle.find({}), /entries\.find/);
        await assert.rejects(handle.insertOne({ a: 1 }), /entries\.insertOne/);
        // Bound, the same calls reach the driver.
        await scope.withTenant('acme', async function () {
          await handle.find({}).toArray();
          await handle.insertOne({ a: 1 });
        });
      });
      assert.deepEqual(ctx.calls, ['find', 'insertOne']);
    });

    it('lets every call through unchanged under single', async function () {
      const ctx = fakeCtx();
      const storage = new MongoCollection(ctx, {}, 'entries', 'entries', [ ]);
      const handle = writeStep.collection(ctx.collection, { name: 'entries', source: 'v1/internal' });
      await storage.findFiltered(null, {});
      await storage.insertOne({ a: 1 });
      await handle.find({}).toArray();
      await handle.insertOne({ a: 1 });
      assert.deepEqual(ctx.calls, ['find', 'insertOne', 'find', 'insertOne']);
    });

    it('is on the store, where a PostgreSQL transaction would be opened', function () {
      // mongo-storage adds it to the store it connects; read it off the module
      // source of truth rather than connecting here.
      assert.equal(typeof scope.withTenant, 'function');
      assert.match(require('node:fs').readFileSync(require.resolve('../lib/storage/mongo-storage'), 'utf8'),
        /mongo\.withTenant = tenantScope\.withTenant;/);
    });
  });
});

// Under `nightscout single` the tenant scope adds nothing to what is stored:
// a document written through the interface, unbound or inside the explicit
// SINGLE_TENANT binding, is byte for byte the document the driver stores when
// handed the same write directly.
describeForEachBackend('single-tenant writes store the same bytes', function (backend) {
  this.timeout(15000);
  const env = require('../lib/server/env')();
  const ctx = { bus: null };
  const prefix = 'tenant_scope_bytes_';
  const names = { direct: prefix + 'direct', unbound: prefix + 'unbound', bound: prefix + 'bound' };

  before(async function () {
    ctx.store = await require('../lib/storage/mongo-storage')(env);
    for (const name of Object.values(names)) await backend.collection(ctx, name).deleteMany({});
  });

  after(async function () {
    for (const name of Object.values(names)) await backend.collection(ctx, name).deleteMany({});
  });

  function documents () {
    const { ObjectId } = require('mongodb');
    return [
      { _id: new ObjectId('64b7f0a1c2d3e4f5a6b7c8d1'), type: 'sgv', sgv: 120, date: 1700000000000
        , dateString: '2023-11-14T22:13:20.000Z', identifier: 'tenant-scope-bytes-1', device: 'test' }
      , { _id: new ObjectId('64b7f0a1c2d3e4f5a6b7c8d2'), eventType: 'Note', notes: 'x', created_at: '2023-11-14T22:13:20.000Z' }
      , { _id: new ObjectId('64b7f0a1c2d3e4f5a6b7c8d3'), device: 'pump', uploaderBattery: 80, utcOffset: 0 }
    ];
  }

  async function writeThroughInterface (name) {
    const storage = new MongoCollection(ctx, env, name, name, [ ], { source: MongoCollection.SOURCES.V1 });
    const [first, second, third] = documents();
    await storage.insertOne(first, { normalize: false });
    await storage.insertMany([second, third]);
    await storage.updateOne(String(first._id), { delta: 2 });
  }

  async function writeDirect (name) {
    const collection = backend.collection(ctx, name);
    const [first, second, third] = documents();
    await collection.insertOne(first);
    await collection.insertMany([second, third]);
    await collection.updateOne({ _id: first._id }, { $set: { delta: 2 } });
  }

  it('unbound and SINGLE_TENANT-bound writes match the driver\'s own', async function () {
    await writeDirect(names.direct);
    await writeThroughInterface(names.unbound);
    await scope.withTenant(scope.SINGLE_TENANT, () => writeThroughInterface(names.bound));
    for (const { _id } of documents()) {
      const direct = await backend.storedDocument(ctx, names.direct, { _id });
      assert.ok(Buffer.isBuffer(direct) && direct.length > 0, 'nothing stored for ' + _id);
      for (const name of [names.unbound, names.bound]) {
        const stored = await backend.storedDocument(ctx, name, { _id });
        assert.ok(Buffer.isBuffer(stored), name + ': nothing stored for ' + _id);
        assert.equal(stored.toString('hex'), direct.toString('hex'),
          name + ' stored different bytes for ' + _id + ': ' + JSON.stringify(require('mongodb').BSON.deserialize(stored)));
      }
    }
  });
});
