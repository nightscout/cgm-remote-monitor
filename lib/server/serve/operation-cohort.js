'use strict';

// A complete first-reference cohort is created by actual role constructors in
// this process. It is not a user-supplied quiescence assertion or a remote lease.
const windows = require('../../tenant-lifecycle/operation-window');
const connect = require('../../storage/postgres-connection');
const REQUIRED = Object.freeze(['api', 'evaluator', 'realtime', 'tenant-admin']);
const states = new WeakMap();
const fail = code => Object.assign(new Error(code), { code });
const sources = {
  api: () => require('./preview-api'), evaluator: () => require('./evaluator-preview'),
  realtime: () => require('./preview-realtime'), 'tenant-admin': () => require('./owner-preview')
};
// Every PostgreSQL config family uses either namespaces or namespace. Include
// nested consumer outbox/suppression stores, not just clinical collections.
function protectedNamespaces (value) {
  const names = new Set();
  function collect (node) {
    if (!node || typeof node !== 'object' || node instanceof Map || node instanceof Set) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'namespace' && typeof child === 'string') names.add(child);
      else if (key === 'namespaces' && child && typeof child === 'object') {
        for (const name of Object.values(child)) if (typeof name === 'string') names.add(name);
      } else if (child && typeof child === 'object') collect(child);
    }
  }
  collect(value); return [...names];
}
function stateOf (cohort, tenant) {
  const state = states.get(cohort);
  if (!state || state.closed || !state.complete || !state.tenants.has(tenant) || REQUIRED.some(role => !state.contexts.has(role))) throw fail('RESTORE_COHORT_INCOMPLETE');
  return state;
}
async function create ({ window, names, tenants, namespaces }) {
  if (!windows.isWindow(window) || !Array.isArray(names) || JSON.stringify([...names].sort()) !== JSON.stringify([...REQUIRED].sort()) ||
      !Array.isArray(tenants) || !tenants.length || new Set(tenants).size !== tenants.length ||
      !Array.isArray(namespaces) || !namespaces.length || namespaces.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))) throw fail('RESTORE_COHORT_CONFIGURATION');
  await window.ready();
  const release = connect.installOperationWindow(window);
  const state = {window, tenants:new Set(tenants), namespaces:Object.freeze([...new Set(namespaces)]), contexts:new Map(), booting:new Set(), complete:false, closed:false};
  const cohort = Object.freeze({ window,
    async boot (role, config) {
      if (state.closed || state.contexts.has(role) || state.booting.has(role) || !Object.hasOwn(sources, role)) throw fail('RESTORE_COHORT_CONFIGURATION');
      const ids = config.bindings ? [...config.bindings.keys()] : config.tenants ? [...config.tenants.keys()] : config.tenantIds;
      if (!Array.isArray(ids) || JSON.stringify([...ids].sort()) !== JSON.stringify([...state.tenants].sort())) throw fail('RESTORE_COHORT_TENANT_MISMATCH');
      if (protectedNamespaces(config).some(name => !state.namespaces.includes(name))) throw fail('RESTORE_COHORT_NAMESPACE_MISMATCH');
      state.booting.add(role);
      let context;
      try { context = await sources[role]().boot(config, {operationWindow:window}); }
      finally { state.booting.delete(role); }
      if (state.closed) { await context?.close?.(); throw fail('RESTORE_COHORT_INCOMPLETE'); }
      if (!context || typeof context.close !== 'function' || typeof context.invalidateTenant !== 'function') {
        if (context?.close) await context.close();
        throw fail('RESTORE_COHORT_COMPONENT_UNSELECTED');
      }
      state.contexts.set(role, context); return context;
    },
    complete () {
      if (state.closed || REQUIRED.some(role => !state.contexts.has(role))) throw fail('RESTORE_COHORT_INCOMPLETE');
      state.complete = true;
    },
    async close () {
      if (state.closed) return; state.closed = true; state.complete = false;
      try { await window.close(); } finally { release(); }
    }
  });
  states.set(cohort, state); return cohort;
}
async function assertComplete (cohort, tenant, {client} = {}) {
  const state = stateOf(cohort, tenant);
  if (!client || typeof client.query !== 'function') throw fail('RESTORE_COHORT_CENSUS_REQUIRED');
  const observed = connect.cohortBackends(state.window);
  const known = new Map(observed.map(row => [row.pid, row]));
  // A private operator must be able to observe backend births. NULL/unknown
  // actors refuse; labels/application_name are never accepted as authority.
  const actors = (await client.query(`SELECT /* restore-cohort-actors */ a.pid,a.usename AS role,extract(epoch from a.backend_start)::text AS birth
    FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid
    WHERE a.datname=current_database() AND a.backend_type='client backend' AND a.pid<>pg_backend_pid()
      AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f')
        AND (pg_has_role(r.oid,c.relowner,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles e WHERE pg_has_role(r.oid,e.oid,'MEMBER') AND
          (has_table_privilege(e.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(e.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))))` , [state.namespaces])).rows;
  for (const actor of actors) {
    const row = known.get(actor.pid);
    if (!row || !actor.birth || row.birth !== actor.birth || row.role !== actor.role) throw fail('RESTORE_COHORT_UNKNOWN_BACKEND');
  }
  return Object.freeze({tenant, backends:actors.length});
}
async function invalidate (cohort, tenant) {
  const state = stateOf(cohort, tenant);
  // Controller has already excluded/drained A. These methods clear actual
  // process caches/sockets; they do not advance a DB clock or fabricate output.
  for (const role of REQUIRED) await state.contexts.get(role).invalidateTenant(tenant);
}
module.exports = { create, assertComplete, invalidate, REQUIRED, protectedNamespaces };
