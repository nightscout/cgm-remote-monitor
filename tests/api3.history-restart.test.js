'use strict';

const assert = require('assert');
const path = require('path');
const { fork } = require('child_process');
const { MongoClient } = require('mongodb');
const request = require('supertest');

// Uses separate Node processes and isolated collection names in the test DB.
// The first process writes an import through HTTP; the second must continue
// from the cursor issued before it started, even when wall time has not moved.
describe('API3 history after a server restart', function () {
  this.timeout(30000);
  const names = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'settings'];
  const prefix = 'history_restart_' + process.pid + '_';
  const hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  let child, url, client, childEnv;

  async function stop () {
    if (!child) return;
    const stopped = child;
    child = null;
    if (stopped.exitCode !== null || stopped.signalCode !== null) return;
    await new Promise(function (resolve) {
      stopped.once('exit', resolve);
      stopped.kill('SIGTERM');
    });
  }

  function start () {
    return new Promise(function (resolve, reject) {
      let output = '';
      child = fork(path.join(__dirname, 'fixtures/history-clock-server.js'), [], {
        env: childEnv, silent: true
      });
      const current = child;
      const timer = setTimeout(function () { reject(new Error('Boot timed out: ' + output)); }, 15000);
      const capture = data => { output = (output + data.toString()).slice(-4000); };
      current.stdout.on('data', capture);
      current.stderr.on('data', capture);
      current.once('error', function (err) { clearTimeout(timer); reject(err); });
      current.once('exit', function (code) { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + output)); });
      current.once('message', function (message) {
        clearTimeout(timer);
        if (message.error) return reject(new Error(message.error));
        url = message.url;
        resolve();
      });
    });
  }

  before(async function () {
    const env = require('../lib/server/env')();
    client = await MongoClient.connect(env.storageURI);
    childEnv = Object.assign({}, process.env, {
      CUSTOMCONNSTR_mongo: env.storageURI,
      HISTORY_TEST_NOW: String(Date.now()),
      ENTRIES_COLLECTION: prefix + 'entries',
      MONGO_COLLECTION: prefix + 'entries',
      ENABLE: 'api careportal'
    });
    names.slice(1).forEach(function (name) {
      childEnv['MONGO_' + name.toUpperCase() + '_COLLECTION'] = prefix + name;
    });
  });

  after(async function () {
    await stop();
    if (client) {
      await Promise.all(names.map(name => client.db().collection(prefix + name).drop().catch(function (err) {
        if (err.code !== 26) throw err;
      })));
      await client.close();
    }
  });

  it('keeps imported history and subsequent v1/v3 writes visible across restart', async function () {
    await start();
    const now = Number(childEnv.HISTORY_TEST_NOW);
    const batch = Array.from({ length: 1501 }, (_, i) => ({
      type: 'sgv', sgv: 100, date: now - (1501 - i) * 300000,
      dateString: new Date(now - (1501 - i) * 300000).toISOString(), device: 'history-restart'
    }));
    await request(url).post('/api/v1/entries').set('api-secret', hash).send(batch).expect(200);
    let cursor = now - 1;
    const seen = new Set();
    for (let page = 0; page < 5; page++) {
      const res = await request(url).get('/api/v3/entries/history/' + cursor + '?limit=500').expect(200);
      if (!res.body.result.length) break;
      res.body.result.forEach(doc => seen.add(doc.identifier));
      cursor = Number(/W\/"(\d+)"/.exec(res.headers.etag)[1]);
    }
    assert.strictEqual(seen.size, batch.length);
    assert(cursor > now, 'batch must have moved the cursor beyond wall time');

    // A later write in another collection must also contribute to the shared
    // clock, including when custom collection names are configured.
    const note = await request(url).post('/api/v3/treatments').send({
      eventType: 'Note', date: now, utcOffset: 0, app: 'restart-test', device: 'restart-test'
    }).expect(201);
    const storedNote = await request(url).get('/api/v3/treatments/' + note.body.identifier).expect(200);
    const latest = storedNote.body.result.srvModified;
    assert(latest > cursor);

    await stop();
    await start();
    const added = await request(url).post('/api/v3/entries').send({
      type: 'sgv', sgv: 151, date: now, utcOffset: 0, app: 'restart-test', device: 'restart-test'
    }).expect(201);
    const record = await request(url).get('/api/v3/entries/' + added.body.identifier).expect(200);
    assert(record.body.result.srvModified > latest, 'restart must restore the clock before accepting writes');
    await request(url).post('/api/v1/entries').set('api-secret', hash).send({
      type: 'sgv', sgv: 152, date: now + 300000, dateString: new Date(now + 300000).toISOString()
    }).expect(200);
    const changes = await request(url).get('/api/v3/entries/history/' + cursor).expect(200);
    assert.deepStrictEqual(changes.body.result.map(doc => doc.sgv), [151, 152]);
  });

  names.forEach(function (name, index) {
    it('recovers the latest stored time from the configured ' + name + ' collection', async function () {
      await stop();
      const now = Number(childEnv.HISTORY_TEST_NOW);
      const latest = now + 10000 + index * 1000;
      await client.db().collection(prefix + name).insertOne({ srvModified: latest });
      await start();
      const added = await request(url).post('/api/v3/entries').send({
        type: 'sgv', sgv: 153, date: now + (index + 2) * 300000,
        utcOffset: 0, app: 'restart-test', device: 'restart-test'
      }).expect(201);
      const record = await request(url).get('/api/v3/entries/' + added.body.identifier).expect(200);
      assert(record.body.result.srvModified > latest);
    });
  });

  it('ignores malformed legacy timestamp values instead of hiding the latest valid time', async function () {
    await stop();
    const now = Number(childEnv.HISTORY_TEST_NOW);
    const latest = now + 20000;
    await client.db().collection(prefix + 'entries').insertMany([
      { srvModified: latest }, { srvModified: [latest + 1000] },
      { srvModified: String(latest + 1000) }, { srvModified: Infinity },
      { srvModified: new Date(latest + 1000) }
    ]);
    await start();
    const added = await request(url).post('/api/v3/entries').send({
      type: 'sgv', sgv: 154, date: now + 3600000,
      utcOffset: 0, app: 'restart-test', device: 'restart-test'
    }).expect(201);
    const record = await request(url).get('/api/v3/entries/' + added.body.identifier).expect(200);
    assert.strictEqual(record.body.result.srvModified, latest + 1);
  });
});
