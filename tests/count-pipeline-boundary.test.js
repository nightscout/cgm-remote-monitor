'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');
const express = require('express');
const request = require('supertest');
const qs = require('qs');

describe('Public count query boundary', function () {
  this.timeout(15000);
  const prefix = 'count_boundary_' + randomUUID().replaceAll('-', '');
  let client, entries, privateCollection, server, aggregateCommands = 0;
  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test', {monitorCommands:true});
    await client.connect();
    const db = client.db();
    entries = db.collection(prefix + '_entries');
    privateCollection = db.collection(prefix + '_private');
    await entries.insertMany([
      {date:1700000000000, sgv:100, pipeline:'ordinary field'},
      {date:1700000300000, sgv:150}, {date:1700000600000, sgv:200}
    ]);
    await privateCollection.insertMany([{fixture:'one'}, {fixture:'two'}]);
    client.on('commandStarted', event => {
      if (event.commandName === 'aggregate' && event.command.aggregate === entries.collectionName) aggregateCommands++;
    });
    const app = express();
    require('../lib/middleware/configure-request')(app);
    app.set('query parser', 'extended');
    const pass = (req, res, next) => next();
    const storage = require('../lib/server/entries')({entries_collection:entries.collectionName}, {store:db});
    app.use(require('../lib/api/entries')(app, {
      sendJSONStatus:pass, rawParser:pass, bodyParser:express,
      urlencodedParser:express.urlencoded({extended:true}), extensions:() => pass, obscure_device:pass
    }, {entries:storage, treatments:storage, devicestatus:storage,
      authorization:{isPermitted:() => pass}}, {settings:{}}));
    server = await new Promise(resolve => {const listening = app.listen(0, '127.0.0.1', () => resolve(listening));});
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
      if (entries) await entries.drop();
      if (privateCollection) await privateCollection.drop();
    } finally {if (client) await client.close();}
  });

  it('preserves documented find counts and storage selection', async function () {
    for (const storage of ['entries', 'treatments', 'devicestatus', 'unknown']) {
      for (const [find, count] of [[{date:{$gte:0}}, 3], [{date:{$gte:0}, sgv:{$gte:150}}, 2]]) {
        const response = await request(server).get('/count/' + storage + '/where?' + qs.stringify({find})).expect(200);
        assert.equal(response.body[0].count, count);
      }
    }
  });

  it('rejects cross-collection pipelines before aggregation on successive requests', async function () {
    const pipeline = [{$lookup:{from:privateCollection.collectionName,
      localField:'missing', foreignField:'missing', as:'joined'}}, {$unwind:'$joined'}];
    for (let cycle = 0; cycle < 2; cycle++) {
      const before = aggregateCommands;
      const response = await request(server).get('/count/entries/where?' + qs.stringify({find:{date:{$gte:0}}, pipeline}));
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.equal(response.body.status, 400);
      assert.equal(response.body.message, 'Custom aggregation pipelines are not supported by the count endpoint');
      assert.equal(aggregateCommands, before);
    }
  });

  it('rejects transformation, string and empty pipeline parameters', async function () {
    for (const pipeline of [[{$limit:1}], 'unrecognized stage', '']) {
      const before = aggregateCommands;
      await request(server).get('/count/entries/where?' + qs.stringify({find:{date:{$gte:0}}, pipeline})).expect(400);
      assert.equal(aggregateCommands, before);
    }
  });

  it('still allows an ordinary document field named pipeline in find', async function () {
    const response = await request(server).get('/count/entries/where?' + qs.stringify({find:{date:{$gte:0}, pipeline:'ordinary field'}})).expect(200);
    assert.equal(response.body[0].count, 1);
  });
});
