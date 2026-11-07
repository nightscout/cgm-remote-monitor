'use strict';
// Execute only from the explicitly granted parent phase; no container lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function configuration (input) {
  const config = JSON.parse(fs.readFileSync(input.env.NS_RT_PROFILE_CONFIG, 'utf8'));
  assert.equal(config.version, 1); assert.match(config.sourceHead, /^[a-f0-9]{40}$/);
  assert.equal(config.sourceHead, input.env.NS_RT_SOURCE_HEAD, 'immutable joined source attribution required');
  assert.equal(config.phaseId, input.phaseId);
  if (config.profileOrderCatalogue !== undefined) assert.equal(config.profileOrderCatalogue, 'socket-order-v1');
  assert.match(config.tenant, /^[a-f0-9-]{36}$/); assert.match(config.profileNamespace, /^[a-z][a-z0-9_]{0,62}$/);
  assert.match(config.mongoDatabase, /^rt_profile_[a-f0-9]{16,32}$/);
  assert(config.maxMessageBytes > 0 && Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0);
  const ownership = JSON.parse(fs.readFileSync(config.ownershipFile, 'utf8'));
  assert.equal(ownership.phaseId, input.phaseId); assert.equal(ownership.sourceHead, config.sourceHead);
  assert.equal(ownership.tenant, config.tenant); assert.equal(ownership.profileNamespace, config.profileNamespace);
  assert.equal(ownership.mongoDatabase, config.mongoDatabase);
  for (const kind of (['profile-port-differential', 'profile-catalogue-upgrade'].includes(input.phaseId) ? ['postgres', 'mongo'] : ['postgres', 'mongo', 'vault'])) {
    const resource = ownership.resources.find(row => row.kind === kind);
    assert(resource && resource.host === '127.0.0.1' && resource.labelValue && resource.containerId && resource.mounts);
    assert.equal(resource.image, require('./early').plan.pins[kind], 'root verified actual image identity required');
  }
  for (const [name, url] of [['postgres', input.env.NS_TEST_POSTGRES_ADMIN_URI], ['mongo', input.env.CUSTOMCONNSTR_mongo]]) {
    const parsed = new URL(url), resource = ownership.resources.find(row => row.kind === name);
    assert.equal(parsed.hostname, resource.host); assert.equal(Number(parsed.port), resource.port);
    if (name === 'postgres') assert.equal(decodeURIComponent(parsed.pathname.slice(1)), resource.database);
  }
  if (['profile-port-differential', 'profile-catalogue-upgrade'].includes(input.phaseId)) {
    assert.equal(config.authorityBoundary, 'synthetic-preauthorized-canonical-port-only');
    assert(input.env.NS_RT_PROFILE_WRITER_URI); return config;
  }
  assert(ownership.api && Number.isSafeInteger(ownership.api.pid) && ownership.api.sourceHead === config.sourceHead);
  process.kill(ownership.api.pid, 0); // handed-in owned actual CLI, never another substitute
  assert.deepEqual(ownership.api.socketPath, config.apiSocketPath);
  assert(input.env[config.credentialEnv]);
  return config;
}
module.exports = async function run (input) {
  const config = configuration(input), { Client } = require('pg'), { MongoClient, ObjectId } = require('mongodb');
  const { encodeDocument, decodeDocument } = require('../../../lib/storage/postgres-identity');
  const direct = input.phaseId === 'profile-port-differential';
  const invoke = direct ? null : require('../../../lib/server/realtime/ipc').client({ socketPath: config.apiSocketPath, maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs });
  const rows = [], pg = new Client({ connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI });
  const mongo = new MongoClient(input.env.CUSTOMCONNSTR_mongo); let reference, socket, directPort, pgConnected = false, mongoConnected = false;
  const table = '"' + config.profileNamespace + '".profile';
  const save = () => fs.writeFileSync(path.join(input.captureDir, 'profile-physical-results.json'), JSON.stringify(rows, null, 2) + '\n');
  const emit = (event, data) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SINGLE_CALLBACK_MISSING')), config.timeoutMs);
    socket.emit(event, data, (...reply) => { clearTimeout(timer); resolve(reply); });
  });
  async function physical () {
    const pgRows = (await pg.query('SELECT ctid::text,id_kind,doc FROM ' + table + ' WHERE tenant_id=$1', [config.tenant])).rows;
    return { pgRaw: pgRows, pgDocuments: pgRows.map(decodeDocument), mongoRaw: await mongo.db(config.mongoDatabase).collection('profile').find({}).toArray() };
  }
  async function add (label, payload) {
    const producer = structuredClone(payload), before = await physical(), wireCall = require('./wire-call');
    const mongoCall = await wireCall(producer, sent => emit('dbAdd', sent));
    if (mongoCall.error) throw mongoCall.error;
    const postgresCall = await wireCall(producer, sent => direct ? directPort.send(sent) : invoke('/mutate', { host: config.host,
      envelope: { tenant: config.tenant, namespace: '/', event: 'dbAdd', credential: JSON.parse(input.env[config.credentialEnv]), args: [sent] } }).then(result => result.replyArgs));
    const expected = mongoCall.result, actual = postgresCall.result, refusal = postgresCall.error && (postgresCall.error.code || postgresCall.error.message);
    const windows = { mongo: mongoCall.window, postgres: postgresCall.window }, stored = await physical();
    const operation = { label, producer, before, windows, producerUnchanged: mongoCall.producerUnchanged && postgresCall.producerUnchanged,
      expected, actual, refusal, ...stored };
    rows.push(operation); save();
    assert(operation.producerUnchanged, 'PROFILE_PRODUCER_IMMUTABLE received-copy mutation cannot alter next retry');
    assert.deepEqual(payload, producer, 'PROFILE_PRODUCER_IMMUTABLE original request remains unchanged');
    assert.equal(refusal, undefined, 'PROFILE_NATIVE_REFUSAL actual canonical PG socket profile refused');
    require('./profile-timestamps').compare(operation);

  }
  try {
    await pg.connect(); pgConnected = true; await mongo.connect(); mongoConnected = true;
    if (direct) directPort = await require('./profile-port')({ env: input.env, config });
    reference = await require('../socket-forwarding/mongo-reference')({ connectionString: input.env.CUSTOMCONNSTR_mongo, database: config.mongoDatabase });
    socket = require('socket.io-client')('http://127.0.0.1:' + reference.port, { reconnection: false, timeout: config.timeoutMs, transports: ['websocket'] });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    await emit('authorize', { secret: 'synthetic-reference-only', history: 24, status: true });
    for (const number of [1, 2, 3]) {
      await pg.query('DELETE FROM ' + table + ' WHERE tenant_id=$1', [config.tenant]); await reference.reset();
      const document = { _id: '111111111111111111111111', NSCLIENT_ID: 'synthetic-profile-' + number,
        startDate: '2026-11-06T00:00:00.000Z', defaultProfile: 'Synthetic', store: { Synthetic: { dia: 3, units: 'mg/dl',
          basal: [{ time: '00:00', value: 1, timeAsSeconds: 0 }], sens: [{ time: '00:00', value: 50, timeAsSeconds: 0 }],
          carbratio: [{ time: '00:00', value: 10, timeAsSeconds: 0 }], target_low: [{ time: '00:00', value: 90, timeAsSeconds: 0 }], target_high: [{ time: '00:00', value: 110, timeAsSeconds: 0 }] } } };
      if (number === 3) {
        for (const id of ['bbbbbbbbbbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaaaaaaaaaa']) {
          const seed = { ...document, _id: new ObjectId(id) }, encoded = encodeDocument(seed);
          await pg.query('INSERT INTO ' + table + '(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)', [config.tenant, encoded.id_kind, JSON.stringify(encoded.doc)]);
          await mongo.db(config.mongoDatabase).collection('profile').insertOne(seed);
        }
        rows.push({ label: 'preseed-natural-order', ...await physical() }); save();
      }
      const payload = { collection: 'profile', data: document };
      await add('case-' + number + '-first', payload);
      if (number === 2) await add('case-2-exact-retry', payload);
    }
    reference.assertHealthy();
  } finally {
    const cleanupErrors = []; let referenceClosed = !reference, pgEmpty, mongoEmpty;
    socket?.close();
    if (reference) try { await reference.close(); referenceClosed = true; } catch (error) { cleanupErrors.push(error.code || 'REFERENCE_CLOSE_FAILED'); }
    // Root owns schemas/containers. Only this attested dedicated fixture tenant/database is reset.
    if (pgConnected) try {
      await pg.query('DELETE FROM ' + table + ' WHERE tenant_id=$1', [config.tenant]);
      pgEmpty = Number((await pg.query('SELECT count(*) AS n FROM ' + table + ' WHERE tenant_id=$1', [config.tenant])).rows[0].n) === 0;
    } catch (error) { cleanupErrors.push(error.code || 'PG_CLEANUP_FAILED'); }
    if (mongoConnected) try {
      await mongo.db(config.mongoDatabase).dropDatabase();
      mongoEmpty = (await mongo.db(config.mongoDatabase).listCollections().toArray()).length === 0;
    } catch (error) { cleanupErrors.push(error.code || 'MONGO_CLEANUP_FAILED'); }
    const ends = await Promise.allSettled([pg.end(), mongo.close(), ...(directPort ? [directPort.close()] : [])]);
    for (const end of ends) if (end.status === 'rejected') cleanupErrors.push('DRIVER_CLOSE_FAILED');
    fs.writeFileSync(path.join(input.captureDir, 'profile-cleanup.json'), JSON.stringify({ referenceClosed, socketClosed: !socket?.connected,
      pgEmpty, mongoEmpty, cleanupErrors, authorityBoundary: direct ? 'synthetic-preauthorized-canonical-port-only' : 'actual-private-api-current-client', containersUntouched: true, schemasUntouched: true }) + '\n');
    assert.equal(cleanupErrors.length, 0, 'PROFILE_OWNED_CLEANUP exact owned fixture resources must close');

  }
};
module.exports.configuration = configuration;
