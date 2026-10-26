'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');
const express = require('express');
const request = require('supertest');

describe('Slice storage cache selection', function () {
  this.timeout(15000);
  const prefix = 'owned_slice_cache_' + randomUUID().replaceAll('-', '') + '_';
  const names = ['entries', 'treatments', 'devicestatus'];
  let client, server, authorization, ctx, reads = [];
  const collections = [];
  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test', {monitorCommands:true});
    await client.connect();
    const db = client.db();
    client.on('commandStarted', event => {
      if (event.commandName === 'find' && String(event.command.find).startsWith(prefix)) reads.push(event.command.find);
    });
    const env = {settings:{authDefaultRoles:'owned-reader', authFailDelay:0}, authentication_collections_prefix:prefix + 'auth_'};
    ctx = Object.assign({}, require('./inithelper')().ctx, {store:db, cache:{entries:[], getData:() => ctx.cache.entries}, ddata:{sgvs:[]}});
    authorization = ctx.authorization = require('../lib/authorization')(env, ctx);
    authorization.storage.roles = [{name:'owned-reader', permissions:names.map(name => 'api:' + name + ':read')}];
    for (const name of names) {
      const col = db.collection(prefix + name);
      collections.push(col);
      ctx[name] = require('../lib/server/' + name)({[name + '_collection']:col.collectionName}, ctx);
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

  it('reads the selected collection despite a populated entries cache over two updates', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      const date = Date.now(), stamp = new Date(date).toISOString();
      ctx.cache.entries = [{date, sgv:101 + cycle, type:'sgv', marker:'cached-entries-' + cycle}];
      for (let index = 0; index < names.length; index++) {
        const name = names[index];
        await collections[index].updateOne({marker:name}, {$set:{date, dateString:stamp, created_at:stamp, sgv:120 + cycle, type:'sgv', cycle}}, {upsert:true});
      }
      for (const name of ['treatments', 'devicestatus']) {
        const before = reads.length;
        const response = await request(server).get('/slice/' + name + '/type/sgv?count=1').set('Accept','application/json').expect(200);
        assert.equal(response.body.length, 1);
        assert.equal(response.body[0].marker, name);
        assert.equal(response.body[0].cycle, cycle);
        assert.deepEqual(reads.slice(before), [prefix + name]);
      }
      // The existing entries fast path, including unknown-storage fallback, stays cached.
      for (const name of ['entries', 'unknown']) {
        const before = reads.length;
        const response = await request(server).get('/slice/' + name + '/type/sgv?count=1').set('Accept','application/json').expect(200);
        assert.equal(response.body[0].marker, 'cached-entries-' + cycle);
        assert.equal(reads.length, before);
      }
    }
  });
});
