'use strict';

// The process's one private listener (serve.internal). Which internal contracts
// it serves is decided here, by the roles' code; serve.internal configuration
// only says where it listens (lib/server/internal-api/listener-config.js).
//
// The route table is fixed when the listener opens, before any role boots, so
// a co-resident caller (realtime warming its tenants against api) reaches a
// contract the moment its role has booted. A role binds its handlers after its
// boot; until then its routes answer SOCKET_IPC_NOT_READY (503, distinct from a
// refusal, so a peer warming against it retries). Start-up refuses
// a role that binds a contract it does not own, and any contract left unbound.
//
// The same listener answers the role's GET health endpoints
// (lib/server/serve/role-health.js): /healthz/live, /healthz/ready,
// /healthz/datastore, /healthz/schema and /healthz/isolation. A process with no contract still
// opens it for health when serve.internal is configured explicitly.
const fs = require('node:fs');
const path = require('node:path');
const transport = require('../internal-api/transport');
const contracts = require('../internal-api/contracts');
const hints = require('../../internal-hints');

// Role -> the internal contracts its code may serve. Configuration cannot add,
// move or merge an entry; a role's own settings only switch its contract on.
const OWNED = Object.freeze({
  api: Object.freeze(['socket-authority']),
  realtime: Object.freeze(['alarm-delivery', 'completed-output', 'realtime-inspection', 'storage-events']),
  evaluator: Object.freeze(['evaluator-inspection', 'evaluator-readiness-witness']),
  'tenant-admin': Object.freeze([]),
  vcpool: Object.freeze(['connector-inspection'])
});
const SERVICES = Object.freeze(Object.fromEntries(Object.values(contracts).map(service => [service.id, service])));
const fail = (code, detail) => { throw Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code }); };

// The contracts this process serves: [{id, roles, bounds, lifetime}] from the
// roles' own parsed settings. Pure; no I/O.
function plan (names, { preview, realtimePreview, vcpoolPreview, evaluatorPreview } = {}) {
  const rows = [];
  if (names.includes('api') && preview && preview.socketForwarding) {
    const settings = preview.socketForwarding;
    rows.push({ id: 'socket-authority', roles: ['api'], tenantScoped: true,
      bounds: { maxBytes: settings.maxMessageBytes, timeoutMs: settings.operationTimeoutMs } });
  }
  if (names.includes('realtime') && realtimePreview) {
    rows.push({ id: 'alarm-delivery', roles: ['realtime'], tenantScoped: true,
      bounds: { maxBytes: realtimePreview.maxMessageBytes, timeoutMs: realtimePreview.operationTimeoutMs } });
  }
  if (names.includes('realtime') && realtimePreview?.completedOutput) rows.push({id:'completed-output',roles:['realtime'],tenantScoped:false,bounds:{maxBytes:4096,timeoutMs:1000}});
  if (names.includes('realtime') && (realtimePreview?.placement || realtimePreview?.completedOutput)) {
    rows.push({ id: 'realtime-inspection', roles: ['realtime'], tenantScoped: false,
      bounds: { maxBytes: 1048576, timeoutMs: 5000 } });
  }
  if (names.includes('vcpool') && vcpoolPreview) {
    // The connector pool's operational read: refusals per member and tenant.
    rows.push({ id: 'connector-inspection', roles: ['vcpool'], tenantScoped: false,
      bounds: { maxBytes: 4194304, timeoutMs: 5000 } });
  }
  if (names.includes('evaluator') && evaluatorPreview && evaluatorPreview.inspection === true) {
    // The evaluator's operational read: configured pool values beside observed
    // membership and per-tenant progress (lib/server/serve/evaluator-config.js inspectionFor).
    rows.push({ id: 'evaluator-inspection', roles: ['evaluator'], tenantScoped: false,
      bounds: { maxBytes: 4194304, timeoutMs: 5000 } });
    rows.push({ id: 'evaluator-readiness-witness', roles: ['evaluator'], tenantScoped: false,
      bounds: { maxBytes: 1048576, timeoutMs: 5000 } });
  }
  for (const row of rows) {
    if (!row.roles.every(role => names.includes(role) && OWNED[role] && OWNED[role].includes(row.id))) fail('INTERNAL_API_CONTRACT_UNOWNED', row.id);
  }
  return rows;
}

// Create the default runtime directory (0700) when the default socket is used.
function prepareDirectory (internal) {
  if (!internal.defaultSocket || !internal.listen.socketPath) return;
  const parent = path.dirname(internal.listen.socketPath);
  try { fs.mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

// Health requests carry no body; a check opens at most one connection per login.
const HEALTH_BOUNDS = Object.freeze({ maxBytes: 1024, timeoutMs: 15000 });

// open(internal, rows, {operationWindow, health}) -> {routes, address, bind, assertBound, close}
async function open (internal, rows, { operationWindow, health } = {}) {
  if (!rows.length && !health) return null;
  const slots = new Map();
  const modules = rows.map(row => {
    const service = SERVICES[row.id];
    if (!service) fail('INTERNAL_API_CONTRACT_UNOWNED', row.id);
    const slot = { row, service, token: null, operations: null, resolveTenant: null };
    slots.set(row.id, slot);
    const create = token => {
      slot.token = token;
      return Object.fromEntries(Object.keys(service.operations).map(name => [name, (request, body) => {
        if (!slot.operations) fail('SOCKET_IPC_NOT_READY');
        return slot.operations[name](request, body);
      }]));
    };
    const lifetime = row.tenantScoped && operationWindow ? { operationWindow, resolveTenant: body => {
      if (!slot.resolveTenant) fail('SOCKET_IPC_NOT_READY');
      return slot.resolveTenant(body);
    } } : undefined;
    return { service, create, bounds: row.bounds, ...(lifetime ? { lifetime } : {}) };
  });
  // The realtime preview binds this advisory receiver only with a tenant generation window.
  let storageBinding;
  const storage = operationWindow && rows.some(row => row.roles.includes('realtime'))
    ? hints.receiver.create({
      ready: () => !!storageBinding,
      owns: tenant => storageBinding.owns(tenant),
      handlers: { 'storage-events': (tenant, hint) => storageBinding.receive(tenant, hint) }
    }) : null;
  const bounds = [...rows.map(row => row.bounds), ...(health ? [HEALTH_BOUNDS] : []),
    ...(storage ? [{ maxBytes: hints.contract.KINDS['storage-events'].maxBytes, timeoutMs: hints.contract.TIMEOUT_MS }] : [])];
  const widest = { maxBytes: Math.max(...bounds.map(row => row.maxBytes)), timeoutMs: Math.max(...bounds.map(row => row.timeoutMs)) };
  prepareDirectory(internal);
  const listener = await transport.compose({ ...internal.listen, ...widest }, modules,
    { shutdownTimeoutMs: internal.shutdownTimeoutMs, ...(health ? { get: health } : {}), ...(storage ? { hints: storage.handle } : {}) });
  return Object.freeze({
    routes: storage ? Object.freeze([...listener.routes, 'POST /internal/v' + hints.contract.VERSION + '/tenants/{tenant}/storage-events']) : listener.routes,
    address: internal.listen,
    // A booted role binds the handlers of contracts it owns and this process serves.
    bind (role, bindings) {
      if (!bindings) return;
      for (const [id, binding] of Object.entries(bindings)) {
        if (id === 'storage-events') {
          if (role !== 'realtime' || !storage) fail('INTERNAL_API_CONTRACT_UNOWNED', role + ' ' + id);
          if (storageBinding || typeof binding?.owns !== 'function' || typeof binding?.receive !== 'function') fail('INTERNAL_API_BINDING_INVALID', id);
          storageBinding = binding;
          continue;
        }
        const slot = slots.get(id);
        if (!OWNED[role] || !OWNED[role].includes(id) || !slot || !slot.row.roles.includes(role)) fail('INTERNAL_API_CONTRACT_UNOWNED', role + ' ' + id);
        if (slot.operations || !binding || typeof binding.create !== 'function' ||
            (slot.row.tenantScoped && operationWindow && typeof binding.resolveTenant !== 'function')) fail('INTERNAL_API_BINDING_INVALID', id);
        const operations = binding.create(slot.token);
        const names = Object.keys(slot.service.operations);
        if (!operations || Object.keys(operations).length !== names.length || !names.every(name => typeof operations[name] === 'function')) fail('INTERNAL_API_BINDING_INVALID', id);
        slot.resolveTenant = binding.resolveTenant || null;
        slot.operations = operations;
      }
    },
    assertBound () {
      const missing = [...slots.values()].filter(slot => !slot.operations).map(slot => slot.row.id);
      if (storage && !storageBinding) missing.push('storage-events');
      if (missing.length) fail('INTERNAL_API_CONTRACT_UNBOUND', missing.join(','));
    },
    close: listener.close
  });
}

module.exports = { OWNED, plan, open };
