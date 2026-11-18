'use strict';

// Selected serving roles bind application scopes and physical SQL effects to
// the tenant lifecycle generation.
const { AsyncLocalStorage } = require('node:async_hooks');
const { tryGenerationLock } = require('./transaction-fence');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TENANT = '00000000-0000-0000-0000-000000000000';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const windows = new WeakSet(),lifecycleCatalogues=new WeakMap(),intakeRosters=new WeakMap();
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
  if (code === 'LIFECYCLE_WINDOW_SUSPENDED') {
    suspensions.add(error);
    error.status = 503;
    error.retryAfter = 1;
  }
  return error;
};

// Assertion only, for explicit private evaluator entry. It never creates,
// clears or changes authority. Closed/expired/foreign callers are refused before
// a trusted scheduler can enqueue anything on their behalf.
function schedulingParent (window, tenant) {
  const storage = schedulingScopes.get(window);
  if (!storage || window.closed) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  const parent = storage.getStore();
  if (parent?.stale) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
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
function create ({ namespace, locks, lockRule, pool, leaseSessionCount, trustedWorker = false, intakeProfile }) {
  if(intakeProfile!==undefined)intakeProfile = require('./generation-domain').bind(intakeProfile,namespace,Array.isArray(locks)?locks.map(row=>row.tenant):undefined);
  const nativeProfile=require('./native-selection').isNative(intakeProfile),poolProfile=intakeProfile&&require('./generation-domain').isPool(intakeProfile);
  const poolAuthority=poolProfile?require('./pool-authority').create({namespace}):null;
  if(poolProfile&&lockRule!=='tenant-id-sha256-v1')throw new TypeError('LIFECYCLE_POOL_DYNAMIC_LOCK_RULE_REQUIRED');
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
      try { identity = await admit(client, namespace, {lifetime:true,intakeProfile}); database = await datastore.read(client); cluster = await datastore.cluster(client); await rememberBackend(client, true); operational = verifying === 0; }
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
    if (trustedWorker) operational = false;
    try {
      await ready();
      await sessions.control(async client => {
        await admit(client, namespace, { lifetime: true, identity, intakeProfile });
        if (!same(await datastore.read(client), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');
        await rememberBackend(client, true);
      });
      if (relatedVerification) await relatedVerification();
    } catch (failure) { operational = false; verificationFailed = true; throw failure; }
    finally {
      // Concurrent verifications cannot reopen admission around a pending or
      // failed related check. A later complete verification can retry the batch.
      if (!--verifying) operational = !verificationFailed && !closed;
    }
  }
  const running = new Set();
  let probeFailure;
  const activeBodies = new Set();
  const sessions = require('./lifetime-sessions').create({ pool, size: leaseSessionCount ?? pool.options?.max ?? 1 });
  // Decision datastore-loss-recover-in-place. `probe` answers one question on a
  // new or pooled backend: can this process admit a tenant operation now? It
  // refuses while a lifetime session is lost or the backend reports a datastore
  // other than the admitted one. One cheap statement, no catalogue admission.
  async function probe () {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    await ready();
    if (sessions.failed()) throw fail('LIFECYCLE_WINDOW_SESSION_LOST');
    try { await sessions.control(async client => { if (!same(await datastore.read(client), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED'); }); }
    catch (error) { probeFailure = error; sessions.invalidate(error); throw error; }
  }
  // Recovery re-admits the same database and catalogue objects in the same
  // PostgreSQL cluster. Network address/port may change after a container move.
  // A selected supervisor still refuses changed resource epochs before adoption;
  // the system identifier neither rebinds its sealed plan nor refunds credits.
  // beforeAdopt drops old cached tenant state before any changed endpoint or
  // postmaster is adopted.
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
      let nextIdentity, nextDatabase, nextCluster;
      await sessions.control(async client => { active(); nextIdentity = await admit(client, namespace, { lifetime: true, intakeProfile }); active(); nextDatabase = await datastore.read(client); active(); nextCluster = await datastore.cluster(client); });
      active();
      if (!same(lineage(nextDatabase, nextCluster), lineage(database, cluster)) || !same(nextIdentity, identity)) throw fail('LIFECYCLE_WINDOW_DATASTORE_REPLACED');
      const restarted = !same(nextDatabase, database);
      if (restarted && require('../storage/connection-admission').health() !== null) throw fail('DATASTORE_RECOVERY_REBIND_REQUIRED');
      if (restarted) sessions.invalidate(fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED'));
      if ([...activeBodies].some(state => state.failure)) throw fail('LIFECYCLE_WINDOW_DRAIN_REQUIRED');
      if (restarted && beforeAdopt) await beforeAdopt();
      active();
      // Publish adoption only after every refusal boundary. A retry must still
      // report the real restart if an earlier attempt could not drain bodies.
      database = nextDatabase; probeFailure = null; operational = verifying === 0;
      if (restarted) backends = new WeakMap();
      const sessionsReplaced = sessions.reset();
      return Object.freeze({ restarted, sessionsReplaced });
    })().catch(error => { if (trustedWorker) operational = false; throw error; }).finally(() => { recovering = null; });
    return recovering;
  }
  function keyFor (tenant) {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    if(intakeProfile&&!poolProfile&&!nativeProfile)try{intakeProfile.assignment.owner(tenant);}catch{throw fail('LIFECYCLE_WINDOW_TENANT_UNKNOWN');}
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
    await admit(client, namespace, {lifetime, identity, intakeProfile});
    if (!same(await datastore.read(client), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');
    await rememberBackend(client, lifetime);
  }
  async function admitClient (client) { await ready(); await admitBackend(client, false); }
  // Readiness obtains its exact source-selected control surface from this window.
  // Native recommission grants are column-scoped; refresh their catalogue and
  // backend admission here so a warm client cannot hide a later grant change.
  // This is a readiness boundary, never an ordinary operation's hot path.
  async function readinessControlRelations (client) {
    await ready();
    if (nativeProfile) await admitBackend(client, false, true);
    else if (!isAdmittedClient(client)) {
      if (intakeProfile) await admitBackend(client, false);
      else await admit(client, namespace, {identity});
    }
    return Object.freeze(['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations',
      ...(nativeProfile ? [require('./recommission-candidate').TABLE] : [])].map(table => namespace + '.' + table));
  }
  function assertOperational (finishing = false) {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    // An admitted effect may finish while its own backend is queued for health
    // verification. A failed or completed verification still governs output.
    if (!operational && !(trustedWorker && finishing && verifying && !verificationFailed)) throw fail('LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
    if (sessions.failed()) throw fail('LIFECYCLE_WINDOW_SESSION_LOST');
    if (probeFailure) throw probeFailure;
  }

  async function readGeneration (client, tenant, key, { final = false, bindSnapshot = false } = {}) {
    const end = diagnostics.time('window.admission');
    try {
      assertOperational(final);
      // A sole observation or a fresh REPEATABLE READ data snapshot can use
      // this statement's snapshot throughout. A writable READ COMMITTED
      // transaction takes its lock in a prior statement to get a fresh view.
      const fields = 'w.lock_key::text AS lock_key,w.phase,w.generation::text AS generation';
      const sql = bindSnapshot
        ? "WITH /* operation-window-current */ /* operation-window-snapshot */ binding AS MATERIALIZED (" +
          "SELECT set_config('app.current_tenant_id',$1,true)::uuid AS tenant,pg_try_advisory_xact_lock_shared($2::bigint) AS held) " +
          'SELECT b.held,w.lock_key,w.phase,w.generation FROM binding b LEFT JOIN LATERAL ' +
          '(SELECT ' + fields + ' FROM ' + table + ' w WHERE b.held AND w.tenant_id=b.tenant OFFSET 0) w ON true'
        : (final ? 'SELECT /* operation-window-final */ ' : 'SELECT /* operation-window-current */ ') +
          fields + ' FROM ' + table + ' w WHERE w.tenant_id=$1';
      const row = (await client.query(sql, bindSnapshot ? [tenant, key] : [tenant])).rows[0];
      if (bindSnapshot && row?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
      if (!row || row.lock_key !== key || typeof row.generation !== 'string' || !/^[1-9][0-9]*$/.test(row.generation)) throw fail('LIFECYCLE_WINDOW_BINDING_CHANGED');
      if (row.phase !== 'active') throw fail('LIFECYCLE_WINDOW_SUSPENDED');
      if (poolProfile) {
        const live = await poolAuthority.read(client.query.bind(client), tenant);
        if (live.generation !== row.generation || live.identity !== tenant || live.eligibility !== 'active') throw fail('LIFECYCLE_WINDOW_TENANT_AUTHORITY_REFUSED');
      }
      assertOperational(final);
      return row.generation;
    } finally { end(); }
  }

  // The control backend has its own READ COMMITTED view even when the data
  // transaction imported a snapshot. End this transaction before running a body.
  async function currentObservation (session, tenant, key, dataLockHeld = false, final = false) {
    return session.serial(async () => {
      const client = session.client;
      await admitBackend(client, true);
      let began = false, committing = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
        began = true;
        if (dataLockHeld) {
          await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
        }
        const generation = await readGeneration(client, tenant, key, { final, bindSnapshot: !dataLockHeld });
        committing = true;
        if ((await client.query('COMMIT')).command !== 'COMMIT') throw fail('LIFECYCLE_WINDOW_OBSERVATION_UNCONFIRMED');
        return generation;
      } catch (error) {
        if (committing) session.poison(error);
        else if (began) {
          try { await client.query('ROLLBACK'); }
          catch (rollback) { session.poison(rollback); }
        }
        throw error;
      }
    });
  }

  // Reserve the physical child's place in the JavaScript scope before BEGIN.
  // No session lock spans this handle. PostgreSQL releases both fences itself.
  async function acquireClient (client, tenant) {
    assertOperational();
    const metadata = tenant === METADATA_TENANT;
    const key = metadata ? null : keyFor(tenant);
    const outer = scopes.getStore();
    if (outer && (outer.tenant !== tenant || !outer.active || !outer.accepting)) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
    if (outer?.stale) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    await admitBackend(client, false);
    if (outer && (!outer.active || !outer.accepting)) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
    const held = { client, tenant, key, metadata, outer, active: true };
    let finish;
    const child = outer && new Promise(resolve => { finish = resolve; });
    if (child) outer.children.add(child);
    const lease = Object.freeze({ close (failure) {
      if (!held.active) return;
      held.active = false;
      if (child) {
        if (failure) outer.childError = outer.childError || failure;
        outer.children.delete(child);
        finish();
      }
    } });
    leases.set(lease, held);
    return lease;
  }

  function reservation (client, tenant, lease, finishing = false) {
    const held = leases.get(lease);
    if (!held?.active || held.client !== client || held.tenant !== tenant) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    if (!isAdmittedClient(client)) throw fail('LIFECYCLE_WINDOW_NOT_READY');
    if (held.outer && !held.outer.active) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
    if (held.outer?.stale) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    assertOperational(finishing);
    return held;
  }

  async function assertClient (client, tenant, lease, { snapshot = false, bindReadOnlySnapshot = false, readOnly = false } = {}) {
    const held = reservation(client, tenant, lease);
    if (held.metadata) {
      const result = await client.query('SHOW transaction_read_only');
      if (result.rows[0]?.transaction_read_only !== 'on') throw fail('LIFECYCLE_WINDOW_METADATA_READ_ONLY_REQUIRED');
      return;
    }
    if (!bindReadOnlySnapshot) {
      const lock = await client.query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS held', [held.key]);
      if (lock.rows[0]?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    }
    held.generation = await readGeneration(client, tenant, held.key, { bindSnapshot: bindReadOnlySnapshot });
    if (held.outer && held.outer.generation !== held.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    held.snapshot = snapshot;
    held.readOnly = readOnly;
    if (snapshot && !bindReadOnlySnapshot) {
      held.session = await sessions.acquire(tenant);
      if (await currentObservation(held.session, tenant, held.key, true) !== held.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    }
    return held.generation;
  }

  async function assertCommit (client, tenant, lease) {
    const held = reservation(client, tenant, lease, true);
    if (held.metadata || held.readOnly) return;
    if (!held.generation) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    if (!await tryGenerationLock(client, held.key, false)) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    // A separate statement after lock acquisition gets a fresh READ COMMITTED
    // snapshot. A repeatable view instead reads on its admitted control session.
    const current = held.snapshot
      ? await currentObservation(held.session, tenant, held.key, true, true)
      : await readGeneration(client, tenant, held.key, { final: true });
    if (current !== held.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    reservation(client, tenant, lease, true);
  }

  async function executeBody (tenant, fn, { onInvalidated } = {}) {
    if (typeof fn !== 'function' || onInvalidated !== undefined && typeof onInvalidated !== 'function') throw new TypeError('Operation body and optional invalidation callback required');
    const key = keyFor(tenant);
    const outer = scopes.getStore();
    if (outer) {
      assertCurrent(tenant);
      return fn();
    }
    await ready();
    assertOperational();
    const session = await sessions.acquire(tenant);
    const state = { tenant, active: true, accepting: true, children: new Set() };
    const unsubscribe = session.subscribe(error => {
      state.failure = error;
      state.active = false;
      try { onInvalidated?.(); } catch { /* Transport invalidation is best effort. */ }
    });
    activeBodies.add(state);
    const endBody = diagnostics.time('window.body_response_inclusive');
    diagnostics.delta('window.outer_bodies', 1);
    let value;
    try {
      state.generation = await currentObservation(session, tenant, key);
      if (state.failure) throw state.failure;
      if (state.stale) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
      value = await scopes.run(state, fn);
    } finally {
      state.accepting = false;
      await Promise.all([...state.children]);
      state.active = false;
      activeBodies.delete(state);
      unsubscribe();
      diagnostics.delta('window.outer_bodies', -1);
      endBody();
    }
    if (state.failure) throw state.failure;
    if (state.childError) throw state.childError;
    if (trustedWorker && !operational) throw fail('LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
    return value;
  }

  function run (tenant, fn, options) {
    const pending = executeBody(tenant, fn, options);
    running.add(pending);
    pending.then(() => running.delete(pending), () => running.delete(pending));
    return pending;
  }
  function invalidateTenant (tenant) {
    keyFor(tenant);
    // Suspended callers can still finish an already committed HTTP response.
    // An old application scope cannot start a new transaction or publish output.
    for (const state of activeBodies) if (state.tenant === tenant) state.stale = true;
  }
  function assertCurrent (tenant) {
    const current = scopes.getStore();
    if (current?.stale) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    if (!current || current.tenant !== tenant || !current.active || !current.accepting || !operational || probeFailure) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  }
  const api = Object.freeze({
    ...(intakeProfile ? { get intakeProfileDigest () { return intakeProfile.digest; } } : {}),
    ready, probe, recover, invalidateTenant, verifyClient, verifyOperational, admitClient, isAdmittedClient, readinessControlRelations,
    trustedWorker, namespace, acquireClient, assertClient, assertCommit, run, assertCurrent,
    get identity () { return identity; },
    get datastore () { return database; },
    get closed () { return closed; },
    currentGeneration (tenant) { assertCurrent(tenant); return scopes.getStore().generation; },
    current (tenant) {
      const value = scopes.getStore();
      return !!value && !value.stale && value.tenant === tenant && value.active && value.accepting && operational && !probeFailure;
    },
    // Legacy inspection has no cross-process application participants to drain.
    drainTenant (tenant) { keyFor(tenant); },
    inflight (tenant) { keyFor(tenant); return []; },
    isMetadataTenant: tenant => tenant === METADATA_TENANT,
    async close () {
      closed = true;
      await Promise.allSettled([...running]);
      await sessions.close();
    }
  });
  windows.add(api); if(intakeProfile){lifecycleCatalogues.set(api,require('./generation-domain').catalogue(intakeProfile));if(!poolProfile&&!nativeProfile)intakeRosters.set(api,intakeProfile.binding.tenants);} schedulingScopes.set(api, scopes);
  return api;
}
module.exports = { intakeRoster(window){if(!windows.has(window)||window.closed)throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');return intakeRosters.get(window);}, catalogue(window){if(!windows.has(window)||window.closed)throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');return lifecycleCatalogues.get(window)||require('./postgres-candidate.json');}, create, assertNoAmbientScope, schedulingParent, isSuspension: error => suspensions.has(error), isWindow: value => windows.has(value) && value.closed === false };
