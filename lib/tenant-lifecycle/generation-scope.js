'use strict';

// The role keeps a generation in its asynchronous request scope. Only a
// database transaction holds the replacement lock. A response can outlive it.
const { AsyncLocalStorage } = require('node:async_hooks');
const { isDeepStrictEqual } = require('node:util');
const { tryGenerationLock, sharedGenerationLockStatement } = require('./transaction-fence');
const tenantLock = require('./tenant-lock');
const diagnostics = require('../diagnostics/m7');
const observer = require('../storage/postgres-datastore');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TENANT = '00000000-0000-0000-0000-000000000000';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const OPEN_BEGINS = new Set(['BEGIN ISOLATION LEVEL READ COMMITTED', 'BEGIN ISOLATION LEVEL REPEATABLE READ']);
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
  if (parent && (parent.tenant !== tenant || !parent.active || !parent.accepting)) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  const bound = require('../storage/tenant-scope').currentTenant();
  if (bound !== undefined && bound !== tenant) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  if (!parent) return null;
  window.assertCurrent(tenant);
  let token = schedulingTokens.get(parent);
  if (!token) { token = Object.freeze({}); schedulingTokens.set(parent, token); }
  return token;
}

const guards = new WeakMap();
function guarded(scope, code, guard) {
  const error = fail(code);
  guards.set(error, {scope, guard});
  return error;
}
const LOCK_RULES = Object.freeze({ 'tenant-id-sha256-v1': tenant => require('../tenant-registry/rules').lockKey(tenant) });
function create ({ namespace, locks, lockRule, pool, trustedWorker = false, intakeProfile: legacyProfile, nativeSelection, available = () => true, availabilityEpoch = () => null, datastore, invalidate = async () => {}, fewerRoundTrips = false }) {
  // The supported native lifecycle selection has its own key; intakeProfile
  // carries only the legacy fixed and pool profiles (legacy-topology-retirement).
  if (legacyProfile !== undefined && (nativeSelection !== undefined || require('./native-selection').isNative(legacyProfile))) throw new TypeError('LIFECYCLE_NATIVE_SELECTION_KEY_REQUIRED');
  if (nativeSelection !== undefined && !require('./native-selection').isNative(nativeSelection)) throw new TypeError('LIFECYCLE_NATIVE_SELECTION_KEY_REQUIRED');
  let intakeProfile = nativeSelection ?? legacyProfile;
  if(intakeProfile!==undefined)intakeProfile = require('./generation-domain').bind(intakeProfile,namespace,Array.isArray(locks)?locks.map(row=>row.tenant):undefined);
  const nativeProfile=require('./native-selection').isNative(intakeProfile),poolProfile=intakeProfile&&require('./generation-domain').isPool(intakeProfile);
  const poolAuthority=poolProfile?require('./pool-authority').create({namespace}):null;
  if(poolProfile&&lockRule!=='tenant-id-sha256-v1')throw new TypeError('LIFECYCLE_POOL_DYNAMIC_LOCK_RULE_REQUIRED');
  if (typeof fewerRoundTrips !== 'boolean') throw new TypeError('Explicit fewer round trips mode required');
  // NS_EVAL_FEWER_ROUNDTRIPS: fixed fence statements travel as one simple-protocol
  // query. The pool profile's extra authority read keeps the separate statements.
  const merged = fewerRoundTrips && !poolProfile;
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

  const receipts = new WeakMap();
  const generations = new Map();
  const changing = new Map();
  let initial, closed = false;
  const expected = () => datastore?.() || initial;
  const sameEpoch = epoch => epoch === availabilityEpoch();
  function assertOperational (epoch = availabilityEpoch()) {
    if (closed || !available() || !sameEpoch(epoch)) throw guarded(api, 'LIFECYCLE_WINDOW_SCOPE_INVALID', 'admission-withdrawn');
  }
  // A direct pg Client owns one backend. Re-read its identity when its PID
  // or the role's admission epoch changes, even if the pool reuses the object.
  const backends = new WeakMap();
  async function checkDatastore (client) {
    const epoch = availabilityEpoch();
    let entry = backends.get(client);
    if (!entry || entry.pid !== client.processID || entry.epoch !== epoch) {
      const database = await observer.read(client);
      assertOperational(epoch);
      entry = {pid:client.processID, epoch, database};
      backends.set(client, entry);
    }
    const value = entry.database;
    if (expected() && !isDeepStrictEqual(expected(), value)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');
    return value;
  }
  async function ready () {
    assertOperational();
    if (initial) return;
    const client = await pool.connect();
    let failure;
    try { initial = await checkDatastore(client); }
    catch (error) { failure = error; throw error; }
    finally { client.release(failure); }
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
  const FIELDS = 'w.lock_key::text AS lock_key,w.phase,w.generation::text AS generation';
  function admittedGeneration (row, key, bindSnapshot) {
    if (bindSnapshot && row?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    if (!row || row.lock_key !== key || typeof row.generation !== 'string' || !/^[1-9][0-9]*$/.test(row.generation)) throw fail('LIFECYCLE_WINDOW_BINDING_CHANGED');
    if (row.phase !== 'active') throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    return row.generation;
  }
  function snapshotSql (tenant, key) {
    return "WITH /* operation-window-current */ /* operation-window-snapshot */ binding AS MATERIALIZED (" +
      "SELECT set_config('app.current_tenant_id'," + tenant + ",true)::uuid AS tenant,pg_try_advisory_xact_lock_shared(" + key + "::bigint) AS held) " +
      'SELECT b.held,w.lock_key,w.phase,w.generation FROM binding b LEFT JOIN LATERAL ' +
      '(SELECT ' + FIELDS + ' FROM ' + table + ' w WHERE b.held AND w.tenant_id=b.tenant OFFSET 0) w ON true';
  }
  function windowSql (final, tenant) {
    return (final ? 'SELECT /* operation-window-final */ ' : 'SELECT /* operation-window-current */ ') +
      FIELDS + ' FROM ' + table + ' w WHERE w.tenant_id=' + tenant;
  }
  // Validated literals for a simple-protocol query of several statements. Only a
  // UUID and a decimal bigint reach the text.
  function literals (tenant, key) {
    if (!UUID.test(tenant) || tenant === METADATA_TENANT || typeof key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(key) ||
        BigInt(key) > 9223372036854775807n) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    return { tenant: "'" + tenant + "'", key };
  }
  async function readGeneration (client, tenant, key, { final = false, bindSnapshot = false } = {}) {
    const end = diagnostics.time('window.admission');
    try {
      assertOperational();
      // A sole observation or a fresh REPEATABLE READ data snapshot can use
      // this statement's snapshot throughout. A writable READ COMMITTED
      // transaction takes its lock in a prior statement to get a fresh view.
      const sql = bindSnapshot ? snapshotSql('$1', '$2') : windowSql(final, '$1');
      const row = (await client.query(sql, bindSnapshot ? [tenant, key] : [tenant])).rows[0];
      const generation = admittedGeneration(row, key, bindSnapshot);
      if (poolProfile) {
        const live = await poolAuthority.read(client.query.bind(client), tenant);
        if (live.generation !== row.generation || live.identity !== tenant || live.eligibility !== 'active') throw fail('LIFECYCLE_WINDOW_TENANT_AUTHORITY_REFUSED');
      }
      assertOperational();
      return generation;
    } finally { end(); }
  }

  // Use a fresh READ COMMITTED observation for scopes and imported snapshots.
  // Return the client to the pool before running any application callback.
  async function observe (tenant, key) {
    const client = await pool.connect();
    let failure;
    try {
      await checkDatastore(client);
      if (merged) {
        // One round trip: BEGIN, the bound observation and COMMIT. The read is
        // its own statement and snapshot; nothing is written, so it commits first
        // and is checked after. A failed statement skips the COMMIT.
        const end = diagnostics.time('window.admission');
        try {
          assertOperational();
          const value = literals(tenant, key);
          const results = await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;' + snapshotSql(value.tenant, value.key) + ';COMMIT');
          if (!Array.isArray(results) || results.length !== 3 || results[2].command !== 'COMMIT') throw fail('LIFECYCLE_WINDOW_OBSERVATION_UNCONFIRMED');
          const generation = admittedGeneration(results[1].rows[0], key, true);
          assertOperational();
          return generation;
        } finally { end(); }
      }
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      const generation = await readGeneration(client, tenant, key, { bindSnapshot: true });
      if ((await client.query('COMMIT')).command !== 'COMMIT') throw fail('LIFECYCLE_WINDOW_OBSERVATION_UNCONFIRMED');
      return generation;
    } catch (error) { failure = error; throw error; }
    finally { client.release(failure); }
  }

  // Remember the highest observed generation even if cache retirement fails.
  // A null change means the next entry must retry before it can use that cache.
  async function synchronize (tenant, generation, epoch) {
    while (changing.get(tenant)) await changing.get(tenant);
    assertOperational(epoch);
    const previous = generations.get(tenant);
    if (previous === undefined) {
      generations.set(tenant, generation);
      return;
    }
    if (BigInt(previous) > BigInt(generation)) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    if (previous === generation && !changing.has(tenant)) return;
    generations.set(tenant, generation);
    const change = Promise.resolve().then(() => invalidate(tenant));
    changing.set(tenant, change);
    try {
      await change;
      assertOperational(epoch);
      changing.delete(tenant);
    } catch (error) {
      changing.set(tenant, null);
      throw error;
    }
  }

  function assertCurrent (tenant) {
    const parent = scopes.getStore();
    assertOperational(parent?.epoch);
    if (!parent || parent.tenant !== tenant || !parent.active || !parent.accepting)
      throw guarded(api, 'LIFECYCLE_WINDOW_SCOPE_INVALID', !parent ? 'scope-missing' : parent.tenant !== tenant ? 'scope-tenant-mismatch' : 'scope-inactive');
    if (changing.has(tenant) || generations.get(tenant) !== parent.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
  }

  async function run (tenant, body, {onScope} = {}) {
    if (typeof body !== 'function') throw new TypeError('Tenant operation body required');
    const key = keyFor(tenant);
    if (scopes.getStore()) { assertCurrent(tenant); return body(); }
    const epoch = availabilityEpoch();
    assertOperational(epoch);
    const generation = await observe(tenant, key);
    assertOperational(epoch);
    await synchronize(tenant, generation, epoch);
    assertOperational(epoch);
    const state = {tenant, generation, epoch, active: true, accepting: true, children: new Set()};
    const value = await scopes.run(state, async () => {
      try {
        assertCurrent(tenant);
        if (onScope) {
          const receipt = Object.freeze({});
          receipts.set(receipt, state); onScope(receipt);
        }
        return await body();
      } finally {
        state.accepting = false;
        await Promise.all(state.children);
        state.active = false;
      }
    });
    if (state.childError) throw state.childError;
    return value;
  }
  async function acquireClient (client, tenant) {
    assertOperational();
    const metadata = tenant === METADATA_TENANT;
    const key = metadata ? null : keyFor(tenant);
    const outer = scopes.getStore();
    if (outer && (outer.tenant !== tenant || !outer.active || !outer.accepting)) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
    if (outer) assertCurrent(tenant);
    const held = { client, tenant, key, metadata, outer, epoch: availabilityEpoch(), active: true };
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

  function reservation (client, tenant, lease) {
    const held = leases.get(lease);
    if (!held?.active || held.client !== client || held.tenant !== tenant) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    if (held.outer && (changing.has(tenant) || generations.get(tenant) !== held.outer.generation)) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    if (held.outer && !held.outer.active) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
    assertOperational(held.epoch);
    return held;
  }

  // NS_EVAL_FEWER_ROUNDTRIPS: BEGIN, the tenant binding with the shared
  // replacement lock, and the current window read as one simple-protocol query.
  // Each statement keeps its own snapshot under READ COMMITTED, so the read still
  // follows the lock; under REPEATABLE READ the binding statement takes the
  // snapshot, as with separate statements. `query` sends through the caller's
  // transaction bookkeeping. Returns null when this scope does not merge.
  async function openClient (client, tenant, lease, { begin, query, snapshot = false, readOnly = false }) {
    if (!merged) return null;
    const held = reservation(client, tenant, lease);
    if (held.metadata || !OPEN_BEGINS.has(begin) || typeof query !== 'function') return null;
    const end = diagnostics.time('window.admission');
    let results;
    try {
      assertOperational();
      const value = literals(tenant, held.key);
      results = await query(begin + ";SELECT set_config('app.current_tenant_id'," + value.tenant + ',true),pg_try_advisory_xact_lock_shared(' +
        value.key + '::bigint) AS held;' + windowSql(false, value.tenant));
    } finally { end(); }
    if (!Array.isArray(results) || results.length !== 3) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    if (results[1].rows[0]?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    held.generation = admittedGeneration(results[2].rows[0], held.key, false);
    assertOperational(held.epoch);
    return finishAssert(held, tenant, { snapshot, readOnly });
  }

  async function finishAssert (held, tenant, { snapshot, bindReadOnlySnapshot = false, readOnly }) {
    if (held.outer && held.outer.generation !== held.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    held.snapshot = snapshot;
    held.readOnly = readOnly;
    if (snapshot && !bindReadOnlySnapshot) {
      if (await observe(tenant, held.key) !== held.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    }
    assertOperational(held.epoch);
    return held.generation;
  }

  async function assertClient (client, tenant, lease, { snapshot = false, bindReadOnlySnapshot = false, readOnly = false } = {}) {
    const held = reservation(client, tenant, lease);
    if (held.metadata) {
      const result = await client.query('SHOW transaction_read_only');
      if (result.rows[0]?.transaction_read_only !== 'on') throw fail('LIFECYCLE_WINDOW_METADATA_READ_ONLY_REQUIRED');
      assertOperational(held.epoch);
      return;
    }
    if (!bindReadOnlySnapshot) {
      if (!await tenantLock.tryShared(client.query.bind(client), held.key)) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    }
    held.generation = await readGeneration(client, tenant, held.key, { bindSnapshot: bindReadOnlySnapshot });
    return finishAssert(held, tenant, { snapshot, bindReadOnlySnapshot, readOnly });
  }

  async function assertCommit (client, tenant, lease) {
    const held = reservation(client, tenant, lease);
    if (held.metadata || held.readOnly) return;
    if (!held.generation) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    if (merged && !held.snapshot) {
      // The commit lock and the final read as one round trip: two statements,
      // so the read's READ COMMITTED snapshot still follows the lock.
      const value = literals(tenant, held.key);
      const end = diagnostics.time('window.admission');
      let results;
      try {
        assertOperational();
        results = await client.query(sharedGenerationLockStatement(held.key) + ';' + windowSql(true, value.tenant));
      } finally { end(); }
      if (!Array.isArray(results) || results.length !== 2) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
      if (results[0].rows[0]?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
      if (admittedGeneration(results[1].rows[0], held.key, false) !== held.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
      assertOperational();
      reservation(client, tenant, lease);
      return;
    }
    if (!await tryGenerationLock(client, held.key, false)) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    // A separate statement after lock acquisition gets a fresh READ COMMITTED
    // snapshot. A repeatable view instead reads on its admitted control session.
    const current = held.snapshot
      ? await observe(tenant, held.key)
      : await readGeneration(client, tenant, held.key, { final: true });
    if (current !== held.generation) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    reservation(client, tenant, lease);
  }

  const api = Object.freeze({
    ready, run, acquireClient, openClient, assertClient, assertCommit, assertCurrent, namespace, trustedWorker, fewerRoundTrips: merged,
    ...(intakeProfile ? {selectionDigest: intakeProfile.digest} : {}),
    ...(intakeProfile && !nativeProfile ? {intakeProfileDigest: intakeProfile.digest} : {}),
    ...(nativeProfile ? {nativeLifecycle: intakeProfile} : {}),
    get closed () { return closed; },
    get datastore () { return expected(); },
    isMetadataTenant: tenant => tenant === METADATA_TENANT,
    currentGeneration (tenant) { assertCurrent(tenant); return scopes.getStore().generation; },
    current (tenant) {
      const state = scopes.getStore();
      return !closed && available() && state?.active === true && sameEpoch(state.epoch) && state.accepting && state.tenant === tenant &&
        !changing.has(tenant) && generations.get(tenant) === state.generation;
    },
    readinessReceiptCurrent (receipt) {
      const state = receipts.get(receipt);
      return !!state && !closed && available() && sameEpoch(state.epoch) && !state.active && !state.childError &&
        !changing.has(state.tenant) && generations.get(state.tenant) === state.generation;
    },
    readinessFacts () { return {closed, operational: !closed && available(), verifying: false, verificationFailed: false,
      sessionLost: false, probeFailed: !available()}; },
    async close () { closed = true; await Promise.allSettled([...changing.values()]); generations.clear(); }
  });
  windows.add(api);
  schedulingScopes.set(api, scopes);
  if (intakeProfile) {
    lifecycleCatalogues.set(api, require('./generation-domain').catalogue(intakeProfile));
    if (!poolProfile && !nativeProfile) intakeRosters.set(api, intakeProfile.binding.tenants);
  }
  return api;
}
module.exports = {create, assertNoAmbientScope, schedulingParent,
  intakeRoster: scope => intakeRosters.get(scope),
  catalogue: scope => lifecycleCatalogues.get(scope) || require('./postgres-candidate.json'),
  isSuspension: error => suspensions.has(error), isScope: value => windows.has(value),
  failureGuard (scope, error) { const info = guards.get(error); return info && info.scope === scope ? info.guard : null; }
};
