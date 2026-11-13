'use strict';
const c = require('./contract');
module.exports = function notificationStateConfig (value, source, alarm) {
  if (value === undefined) return undefined;
  if (!c.exact(value, ['evaluatorConfigEnv'])) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
  const config = require('../serve/evaluator-config').loadMetadata({...source, MULTITENANT_EVALUATOR_CONFIG: c.reference(value.evaluatorConfigEnv, source)});
  const selected = config.consumers?.realtime;
  const endpoint = require('../serve/evaluator-consumer-config').endpoint;
  if (!selected || !config.datastore || selected.suppression.namespace !== alarm.namespace ||
      require('../serve/evaluator-config').descriptorEndpoint(config.datastore) !== endpoint(alarm.connectionString)) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
  return Object.freeze({namespace: selected.outbox.namespace, consumer: selected.route.id,
    maxRows: selected.outbox.maxRows, maxBytes: selected.outbox.maxBytes, maxPayloadBytes: selected.maxPayloadBytes,
    readCurrent: config.readCurrent});
};
