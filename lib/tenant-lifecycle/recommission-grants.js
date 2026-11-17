'use strict';

// Private maintenance identity only. No schema/table/function is selected by an
// artifact; callers pass the current source-admitted catalogue construction.
const profiles = require('../pgstream/pool-intake-profile');
const planner = require('./recommission-plan');
const { validateCatalogue } = require('../migrations/catalogue');
const insertions = require('./insertion-inventory');
const q = value => { if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) || value.startsWith('pg_') || ['public', 'information_schema'].includes(value)) throw new TypeError('Explicit recommission SQL identifier required'); return '"' + value + '"'; };
const table = (namespace, name) => q(namespace) + '.' + q(name);
function build ({ catalogues, namespaces, registryNamespace, intakeProfile, predecessorProfile, role, destroyRetainedKeys = false }) {
  const profile = profiles.validate(intakeProfile), b = profile.binding, who = q(role);
  if (typeof destroyRetainedKeys !== 'boolean') throw new TypeError('Explicit retained-key destruction capability required');
  if ([b.role, b.operatorRole].includes(role) || !Array.isArray(catalogues) || !catalogues.length) throw new TypeError('Separate private recommission identity required');
  const control = b.lifecycleNamespace, sql = [], seen = new Set();
  const grant = (rights, namespace, name) => sql.push('GRANT ' + rights + ' ON ' + table(namespace, name) + ' TO ' + who);
  for (const entry of catalogues) {
    if (entry.kind === 'lifecycle') continue;
    const namespace = namespaces[entry.kind]; q(namespace);
    if (seen.has(namespace)) throw new TypeError('Separate recommission catalogue namespaces required'); seen.add(namespace);
    const candidate = entry.candidate || entry.catalogue;
    validateCatalogue(candidate); insertions.assertTables(entry.kind, candidate, entry.tables);
    if (namespace === b.namespace && !require('node:util').isDeepStrictEqual(candidate, require('../pgstream/pool-catalogue').build(profile, { predecessorProfile }).catalogue)) throw new TypeError('Exact selected checkpoint catalogue required');
    sql.push('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + who);
    grant('SELECT', namespace, 'schema_migrations');
    for (const name of entry.tables) {
      const disposition = planner.disposition(entry.kind + '.' + name);
      grant('SELECT,DELETE', namespace, name);
      if (insertions.hasCounter(candidate, entry.kind) && name === entry.kind) {
        sql.push(...require('../server/ordinary-deployment-grants').insertionGrants({ namespace, domain: entry.kind, role, mode: 'restore' }));
        // Reconstruction inserts every captured column, including the current
        // storage statistic. Ordinary insertion grants intentionally omit it.
        if (candidate.migrations.some(migration => migration.operation?.kind === 'clinical-storage-size-v1' && migration.operation.domain === entry.kind)) grant('INSERT(storage_bytes)', namespace, name);
      } else if (name === insertions.COUNTER) {
        grant('INSERT(tenant_id,last_ordinal),UPDATE(last_ordinal)', namespace, name);
      } else if (name === 'tenant_consumer_checkpoint') {
        const columns = namespace === b.namespace ? require('../pgstream/pool-checkpoint-provision-candidate').INSERTS : ['tenant_id', 'consumer', 'contract_digest', 'checkpoint', 'projection'];
        grant('INSERT(' + columns.join(',') + ')', namespace, name);
      } else if (disposition !== 'current' && disposition !== 'reset') grant('INSERT', namespace, name);
      // The invoker trigger recomputes this derived statistic on restored rows.
      if (name === entry.kind && candidate.migrations.some(migration => migration.operation?.kind === 'clinical-storage-size-v1' && migration.operation.domain === entry.kind)) grant('UPDATE(storage_bytes)', namespace, name);
    }
  }
  if (!seen.has(b.namespace)) throw new TypeError('Current selected checkpoint required');
  sql.push(...require('./maintenance-window').operatorGrants({ namespace: control, role, intakeProfile: profile }));
  sql.push(...require('./recommission-commissioning').grants({ namespaces: { ...namespaces, control, registry: registryNamespace }, role }));
  sql.push(...require('../tenant-registry/recommission').grants({ namespace: registryNamespace, role }));
  for (const name of ['tenant_lifecycle_requests', 'tenant_lifecycle_ceremony', 'tenant_lifecycle_key_retention']) grant('SELECT', control, name);
  grant('INSERT(request_id,tenant_id,artifact_digest,phase,requested_at),UPDATE(phase,executed_at)', control, 'tenant_lifecycle_requests');
  grant('INSERT(request_id,tenant_id,phase,requested_by,requested_consumer),UPDATE(phase,confirmed_by,confirmed_consumer,confirmed_at,cancelled_by,cancelled_consumer,cancelled_at,claim_id,started_by,started_consumer,started_at,executed_by,executed_consumer,executed_at)', control, 'tenant_lifecycle_ceremony');
  grant('INSERT(request_id,tenant_id,artifact_digest,key_names,key_references,phase,retained_at,retain_until),UPDATE(phase,restored_at)', control, 'tenant_lifecycle_key_retention');
  if (destroyRetainedKeys) grant('UPDATE(destroy_started_by,destroy_started_consumer,destroy_started_at,destroyed_by,destroyed_consumer,destroyed_at,artifact_removal,artifact_removal_code)', control, 'tenant_lifecycle_key_retention');
  const worker = require('../pgstream/pool-worker-grants');
  for (const [namespace, name, columns] of [[b.namespace, 'pgstream_intake_profile', worker.PROFILE], [b.namespace, 'schema_migrations', worker.LEDGER],
    [b.membershipNamespace, 'schema_migrations', worker.LEDGER], [b.membershipNamespace, 'pool_desired', worker.DESIRED], [b.membershipNamespace, 'pool_membership', worker.MEMBERS]]) {
    sql.push('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + who); grant('SELECT(' + columns.join(',') + ')', namespace, name);
  }
  for (const [name, columns] of Object.entries(require('../pgstream/pool-checkpoint-provision-candidate').AUTHORITY_READS)) grant('SELECT(' + columns.join(',') + ')', control, name);
  sql.push('GRANT EXECUTE ON FUNCTION ' + table(namespaces.tenant_settings, 'tenant_settings_values_valid') + '(jsonb) TO ' + who);
  return Object.freeze([...new Set(sql)]);
}
module.exports = { build };
