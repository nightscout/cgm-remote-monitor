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

  async function run (tenant, fn) {
    const outer = activeTransaction(tenant);
    if (outer) return fn();
    const client = await pool.connect();
    const transaction = { client, tenant, active: true };
    let releaseError;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
      const result = await transactions.run(transaction, fn);
      const committed = await client.query('COMMIT');
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
        throw failure;
      }
      throw error;
    } finally {
      transaction.active = false;
      client.release(releaseError);
    }
  }

  return {
    withTenant (tenant, fn) {
      return tenantScope.withTenant(tenant, () => run(tenantId(), fn));
    }
    , query (text, values) {
      const tenant = tenantId();
      const transaction = activeTransaction(tenant);
      if (transaction) return transaction.client.query(text, values);
      return run(tenant, () => transactions.getStore().client.query(text, values));
    }
    , withSavepoint (fn) {
      return run(tenantId(), async function () {
        const transaction = transactions.getStore();
        if (transaction.savepointActive) {
          throw new Error('PostgreSQL concurrent or nested savepoint operations are unsupported');
        }
        transaction.savepointActive = true;
        const client = transaction.client;
        const name = 'ns_' + randomUUID().replace(/-/g, '');
        try {
          await client.query('SAVEPOINT ' + name);
          try {
            const result = await fn();
            await client.query('RELEASE SAVEPOINT ' + name);
            return result;
          } catch (error) {
            try {
              await client.query('ROLLBACK TO SAVEPOINT ' + name);
              await client.query('RELEASE SAVEPOINT ' + name);
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
    , end () { return pool.end(); }
  };
};
