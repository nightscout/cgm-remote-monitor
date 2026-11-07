'use strict';

// Native test child: credentials arrive only through the environment; never print them.
const connect = require('../../lib/storage/postgres-connection');
const scope = require('../../lib/storage/tenant-scope');
const createStore = require('../../lib/tenant-notifications/postgres');
const createComponent = require('../../lib/tenant-notifications/component');
const { notification } = require('./tenant-notifications-native');
(async () => {
  const config = JSON.parse(process.env.NS_NOTIFICATION_CHILD);
  scope.setTenancyMode('multi');
  const connection = await connect({ connectionString: config.connectionString, max: 1, statement_timeout: 5000 });
  const store = createStore({ connection, namespace: config.namespace, maxRows: 10, maxBytes: 65536 });
  const cycle = { tenant: config.tenant, identity: 'native-config', runtimeId: 'native-child', outputRevision: 1,
    eligible: true, result: { now: config.at, emitted: [notification()] } };
  const component = createComponent({ store, adapter: { id: 'synthetic', send (row) {
    // This fake consumer records acceptance but deliberately never calls completion.
    process.send({ phase: 'synthetic-acceptance-no-completion', id: row.id, attempt: row.attempt });
  } }, selectCycle: async () => cycle, isCurrent: async () => true, allows: async () => true, now: () => config.at,
  maxRows: 10, maxPayloadBytes: 10000, maxInflight: 1, attemptTimeoutMs: 10000, retryDelayMs: 1 });
  await component.run(config.tenant); await component.close(); await connection.end();
})().catch(() => { process.exitCode = 1; });
