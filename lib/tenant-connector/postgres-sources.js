'use strict';

// Durable D15 connector configuration in the tenant-settings namespace.
// Definitions and their history are tenant data, covered by ordinary tenant
// export/deletion. This component stores only secret references, never values.
const { isDeepStrictEqual } = require('node:util');
const connect = require('../storage/postgres-connection');
const configuration = require('./config');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const zero = '00000000-0000-0000-0000-000000000000';
const fail = code => Object.assign(new Error(code), { code });
const q = value => '"' + value + '"';
function namespacesOf (namespaces) {
  if (!namespaces || Object.keys(namespaces).sort().join(',') !== 'control,registry,secrets,settings' ||
      new Set(Object.values(namespaces)).size !== 4 || Object.values(namespaces).some(value => !NAME.test(value) || value === 'public' || value === 'information_schema' || value.startsWith('pg_'))) throw fail('CONNECTOR_DEFINITION_INVALID');
  return namespaces;
}
function identity (tenant, source) {
  if (!UUID.test(tenant || '') || tenant === zero || source !== undefined && !ID.test(source)) throw fail('CONNECTOR_DEFINITION_INVALID');
}
function specOf (value) {
  if (!value || Object.keys(value).sort().join(',') !== 'connector,enabled,ifGeneration' || typeof value.enabled !== 'boolean' ||
      !Number.isSafeInteger(value.ifGeneration) || value.ifGeneration < 0 || value.ifGeneration >= Number.MAX_SAFE_INTEGER) throw fail('CONNECTOR_DEFINITION_INVALID');
  try { return { enabled: value.enabled, ifGeneration: value.ifGeneration, connector: configuration.connectorOf(value.connector) }; }
  catch { throw fail('CONNECTOR_DEFINITION_INVALID'); }
}
function rowOf (tenant, row) {
  if (!row) return null;
  const generation = Number(row.generation);
  if (!ID.test(row.source_id) || !Number.isSafeInteger(generation) || generation < 1 || typeof row.enabled !== 'boolean' || typeof row.deleted !== 'boolean') throw fail('CONNECTOR_DEFINITION_UNSAFE');
  return Object.freeze({ tenant, sourceId: row.source_id, generation, enabled: row.enabled, deleted: row.deleted,
    connector: configuration.connectorOf(row.definition) });
}
function grants ({ namespaces, reader, writer }) {
  const ns = namespacesOf(namespaces), out = [];
  if (!reader && !writer || [reader, writer].filter(Boolean).some(role => !NAME.test(role))) throw fail('CONNECTOR_DEFINITION_INVALID');
  const table = (kind, name) => q(ns[kind]) + '.' + name;
  for (const role of [reader, writer].filter(Boolean)) {
    for (const kind of ['settings', 'registry']) out.push('GRANT USAGE ON SCHEMA ' + q(ns[kind]) + ' TO ' + q(role),
      'GRANT SELECT ON ' + table(kind, 'schema_migrations') + ' TO ' + q(role));
    out.push('GRANT SELECT ON ' + table('settings', 'tenant_connector_sources') + ' TO ' + q(role));
  }
  if (reader) out.push(...require('../tenant-registry/postgres').grants({ namespace: ns.registry, readers: [reader], enumerators: [reader] }));
  if (writer) out.push('GRANT INSERT, UPDATE (generation, enabled, deleted, definition) ON ' + table('settings', 'tenant_connector_sources') + ' TO ' + q(writer),
    'GRANT INSERT ON ' + table('settings', 'tenant_connector_source_history') + ' TO ' + q(writer),
    'GRANT SELECT ON ' + table('registry', 'tenant_registry') + ', ' + table('registry', 'tenant_registry_clock') + ' TO ' + q(writer),
    'GRANT UPDATE (revision) ON ' + table('registry', 'tenant_registry_clock') + ' TO ' + q(writer),
    'GRANT USAGE ON SCHEMA ' + q(ns.secrets) + ' TO ' + q(writer),
    'GRANT SELECT (tenant_id, id) ON ' + table('secrets', 'secret_records') + ' TO ' + q(writer),
    'GRANT USAGE ON SCHEMA ' + q(ns.control) + ' TO ' + q(writer),
    'GRANT SELECT ON ' + ['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations'].map(name => table('control', name)).join(', ') + ' TO ' + q(writer));
  return Object.freeze(out);
}
async function create ({ connectionString, namespaces, writer = false, operator, now = Date.now }) {
  const ns = namespacesOf(namespaces);
  if (writer && (!operator || !ID.test(operator.principal) || !ID.test(operator.consumer))) throw fail('CONNECTOR_DEFINITION_INVALID');
  const connection = await connect({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-connector-definitions' });
  const t = (kind, table) => q(ns[kind]) + '.' + table, current = t('settings', 'tenant_connector_sources'), history = t('settings', 'tenant_connector_source_history');
  try {
    await require('../migrations/postgres').run('check', { direct: true, connectionString, namespace: ns.settings, catalogue: require('../tenant-settings/postgres-candidate.json') });
    const role = (await connection.readOnly('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
    const screen = (await connection.readOnly("SELECT c.relrowsecurity,c.relforcerowsecurity,pg_has_role(current_user,c.relowner,'MEMBER') AS owns," +
      " has_table_privilege(c.oid,'SELECT') AS reads,has_table_privilege(c.oid,'INSERT') AS inserts,has_any_column_privilege(c.oid,'UPDATE') AS updates," +
      " has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS unsafe FROM pg_class c WHERE c.oid=$1::regclass", [current])).rows[0];
    if (!role || Object.values(role).some(Boolean) || !screen?.relrowsecurity || !screen.relforcerowsecurity || screen.owns || !screen.reads || screen.unsafe ||
        screen.inserts !== writer || screen.updates !== writer) throw fail('CONNECTOR_DEFINITION_UNSAFE');
    const audit = (await connection.readOnly("SELECT c.relrowsecurity,c.relforcerowsecurity,pg_has_role(current_user,c.relowner,'MEMBER') AS owns," +
      " has_table_privilege(c.oid,'SELECT') AS reads,has_table_privilege(c.oid,'INSERT') AS inserts," +
      " has_table_privilege(c.oid,'UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'UPDATE,REFERENCES') AS unsafe FROM pg_class c WHERE c.oid=$1::regclass", [history])).rows[0];
    if (!audit?.relrowsecurity || !audit.relforcerowsecurity || audit.owns || audit.reads || audit.unsafe || audit.inserts !== writer) throw fail('CONNECTOR_DEFINITION_UNSAFE');
    if (writer) {
      const read = (await connection.readOnly("SELECT has_column_privilege(current_user,$1,'ciphertext','SELECT') AS ciphertext", [t('secrets', 'secret_records')])).rows[0];
      if (read.ciphertext) throw fail('CONNECTOR_DEFINITION_UNSAFE');
    }
  } catch (error) { await connection.end(); throw error; }
  const select = 'SELECT source_id,generation,enabled,deleted,definition FROM ' + current;
  async function active (tenant) {
    const key = require('../tenant-registry/rules').lockKey(tenant);
    const lock = (await connection.query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS held', [key])).rows[0];
    if (lock?.held !== true) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    await require('../tenant-lifecycle/operation-window-readiness').admit({ query: connection.query }, ns.control);
    const window = (await connection.query('SELECT phase,lock_key::text AS lock_key FROM ' + t('control', 'tenant_lifecycle_windows') + ' WHERE tenant_id=$1', [tenant])).rows[0];
    if (window?.phase !== 'active' || window.lock_key !== key) throw fail('LIFECYCLE_WINDOW_SUSPENDED');
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('nightscout-connector-config'),hashtext($1))", [tenant]);
    const row = (await connection.query('SELECT state FROM ' + t('registry', 'tenant_registry') + ' WHERE tenant_id=$1', [tenant])).rows[0];
    if (row?.state !== 'active') throw fail('CONNECTOR_TENANT_REFUSED');
  }
  async function change (tenant, sourceId, input, remove) {
    identity(tenant, sourceId);
    if (!writer) throw fail('CONNECTOR_DEFINITION_FORBIDDEN');
    const spec = remove ? { ifGeneration: input } : specOf(input);
    if (!Number.isSafeInteger(spec.ifGeneration) || spec.ifGeneration < 0 || spec.ifGeneration >= Number.MAX_SAFE_INTEGER) throw fail('CONNECTOR_DEFINITION_INVALID');
    return connection.withTenant(tenant, async () => {
      await active(tenant);
      const previous = rowOf(tenant, (await connection.query(select + ' WHERE tenant_id=$1 AND source_id=$2 FOR UPDATE', [tenant, sourceId])).rows[0]);
      const same = previous && (remove ? previous.deleted : !previous.deleted && previous.enabled === spec.enabled && isDeepStrictEqual(previous.connector, spec.connector));
      if (same && [previous.generation, previous.generation - 1].includes(spec.ifGeneration)) return { outcome: 'existing', definition: previous };
      if ((previous?.generation || 0) !== spec.ifGeneration || remove && !previous) throw fail('CONNECTOR_GENERATION_CONFLICT');
      const connector = remove ? previous.connector : spec.connector;
      if (!remove) {
        const refs = [connector.sourceEndpoint, connector.sourceCredential, connector.writeCredential];
        const rows = (await connection.query('SELECT id FROM ' + t('secrets', 'secret_records') + ' WHERE tenant_id=$1 AND id=ANY($2::text[])', [tenant, refs])).rows;
        if (rows.length !== refs.length) throw fail('CONNECTOR_SECRET_REFERENCE_REFUSED');
      }
      const generation = (previous?.generation || 0) + 1, enabled = remove ? false : spec.enabled;
      const values = [tenant, sourceId, generation, enabled, remove, connector];
      await connection.query('INSERT INTO ' + current + ' (tenant_id,source_id,generation,enabled,deleted,definition) VALUES ($1,$2,$3,$4,$5,$6)' +
        ' ON CONFLICT (tenant_id,source_id) DO UPDATE SET generation=excluded.generation,enabled=excluded.enabled,deleted=excluded.deleted,definition=excluded.definition', values);
      await connection.query('INSERT INTO ' + history + ' (tenant_id,source_id,generation,enabled,deleted,definition,principal,consumer,event_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [...values, operator.principal, operator.consumer, now()]);
      await connection.query('UPDATE ' + t('registry', 'tenant_registry_clock') + ' SET revision=revision+1 WHERE singleton');
      return { outcome: remove ? 'deleted' : previous ? 'updated' : 'created', definition: rowOf(tenant,
        { source_id: sourceId, generation, enabled, deleted: remove, definition: connector }) };
    });
  }
  return Object.freeze({
    put: (tenant, source, value) => change(tenant, source, value, false),
    remove: (tenant, source, generation) => change(tenant, source, generation, true),
    async list (tenant, { after = '', limit = 100, activeOnly = false } = {}) {
      identity(tenant);
      if (after !== '' && !ID.test(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail('CONNECTOR_DEFINITION_INVALID');
      return connection.withTenant(tenant, async () => (await connection.query(select + ' WHERE tenant_id=$1 AND source_id>$2' +
        (activeOnly ? ' AND enabled AND NOT deleted' : '') + ' ORDER BY source_id LIMIT $3', [tenant, after, limit])).rows.map(row => rowOf(tenant, row)));
    },
    async get (tenant, source) { identity(tenant, source); return connection.withTenant(tenant, async () => rowOf(tenant,
      (await connection.query(select + ' WHERE tenant_id=$1 AND source_id=$2', [tenant, source])).rows[0])); },
    close: () => connection.end()
  });
}
module.exports = { create, grants, specOf };
