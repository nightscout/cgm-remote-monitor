'use strict';

const postgresConnection = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const { resolveEffectiveSettings } = require('../tenant-settings/component');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = code => Object.assign(new Error(code), { code });

// Owner settings need current constraints, never operator policy write authority.
module.exports = async function createPostgresOperatorPolicyReader ({ connectionString, namespace }) {
  if (scope.getTenancyMode() !== 'multi' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || ['public', 'information_schema'].includes(namespace) ||
      namespace.startsWith('pg_')) throw new TypeError('Policy reader requires an explicit multitenant namespace');
  let connection;
  try {
    connection = await postgresConnection({ connectionString, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, query_timeout: 5000, application_name: 'nightscout-operator-policy-read' });
  } catch { throw failure('SETTINGS_POLICY_UNAVAILABLE'); }
  const table = '"' + namespace + '".tenant_operator_policy';
  async function transaction (tenant, fn) {
    if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Policy reader requires a canonical tenant');
    try { return await connection.withTenant(tenant, fn); }
    catch { throw failure('SETTINGS_POLICY_UNAVAILABLE'); }
  }
  try {
    const result = await transaction('00000000-0000-0000-0000-000000000000', () => connection.query(`
      SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
        has_table_privilege(c.oid,'SELECT') AS reads,
        has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes
      FROM pg_class c WHERE c.oid=to_regclass($1)`, [table]));
    if (result.rows.length !== 1 || result.rows.some(row => !row.secured || row.owns || !row.reads || row.writes)) {
      throw failure('SETTINGS_POLICY_UNSAFE');
    }
  } catch (error) { await connection.end(); throw error; }
  return Object.freeze({
    async read (tenant) {
      const row = await transaction(tenant, async () => (await connection.query(
        'SELECT generation, policy FROM ' + table + ' WHERE tenant_id=$1', [tenant])).rows[0]);
      if (!row) throw failure('SETTINGS_POLICY_UNAVAILABLE');
      try {
        // Validate the same two-name catalogue; do not convert unknown policy
        // shapes or missing generations into an open deployment policy.
        resolveEffectiveSettings({ version: 1, values: {} }, { ...row.policy, generation: row.generation });
        return { generation: row.generation, policy: structuredClone(row.policy) };
      } catch { throw failure('SETTINGS_POLICY_UNAVAILABLE'); }
    },
    async close () {
      try { await connection.end(); } catch { throw failure('SETTINGS_POLICY_UNAVAILABLE'); }
    }
  });
};
