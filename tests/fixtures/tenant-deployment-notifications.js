'use strict';

const common = require('../../lib/tenant-operations/common');
const uuid = value => '10000000-0000-4000-8000-' + String(value).padStart(12, '0');
function notificationInputs ({ tenants, now, outboxRole, checkpointWriterRole } = {}) {
  if (!Array.isArray(tenants) || tenants.length !== 2 || new Set(tenants).size !== 2 || tenants.some(tenant => !common.UUID.test(tenant))) {
    throw common.refuse('NOTIFICATION_INPUT_TENANTS_INVALID');
  }
  if (!Number.isSafeInteger(now) || now < 1000000 || now + 1000000 >= Number.MAX_SAFE_INTEGER) throw common.refuse('NOTIFICATION_INPUT_TIME_INVALID');
  if ([outboxRole, checkpointWriterRole].some(role => typeof role !== 'string' || !common.ROLE.test(role)) || outboxRole === checkpointWriterRole) {
    throw common.refuse('NOTIFICATION_INPUT_ROLES_INVALID');
  }
  const rows = { tenant_notification_heads: [], tenant_notification_requests: [] };
  for (const [tenantIndex, tenant] of tenants.entries()) {
    for (const [index, state] of ['pending', 'attempting', 'uncertain', 'accepted', 'cancelled'].entries()) {
      for (const [policyIndex, normalPolicy] of ['pushnotify', 'realtime-cycle'].entries()) {
        const number = 1 + tenantIndex * 100 + index * 2 + policyIndex;
        const requestId = uuid(number), consumer = normalPolicy === 'pushnotify' ? 'synthetic_provider' : 'synthetic_realtime';
        const dedup = normalPolicy + ':synthetic_' + state;
        rows.tenant_notification_heads.push({ tenant_id: tenant, consumer, dedup_key: dedup, request_id: requestId,
          blocked_until: String(normalPolicy === 'pushnotify' ? now + (state === 'accepted' ? 900000 : 30000) : now) });
        rows.tenant_notification_requests.push({ tenant_id: tenant, request_id: requestId, consumer, dedup_key: dedup,
          origin: 'synthetic-recovery', config_identity: 'synthetic-config', payload: { title: 'Synthetic alert', message: state,
            group: 'synthetic_low', level: 1, plugin: { name: 'synthetic' } }, state, created_at: String(now - 1000), next_at: String(now),
          attempt: state === 'pending' ? 0 : 1, attempt_token: state === 'attempting' ? uuid(number + 1000) : null,
          attempt_until: state === 'attempting' ? String(now + 30000) : null, accepted_at: state === 'accepted' ? String(now) : null,
          receipt: state === 'accepted' && normalPolicy === 'pushnotify' ? { synthetic: true, reference: 'retained-receipt' } : null,
          cleared_at: state === 'accepted' && normalPolicy === 'pushnotify' && tenantIndex === 0 ? String(now + 1) : null });
      }
    }
  }
  return {
    extension: { kind: 'notification_outbox', candidatePath: 'lib/tenant-notifications/postgres-candidate.json',
      sourceCommit: 'd06c990ca2c00e8689be5c56e37301f5c71ffc67',
      sourceSha256: '4c4ad71a688a63ffe1d2341314d0f50a8baeb097a00f5333078fd2dcbb6bbcf4',
      candidateDigest: '4a89b248b630d429216411ff4bb68ce5f4efc43f73f0b6df4ad85c8195c31818',
      tables: ['tenant_notification_heads', 'tenant_notification_requests'], secrets: [] },
    rows,
    acl: { grants: [
      { role: outboxRole, kind: 'notification_outbox', table: 'schema_migrations', privileges: ['SELECT'] },
      { role: outboxRole, kind: 'notification_outbox', table: 'tenant_notification_heads', privileges: ['SELECT', 'INSERT'],
        columnPrivileges: { UPDATE: ['request_id', 'blocked_until'] } },
      { role: outboxRole, kind: 'notification_outbox', table: 'tenant_notification_requests', privileges: ['SELECT', 'INSERT'],
        columnPrivileges: { UPDATE: ['state', 'next_at', 'attempt', 'attempt_token', 'attempt_until', 'accepted_at', 'receipt', 'cleared_at'] } }
    ] }
  };
}
module.exports = { notificationInputs };
