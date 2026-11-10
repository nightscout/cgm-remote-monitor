'use strict';

const express = require('express');
const scope = require('../../storage/tenant-scope');
const c = require('../realtime/contract');
const ipc = require('../internal-api/transport');
const clients = require('../internal-api/clients');
const { alarmDelivery } = require('../internal-api/contracts');
const protocolFactory = require('../realtime/protocol');
const { PreviewConfigError } = require('./preview-config');
async function boot (config, { operationWindow } = {}) {
  let connection, runtime, protocol, io, alarms, closing, quiescing;
  function quiesce () {
    if (quiescing) return quiescing;
    quiescing = (async () => {
    protocol?.close();
    if (runtime) await runtime.close();
    if (alarms) await alarms.close();
    if (io) await new Promise(resolve => io.close(resolve));
    })();
    return quiescing;
  }
  function close () {
    if (closing) return closing;
    closing = (async () => { try { await quiesce(); } finally { if (connection) await connection.end(); } })();
    return closing;
  }
  try {
    await require('./evaluator-readiness')(config, { operationWindow }); // same read-only clinical/owned-checkpoint contract
    scope.setTenancyMode('multi');
    connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString,
      max: 4, connectionTimeoutMillis: config.operationTimeoutMs, statement_timeout: config.operationTimeoutMs,
      application_name: 'nightscout-realtime-preview' });
    const api = clients.socketAuthority(config.api);
    const startup = require('./tenant-startup').create(config.tenants.keys(), operationWindow, async tenant => {
      await require('./evaluator-readiness').provisionTenant(connection, config, tenant);
      await connection.withTenant(tenant, async () => {
        const other = await connection.query('SELECT 1 FROM "' + config.namespaces.checkpoint + '".tenant_consumer_checkpoint WHERE consumer<>$1 LIMIT 1', [config.consumer]);
        if (other.rows.length) c.fail('REALTIME_CHECKPOINT_SCOPE_REFUSED');
      });
      if (await config.readCurrent(tenant)) {
        const host = config.admission.aliases.find(alias => alias.tenant === tenant)?.host;
        await api.authorizeSocket({ host, tenant, namespace: '/', credential: {} });
      }
    });
    await startup.warm();
    protocol = protocolFactory.create({ operationWindow, admission: config.admission, api, readCurrent: config.readCurrent,
      humanSessionsEnabled: (process.env.ENABLE || '').split(/\s+/).includes('oidc'),
      humanAccepts: require('../../human-session/access-config').humanRouting(),
      runtime: () => runtime, maxSockets: config.maxSockets, domains: require('../../data/tenant-projection-evaluator').domains });
    runtime = await require('../realtime/runtime')({ tenants: [...config.tenants.keys()], readCurrent: config.readCurrent,
      recoveryIntervalMs: config.recoveryIntervalMs, operationWindow, prepareTenant: startup.ensure,
      create: current => require('../realtime/projection')({ config, connection, current }), fanout: protocol.fanout });
    alarms = await ipc.open(config.alarms, alarmDelivery, token => require('../realtime/alarm-transport').operations({ token, deliver: protocol.alarm }), {operationWindow, resolveTenant: body => body.tenant});
    const app = express(); app.disable('x-powered-by');
    app.get('/health', (req, res) => { const health = runtime.health(); res.status(health.ready ? 200 : 503).json(health); });
    app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    return Object.freeze({ app, quiesce, close,
      async invalidateTenant (tenant) { startup.invalidateTenant(tenant); protocol.invalidateTenant(tenant); await runtime.invalidateTenant(tenant); }, health: runtime.health, refresh: runtime.refresh,
      async attach (server) {
        if (io) c.fail('REALTIME_ALREADY_ATTACHED');
        io = require('socket.io')({}).listen(server, { allowEIO3: true, transports: ['polling', 'websocket'], maxHttpBufferSize: config.maxMessageBytes,
          allowRequest: (request, callback) => {
            if (!protocolFactory.origin(request)) return callback(null, false);
            config.admission.resolve(request).then(() => callback(null, true), () => callback(null, false));
          } });
        for (const namespace of ['/', '/storage', '/alarm']) {
          const channel = io.of(namespace);
          channel.use((socket, next) => protocol.prepare(socket).then(() => next(), () => next(new Error('REALTIME_HANDSHAKE_REFUSED'))));
          channel.on('connection', socket => protocol.bind(socket, namespace));
        }
      }
    });
  } catch {
    await close(); throw new PreviewConfigError('realtime preview readiness or initialization refused');
  }
}
module.exports = { boot };
