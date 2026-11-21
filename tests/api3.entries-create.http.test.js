'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoClient } = require('mongodb');
const express = require('express');
const request = require('supertest');
const shiro = require('shiro-trie');
const configureApi3 = require('../lib/api3');
const authentication = require('../lib/api3/tenant-authentication');
const purifier = require('../lib/server/purifier');
const intent = require('../lib/storage/write-intent');

describe('API3 entries create actual Mongo HTTP reference', function () {
  let mongo, db, app, col, grants, events, name, env;
  const document = () => ({ identifier: 'packet-synthetic-entry', date: 1793664000000,
    utcOffset: 0, app: 'synthetic-packet', type: 'sgv', sgv: 123 });

  before(async function () {
    mongo = new MongoClient(process.env.CUSTOMCONNSTR_mongo);
    await mongo.connect();
    db = mongo.db();
    name = 'entries_packet_' + randomUUID().replace(/-/g, '');
    app = express();
    app.use((req, res, next) => {
      const permissions = shiro.new();
      for (const grant of grants) permissions.add(grant);
      authentication.bind(req, { shiros: [permissions], subject: { name: 'Synthetic Packet' } });
      next();
    });
    const bus = new EventEmitter();
    events = [];
    for (const event of [intent.INTENT_EVENT, 'storage-socket-create', 'storage-socket-update', 'data-received']) {
      bus.on(event, value => events.push({ event, value }));
    }
    env = {
      entries_collection: name,
      api3: { API3_SECURITY_ENABLE: true, API3_DEDUP_FALLBACK_ENABLED: true }
    };
    const api = configureApi3(env, { store: { db, collection: n => db.collection(n), ensureIndexes () {} },
      purifier: purifier({}, {}), bus });
    col = api.get('collections').entries;
    app.use(api);
  });

  beforeEach(async function () {
    await db.collection(name).deleteMany({});
    events.length = 0;
    col.autoPruneDays = undefined;
    col.nextAutoPrune = new Date(0);
    env.write = {};
  });

  after(async function () {
    if (db) await db.collection(name).drop();
    if (mongo) await mongo.close();
  });

  it('creates with create-only authority but refuses the same authority on a matched resend', async function () {
    grants = ['api:entries:create'];
    const created = await request(app).post('/entries').send(document()).expect(201);
    assert.equal(created.body.identifier, document().identifier);
    assert.equal(created.headers.location, '/api/v3/entries/' + document().identifier);
    const stored = await db.collection(name).findOne({});
    assert.equal(stored.subject, 'Synthetic Packet');
    assert.deepEqual(events.map(item => item.event),
      [intent.INTENT_EVENT, 'storage-socket-create', 'data-received']);
    events.length = 0;
    const refused = await request(app).post('/entries').send(document()).expect(403);
    assert.equal(refused.body.message, 'Missing permission api:entries:update');
    assert.deepEqual(await db.collection(name).findOne({}), stored);
    assert.deepEqual(events, []);
  });

  it('requires create on a miss and update on a match; the default resend replaces omitted fields', async function () {
    grants = ['api:entries:update'];
    const refused = await request(app).post('/entries').send(document()).expect(403);
    assert.equal(refused.body.message, 'Missing permission api:entries:create');
    assert.equal(await db.collection(name).countDocuments(), 0);
    assert.deepEqual(events, []);
    grants = ['api:entries:create'];
    await request(app).post('/entries').send({ ...document(), omittedOnResend: 'synthetic' }).expect(201);
    const original = await db.collection(name).findOne({});
    events.length = 0;
    grants = ['api:entries:update'];
    const resent = await request(app).post('/entries').send({ ...document(), sgv: 124 }).expect(200);
    assert.equal(resent.body.isDeduplication, true);
    const stored = await db.collection(name).findOne({});
    assert.equal(stored.sgv, 124);
    assert.equal(Object.hasOwn(stored, 'omittedOnResend'), false);
    assert.equal(stored.srvCreated, original.srvCreated);
    assert.deepEqual(events.map(item => item.event),
      [intent.INTENT_EVENT, 'storage-socket-update', 'data-received']);
  });

  it('refuses read-only authority before writing or emitting mutation events', async function () {
    grants = ['api:entries:read'];
    await request(app).post('/entries').send(document()).expect(403);
    assert.equal(await db.collection(name).countDocuments(), 0);
    assert.deepEqual(events, []);
  });

  it('uses the shipping parser and purifier for a data document above the owner limit', async function () {
    grants = ['api:entries:create'];
    const response = await request(app).post('/entries').send({
      ...document(), notes: '<packet>synthetic</packet>', padding: 'x'.repeat(70 * 1024)
    }).expect(201);
    assert.equal(response.body.identifier, document().identifier);
    const stored = await db.collection(name).findOne({});
    assert.equal(stored.padding.length, 70 * 1024);
    assert.equal(stored.notes, 'synthetic');
    const before = await db.collection(name).countDocuments();
    const malformed = await request(app).post('/entries').type('json').send('{').expect(500);
    assert.equal(malformed.body.status, 500);
    assert.equal(await db.collection(name).countDocuments(), before);
  });

  it('accepts legitimate extension field names and JSON values through the actual entries handler', async function () {
    grants = ['api:entries:create'];
    const extension = { 'vendor-field': { '測定': [true, null, 2.5, 'synthetic'] }, '測定': 'synthetic' };
    await request(app).post('/entries').send({ ...document(), ...extension }).expect(201);
    const stored = await db.collection(name).findOne({});
    for (const [key, value] of Object.entries(extension)) assert.deepEqual(stored[key], value);
  });

  for (const key of ['vendor-field', '測定', 'unknown_ordinary']) {
    it(`preserves literal ${key} insert, replacement and configured merge resend semantics`, async function () {
      grants = ['api:entries:create', 'api:entries:update'];
      await request(app).post('/entries').send({
        ...document(), [key]: { 'nested-field': 1, '測定': [true, null, 2.5] }, keep: 'first'
      }).expect(201);
      await request(app).post('/entries').send({ ...document(), [key]: { 'nested-field': 2 } }).expect(200);
      let stored = await db.collection(name).findOne({});
      assert.deepEqual(stored[key], { 'nested-field': 2 });
      assert.equal(Object.hasOwn(stored, 'keep'), false);
      env.write = { resend: 'merge-except-treatments' };
      await request(app).post('/entries').send({ ...document(), [key]: { '測定': [null, false] }, keep: 'retained' }).expect(200);
      stored = await db.collection(name).findOne({});
      assert.deepEqual(stored[key], { 'nested-field': 2, '測定': [null, false] });
      await request(app).post('/entries').send({ ...document(), [key]: { 'nested-field': null } }).expect(200);
      stored = await db.collection(name).findOne({});
      assert.deepEqual(stored[key], { '測定': [null, false] });
      assert.equal(stored.keep, 'retained');
      await request(app).post('/entries').send({ ...document(), [key]: null }).expect(200);
      stored = await db.collection(name).findOne({});
      assert.equal(Object.hasOwn(stored, key), false);
      assert.equal(stored.keep, 'retained');
    });
  }

  it('currently collapses flagged unsupported adapter input and unavailable storage to the same 500', async function () {
    grants = ['api:entries:create'];
    const insert = col.storage.insertOne;
    try {
      for (const error of [Object.assign(new TypeError('synthetic unsupported shape'), { unsupported: true }),
        Object.assign(new Error('synthetic storage unavailable'), { code: 'ECONNREFUSED' })]) {
        col.storage.insertOne = async () => { throw error; };
        const response = await request(app).post('/entries').send(document()).expect(500);
        assert.equal(response.body.message, 'Database error');
        assert.equal(await db.collection(name).countDocuments(), 0);
        assert.deepEqual(events, []);
      }
    } finally { col.storage.insertOne = insert; }
  });

  it('does not reach prune storage when the configured retention is absent, invalid or nonpositive', async function () {
    const resolve = col.storage.resolveOr;
    let calls = 0;
    col.storage.resolveOr = async (...args) => { calls++; return resolve(...args); };
    try {
      for (const setting of [undefined, '', false, 0, '0', '-1', 'invalid', 'Infinity']) {
        col.autoPruneDays = setting;
        col.autoPrune();
      }
      await delay(10);
      assert.equal(calls, 0);
    } finally { col.storage.resolveOr = resolve; }
  });

  it('runs configured pruning after create-only POST, deleting by date-only OR and throttling the next write', async function () {
    grants = ['api:entries:create'];
    col.autoPruneDays = '30';
    const now = Date.now();
    const old = now - 40 * 24 * 3600 * 1000;
    const outdated = { identifier: 'packet-old', date: old,
      created_at: new Date(now).toISOString(), srvCreated: now, type: 'sgv', sgv: 100 };
    await db.collection(name).insertOne({ ...outdated });
    await request(app).post('/entries').send(document()).expect(201);
    const deadline = Date.now() + 3000;
    while (!events.some(item => item.event === intent.INTENT_EVENT && item.value.op === 'prune')) {
      assert.ok(Date.now() < deadline, 'configured prune must complete');
      await delay(10);
    }
    assert.equal(await db.collection(name).countDocuments({ identifier: 'packet-old' }), 0);
    assert.equal(await db.collection(name).countDocuments({ identifier: document().identifier }), 1);
    assert.equal(events.filter(item => item.event === intent.INTENT_EVENT && item.value.op === 'prune').length, 1);
    assert.ok(col.nextAutoPrune.getTime() > Date.now() + 3500 * 1000);
    await db.collection(name).insertOne({ ...outdated });
    await request(app).post('/entries').send({ ...document(), identifier: 'packet-another' }).expect(201);
    await delay(25);
    assert.equal(await db.collection(name).countDocuments({ identifier: 'packet-old' }), 1);
    assert.equal(events.filter(item => item.event === intent.INTENT_EVENT && item.value.op === 'prune').length, 1);
  });
});
