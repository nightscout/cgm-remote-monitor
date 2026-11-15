'use strict';

// Dormant lifetime adapter. A restore consumer must compose EVERY serving and
// lower-port path; creating this adapter alone does not admit tenant restore.
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID, createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TENANT = '00000000-0000-0000-0000-000000000000';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const windows = new WeakSet();
const schedulingScopes = new WeakMap(), schedulingTokens = new WeakMap();
// Boot-only observation: weak references neither retain historical windows nor
// add work to operation admission. An expired inherited store is still authority
// and must not become a trusted scheduler's permanent parent.
const scopeObservers = new Set();
function assertNoAmbientScope () {
  for (const reference of scopeObservers) {
    const storage = reference.deref();
    if (!storage) scopeObservers.delete(reference);
    else if (storage.getStore() !== undefined) throw fail('LIFECYCLE_WINDOW_AMBIENT_SCOPE');
  }
}
const suspensions = new WeakSet();
const datastore = require('../storage/postgres-datastore');
const { isDeepStrictEqual: same } = require('node:util');
const { admit } = require('./operation-window-readiness');
const diagnostics = require('../diagnostics/m7');
const fail = code => {
  const error = Object.assign(new Error(code), { code });
  if (code === 'LIFECYCLE_WINDOW_SUSPENDED') suspensions.add(error);
  return error;
};

// Assertion only, for explicit private evaluator entry. It never creates,
// clears or changes authority. Closed/expired/foreign callers are refused before
// a trusted scheduler can enqueue anything on their behalf.
function schedulingParent (window, tenant) {
  const storage = schedulingScopes.get(window);
  if (!storage || window.closed) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  const parent = storage.getStore();
  if (parent && (parent.tenant !== tenant || !parent.active || !parent.accepting)) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  const bound = require('../storage/tenant-scope').currentTenant();
  if (bound !== undefined && bound !== tenant) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  if (!parent) return null;
  let token = schedulingTokens.get(parent);
  if (!token) { token = Object.freeze({}); schedulingTokens.set(parent, token); }
  return token;
}

// `locks` is the static tenant -> advisory lock key map; `lockRule:
// 'tenant-id-sha256-v1'` (registry mode, decision tenant-registry) derives the
// key from the tenant id (lib/tenant-registry/rules.js lockKey), the key
// provisioning wrote into the tenant's window row. Either way the window row is
// read in the transaction and a different key refuses (BINDING_CHANGED).
const LOCK_RULES = Object.freeze({ 'tenant-id-sha256-v1': tenant => require('../tenant-registry/rules').lockKey(tenant) });
function create ({ namespace, locks, lockRule, pool, leaseSessionCount, trustedWorker = false }) {
  if (!NAME.test(namespace) || namespace === 'public' || namespace === 'information_schema' || namespace.startsWith('pg_') ||
      (lockRule === undefined ? (!Array.isArray(locks) || !locks.length) : (locks !== undefined || !Object.hasOwn(LOCK_RULES, lockRule))) ||
      typeof pool?.connect !== 'function') {
    throw new TypeError('Explicit operation-window namespace, tenant lock map and pool required');
  }
  if (typeof trustedWorker !== 'boolean') throw new TypeError('Explicit trusted worker operation mode required');
  const keys = new Map(), used = new Set(), scopes = new AsyncLocalStorage(), leases = new WeakMap();
  for (const reference of scopeObservers) if (!reference.deref()) scopeObservers.delete(reference);
  scopeObservers.add(new globalThis.WeakRef(scopes));
  const derive = lockRule === undefined ? null : LOCK_RULES[lockRule];
  for (const row of locks || []) {
    if (!UUID.test(row?.tenant) || row.tenant === METADATA_TENANT || typeof row.key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.key) ||
        BigInt(row.key) > 9223372036854775807n || keys.has(row.tenant) || used.has(row.key)) {
      throw new TypeError('Unique provisioned tenant operation lock keys required');
    }
    keys.set(row.tenant, row.key); used.add(row.key);
  }
  const table = '"' + namespace + '".tenant_lifecycle_windows';
  let backends = new WeakMap();
  const watchedBackends = new WeakSet();
  let closed = false, identity = null, database = null, cluster = null, readiness, operational = false, verifying = 0, verificationFailed = false;
  function ready () {
    if (closed) return Promise.reject(fail('LIFECYCLE_WINDOW_CLOSED'));
    if (!readiness) readiness = (async () => {
      const client = await pool.connect(); let error;
      try { identity = await admit(client, namespace, {lifetime:true}); database = await datastore.read(client); cluster = await datastore.cluster(client); await rememberBackend(client, true); operational = verifying === 0; }
      catch (failure) { error = failure; throw failure; }
      finally { client.release(error); }
    })();
    return readiness;
  }
  // Trusted workers inspect operational authority outside tenant execution.
  // Public/routed windows use the same physical-backend admission boundary.
  async function verifyClient (client) {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    await ready();
    try {
      await admitBackend(client, false, true);
    } catch (error) { if (trustedWorker) { operational = false; if (verifying) verificationFailed = true; } throw error; }
  }
  async function verifyOperational (relatedVerification) {
    if (relatedVerification !== undefined && typeof relatedVerification !== 'function') throw new TypeError('Related operational verification must be a function');
    assertNoAmbientScope();
    if (require('../storage/tenant-scope').currentTenant() !== undefined) throw fail('LIFECYCLE_WINDOW_AMBIENT_SCOPE');
    if (!verifying++) verificationFailed = false;
    operational = false;
    try {
      await ready();
      const client = await pool.connect(); let error;
      try {
        await admit(client, namespace, { lifetime: true, identity });
        if (!same(await datastore.read(client), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');
        await rememberBackend(client, true);
      } catch (failure) { error = failure; throw failure; }
      finally { client.release(error); }
      if (relatedVerification) await relatedVerification();
    } catch (failure) { verificationFailed = true; throw failure; }
    finally {
      // Concurrent verifications cannot reopen admission around a pending or
      // failed related check. A later complete verification can retry the batch.
      if (!--verifying) operational = !verificationFailed && !closed;
    }
  }
  const running = new Set();
  // This process's unfinished operations, by tenant: an id is present from before
  // its durable marker is written until its body and completion have ended, on
  // every path (including a lost lease connection, where the marker stays
  // unfinished). Read only by the lifecycle participant's getOperations, so an
  // operator can tell a marker nobody runs from one whose body is still running.
  const inflight = new Map();
  const sessions = leaseSessionCount === undefined ? null : require('./lifetime-sessions').create({ pool, size: leaseSessionCount });
  // Decision datastore-loss-recover-in-place. `probe` answers one question on a
  // new or pooled backend: can this process admit a tenant operation now? It
  // refuses while a lifetime session is lost or the backend reports a datastore
  // other than the admitted one. One cheap statement, no catalogue admission.
  async function probe () {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    await ready();
    if (sessions && sessions.failed()) throw fail('LIFECYCLE_WINDOW_SESSION_LOST');
    const client = await pool.connect(); let error;
    try { if (!same(await datastore.read(client), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED'); }
    catch (failure) { error = failure; throw failure; }
    finally { client.release(error); }
  }
  // Recovery re-admits the same database and catalogue objects in the same
  // PostgreSQL cluster. Network address/port may change after a container move.
  // A selected supervisor still refuses changed resource epochs before adoption;
  // the system identifier neither rebinds its sealed plan nor refunds credits.
  // beforeAdopt drops old cached tenant state before any changed endpoint or
  // postmaster is adopted. Lost-session markers remain untouched.
  const lineage = (value, system) => [value.database, value.database_oid, system];
  let recovering = null;
  function recover ({ beforeAdopt, signal } = {}) {
    if (closed) return Promise.reject(fail('LIFECYCLE_WINDOW_CLOSED'));
    if (beforeAdopt !== undefined && typeof beforeAdopt !== 'function') throw new TypeError('Operation-window adoption callback must be a function');
    if (signal !== undefined && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) throw new TypeError('Recovery cancellation signal required');
    const active = () => {
      if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
      if (signal?.aborted) throw fail('LIFECYCLE_WINDOW_RECOVERY_CANCELLED');
    };
    if (!recovering) recovering = (async () => {
      active(); await ready(); active();
      const client = await pool.connect(); let error, nextIdentity, nextDatabase, nextCluster;
      try { active(); nextIdentity = await admit(client, namespace, { lifetime: true }); active(); nextDatabase = await datastore.read(client); active(); nextCluster = await datastore.cluster(client); }
      catch (failure) { error = failure; throw failure; }
      finally { client.release(error); }
      active();
      if (!same(lineage(nextDatabase, nextCluster), lineage(database, cluster)) || !same(nextIdentity, identity)) throw fail('LIFECYCLE_WINDOW_DATASTORE_REPLACED');
      const restarted = !same(nextDatabase, database);
      if (restarted && require('../storage/connection-admission').health() !== null) throw fail('DATASTORE_RECOVERY_REBIND_REQUIRED');
      if (restarted && beforeAdopt) await beforeAdopt();
      active();
      database = nextDatabase; operational = verifying === 0;
      backends = new WeakMap();
      const sessionsReplaced = sessions ? sessions.reset() : 0;
      return Object.freeze({ restarted, sessionsReplaced });
    })().catch(error => { if (trustedWorker) operational = false; throw error; }).finally(() => { recovering = null; });
    return recovering;
  }
  function keyFor (tenant) {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    if (derive) {
      if (!UUID.test(tenant) || tenant === METADATA_TENANT) throw fail('LIFECYCLE_WINDOW_TENANT_UNKNOWN');
      return derive(tenant);
    }
    if (!keys.has(tenant)) throw fail('LIFECYCLE_WINDOW_TENANT_UNKNOWN');
    return keys.get(tenant);
  }
  // Structural admission belongs to this exact physical backend and principal.
  // Deployment/migration retires the cohort before protected DDL or grant expansion.
  // Arbitrary administrator edits on a warm backend have no next-operation digest.
  const safeRole = row => row && ['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication'].every(key => row[key] === false);
  async function rememberBackend (client, lifetime) {
    const row = (await client.query('SELECT /* operation-window-principal */ pg_backend_pid() AS pid,r.oid AS role_oid,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication FROM pg_roles r WHERE r.rolname=current_user')).rows[0];
    if (!safeRole(row) || row.pid !== client.processID || !Number.isSafeInteger(row.role_oid) || row.role_oid < 1) throw fail('LIFECYCLE_WINDOW_ROLE_UNSAFE');
    if (!watchedBackends.has(client)) {
      const invalidate = () => backends.delete(client);
      client.on('error', invalidate); client.on('end', invalidate);
      watchedBackends.add(client);
    }
    backends.set(client, {pid:row.pid, role:row.role_oid, lifetime});
  }
  function isAdmittedClient (client) {
    const proof = backends.get(client);
    return !closed && !!proof && proof.pid === client.processID;
  }
  async function admitBackend (client, lifetime, fresh = false) {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    if (!fresh && isAdmittedClient(client) && backends.get(client).lifetime === lifetime) return;
    backends.delete(client);
    await admit(client, namespace, {lifetime, identity});
    if (!same(await datastore.read(client), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');
    await rememberBackend(client, lifetime);
  }
  async function admitClient (client) { await ready(); await admitBackend(client, false); }
  const statements = new Map();
  function statement (client, lifetime, metadata) {
    const proof = backends.get(client);
    if (!isAdmittedClient(client) || proof.lifetime !== lifetime) throw fail('LIFECYCLE_WINDOW_NOT_READY');
    const key = (lifetime ? 'lifetime' : 'lower') + (metadata ? '-metadata' : '') + '-' + proof.role;
    if (!statements.has(key)) {
      const text = 'SELECT /* operation-window-current ' + key + ' */ pg_backend_pid() AS pid,' + datastore.SQL +
        ',r.oid AS role_oid,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,' +
        `pg_has_role(current_user,${identity.ownerOid}::oid,'MEMBER') AS owns_control` +
        (metadata ? ",current_setting('transaction_read_only') AS read_only FROM pg_roles r"
          : ',w.lock_key::text AS lock_key,w.phase,w.generation::text AS generation FROM pg_roles r LEFT JOIN ' + table + ' w ON w.tenant_id=$1') +
        ` WHERE r.oid=${proof.role}::oid AND r.oid=current_user::regrole::oid`;
      statements.set(key, { name: 'ns_window_' + createHash('sha256').update(text).digest('hex').slice(0, 24), text });
    }
    return statements.get(key);
  }
  async function admission (client, tenant, lifetime, metadata) {
    const end = diagnostics.time('window.admission');
    try {
      if (trustedWorker && !operational) throw fail('LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
      const {name,text} = statement(client, lifetime, metadata);
      const row = (await client.query({name,text,values:metadata ? [] : [tenant]})).rows[0];
      if (!safeRole(row) || row.role_oid !== backends.get(client)?.role || row.owns_control !== false) throw fail('LIFECYCLE_WINDOW_ROLE_UNSAFE');
      if (row.pid !== client.processID || !same(datastore.identity(row), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');
      if (trustedWorker && !operational) throw fail('LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
      return row;
    } finally { end(); }
  }
  // Lifetime lanes serialize registration/completion on one physical backend.
  // Overlapping bodies share its session lock; every registration still starts
  // a new transaction and reads the current principal and tenant window.
  const laneLocks = new WeakMap();
  async function acquire (client, tenant, lifetime) {
    const metadata = tenant === METADATA_TENANT;
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    const key = metadata ? null : keyFor(tenant);
    if (lifetime && laneLocks.get(client) && laneLocks.get(client).pid !== client.processID) throw fail('LIFECYCLE_WINDOW_LOCK_LOST');
    await admitBackend(client, lifetime);
    const outer = scopes.getStore();
    // A real trusted operation already holds this tenant's lifetime lock and
    // durable drain marker. Its lower transactions retain fresh admission on
    // their own backend, but need not take the same restore exclusion again.
    // Children keep that lifetime alive until all physical SQL has drained.
    if (!lifetime && trustedWorker && !metadata && outer) {
      if (outer.tenant !== tenant || !outer.active || !outer.accepting || !outer.lease || !leases.get(outer.lease)?.active()) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
      let active = true, drained;
      const pending = new Promise(resolve => { drained = resolve; });
      outer.children.add(pending);
      const lease = Object.freeze({ async close (error) {
        if (!active) return;
        active = false;
        if (error) outer.childError = outer.childError || error;
        outer.children.delete(pending); drained();
      } });
      leases.set(lease, { client, tenant, key, metadata, lifetime: false, borrowed: outer,
        active: () => active && outer.active && leases.get(outer.lease)?.active() });
      return lease;
    }
    if (!identity) throw fail('LIFECYCLE_WINDOW_NOT_READY');
    // Nonblocking shared acquisition avoids queueing behind maintenance while
    // an already-admitted outer serving operation is trying to drain SQL work.
    // Live role, datastore and tenant checks follow inside the transaction
    // (assertClient), before any body SQL.
    const shared = lifetime && sessions && !metadata;
    let backend, lock;
    if (shared) {
      backend = laneLocks.get(client);
      if (backend && backend.pid !== client.processID) throw fail('LIFECYCLE_WINDOW_LOCK_LOST');
      if (!backend) { backend = { pid: client.processID, keys: new Map() }; laneLocks.set(client, backend); }
      lock = backend.keys.get(key);
      if (lock?.lost) throw fail('LIFECYCLE_WINDOW_LOCK_LOST');
    }
    if (!lock) {
      const row = metadata ? null : (await client.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS held', [key])).rows[0];
      if (!metadata && row?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
      if (shared) { lock = { references: 0, lost: false }; backend.keys.set(key, lock); }
    }
    if (lock) lock.references++;
    let active = true;
    const lease = Object.freeze({ async close () {
      if (!active) return;
      active = false;
      if (metadata) return;
      if (lock) {
        if (lock.lost || backend.pid !== client.processID) throw fail('LIFECYCLE_WINDOW_LOCK_LOST');
        if (--lock.references > 0) return;
      }
      try {
        const value = (await client.query('SELECT pg_advisory_unlock_shared($1::bigint) AS released', [key])).rows[0];
        if (value?.released !== true) throw fail('LIFECYCLE_WINDOW_LOCK_LOST');
        if (lock) backend.keys.delete(key);
      } catch (error) {
        if (lock) lock.lost = true;
        throw error;
      }
    } });
    leases.set(lease, { client, tenant, key, metadata, lifetime, active: () => active });
    return lease;
  }
  const acquireClient = (client, tenant) => acquire(client, tenant, false);
  async function assertClient (client, tenant, lease) {
    const held = leases.get(lease);
    if (!held || held.client !== client || held.tenant !== tenant || !held.active()) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    // Caller begins/binds ONLY AFTER acquiring the session lock. In particular
    // REPEATABLE READ must not snapshot active state before waiting for a lock.
    const row = await admission(client, tenant, held.lifetime, held.metadata);
    if (held.metadata) {
      if (row.read_only !== 'on') throw fail('LIFECYCLE_WINDOW_METADATA_READ_ONLY_REQUIRED');
      return null;
    }
    if (row.lock_key !== held.key) throw fail('LIFECYCLE_WINDOW_BINDING_CHANGED');
    if (row.phase !== 'active') throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    if (!/^[1-9][0-9]*$/.test(row.generation || '')) throw fail('LIFECYCLE_WINDOW_BINDING_CHANGED');
    if (held.borrowed && row.generation !== held.borrowed.generation) throw fail('LIFECYCLE_WINDOW_BINDING_CHANGED');
    return row.generation;
  }
  async function execute (tenant, fn, { onInvalidated } = {}) {
    if (onInvalidated !== undefined && typeof onInvalidated !== 'function') throw new TypeError('Operation-window invalidation callback must be a function');
    if (typeof fn !== 'function') throw new TypeError('Operation-window body required');
    keyFor(tenant);
    const outer = scopes.getStore();
    if (outer) {
      if (outer.tenant !== tenant || !outer.active || !outer.accepting || trustedWorker && !operational) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
      return fn();
    }
    await ready();
    const session = sessions ? await sessions.acquire(tenant) : null;
    const client = session ? session.client : await pool.connect();
    const serial = (fn, options) => session ? session.serial(fn, options) : fn();
    let lease, error, transportError, began = false, registered = false, generation, outcome, cleanupError;
    const operation = randomUUID();
    const state = { tenant, active: true, accepting: true, children: new Set() };
    if (!inflight.has(tenant)) inflight.set(tenant, new Set());
    inflight.get(tenant).add(operation);
    const failed = failure => {
      transportError = failure; error = error || failure; state.active = false;
      if (onInvalidated) { try { onInvalidated(); } catch (failure) { error = error || failure; } }
    };
    const unsubscribe = session ? session.subscribe(failed) : (() => { client.on('error', failed); return () => client.removeListener('error', failed); })();
    try {
      await serial(async () => {
        const endRegister = diagnostics.time('window.register');
        let committing = false;
        try {
          lease = await acquire(client, tenant, true); state.lease = lease;
          await client.query('BEGIN'); began = true;
          await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
          generation = await assertClient(client, tenant, lease);state.generation=generation;
          await client.query('INSERT INTO "' + namespace + '".tenant_lifecycle_operations (tenant_id,operation_id,generation) VALUES ($1,$2,$3)', [tenant, operation, generation]);
          committing = true; await client.query('COMMIT'); committing = false; began = false; registered = true;
        } catch (failure) {
          if (session && committing) session.poison(failure);
          else if (began) {
            try { await client.query('ROLLBACK'); began = false; }
            catch (rollback) { if (session) session.poison(rollback); throw rollback; }
          }
          throw failure;
        } finally { endRegister(); }
      });
      if (transportError || !state.active) throw error || fail('LIFECYCLE_WINDOW_SESSION_LOST');
      const endBody = diagnostics.time('window.body_response_inclusive');
      diagnostics.delta('window.outer_bodies', 1);
      let bodyError;
      try { outcome = await scopes.run(state, fn); }
      catch (failure) { bodyError = failure; }
      finally {
        // Expired inherited tasks cannot borrow a finished body. Already
        // admitted physical SQL drains before its lifetime marker and lock.
        state.accepting = false;
        await Promise.all([...state.children]);
        diagnostics.delta('window.outer_bodies', -1); endBody();
      }
      if (bodyError) throw bodyError;
      if (state.childError) throw state.childError;
      if (trustedWorker && !operational) throw fail('LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
    } catch (failure) { error = error || failure; }
    finally {
      const endComplete = diagnostics.time('window.complete_inclusive');
      state.active = false;
      // A durable pending operation survives a lost lease connection. The
      // operator must refuse restoration on that orphan; lock absence alone
      // cannot prove that a response/provider callback has finished.
      try {
        if (lease || registered || began) await serial(async () => {
          let finishing = false;
          try {
            if (began) { await client.query('ROLLBACK'); began = false; }
            if (registered && !transportError) {
              await client.query('BEGIN'); finishing = true;
              await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
              const updated = await client.query('UPDATE "' + namespace + '".tenant_lifecycle_operations SET finished=true WHERE tenant_id=$1 AND operation_id=$2 AND generation=$3 AND finished=false', [tenant, operation, generation]);
              if (updated.rowCount !== 1) throw fail('LIFECYCLE_WINDOW_OPERATION_LOST');
              await client.query('COMMIT'); finishing = false;
            }
            if (lease) await lease.close();
          } catch (failure) {
            if (session) session.poison(failure);
            else if (finishing) await client.query('ROLLBACK').catch(() => {});
            throw failure;
          }
        }, { completion: true });
      }
      catch (failure) { cleanupError = failure; }
      try {
        if (session) { if (cleanupError || transportError || began) session.poison(cleanupError || transportError || error); }
        else client.release(cleanupError || error);
      }
      finally {
        const own = inflight.get(tenant);
        if (own) { own.delete(operation); if (!own.size) inflight.delete(tenant); }
        unsubscribe(); endComplete();
      }
    }
    if (cleanupError) {
      const failure = fail('LIFECYCLE_WINDOW_RELEASE_FAILED');
      failure.cause = error || cleanupError; failure.cleanupError = cleanupError; throw failure;
    }
    if (error) throw error;
    return outcome;
  }

  function run (tenant, fn, options) {
    const pending = execute(tenant, fn, options); running.add(pending);
    pending.then(() => running.delete(pending), () => running.delete(pending));
    return pending;
  }
  function assertCurrent (tenant) {
    const current = scopes.getStore();
    if (!current || current.tenant !== tenant || !current.active || !current.accepting || trustedWorker && !operational) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  }
  const api = Object.freeze({ ready, probe, recover, verifyClient, verifyOperational, admitClient, isAdmittedClient, trustedWorker, namespace, get identity () { return identity; }, get datastore () { return database; }, acquireClient, assertClient, run, assertCurrent, currentGeneration(tenant){const state=scopes.getStore();if(!state||!state.active||!state.accepting||state.tenant!==tenant||typeof state.generation!=='string'||trustedWorker&&!operational)throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');return state.generation;}, inflight: tenant => [...(inflight.get(tenant) || [])].sort(), isMetadataTenant: tenant => tenant === METADATA_TENANT, get closed () { return closed; }, current (tenant) {
    const value = scopes.getStore(); return !!value && value.tenant === tenant && value.active && value.accepting && (!trustedWorker || operational);
  }, async close () {
    closed = true;
    const results = await Promise.allSettled([...running]);
    if (sessions) await sessions.close();
    if (results.some(row => row.status === 'rejected')) throw fail('LIFECYCLE_WINDOW_DRAIN_FAILED');
  } });
  windows.add(api); schedulingScopes.set(api, scopes);
  return api;
}
module.exports = { create, assertNoAmbientScope, schedulingParent, isSuspension: error => suspensions.has(error), isWindow: value => windows.has(value) && value.closed === false };
