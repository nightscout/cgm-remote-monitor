'use strict';

const POOL_MAX = 4;
const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const { options, inspect } = require('../migrations/postgres-check');
const { MigrationError } = require('../migrations/catalogue');
const readinessCheck = require('./readiness-check');
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
  const connection = await connect({ connectionString, direct: true, displaySettings: true,
    max: POOL_MAX, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
    application_name: 'nightscout-display-settings' });
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
  return Object.freeze({
    // Guards and values share one owned READ ONLY snapshot on EVERY read.
    async read (tenant, { signal } = {}) {
      if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) throw new TypeError('Canonical settings tenant required');
      validate();
      signal?.throwIfAborted();
      return connection.readOnlySnapshot(tenant, async ({ query }) => {
        await screen(query);
        signal?.throwIfAborted();
        const row = (await query(`SELECT s.version,s.values,p.generation,p.policy FROM ${settings} s
          JOIN ${policy} p ON p.tenant_id=s.tenant_id WHERE s.tenant_id=$1`, [tenant])).rows[0];
        if (!row) throw failure('SETTINGS_POLICY_UNAVAILABLE');
        return resolveEffectiveSettings({ version: row.version, values: row.values }, { ...row.policy, generation: row.generation });
      });
    },
    close () { return connection.end(); }
  });
};

module.exports.POOL_MAX = POOL_MAX;
