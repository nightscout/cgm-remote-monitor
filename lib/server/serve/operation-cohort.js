'use strict';

// Local participants are created by actual role constructors. A fixed private
// peer manifest composes separate processes; caller labels do not certify them.
const windows = require('../../tenant-lifecycle/operation-window');
const connect = require('../../storage/postgres-connection');
const REQUIRED = Object.freeze(['api', 'evaluator', 'realtime', 'tenant-admin']);
const states = new WeakMap(), pins = new WeakMap();
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const clients = require('../internal-api/clients');
const { CLINICAL, COUNTERS } = require('../../tenant-lifecycle/clinical-catalogue');
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
      // The tenant registry is operational (census OPERATIONAL), never restored with a tenant.
      if (key === 'registry') continue;
      if (key === 'namespace' && typeof child === 'string') names.add(child);
      else if (key === 'namespaces' && child && typeof child === 'object') {
        for (const name of Object.values(child)) if (typeof name === 'string') names.add(name);
      } else if (child && typeof child === 'object') collect(child);
    }
  }
  collect(value); return [...names];
}
// Registry mode (decision tenant-registry): the cohort's tenant set is the
// registry, written as the one label 'registry:<namespace>'; every canonical
// tenant id belongs to it (the operation window row, read in each transaction,
// is the fence), and peers must name the same registry.
const REGISTRY_LABEL = /^registry:[a-z][a-z0-9_]{0,62}$/;
const registryCohort = tenants => tenants.size === 1 && REGISTRY_LABEL.test([...tenants][0]);
const member = (tenants, tenant) => tenants.has(tenant) ||
  (registryCohort(tenants) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant || '') && tenant !== '00000000-0000-0000-0000-000000000000');
function stateOf (cohort, tenant) {
  const state = states.get(cohort);
  if (!state || state.closed || !state.complete || !member(state.tenants, tenant) || (state.kind === 'remote' ? false : state.names.some(role => !state.contexts.has(role)))) throw fail('RESTORE_COHORT_INCOMPLETE');
  return state;
}
async function create ({ window, names, tenants, namespaces, participant }) {
  if (participant && !require('./operation-cohort-manifest').isParticipant(participant)) throw fail('RESTORE_COHORT_CONFIGURATION');
  const selected = participant ? participant.roles : REQUIRED;
  if (!windows.isWindow(window) || !Array.isArray(names) || JSON.stringify([...names].sort()) !== JSON.stringify([...selected].sort()) ||
      !Array.isArray(tenants) || !tenants.length || new Set(tenants).size !== tenants.length ||
      !Array.isArray(namespaces) || !namespaces.length || namespaces.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value))) throw fail('RESTORE_COHORT_CONFIGURATION');
  if (participant && !same([...namespaces].sort(),participant.namespaces)) throw fail('RESTORE_COHORT_NAMESPACE_MISMATCH');
  await window.ready();
  const release = connect.installOperationWindow(window);
  const state = {kind:'local', names:[...names], participant, incarnation:randomUUID(), window, tenants:new Set(tenants), namespaces:Object.freeze([...new Set(namespaces)]), contexts:new Map(), booting:new Set(), complete:false, closed:false};
  const cohort = Object.freeze({ window,
    async boot (role, config) {
      if (state.closed || state.contexts.has(role) || state.booting.has(role) || !state.names.includes(role) || !Object.hasOwn(sources, role)) throw fail('RESTORE_COHORT_CONFIGURATION');
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
      if (state.closed || state.names.some(role => !state.contexts.has(role))) throw fail('RESTORE_COHORT_INCOMPLETE');
      state.complete = true;
    },
    quiesce () { state.complete = false; },
    async close () {
      if (state.closed) return; state.closed = true; state.complete = false;
      // The lifecycle contract is served by the process's serve.internal
      // (lib/server/serve/internal-listener.js), which closes first.
      try { await window.close(); } finally { release(); }
    }
  });
  states.set(cohort, state); return cohort;
}
async function assertComplete (cohort, tenant, {client} = {}) {
  const state = stateOf(cohort, tenant);
  if (!client || typeof client.query !== 'function') throw fail('RESTORE_COHORT_CENSUS_REQUIRED');
  let observed;
  if (state.kind === 'remote') {
    const pin = state.pinned.get(tenant);
    if (!pin) throw fail('RESTORE_COHORT_PIN_REQUIRED');
    const snapshots = await readPeers(state);
    checkPinned(pin,snapshots);
    const actual = connect.datastoreIdentity((await client.query('SELECT '+connect.datastoreSQL)).rows[0]);
    if (snapshots.some(row => !same(row.datastore,actual))) throw fail('RESTORE_COHORT_DATASTORE_MISMATCH');
    observed = snapshots.flatMap(row => row.backends);
  } else {
    observed = connect.cohortBackends(state.window);
    const actual=connect.datastoreIdentity((await client.query('SELECT '+connect.datastoreSQL)).rows[0]);
    if (!same(connect.cohortDatastore(state.window),state.window.datastore) || !same(actual,state.window.datastore)) throw fail('RESTORE_COHORT_DATASTORE_MISMATCH');
  }
  const known = new Map(observed.map(row => [row.pid, row]));
  // Diagnostic census of current actors, not a fence against later raw DATA
  // connections. A closed credential/ingress deployment boundary is separately
  // required for authorized components; boot cannot attest credential custody.
  // A private operator must observe births. NULL/unknown actors refuse;
  // labels/application_name are never accepted as authority.
  // Activity observations are transaction-cached; refresh only statistics on
  // this operator backend before comparing current participant identities.
  // A non-participant backend is accepted only when its database identity holds
  // no privilege (direct, inherited or by ownership) on any clinical table
  // (clinical-catalogue.js) in the protected namespaces, and no write privilege
  // (INSERT, UPDATE, DELETE, or column INSERT/UPDATE; or ownership) on the
  // insertion-order or write-clock counters there, read from the catalogue in
  // this statement: grants, never a role name or label, decide. Such an
  // identity (the admin role's ownership_operator; a read-only readiness
  // identity) cannot touch what a restore reconciles or advances; restore keeps
  // current authority untouched (decisions restore-census-and-ownership-phase,
  // restore-census-counter-writers).
  await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
  const touches = (tables, table = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER', column = 'SELECT,INSERT,UPDATE,REFERENCES') => `EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p','v','m','f')${tables}
        AND (pg_has_role(r.oid,c.relowner,'MEMBER') OR EXISTS(SELECT 1 FROM pg_roles e WHERE pg_has_role(r.oid,e.oid,'MEMBER') AND
          (has_table_privilege(e.oid,c.oid,'${table}')
          OR has_any_column_privilege(e.oid,c.oid,'${column}')))))`;
  const actors = (await client.query(`SELECT /* restore-cohort-actors */ a.pid,a.usename AS role,extract(epoch from a.backend_start)::text AS birth,
      ${touches(' AND c.relname=ANY($2::text[])')} AS clinical,
      ${touches(' AND c.relname=ANY($3::text[])', 'INSERT,UPDATE,DELETE', 'INSERT,UPDATE')} AS counters
    FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid
    WHERE a.datname=current_database() AND a.backend_type='client backend' AND a.pid<>pg_backend_pid()
      AND ${touches('')}` , [state.namespaces, CLINICAL, COUNTERS])).rows;
  let exempt = 0;
  for (const actor of actors) {
    const row = known.get(actor.pid);
    if (row && actor.birth && row.birth === actor.birth && row.role === actor.role) continue;
    if (actor.clinical === false && actor.counters === false) { exempt++; continue; }
    throw fail('RESTORE_COHORT_UNKNOWN_BACKEND');
  }
  return Object.freeze({tenant, backends:actors.length - exempt, exempt});
}
async function invalidate (cohort, tenant) {
  const state = stateOf(cohort, tenant);
  // Controller has excluded/drained cooperative A operations. These clear actual
  // process caches/sockets; they do not advance a DB clock or fabricate output.
  if (state.kind === 'remote') {
    const pin=state.pinned.get(tenant); if (!pin) throw fail('RESTORE_COHORT_PIN_REQUIRED');
    const snapshots=await readPeers(state); checkPinned(pin,snapshots);
    await Promise.all(state.participants.map(async (peer,index) => {
      const request=randomUUID(), before=snapshots[index];
      const reply=await clients.lifecycleParticipant(peer.endpoint).invalidateTenant({request,tenant,incarnation:before.incarnation,identity:before.identity});
      const after=validateStatus(state,peer,reply,request,tenant);
      checkPinned(pin,[after],index);
    }));
    checkPinned(pin,await readPeers(state));
  } else for (const role of state.names) await state.contexts.get(role).invalidateTenant(tenant);
}

// Lifecycle participant handlers. They carry NO tenant operation window: control
// must stay callable while a tenant is suspended. A composed component listener
// registers these as their own module beside application contracts.
function controlOperations (cohort) {
  const state = states.get(cohort);
  if (!state || state.kind !== 'local' || !state.participant) throw fail('RESTORE_COHORT_CONFIGURATION');
  return Object.freeze({
    getStatus: async (ctx, body) => {
      exactRequest(body,['request']); return {...localStatus(cohort),request:body.request};
    },
    invalidateTenant: async (ctx, body) => {
      exactRequest(body,['request','tenant','incarnation','identity']);
      const current=localStatus(cohort);
      if (body.incarnation !== current.incarnation || !same(body.identity,current.identity)) throw fail('RESTORE_COHORT_PARTICIPANT_CHANGED');
      await invalidate(cohort,body.tenant);
      return {...localStatus(cohort),request:body.request,tenant:body.tenant};
    }
  });
}

function exactRequest (body, keys) {
  if (!require('../realtime/contract').exact(body,keys) || typeof body.request !== 'string' || !/^[0-9a-f-]{36}$/.test(body.request)) throw fail('RESTORE_COHORT_PROTOCOL');
}
function localStatus (cohort) {
  const state=stateOf(cohort,[...states.get(cohort).tenants][0]);
  const database=connect.cohortDatastore(state.window);
  if (!same(database,state.window.datastore)) throw fail('RESTORE_COHORT_DATASTORE_MISMATCH');
  return {version:1,participant:state.participant.id,incarnation:state.incarnation,namespace:state.window.namespace,
    roles:[...state.names].sort(),tenants:[...state.tenants].sort(),namespaces:[...state.namespaces].sort(),
    identity:state.window.identity,datastore:database,backends:connect.cohortBackends(state.window)};
}
function validateStatus (state, peer, reply, request, tenant) {
  const keys=['version','participant','incarnation','namespace','roles','tenants','namespaces','identity','datastore','backends','request',...(tenant ? ['tenant'] : [])];
  exactRequest(reply,keys);
  if (reply.request!==request || reply.version!==1 || reply.participant!==peer.id || typeof reply.incarnation!=='string' || !/^[0-9a-f-]{36}$/.test(reply.incarnation) ||
    reply.namespace!==state.namespace || !same(reply.roles,peer.roles) || !same(reply.tenants,[...state.tenants].sort()) || !same(reply.namespaces,peer.namespaces) ||
    !reply.identity || typeof reply.identity!=='object' || !Object.keys(reply.identity).length || Object.values(reply.identity).some(value => !Number.isSafeInteger(value) || value<1) ||
    !Array.isArray(reply.backends) || reply.backends.some(row => !require('../realtime/contract').exact(row,['pid','role','birth']) || !Number.isSafeInteger(row.pid) || row.pid<1 || typeof row.role!=='string' || !row.role || typeof row.birth!=='string' || !row.birth) ||
    (tenant && reply.tenant!==tenant)) throw fail('RESTORE_COHORT_PROTOCOL');
  const datastore=connect.datastoreIdentity(reply.datastore);
  return {...reply,datastore};
}
async function readPeers (state) {
  if (state.closed) throw fail('RESTORE_COHORT_INCOMPLETE');
  const rows=await Promise.all(state.participants.map(async peer => {
    const request=randomUUID();
    const reply=await clients.lifecycleParticipant(peer.endpoint).getStatus({request});
    return validateStatus(state,peer,reply,request);
  }));
  if (rows.some(row => !same(row.identity,rows[0].identity) || !same(row.datastore,rows[0].datastore))) throw fail('RESTORE_COHORT_DATASTORE_MISMATCH');
  const pids=rows.flatMap(row => row.backends.map(backend => backend.pid));
  if (new Set(pids).size!==pids.length) throw fail('RESTORE_COHORT_PROTOCOL');
  return rows;
}
function checkPinned (pin, rows, offset=0) {
  rows.forEach((row,index) => {
    const before=pin.snapshots[index+offset];
    if (!before || row.participant!==before.participant || row.incarnation!==before.incarnation || !same(row.identity,before.identity) || !same(row.datastore,before.datastore)) throw fail('RESTORE_COHORT_PARTICIPANT_CHANGED');
  });
}
async function createRemote ({namespace,tenants,participants}) {
  participants=require('./operation-cohort-manifest').validate(participants);
  if (typeof namespace!=='string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || !Array.isArray(tenants) || !tenants.length || new Set(tenants).size!==tenants.length || (tenants.length === 1 && REGISTRY_LABEL.test(tenants[0]) ? false : tenants.some(value => !require('../realtime/contract').uuid(value)))) throw fail('RESTORE_COHORT_CONFIGURATION');
  const state={kind:'remote',namespace,tenants:new Set(tenants),participants,namespaces:[...new Set(participants.flatMap(peer => peer.namespaces))],pinned:new Map(),complete:true,closed:false};
  const cohort=Object.freeze({async close () { state.closed=true; state.complete=false; }});
  states.set(cohort,state); await readPeers(state); return cohort;
}
async function pin (cohort,tenant,{client}={}) {
  const state=stateOf(cohort,tenant), token=Object.freeze({});
  if (state.kind==='remote') {
    if (state.pinned.has(tenant)) throw fail('RESTORE_COHORT_ALREADY_PINNED');
    const slot={snapshots:null}; state.pinned.set(tenant,slot);
    try { slot.snapshots=await readPeers(state); await assertComplete(cohort,tenant,{client}); }
    catch (error) { state.pinned.delete(tenant); throw error; }
  }
  pins.set(token,{state,tenant}); return token;
}
async function releasePin (token) {
  const binding=pins.get(token); if (!binding) throw fail('RESTORE_COHORT_PIN_INVALID');
  pins.delete(token); if (binding.state.kind==='remote') binding.state.pinned.delete(binding.tenant);
}
module.exports={create,createRemote,pin,releasePin,assertComplete,invalidate,controlOperations,REQUIRED,protectedNamespaces};
