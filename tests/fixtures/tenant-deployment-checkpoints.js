'use strict';

// Explicit actual configuration binding for two physical checkpoint instances.
// Digests come from each actual selected replay constructor at native provision;
// this helper does not invent runtime readiness or combine independent consumers.
const common = require('../../lib/tenant-operations/common');
const { refuse } = common;
function checkpointInputs ({ namespaces, tenants, realtime, evaluator, realtimeRole, evaluatorRole } = {}) {
  if (!namespaces || !Array.isArray(tenants) || tenants.length !== 2 || new Set(tenants).size !== 2 ||
      tenants.some(tenant => typeof tenant !== 'string' || !common.UUID.test(tenant))) throw refuse('CHECKPOINT_INPUT_INVALID');
  const records = [realtime, evaluator], roles = [realtimeRole, evaluatorRole];
  if (roles.some(role => typeof role !== 'string' || !common.ROLE.test(role)) || new Set(roles).size !== 2 ||
      records.some(record => !record || typeof record.consumer !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.consumer) ||
        !common.DIGEST.test(record.contractDigest) || !common.namespaceValid(record.namespace)) ||
      realtime.namespace === evaluator.namespace || realtime.consumer === evaluator.consumer ||
      namespaces.checkpoint !== realtime.namespace || namespaces.evaluator_checkpoint !== evaluator.namespace) throw refuse('CHECKPOINT_INPUT_INVALID');
  const rows = {}, grants = [];
  for (const [index, kind] of ['checkpoint', 'evaluator_checkpoint'].entries()) {
    const record = records[index];
    rows[kind + '.tenant_consumer_checkpoint'] = tenants.map((tenant, tenantIndex) => ({ tenant_id: tenant,
      consumer: record.consumer, contract_digest: record.contractDigest, checkpoint: String(1000 + index * 100 + tenantIndex),
      projection: tenantIndex ? [] : null }));
    grants.push({ role: roles[index], kind, table: 'schema_migrations', privileges: ['SELECT'] },
      { role: roles[index], kind, table: 'tenant_consumer_checkpoint', privileges: ['SELECT'],
        columnPrivileges: { UPDATE: ['checkpoint', 'projection', 'contract_digest'] } });
  }
  return { instances: [{ kind: 'evaluator_checkpoint', of: 'checkpoint' }], rows, acl: { grants } };
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
