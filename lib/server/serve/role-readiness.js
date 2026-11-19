'use strict';

// A serving role's own start and readiness checks (decision
// platform-verification-removal). Two concerns, each answered on the role's
// own connections:
//
//   identity  the serving login cannot bypass row-level security (no
//             SUPERUSER, no BYPASSRLS). This protects isolation, so a refusal
//             is terminal: restarting with the same login cannot help.
//   schema    every migration ledger the role reads is current
//             (lib/migrations/postgres-check.js). The migration Job owns
//             upgrades; a stale ledger is not ready, and boot waits for a
//             restart rather than serving an older schema.
//
// Nothing here compares configuration with a published record, so a
// configuration-only edit (a hostname alias, a new port) never refuses.
const { Client } = require('pg');
const { MigrationError, validateCatalogue } = require('../../migrations/catalogue');
const { inspect } = require('../../migrations/postgres-check');

const IDENTITY_UNSAFE = 'PLATFORM_SERVING_IDENTITY_UNSAFE';
// Codes a role keeps when its start check refuses.
const TERMINAL = Object.freeze([IDENTITY_UNSAFE]);
// A start-check refusal keeps its typed code (exit 1), never a configuration
// refusal: an unsafe login, or a ledger the migration Job has not brought current.
const keeps = error => TERMINAL.includes(error?.code) || error instanceof MigrationError;
const fail = code => Object.assign(new Error(code), { code });

async function withClient (connectionString, run, timeoutMs = 5000) {
  const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs,
    query_timeout: timeoutMs + 1000, application_name: 'nightscout-role-readiness' });
  client.on('error', () => {});
  try { await client.connect(); return await run(client); } finally { await client.end().catch(() => {}); }
}

// The login a role serves with, per role.
function servingConnection (config, role) {
  return role === 'vcpool' ? config.secretsConnectionString : config.connectionString;
}

// [{connectionString, namespace, catalogue}] for every ledger the role reads.
// The api reads its ledgers through its read-only readiness login when one is
// configured; evaluator and realtime through their serving login, which the
// grants already let read each catalogue's schema_migrations.
function ledgers (config, role) {
  const rows = [];
  const add = (connectionString, namespace, catalogue) => { if (connectionString && namespace && catalogue) rows.push({ connectionString, namespace, catalogue }); };
  if (role === 'api') {
    const via = config.readinessConnectionString || config.connectionString;
    for (const [kind, catalogue] of Object.entries(require('./postgres-domains').cataloguesFor(config))) add(via, config.namespaces[kind], catalogue);
  } else if (role === 'evaluator' || role === 'realtime') {
    for (const [kind, catalogue] of Object.entries(require('./evaluator-readiness').cataloguesFor(config))) add(config.connectionString, config.namespaces[kind], catalogue);
  } else if (role === 'vcpool') {
    add(config.activity?.connectionString, config.activity?.namespace, require('../../tenant-lifecycle/postgres-candidate.json'));
  }
  return rows;
}

async function identity (config, role) {
  const connectionString = servingConnection(config, role);
  if (typeof connectionString !== 'string') throw fail(IDENTITY_UNSAFE);
  const row = await withClient(connectionString, async client =>
    (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0]);
  if (!row || row.rolsuper !== false || row.rolbypassrls !== false) throw fail(IDENTITY_UNSAFE);
}

// One client per distinct login, one read-only transaction for its ledgers.
async function schema (config, role) {
  const byConnection = new Map();
  for (const row of ledgers(config, role)) {
    if (!byConnection.has(row.connectionString)) byConnection.set(row.connectionString, []);
    byConnection.get(row.connectionString).push(row);
  }
  const pending = [];
  for (const [connectionString, rows] of byConnection) {
    await withClient(connectionString, async client => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        for (const row of rows) {
          const state = await inspect(client.query.bind(client), { table: '"' + row.namespace + '".schema_migrations', files: validateCatalogue(row.catalogue) });
          if (!state.current) pending.push(row.namespace);
        }
      } finally { await client.query('ROLLBACK').catch(() => {}); }
    });
  }
  if (pending.length) throw new MigrationError('MIG_STALE', 'schema is stale; an operator must run migrate up');
}

// Boot: identity first (terminal), then the ledgers.
async function admit (config, role) {
  await identity(config, role);
  await schema(config, role);
}

module.exports = { TERMINAL, IDENTITY_UNSAFE, keeps, servingConnection, ledgers, identity, schema, admit };
