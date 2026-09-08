'use strict';

// Worker for the owned Docker rehearsal; never accepts a deployment URI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {createHash} = require('node:crypto');
const {MongoClient, ObjectId, BSON} = require('mongodb');
const [mode, port, database, expectedFile, targetFcv] = process.argv.slice(2);
assert.match(port, /^\d+$/);
assert.match(database, /^nightscout_upgrade_[a-f0-9]{12}$/);
const uri = `mongodb://fixture:owned-upgrade-fixture@127.0.0.1:${port}/${database}?authSource=admin`;
const client = new MongoClient(uri, {serverSelectionTimeoutMS: 1000});
const root = path.resolve(__dirname, '..');
const collections = ['entries', 'treatments', 'profile', 'devicestatus', 'food', 'settings'];
const hash = value => createHash('sha256').update(value).digest('hex');

async function snapshot(db) {
  const result = {};
  for (const name of collections) {
    const collection = db.collection(name);
    const documents = await collection.find().sort({_id: 1}).toArray();
    const indexes = (await collection.listIndexes().toArray()).map(({ns, ...index}) => index).sort((a, b) => a.name.localeCompare(b.name));
    result[name] = {documents: BSON.EJSON.serialize(documents, {relaxed: false}), indexes};
  }
  return result;
}

async function application(db) {
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const appPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, {NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(appPort),
    INSECURE_USE_HTTP: 'true', CUSTOMCONNSTR_mongo: uri, API_SECRET: 'owned-upgrade-api-fixture',
    AUTH_DEFAULT_ROLES: 'denied', ENABLE: 'careportal', MONGO_POOL_SIZE: '5', MONGO_MIN_POOL_SIZE: '1'});
  const child = spawn(process.execPath, ['lib/server/server.js'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {output = (output + chunk).slice(-12000);});
  const exit = once(child, 'exit');
  const origin = 'http://127.0.0.1:' + appPort;
  const headers = {'api-secret': createHash('sha1').update(env.API_SECRET).digest('hex')};
  async function request(route, options = {}) {
    const response = await fetch(origin + route, {headers, signal: AbortSignal.timeout(5000), ...options});
    assert.equal(response.status, 200, route + ': ' + await response.clone().text());
    return response.json();
  }
  try {
    let loaded = false;
    for (let i = 0; i < 120; i++) {
      assert.equal(child.exitCode, null, output);
      try {loaded = (await request('/api/v1/status.json')).runtimeState === 'loaded';} catch (_) {}
      if (loaded) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(loaded, output);
    const entries = await request('/api/v1/entries.json?count=100&find[date][$gte]=0');
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(entry => entry.sgv).sort((a, b) => a - b), [90, 126, 180]);
    const treatments = await request('/api/v1/treatments.json?count=100&find[created_at][$gte]=1970-01-01');
    assert.equal(treatments.length, 3);
    assert.deepEqual(treatments.map(t => t.enteredBy).sort(), ['AAPS fixture', 'Loop fixture', 'Trio fixture']);
    const profiles = await request('/api/v1/profile.json'); assert.equal(profiles.length, 1);
    assert.equal(profiles[0].store.Default.timezone, 'America/New_York');
    const payload = {eventType: 'Note', notes: 'upgrade write probe', created_at: new Date().toISOString(),
      enteredBy: 'upgrade fixture', identifier: 'upgrade-write-probe'};
    await request('/api/v1/treatments', {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify(payload)});
    const stored = await db.collection('treatments').findOne({identifier: payload.identifier}); assert.ok(stored);
    await db.collection('treatments').deleteOne({_id: stored._id});
    return {loaded: true, authenticatedEntries: 3, authenticatedTreatments: 3, profiles: 1, uploadAndReadback: true};
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exit; clearTimeout(timer);
    }
  }
}

(async () => {
  for (let attempt = 0; ; attempt++) {
    try {await client.connect(); break;} catch (error) {
      if (attempt >= 60) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  try {
    const db = client.db(database), admin = client.db('admin');
    if (mode === 'seed') {
      assert.equal((await db.listCollections().toArray()).length, 0, 'Seed only a fresh owned database');
      const date = Date.parse('2025-03-09T07:00:00Z');
      await db.collection('entries').insertMany([90, 126, 180].map((sgv, i) => ({_id: new ObjectId('65a00000000000000000000' + (i + 10).toString(16)),
        type: 'sgv', sgv, date: date + i * 300000, dateString: new Date(date + i * 300000).toISOString(), direction: 'Flat', device: 'upgrade fixture'})));
      await db.collection('treatments').insertMany([
        {_id: '69F15FD2-8075-4DEB-AEA3-4352F455840D', identifier: 'loop-fixture-uuid', enteredBy: 'Loop fixture', eventType: 'Temporary Override', duration: 30},
        {_id: new ObjectId('65b000000000000000000001'), syncIdentifier: 'trio-fixture-sync', enteredBy: 'Trio fixture', eventType: 'Carb Correction', carbs: 12},
        {_id: new ObjectId('65b000000000000000000002'), identifier: null, enteredBy: 'AAPS fixture', eventType: 'Meal Bolus', insulin: 1.2, carbs: 15}
      ].map(t => ({...t, created_at: new Date(date).toISOString(), units: 'mg/dl'})));
      await db.collection('profile').insertOne({_id: new ObjectId('65c000000000000000000001'), defaultProfile: 'Default', startDate: '2025-01-01T00:00:00.000Z',
        mills: Date.parse('2025-01-01T00:00:00Z'), units: 'mg/dl', store: {Default: {dia: 3, carbs_hr: 20, delay: 20, timezone: 'America/New_York',
          units: 'mg/dl', basal: [{time: '00:00', value: 0.5}], sens: [{time: '00:00', value: 50}], carbratio: [{time: '00:00', value: 10}],
          target_low: [{time: '00:00', value: 90}], target_high: [{time: '00:00', value: 110}]}}});
      await db.collection('devicestatus').insertOne({created_at: new Date(date).toISOString(), device: 'upgrade fixture', uploader: {battery: 75}, loop: {timestamp: new Date(date)}});
      await db.collection('food').insertOne({type: 'food', name: 'Fixture bread', carbs: 15, portion: 1, unit: 'slice'});
      await db.collection('settings').insertOne({fixture: 'configuration', units: 'mmol', customTitle: 'Upgrade fixture'});
      await db.collection('entries').createIndex({date: -1}, {name: 'fixture_date'});
      await db.collection('treatments').createIndex({identifier: 1}, {name: 'fixture_identifier', sparse: true});
      // Application boot may create its normal indexes. Capture after that boot.
      await application(db);
      fs.writeFileSync(expectedFile, JSON.stringify(await snapshot(db), null, 2) + '\n');
    } else if (mode === 'fcv') {
      assert.ok(['6.0', '7.0', '8.0'].includes(targetFcv));
      await admin.command({setFeatureCompatibilityVersion: targetFcv, ...(Number(targetFcv) >= 7 ? {confirm: true} : {})});
    } else assert.equal(mode, 'verify');
    const api = await application(db);
    const actual = await snapshot(db), expected = JSON.parse(fs.readFileSync(expectedFile));
    assert.deepEqual(actual, expected, 'BSON values, identifiers and indexes survive the upgrade/restore');
    const build = await admin.command({buildInfo: 1});
    const fcv = (await admin.command({getParameter: 1, featureCompatibilityVersion: 1})).featureCompatibilityVersion;
    console.log(JSON.stringify({version: build.version, fcv, api, collections: Object.fromEntries(Object.entries(actual).map(([name, data]) =>
      [name, {documents: data.documents.length, indexes: data.indexes.map(index => index.name), sha256: hash(JSON.stringify(data))}]))}));
  } finally {await client.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
