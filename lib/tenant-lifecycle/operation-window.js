'use strict';

// Dormant lifetime adapter. A restore consumer must compose EVERY serving and
// lower-port path; creating this adapter alone does not admit tenant restore.
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TENANT = '00000000-0000-0000-0000-000000000000';
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const windows = new WeakSet();
const fail = code => Object.assign(new Error(code), { code });

function create ({ namespace, locks, pool }) {
  if (!NAME.test(namespace) || namespace === 'public' || namespace === 'information_schema' || namespace.startsWith('pg_') ||
      !Array.isArray(locks) || !locks.length || typeof pool?.connect !== 'function') {
    throw new TypeError('Explicit operation-window namespace, tenant lock map and pool required');
  }
  const keys = new Map(), used = new Set(), scopes = new AsyncLocalStorage(), leases = new WeakMap();
  for (const row of locks) {
    if (!UUID.test(row?.tenant) || row.tenant === METADATA_TENANT || typeof row.key !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.key) ||
        BigInt(row.key) > 9223372036854775807n || keys.has(row.tenant) || used.has(row.key)) {
      throw new TypeError('Unique provisioned tenant operation lock keys required');
    }
    keys.set(row.tenant, row.key); used.add(row.key);
  }
  const table = '"' + namespace + '".tenant_lifecycle_windows';
  let closed = false;
  const running = new Set();
  function keyFor (tenant) {
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    if (!keys.has(tenant)) throw fail('LIFECYCLE_WINDOW_TENANT_UNKNOWN');
    return keys.get(tenant);
  }
  async function acquireClient (client, tenant) {
    const metadata = tenant === METADATA_TENANT;
    if (closed) throw fail('LIFECYCLE_WINDOW_CLOSED');
    const key = metadata ? null : keyFor(tenant);
    const role = (await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) throw fail('LIFECYCLE_WINDOW_ROLE_UNSAFE');
    // Nonblocking shared acquisition avoids queueing behind maintenance while
    // an already-admitted outer serving operation is trying to drain SQL work.
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
    leases.set(lease, { client, tenant, key, metadata, active: () => active });
    return lease;
  }
  async function assertClient (client, tenant, lease) {
    const held = leases.get(lease);
    if (!held || held.client !== client || held.tenant !== tenant || !held.active()) throw fail('LIFECYCLE_WINDOW_LEASE_INVALID');
    if (held.metadata) {
      const row = (await client.query('SHOW transaction_read_only')).rows[0];
      if (row?.transaction_read_only !== 'on') throw fail('LIFECYCLE_WINDOW_METADATA_READ_ONLY_REQUIRED');
      return null;
    }
    // Caller begins/binds ONLY AFTER acquiring the session lock. In particular
    // REPEATABLE READ must not snapshot active state before waiting for a lock.
    const result = await client.query('SELECT lock_key::text,phase,generation::text FROM ' + table + ' WHERE tenant_id=$1', [tenant]);
    if (result.rows.length !== 1 || result.rows[0].lock_key !== held.key) throw fail('LIFECYCLE_WINDOW_BINDING_CHANGED');
    if (result.rows[0].phase !== 'active') throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    if (!/^[1-9][0-9]*$/.test(result.rows[0].generation)) throw fail('LIFECYCLE_WINDOW_BINDING_CHANGED');
    return result.rows[0].generation;
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
    const client = await pool.connect(); let lease, error, transportError, began = false, registered = false, generation, outcome, cleanupError;
    const operation = randomUUID();
    const state = { tenant, active: true };
    const failed = failure => {
      transportError = failure; error = error || failure; state.active = false;
      if (onInvalidated) { try { onInvalidated(); } catch (failure) { error = error || failure; } }
    };
    client.on('error', failed);
    try {
      lease = await acquireClient(client, tenant);
      await client.query('BEGIN'); began = true;
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      generation = await assertClient(client, tenant, lease);
      await client.query('INSERT INTO "' + namespace + '".tenant_lifecycle_operations (tenant_id,operation_id,generation,finished) VALUES ($1,$2,$3,false)', [tenant, operation, generation]);
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
  const api = Object.freeze({ acquireClient, assertClient, run, assertCurrent, isMetadataTenant: tenant => tenant === METADATA_TENANT, get closed () { return closed; }, current (tenant) {
    const value = scopes.getStore(); return !!value && value.tenant === tenant && value.active;
  }, async close () {
    closed = true;
    const results = await Promise.allSettled([...running]);
    if (results.some(row => row.status === 'rejected')) throw fail('LIFECYCLE_WINDOW_DRAIN_FAILED');
  } });
  windows.add(api);
  return api;
}
module.exports = { create, isWindow: value => windows.has(value) && value.closed === false };
