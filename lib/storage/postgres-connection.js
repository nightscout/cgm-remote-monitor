'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const tenantScope = require('./tenant-scope');
const operationWindows = require('../tenant-lifecycle/operation-window');
let requiredWindow = null;
const liveConnections = new Set();

const { SQL: DATASTORE_SQL, identity: datastoreIdentity } = require('./postgres-datastore');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_CHUNK = 500;

// Transaction foundation only: not registered as an available storage backend.
module.exports = async function postgresConnection (options) {
  if (!options || typeof options.connectionString !== 'string' || !options.connectionString.trim()) {
    throw new TypeError('PostgreSQL hosted connections require an explicit connectionString');
  }
  const { operationWindow: requestedWindow, ...poolOptions } = options;
  if (requiredWindow && requestedWindow !== undefined && requestedWindow !== requiredWindow.window) {
    throw new TypeError('A selected operation window cannot be replaced by a connection');
  }
  const operationWindow = requiredWindow ? requiredWindow.window : requestedWindow;
  if (operationWindow !== undefined && [operationWindow.acquireClient, operationWindow.assertClient].some(fn => typeof fn !== 'function')) {
    throw new TypeError('PostgreSQL operation window requires physical lease and current admission');
  }
  const pool = new Pool(poolOptions);
  const record = { window: operationWindow, backends: new Map(), datastore: null, closed: false };
  liveConnections.add(record);
  pool.on('remove', client => record.backends.delete(client.processID));
  function backendIdentity (client, row) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid < 1 || row.pid !== client.processID ||
        typeof row.role !== 'string' || !row.role || typeof row.birth !== 'string' || !row.birth) {
      const error = new Error('PostgreSQL direct backend identity required for selected operation window');
      error.code = 'POSTGRES_COHORT_BACKEND_IDENTITY';
      throw error;
    }
    const datastore = datastoreIdentity(row);
    if (record.datastore && JSON.stringify(record.datastore) !== JSON.stringify(datastore)) throw new Error('PostgreSQL cohort datastore changed');
    record.datastore = datastore;
    return Object.freeze({ pid: row.pid, role: row.role, birth: row.birth });
  }
  // Decision admission-epoch-everywhere: a pooled client is one backend for its
  // life, so its identity is read once per client and again whenever the client's
  // backend pid differs (a reconnect is a new client and a new backend).
  const observed = new WeakMap();
  async function observeBackend (client) {
    if (!operationWindow) return;
    if (observed.get(client) === client.processID && record.backends.has(client.processID)) return;
    const row = (await client.query("SELECT pg_backend_pid() AS pid,current_user AS role,extract(epoch from backend_start)::text AS birth," + DATASTORE_SQL + " FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];
    const identity = backendIdentity(client, row);
    record.backends.set(identity.pid, identity);
    observed.set(client, identity.pid);
  }
  async function startupRole () {
    const text = "SELECT rolsuper, rolbypassrls,pg_backend_pid() AS pid,current_user AS role,(SELECT extract(epoch from backend_start)::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS birth," + DATASTORE_SQL + " FROM pg_roles WHERE rolname = current_user";
    if (!operationWindow) return pool.query(text);
    // The first-reference cohort requires one physical PostgreSQL backend per
    // client. Do not adopt a transaction-pooler backend through its SQL label.
    const client = await pool.connect(); let failure;
    try {
      const result = await client.query(text), row = result.rows[0];
      const identity = backendIdentity(client, row);
      record.backends.set(identity.pid, identity);
      return result;
    } catch (error) { failure = error; throw error; }
    finally { client.release(failure); }
  }
  const transactions = new AsyncLocalStorage();
  let ending;
  pool.on('error', function idleConnectionError (error) {
    console.error('PostgreSQL idle connection error:', error.code || error.name);
  });

  try {
    const result = await startupRole();
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error('PostgreSQL application connections require NOSUPERUSER NOBYPASSRLS');
    }
  } catch (error) {
    try {
      await pool.end();
      record.closed = true; liveConnections.delete(record);
    } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }

  function tenantId () {
    const tenant = tenantScope.requireTenant('postgres transaction');
    if (typeof tenant !== 'string' || !UUID.test(tenant)) {
      throw new TypeError('PostgreSQL hosted transactions require a UUID tenant binding');
    }
    return tenant;
  }

  function activeTransaction (tenant) {
    const transaction = transactions.getStore();
    if (transaction && (!transaction.active || transaction.tenant !== tenant)) {
      throw new Error('PostgreSQL transaction scope is closed or belongs to another tenant');
    }
    return transaction;
  }

  function assertUsable (transaction) {
    if (!transaction.active) throw new Error('PostgreSQL transaction scope is closed');
    if (transaction.connectionError) throw transaction.connectionError;
  }

  async function queryInTransaction (transaction, text, values) {
    assertUsable(transaction);
    const result = await transaction.client.query(text, values);
    // A socket event can arrive while a caller awaits something other than a
    // query, or alongside a query result. A known dead client cannot succeed.
    assertUsable(transaction);
    return result;
  }

  async function run (tenant, fn, begin = 'BEGIN') {
    const outer = activeTransaction(tenant);
    if (outer) { assertUsable(outer); return fn(); }
    const client = await pool.connect();
    const transaction = { client, tenant, active: true };
    // The pool removes its idle error listener while this client is checked
    // out. pg rejects active queries on transport failure, but also emits a
    // separate client error; bridge that event into this transaction's failure.
    const connectionFailed = error => {
      if (!transaction.connectionError) transaction.connectionError = error;
    };
    client.on('error', connectionFailed);
    let releaseError, windowLease, outcome, primary, windowReleaseError;
    try {
      await observeBackend(client);
      if (operationWindow) windowLease = await operationWindow.acquireClient(client, tenant);
      try {
        const metadata = operationWindow && typeof operationWindow.isMetadataTenant === 'function' && operationWindow.isMetadataTenant(tenant) === true;
        await queryInTransaction(transaction, metadata ? begin + ' READ ONLY' : begin);
        await queryInTransaction(transaction, "SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
        if (operationWindow) await operationWindow.assertClient(client, tenant, windowLease);
        assertUsable(transaction);
        outcome = await transactions.run(transaction, fn);
        assertUsable(transaction);
        const committed = await queryInTransaction(transaction, 'COMMIT');
        if (committed.command !== 'COMMIT') {
          throw new Error('PostgreSQL transaction was aborted; no changes were committed');
        }
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          releaseError = rollbackError;
          const failure = new Error('PostgreSQL operation and rollback failed');
          failure.cause = error;
          failure.rollbackError = rollbackError;
          if (transaction.connectionError) failure.connectionError = transaction.connectionError;
          throw failure;
        }
        throw error;
      }
    } catch (error) { primary = error; }
    finally {
      transaction.active = false;
      // Release reattaches the pool's idle listener synchronously. A failed
      // window unlock evicts the backend, and is reported after cleanup.
      try {
        try { if (windowLease) await windowLease.close(); }
        catch (error) { windowReleaseError = error; }
        client.release(releaseError || transaction.connectionError || windowReleaseError);
      } finally { client.removeListener('error', connectionFailed); }
    }
    if (windowReleaseError) {
      const failure = new Error('PostgreSQL operation window release failed', { cause: primary || windowReleaseError });
      failure.windowReleaseError = windowReleaseError;
      throw failure;
    }
    if (primary) throw primary;
    return outcome;
  }

  return {
    withTenant (tenant, fn) {
      return tenantScope.withTenant(tenant, () => run(tenantId(), fn));
    }
    , query (text, values) {
      const tenant = tenantId();
      const transaction = activeTransaction(tenant);
      if (transaction) return queryInTransaction(transaction, text, values);
      return run(tenant, () => queryInTransaction(transactions.getStore(), text, values));
    }
    , withSavepoint (fn) {
      return run(tenantId(), async function () {
        const transaction = transactions.getStore();
        if (transaction.savepointActive) {
          throw new Error('PostgreSQL concurrent or nested savepoint operations are unsupported');
        }
        transaction.savepointActive = true;
        const name = 'ns_' + randomUUID().replace(/-/g, '');
        try {
          await queryInTransaction(transaction, 'SAVEPOINT ' + name);
          try {
            const result = await fn();
            await queryInTransaction(transaction, 'RELEASE SAVEPOINT ' + name);
            return result;
          } catch (error) {
            try {
              await queryInTransaction(transaction, 'ROLLBACK TO SAVEPOINT ' + name);
              await queryInTransaction(transaction, 'RELEASE SAVEPOINT ' + name);
            } catch (rollbackError) {
              const failure = new Error('PostgreSQL operation and savepoint rollback failed', { cause: error });
              failure.rollbackError = rollbackError;
              throw failure;
            }
            throw error;
          }
        } finally { transaction.savepointActive = false; }
      });
    }
    , transaction (fn) {
      const tenant = tenantId();
      if (activeTransaction(tenant)) throw new Error('PostgreSQL commit boundary requires a new transaction');
      return run(tenant, fn);
    }
    // Explicit stronger snapshot capability for dormant durable consumers.
    // Never pretend an already-open READ COMMITTED transaction is upgraded.
    // Bookkeeping writes may commit in this snapshot; it is not READ ONLY.
    , snapshotTransaction (fn) {
      const tenant = tenantId();
      if (activeTransaction(tenant)) throw new Error('PostgreSQL snapshot requires a new transaction');
      return run(tenant, fn, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    }
    // One READ ONLY statement with no tenant bound (app.current_tenant_id is
    // unset, so tenant RLS returns nothing). For catalogue reads and narrow
    // SECURITY DEFINER hint functions; no operation-window lease, nothing served.
    , async readOnly (text, values) {
      if (typeof text !== 'string' || !/^SELECT\s/.test(text) || /;/.test(text)) throw new TypeError('PostgreSQL read-only query requires one SELECT');
      if (transactions.getStore()) throw new Error('PostgreSQL read-only query cannot run inside a tenant transaction');
      const client = await pool.connect(); let failure;
      try {
        await observeBackend(client);
        await client.query('BEGIN READ ONLY');
        const result = await client.query(text, values);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        failure = error;
        try { await client.query('ROLLBACK'); } catch { /* the client is released as failed */ }
        throw error;
      } finally { client.release(failure); }
    }
    // Change hints for many tenants in one round trip (D6: a wake is a hint,
    // the stamp read under the tenant's own binding is compared with what was
    // served). One READ ONLY transaction binds each tenant in turn through the
    // same RLS setting withTenant uses, then runs one fixed single-row
    // statement. It takes no operation-window lease, so nothing read here may
    // be served: callers only decide whether to run a windowed operation.
    , async scanTenants (tenants, text) {
      if (!Array.isArray(tenants) || tenants.some(tenant => typeof tenant !== 'string' || !UUID.test(tenant)) ||
          new Set(tenants).size !== tenants.length) throw new TypeError('PostgreSQL tenant scan requires distinct UUID tenants');
      if (typeof text !== 'string' || !/^SELECT\s/.test(text) || /[;\\$]/.test(text)) {
        throw new TypeError('PostgreSQL tenant scan requires one fixed parameterless SELECT');
      }
      if (transactions.getStore()) throw new Error('PostgreSQL tenant scan cannot run inside a tenant transaction');
      const found = new Map();
      for (let start = 0; start < tenants.length; start += SCAN_CHUNK) {
        const chunk = tenants.slice(start, start + SCAN_CHUNK);
        const client = await pool.connect(); let failure;
        try {
          await observeBackend(client);
          // Tenant ids are validated UUID literals; the statement is fixed.
          const statements = ['BEGIN READ ONLY'];
          for (const tenant of chunk) statements.push("SELECT set_config('app.current_tenant_id','" + tenant.toLowerCase() + "',true)", text);
          statements.push('COMMIT');
          const results = await client.query(statements.join(';'));
          if (!Array.isArray(results) || results.length !== statements.length || results.at(-1).command !== 'COMMIT') {
            throw new Error('PostgreSQL tenant scan was not committed');
          }
          chunk.forEach((tenant, index) => found.set(tenant, results[2 + index * 2].rows));
        } catch (error) {
          failure = error;
          try { await client.query('ROLLBACK'); } catch { /* the client is released as failed */ }
          throw error;
        } finally { client.release(failure); }
      }
      return found;
    }
    , end () {
      if (record.closed) return Promise.resolve();
      if (!ending) ending = pool.end().then(() => {
        record.closed = true;
        liveConnections.delete(record);
      });
      // Failed drain stays in the cohort census and prevents registry release.
      return ending;
    }
  };
};


// A selected, privately composed role cohort must not let a helper create a
// bare lower port by forgetting an option. The owning boot coordinator keeps
// this release closure and may call it only after its contexts/pools drain.
// Only the explicitly selected, privately composed role cohort installs it.
module.exports.installOperationWindow = function installOperationWindow (window) {
  if (!operationWindows.isWindow(window)) throw new TypeError('An actual live operation window is required');
  if (requiredWindow) throw new Error('An operation window is already selected');
  if (liveConnections.size) throw new Error('Existing PostgreSQL connections prevent complete cohort selection');
  const binding = { window }; requiredWindow = binding; let released = false;
  return function releaseOwnedWindow () {
    if (released) return;
    if (requiredWindow !== binding) throw new Error('Operation window ownership changed');
    if ([...liveConnections].some(record => record.window === window && !record.closed)) {
      throw new Error('PostgreSQL cohort connections must drain before release');
    }
    requiredWindow = null; released = true;
  };
};

// Private coordinator census: immutable observed backend identities, never credentials.
module.exports.cohortBackends = function cohortBackends (window) {
  if (!requiredWindow || requiredWindow.window !== window || !operationWindows.isWindow(window)) throw new Error('PostgreSQL cohort is not selected');
  const rows = [];
  for (const record of liveConnections) {
    if (record.closed || record.window !== window) throw new Error('Unselected PostgreSQL cohort connection');
    rows.push(...record.backends.values());
  }
  return Object.freeze(rows.slice());
};

module.exports.datastoreSQL = DATASTORE_SQL;
module.exports.datastoreIdentity = datastoreIdentity;
module.exports.cohortDatastore = function cohortDatastore (window) {
  module.exports.cohortBackends(window);
  const identities = [...liveConnections].filter(record => record.window === window && !record.closed).map(record => record.datastore);
  if (!identities.length || identities.some(value => !value || JSON.stringify(value) !== JSON.stringify(identities[0]))) throw new Error('PostgreSQL cohort datastore unavailable');
  return identities[0];
};
