'use strict';

// Durable tenant activity flags (pause/suspend) with an append-only audit.
// Three capabilities, each a separate database identity:
//   reader    SELECT tenant_activity only (evaluator, consumers, connectors)
//   owner     SELECT; UPDATE(version, paused) only; INSERT audit. It cannot
//             write `suspended`: the column grant, not only this module,
//             keeps an owner from suspending or unsuspending.
//   operator  provisions rows and may set both flags.
// Rows live under tenant RLS; every call binds the tenant it acts on.
const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const policy = require('./policy');
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ACTOR = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TENANT = '00000000-0000-0000-0000-000000000000';
const refuse = code => Object.assign(new Error(code), { code });
const KNOWN = new Set(['ACTIVITY_FORBIDDEN', 'ACTIVITY_SUSPENDED', 'ACTIVITY_VERB_INVALID', 'ACTIVITY_NOT_PROVISIONED',
  'ACTIVITY_VERSION_CONFLICT', 'ACTIVITY_STORE_UNSAFE']);

const grantsFor = ({ namespace, reader, owner, operator }) => {
  if (!NAME.test(namespace || '') || ['public', 'information_schema'].includes(namespace) || namespace.startsWith('pg_')) {
    throw new TypeError('Explicit activity namespace required');
  }
  const q = name => '"' + name + '"', table = q(namespace) + '.tenant_activity', audit = q(namespace) + '.tenant_activity_audit';
  const statements = [];
  for (const role of [reader, owner, operator].filter(Boolean)) {
    if (!NAME.test(role)) throw new TypeError('Explicit activity role required');
    statements.push('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(role),
      'GRANT SELECT ON ' + q(namespace) + '.schema_migrations TO ' + q(role),
      'GRANT SELECT ON ' + table + ' TO ' + q(role));
  }
  if (owner) statements.push('GRANT UPDATE (version, paused) ON ' + table + ' TO ' + q(owner),
    'GRANT INSERT ON ' + audit + ' TO ' + q(owner));
  if (operator) statements.push('GRANT INSERT, UPDATE (version, paused, suspended) ON ' + table + ' TO ' + q(operator),
    'GRANT SELECT, INSERT ON ' + audit + ' TO ' + q(operator));
  return Object.freeze(statements);
};

async function create ({ connectionString, namespace, capability, applicationName = 'nightscout-tenant-activity' } = {}) {
  if (scope.getTenancyMode() !== 'multi' || !NAME.test(namespace || '') || ['public', 'information_schema'].includes(namespace) ||
      namespace.startsWith('pg_') || !['reader', 'owner', 'operator'].includes(capability)) {
    throw new TypeError('Activity store requires multi mode, an explicit namespace and a capability');
  }
  const connection = await connect({ connectionString, max: 2, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 5000, application_name: applicationName });
  const table = '"' + namespace + '".tenant_activity', audit = '"' + namespace + '".tenant_activity_audit';
  try {
    // The identity must hold exactly its capability. A reader that could
    // write, or an owner that could write `suspended`, is refused at boot.
    const rows = (await connection.withTenant(METADATA_TENANT, () => connection.query(`
      SELECT c.oid = to_regclass($1) AS current_state, c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user,c.relowner,'MEMBER') AS owns, has_table_privilege(c.oid,'SELECT') AS reads,
        has_table_privilege(c.oid,'INSERT') AS inserts,
        has_table_privilege(c.oid,'DELETE,TRUNCATE,TRIGGER,REFERENCES') AS destroys,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege(c.oid,a.attnum,'UPDATE') ORDER BY a.attname) AS updates
      FROM pg_class c WHERE c.oid IN (to_regclass($1), to_regclass($2))`, [table, audit]))).rows;
    const state = rows.find(row => row.current_state), log = rows.find(row => !row.current_state);
    const expected = {
      reader: { stateInsert: false, stateUpdates: [], logInsert: false },
      owner: { stateInsert: false, stateUpdates: ['paused', 'version'], logInsert: true },
      operator: { stateInsert: true, stateUpdates: ['paused', 'suspended', 'version'], logInsert: true }
    }[capability];
    if (rows.length !== 2 || rows.some(row => !row.secured || row.owns || row.destroys) || !state.reads ||
        state.inserts !== expected.stateInsert || JSON.stringify(state.updates) !== JSON.stringify(expected.stateUpdates) ||
        log.inserts !== expected.logInsert || log.updates.length) throw refuse('ACTIVITY_STORE_UNSAFE');
  } catch (error) {
    await connection.end();
    throw KNOWN.has(error.code) ? error : refuse('ACTIVITY_STORE_UNAVAILABLE');
  }
  const tenantOf = tenant => {
    if (typeof tenant !== 'string' || !UUID.test(tenant) || tenant === METADATA_TENANT) throw new TypeError('Canonical activity tenant required');
    return tenant;
  };
  const shape = (tenant, row) => row ? Object.freeze({ tenant, version: Number(row.version), paused: row.paused,
    suspended: row.suspended, state: policy.stateOf(row) }) : null;
  async function read (tenant) {
    tenantOf(tenant);
    try {
      return await connection.withTenant(tenant, async () =>
        shape(tenant, (await connection.query('SELECT version::text,paused,suspended FROM ' + table + ' WHERE tenant_id=$1', [tenant])).rows[0]));
    } catch { throw refuse('ACTIVITY_UNAVAILABLE'); }
  }
  async function transition (actor, verb, { expectedVersion } = {}) {
    if (capability === 'reader') throw refuse('ACTIVITY_FORBIDDEN');
    if (!actor || ['principal', 'consumer'].some(key => typeof actor[key] !== 'string' || !ACTOR.test(actor[key]))) {
      throw new TypeError('Authenticated activity actor required');
    }
    const tenant = tenantOf(actor.tenant);
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw refuse('ACTIVITY_VERB_INVALID');
    try {
      return await connection.withTenant(tenant, async () => {
        await connection.query("SET LOCAL synchronous_commit = 'on'");
        const row = (await connection.query('SELECT version::text,paused,suspended FROM ' + table + ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows[0];
        if (!row) throw refuse('ACTIVITY_NOT_PROVISIONED');
        if (expectedVersion !== undefined && Number(row.version) !== expectedVersion) throw refuse('ACTIVITY_VERSION_CONFLICT');
        const next = policy.apply(capability, verb, row);
        if (next.paused === row.paused && next.suspended === row.suspended) return shape(tenant, row);
        const columns = capability === 'owner' ? 'paused=$3' : 'paused=$3,suspended=$4';
        const values = capability === 'owner' ? [tenant, row.version, next.paused] : [tenant, row.version, next.paused, next.suspended];
        const updated = (await connection.query('UPDATE ' + table + ' SET version=version+1,' + columns +
          ' WHERE tenant_id=$1 AND version=$2::bigint RETURNING version::text,paused,suspended', values)).rows[0];
        if (!updated) throw refuse('ACTIVITY_VERSION_CONFLICT');
        await connection.query('INSERT INTO ' + audit + ' (tenant_id,version,verb,authority,principal,consumer,paused,suspended) VALUES ($1,$2::bigint,$3,$4,$5,$6,$7,$8)',
          [tenant, updated.version, verb, capability, actor.principal, actor.consumer, updated.paused, updated.suspended]);
        return shape(tenant, updated);
      });
    } catch (error) {
      if (KNOWN.has(error.code)) throw error;
      throw refuse('ACTIVITY_UNAVAILABLE');
    }
  }
  async function provision (actor) {
    if (capability !== 'operator') throw refuse('ACTIVITY_FORBIDDEN');
    if (!actor || ['principal', 'consumer'].some(key => typeof actor[key] !== 'string' || !ACTOR.test(actor[key]))) {
      throw new TypeError('Authenticated activity actor required');
    }
    const tenant = tenantOf(actor.tenant);
    return connection.withTenant(tenant, async () => {
      const inserted = (await connection.query('INSERT INTO ' + table + ' (tenant_id,version,paused,suspended) VALUES ($1,1,false,false) ON CONFLICT (tenant_id) DO NOTHING RETURNING version::text,paused,suspended', [tenant])).rows[0];
      if (inserted) await connection.query('INSERT INTO ' + audit + " (tenant_id,version,verb,authority,principal,consumer,paused,suspended) VALUES ($1,1,'provision','operator',$2,$3,false,false)",
        [tenant, actor.principal, actor.consumer]);
      return shape(tenant, inserted || (await connection.query('SELECT version::text,paused,suspended FROM ' + table + ' WHERE tenant_id=$1', [tenant])).rows[0]);
    });
  }
  return Object.freeze({ capability, read, ...(capability === 'reader' ? {} : { transition }),
    ...(capability === 'operator' ? { provision } : {}), close: () => connection.end() });
}

module.exports = { create, grants: grantsFor };
