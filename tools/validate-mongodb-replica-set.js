'use strict';

// Destructive only to the dedicated local test replica set: this initializes
// its members and steps down primaries. Never point it at a deployment.
const assert = require('node:assert/strict');
const path = require('node:path');
const {createRequire} = require('node:module');
const {randomUUID} = require('node:crypto');
const {EventEmitter} = require('node:events');
const root = process.argv[2] || path.resolve(__dirname, '..');
assert(path.isAbsolute(root), 'Checkout path must be absolute');
const req = createRequire(path.join(root, 'package.json'));
const {MongoClient} = req('mongodb');
const hosts = [27172, 27173, 27174].map(port => '127.0.0.1:' + port);
const setName = 'nightscout_owned_rs';
const database = 'nightscout_replica_test_' + randomUUID().replaceAll('-', '');
const uri = 'mongodb://' + hosts.join(',') + '/' + database + '?replicaSet=' + setName + '&retryWrites=true&w=majority';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function initialize() {
  let initialized = false;
  for (const host of hosts) {
    const direct = new MongoClient('mongodb://' + host + '/?directConnection=true', {serverSelectionTimeoutMS:5000});
    try {
      await direct.connect();
      const options = (await direct.db('admin').command({getCmdLineOpts:1})).parsed;
      assert.equal(options.replication.replSet, setName);
      assert.equal(options.net.bindIp, '127.0.0.1');
      assert.equal(options.net.port, Number(host.split(':')[1]));
      if (host === hosts[0]) {
        try {
          const {config} = await direct.db('admin').command({replSetGetConfig:1});
          assert.equal(config._id, setName);
          assert.deepEqual(config.members.map(member => member.host).sort(), hosts);
          initialized = true;
        } catch (error) {
          if (error.code !== 94) throw error; // NotYetInitialized only
        }
      }
    } finally {await direct.close();}
  }
  // Inspect every member before initializing the owned set.
  if (!initialized) {
    const direct = new MongoClient('mongodb://' + hosts[0] + '/?directConnection=true');
    try {
      await direct.connect();
      await direct.db('admin').command({replSetInitiate:{
        _id:setName, members:hosts.map((host, _id) => ({_id, host})),
        settings:{electionTimeoutMillis:1500, heartbeatIntervalMillis:500}
      }});
    } finally {await direct.close();}
  }
}

async function primary(client, previous) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    try {
      const hello = await client.db('admin').command({hello:1});
      if (hello.isWritablePrimary && hello.primary !== previous) return hello.primary;
    } catch (error) {
      if (error.name !== 'MongoServerSelectionError' && error.name !== 'MongoNetworkError') throw error;
    }
    await pause(100);
  }
  throw new Error('Owned replica set did not elect a different primary');
}

(async function () {
  await initialize();
  const monitor = new MongoClient(uri, {serverSelectionTimeoutMS:10000});
  let store;
  const transitions = [];
  try {
    await monitor.connect();
    let current = await primary(monitor);
    store = await req('./lib/storage/mongo-storage')({storageURI:uri, mongo_pool_size:'2'}, undefined, true);
    assert.equal(store.client.options.retryWrites, true);
    assert.equal(store.client.options.writeConcern.w, 'majority');
    const updates = [];
    const bus = new EventEmitter();
    bus.on('data-update', event => updates.push(event));
    const entries = req('./lib/server/entries')({entries_collection:'entries'}, {
      store, bus, purifier:req('./lib/server/purifier')(), ddata:{processRawDataForRuntime:docs => docs}
    });
    const makeEntry = (index, sgv) => ({identifier:'owned-replica-' + index,
      date:1700000000000 + index * 300000, type:'sgv', sgv});
    await entries.create([makeEntry(0, 100)]);
    const initial = await entries.list({find:{date:{$gte:0}}});
    assert.equal(initial.length, 1);
    const ids = new Map([[initial[0].identifier, initial[0]._id.toHexString()]]);
    for (let cycle = 1; cycle <= 2; cycle++) {
      try {
        await monitor.db('admin').command({replSetStepDown:5, force:true});
      } catch (error) {
        // Some server/driver combinations close the connection after stepdown.
        if (error.name !== 'MongoNetworkError') throw error;
      }
      // No application retry loop: exercise the real storage/client behavior
      // while the topology is changing, using majority-acknowledged writes.
      await entries.create([makeEntry(cycle, 100 + cycle)]);
      const next = await primary(monitor, current);
      transitions.push({from:current, to:next});
      current = next;
      let rows = await entries.list({find:{date:{$gte:0}}});
      assert.equal(rows.length, cycle + 1);
      const inserted = rows.find(row => row.identifier === 'owned-replica-' + cycle);
      assert(inserted);
      ids.set(inserted.identifier, inserted._id.toHexString());
      await entries.create([makeEntry(cycle, 200 + cycle)]);
      rows = await entries.list({find:{date:{$gte:0}}});
      assert.equal(rows.length, cycle + 1);
      assert.equal(new Set(rows.map(row => row._id.toHexString())).size, rows.length);
      for (const [identifier, id] of ids) {
        assert.equal(rows.find(row => row.identifier === identifier)._id.toHexString(), id);
      }
      assert.equal(rows.find(row => row.identifier === inserted.identifier).sgv, 200 + cycle);
      assert.equal(rows[0].identifier, inserted.identifier);
    }
    const stats = await store.db.stats();
    assert.equal(stats.db, database);
    assert.equal(stats.objects, 3);
    assert.equal(updates.length, 5);
    console.log(JSON.stringify({driver:req('mongodb/package.json').version, node:process.version,
      server:(await monitor.db('admin').command({buildInfo:1})).version,
      transitions, records:3, updates:updates.length, statsObjects:stats.objects}));
  } finally {
    try {if (store) await store.db.dropDatabase();}
    finally {
      if (store?.client) await store.client.close();
      await monitor.close();
    }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
