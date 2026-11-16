'use strict';

// Writes only absent current-configuration rows inside the caller's already
// open DATA transaction. There is no artifact input and no transaction/pool or
// authorization fallback. The caller commissions before restoring FK children.
const maintenance = require('./maintenance-window');
const owner = require('../subject-admin/owner-policy');
const settings = require('../tenant-settings/component');
const { createOperatorPolicy } = require('../operator-policy/component');
const { createSubjectPolicy } = require('../subject-policy/component');
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAP = Object.freeze({ access: 'data', management: 'management', 'human-data': 'data', 'human-management': 'management' });
const TABLES = Object.freeze([
  ['operator_policy', 'tenant_operator_policy', ['tenant_id', 'generation', 'policy', 'principal', 'consumer', 'event_time']],
  ['authorization', 'tenant_owner_policy', ['tenant_id', 'catalogue_digest', 'ceiling', 'owner_fence']],
  ['authorization', 'tenant_owner_actors', ['tenant_id', 'principal', 'consumer', 'active', 'can_update', 'delegable', 'owner_fence']],
  ['owner_configuration', 'tenant_owner_configuration_authority', ['tenant_id', 'principal', 'consumer', 'active', 'can_configure', 'owner_fence']],
  ['subject_policy', 'subject_policy', ['tenant_id', 'version', 'grants']],
  ['access', 'access_tenants', ['tenant_id', 'active']],
  ['access', 'access_keys', ['tenant_id', 'kid', 'purpose', 'active']]
]);
const fail = code => { throw Object.assign(new Error('LIFECYCLE_COMMISSION_' + code), { code: 'LIFECYCLE_COMMISSION_' + code }); };
const named = value => typeof value === 'string' && NAME.test(value);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const q = name => '"' + name + '"';
function namespacesOf (input) {
  const result = {};
  for (const kind of ['control', 'registry', ...new Set(TABLES.map(row => row[0]))]) {
    const value = input?.[kind];
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) ||
        value === 'public' || value === 'information_schema' || value.startsWith('pg_')) fail('NAMESPACE_INVALID');
    result[kind] = value;
  }
  return result;
}
const tableName = (ns, kind, table) => q(ns[kind]) + '.' + q(table);
function identities (rows, fields) {
  if (!Array.isArray(rows) || rows.length > 1000) fail('CAPABILITY_REQUIRED');
  const seen = new Set();
  for (const row of rows) {
    if (!plain(row) || Object.keys(row).some(name => !['principal', 'consumer', ...fields].includes(name)) ||
        !named(row.principal) || !named(row.consumer) || seen.has(row.principal + ':' + row.consumer)) fail('CAPABILITY_INVALID');
    seen.add(row.principal + ':' + row.consumer);
  }
  return rows;
}

async function commission ({ connection, maintenanceClaim, tenant, artifactDigest, namespaces, configuration } = {}) {
  const claim = { connection, tenant, artifactDigest };
  // This must precede configuration reads and every query, including role checks.
  await maintenance.assertHeld(maintenanceClaim, claim);
  if (!UUID.test(tenant || '') || !DIGEST.test(artifactDigest || '') || typeof connection?.query !== 'function') fail('INPUT_INVALID');
  const ns = namespacesOf(namespaces), current = new Map(), pending = new Map();
  const authority = await connection.query('SELECT /* recommission-current-authority */ active FROM ' +
    tableName(ns, 'control', 'tenant_lifecycle_restore_authority') + ' WHERE tenant_id=$1 AND role_oid=CURRENT_USER::regrole::oid', [tenant]);
  if (authority.rows.length !== 1 || authority.rows[0].active !== true) fail('AUTHORITY_REFUSED');
  for (const [kind, table, columns] of TABLES) {
    const rows = (await connection.query('SELECT ' + columns.map(q).join(',') + ' FROM ' + tableName(ns, kind, table) + ' WHERE tenant_id=$1', [tenant])).rows;
    current.set(kind + '.' + table, rows);
  }
  const absent = key => !current.get(key).length;
  const required = key => {
    if (!plain(configuration) || !Object.hasOwn(configuration, key)) fail('CONFIGURATION_REQUIRED');
    return configuration[key];
  };
  const actor = () => {
    const value = required('actor');
    if (!plain(value) || Object.keys(value).some(key => !['principal', 'consumer'].includes(key)) || !named(value.principal) || !named(value.consumer)) fail('ACTOR_INVALID');
    return { tenant, principal: value.principal, consumer: value.consumer };
  };
  const eventTime = () => {
    const value = required('eventTime');
    if (!Number.isSafeInteger(value) || value < 0) fail('TIME_INVALID');
    return String(value);
  };
  if (absent('operator_policy.tenant_operator_policy')) {
    const who = actor(), policy = required('operatorPolicy');
    // Reuse both generic operator JSON limits and the actual settings rules.
    const validator = createOperatorPolicy({ authorizeManagement: async () => true,
      store: { read: async () => undefined, write: async (_actor, _version, value) => ({ policy: value }) } });
    const normalized = (await validator.replace(who, 0, policy)).policy;
    settings.resolveEffectiveSettings({ version: 1, values: {} }, { ...normalized, generation: 1 });
    pending.set('operator_policy.tenant_operator_policy', [[tenant, 1, JSON.stringify(normalized), who.principal, who.consumer, eventTime()]]);
  }
  let ceiling = current.get('authorization.tenant_owner_policy')[0]?.ceiling;
  if (absent('authorization.tenant_owner_policy')) {
    ceiling = required('ownerCatalogue');
    const digest = owner.catalogueDigest(ceiling);
    pending.set('authorization.tenant_owner_policy', [[tenant, digest, ceiling.slice(), false]]);
  }
  if (absent('authorization.tenant_owner_actors')) {
    const rows = identities(required('ownerActors'), ['active', 'canUpdate', 'delegable']);
    pending.set('authorization.tenant_owner_actors', rows.map(row => {
      if (typeof row.active !== 'boolean' || typeof row.canUpdate !== 'boolean' || !owner.permissionsValid(row.delegable) ||
          !owner.permissionsValid(ceiling) || !owner.permissionsContained(row.delegable, ceiling)) fail('CAPABILITY_INVALID');
      return [tenant, row.principal, row.consumer, row.active, row.canUpdate, row.delegable.slice(), false];
    }));
  }
  if (absent('owner_configuration.tenant_owner_configuration_authority')) {
    const rows = identities(required('ownerConfiguration'), ['active', 'canConfigure']);
    pending.set('owner_configuration.tenant_owner_configuration_authority', rows.map(row => {
      if (typeof row.active !== 'boolean' || typeof row.canConfigure !== 'boolean') fail('CAPABILITY_INVALID');
      return [tenant, row.principal, row.consumer, row.active, row.canConfigure, false];
    }));
  }
  if (absent('subject_policy.subject_policy')) {
    const policy = required('subjectPolicy'), who = actor();
    if (!plain(policy) || !['grants', 'code', 'operator'].every(key => Object.hasOwn(policy, key))) fail('CAPABILITY_REQUIRED');
    // Source component normalizes exact grants and checks both current ceilings.
    // This in-memory validator supplies no runtime authorization to the caller.
    const validator = createSubjectPolicy({ authorizeManagement: async () => true,
      limitsFor: async () => ({ code: policy.code, operator: policy.operator, generation: 1 }),
      store: { read: async () => undefined, write: async (_actor, _version, grants) => ({ grants }) } });
    const normalized = (await validator.replace(who, 0, policy.grants)).grants;
    pending.set('subject_policy.subject_policy', [[tenant, 1, JSON.stringify(normalized)]]);
  }
  if (absent('access.access_tenants')) {
    const access = required('access');
    if (!plain(access) || typeof access.active !== 'boolean') fail('CAPABILITY_REQUIRED');
    pending.set('access.access_tenants', [[tenant, access.active]]);
  }
  if (absent('access.access_keys')) {
    const keys = required('access')?.keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 256) fail('CAPABILITY_REQUIRED');
    const registry = (await connection.query('SELECT purpose,kid,public_key FROM ' +
      tableName(ns, 'registry', 'tenant_registry_keys') + ' WHERE tenant_id=$1', [tenant])).rows;
    const seen = new Set();
    pending.set('access.access_keys', keys.map(key => {
      if (!plain(key) || Object.keys(key).some(name => !['purpose', 'kid', 'publicKey'].includes(name)) ||
          !Object.hasOwn(MAP, key.purpose) || !named(key.kid) || typeof key.publicKey !== 'string' ||
          !/^[A-Za-z0-9+/]{43}=$/.test(key.publicKey) || Buffer.from(key.publicKey, 'base64').toString('base64') !== key.publicKey) fail('KEY_INVALID');
      const matched = registry.filter(row => row.purpose === key.purpose && row.kid === key.kid && row.public_key === key.publicKey);
      const identity = key.kid + ':' + MAP[key.purpose];
      if (matched.length !== 1 || seen.has(identity)) fail('KEY_INVALID');
      seen.add(identity);
      return [tenant, key.kid, MAP[key.purpose], true];
    }));
  }
  // All omissions, source validation and current-key selection precede writes.
  for (const [kind, table, columns] of TABLES) {
    const rows = pending.get(kind + '.' + table);
    if (!rows) continue;
    for (const row of rows) {
      await maintenance.assertHeld(maintenanceClaim, claim);
      const result = await connection.query('INSERT INTO ' + tableName(ns, kind, table) + ' (' + columns.map(q).join(',') +
        ') VALUES (' + columns.map((_, index) => '$' + (index + 1)).join(',') + ')', row);
      if (result.rowCount !== 1) fail('WRITE_REFUSED');
    }
  }
  await maintenance.assertHeld(maintenanceClaim, claim);
  return Object.freeze({ inserted: Object.freeze([...pending.keys()].sort()), preserved: Object.freeze([...current.keys()].filter(key => !absent(key)).sort()) });
}

function grants ({ namespaces, role } = {}) {
  const ns = namespacesOf(namespaces);
  if (!named(role) || !/^[a-z][a-z0-9_]{0,62}$/.test(role)) fail('ROLE_INVALID');
  const result = [...new Set(Object.values(ns))].map(name => 'GRANT USAGE ON SCHEMA ' + q(name) + ' TO ' + q(role));
  for (const [kind, table, columns] of TABLES) result.push('GRANT SELECT (' + columns.map(q).join(',') + '), INSERT (' + columns.map(q).join(',') + ') ON ' + tableName(ns, kind, table) + ' TO ' + q(role));
  result.push('GRANT SELECT (tenant_id,role_oid,active) ON ' + tableName(ns, 'control', 'tenant_lifecycle_restore_authority') + ' TO ' + q(role));
  result.push('GRANT SELECT (tenant_id,purpose,kid,public_key) ON ' + tableName(ns, 'registry', 'tenant_registry_keys') + ' TO ' + q(role));
  return result;
}

module.exports = { commission, grants };
