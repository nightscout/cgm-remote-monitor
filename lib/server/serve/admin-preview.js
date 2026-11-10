'use strict';

// The multitenant `admin` role (D7): the platform operator's private plane. Its
// listener (ADMIN_HOSTNAME / ADMIN_PORT, lib/server/serve/listeners.js plane rule:
// loopback unless acknowledged, never the consumer listener's address) serves
// exactly the composed operator service contracts, through the shared internal
// transport (decision internal-service-contracts). It has no credential of its
// own; it is secured by unreachability, and HTTP access policy belongs to the
// deployment.
//
// Composed operator services:
//   ownership-operations  operator-assisted ownership list/add/transfer/recover
//                         (lib/tenant-ownership), on the ownership_operator
//                         database identity, for the configured tenants only.
const { Client } = require('pg');
const transport = require('../internal-api/transport');
const scope = require('../../storage/tenant-scope');
const createOwnershipStore = require('../../tenant-ownership/postgres');
const { createOwnershipOperations } = require('../../tenant-ownership/component');
const ownershipService = require('../../tenant-ownership/service');

function failure (code) { return Object.assign(new Error(code), { code }); }

// The ownership identity must not be able to step around tenant RLS or the
// privilege screen: no superuser, BYPASSRLS, role or database creation, or
// replication. The store's own screen checks the table privileges.
async function identityReadiness (connectionString) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    await client.connect();
    const role = (await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!role || Object.values(role).some(Boolean)) throw failure('ADMIN_IDENTITY_UNSAFE');
  } finally { await client.end().catch(() => {}); }
}

// One module per composed operator service: { service, create(token) }.
async function ownershipModule (selected, resources) {
  await identityReadiness(selected.connectionString);
  const store = await createOwnershipStore({ connectionString: selected.connectionString, namespace: selected.namespace });
  resources.push(store);
  const ownership = createOwnershipOperations({ store,
    authorizeOperator: ownershipService.tenantSetAuthority({ ...selected.operator, tenants: selected.tenants.slice() }) });
  return { service: ownershipService.contract,
    create: token => ownershipService.operations({ token, ownership, operator: selected.operator }) };
}

// The admin listener's request handler: exactly the composed modules' routes,
// one owned token per module (as transport.compose issues them).
function operatorHandler (modules, { maxBytes, timeoutMs }, admitted) {
  const owned = modules.map(module => { const token = Symbol('owned-admin-operation');
    return { service: module.service, token, operations: module.create(token) }; });
  return transport.handler({ maxBytes, timeoutMs, modules: owned, admitted });
}

async function boot (config) {
  const resources = []; let closed = false, closing;
  function close () {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      const results = await Promise.allSettled(resources.reverse().map(resource => resource.close()));
      if (results.some(result => result.status === 'rejected')) throw new Error('admin role shutdown failed');
    })();
    return closing;
  }
  try {
    scope.setTenancyMode('multi');
    const modules = [await ownershipModule(config.ownership, resources)];
    const handler = operatorHandler(modules, config, () => !closed);
    return {
      app: handler,
      routes: handler.routes,
      async attach (server) {
        server.headersTimeout = config.timeoutMs;
        server.requestTimeout = config.timeoutMs;
      },
      quiesce () { closed = true; },
      close
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}

module.exports = { boot, identityReadiness, operatorHandler };
