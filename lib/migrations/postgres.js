'use strict';

const connectionAdmission = require('../storage/connection-admission');

const crypto = require('node:crypto');
const { Client } = require('pg');
const PostgresCleanupError = require('../storage/postgres-cleanup-error');
const { Umzug } = require('umzug');
const { MigrationError, renderMigration } = require('./catalogue');

const { options, inspect: inspectCatalogue } = require('./postgres-check');

async function transaction (client, begin, fn) {
  await client.query(begin);
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      // Neither failure is hidden, but the CLI never prints driver messages.
      throw new globalThis.AggregateError([error, rollbackError], 'migration and rollback failed');
    }
    throw error;
  }
}

function inspect (client, opts) {
  return inspectCatalogue(client.query.bind(client), opts);
}

async function lock (client, opts) {
  // Advisory keys are database-local and namespace-specific. This Client is
  // never a Pool: the session lock, migration and ledger share one connection.
  const key = BigInt.asIntN(64, BigInt('0x' + crypto.createHash('sha256')
    .update('nightscout:migrations:' + opts.namespace).digest('hex').slice(0, 16))).toString();
  const deadline = Date.now() + opts.waitMs;
  let acquired;
  do {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]);
    acquired = result.rows[0].acquired;
    if (!acquired) {
      if (Date.now() >= deadline) throw new MigrationError('MIG_LOCK_TIMEOUT', 'migration advisory lock deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
  } while (!acquired);
  return async () => {
    const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS released', [key]);
    if (!result.rows[0].released) throw new MigrationError('MIG_LOCK_LOST', 'migration advisory lock was not held');
  };
}

async function up (client, opts) {
  const release = await lock(client, opts);
  try {
    await transaction(client, 'BEGIN', async () => {
      await client.query('CREATE SCHEMA IF NOT EXISTS "' + opts.namespace + '"');
      await client.query('CREATE TABLE IF NOT EXISTS ' + opts.table + ' (' +
        'name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    });
    await inspect(client, opts);
    const runner = new Umzug({
      logger: undefined,
      migrations: opts.files.map(m => ({
        name: m.name,
        up: async () => transaction(client, 'BEGIN', async () => {
          await client.query('SET LOCAL search_path TO "' + opts.namespace + '", pg_catalog');
          for (const text of renderMigration(m, opts.namespace)) await client.query({ text, queryMode: 'extended' });
          await client.query('INSERT INTO ' + opts.table + ' (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
        })
      })),
      storage: {
        executed: async () => (await inspect(client, opts)).applied,
        // The adapter deliberately records inside up's transaction, not here.
        logMigration: async () => {},
        unlogMigration: async () => { throw new MigrationError('MIG_UNSUPPORTED', 'rollback is not enabled'); }
      }
    });
    const done = (await runner.up()).map(m => m.name);
    return { ...await inspect(client, opts), done };
  } finally {
    await release();
  }
}

async function run (action, input) {
  if (!['up', 'status', 'check'].includes(action)) {
    throw new MigrationError('MIG_UNSUPPORTED', 'supported migration actions are up, status and check; rollback is not enabled');
  }
  const opts = options(input);
  // Do not reuse the application pool, DATABASE_URL, PGHOST or serving identity.
  const client = new (connectionAdmission.wrapClient(Client, 'migration-direct'))({
    ...opts.connection,
    application_name: 'nightscout-operator-migrations',
    connectionTimeoutMillis: 10000,
    statement_timeout: opts.statementTimeoutMs
  });
  let outcome;
  try {
    await client.connect();
    if (action === 'up') outcome = { value: await up(client, opts) };
    else {
      const state = await transaction(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', () => inspect(client, opts));
      if (action === 'check' && !state.current) throw new MigrationError('MIG_STALE', 'schema is stale; an operator must run migrate up');
      outcome = { value: state };
    }
  } catch (error) { outcome = { error }; }
  // Cleanup uncertainty takes precedence while preserving the primary cause.
  // Throw after cleanup, rather than overriding control flow from a finally.
  try { await client.end(); } catch (cleanupError) { throw new PostgresCleanupError(outcome.error || cleanupError, cleanupError); }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

module.exports = { run };
