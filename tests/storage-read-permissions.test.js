'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');
const express = require('express');
const request = require('supertest');
const qs = require('qs');

describe('Selected storage read permissions', function () {
  this.timeout(15000);
  const prefix = 'owned_storage_permissions_' + randomUUID().replaceAll('-', '') + '_';
  const names = ['entries', 'treatments', 'devicestatus'];
  let client, server, authorization, reads = 0;
  const collections = [];
  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test', {monitorCommands:true});
    await client.connect();
    const db = client.db();
    client.on('commandStarted', event => {
      if (['find', 'aggregate'].includes(event.commandName) && String(event.command[event.commandName]).startsWith(prefix)) reads++;
    });
    const env = {settings:{authDefaultRoles:'owned-reader', authFailDelay:0}, authentication_collections_prefix:prefix + 'auth_'};
    const ctx = Object.assign({}, require('./inithelper')().ctx, {store:db, cache:{entries:[], getData:() => []}, ddata:{sgvs:[]}});
    authorization = ctx.authorization = require('../lib/authorization')(env, ctx);
    authorization.storage.roles = [{name:'owned-reader', permissions:['api:entries:read']}];
    for (let index = 0; index < names.length; index++) {
      const name = names[index], col = db.collection(prefix + name);
      collections.push(col);
      await col.insertMany(Array.from({length:index + 1}, (_, i) => ({date:1700000000000 + i * 300000,
        dateString:new Date(1700000000000 + i * 300000).toISOString(), marker:name, sgv:100 + i, type:'sgv'})));
      ctx[name] = require('../lib/server/entries')({entries_collection:col.collectionName}, ctx);
    }
    const app = express();
    app.set('query parser', 'extended');
    app.use(require('../lib/api/entries')(app, require('../lib/middleware')(env), ctx, env));
    server = await new Promise(resolve => {const listening = app.listen(0, '127.0.0.1', () => resolve(listening));});
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
    try {for (const col of collections) await col.drop();} finally {if (client) await client.close();}
  });
  const filter = qs.stringify({find:{date:{$gte:0}}});

  it('denies entries-only access to other count and slice storages before reads twice', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      authorization.storage.roles[0].permissions = ['api:entries:read'];
      for (const name of ['treatments', 'devicestatus']) {
        for (const url of ['/count/' + name + '/where?' + filter, '/slice/' + name + '/dateString?' + filter]) {
          const before = reads;
          await request(server).get(url).set('Accept', 'application/json').expect(401);
          assert.equal(reads, before);
        }
      }
    }
  });

  it('permits explicitly granted storage reads and retains entries fallback twice', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      authorization.storage.roles[0].permissions = names.map(name => 'api:' + name + ':read');
      for (let i = 0; i < names.length; i++) {
        const count = await request(server).get('/count/' + names[i] + '/where?' + filter).expect(200);
        assert.equal(count.body[0].count, i + 1);
        const slice = await request(server).get('/slice/' + names[i] + '/dateString?' + filter).set('Accept','application/json').expect(200);
        assert.equal(slice.body.length, i + 1);
        assert(slice.body.every(row => row.marker === names[i]));
      }
      authorization.storage.roles[0].permissions = ['api:entries:read'];
      const fallback = await request(server).get('/count/unknown/where?' + filter).expect(200);
      assert.equal(fallback.body[0].count, 1);
    }
  });
});
