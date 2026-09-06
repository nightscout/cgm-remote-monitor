'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');
const express = require('express');
const request = require('supertest');
const qs = require('qs');

describe('Profile query JavaScript HTTP boundary', function () {
  this.timeout(15000);
  let client, col, server, findCommands = 0;
  const collectionName = 'query_boundary_' + randomUUID().replaceAll('-', '');
  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test', {monitorCommands:true});
    await client.connect();
    const db = client.db();
    col = db.collection(collectionName);
    client.on('commandStarted', event => {
      if (event.commandName === 'find' && event.command.find === collectionName) findCommands++;
    });
    await col.insertMany([
      {startDate:'2030-01-01T00:00:00.000Z', score:1, payload:{$where:'literal'}, notes:'$where is plain text'},
      {startDate:'2030-01-02T00:00:00.000Z', score:2, payload:{$function:'literal'}},
      {startDate:'2030-01-03T00:00:00.000Z', score:3}
    ]);
    const app = express();
    app.set('query parser', 'extended');
    const pass = (req, res, next) => next();
    app.use(require('../lib/api/profile')(app, {
      sendJSONStatus:pass, rawParser:pass, jsonParser:express.json(), urlencodedParser:express.urlencoded({extended:true})
    }, {
      profile:require('../lib/server/profile')(collectionName, {store:db}),
      authorization:{isPermitted:() => pass}
    }));
    server = await new Promise(resolve => {const listening = app.listen(0, '127.0.0.1', () => resolve(listening));});
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    try {if (col) await col.drop();} finally {if (client) await client.close();}
  });

  it('rejects repeated direct and nested JavaScript predicates with 400 and no find', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const find of [{$where:'this.score === 1'},
        {$or:[{$where:'this.score === 1'}]},
        {$expr:{$function:{body:'function() { return true; }', args:[], lang:'js'}}}]) {
        const before = findCommands;
        const response = await request(server).get('/profiles/?' + qs.stringify({find})).expect(400);
        assert.equal(response.body.status, 400);
        assert.equal(response.body.message, 'Server-side JavaScript is not allowed in database queries');
        assert.equal(findCommands, before);
      }
    }
  });

  it('preserves sorted and limited ordinary profile filters after rejection', async function () {
    const result = await request(server).get('/profiles/?' + qs.stringify({find:{startDate:{$gte:'2030-01-02T00:00:00.000Z'}}, count:1})).expect(200);
    assert.equal(result.body.length, 1);
    assert.equal(result.body[0].score, 3);
  });

  it('treats operator names inside explicit literals as data', async function () {
    for (const [find, score] of [
      [{payload:{$eq:{$where:'literal'}}}, 1],
      [{$expr:{$eq:[{$literal:{$function:'literal'}}, '$payload']}}, 2],
      [{notes:{$regex:'\\$where is plain text'}}, 1]
    ]) {
      const result = await request(server).get('/profiles/?' + qs.stringify({find})).expect(200);
      assert.equal(result.body.length, 1);
      assert.equal(result.body[0].score, score);
    }
  });
});
