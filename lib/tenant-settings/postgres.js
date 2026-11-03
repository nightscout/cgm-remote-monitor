'use strict';

const postgresConnection = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = async function createPostgresTenantSettings ({ connectionString, namespace }) {
  if (scope.getTenancyMode() !== 'multi' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Settings require explicit multi mode and a non-system namespace');
  }
  let connection;
  try {
    connection = await postgresConnection({
      connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
      application_name: 'nightscout-tenant-settings'
    });
  } catch { throw failure('SETTINGS_STORE_UNAVAILABLE'); }
  const table = '"' + namespace + '".tenant_settings';
  const history = '"' + namespace + '".tenant_settings_history';
  async function transaction (tenant, fn) {
    if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) {
      throw new TypeError('Settings require a canonical UUID tenant');
    }
    try {
      return await connection.withTenant(tenant, async () => {
        await connection.query("SET LOCAL synchronous_commit = 'on'");
        return fn();
      });
    } catch { throw failure('SETTINGS_STORE_UNAVAILABLE'); }
  }
  try {
    const result = await transaction('00000000-0000-0000-0000-000000000000', () => connection.query(`
      SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AS reads,
        has_table_privilege(c.oid, 'INSERT') AS inserts,
        has_table_privilege(c.oid, 'UPDATE') AS updates,
        has_table_privilege(c.oid, 'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS mutates,
        has_any_column_privilege(c.oid, 'UPDATE') AS column_updates,
        c.oid = to_regclass($1) AS current_state
      FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2))`, [table, history]));
    if (result.rows.length !== 2 || result.rows.some(row => !row.secured || row.owns ||
        !row.inserts || !row.reads || row.mutates || row.updates !== row.current_state ||
        row.column_updates !== row.current_state)) throw failure('SETTINGS_STORE_UNSAFE');
  } catch (error) {
    await connection.end();
    throw error;
  }
  return Object.freeze({
    async read (tenant) {
      return transaction(tenant, async () => (await connection.query(
        'SELECT version, values FROM ' + table + ' WHERE tenant_id = $1', [tenant])).rows[0]);
    },
    async history (tenant, target) {
      return transaction(tenant, async () => (await connection.query(
        'SELECT version, values FROM ' + history + ' WHERE tenant_id = $1 AND version = $2', [tenant, target])).rows[0]);
    },
    async write (actor, expectedVersion, values, operation, restoredFrom) {
      return transaction(actor.tenant, async () => {
        const result = expectedVersion === 0
          ? await connection.query('INSERT INTO ' + table +
            ' (tenant_id, version, values) VALUES ($1,1,$2) ON CONFLICT DO NOTHING RETURNING version, values',
          [actor.tenant, JSON.stringify(values)])
          : await connection.query('UPDATE ' + table +
            ' SET version = version + 1, values = $3 WHERE tenant_id = $1 AND version = $2 RETURNING version, values',
          [actor.tenant, expectedVersion, JSON.stringify(values)]);
        const state = result.rows[0];
        if (!state) return undefined;
        await connection.query('INSERT INTO ' + history +
          ' (tenant_id,version,values,principal,consumer,operation,event_time,restored_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [actor.tenant, state.version, JSON.stringify(values), actor.principal, actor.consumer, operation,
          Date.now(), restoredFrom === undefined ? null : restoredFrom]);
        return state;
      });
    },
    async close () {
      try { await connection.end(); } catch { throw failure('SETTINGS_STORE_UNAVAILABLE'); }
    }
  });
};
