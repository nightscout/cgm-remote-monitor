'use strict';

const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');

describe('Complete authorization reload boundary', function () {
  this.timeout(15000);
  const prefix = 'owned_auth_reload_' + randomUUID().replaceAll('-', '') + '_';
  let client, roles, subjects, storage;
  const commands = [];
  before(async function () {
    client = new MongoClient(process.env.CUSTOMCONNSTR_mongo || 'mongodb://127.0.0.1:27017/test', {monitorCommands:true});
    await client.connect();
    const db = client.db();
    roles = db.collection(prefix + 'roles');
    subjects = db.collection(prefix + 'subjects');
    client.on('commandStarted', event => {
      if (event.commandName === 'find' && event.command.find.startsWith(prefix)) commands.push(event.command);
    });
    storage = require('../lib/authorization/storage')({authentication_collections_prefix:prefix,
      enclave:{isApiKeySet:() => false}}, {store:db, settings:{}, moment:require('moment'), language:{translate:v => v}});
    await roles.insertMany([{name:'zulu', permissions:['api:entries:read']}, {name:'alpha', permissions:['api:profile:read']}]);
    await subjects.insertMany([{name:'second', roles:['zulu']}, {name:'first', roles:['alpha']}]);
  });
  after(async function () {
    try {
      if (roles) await roles.drop();
      if (subjects) await subjects.drop();
    } finally {if (client) await client.close();}
  });

  it('rejects filter options before I/O with promise and callback error contracts', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const method of ['listRoles', 'listSubjects']) {
        const before = commands.length;
        await assert.rejects(storage[method]({find:{name:'alpha'}}), /do not accept filters/);
        let calls = 0;
        await new Promise((resolve, reject) => {
          storage[method]({find:{$where:'true'}}, error => {
            calls++;
            try {assert(error instanceof TypeError); resolve();} catch (err) {reject(err);}
          });
        });
        assert.equal(calls, 1);
        assert.equal(commands.length, before);
      }
    }
  });

  it('reloads complete sorted role/subject snapshots and changed grants twice', async function () {
    for (let cycle = 0; cycle < 2; cycle++) {
      const permission = cycle ? 'api:treatments:read' : 'api:entries:read';
      await roles.updateOne({name:'zulu'}, {$set:{permissions:[permission]}});
      await subjects.updateOne({name:'second'}, {$set:{roles:cycle ? ['alpha'] : ['zulu']}});
      const before = commands.length;
      await new Promise((resolve, reject) => storage.reload(error => error ? reject(error) : resolve()));
      assert.deepEqual(storage.subjects.map(s => s.name), ['first', 'second']);
      assert.deepEqual(storage.subjects[1].roles, cycle ? ['alpha'] : ['zulu']);
      assert.deepEqual(storage.roles.find(r => r.name === 'zulu').permissions, [permission]);
      assert(storage.roles.some(r => r.name === 'alpha'));
      for (const role of storage.defaultRoles) assert(storage.roles.some(r => r.name === role.name));
      const reads = commands.slice(before);
      assert.equal(reads.length, 2);
      for (const command of reads) {
        assert.deepEqual(command.filter, {});
        assert.deepEqual(command.sort instanceof Map ? Object.fromEntries(command.sort) : command.sort, {name:1});
      }
    }
  });
});
