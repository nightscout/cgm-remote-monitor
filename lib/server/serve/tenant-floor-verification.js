'use strict';

// Tenant DATA postconditions belong to admin. API admission reads only this
// recorded result, never MAX(doc), insertion tables or encrypted root storage.
const { Client } = require('pg');
const connect = require('../../storage/postgres-connection');
const platform = require('./platform-verification');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const q = name => '"' + name.replaceAll('"', '""') + '"';
const fail = code => Object.assign(new Error(code), { code, status: 503, retryAfter: 1 });
const validTenant = tenant => { if (!UUID.test(tenant || '')) throw fail('TENANT_FLOOR_VERIFICATION_CONFIG'); return tenant; };
const schema = namespace => { if (!NAME.test(namespace || '') || namespace.startsWith('pg_') || ['public', 'information_schema'].includes(namespace)) throw fail('TENANT_FLOOR_VERIFICATION_CONFIG'); return q(namespace); };

const policy = 'tenant_floor_reader';
async function grantReaders (client, table, readers) {
  if (!readers.length) return;
  const names = readers.map(q).join(',');
  await client.query('CREATE POLICY ' + policy + ' ON ' + table + ' FOR SELECT TO ' + names + " USING(tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid)");
  await client.query('GRANT SELECT ON ' + table + ' TO ' + names);
}

async function install (client, { namespace, writer, floorReaders }) {
  const ns = schema(namespace), table = ns + '.verified_tenant_floor';
  await client.query('CREATE TABLE ' + table + " (tenant_id uuid PRIMARY KEY, status text NOT NULL CHECK(status IN ('verifying','verified','failed')), generation bigint, contract_digest text NOT NULL, epoch bigint NOT NULL, verified_at timestamptz, failure_code text)");
  await client.query('REVOKE ALL ON ' + table + ' FROM PUBLIC');
  await client.query('ALTER TABLE ' + table + ' ENABLE ROW LEVEL SECURITY');
  await client.query('ALTER TABLE ' + table + ' FORCE ROW LEVEL SECURITY');
  await client.query('CREATE POLICY admin_floor_writer ON ' + table + ' TO ' + q(writer) + ' USING(true) WITH CHECK(true)');
  await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + table + ' TO ' + q(writer));
  await grantReaders(client, table, floorReaders);
}

async function screenReader (config, connection) {
  schema(config.platformVerification?.namespace);
  const rows = await connection.withTenant('00000000-0000-0000-0000-000000000000', async () => (await connection.query(`SELECT
    c.relrowsecurity AND c.relforcerowsecurity AS secured,
    pg_has_role(current_user,c.relowner,'MEMBER') AS owns,
    has_table_privilege(c.oid,'SELECT') AS reads,
    has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes
    FROM pg_class c WHERE c.oid=to_regclass($1)`, [config.platformVerification.namespace + '.verified_tenant_floor'])).rows);
  if (rows.length !== 1 || rows[0].secured !== true || rows[0].owns !== false || rows[0].reads !== true || rows[0].writes !== false) throw fail('TENANT_FLOOR_RESULT_STORE_UNSAFE');
}

// Explicit elevated admin migration, called before verification for an
// existing platform namespace. Serving roles never invoke schema changes.
async function upgrade (client, options) {
  const ns = schema(options.namespace), table = ns + '.verified_tenant_floor';
  const exists = (await client.query('SELECT to_regclass($1) AS relation', [options.namespace + '.verified_tenant_floor'])).rows[0]?.relation;
  if (!exists) await install(client, options);
  else {
    // Older namespaces granted the tenant floor reader policy to all serving
    // roles. Retire those table grants when narrowing the policy to the API.
    const previous = (await client.query('SELECT r.rolname FROM pg_policy p CROSS JOIN LATERAL unnest(p.polroles) member_oid JOIN pg_roles r ON r.oid=member_oid WHERE p.polrelid=$1::regclass AND p.polname=$2', [table, policy])).rows.map(row => row.rolname);
    if (previous.length !== options.floorReaders.length || previous.some(name => !options.floorReaders.includes(name))) {
      await client.query('DROP POLICY IF EXISTS ' + policy + ' ON ' + table);
      for (const name of previous) {
        if (!options.floorReaders.includes(name)) await client.query('REVOKE SELECT ON ' + table + ' FROM ' + q(name));
      }
      await grantReaders(client, table, options.floorReaders);
    }
  }
  return { created: !exists, namespace: options.namespace };
}

function createReader ({ config, connection, operationWindow }) {
  const ns = schema(config.platformVerification?.namespace);
  const digest = platform.contract(config, 'api', platform.operationProfileDigest(operationWindow));
  return async function assertTenant (tenant) {
    validTenant(tenant);
    const generation = operationWindow ? String(operationWindow.currentGeneration(tenant)) : '0';
    const rows = await connection.withTenant(tenant, async () => (await connection.query(
      'SELECT /* verified-tenant-floor */ 1 FROM ' + ns + '.verified_tenant_floor f JOIN ' + ns + '.verification_control c ON c.singleton AND c.epoch=f.epoch ' +
      'JOIN ' + ns + ".verified_role r ON r.role='api' AND r.epoch=c.epoch AND r.status='verified' AND r.contract_digest=f.contract_digest " +
      "WHERE f.tenant_id=$1 AND f.status='verified' AND f.generation=$2::bigint AND f.contract_digest=$3", [tenant, generation, digest])).rows);
    if (rows.length !== 1) throw fail('TENANT_FLOOR_VERIFICATION_REQUIRED');
  };
}

async function withWriter (connectionString, body) {
  const client = new Client({ connectionString, application_name: 'nightscout-admin-tenant-floors', connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 11000 });
  try { await client.connect(); return await body(client); } finally { await client.end().catch(() => {}); }
}

function lifecycleTable (operationConfig) {
  return operationConfig ? schema(operationConfig.namespace) + '.tenant_lifecycle_windows' : null;
}
async function lifecycleState (connection, operationConfig, tenant) {
  const table = lifecycleTable(operationConfig);
  if (!table) return { generation: '0', phase: 'active', claim_id: null };
  const rows = (await connection.query('SELECT generation::text,phase,claim_id,lock_key::text FROM ' + table + ' WHERE tenant_id=$1', [tenant])).rows;
  if (rows.length !== 1 || !/^[1-9][0-9]*$/.test(rows[0].generation)) throw fail('TENANT_FLOOR_LIFECYCLE_REQUIRED');
  return rows[0];
}
async function checkTenant ({ config, operationConfig }, connection, tenant) {
  return connection.withTenant(tenant, async () => {
    let before = await lifecycleState(connection, operationConfig, tenant);
    if (before.phase === 'active') {
      if (operationConfig) {
        if (!await require('../../tenant-lifecycle/tenant-lock').tryShared(connection.query.bind(connection), before.lock_key, { label: 'admin-floor-replacement-lock' })) throw fail('TENANT_FLOOR_LIFECYCLE_REQUIRED');
        before = await lifecycleState(connection, operationConfig, tenant);
        if (before.phase !== 'active') throw fail('TENANT_FLOOR_LIFECYCLE_REQUIRED');
      }
    } else {
      // The operator invokes this after DATA commit and awaits it before
      // activation, retaining the exclusive replacement lock. Resume also
      // invokes it before activation. Suspended tenants cannot serve effects.
      if (before.phase !== 'suspended' || !before.claim_id) throw fail('TENANT_FLOOR_LIFECYCLE_REQUIRED');
    }
    await require('./postgres-domains').checkTenantFloors(config, connection, tenant);
    const root = (await connection.query('SELECT 1 FROM ' + schema(config.namespaces.legacy) + '.legacy_credential_config c JOIN ' + schema(config.namespaces.secrets) + '.secret_records s ON s.tenant_id=c.tenant_id AND s.id=c.root_reference_id WHERE c.tenant_id=$1', [tenant])).rows;
    if (root.length !== 1) throw fail('TENANT_FLOOR_ROOT_REQUIRED');
    const after = await lifecycleState(connection, operationConfig, tenant);
    if (before.generation !== after.generation || before.phase !== after.phase || before.claim_id !== after.claim_id) throw fail('TENANT_FLOOR_LIFECYCLE_CHANGED');
    return before.generation;
  });
}

async function verifyTenant ({ namespace, connectionString, item, tenant }) {
  validTenant(tenant);
  const ns = schema(namespace), digest = platform.contract(item.config, 'api', (item.operationConfig?.nativeSelection ?? item.operationConfig?.intakeProfile)?.digest);
  if (item.role !== 'api' || item.config.platformVerification?.namespace !== namespace) throw fail('TENANT_FLOOR_VERIFICATION_CONFIG');
  return withWriter(connectionString, async writer => {
    const locked = (await writer.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', ['tenant-floor-verification:' + namespace + ':' + tenant])).rows[0]?.held;
    if (!locked) throw fail('TENANT_FLOOR_VERIFICATION_BUSY');
    const epoch = (await writer.query('SELECT epoch FROM ' + ns + '.verification_control WHERE singleton')).rows[0]?.epoch;
    if (epoch === undefined) throw fail('TENANT_FLOOR_RESULT_UNRECORDED');
    const save = async (status, generation, failureCode) => {
      const result = await writer.query('INSERT INTO ' + ns + '.verified_tenant_floor (tenant_id,status,generation,contract_digest,epoch,verified_at,failure_code) SELECT $1,$2,$3::bigint,$4,epoch,CASE WHEN $2=\'verified\' THEN clock_timestamp() END,$5 FROM ' + ns + '.verification_control WHERE singleton AND epoch=$6 ON CONFLICT(tenant_id) DO UPDATE SET status=EXCLUDED.status,generation=EXCLUDED.generation,contract_digest=EXCLUDED.contract_digest,epoch=EXCLUDED.epoch,verified_at=EXCLUDED.verified_at,failure_code=EXCLUDED.failure_code', [tenant, status, generation, digest, failureCode, epoch]);
      if (result.rowCount !== 1) throw fail('TENANT_FLOOR_VERIFICATION_INVALIDATED');
    };
    let connection;
    try {
      await save('verifying', null, null);
      connection = await connect({ connectionString: item.config.connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 11000, application_name: 'nightscout-admin-floor-data' });
      const generation = await checkTenant(item, connection, tenant);
      await save('verified', generation, null);
      return Object.freeze({ version: 1, namespace, tenant, status: 'verified', generation });
    } catch (error) {
      if (error.code === 'TENANT_FLOOR_VERIFICATION_INVALIDATED') throw error;
      try { await save('failed', null, 'TENANT_FLOOR_INVALID'); } catch (recordError) { if (recordError.code === 'TENANT_FLOOR_VERIFICATION_INVALIDATED') throw recordError; throw fail('TENANT_FLOOR_RESULT_UNRECORDED'); }
      throw fail('TENANT_FLOOR_VERIFICATION_FAILED');
    } finally { if (connection) await connection.end(); }
  });
}

async function tenants ({ config }, connectionString) {
  if (!config.registry) return [...config.bindings.keys()];
  const connection = await connect({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 11000, application_name: 'nightscout-admin-floor-roster' });
  try { return (await require('../../tenant-registry/postgres').create({ connection, namespace: config.registry.namespace }).enumerate()).tenants; }
  finally { await connection.end(); }
}
module.exports = { install, upgrade, screenReader, createReader, verifyTenant, checkTenant, tenants };
