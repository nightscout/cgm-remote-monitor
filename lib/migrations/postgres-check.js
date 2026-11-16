'use strict';

// Internal validated catalogue engine. The caller owns its read-only transaction
// and supplies only a bounded SELECT function, never a borrowed pg Client.
const { MigrationError, validateCatalogue } = require('./catalogue');

function connectionOptions (connectionString) {
  let url;
  try { url = new URL(connectionString); } catch {
    throw new MigrationError('MIG_CONNECTION', 'an explicit PostgreSQL connection URL is required');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 ||
      (url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode')))) {
    throw new MigrationError('MIG_CONNECTION', 'connection URL must specify host, user, password and database; only sslmode=disable or verify-full is supported');
  }
  return {
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
    };
}

function options (opts) {
  if (!opts || opts.direct !== true) {
    throw new MigrationError('MIG_DIRECT', 'an operator-attested direct PostgreSQL connection is required; transaction poolers are unsupported');
  }
  const connection = connectionOptions(opts.connectionString);
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
    connection,
    files: validateCatalogue(opts.catalogue),
    table: '"' + opts.namespace + '".schema_migrations',
    waitMs: opts.waitMs === undefined ? 30000 : opts.waitMs,
    statementTimeoutMs: opts.statementTimeoutMs === undefined ? 60000 : opts.statementTimeoutMs
  };
}

async function inspect (query, opts) {
  const found = await query('SELECT to_regclass($1) IS NOT NULL AS present', [opts.table]);
  const rows = found.rows[0].present
    ? (await query('SELECT name, checksum FROM ' + opts.table + ' ORDER BY name COLLATE "C"')).rows : [];
  // This exact reviewed size operation is independent of optional ordering
  // conversion. All other applied history must remain an immutable prefix.
  const size = file => file.operation?.kind === 'clinical-storage-size-v1' &&
    file.name === '0099_' + file.operation.domain + '_storage_bytes' || file.operation?.kind === 'storage-event-identity-v1' && file.name === '0100_' + file.operation.domain + '_storage_identity';
  const seen = new Set();
  for (const row of rows) {
    const file = opts.files.find(m => m.name === row.name);
    if (!file) throw new MigrationError('MIG_UNKNOWN', 'an applied migration is unknown to the reviewed catalogue');
    if (file.checksum !== row.checksum) throw new MigrationError('MIG_DRIFT', 'applied migration checksum drift: ' + row.name);
    if (seen.has(row.name)) throw new MigrationError('MIG_HISTORY', 'duplicate applied migration');
    seen.add(row.name);
  }
  const ordinary = opts.files.filter(file => !size(file));
  const appliedOrdinary = rows.filter(row => !size(opts.files.find(file => file.name === row.name)));
  if (rows.length && !appliedOrdinary.length || appliedOrdinary.some((row,index) => ordinary[index]?.name !== row.name)) {
    throw new MigrationError('MIG_HISTORY', 'applied migrations are not a catalogue prefix');
  }
  const applied = rows.map(row => row.name);
  const pending = opts.files.filter(file => !seen.has(file.name)).map(file => file.name);
  return { current: pending.length === 0, applied, pending };
}

module.exports = { options, inspect, connectionOptions };
