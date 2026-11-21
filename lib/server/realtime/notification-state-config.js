'use strict';
const c = require('./contract');
module.exports = function notificationStateConfig (value, source, alarm) {
  if (value === undefined) return undefined;
  // The evaluator's notification outbox and suppression, read from the same
  // environment (lib/server/serve/deployment-settings.js).
  if (!c.exact(value, [])) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
  const config = require('../serve/evaluator-config').loadMetadata(source);
  const selected = config.consumers?.realtime;
  const endpoint = require('../serve/evaluator-consumer-config').endpoint;
  if (!selected || !config.datastore || selected.suppression.namespace !== alarm.namespace ||
      require('../serve/evaluator-config').descriptorEndpoint(config.datastore) !== endpoint(alarm.connectionString)) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
  return Object.freeze({namespace: selected.outbox.namespace, consumer: selected.route.id,
    ...(selected.expectedCatalogue === undefined ? {} : {expectedCatalogue: selected.expectedCatalogue}),
    maxRows: selected.outbox.maxRows, maxBytes: selected.outbox.maxBytes, maxPayloadBytes: selected.maxPayloadBytes,
    readCurrent: (tenant, registryAdmission, settingsReader) => config.readCurrent(tenant, settingsReader, registryAdmission)});
};
