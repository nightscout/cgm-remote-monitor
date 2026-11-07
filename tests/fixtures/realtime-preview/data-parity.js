'use strict';
// Actual RT Socket.IO→privateAPI→canonical PG operations versus independent
// same-head Mongo socket reference. Requires profile uncertainty resolved first.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function dataParity (input) {
  const roles = await require('./roles').start(input), config = roles.config, { Client } = require('pg'), { MongoClient } = require('mongodb');
  const admin = new Client({ connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI }), mongo = new MongoClient(input.env.CUSTOMCONNSTR_mongo);
  const sockets = [], observations = []; let reference, adminReady = false, mongoReady = false;
  const record = () => fs.writeFileSync(path.join(input.captureDir, 'socket-data-physical-parity.json'), JSON.stringify(observations, null, 2) + '\n');
  const names = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
  const table = logical => { const name = config.namespaces[logical]; assert.match(name, /^[a-z][a-z0-9_]{0,62}$/); assert.equal(roles.owned.namespaces[logical], name); return '"' + name + '"."' + logical + '"'; };
  const norm = (value, key) => {
    if (value?._bsontype === 'ObjectId') return { objectId: value.toHexString() };
    if (value instanceof Date) return { date: value.toISOString() };
    if (['srvCreated', 'srvModified'].includes(key) && Number.isFinite(value) && value > 1e12) return 'server-clock';
    if (Array.isArray(value)) return value.map(item => norm(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, k)]));
    return value;
  };
  const send = (socket, event, payload) => new Promise(resolve => {
    const timer = setTimeout(() => resolve({ outcome: 'noack' }), config.timeoutMs);
    socket.emit(event, payload, (...reply) => { clearTimeout(timer); resolve({ outcome: 'reply', args: reply }); });
  });
  async function connect (port, host, credential) {
    const socket = require('socket.io-client')('http://127.0.0.1:' + port, { transports: ['websocket'], reconnection: false,
      timeout: config.timeoutMs, ...(host ? { extraHeaders: { Host: host } } : {}) }); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const result = await send(socket, 'authorize', credential); assert.equal(result.args?.[0]?.read, true); return socket;
  }
  try {
    assert.equal(config.profileUncertaintyResolved, true, 'root must resolve profile uncertainty before all6 campaign');
    assert.equal(config.mongoDatabase, roles.owned.mongoDatabase); assert.match(config.mongoDatabase, /^rt_data_[a-f0-9]{16,32}$/);
    assert.equal(config.tenant, roles.owned.tenant);
    await admin.connect(); adminReady = true; await mongo.connect(); mongoReady = true;
    reference = await require('../socket-forwarding/mongo-reference')({ connectionString: input.env.CUSTOMCONNSTR_mongo, database: config.mongoDatabase });
    const expectedSocket = await connect(reference.port, null, { secret: 'synthetic-reference-only' });
    const actualSocket = await connect(roles.ingress.port, config.host, JSON.parse(input.env[config.credentialEnv]));
    const now = Date.now(), time = new Date(now).toISOString();
    const documents = {
      entries: { _id: 'synthetic-entry', type: 'sgv', sgv: 123, date: now, dateString: time, device: 'synthetic' },
      treatments: { _id: 'synthetic-treatment', eventType: 'Note', created_at: time, notes: 'synthetic' },
      devicestatus: { _id: 'synthetic-status', device: 'synthetic', created_at: time },
      profile: { _id: 'synthetic-profile', NSCLIENT_ID: 'synthetic-profile', startDate: time, defaultProfile: 'Synthetic', store: { Synthetic: { dia: 3, units: 'mg/dl', basal: [{ time: '00:00', value: 1, timeAsSeconds: 0 }] } } },
      food: { _id: 'synthetic-food', type: 'food', name: 'Synthetic', category: 'Synthetic', portion: 1, carbs: 10, unit: 'g' },
      activity: { _id: 'synthetic-activity', type: 'activity', eventType: 'Exercise', created_at: time, duration: 10 }
    };
    for (const logical of names) {
      await admin.query('DELETE FROM ' + table(logical) + ' WHERE tenant_id=$1', [config.tenant]);
      for (const attempt of [1, 2]) {
        const payload = { collection: logical, data: structuredClone(documents[logical]) };
        const producer = structuredClone(payload), before = logical === 'profile' ? {
          pgDocuments: (await admin.query('SELECT id_kind,doc FROM ' + table(logical) + ' WHERE tenant_id=$1', [config.tenant])).rows.map(require('../../../lib/storage/postgres-identity').decodeDocument),
          mongoRaw: await mongo.db(config.mongoDatabase).collection(logical).find({}).toArray()
        } : undefined;
        const wireCall = require('./wire-call');
        const expectedCall = await wireCall(producer, sent => send(expectedSocket, 'dbAdd', sent));
        const actualCall = await wireCall(producer, sent => send(actualSocket, 'dbAdd', sent));
        const expected = expectedCall.result, actual = actualCall.result;
        const windows = { mongo: expectedCall.window, postgres: actualCall.window };
        const pgRaw = (await admin.query('SELECT ctid::text,id_kind,doc FROM ' + table(logical) + ' WHERE tenant_id=$1', [config.tenant])).rows;
        const mongoRaw = await mongo.db(config.mongoDatabase).collection(logical).find({}).toArray();
        observations.push({ logical, attempt, producer, before, windows, expected, actual, pgRaw, mongoRaw }); record();
        assert(expectedCall.producerUnchanged && actualCall.producerUnchanged, 'SOCKET_DATA_PRODUCER_IMMUTABLE');
        assert.equal(pgRaw.length, 1, 'SOCKET_DATA_RETRY_STORE_ONCE explicit stable identity');
        assert.equal(mongoRaw.length, 1, 'SOCKET_DATA_SINGLE_RETRY_STORE_ONCE explicit stable identity');
        if (logical === 'profile') {
          assert.equal(actual.outcome, 'reply'); assert.equal(expected.outcome, 'reply');
          require('./profile-timestamps').compare({ producer, before, windows, expected: expected.args, actual: actual.args,
            pgDocuments: pgRaw.map(require('../../../lib/storage/postgres-identity').decodeDocument), mongoRaw });
          continue;
        }
        assert.deepEqual(norm(actual), norm(expected), 'SOCKET_DATA_CALLBACK_PARITY ' + logical + '/' + attempt);
        const documentsFor = rows => rows.map(row => norm(row)).sort((a, b) => JSON.stringify(a._id).localeCompare(JSON.stringify(b._id)));
        assert.deepEqual(documentsFor(pgRaw.map(require('../../../lib/storage/postgres-identity').decodeDocument)), documentsFor(mongoRaw), 'SOCKET_DATA_STORED_PARITY ' + logical + '/' + attempt);
      }
    }
    // Duplicate-ID retry may be a canonical baseline noack/refusal. Its raw
    // stderr is retained by the parent; do not relabel it transport success.
  } finally {
    const cleanup = []; for (const socket of sockets) socket.close();
    if (reference) try { await reference.close(); } catch { cleanup.push('REFERENCE_CLOSE'); }
    if (adminReady) for (const logical of names) try { await admin.query('DELETE FROM ' + table(logical) + ' WHERE tenant_id=$1', [config.tenant]); } catch { cleanup.push('PG_CLEANUP_' + logical); }
    if (mongoReady) try { await mongo.db(config.mongoDatabase).dropDatabase(); } catch { cleanup.push('MONGO_CLEANUP'); }
    await Promise.allSettled([admin.end(), mongo.close()]);
    try { await roles.close(); } catch { cleanup.push('ROLE_CLOSE'); }
    observations.push({ cleanupErrors: cleanup }); record(); assert.equal(cleanup.length, 0, 'SOCKET_DATA_OWNED_CLEANUP');
  }
};
