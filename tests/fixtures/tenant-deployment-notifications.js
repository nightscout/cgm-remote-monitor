'use strict';

const common = require('../../lib/tenant-operations/common');
const uuid = value => '10000000-0000-4000-8000-' + String(value).padStart(12, '0');
function notificationInputs ({ tenants, now, outboxRole, checkpointWriterRole, ackReaderRole } = {}) {
  if (!Array.isArray(tenants) || tenants.length !== 2 || new Set(tenants).size !== 2 || tenants.some(tenant => !common.UUID.test(tenant))) {
    throw common.refuse('NOTIFICATION_INPUT_TENANTS_INVALID');
  }
  if (!Number.isSafeInteger(now) || now < 1000000 || now + 1000000 >= Number.MAX_SAFE_INTEGER) throw common.refuse('NOTIFICATION_INPUT_TIME_INVALID');
  const roles = [outboxRole, checkpointWriterRole, ackReaderRole];
  if (roles.some(role => typeof role !== 'string' || !common.ROLE.test(role)) || new Set(roles).size !== roles.length) {
    throw common.refuse('NOTIFICATION_INPUT_ROLES_INVALID');
  }
  const rows = { tenant_notification_heads: [], tenant_notification_requests: [], tenant_notification_state: [] };
  for (const [tenantIndex, tenant] of tenants.entries()) {
    for (const [index, consumer] of ['synthetic_provider', 'synthetic_realtime'].entries()) {
      const group = 'synthetic_low';
      const ackedAt = now - 1000, expiresAt = now + 30000;
      rows.tenant_notification_state.push({ tenant_id: tenant, consumer, revision: String(7 + tenantIndex * 10 + index), config_identity: 'synthetic-config',
        producer: {
          alarms: [{ level: 1, group, lastAckTime: ackedAt, silenceTime: expiresAt - ackedAt, lastEmitTime: now - 2000 }],
          effects: [{ origin: common.sha256('synthetic-transition-' + tenantIndex + '-' + index), payload: {
            clear: true, group, level: 1, title: 'Synthetic clear', message: 'Retained clear', plugin: { name: 'synthetic' } } }],
          acks: [JSON.stringify([group, 1, ackedAt, expiresAt])],
          output: ['synthetic-clinical-config', 'synthetic-runtime-' + tenantIndex, 3, String(now - 2000)], clinicalIdentity: 'synthetic-clinical-config'
        } });
    }
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
      sourceCommit: '5600192558a10462c159d00ef53ba770a647765d',
      sourceSha256: '0d998333640f4415dfb93edd789edb0277c1067ccd79f8583f902b3e1b0e1ec2',
      candidateDigest: '6373384e7e3c7e4059d2d1bd01cd36d29a38964bd96a1a239f28438d598d563b',
      tables: ['tenant_notification_heads', 'tenant_notification_requests', 'tenant_notification_state'], secrets: [] },
    rows,
    acl: { grants: [
      { role: outboxRole, kind: 'notification_outbox', table: 'schema_migrations', privileges: ['SELECT'] },
      { role: outboxRole, kind: 'notification_outbox', table: 'tenant_notification_heads', privileges: ['SELECT', 'INSERT'],
        columnPrivileges: { UPDATE: ['request_id', 'blocked_until'] } },
      { role: outboxRole, kind: 'notification_outbox', table: 'tenant_notification_requests', privileges: ['SELECT', 'INSERT'],
        columnPrivileges: { UPDATE: ['state', 'next_at', 'attempt', 'attempt_token', 'attempt_until', 'accepted_at', 'receipt', 'cleared_at'] } },
      { role: outboxRole, kind: 'notification_outbox', table: 'tenant_notification_state', privileges: ['SELECT', 'INSERT'], columnPrivileges: { UPDATE: ['revision', 'config_identity', 'producer'] } },
      { role: ackReaderRole, kind: 'notification_outbox', table: 'schema_migrations', privileges: ['SELECT'] },
      { role: ackReaderRole, kind: 'notification_outbox', table: 'tenant_notification_state', privileges: ['SELECT'] }
    ] }
  };
}
module.exports = { notificationInputs };
