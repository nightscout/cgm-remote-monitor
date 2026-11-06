'use strict';

// Actual Mongo/PG storage wrappers and shipping acquisition modules. No query
// evaluator, clinical calculation or notification provider is replaced here.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const { run } = require('../../lib/migrations/postgres');
const connect = require('../../lib/storage/postgres-connection');
const { encodeDocument } = require('../../lib/storage/postgres-identity');
const postgresDomains = require('../../lib/server/serve/postgres-domains');
const environment = require('../../lib/server/tenant-app/environment');
const scope = require('../../lib/storage/tenant-scope');
const createData = require('../../lib/data/ddata');
const createCache = require('../../lib/server/cache');
const createLoader = require('../../lib/data/dataloader');
const createViews = require('../../lib/data/views');
const createSnapshot = require('../../lib/server/tenant-app/snapshot');
const derivedFrame = require('../../lib/server/tenant-app/derived-frame');
const language = require('../../lib/language')();
const wrappers = {
  entries: require('../../lib/server/entries'), treatments: require('../../lib/server/treatments'),
  devicestatus: require('../../lib/server/devicestatus'), profile: require('../../lib/server/profile'),
  food: require('../../lib/server/food'), activity: require('../../lib/server/activity')
};

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOW = 1793664000123;
const HOUR = 3600000;
const DOMAINS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
const PLUGINS = ['bgnow', 'direction', 'upbat', 'iob'];
const HEX = '65a1b2c3d4e5f60718293a4b';
const iso = time => new Date(time).toISOString();
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();

function documents (tenant = A) {
  const n = tenant === A ? 1 : 2;
  const result = {
    entries: Array.from({ length: 15 }, (_, i) => ({
      _id: i === 0 ? new ObjectId(HEX) : i === 1 ? 'typed-string' : 'sgv-' + i,
      type: 'sgv', date: NOW - (1 + i * 5) * 60000, sgv: n * 100 + i,
      sysTime: iso(NOW - (1 + i * 5) * 60000), direction: 'Flat'
    })),
    treatments: [{ _id: 'meal', eventType: 'Meal Bolus', created_at: iso(NOW - 600000), carbs: 20, insulin: n },
      { _id: 'sensor', eventType: 'Sensor Start', created_at: iso(NOW - 30 * HOUR) },
      { _id: 'too-old', eventType: 'Note', created_at: iso(NOW - 61 * HOUR), notes: 'synthetic old note' }],
    devicestatus: [],
    profile: [{ _id: new ObjectId('65a1b2c3d4e5f60718293c4b'), defaultProfile: 'Default',
      startDate: iso(NOW - 100 * HOUR), created_at: iso(NOW - 100 * HOUR), mills: NOW - 100 * HOUR,
      store: { Default: { dia: 3, carbratio: [{ time: '00:00', value: 10 }], carbs_hr: 20,
        delay: 20, sens: [{ time: '00:00', value: 50 }], basal: [{ time: '00:00', value: n }],
        target_low: [{ time: '00:00', value: 90 }], target_high: [{ time: '00:00', value: 110 }],
        timezone: 'UTC', units: 'mg/dl' } } }],
    food: [{ _id: 'food', name: 'Synthetic food', type: 'food', carbs: 10 }],
    activity: [{ _id: 'activity', created_at: iso(NOW - 600000), type: 'steps', steps: 100 }]
  };
  result.entries.push({ _id: 'meter', type: 'mbg', date: NOW - 600000, mbg: n * 100 + 2 },
    { _id: 'calibration', type: 'cal', date: NOW - 1200000, slope: 1, intercept: 0, scale: 1 },
    { _id: 'outside', type: 'sgv', date: NOW - 49 * HOUR, sgv: 999 });
  for (let i = 0; i < 12; i++) result.devicestatus.push({ _id: 'uploader-' + i,
    device: 'synthetic-uploader', created_at: iso(NOW - (12 - i) * 60000), uploader: { battery: 40 + i } });
  result.devicestatus.push({ _id: new ObjectId('65a1b2c3d4e5f60718293d4b'), device: 'synthetic-pump',
    created_at: iso(NOW - 20 * 60000), pump: { clock: iso(NOW - 20 * 60000), reservoir: 100 } },
  { _id: 'multi-kind', device: 'synthetic-loop', created_at: iso(NOW - 5 * 60000),
    uploader: { battery: 60 }, loop: { iob: { iob: 1.25 * n, timestamp: iso(NOW - 5 * 60000) } } },
  { _id: 'old-status', device: 'synthetic-old', created_at: iso(NOW - 25 * HOUR), uploader: { battery: 5 } });
  return result;
}

module.exports = function frameAcquisition () {
  const suffix = randomBytes(8).toString('hex');
  const name = 'frame_test_' + suffix, role = name + '_app';
  const namespaces = Object.fromEntries(DOMAINS.map(domain => [domain, name + '_' + domain]));
  const containers = [], connections = [], stores = [];
  let admin, mongo, db, uri, oldMode;

  async function ready (fn) {
    const until = Date.now() + 30000;
    let last;
    do { try { return await fn(); } catch (error) { last = error; await delay(100); } } while (Date.now() < until);
    throw last;
  }
  async function open () {
    oldMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const password = randomBytes(24).toString('hex');
    const pg = name + '_pg', mg = name + '_mongo';
    containers.push(pg);
    execFileSync('docker', ['run', '--name', pg, '--detach', '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=' + name, 'postgres:16'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: 'pipe', timeout: 30000 });
    containers.push(mg);
    docker(['run', '--name', mg, '--detach', '--ulimit', 'nofile=64000:64000', '--publish', '127.0.0.1::27017', 'mongo:8.0.34']);
    const url = new URL('postgres://postgres@127.0.0.1:' + docker(['port', pg, '5432/tcp']).split(':').pop() + '/' + name);
    url.password = password;
    const adminURI = url.toString();
    admin = await ready(async () => { const c = new Client({ connectionString: adminURI, connectionTimeoutMillis: 500 });
      try { await c.connect(); return c; } catch (error) { await c.end(); throw error; } });
    for (const logical of DOMAINS) await run('up', { direct: true, connectionString: adminURI,
      namespace: namespaces[logical], catalogue: postgresDomains.get(logical).catalogue });
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(namespaces).join(',')} TO ${role}`);
    for (const logical of DOMAINS) await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${namespaces[logical]}.${logical} TO ${role}`);
    url.username = role; uri = url.toString();
    mongo = new MongoClient('mongodb://127.0.0.1:' + docker(['port', mg, '27017/tcp']).split(':').pop(), { serverSelectionTimeoutMS: 500 });
    await ready(() => mongo.connect()); db = mongo.db(name);
    console.log('frame acquisition services:', 'Node' + process.version,
      'PostgreSQL' + (await admin.query('SHOW server_version')).rows[0].server_version,
      'MongoDB' + (await db.admin().buildInfo()).version);
    await seed();
  }
  async function seed (change) {
    for (const logical of DOMAINS) await admin.query(`DELETE FROM ${namespaces[logical]}.${logical}`);
    for (const tenant of [A, B]) {
      const docs = documents(tenant);
      if (change) change(docs, tenant);
      for (const logical of DOMAINS) {
        const store = db.collection(name + '_' + (tenant === A ? 'a' : 'b') + '_' + logical);
        if (!stores.includes(store.collectionName)) stores.push(store.collectionName);
        await store.deleteMany({});
        if (docs[logical].length) await store.insertMany(docs[logical]);
        for (const document of docs[logical]) {
          const row = encodeDocument(document);
          await admin.query(`INSERT INTO ${namespaces[logical]}.${logical}(tenant_id,id_kind,doc) VALUES($1,$2,$3)`,
            [tenant, row.id_kind, row.doc]);
        }
      }
    }
  }
  async function context (backend, tenant = A, { days = 1 } = {}) {
    const env = environment({ settings: { enable: PLUGINS }, extendedSettings: { devicestatus: { days } } });
    const trace = [], bus = new EventEmitter();
    const ctx = { settings: env.settings, language, levels: { ...require('../../lib/levels'), translate: language.translate },
      moment: require('moment-timezone'), bus, ddata: createData() };
    ctx.cache = createCache(env, ctx);
    if (backend === 'pg') {
      const connection = await connect({ connectionString: uri, max: 3 }); connections.push(connection);
      const ports = new Map();
      for (const logical of DOMAINS) ports.set(logical, postgresDomains.get(logical).factory({
        connection, table: namespaces[logical] + '.' + logical, bus, env, source: 'v1/internal' }));
      ctx.storagePorts = { resolve: ({ logical, source }) => source === 'v1/internal' ? ports.get(logical) : undefined };
      ctx.store = { db: { async stats () {
        let dataSize = 0;
        for (const logical of DOMAINS) dataSize += Number((await connection.query(
          `SELECT COALESCE(sum(pg_column_size(doc)),0) AS bytes FROM ${namespaces[logical]}.${logical}`)).rows[0].bytes);
        return { dataSize, indexSize: undefined };
      } } };
    } else {
      assert.equal(backend, 'mongo');
      ctx.store = { db: { stats: () => db.stats(), admin: () => db.admin() },
        collection: n => db.collection(n), ensureIndexes () {} };
    }
    for (const logical of DOMAINS) {
      env[logical + '_collection'] = name + '_' + (tenant === A ? 'a' : 'b') + '_' + logical;
      const wrapper = logical === 'profile' ? wrappers.profile(env.profile_collection, ctx, env)
        : wrappers[logical](env, ctx);
      const method = logical === 'profile' ? 'last' : 'list';
      ctx[logical] = { [method] (...args) {
        const callback = args.pop();
        trace.push({ logical, method, query: args[0] && structuredClone(args[0]) });
        wrapper[method](...args, (error, docs) => {
          const entry = { logical, error: error && error.message,
            ids: docs && docs.map(doc => ({ shown: String(doc._id), kind: doc._id?._bsontype || typeof doc._id })) };
          trace.push(entry); callback(error, docs);
        });
      } };
    }
    const ports = Object.fromEntries(DOMAINS.map(logical => [logical, { tenant, store: ctx[logical] }]));
    ports.stats = { tenant, read: () => ctx.store.db.stats() };
    return { backend, tenant, env, ctx, ports, trace };
  }
  async function acquire (setup, path, at = NOW) {
    const { tenant, env, ctx } = setup;
    if (path === 'snapshot') return createSnapshot({ tenant, env, ports: setup.ports, language }).load({ at });
    return scope.withTenant(tenant, async () => {
      if (path === 'properties' || path === 'alarms') return new Promise((resolve, reject) => {
        const views = createViews(env, ctx);
        views.materialise(path, { now: at }, (error, frame) => error ? reject(error) : resolve({ ...frame, views }));
      });
      const ddata = createData();
      await new Promise((resolve, reject) => createLoader(env, ctx).update(ddata,
        { lastUpdated: at, frame: path === 'loader-frame' }, error => error ? reject(error) : resolve()));
      return { tenant, ddata, cache: ctx.cache };
    });
  }
  function properties (setup, frame) {
    if (frame.views) return frame.views.evaluate(frame).properties;
    return derivedFrame({ env: setup.env, frame, language }).properties;
  }
  async function liveness () {
    assert.equal((await admin.query('SELECT 1 AS live')).rows[0].live, 1);
    assert.equal((await db.command({ ping: 1 })).ok, 1);
  }
  async function release () {
    for (const connection of connections.splice(0)) await connection.end();
  }
  async function close () {
    const failures = [];
    for (const connection of connections) try { await connection.end(); } catch (error) { failures.push(error); }
    if (mongo) try { await db.dropDatabase(); await mongo.close(); } catch (error) { failures.push(error); }
    if (admin) try { await admin.end(); } catch (error) { failures.push(error); }
    for (const name of containers.reverse()) try { docker(['rm', '--force', name]); } catch (error) { failures.push(error); }
    if (oldMode !== undefined) scope.setTenancyMode(oldMode);
    if (failures.length) throw new globalThis.AggregateError(failures, 'frame acquisition cleanup');
  }
  return { A, B, NOW, HOUR, HEX, open, seed, context, acquire, properties, liveness, release, close, language };
};
