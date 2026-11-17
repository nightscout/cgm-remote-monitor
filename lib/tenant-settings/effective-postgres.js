'use strict';

const POOL_MAX = 4;
// Decision trusted-worker-performance-boundary (clarified 2026-11-17): no
// integrity screen runs inside a tenant read or is triggered by one. The
// screen runs when this capability opens (startup, and the reopen after a
// failed read or a datastore recovery) and when its owner calls check() from
// its readiness/recovery path. A read is one READ ONLY snapshot and its value.
const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const { options, inspect } = require('../migrations/postgres-check');
const { MigrationError } = require('../migrations/catalogue');
const readinessCheck = require('./readiness-check');
const PostgresCleanupError = require('../storage/postgres-cleanup-error');
const { resolveEffectiveSettings } = require('./component');
const failure = code => Object.assign(new Error(code), { code });

// Presentation-only read capability: never supplies a storage/write environment,
// owner actor or credential authority. Both inputs come from one SQL snapshot.
module.exports = async function effectiveSettings ({ connectionString, namespaces: inputNamespaces }) {
  const namespaces = inputNamespaces && Object.freeze({ ...inputNamespaces });
  const valid = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name) &&
    !['public', 'information_schema'].includes(name) && !name.startsWith('pg_');
  function validate () {
    if (scope.getTenancyMode() !== 'multi' || !namespaces || !valid(namespaces.settings) ||
        !valid(namespaces.operatorPolicy) || namespaces.settings === namespaces.operatorPolicy) throw new TypeError('Explicit settings read namespaces required');
  }
  validate();
  const catalogueInputs = () => Object.entries({ settings: require('./postgres-candidate.json'),
    operatorPolicy: require('../operator-policy/postgres-candidate.json') }).map(([kind, catalogue]) =>
    options({ direct: true, connectionString, namespace: namespaces[kind], catalogue, statementTimeoutMs: 5000 }));
  // The same explicit URL/SSL/PG-default contract as public migration checks.
  catalogueInputs();
  const settings = '"' + namespaces.settings + '".tenant_settings';
  const policy = '"' + namespaces.operatorPolicy + '".tenant_operator_policy';
  async function screen (query) {
    await readinessCheck(query);
    for (const opts of catalogueInputs()) {
      const state = await inspect(query, opts);
      if (!state.current) throw new MigrationError('MIG_STALE', 'schema is stale; an operator must run migrate up');
    }
    const rows = (await query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owns, has_table_privilege(c.oid,'SELECT') AS reads,
      has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes
      FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [[settings, policy]])).rows;
    if (rows.length !== 2 || rows.some(row => !row.secured || row.owns || !row.reads || row.writes)) throw failure('SETTINGS_STORE_UNSAFE');
  }
  const connection = await connect({ connectionString, direct: true, displaySettings: true,
    max: POOL_MAX, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
    application_name: 'nightscout-display-settings' });
  // Each catalogue SELECT runs in its own READ ONLY transaction on this pool,
  // so the screen checks the same endpoint and identity the reads use.
  const check = () => screen((text, values) => connection.readOnly(text, values));
  // Startup fails fast: an unsafe or stale store never yields a capability.
  try { await check(); }
  catch (error) {
    try { await connection.end(); } catch (cleanupError) { throw new PostgresCleanupError(error, cleanupError); }
    throw error;
  }
  return Object.freeze({
    // Tenant scope, the operation-window guard and READ ONLY are enforced by
    // readOnlySnapshot; the read itself sends only the value SELECT.
    async read (tenant, { signal } = {}) {
      if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) throw new TypeError('Canonical settings tenant required');
      validate();
      signal?.throwIfAborted();
      return connection.readOnlySnapshot(tenant, async ({ query }) => {
        const row = (await query(`SELECT s.version,s.values,p.generation,p.policy FROM ${settings} s
          JOIN ${policy} p ON p.tenant_id=s.tenant_id WHERE s.tenant_id=$1`, [tenant])).rows[0];
        if (!row) throw failure('SETTINGS_POLICY_UNAVAILABLE');
        return resolveEffectiveSettings({ version: row.version, values: row.values }, { ...row.policy, generation: row.generation });
      });
    },
    // The owner's readiness/recovery screen, outside any tenant read.
    check,
    close () { return connection.end(); }
  });
};

module.exports.POOL_MAX = POOL_MAX;
