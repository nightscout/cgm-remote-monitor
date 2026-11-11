'use strict';

// Dormant lifetime adapter. A restore consumer must compose EVERY serving and
// lower-port path; creating this adapter alone does not admit tenant restore.
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID, createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TENANT = '00000000-0000-0000-0000-000000000000';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const windows = new WeakSet();
const suspensions = new WeakSet();
const datastore = require('../storage/postgres-datastore');
const { isDeepStrictEqual: same } = require('node:util');
const { admit } = require('./operation-window-readiness');
const epochs = require('./operation-window-epoch');
const fail = code => {
  const error = Object.assign(new Error(code), { code });
  if (code === 'LIFECYCLE_WINDOW_SUSPENDED') suspensions.add(error);
  return error;
};

// `locks` is the static tenant -> advisory lock key map; `lockRule:
// 'tenant-id-sha256-v1'` (registry mode, decision tenant-registry) derives the
// key from the tenant id (lib/tenant-registry/rules.js lockKey), the key
// provisioning wrote into the tenant's window row. Either way the window row is
// read in the transaction and a different key refuses (BINDING_CHANGED).
const LOCK_RULES = Object.freeze({ 'tenant-id-sha256-v1': tenant => require('../tenant-registry/rules').lockKey(tenant) });
function create ({ namespace, locks, lockRule, pool }) {
  if (!NAME.test(namespace) || namespace === 'public' || namespace === 'information_schema' || namespace.startsWith('pg_') ||
      (lockRule === undefined ? (!Array.isArray(locks) || !locks.length) : (locks !== undefined || !Object.hasOwn(LOCK_RULES, lockRule))) ||
      typeof pool?.connect !== 'function') {
    throw new TypeError('Explicit operation-window namespace, tenant lock map and pool required');
  }
  const keys = new Map(), used = new Set(), scopes = new AsyncLocalStorage(), leases = new WeakMap();
  const derive = lockRule === undefined ? null : LOCK_RULES[lockRule];
  for (const row of locks || []) {
    if (!UUID.test(row?.tenant) || row.tenant === METADATA_TENANT || typeof row.key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.key) ||
        BigInt(row.key) > 9223372036854775807n || keys.has(row.tenant) || used.has(row.key)) {
      throw new TypeError('Unique provisioned tenant operation lock keys required');
    }
    keys.set(row.tenant, row.key); used.add(row.key);
  }
  const table = '"' + namespace + '".tenant_lifecycle_windows';
  let closed = false, identity = null, database = null, readiness;
  function ready () {
    if (closed) return Promise.reject(fail('LIFECYCLE_WINDOW_CLOSED'));
    if (!readiness) readiness = (async () => {
      const client = await pool.connect(); let error;
      try { identity = await admit(client, namespace, {lifetime:true}); database = await datastore.read(client); }
      catch (failure) { error = failure; throw failure; }
      finally { client.release(error); }
    })();
    return readiness;
  }
  const running = new Set();
  function keyFor (tenant) {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    if (derive) {
      if (!UUID.test(tenant) || tenant === METADATA_TENANT) throw fail('LIFECYCLE_WINDOW_TENANT_UNKNOWN');
      return derive(tenant);
    }
    if (!keys.has(tenant)) throw fail('LIFECYCLE_WINDOW_TENANT_UNKNOWN');
    return keys.get(tenant);
  }
  // Admission epochs (decision cost-proportional-to-activity, item 3): the full
  // catalogue admission runs again only when the database reports, inside the
  // transaction, a catalogue epoch it has not admitted (operation-window-epoch.js).
  const admitted = new Map([[false, new Set()], [true, new Set()]]);
  const statements = new Map();
  function statement (lifetime, metadata) {
    const key = (lifetime ? 'lifetime' : 'lower') + (metadata ? '-metadata' : '');
    if (!statements.has(key)) {
      const text = 'SELECT /* operation-window-epoch ' + key + ' */ ' + epochs.sql(namespace, lifetime, identity) + ' AS epoch,pg_backend_pid() AS pid,' + datastore.SQL +
        ',r.rolsuper,r.rolbypassrls' + (metadata ? ",current_setting('transaction_read_only') AS read_only FROM pg_roles r"
          : ',w.lock_key::text AS lock_key,w.phase,w.generation::text AS generation FROM pg_roles r LEFT JOIN ' + table + ' w ON w.tenant_id=$1') +
        ' WHERE r.rolname=current_user';
      statements.set(key, { name: 'ns_window_' + createHash('sha256').update(text).digest('hex').slice(0, 24), text });
    }
    return statements.get(key);
  }
  async function current (client, tenant, lifetime, metadata) {
    const { name, text } = statement(lifetime, metadata);
    const row = (await client.query({ name, text, values: metadata ? [] : [tenant] })).rows[0];
    if (!row || row.rolsuper !== false || row.rolbypassrls !== false) throw fail('LIFECYCLE_WINDOW_ROLE_UNSAFE');
    if (row.pid !== client.processID || !same(datastore.identity(row), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');
    if (typeof row.epoch !== 'string' || !/^[0-9a-f]{64}$/.test(row.epoch)) throw fail('LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
    return row;
  }
  // The epoch and the window row are read in ONE statement inside the caller's
  // transaction. An unadmitted epoch runs the full admission on this backend and
  // is cached only when the epoch read after it is unchanged (no concurrent DDL).
  async function admission (client, tenant, lifetime, metadata) {
    let row = await current(client, tenant, lifetime, metadata);
    const cache = admitted.get(lifetime);
    for (let attempt = 0; !cache.has(row.epoch); attempt++) {
      if (attempt === 2) throw fail('LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
      await admit(client, namespace, { lifetime, identity });
      const after = await current(client, tenant, lifetime, metadata);
      if (after.epoch === row.epoch) {
        if (cache.size >= 16) cache.delete(cache.values().next().value);
        cache.add(row.epoch);
      }
      row = after;
    }
    return row;
  }
  async function acquire (client, tenant, lifetime) {
    const metadata = tenant === METADATA_TENANT;
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    const key = metadata ? null : keyFor(tenant);
    if (!identity) throw fail('LIFECYCLE_WINDOW_NOT_READY');
    // Nonblocking shared acquisition avoids queueing behind maintenance while
    // an already-admitted outer serving operation is trying to drain SQL work.
    // Role, datastore and catalogue admission follow inside the transaction
    // (assertClient), before any body SQL.
    const row = metadata ? null : (await client.query('SELECT pg_try_advisory_lock_shared($1::bigint) AS held', [key])).rows[0];
    if (!metadata && row?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    let active = true;
    const lease = Object.freeze({ async close () {
      if (!active) return;
      active = false;
      if (metadata) return;
      const value = (await client.query('SELECT pg_advisory_unlock_shared($1::bigint) AS released', [key])).rows[0];
      if (value?.released !== true) throw fail('LIFECYCLE_WINDOW_LOCK_LOST');
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
    return row.generation;
  }
  async function execute (tenant, fn, { onInvalidated } = {}) {
    if (onInvalidated !== undefined && typeof onInvalidated !== 'function') throw new TypeError('Operation-window invalidation callback must be a function');
    if (typeof fn !== 'function') throw new TypeError('Operation-window body required');
    keyFor(tenant);
    const outer = scopes.getStore();
    if (outer) {
      if (outer.tenant !== tenant || !outer.active) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
      return fn();
    }
    await ready();
    const client = await pool.connect(); let lease, error, transportError, began = false, registered = false, generation, outcome, cleanupError;
    const operation = randomUUID();
    const state = { tenant, active: true };
    const failed = failure => {
      transportError = failure; error = error || failure; state.active = false;
      if (onInvalidated) { try { onInvalidated(); } catch (failure) { error = error || failure; } }
    };
    client.on('error', failed);
    try {
      lease = await acquire(client, tenant, true);
      await client.query('BEGIN'); began = true;
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      generation = await assertClient(client, tenant, lease);
      await client.query('INSERT INTO "' + namespace + '".tenant_lifecycle_operations (tenant_id,operation_id,generation) VALUES ($1,$2,$3)', [tenant, operation, generation]);
      await client.query('COMMIT'); began = false; registered = true;
      outcome = await scopes.run(state, fn);
    } catch (failure) { error = error || failure; }
    finally {
      state.active = false;
      // A durable pending operation survives a lost lease connection. The
      // operator must refuse restoration on that orphan; lock absence alone
      // cannot prove that a response/provider callback has finished.
      try {
        if (began) await client.query('ROLLBACK');
        if (registered && !transportError) {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
          const updated = await client.query('UPDATE "' + namespace + '".tenant_lifecycle_operations SET finished=true WHERE tenant_id=$1 AND operation_id=$2 AND generation=$3 AND finished=false', [tenant, operation, generation]);
          if (updated.rowCount !== 1) cleanupError = fail('LIFECYCLE_WINDOW_OPERATION_LOST');
          else await client.query('COMMIT');
        }
      }
      catch (failure) { cleanupError = failure; }
      try { if (lease) await lease.close(); }
      catch (failure) { cleanupError = cleanupError || failure; }
      try { client.release(cleanupError || error); }
      finally { client.removeListener('error', failed); }
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
    if (!current || current.tenant !== tenant || !current.active) throw fail('LIFECYCLE_WINDOW_SCOPE_INVALID');
  }
  const api = Object.freeze({ ready, namespace, get identity () { return identity; }, get datastore () { return database; }, acquireClient, assertClient, run, assertCurrent, isMetadataTenant: tenant => tenant === METADATA_TENANT, get closed () { return closed; }, current (tenant) {
    const value = scopes.getStore(); return !!value && value.tenant === tenant && value.active;
  }, async close () {
    closed = true;
    const results = await Promise.allSettled([...running]);
    if (results.some(row => row.status === 'rejected')) throw fail('LIFECYCLE_WINDOW_DRAIN_FAILED');
  } });
  windows.add(api);
  return api;
}
module.exports = { create, isSuspension: error => suspensions.has(error), isWindow: value => windows.has(value) && value.closed === false };
