'use strict';
// Actual successful evaluator→durable outbox→owned UDS relay→actual RT delivery.
// Relay drops one response AFTER actual handoff to create uncertain-send evidence.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
module.exports = async function consumer (input) {
  const roles = await require('./roles').start(input), config = roles.config, sockets = [], events = [], attempts = [], observations = {};
  const { Client } = require('pg'), admin = new Client({ connectionString: input.env.NS_TEST_POSTGRES_ADMIN_URI });
  let connected = false, relay, directory, runtimeDirectory, dropped = false, staleGrants, cold;
  const oracle = require('./consumer-oracles'), evaluatorEnvironment = require('./roles').roleEnvironment(JSON.parse(fs.readFileSync(config.evaluatorEnvFile)), input.env);
  const limits = JSON.parse(fs.readFileSync(evaluatorEnvironment.MULTITENANT_EVALUATOR_CONFIG)).consumers.realtime.outbox;
  const table = name => { assert.match(name, /^[a-z][a-z0-9_]{0,62}$/); return '"' + name + '"'; };
  const record = (extra = {}) => {
    Object.assign(observations, extra);
    fs.writeFileSync(path.join(input.captureDir, 'actual-consumer-handoff.json'), JSON.stringify({ events, attempts, ...observations }, null, 2) + '\n');
  };
  const requests = table(config.outboxNamespace) + '.tenant_notification_requests';
  const states = table(config.outboxNamespace) + '.tenant_notification_state';
  const requestRows = async () => oracle.bounded((await admin.query('SELECT tenant_id,request_id,consumer,payload,state,attempt,receipt,origin,config_identity,dedup_key FROM ' + requests + ' WHERE tenant_id=$1 AND consumer=$2 LIMIT $3', [config.tenant, config.consumerId, limits.maxRows + 1])).rows, limits);
  const producerRows = async () => oracle.bounded((await admin.query('SELECT revision,config_identity,producer FROM ' + states + ' WHERE tenant_id=$1 AND consumer=$2 LIMIT $3', [config.tenant, config.consumerId, limits.maxRows + 1])).rows, limits);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait (check, marker) { const until = Date.now() + config.timeoutMs; while (Date.now() < until) { const result = await check(); if (result) return result; await pause(10); } throw new Error(marker); }
  async function subscribe (credential, recipient) {
    const socket = roles.client({namespace:'/alarm',transports:['websocket']}); sockets.push(socket);
    socket.on('urgent_alarm', notification => { events.push({ recipient, kind: 'urgent_alarm', notification }); record(); });
    socket.on('clear_alarm', notification => { events.push({ recipient, kind: 'clear_alarm', notification }); record(); });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CONSUMER_SUBSCRIBE_NOACK')), config.timeoutMs);
      socket.emit('subscribe', credential, value => { clearTimeout(timer); resolve(value); }); }); assert.equal(result.success, true); return socket;
  }
  try {
    assert.equal(roles.owned.tenant, config.tenant); assert.equal(roles.owned.outboxNamespace, config.outboxNamespace);
    assert.equal(roles.owned.authorizationNamespace, config.authorizationNamespace);
    await admin.connect(); connected = true;
    await subscribe(JSON.parse(input.env[config.staleCredentialEnv]), 'stale');
    const good = await subscribe(JSON.parse(input.env[config.credentialEnv]), 'current');
    const auth = table(config.authorizationNamespace);
    // Sparse refused first recipient exercises real per-socket admission on RT.
    staleGrants = (await admin.query('SELECT role_name FROM ' + auth + '.tenant_authorization_subject_roles WHERE tenant_id=$1 AND subject_id=$2', [config.tenant, config.staleSubjectId])).rows;
    assert(staleGrants.length > 0, 'owned sparse-recipient subject must have removable grants');
    await admin.query('DELETE FROM ' + auth + '.tenant_authorization_subject_roles WHERE tenant_id=$1 AND subject_id=$2', [config.tenant, config.staleSubjectId]);
    runtimeDirectory = require('./runtime-directory')({ captureDir: input.captureDir, phaseId: input.phaseId });
    directory = runtimeDirectory.path;
    const socketPath = path.join(directory, 'relay.sock'), ipc = require('../../../lib/server/realtime/ipc');
    const deliver = ipc.client({ socketPath: config.alarmSocketPath, maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs });
    relay = await ipc.open({ socketPath, maxBytes: config.maxMessageBytes, timeoutMs: config.timeoutMs }, token => ({
      async '/alarm' (request, body) {
        assert.equal(request.transport, token);
        assert([roles.owned.tenant, roles.owned.foreignTenant].includes(body.tenant), 'handoff must belong to an attested fixture tenant');
        const result = await deliver('/alarm', body);
        if (result?.accepted !== true) throw new Error('CONSUMER_RELAY_HANDOFF_NOT_ACCEPTED');
        const attempt = {tenant:body.tenant,id:body.id,attempt:body.attempt,notification:body.notification,result};
        if (body.tenant === config.tenant && !body.notification.clear) {
          const rows = await requestRows(), first = attempts.find(row=>row.responseLost);
          attempt.durable = oracle.bindAttempt(attempt,rows,first);
          record({relayPhysicalRows:rows});
        }
        attempts.push(attempt);
        if (!dropped && body.tenant === config.tenant && !body.notification.clear) {
          dropped = true; attempt.responseLost = true; record(); throw new Error('INTENTIONAL_UNCERTAIN_RESPONSE_AFTER_HANDOFF');
        }
        record();
        return result;
      }
    }));
    const warm = await roles.startEvaluator({ alarmRoutePath: socketPath });
    record({warmEvaluatorPid:warm.pid});
    const boundary = await wait(()=>oracle.retryBoundary(attempts,config.tenant),'CONSUMER_ACTUAL_RETRY_BOUNDARY_NOT_OBSERVED');
    const physicalRetryRows = await requestRows();
    const original = oracle.retry({...boundary,rows:physicalRetryRows},record);
    const accepted = await wait(async () => {
      const rows = await requestRows(); record({requests:rows});
      return rows.find(row=>row.request_id===original.request_id&&row.state==='accepted'&&row.attempt>=2);
    },'CONSUMER_RETRY_COMPLETION_NOT_OBSERVED');
    record({accepted});
    assert.equal(events.some(row => row.recipient === 'stale' && row.kind === 'urgent_alarm'), false, 'CONSUMER_STALE_RECIPIENT no protected alarm');
    assert(events.some(row => row.recipient === 'current' && row.kind === 'urgent_alarm'), 'CONSUMER_VALID_RECIPIENT actual sparse failure must not block valid socket');
    assert.equal(accepted.receipt, null, 'RT_HANDOFF_NOT_DEVICE_RECEIPT');
    cold = await require('./cold-acquisition')({ input, roles, admin, warm, alarmRoutePath: socketPath, record, wait, sockets });
    const beforeProducer = (await producerRows())[0];
    if (!beforeProducer) throw new Error('CONSUMER_COLD_PRODUCER_STATE_REQUIRED');
    record({beforeAckProducer:beforeProducer});
    const beforeAckIds = new Set((await admin.query('SELECT request_id FROM ' + requests + ' WHERE tenant_id=$1 AND consumer=$2', [config.tenant, config.consumerId])).rows.map(row => row.request_id));
    const beforeAckClearEvents = events.filter(row => row.recipient === 'current' && row.kind === 'clear_alarm').length;
    record({ beforeAckRequestIds: [...beforeAckIds], beforeAckClearEvents });
    // API durable ACK on actual /alarm; observable suppression/cascade is a
    // separate persisted state, never a clinical checkpoint/request identity.
    const ackStartedAt = Date.now();
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CONSUMER_ACK_NOACK')), config.timeoutMs);
      good.emit('ack', 2, accepted.payload.group || 'default', config.snoozeMs, () => { clearTimeout(timer); resolve(); }); });
    assert.equal(roles.owned.alarmNamespace, config.alarmNamespace);
    const suppressed = (await admin.query('SELECT alarm_group,alarm_level,acked_at,expires_at FROM ' + table(config.alarmNamespace) +
      '.tenant_alarm_suppression WHERE tenant_id=$1 AND alarm_group=$2', [config.tenant, accepted.payload.group || 'default'])).rows;
    record({ accepted, suppressed });
    const keys = oracle.ackKeys(suppressed);
    const producer = await wait(async () => {
      const rows = await producerRows(); record({coldAckProducerObservations:rows});
      return oracle.consumed(rows[0],keys,beforeProducer.revision) ? rows[0] : null;
    },'CONSUMER_COLD_ACK_CONSUMPTION_NOT_OBSERVED');
    const coldBoundary = await wait(()=>cold.observe(ackStartedAt),'CONSUMER_COLD_POST_ACK_OBSERVATION_REQUIRED');
    const physicalClear = oracle.clear({producer,ackKeys:keys,beforeRevision:beforeProducer.revision,
      beforeAckRequestIds:[...beforeAckIds],rows:await requestRows(),cold:coldBoundary,suppressed},record);
    const clear = await wait(async () => {
      const rows = await requestRows(); record({coldAfterAckRequests:rows});
      return rows.find(row=>row.request_id===physicalClear.request_id&&row.state==='accepted');
    },'CONSUMER_COLD_CLEAR_COMPLETION_NOT_OBSERVED');
    await wait(() => events.filter(row => row.recipient === 'current' && row.kind === 'clear_alarm').length > beforeAckClearEvents, 'CONSUMER_COLD_ACK_CLEAR_NOT_DELIVERED');
    const coldAfterAck = await wait(() => cold.observe(ackStartedAt), 'CONSUMER_COLD_POST_ACK_OBSERVATION_REQUIRED'); record({ coldClear: clear, coldAfterAck });
    assert(coldAfterAck, 'CONSUMER_COLD_CLEAR_CLINICAL_STILL_REFUSED_LAST_NULL');
    assert.equal(clear.receipt, null);
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
    if (cold) try { cold.restore(); } catch { errors.push('COLD_CONFIG_RESTORE'); }
    if (relay) try { await relay.close(); } catch { errors.push('RELAY_CLOSE'); }
    if (runtimeDirectory) try { runtimeDirectory.close(); } catch { errors.push('RELAY_RUNTIME_DIRECTORY_CLEANUP'); }
    if (connected && staleGrants) try {
      for (const row of staleGrants) await admin.query('INSERT INTO ' + table(config.authorizationNamespace) +
        '.tenant_authorization_subject_roles(tenant_id,subject_id,role_name) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [config.tenant, config.staleSubjectId, row.role_name]);
    } catch { errors.push('STALE_GRANT_RESTORE'); }
    try { await admin.end(); } catch { errors.push('ADMIN_CLOSE'); }
    record({ cleanupErrors: errors }); assert.equal(errors.length, 0, 'CONSUMER_OWNED_CLEANUP');
  }
};
