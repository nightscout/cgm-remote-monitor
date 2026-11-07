'use strict';
// Actual successful evaluator→durable outbox→owned UDS relay→actual RT delivery.
// Relay drops one response AFTER actual handoff to create uncertain-send evidence.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function consumer (input) {
  const roles = await require('./roles').start(input), config = roles.config, sockets = [], events = [], attempts = [];
  const { Client } = require('pg'), admin = new Client({ connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI });
  let connected = false, relay, directory, dropped = false, staleGrants;
  const table = name => { assert.match(name, /^[a-z][a-z0-9_]{0,62}$/); return '"' + name + '"'; };
  const record = extra => fs.writeFileSync(path.join(input.captureDir, 'actual-consumer-handoff.json'), JSON.stringify({ events, attempts, ...extra }, null, 2) + '\n');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait (check, marker) { const until = Date.now() + config.timeoutMs; while (Date.now() < until) { const result = await check(); if (result) return result; await pause(10); } throw new Error(marker); }
  async function subscribe (credential, recipient) {
    const socket = require('socket.io-client')('http://127.0.0.1:' + roles.ingress.port + '/alarm', { transports: ['websocket'], forceNew: true,
      reconnection: false, timeout: config.timeoutMs, extraHeaders: { Host: config.host } }); sockets.push(socket);
    socket.on('urgent_alarm', notification => { events.push({ recipient, kind: 'urgent_alarm', notification }); record(); });
    socket.on('clear_alarm', notification => { events.push({ recipient, kind: 'clear_alarm', notification }); record(); });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CONSUMER_SUBSCRIBE_NOACK')), config.timeoutMs);
      socket.emit('subscribe', credential, value => { clearTimeout(timer); resolve(value); }); }); assert.equal(result.success, true); return socket;
  }
  try {
    assert.equal(roles.owned.tenant, config.tenant); assert.equal(roles.owned.outboxNamespace, config.outboxNamespace);
    assert.equal(roles.owned.authorizationNamespace, config.authorizationNamespace);
    assert(Buffer.byteLength(input.captureDir) <= 56, 'owned relay requires short captureDir');
    await admin.connect(); connected = true;
    await subscribe(JSON.parse(input.env[config.staleCredentialEnv]), 'stale');
    const good = await subscribe(JSON.parse(input.env[config.credentialEnv]), 'current');
    const auth = table(config.authorizationNamespace);
    // Sparse refused first recipient exercises real per-socket admission on RT.
    staleGrants = (await admin.query('SELECT role_name FROM ' + auth + '.tenant_authorization_subject_roles WHERE tenant_id=$1 AND subject_id=$2', [config.tenant, config.staleSubjectId])).rows;
    assert(staleGrants.length > 0, 'owned sparse-recipient subject must have removable grants');
    await admin.query('DELETE FROM ' + auth + '.tenant_authorization_subject_roles WHERE tenant_id=$1 AND subject_id=$2', [config.tenant, config.staleSubjectId]);
    directory = fs.mkdtempSync(path.join(input.captureDir, 'route-')); fs.chmodSync(directory, 0o700);
    const socketPath = path.join(directory, 'relay.sock'), ipc = require('../../../lib/server/realtime/ipc');
    const deliver = ipc.client({ socketPath: config.alarmSocketPath, maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs });
    relay = await ipc.open({ socketPath, maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs }, token => ({
      async '/alarm' (request, body) {
        assert.equal(request.transport, token); assert.equal(body.tenant, config.tenant);
        const result = await deliver('/alarm', body); attempts.push({ id: body.id, attempt: body.attempt, notification: body.notification, result }); record();
        if (!dropped && !body.notification.clear) { dropped = true; throw new Error('INTENTIONAL_UNCERTAIN_RESPONSE_AFTER_HANDOFF'); }
        return result;
      }
    }));
    await roles.startEvaluator({ alarmRoutePath: socketPath });
    const requests = table(config.outboxNamespace) + '.tenant_notification_requests';
    const accepted = await wait(async () => {
      const rows = (await admin.query('SELECT request_id,consumer,payload,state,attempt,receipt FROM ' + requests + ' WHERE tenant_id=$1 AND consumer=$2', [config.tenant, config.consumerId])).rows;
      record({ requests: rows }); return rows.find(row => row.state === 'accepted' && row.attempt >= 2 && !row.payload.clear);
    }, 'CONSUMER_SAME_ID_RETRY_NOT_ACCEPTED');
    const same = attempts.filter(row => row.id === accepted.request_id && !row.notification.clear);
    assert(same.length >= 2, 'CONSUMER_UNCERTAIN_SAME_ID actual retry must retain UUID');
    assert.deepEqual(same[0].notification, same[1].notification, 'CONSUMER_RETRY_UNCHANGED_PAYLOAD');
    assert.deepEqual(same[0].notification, accepted.payload, 'CONSUMER_PERSISTED_PAYLOAD actual relay preserves durable notification');
    assert.equal(events.some(row => row.recipient === 'stale' && row.kind === 'urgent_alarm'), false, 'CONSUMER_STALE_RECIPIENT no protected alarm');
    assert(events.some(row => row.recipient === 'current' && row.kind === 'urgent_alarm'), 'CONSUMER_VALID_RECIPIENT actual sparse failure must not block valid socket');
    assert.equal(accepted.receipt, null, 'RT_HANDOFF_NOT_DEVICE_RECEIPT');
    // API durable ACK on actual /alarm; observable suppression/cascade is a
    // separate persisted state, never a clinical checkpoint/request identity.
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CONSUMER_ACK_NOACK')), config.timeoutMs);
      good.emit('ack', 2, accepted.payload.group || 'default', config.snoozeMs, () => { clearTimeout(timer); resolve(); }); });
    assert.equal(roles.owned.alarmNamespace, config.alarmNamespace);
    const suppressed = (await admin.query('SELECT alarm_group,alarm_level,acked_at,expires_at FROM ' + table(config.alarmNamespace) +
      '.tenant_alarm_suppression WHERE tenant_id=$1 AND alarm_group=$2', [config.tenant, accepted.payload.group || 'default'])).rows;
    assert.deepEqual(suppressed.map(row => row.alarm_level).sort(), [1, 2]);
    assert(Number.isSafeInteger(config.settleMs) && config.settleMs > 0 && config.settleMs <= 60000);
    assert(Number.isSafeInteger(config.observationMs) && config.observationMs > 0 && config.observationMs <= 60000);
    await pause(config.settleMs); const before = events.filter(row => row.kind === 'urgent_alarm').length;
    await pause(config.observationMs);
    assert.equal(events.filter(row => row.kind === 'urgent_alarm').length, before, 'CONSUMER_CURRENT_DURABLE_SUPPRESSION stops new alarm handoffs');
    record({ accepted, suppressed, sameIdRetry: true, suppressionStopsDelivery: true });
  } finally {
    const errors = []; for (const socket of sockets) socket.close();
    // Stop producer before relay/RT; role fixture owns its children only.
    try { await roles.close(); } catch { errors.push('ROLE_CLOSE'); }
    if (relay) try { await relay.close(); } catch { errors.push('RELAY_CLOSE'); }
    if (directory) { const names = fs.readdirSync(directory); if (names.length) errors.push('RELAY_ENDPOINT_REMAINED'); else fs.rmdirSync(directory); }
    if (connected && staleGrants) try {
      for (const row of staleGrants) await admin.query('INSERT INTO ' + table(config.authorizationNamespace) +
        '.tenant_authorization_subject_roles(tenant_id,subject_id,role_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [config.tenant, config.staleSubjectId, row.role_name]);
    } catch { errors.push('STALE_GRANT_RESTORE'); }
    try { await admin.end(); } catch { errors.push('ADMIN_CLOSE'); }
    record({ cleanupErrors: errors }); assert.equal(errors.length, 0, 'CONSUMER_OWNED_CLEANUP');
  }
};
