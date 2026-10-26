'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');
const express = require('express');
const request = require('supertest');
const qs = require('qs');

describe('Entries predicate permission boundary', function () {
  this.timeout(15000);
  const name = 'owned_entries_query_' + randomUUID().replaceAll('-', '');
  let client, collection, server, authorization, reads = 0, cacheReads = 0;
  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test', {monitorCommands:true});
    await client.connect();
    const db = client.db();
    collection = db.collection(name);
    await collection.insertMany([1, 2, 3].map(i => ({date:1700000000000 + i * 300000, sgv:100 + i, type:'sgv'})));
    client.on('commandStarted', event => {
      if (event.commandName === 'find' && event.command.find === name) reads++;
    });
    const env = {settings:{authDefaultRoles:'owned-role', authFailDelay:0}, authentication_collections_prefix:name + '_auth_'};
    const ctx = Object.assign({}, require('./inithelper')().ctx, {store:db,
      cache:{entries:[], getData:() => {cacheReads++; return [];}}, ddata:{sgvs:[]}});
    authorization = ctx.authorization = require('../lib/authorization')(env, ctx);
    authorization.storage.roles = [{name:'owned-role', permissions:[]}];
    ctx.entries = require('../lib/server/entries')({entries_collection:name}, ctx);
    const app = express();
    app.enable('api');
    app.set('query parser', 'extended');
    app.use(require('../lib/api/entries')(app, require('../lib/middleware')(env), ctx, env));
    server = await new Promise(resolve => {const listening = app.listen(0, '127.0.0.1', () => resolve(listening));});
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    try {if (collection) await collection.drop();} finally {if (client) await client.close();}
  });
  function url(find) {return '/entries?' + qs.stringify({find, count:100});}

  it('rejects absent and unrelated read permissions before cache or DB access twice', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const permissions of [[], ['api:profile:read']]) {
        authorization.storage.roles[0].permissions = permissions;
        for (const find of [{}, {sgv:{$ne:0}}, {$where:'true'}]) {
          const before = [reads, cacheReads];
          await request(server).get(url(find)).set('Accept','application/json').expect(401);
          assert.deepEqual([reads, cacheReads], before);
        }
      }
    }
  });

  it('allows intentional broad predicates but rejects executable code before MongoDB twice', async function () {
    authorization.storage.roles[0].permissions = ['api:entries:read'];
    for (let cycle = 0; cycle < 2; cycle++) {
      const result = await request(server).get(url({date:{$gte:0}, $or:[{sgv:{$ne:0}}, {sgv:{$exists:true}}]})).set('Accept','application/json').expect(200);
      assert.deepEqual(result.body.map(row => row.sgv), [103, 102, 101]);
      for (const find of [{$where:'true'}, {$or:[{$where:'true'}]}, {$expr:{$function:{body:'function(){return true}',args:[],lang:'js'}}}]) {
        const before = reads;
        const response = await request(server).get(url(find)).set('Accept','application/json');
        // This checks rejection/security, not a redesign of legacy error status.
        assert(response.status >= 400 && response.status < 600);
        assert.equal(reads, before);
      }
    }
  });

  it('does not grant writes to an entries reader with a broad predicate', async function () {
    authorization.storage.roles[0].permissions = ['api:entries:read'];
    for (let cycle = 0; cycle < 2; cycle++) {
      await request(server).delete(url({sgv:{$ne:0}})).expect(401);
      await request(server).post('/entries').send([{date:1700000000000,sgv:200}]).expect(401);
      assert.equal(await collection.countDocuments(), 3);
    }
  });
});
