'use strict';

const producer = require('./producer-state');
const assertReady = require('./readiness');
const alarm = require('../tenant-alarms/contract');
const c = require('./contract');

// The original socket authority is checked in this transaction before this
// hook. Its restricted function marks only that tenant's producer for selection.
module.exports = function ackAdmission ({namespace, consumer, alarmNamespace, maxRows, maxBytes, maxPayloadBytes, expectedCatalogue}) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      ['public', 'information_schema'].includes(namespace) || namespace.startsWith('pg_') ||
      typeof consumer !== 'string' || !c.NAME.test(consumer)) throw new TypeError('Explicit selected notification ACK state required');
  for (const [name, value] of Object.entries({maxRows, maxBytes, maxPayloadBytes})) c.integer(value, name);
  // Reviewed schema compatibility only: user ACK does not require a live
  // evaluator, assignment, membership lease or notification owner.
  require('./partition-candidate').expectedMigrations(expectedCatalogue);
  const alarmTable = alarm.table(alarmNamespace), table = '"' + namespace + '".tenant_notification_state';
  return async function admitAck ({connection, operation, at, configIdentity}) {
    if (typeof configIdentity !== 'string' || !configIdentity) throw new TypeError('Fresh selected producer config identity required');
    const tenant = alarm.tenant(operation?.tenant), input = alarm.args(operation?.args);
    await assertReady(connection, namespace, {stateReadOnly: true, alarmTable, expectedCatalogue});
    await producer.lock(connection, tenant, consumer);
    const rows = (await connection.query('SELECT * FROM ' + table + ' WHERE tenant_id=$1 AND consumer=$2', [tenant, consumer])).rows;
    if (rows[0]?.producer?.ackPending === true) delete rows[0].producer.ackPending;
    if (rows.length > 1 || Buffer.byteLength(JSON.stringify(rows)) > maxBytes) throw new Error('NOTIFICATION_ACK_STATE_BOUND');
    const time = (await connection.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms /* notification-ack-time */')).rows;
    if (time.length !== 1) throw new Error('NOTIFICATION_ACK_TIME_INVALID');
    at = alarm.storedInstant(time[0].now_ms);
    if (!rows.length) return {accepted:true,at};
    const emitted = [], previous = producer.bounded(rows[0].producer, {maxRows, maxBytes});
    const service = producer.service(previous.alarms, at, {maxRows, maxBytes, maxPayloadBytes}, emitted);
    try {
      const accepted = service.ackAt(input.level, input.group, input.duration, true, at);
      if (accepted && expectedCatalogue === undefined) await connection.query(
        'SELECT /* notification-ack-discovery */ "' + namespace + '".tenant_notification_mark_ack($1,$2)', [tenant, consumer]);
      return {accepted,at};
    }
    finally { service.close(); }
  };
};
