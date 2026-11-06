'use strict';

// Local owned TLS fixture only. See mongodb-driver7.md for setup and scope.
const assert = require('node:assert/strict');
const path = require('node:path');
const {createRequire} = require('node:module');
const {randomUUID} = require('node:crypto');
const root = process.argv[2];
const certificates = process.argv[3];
assert(root && path.isAbsolute(root), 'Supply an absolute checkout path');
assert(certificates && path.isAbsolute(certificates), 'Supply an absolute fixture certificate directory');
const req = createRequire(path.join(root, 'package.json'));
const {MongoClient} = req('mongodb');
const database = 'nightscout_tls_test_' + randomUUID().replaceAll('-', '');
function uri(ca) {
  return 'mongodb://127.0.0.1:27175/' + database + '?tls=true&tlsCAFile=' +
    encodeURIComponent(path.join(certificates, ca));
}

(async function () {
  const monitor = new MongoClient(uri('ca.crt'), {serverSelectionTimeoutMS:3000});
  let version, owned = false;
  try {
    await monitor.connect();
    const options = (await monitor.db('admin').command({getCmdLineOpts:1})).parsed;
    assert.equal(options.net.port, 27175);
    assert.equal(options.net.bindIp, '127.0.0.1');
    assert.equal(options.net.tls.mode, 'requireTLS');
    assert.equal(path.resolve(options.storage.dbPath), path.join(certificates, 'db'));
    owned = true;
    version = (await monitor.db('admin').command({buildInfo:1})).version;
    for (let cycle = 0; cycle < 2; cycle++) {
      const store = await req('./lib/storage/mongo-storage')({storageURI:uri('ca.crt'), mongo_pool_size:'2'}, undefined, true);
      try {
        assert.equal(store.client.options.tls, true);
        assert.notEqual(store.client.options.tlsAllowInvalidCertificates, true);
        assert.notEqual(store.client.options.tlsAllowInvalidHostnames, true);
        const col = store.db.collection('owned');
        await col.updateOne({_id:'stable'}, {$set:{cycle}}, {upsert:true});
        assert.deepEqual(await col.find().toArray(), [{_id:'stable', cycle}]);
      } finally {await store.client.close();}

      const untrusted = new MongoClient(uri('untrusted.crt'), {serverSelectionTimeoutMS:1000});
      try {
        await assert.rejects(untrusted.connect(), error =>
          error.name === 'MongoServerSelectionError' && /certificate|issuer|self.signed/i.test(error.message));
      } finally {await untrusted.close();}
    }
    console.log(JSON.stringify({driver:req('mongodb/package.json').version, node:process.version,
      server:version, trustedReadWriteCycles:2, untrustedCARejections:2}));
  } finally {
    try {if (owned) await monitor.db(database).dropDatabase();}
    finally {await monitor.close();}
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
