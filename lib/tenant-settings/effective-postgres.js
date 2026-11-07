'use strict';

const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const { run } = require('../migrations/postgres');
const { resolveEffectiveSettings } = require('./component');
const failure = code => Object.assign(new Error(code), { code });

// Presentation-only read capability: never supplies a storage/write environment,
// owner actor or credential authority. Both inputs come from one SQL snapshot.
module.exports = async function effectiveSettings ({ connectionString, namespaces }) {
  const valid = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name) &&
    !['public', 'information_schema'].includes(name) && !name.startsWith('pg_');
  if (scope.getTenancyMode() !== 'multi' || !namespaces || !valid(namespaces.settings) ||
      !valid(namespaces.operatorPolicy) || namespaces.settings === namespaces.operatorPolicy) throw new TypeError('Explicit settings read namespaces required');
  await require('./readiness')({ connectionString });
  for (const [kind, catalogue] of Object.entries({ settings: require('./postgres-candidate.json'),
    operatorPolicy: require('../operator-policy/postgres-candidate.json') })) {
    await run('check', { direct: true, connectionString, namespace: namespaces[kind], catalogue, statementTimeoutMs: 5000 });
  }
  const connection = await connect({ connectionString, max: 4, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 5000, application_name: 'nightscout-display-settings' });
  const settings = '"' + namespaces.settings + '".tenant_settings';
  const policy = '"' + namespaces.operatorPolicy + '".tenant_operator_policy';
  try {
    const rows = await connection.withTenant('00000000-0000-0000-0000-000000000000', async () =>
      (await connection.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user,c.relowner,'MEMBER') AS owns, has_table_privilege(c.oid,'SELECT') AS reads,
        has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes
        FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [[settings, policy]])).rows);
    if (rows.length !== 2 || rows.some(row => !row.secured || row.owns || !row.reads || row.writes)) throw failure('SETTINGS_STORE_UNSAFE');
  } catch (error) { await connection.end(); throw error; }
  return Object.freeze({
    async read (tenant) {
      if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) throw new TypeError('Canonical settings tenant required');
      try {
        return await connection.withTenant(tenant, async () => {
          const row = (await connection.query(`SELECT s.version,s.values,p.generation,p.policy FROM ${settings} s
            JOIN ${policy} p ON p.tenant_id=s.tenant_id WHERE s.tenant_id=$1`, [tenant])).rows[0];
          if (!row) throw failure('SETTINGS_POLICY_UNAVAILABLE');
          return resolveEffectiveSettings({ version: row.version, values: row.values }, { ...row.policy, generation: row.generation });
        });
      } catch { throw failure('SETTINGS_POLICY_UNAVAILABLE'); }
    },
    close () { return connection.end(); }
  });
};
