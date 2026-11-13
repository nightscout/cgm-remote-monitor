'use strict';

const crypto = require('node:crypto');
const { Client } = require('pg');
const { Umzug } = require('umzug');
const { MigrationError, validateCatalogue, renderMigration } = require('./catalogue');

function options (opts) {
  if (!opts || opts.direct !== true) {
    throw new MigrationError('MIG_DIRECT', 'an operator-attested direct PostgreSQL connection is required; transaction poolers are unsupported');
  }
  let url;
  try { url = new URL(opts.connectionString); } catch {
    throw new MigrationError('MIG_CONNECTION', 'an explicit PostgreSQL connection URL is required');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 ||
      (url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode')))) {
    throw new MigrationError('MIG_CONNECTION', 'connection URL must specify host, user, password and database; only sslmode=disable or verify-full is supported');
  }
  if (typeof opts.namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(opts.namespace) ||
      opts.namespace === 'public' || opts.namespace.startsWith('pg_') || opts.namespace === 'information_schema') {
    throw new MigrationError('MIG_NAMESPACE', 'an explicit non-system migration namespace is required');
  }
  for (const key of ['waitMs', 'statementTimeoutMs']) {
    if (opts[key] !== undefined && (!Number.isSafeInteger(opts[key]) || opts[key] < 1 || opts[key] > 600000)) {
      throw new MigrationError('MIG_OPTIONS', 'migration timeouts must be integers between 1 and 600000 milliseconds');
    }
  }
  return {
    ...opts,
    connection: {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 5432,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: url.searchParams.get('sslmode') === 'verify-full' ? { rejectUnauthorized: true } : false,
      sslnegotiation: 'postgres',
      client_encoding: 'UTF8',
      replication: 'false',
      options: '-c search_path=pg_catalog',
      // Explicit defaults prevent ambient PG* variables changing this job.
      fallback_application_name: 'nightscout-operator-migrations'
    },
    files: validateCatalogue(opts.catalogue),
    table: '"' + opts.namespace + '".schema_migrations',
    waitMs: opts.waitMs === undefined ? 30000 : opts.waitMs,
    statementTimeoutMs: opts.statementTimeoutMs === undefined ? 60000 : opts.statementTimeoutMs
  };
}

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

async function inspect (client, opts) {
  const found = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [opts.table]);
  const rows = found.rows[0].present
    ? (await client.query('SELECT name, checksum FROM ' + opts.table + ' ORDER BY name COLLATE "C"')).rows : [];
  for (const [index, row] of rows.entries()) {
    const file = opts.files.find(m => m.name === row.name);
    if (!file) throw new MigrationError('MIG_UNKNOWN', 'an applied migration is unknown to the reviewed catalogue');
    if (file.checksum !== row.checksum) throw new MigrationError('MIG_DRIFT', 'applied migration checksum drift: ' + row.name);
    if (opts.files[index].name !== row.name) throw new MigrationError('MIG_HISTORY', 'applied migrations are not a catalogue prefix');
  }
  const applied = rows.map(row => row.name);
  const pending = opts.files.slice(rows.length).map(m => m.name);
  return { current: pending.length === 0, applied, pending };
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
  const client = new Client({
    ...opts.connection,
    application_name: 'nightscout-operator-migrations',
    connectionTimeoutMillis: 10000,
    statement_timeout: opts.statementTimeoutMs
  });
  try {
    await client.connect();
    if (action === 'up') return await up(client, opts);
    const state = await transaction(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', () => inspect(client, opts));
    if (action === 'check' && !state.current) throw new MigrationError('MIG_STALE', 'schema is stale; an operator must run migrate up');
    return state;
  } finally {
    await client.end();
  }
}

module.exports = { run };
