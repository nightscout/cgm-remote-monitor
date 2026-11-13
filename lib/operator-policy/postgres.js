'use strict';

const postgresConnection = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const lockTenantPolicy = require('./fence');

function failure (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = async function createPostgresOperatorPolicy ({ connectionString, namespace }) {
  if (scope.getTenancyMode() !== 'multi' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || namespace === 'public' ||
      namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Operator policy requires explicit multi mode and a non-system namespace');
  }
  let connection;
  try {
    connection = await postgresConnection({
      connectionString, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
      application_name: 'nightscout-operator-policy'
    });
  } catch { throw failure('OPERATOR_POLICY_STORE_UNAVAILABLE'); }
  const table = '"' + namespace + '".tenant_operator_policy';
  async function transaction (tenant, fn) {
    if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) {
      throw new TypeError('Operator policy requires a canonical UUID tenant');
    }
    try {
      return await connection.withTenant(tenant, async () => {
        await connection.query("SET LOCAL synchronous_commit = 'on'");
        return fn();
      });
    } catch { throw failure('OPERATOR_POLICY_STORE_UNAVAILABLE'); }
  }
  try {
    const result = await transaction('00000000-0000-0000-0000-000000000000', () => connection.query(`
      SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AS reads,
        has_table_privilege(c.oid, 'INSERT') AS inserts,
        has_table_privilege(c.oid, 'UPDATE') AS updates,
        has_table_privilege(c.oid, 'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS mutates,
        has_any_column_privilege(c.oid, 'UPDATE') AS column_updates
      FROM pg_class c WHERE c.oid = to_regclass($1)`, [table]));
    if (result.rows.length !== 1 || !result.rows[0].secured || result.rows[0].owns ||
        !result.rows[0].reads || !result.rows[0].inserts || !result.rows[0].updates ||
        result.rows[0].mutates || !result.rows[0].column_updates) {
      throw failure('OPERATOR_POLICY_STORE_UNSAFE');
    }
  } catch (error) {
    await connection.end();
    throw error;
  }
  return Object.freeze({
    async read (tenant) {
      return transaction(tenant, async () => (await connection.query(
        'SELECT generation, policy, principal, consumer, event_time FROM ' + table + ' WHERE tenant_id = $1',
      [tenant])).rows[0]);
    },
    async write (actor, expectedGeneration, policy) {
      return transaction(actor.tenant, async () => {
        await lockTenantPolicy(connection, actor.tenant);
        const result = expectedGeneration === 0
          ? await connection.query('INSERT INTO ' + table +
            ' (tenant_id, generation, policy, principal, consumer, event_time) VALUES ($1,1,$2,$3,$4,$5) ' +
            'ON CONFLICT DO NOTHING RETURNING generation, policy, principal, consumer, event_time',
          [actor.tenant, JSON.stringify(policy), actor.principal, actor.consumer, Date.now()])
          : await connection.query('UPDATE ' + table +
            ' SET generation = generation + 1, policy = $3, principal = $4, consumer = $5, event_time = $6 ' +
            'WHERE tenant_id = $1 AND generation = $2 RETURNING generation, policy, principal, consumer, event_time',
          [actor.tenant, expectedGeneration, JSON.stringify(policy), actor.principal, actor.consumer, Date.now()]);
        return result.rows[0];
      });
    },
    async close () {
      try { await connection.end(); } catch { throw failure('OPERATOR_POLICY_STORE_UNAVAILABLE'); }
    }
  });
};
