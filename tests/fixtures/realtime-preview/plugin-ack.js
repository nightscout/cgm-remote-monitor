'use strict';
// Separate fresh cohort: actual treatmentnotify default snooze, actual clinical
// producer COMMIT, actual API human ACK. Never manufactures private producer state.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function pluginAck (input) {
  const roles = await require('./roles').start(input), config = roles.config, observations = {}, sockets = [];
  const {Client} = require('pg'), admin = new Client({connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI}); let connected = false;
  const table = name => { assert.match(name, /^[a-z][a-z0-9_]{0,62}$/); return '"' + name + '"'; };
  const save = extra => { Object.assign(observations, extra); fs.writeFileSync(path.join(input.captureDir, 'actual-plugin-ack.json'), JSON.stringify(observations, null, 2) + '\n'); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait (check, marker) { const until = Date.now() + config.timeoutMs; while (Date.now() < until) { const found = await check(); if (found) return found; await pause(10); } throw new Error(marker); }
  async function client (namespace) {
    const socket = roles.client({namespace,transports:['websocket']}); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return {send: (event, ...args) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PLUGIN_ACK_' + event + '_NOACK')), config.timeoutMs);
      socket.emit(event, ...args, (...reply) => { clearTimeout(timer); resolve(reply); });
    })};
  }
  try {
    assert.equal(roles.owned.tenant, config.tenant); assert.equal(roles.owned.outboxNamespace, config.outboxNamespace);
    assert.equal(roles.owned.alarmNamespace, config.alarmNamespace); assert.equal(roles.owned.namespaces.treatments, config.namespaces.treatments);
    const stateTable = table(config.outboxNamespace) + '.tenant_notification_state', suppressionTable = table(config.alarmNamespace) + '.tenant_alarm_suppression';
    await admin.connect(); connected = true;
    const state = async () => (await admin.query('SELECT revision,config_identity,producer FROM ' + stateTable + ' WHERE tenant_id=$1 AND consumer=$2', [config.tenant, config.consumerId])).rows;
    const suppressions = async () => (await admin.query('SELECT alarm_group,alarm_level,acked_at,expires_at FROM ' + suppressionTable + ' WHERE tenant_id=$1 ORDER BY alarm_group,alarm_level', [config.tenant])).rows;
    assert.deepEqual(await state(), [], 'PLUGIN_PHASE_REQUIRES_FRESH_PRODUCER_COHORT');
    assert.deepEqual(await suppressions(), [], 'PLUGIN_PHASE_REQUIRES_FRESH_OWNER_SUPPRESSION');
    const main = await client(''), alarm = await client('/alarm');
    const permission = await main.send('authorize', JSON.parse(input.env[config.dataCredentialEnv])); assert.equal(permission[0]?.write_treatment, true);
    assert.equal((await alarm.send('subscribe', JSON.parse(input.env[config.credentialEnv])))[0]?.success, true);
    const now = Date.now(), packet = {collection: 'treatments', data: {_id: 'synthetic-plugin-' + require('node:crypto').randomUUID(),
      eventType: 'Note', created_at: new Date(now).toISOString(), notes: 'Synthetic plugin snooze'}};
    const reply = await main.send('dbAdd', packet);
    const physical = (await admin.query('SELECT id_kind,doc FROM ' + table(config.namespaces.treatments) + '.treatments WHERE tenant_id=$1', [config.tenant])).rows;
    save({packet, reply, physical}); assert(physical.some(row => row.doc._id === packet.data._id), 'PLUGIN_ACTUAL_API_TREATMENT_STORED');
    await roles.startEvaluator();
    const before = await wait(async () => {
      const rows = await state(); save({producerBefore: rows});
      const alarms = rows[0]?.producer?.alarms;
      return Array.isArray(alarms) && alarms.some(row => row.group === 'default' && row.level === 2 && row.lastAckTime > 0 && row.lastAckTime + row.silenceTime > Date.now()) ? rows[0] : null;
    }, 'PLUGIN_ACTUAL_DEFAULT_SNOOZE_NOT_COMMITTED');
    const window = before.producer.alarms.filter(row => row.group === 'default' && [1, 2].includes(row.level));
    assert.deepEqual(window.map(row => row.level).sort(), [1, 2]);
    for (const row of window) assert.equal(row.silenceTime, 600000, 'ACTUAL_TREATMENTNOTIFY_DEFAULT_TEN_MINUTES');
    const beforeOwner = await suppressions(), ackStartedAt = Date.now();
    const ackReply = await alarm.send('ack', 2, 'default', config.snoozeMs);
    const immediately = await suppressions(); save({windowBefore: window, beforeOwner, ackStartedAt, ackReply, immediately});
    assert.deepEqual(immediately, beforeOwner, 'PLUGIN_WINDOW_HUMAN_ACK_NO_OWNER_WRITE');
    assert(Number.isSafeInteger(config.observationMs) && config.observationMs > 0 && config.observationMs <= 60000);
    await pause(config.observationMs);
    const after = await state(), afterOwner = await suppressions(); save({producerAfter: after, afterOwner});
    const afterWindow = after[0]?.producer?.alarms.filter(row => row.group === 'default' && [1, 2].includes(row.level));
    assert.deepEqual(afterWindow, window, 'PLUGIN_WINDOW_HUMAN_ACK_NO_SLIDE_OR_EXTENSION');
    assert.deepEqual(afterOwner, beforeOwner, 'PLUGIN_WINDOW_NO_DELAYED_OWNER_WRITE');
    save({pluginAckIgnored: true, originalAbsoluteExpiryPreserved: true});
  } finally {
    const errors = []; for (const socket of sockets) socket.close();
    try { await roles.close(); } catch { errors.push('ROLE_CLOSE'); }
    if (connected) try { await admin.end(); } catch { errors.push('ADMIN_CLOSE'); }
    save({cleanupErrors: errors}); assert.equal(errors.length, 0, 'PLUGIN_ACK_OWNED_CLEANUP');
  }
};
