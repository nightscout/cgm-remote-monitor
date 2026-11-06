'use strict';

// Explicit PostgreSQL preview composition. Domain metadata has no backend imports.
const { Client } = require('pg');
const { run } = require('../../migrations/postgres');
const domains = require('../tenant-app/domain-catalogue');
const loaders = Object.freeze({
  entries: () => [require('../tenant-app/entries'), require('../../../migrations/candidates/postgres-entries-v1.json')],
  treatments: () => [require('../tenant-app/treatments'), require('../../../migrations/candidates/postgres-treatments-v1.json')],
  devicestatus: () => [require('../tenant-app/devicestatus'), require('../../../migrations/candidates/postgres-devicestatus-v1.json')],
  profile: () => [require('../tenant-app/profile'), require('../../../migrations/candidates/postgres-profile-v1.json')],
  food: () => [require('../tenant-app/food'), require('../../../migrations/candidates/postgres-food-v1.json')],
  activity: () => [require('../tenant-app/activity'), require('../../../migrations/candidates/postgres-activity-v1.json')],
  settings: () => [require('../tenant-app/settings'), require('../../../migrations/candidates/postgres-settings-v1.json')]
});

function get (logical) {
  domains.get(logical);
  const [factory, catalogue] = loaders[logical]();
  return { factory, catalogue };
}

const CATALOGUES = {
  entries: require('../../../migrations/candidates/postgres-entries-v1.json'),
  authorization: require('../../tenant-authorization/postgres-candidate.json'),
  secrets: require('../../secrets/postgres-candidate.json'),
  legacy: require('../../secrets/legacy-credentials-candidate.json')
};

async function readiness (config) {
  const client = new Client({
    connectionString: config.readinessConnectionString,
    connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'nightscout-preview-readiness'
  });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const role = (await client.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
      FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (!role || Object.values(role).some(Boolean)) throw new Error('unsafe readiness identity');
    for (const namespace of Object.values(config.namespaces)) {
      const state = await client.query(`SELECT
        has_schema_privilege($1, 'CREATE') AS creates,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND
          (pg_has_role(current_user, c.relowner, 'MEMBER') OR
           has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES'))) AS mutates`, [namespace]);
      if (state.rows[0].creates || state.rows[0].mutates) throw new Error('unsafe readiness privileges');
    }
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  const catalogues = { ...CATALOGUES };
  if (config.writeClock) catalogues.clock = require('../../../migrations/candidates/postgres-write-clock-v1.json');
  if (config.accessTokens) catalogues.access = require('../../tenant-authorization/access-candidate.json');
  for (const logical of config.domains) catalogues[logical] = get(logical).catalogue;
  for (const [kind, catalogue] of Object.entries(catalogues)) {
    await run('check', {
      direct: true, connectionString: config.readinessConnectionString,
      namespace: config.namespaces[kind], catalogue, statementTimeoutMs: 5000
    });
  }
}

async function assertServing (config, connection) {
  await connection.withTenant('00000000-0000-0000-0000-000000000000', async () => {
    const roles = await connection.query(`SELECT rolcreaterole, rolcreatedb, rolreplication
      FROM pg_roles WHERE rolname = current_user`);
    if (!roles.rows[0] || Object.values(roles.rows[0]).some(Boolean)) throw new Error('unsafe serving identity');
    for (const namespace of Object.values(config.namespaces)) {
      const privilege = await connection.query("SELECT has_schema_privilege($1, 'CREATE') AS creates", [namespace]);
      if (privilege.rows[0].creates) throw new Error('unsafe serving schema privileges');
    }
    for (const logical of config.domains) {
      const result = await connection.query(`SELECT
        c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AND has_table_privilege(c.oid, 'INSERT') AND
          has_table_privilege(c.oid, 'UPDATE') AND has_table_privilege(c.oid, 'DELETE') AS serves,
        has_table_privilege(c.oid, 'TRUNCATE,REFERENCES,TRIGGER') AS extra
        FROM pg_class c WHERE c.oid = to_regclass($1)`, [config.namespaces[logical] + '.' + logical]);
      if (result.rows.length !== 1 || !result.rows[0].secured || result.rows[0].owns ||
          !result.rows[0].serves || result.rows[0].extra) throw new Error('unsafe domain privileges');
    }
    if (config.writeClock) {
      const clock = await connection.query(`SELECT
        c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AND has_column_privilege(c.oid, 'last_stamp', 'UPDATE') AS serves,
        has_table_privilege(c.oid, 'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          has_any_column_privilege(c.oid, 'INSERT,REFERENCES') OR
          has_column_privilege(c.oid, 'tenant_id', 'UPDATE') AS extra
        FROM pg_class c WHERE c.oid = to_regclass($1)`, [config.namespaces.clock + '.tenant_write_clock']);
      if (clock.rows.length !== 1 || !clock.rows[0].secured || clock.rows[0].owns ||
          !clock.rows[0].serves || clock.rows[0].extra) throw new Error('unsafe write clock privileges');
    }
  });
  if (config.writeClock) {
    for (const tenant of config.bindings.keys()) {
      await connection.withTenant(tenant, async () => {
        // One statement snapshot: a concurrent compliant commit cannot make
        // the floor look older than its data by landing between two reads.
        const maxima = config.domains.map(logical => 'SELECT MAX("srvModified") AS value FROM "' +
          config.namespaces[logical] + '"."' + logical + '" WHERE "srvModified" >= 0 AND "srvModified" < 8640000000000000');
        const result = await connection.query('SELECT last_stamp, (SELECT CEIL(MAX(value)) FROM (' +
          maxima.join(' UNION ALL ') + ') domain_maxima) AS stored_max FROM "' + config.namespaces.clock +
          '".tenant_write_clock WHERE tenant_id = $1', [tenant]);
        const row = result.rows[0];
        if (result.rows.length !== 1 || !Number.isSafeInteger(Number(row.last_stamp)) || Number(row.last_stamp) < 0 ||
            Number(row.last_stamp) >= 8640000000000000 ||
            (row.stored_max !== null && Number(row.last_stamp) < Number(row.stored_max))) {
          throw new Error('missing or stale tenant write clock floor');
        }
      });
    }
  }
}

module.exports = { get, readiness, assertServing };
