'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const tenantScope = require('./tenant-scope');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Transaction foundation only: not registered as an available storage backend.
module.exports = async function postgresConnection (options) {
  if (!options || typeof options.connectionString !== 'string' || !options.connectionString.trim()) {
    throw new TypeError('PostgreSQL hosted connections require an explicit connectionString');
  }
  const pool = new Pool(options);
  const transactions = new AsyncLocalStorage();
  pool.on('error', function idleConnectionError (error) {
    console.error('PostgreSQL idle connection error:', error.code || error.name);
  });

  try {
    const result = await pool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    const role = result.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error('PostgreSQL application connections require NOSUPERUSER NOBYPASSRLS');
    }
  } catch (error) {
    await pool.end();
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
    let releaseError;
    try {
      await queryInTransaction(transaction, begin);
      await queryInTransaction(transaction, "SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
      const result = await transactions.run(transaction, fn);
      assertUsable(transaction);
      const committed = await queryInTransaction(transaction, 'COMMIT');
      if (committed.command !== 'COMMIT') {
        throw new Error('PostgreSQL transaction was aborted; no changes were committed');
      }
      return result;
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
    } finally {
      transaction.active = false;
      // Release reattaches the pool's idle listener synchronously. Keep our
      // listener until that handoff, and evict any client that reported death.
      try { client.release(releaseError || transaction.connectionError); }
      finally { client.removeListener('error', connectionFailed); }
    }
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
    , end () { return pool.end(); }
  };
};
