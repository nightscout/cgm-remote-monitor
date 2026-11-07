'use strict';

// Proposed full-catalogue native seed, not executed PostgreSQL evidence. Actual
// M5 extensions must provide explicit new rows; no guessed peer schema is loaded.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX = '0123456789abcdef01234567';
const digest = 'a'.repeat(64);
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

function populatedRows ({ now = 1700000000000, profileSocketOrder = false } = {}) {
  const rows = {};
  const add = (table, row) => { (rows[table] = rows[table] || []).push(row); };
  for (const [offset, tenant] of [A, B].entries()) {
    const suffix = offset === 0 ? 'a' : 'b';
    const event = n => uuid(n + offset * 100);
    const principal = 'operator_' + suffix, consumer = 'synthetic_' + suffix;
    for (const table of ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings']) {
      for (const id_kind of ['objectid', 'string']) add(table, { tenant_id: tenant, id_kind,
        doc: { _id: HEX, date: now, created_at: new Date(now).toISOString(), srvModified: 1000,
          extension: { flag: false, zero: 0, nullable: null, ordered: [3, 1, 2] } } });
    }
    add('tenant_write_clock', { tenant_id: tenant, last_stamp: '1000' });
    add('tenant_insertion_ordinal', { tenant_id: tenant, last_ordinal: offset ? '900' : '17' });
    add('tenant_consumer_checkpoint', { tenant_id: tenant, consumer, contract_digest: digest, checkpoint: '1000', projection: offset ? [] : null });
    add('tenant_authorization_config', { tenant_id: tenant, anonymous_roles: ['denied'], owner_fence: false });
    add('tenant_authorization_roles', { tenant_id: tenant, name: 'viewer', permissions: ['api:entries:read'], owner_fence: false });
    add('tenant_authorization_subjects', { tenant_id: tenant, subject_id: 'subject_' + suffix, display_name: 'Synthetic ' + suffix, notes: null, created_at: null });
    add('tenant_authorization_subject_roles', { tenant_id: tenant, subject_id: 'subject_' + suffix, role_name: 'viewer' });
    add('tenant_subject_admin_audit', { event_id: event(1), tenant_id: tenant, principal, consumer, subject_id: 'subject_' + suffix, operation: 'update', event_time: '1000' });
    add('tenant_owner_policy', { tenant_id: tenant, catalogue_digest: digest, ceiling: ['api:entries:read'], owner_fence: false });
    add('tenant_owner_actors', { tenant_id: tenant, principal, consumer, active: true, can_update: true, delegable: ['api:entries:read'], owner_fence: false });
    add('access_tenants', { tenant_id: tenant, active: true });
    add('access_credentials', { tenant_id: tenant, credential_id: 'credential_' + suffix, subject_id: 'subject_' + suffix, generation: 1, enabled: true });
    add('access_sessions', { tenant_id: tenant, session_id: 'session_' + suffix, subject_id: 'subject_' + suffix,
      credential_id: 'credential_' + suffix, generation: 1, expires_at: String(now + 600000), active: true, purpose: 'data' });
    add('access_keys', { tenant_id: tenant, kid: 'key_' + suffix, purpose: 'data', active: true });
    add('subject_policy', { tenant_id: tenant, version: 1, grants: [] });
    add('subject_policy_audit', { event_id: event(2), tenant_id: tenant, principal, consumer, operation: 'policy-replace', phase: 'committed', event_time: '1000', version: 1 });
    add('tenant_operator_policy', { tenant_id: tenant, generation: 1, policy: {}, principal, consumer, event_time: '1000' });
    const values = { DISPLAY_UNITS: offset ? 'mg/dl' : 'mmol', SHOW_SECONDS: false };
    add('tenant_settings', { tenant_id: tenant, version: 2, values });
    add('tenant_settings_history', { tenant_id: tenant, version: 1, values, principal, consumer, operation: 'replace', event_time: '1000', restored_from: null });
    add('tenant_owner_configuration_authority', { tenant_id: tenant, principal, consumer, active: true, can_configure: true, owner_fence: false });
    add('legacy_credential_config', { tenant_id: tenant, root_reference_id: 'reference_' + suffix });
    add('legacy_credential_subjects', { tenant_id: tenant, subject_id: 'subject_' + suffix, token_prefix: suffix });
    add('secret_records', { tenant_id: tenant, id: 'reference_' + suffix, format: 1,
      ciphertext: offset ? 'vault:v2:Zm9yZWlnbg==' : 'vault:v1:c3ludGhldGljLWNpcGhlcnRleHQ=' });
    add('secret_audit', { event_id: event(3), tenant_id: tenant, principal, consumer, operation: 'encrypt', secret_id: 'reference_' + suffix,
      phase: 'authorized', event_time: '1000', target_version: null });
    add('tenant_lifecycle_requests', { request_id: event(4), tenant_id: tenant, artifact_digest: digest, phase: 'executed', requested_at: '500', executed_at: '1000' });
    add('tenant_lifecycle_ceremony', { request_id: event(4), tenant_id: tenant, phase: 'executed', requested_by: 'owner_' + suffix, requested_consumer: consumer,
      confirmed_by: principal, confirmed_consumer: consumer, confirmed_at: '600', cancelled_by: null, cancelled_consumer: null, cancelled_at: null,
      claim_id: event(5), started_by: principal, started_consumer: consumer, started_at: '800', executed_by: principal, executed_consumer: consumer, executed_at: '1000' });
    add('tenant_lifecycle_windows', { tenant_id: tenant, lock_key: String(100 + offset), phase: 'active', generation: '1', claim_id: null, artifact_digest: null });
    add('tenant_lifecycle_operations', { tenant_id: tenant, operation_id: event(6), generation: '1', finished: true,
      owner_pid: 1, owner_birth: '2026-11-07T00:00:00.123456Z' });
    // Historical inactive authority/audit rows test SQL fidelity only. They
    // authorize no current actor and are never imported over live control state.
    add('tenant_lifecycle_restore_authority', { tenant_id: tenant, role_oid: 1, active: false });
    add('tenant_lifecycle_restore_audit', { tenant_id: tenant, claim_id: event(7), generation: '1', artifact_digest: digest,
      role_oid: 1, owner_pid: 1, owner_birth: '2026-11-07T00:00:00.123456Z', state: 'activated',
      started_at: '2026-11-07T00:00:01.123456Z', restored_at: '2026-11-07T00:00:02.123456Z', activated_at: '2026-11-07T00:00:03.123456Z' });
  }
  // Explicit successor only: preserve non-ID insertion order, including gaps and
  // both tenants, so recovery must retain ordinals rather than regenerate them.
  if (profileSocketOrder) rows.profile.forEach((row, index) => { row.insertion_ordinal = ['11', '3', '29', '17'][index]; });
  const { alarmInputs } = require('./tenant-deployment-alarm');
  const { notificationInputs } = require('./tenant-deployment-notifications');
  Object.assign(rows, alarmInputs({ tenants: [A, B], now, writerRole: 'alarm_writer', readerRole: 'alarm_reader' }).rows,
    notificationInputs({ tenants: [A, B], now, outboxRole: 'outbox_writer', checkpointWriterRole: 'checkpoint_writer', ackReaderRole: 'ack_reader' }).rows);
  return rows;
}
module.exports = { A, B, populatedRows };
