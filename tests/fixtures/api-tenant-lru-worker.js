'use strict';
// Two-process native LRU instrument. Shipping API routers/storage/clock are real;
// request authentication and presentation settings are fixture-owned synthetic ports.
const http = require('node:http');
const express = require('express');
const shiro = require('shiro-trie');
const scope = require('../../lib/storage/tenant-scope');
const authentication = require('../../lib/api3/tenant-authentication');
const environment = require('../../lib/server/tenant-app/environment');
let connection, graph, server, cache, config, control;
const units = new Map();
async function start (input) {
  scope.setTenancyMode('multi');
  control = input.control;
  connection = await require('../../lib/storage/postgres-connection')({ connectionString: process.env.NS_LRU_APP_URI,
    max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000, application_name: 'api-tenant-lru-worker' });
  config = { domains: input.domains, namespaces: input.namespaces, legacyEnabled: true, contextEnabled: true,
    socketForwarding: true, bindings: { has: tenant => /^11111111-1111-4111-8111-[0-9]{12}$/.test(tenant) },
    environments: { get: tenant => environment({ settings: { units: units.get(tenant) || 'mg/dl' } }) } };
  cache = require('../../lib/server/serve/api-tenant-cache').create({ capacity: input.capacity, concurrency: 2, pendingLimit: 8, waitMs: 1000 });
  let dataConnection = require('../../lib/storage/postgres-write-clock')(connection, input.namespaces.clock);
  if (control === 'memory-clock') {
    const dates = require('../../lib/server/srv-dates');
    dataConnection = { ...connection, transaction: fn => connection.transaction(async () => {
      const tenant = scope.requireTenant('known-bad memory clock');
      const record = cache.peek(tenant) || {};
      const allocator = { tenant, active: true, next: () => (record.controlClock = (record.controlClock || 1000) + 1) };
      try { return await dates.withAllocator(allocator, fn); } finally { allocator.active = false; }
    }) };
  }
  graph = await require('../../lib/server/serve/preview-domains')({ config,
    connection: dataConnection, tenantCache: cache, exchange: async () => null });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const tenant = req.get('x-synthetic-tenant');
    if (!config.bindings.has(tenant)) return res.status(404).end();
    scope.withTenant(tenant, () => {
      req.tenantContext = { tenant };
      const rights = shiro.new(); rights.add('*');
      req.tenantAuthenticate = async () => authentication.bind(req, { shiros: [rights] });
      authentication.bind(req, { shiros: [rights] });
      next();
    });
  });
  app.use('/api/v3', graph.data);
  app.use(['/api/v1', '/api/v2'], graph.legacyRouter);
  app.use((error, req, res, next) => { void next; res.status(503).json({ error: error.code || 'LRU_TEST_FAILED', detail: error.message }); });
  server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, stats: cache.stats() };
}
async function close () {
  if (server) await new Promise(resolve => server.close(resolve));
  if (cache) await cache.close();
  if (connection) await connection.end();
}
process.on('message', async message => {
  try {
    let value;
    if (message.action === 'start') value = await start(message.input);
    else if (message.action === 'stats') value = cache.stats();
    else if (message.action === 'settings') {
      units.set(message.tenant, message.units);
      if (control !== 'skip-invalidation') graph.invalidateTenant(message.tenant);
      value = cache.stats();
    } else if (message.action === 'socket') {
      const execute = require('../../lib/server/tenant-socket-write-executor').createExecutor({ contextForOperation: graph.socketContextFor });
      value = await execute({ tenant: message.tenant, source: 'socket', namespace: '/', event: 'dbAdd',
        actor: { tenant: message.tenant, permissions: { read: true, write: true, write_treatment: true } },
        args: [{ collection: 'entries', data: message.document }] });
    } else if (message.action === 'close') { await close(); value = true; }
    else throw new Error('Unknown fixture action');
    process.send({ id: message.id, value });
    if (message.action === 'close') process.disconnect();
  } catch (error) { process.send({ id: message.id, error: { code: error.code, message: error.message } }); }
});
process.on('disconnect', () => { close().finally(() => process.exit()); });
