'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { MongoClient } = require('mongodb');
const createStorage = require('../lib/connect/storage');
const { transform } = require('../lib/connect/sources/carelink/transform');
const uri = process.env.CARELINK_TEST_MONGODB_URI || process.env.CUSTOMCONNSTR_mongo;

(uri ? describe : describe.skip)('native CareLink real Mongo persistence', function () {
  this.timeout(15000);
  let client, db, collection, enclave, prefix;
  before(async function () {
    const url = new URL(uri);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && /test/i.test(url.pathname), 'Use a localhost test database only');
    client = await MongoClient.connect(uri);
    db = client.db(); prefix = 'carelink_native_test_' + crypto.randomBytes(8).toString('hex');
    collection = db.collection(prefix);
    enclave = require('../lib/server/enclave')(); enclave.setApiKey('carelink-unit-test-secret');
  });
  after(async function () {
    if (!db) return;
    for (const suffix of ['', '_entries', '_treatments', '_status']) await db.collection(prefix + suffix).drop().catch(err => { if (err.code !== 26) throw err; });
    await client.close();
  });
  it('encrypts tokens at rest and restores them through a new storage instance', async function () {
    const a = createStorage(collection, enclave);
    await a.exclusive(async check => { await check(); await a.save({ tokens: { refreshToken: 'test-refresh' } }); });
    const raw = await collection.findOne({ _id: 'carelink' });
    assert.ok(!JSON.stringify(raw).includes('test-refresh'));
    const b = createStorage(collection, enclave);
    assert.deepEqual(await b.load(), { tokens: { refreshToken: 'test-refresh' } });
  });
  it('excludes a second process from refreshing concurrently', async function () {
    const a = createStorage(collection, enclave), b = createStorage(collection, enclave);
    let release, acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const active = a.exclusive(async () => { acquired(); await new Promise(resolve => { release = resolve; }); });
    await ready;
    try { await assert.rejects(b.exclusive(async () => {}), { code: 'connection_busy' }); }
    finally { release(); await active; }
    await b.exclusive(async check => { await check(); });
  });
  it('deduplicates repeated imports through real Nightscout storage adapters', async function () {
    const env = { entries_collection: prefix + '_entries', treatments_collection: prefix + '_treatments',
      devicestatus_collection: prefix + '_status', uuidHandling: true };
    const ctx = { store: { collection: name => db.collection(name) }, bus: new EventEmitter(),
      ddata: { processRawDataForRuntime: value => value }, purifier: require('../lib/server/purifier')() };
    ctx.entries = require('../lib/server/entries')(env, ctx);
    ctx.treatments = require('../lib/server/treatments')(env, ctx);
    ctx.devicestatus = require('../lib/server/devicestatus')(env, ctx);
    const output = require('../lib/connect/output')(ctx);
    const time = new Date().toISOString();
    const payload = { sgs: [{ sg: 123, datetime: time }], medicalDeviceFamily: 'GUARDIAN', lastMedicalDeviceDataUpdateServerTime: time,
      markers: [{ type: 'MEAL', amount: 12, index: 1, dateTime: time }] };
    await output(transform(payload, 'test-person'));
    await output(transform(payload, 'test-person'));
    assert.equal(await ctx.entries().countDocuments(), 1);
    assert.equal(await ctx.treatments().countDocuments(), 1);
    assert.equal(await ctx.devicestatus().countDocuments(), 1);
  });
});
