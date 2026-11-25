'use strict';

// A serving role's own start and readiness checks (decision
// platform-verification-removal). Three concerns, each answered on the role's
// own connections:
//
//   identity  the serving login cannot bypass row-level security (no
//             SUPERUSER, no BYPASSRLS). This protects isolation, so a refusal
//             is terminal: restarting with the same login cannot help.
//   isolation every tenant-data table the role's catalogues put under row-level
//             security still has it enabled and forced, with each policy the
//             catalogues create on it, and the login is still safe (identity).
//             One catalogue query per login. The expected tables and policies
//             are read from the migration catalogues, not kept by hand. A
//             failure is the same terminal identity code: the database no
//             longer isolates tenants for this login.
//   schema    every migration ledger the role reads is current
//             (lib/migrations/postgres-check.js). The migration Job owns
//             upgrades; a stale ledger is not ready, and boot waits for a
//             restart rather than serving an older schema.
//
// Nothing here compares configuration with a published record, so a
// configuration-only edit (a hostname alias, a new port) never refuses.
const { Client } = require('pg');
const { MigrationError, validateCatalogue, renderMigration } = require('../../migrations/catalogue');
const { connectionOptions, inspect } = require('../../migrations/postgres-check');

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
    // The control ledger as the deployment migrated it: the native catalogue when the deployment
    // selects the native lifecycle (decision legacy-topology-retirement), else the plain one.
    add(config.activity?.connectionString, config.activity?.namespace, config.nativeSelection
      ? require('../../tenant-lifecycle/native-selection').catalogue(config.nativeSelection)
      : require('../../tenant-lifecycle/postgres-candidate.json'));
  }
  return rows;
}

async function identity (config, role) {
  const connectionString = servingConnection(config, role);
  if (typeof connectionString !== 'string') throw fail(IDENTITY_UNSAFE);
  return withClient(connectionString, async client => {
    const row = (await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (!row || row.rolsuper !== false || row.rolbypassrls !== false) throw fail(IDENTITY_UNSAFE);

    // settings-config binds the display login to this database. Check its role
    // attributes here so that raw DATA can start while that login is unavailable.
    const display = role === 'api' && config.tenantSettings?.connectionString;
    if (!display) return false;
    const settings = (await client.query(DISPLAY_IDENTITY, [connectionOptions(display).user])).rows[0];
    // A role provisioned after boot must pass the reader's own screen at open.
    if (!settings) return false;
    if (settings.rolsuper !== false || settings.rolbypassrls !== false || settings.member !== false) throw fail(IDENTITY_UNSAFE);
    return true;
  });
}
const DISPLAY_IDENTITY = 'SELECT r.rolsuper, r.rolbypassrls, EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS member FROM pg_roles r WHERE r.rolname = $1';

// What a catalogue promises about row-level security, replayed from its
// statements in order: {table -> Set(policy)} for each table it leaves with
// FORCE ROW LEVEL SECURITY. Unqualified names live in the ledger's namespace.
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const NAME = IDENT + String.raw`(?:\s*\.\s*` + IDENT + ')?';
const STATEMENTS = new RegExp([
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(` + NAME + String.raw`)\s+(NO\s+FORCE|FORCE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY`,
  String.raw`\b(CREATE|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?(` + IDENT + String.raw`)\s+ON\s+(` + NAME + ')',
  String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(` + NAME + ')'
].join('|'), 'gi');
const unquote = part => part.startsWith('"') ? part.slice(1, -1) : part.toLowerCase();
function qualify (name, namespace) {
  const parts = name.match(new RegExp(IDENT, 'g')).map(unquote);
  return parts.length === 2 ? parts[0] + '.' + parts[1] : namespace + '.' + parts[0];
}
const expectedCache = new WeakMap();
function isolationExpected (namespace, catalogue) {
  if (!expectedCache.has(catalogue)) expectedCache.set(catalogue, new Map());
  const byNamespace = expectedCache.get(catalogue);
  if (byNamespace.has(namespace)) return byNamespace.get(namespace);
  const forced = new Set(), policies = new Map();
  const policiesOf = table => { if (!policies.has(table)) policies.set(table, new Set()); return policies.get(table); };
  for (const migration of validateCatalogue(catalogue)) {
    for (const sql of renderMigration(migration, namespace)) {
      for (const m of sql.matchAll(STATEMENTS)) {
        if (m[1]) {
          const table = qualify(m[1], namespace);
          if (/^FORCE$/i.test(m[2])) forced.add(table); else forced.delete(table);
        } else if (m[3]) {
          const table = qualify(m[5], namespace), policy = unquote(m[4]);
          if (/^CREATE$/i.test(m[3])) policiesOf(table).add(policy); else policiesOf(table).delete(policy);
        } else {
          const table = qualify(m[6], namespace);
          forced.delete(table); policies.delete(table);
        }
      }
    }
  }
  const rows = [...forced].map(table => ({ table, policies: [...(policies.get(table) || [])].sort() }));
  byNamespace.set(namespace, rows);
  return rows;
}

// One query: the login's attributes, the expected tables that exist without
// enabled and forced row-level security, and expected policies that are
// missing. A table that does not exist yet holds no tenant data; the ledger
// check (/healthz/schema) reports it. While a ledger is stale (this build ahead
// of the migration Job), a policy that a pending migration adds to an existing
// table reads as missing here; boot runs schema first, so it waits instead.
const ISOLATION_SQL = `SELECT r.rolsuper, r.rolbypassrls,
  (SELECT coalesce(array_agg(t.ns || '.' || t.rel ORDER BY 1), '{}') FROM unnest($1::text[], $2::text[]) AS t(ns, rel)
     JOIN pg_namespace s ON s.nspname = t.ns JOIN pg_class c ON c.relnamespace = s.oid AND c.relname = t.rel
     WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)) AS unforced,
  (SELECT coalesce(array_agg(p.ns || '.' || p.rel || ':' || p.pol ORDER BY 1), '{}') FROM unnest($3::text[], $4::text[], $5::text[]) AS p(ns, rel, pol)
     JOIN pg_namespace s ON s.nspname = p.ns JOIN pg_class c ON c.relnamespace = s.oid AND c.relname = p.rel
     WHERE NOT EXISTS (SELECT 1 FROM pg_policy q WHERE q.polrelid = c.oid AND q.polname = p.pol)) AS missing
  FROM pg_roles r WHERE r.rolname = current_user`;

// Identity plus forced row-level security, one query per distinct login. The
// serving login is always asked, for its identity, even when no ledger uses it.
async function isolation (config, role) {
  const serving = servingConnection(config, role);
  if (typeof serving !== 'string') throw fail(IDENTITY_UNSAFE);
  const byConnection = new Map([[serving, []]]);
  for (const row of ledgers(config, role)) {
    if (!byConnection.has(row.connectionString)) byConnection.set(row.connectionString, []);
    byConnection.get(row.connectionString).push(...isolationExpected(row.namespace, row.catalogue));
  }
  const unsafe = [];
  for (const [connectionString, expected] of byConnection) {
    const tables = new Map();
    for (const { table, policies } of expected) tables.set(table, new Set([...(tables.get(table) || []), ...policies]));
    const split = name => [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
    const t = [...tables.keys()].map(split), p = [];
    for (const [table, policies] of tables) for (const policy of policies) p.push([...split(table), policy]);
    const row = await withClient(connectionString, async client => (await client.query(ISOLATION_SQL,
      [t.map(x => x[0]), t.map(x => x[1]), p.map(x => x[0]), p.map(x => x[1]), p.map(x => x[2])])).rows[0]);
    if (!row || (connectionString === serving && (row.rolsuper !== false || row.rolbypassrls !== false))) unsafe.push('login');
    if (row) unsafe.push(...row.unforced, ...row.missing);
  }
  if (unsafe.length) throw Object.assign(fail(IDENTITY_UNSAFE), { unsafe });
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

// Boot: identity first (terminal), then the ledgers, then forced row-level
// security on the tables the now-current ledgers created. Isolation follows
// schema so that a ledger the migration Job has not brought current waits
// (MIG_STALE) instead of refusing as unsafe.
async function admit (config, role) {
  const displayRoleAdmitted = await identity(config, role);
  await schema(config, role);
  await isolation(config, role);
  return { displayRoleAdmitted };
}

module.exports = { TERMINAL, IDENTITY_UNSAFE, keeps, servingConnection, ledgers, identity, isolationExpected, isolation, schema, admit };
