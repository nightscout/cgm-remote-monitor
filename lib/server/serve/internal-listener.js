'use strict';

// The process's one private listener (serve.internal). Which internal contracts
// it serves is decided here, by the roles' code; serve.internal configuration
// only says where it listens (lib/server/internal-api/listener-config.js).
//
// The route table is fixed when the listener opens, before any role boots, so
// a co-resident caller (realtime warming its tenants against api) reaches a
// contract the moment its role has booted. A role binds its handlers after its
// boot; until then its routes answer SOCKET_IPC_UNAVAILABLE. Start-up refuses
// a role that binds a contract it does not own, and any contract left unbound.
const fs = require('node:fs');
const path = require('node:path');
const transport = require('../internal-api/transport');
const contracts = require('../internal-api/contracts');

// Role -> the internal contracts its code may serve. Configuration cannot add,
// move or merge an entry; a role's own settings only switch its contract on.
const OWNED = Object.freeze({
  api: Object.freeze(['socket-authority', 'lifecycle-participant']),
  realtime: Object.freeze(['alarm-delivery', 'lifecycle-participant']),
  evaluator: Object.freeze(['lifecycle-participant']),
  'tenant-admin': Object.freeze(['lifecycle-participant'])
});
const SERVICES = Object.freeze(Object.fromEntries(Object.values(contracts).map(service => [service.id, service])));
const fail = (code, detail) => { throw Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code }); };

// The contracts this process serves: [{id, roles, bounds, lifetime}] from the
// roles' own parsed settings. Pure; no I/O.
function plan (names, { preview, realtimePreview, participant } = {}) {
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
  if (participant) {
    rows.push({ id: 'lifecycle-participant', roles: [...participant.roles], tenantScoped: false,
      bounds: { maxBytes: participant.endpoint.maxBytes, timeoutMs: participant.endpoint.timeoutMs } });
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

// open(internal, rows, {operationWindow}) -> {routes, address, bind, assertBound, close}
async function open (internal, rows, { operationWindow } = {}) {
  if (!rows.length) return null;
  const slots = new Map();
  const modules = rows.map(row => {
    const service = SERVICES[row.id];
    if (!service) fail('INTERNAL_API_CONTRACT_UNOWNED', row.id);
    const slot = { row, service, token: null, operations: null, resolveTenant: null };
    slots.set(row.id, slot);
    const create = token => {
      slot.token = token;
      return Object.fromEntries(Object.keys(service.operations).map(name => [name, (request, body) => {
        if (!slot.operations) fail('SOCKET_IPC_UNAVAILABLE');
        return slot.operations[name](request, body);
      }]));
    };
    const lifetime = row.tenantScoped && operationWindow ? { operationWindow, resolveTenant: body => {
      if (!slot.resolveTenant) fail('SOCKET_IPC_UNAVAILABLE');
      return slot.resolveTenant(body);
    } } : undefined;
    return { service, create, bounds: row.bounds, ...(lifetime ? { lifetime } : {}) };
  });
  const widest = { maxBytes: Math.max(...rows.map(row => row.bounds.maxBytes)), timeoutMs: Math.max(...rows.map(row => row.bounds.timeoutMs)) };
  prepareDirectory(internal);
  const listener = await transport.compose({ ...internal.listen, ...widest }, modules, { shutdownTimeoutMs: internal.shutdownTimeoutMs });
  return Object.freeze({
    routes: listener.routes,
    address: internal.listen,
    // A booted role binds the handlers of contracts it owns and this process serves.
    bind (role, bindings) {
      if (!bindings) return;
      for (const [id, binding] of Object.entries(bindings)) {
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
      if (missing.length) fail('INTERNAL_API_CONTRACT_UNBOUND', missing.join(','));
    },
    close: listener.close
  });
}

module.exports = { OWNED, plan, open };
