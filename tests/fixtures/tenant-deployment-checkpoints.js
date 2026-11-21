'use strict';

// Explicit actual configuration binding for two physical checkpoint instances.
// Digests come from each actual selected replay constructor at native provision;
// this helper does not invent runtime readiness or combine independent consumers.
const common = require('../../lib/tenant-operations/common');
const { refuse } = common;
const TYPED = Object.freeze({ realtime: 'migrations/candidates/postgres-realtime-output-v2.json', evaluator: 'migrations/candidates/postgres-evaluator-work-v2.json' });
function checkpointInputs ({ namespaces, tenants, realtime, evaluator, realtimeRole, evaluatorRole } = {}) {
  if (!namespaces || !Array.isArray(tenants) || tenants.length !== 2 || new Set(tenants).size !== 2 ||
      tenants.some(tenant => typeof tenant !== 'string' || !common.UUID.test(tenant))) throw refuse('CHECKPOINT_INPUT_INVALID');
  const records = [realtime, evaluator], roles = [realtimeRole, evaluatorRole];
  if (roles.some(role => typeof role !== 'string' || !common.ROLE.test(role)) || new Set(roles).size !== 2 ||
      records.some(record => !record || typeof record.consumer !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.consumer) ||
        !common.DIGEST.test(record.contractDigest) || !common.namespaceValid(record.namespace)) ||
      realtime.namespace === evaluator.namespace || realtime.consumer === evaluator.consumer ||
      namespaces.checkpoint !== realtime.namespace || namespaces.evaluator_checkpoint !== evaluator.namespace) throw refuse('CHECKPOINT_INPUT_INVALID');
  if (records.some((record,index) => record.candidatePath !== undefined && record.candidatePath !== TYPED[index ? 'evaluator' : 'realtime'])) throw refuse('CHECKPOINT_INPUT_INVALID');
  const rows = {}, grants = [], selection = {};
  for (const [index, kind] of ['checkpoint', 'evaluator_checkpoint'].entries()) {
    const record = records[index];
    rows[kind + '.tenant_consumer_checkpoint'] = tenants.map((tenant, tenantIndex) => ({ tenant_id: tenant,
      consumer: record.consumer, contract_digest: record.contractDigest, checkpoint: String(1000 + index * 100 + tenantIndex),
      projection: tenantIndex ? [] : null }));
    let columns = ['checkpoint', 'projection', 'contract_digest'];
    if (record.candidatePath) {
      selection[kind] = record.candidatePath;
      const typedColumns = index ? require('../../lib/pgstream/work-state').COLUMNS : require('../../lib/pgstream/realtime-receipt').COLUMNS;
      columns = [...columns, ...typedColumns];
      rows[kind + '.tenant_consumer_checkpoint'] = rows[kind + '.tenant_consumer_checkpoint'].map(row => ({ ...row, ...(index ? {
        work_version: 2, work_observed: ['9007199254740993', null, '9223372036854775807', null, null, null],
        work_completed: ['9007199254740992', null, '9223372036854775807', null, null, null],
        work_observed_at: ['1700000000000', null, '1700000000000', null, null, null],
        work_pending_at: '1700000000000', work_due_at: null, work_completed_at: '1700000000000',
        work_enabled: true, work_activity_enabled: true, work_lifecycle_enabled: true,
        delivery_revision: '9007199254740993', delivery_ack_revision: '9007199254740992',
        output_identity: 'c'.repeat(64), output_digest: 'd'.repeat(64), output_revision: '1', output_restore_generation: '9223372036854775807',
        projection: [{ kind: 'evaluator-work-v2', output: { tenant: row.tenant_id, frame: { values: [false, 0, null, '9007199254740993'] }, rows: [] } }]
      } : { output_target: '9007199254740994', output_received: '9007199254740993', output_completed: '9007199254740992', output_owner: tenants[0], output_retry_at: null, output_delivery_version: 1 }) }));
    }
    grants.push({ role: roles[index], kind, table: 'schema_migrations', privileges: ['SELECT'] },
      { role: roles[index], kind, table: 'tenant_consumer_checkpoint', privileges: ['SELECT'],
        columnPrivileges: { UPDATE: columns } });
  }
  return { selection, instances: [{ kind: 'evaluator_checkpoint', of: 'checkpoint' }], rows, acl: { grants } };
}
function populatedInstanceRows (admission, tableRows, checkpoints) {
  const result = {};
  for (const entry of admission.catalogues) for (const table of entry.tables) {
    const key = entry.kind + '.' + table;
    const rows = checkpoints.rows[key] || tableRows[table];
    if (!Array.isArray(rows) || !rows.length) throw refuse('CHECKPOINT_INPUT_SEED_MISSING', key);
    result[key] = rows;
  }
  for (const key of Object.keys(checkpoints.rows)) if (!Object.hasOwn(result, key)) throw refuse('CHECKPOINT_INPUT_INSTANCE_OMITTED', key);
  return result;
}
module.exports = { checkpointInputs, populatedInstanceRows };
