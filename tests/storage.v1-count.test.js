'use strict';

// GET /api/v1/count/:storage/where through the storage interface.
//
// lib/server/aggregate.js counted with the driver directly:
// [{$match: query_for(opts)}, {$group: {_id: null, count: {$sum: 1}}}]. It now
// carries query_for's document to the interface as a filter AST in the API v1
// dialect and asks the interface's count(). These pin that each v1 module's
// count reaches the interface it reads and writes through, and that the reply
// is the one the $group gave: [{_id: null, count: n}], and [] when nothing
// matches (a $group over no documents emits no row).

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');
const express = require('express');
const request = require('supertest');
const qs = require('qs');

const reads = require('../lib/server/storage-reads');

describe('API v1 count through the storage interface', function ( ) {
  this.timeout(15000);
  const prefix = 'v1_count_' + randomUUID().replaceAll('-', '');
  const names = { entries: prefix + '_entries', treatments: prefix + '_treatments', devicestatus: prefix + '_devicestatus' };
  const counted = [ ];
  let client, db, server, original;

  before(async function ( ) {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test');
    await client.connect();
    db = client.db();
    await db.collection(names.entries).insertMany([
      { date: 1700000000000, sgv: 100, type: 'sgv' },
      { date: 1700000300000, sgv: 150, type: 'sgv' },
      { date: 1700000600000, mbg: 200, type: 'mbg' }
    ]);
    await db.collection(names.treatments).insertMany([
      { created_at: '2023-11-14T22:13:20.000Z', eventType: 'Note' },
      { created_at: '2023-11-14T22:18:20.000Z', eventType: 'Meal Bolus', carbs: 10 }
    ]);
    await db.collection(names.devicestatus).insertMany([
      { created_at: '2023-11-14T22:13:20.000Z', device: 'loop://iPhone' }
    ]);

    // Record every count() the interface is asked for, by collection.
    original = reads.collection;
    reads.collection = function (...args) {
      const storage = original.apply(this, args);
      const count = storage.count;
      storage.count = function (ast, opts) {
        counted.push({ col: args[2], ast, opts });
        return count.call(this, ast, opts);
      };
      return storage;
    };

    const env = { settings: { }, entries_collection: names.entries, treatments_collection: names.treatments
      , devicestatus_collection: names.devicestatus };
    const ctx = { store: db, bus: { emit ( ) { } } };
    const pass = (req, res, next) => next();
    const app = express();
    require('../lib/middleware/configure-request')(app);
    app.set('query parser', 'extended');
    app.use(require('../lib/api/entries')(app, {
      sendJSONStatus: pass, rawParser: pass, bodyParser: express
      , urlencodedParser: express.urlencoded({ extended: true }), extensions: ( ) => pass, obscure_device: pass
    }, {
      entries: require('../lib/server/entries')(env, ctx)
      , treatments: require('../lib/server/treatments')(env, ctx)
      , devicestatus: require('../lib/server/devicestatus')(env, ctx)
      , authorization: { isPermitted: ( ) => pass }
    }, env));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', ( ) => resolve(s)); });
  });

  after(async function ( ) {
    if (original) reads.collection = original;
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      for (const name of Object.values(names)) await db.collection(name).drop().catch(( ) => { });
    } finally { if (client) await client.close(); }
  });

  beforeEach(function ( ) { counted.length = 0; });

  const get = (storage, find) => request(server)
    .get('/count/' + storage + '/where?' + qs.stringify({ find }));

  it('counts each v1 collection through its storage interface, in the API v1 dialect', async function ( ) {
    for (const [storage, find, n] of [
      ['entries', { date: { $gte: 0 } }, 3]
      , ['entries', { date: { $gte: 0 }, sgv: { $gte: 150 } }, 1]
      , ['treatments', { created_at: { $gte: '2023' } }, 2]
      , ['devicestatus', { created_at: { $gte: '2023' } }, 1]
    ]) {
      counted.length = 0;
      const response = await get(storage, find).expect(200);
      assert.equal(response.text, JSON.stringify([{ _id: null, count: n }]));
      assert.equal(counted.length, 1, storage + ' was not counted through the interface');
      assert.equal(counted[0].col, names[storage]);
      assert.equal(counted[0].opts && counted[0].opts.v1, true);
    }
  });

  it('answers [] when nothing matches, as the $group did', async function ( ) {
    const response = await get('entries', { date: { $gte: 0 }, sgv: { $gte: 999 } }).expect(200);
    assert.equal(response.text, '[]');
    assert.equal(counted.length, 1);
  });

  it('answers a refused operator 400 without asking the interface', async function ( ) {
    const response = await get('entries', { $where: 'owned-expression' });
    assert.equal(response.status, 400, response.text);
    assert.equal(counted.length, 0);
  });

  it('never asks the interface for a refused pipeline (BF-70)', async function ( ) {
    const response = await request(server).get('/count/entries/where?' + qs.stringify({
      find: { date: { $gte: 0 } }, pipeline: [{ $limit: 1 }] }));
    assert.equal(response.status, 400, response.text);
    assert.equal(counted.length, 0);
  });
});
