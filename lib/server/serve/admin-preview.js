'use strict';

// The multitenant `admin` role (D7): the platform operator's private plane. Its
// listener (ADMIN_HOSTNAME / ADMIN_PORT, lib/server/serve/listeners.js plane rule:
// loopback unless acknowledged, never every interface, never the consumer
// listener's port on the same address) serves
// exactly the composed operator service contracts, through the shared internal
// transport (decision internal-service-contracts). It has no credential of its
// own; it is secured by unreachability, and HTTP access policy belongs to the
// deployment.
//
// Composed operator services:
//   ownership-operations  operator-assisted ownership list/add/transfer/recover
//                         (lib/tenant-ownership), on the ownership_operator
//                         database identity, for the configured tenants only.
//   pool-operations       read a partitioned pool kind and set its member count
//                         (lib/pool-membership/operator.js), on the pool
//                         operator database identity, for the configured kinds.
// Versioned REST resources (decision operator-rest-api), beside the RPC contracts:
//   /v1/tenants           tenant provisioning (lib/tenant-registry/rest.js), on the
//                         provisioning database identity and Vault credential.
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
  const store = await createOwnershipStore({ connectionString: selected.connectionString, namespace: selected.namespace,
    lifecycleNamespace: selected.lifecycleNamespace });
  resources.push(store);
  let authorizeOperator;
  if (selected.registry) {
    // Registry mode: the operator acts for the tenants the registry holds as active.
    const connection = await require('../../storage/postgres-connection')({ connectionString: selected.connectionString, max: 1,
      connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-admin-ownership-registry' });
    resources.push({ close: () => connection.end() });
    const registry = require('../../tenant-registry/postgres').create({ connection, namespace: selected.registry.namespace });
    authorizeOperator = ownershipService.registryAuthority({ ...selected.operator, isActive: async tenant => (await registry.entry(tenant))?.state === 'active' });
  } else authorizeOperator = ownershipService.tenantSetAuthority({ ...selected.operator, tenants: selected.tenants.slice() });
  const ownership = createOwnershipOperations({ store, authorizeOperator });
  return { service: ownershipService.contract,
    create: token => ownershipService.operations({ token, ownership, operator: selected.operator }) };
}

const POOL_DENIED = ['POOL_KIND_UNKNOWN', 'POOL_MEMBERS_INVALID'];
async function poolModule (selected, resources) {
  await identityReadiness(selected.connectionString);
  const operator = await require('../../pool-membership').operator({ connectionString: selected.connectionString,
    namespace: selected.namespace, kinds: selected.kinds.slice(), applicationName: 'nightscout-admin-pool' });
  resources.push(operator);
  const contract = require('../internal-api/contracts').poolOperations;
  const call = (fn, outcome, token) => async (request, body) => {
    if (!request || request.transport !== token) throw failure('POOL_PRIVATE_REQUEST_REFUSED');
    try { const result = await fn(body); return outcome ? { outcome, ...result } : result; }
    catch (error) { if (POOL_DENIED.includes(error.code)) return { outcome: 'denied', code: error.code }; throw error; }
  };
  return { service: contract, create: token => ({
    getPool: call(body => operator.get(body.kind), 'observed', token),
    setPoolMembers: call(async body => {
      const result = await operator.setMembers(body.kind, body.members);
      console.log('admin: pool ' + body.kind + ' member count ' + result.outcome + ': ' + JSON.stringify(result.desired));
      return result;
    }, undefined, token)
  }) };
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
    const modules = [];
    if (config.ownership) modules.push(await ownershipModule(config.ownership, resources));
    if (config.pools) modules.push(await poolModule(config.pools, resources));
    // A provisioning-only admin role composes no RPC contract: anything outside
    // the REST prefix is not found.
    const handler = modules.length ? operatorHandler(modules, config, () => !closed)
      : Object.assign((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"NOT_FOUND"}'); }, { routes: [] });
    let app = handler;
    if (config.provisioning) {
      await identityReadiness(config.provisioning.connectionString);
      const provisioning = require('../../tenant-registry/provision').createProvisioning(config.provisioning);
      resources.push({ close: () => provisioning.close() });
      // Counts and codes only; a root secret is never logged.
      const rest = require('../../tenant-registry/rest').createProvisioningApi({ provisioning, maxBytes: config.maxBytes, admitted: () => !closed,
        log: event => console.log('admin: ' + JSON.stringify(event)) });
      app = (req, res) => (typeof req.url === 'string' && req.url.startsWith(rest.prefix) ? rest : handler)(req, res);
    }
    if (config.connectorSources) {
      await identityReadiness(config.connectorSources.connectionString);
      const store = await require('../../tenant-connector/postgres-sources').create({ ...config.connectorSources, writer: true });
      resources.push(store);
      const source = require('../../tenant-connector/source-rest').create({ store, maxBytes: config.maxBytes, admitted: () => !closed });
      const other = app;
      app = (req, res) => source.matches(req.url) ? source.handle(req, res) : other(req, res);
    }
    return {
      app,
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

module.exports = { boot, identityReadiness, operatorHandler, poolModule };
