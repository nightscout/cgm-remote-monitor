'use strict';

// Reviewed input preparation only. The actual migration joins at the coherent
// B/C boundary; this module does not import an active peer or enable a role.
const common = require('../../lib/tenant-operations/common');
const SOURCE = 'e9121a6e2e4b857701df8e443d831e794b68c03c';
const FILE = 'migrations/candidates/postgres-alarm-suppression-v1.json';
const DIGEST = '3283a1639af5a43df024a10b72afb550243438eadc4c9b79aaa93021c3d828c8';
const SOURCE_SHA256 = 'c7e6ed04da17ffe0acc01ed399b2caec540e016b2eb14e78fd51baa0149a5258';

function alarmInputs ({ tenants, now, writerRole, readerRole, realtimeRole = null } = {}) {
  if (!Array.isArray(tenants) || tenants.length !== 2 || new Set(tenants).size !== 2 ||
      tenants.some(tenant => typeof tenant !== 'string' || !common.UUID.test(tenant))) throw common.refuse('ALARM_INPUT_TENANTS_INVALID');
  if (!Number.isSafeInteger(now) || now < 1800001 || now + 1800000 >= 8640000000000000) throw common.refuse('ALARM_INPUT_TIME_INVALID');
  const roles = [writerRole, readerRole, ...(realtimeRole === null ? [] : [realtimeRole])];
  if (roles.some(role => typeof role !== 'string' || !common.ROLE.test(role)) || new Set(roles).size !== roles.length) {
    throw common.refuse('ALARM_INPUT_ROLES_INVALID');
  }
  const rows = tenants.flatMap((tenant, index) => [1, 2].map(level => {
    const active = level === index + 1;
    const acked = now - (active ? 1000 : 1800001);
    return { tenant_id: tenant, alarm_group: level === 1 ? 'synthetic_low' : 'synthetic_high', alarm_level: level,
      acked_at: String(acked), expires_at: String(acked + 1800000) };
  }));
  return {
    extension: { kind: 'alarm_suppression', candidatePath: FILE, candidateDigest: DIGEST,
      sourceCommit: SOURCE, sourceSha256: SOURCE_SHA256, tables: ['tenant_alarm_suppression'], secrets: [] },
    rows: { tenant_alarm_suppression: rows },
    acl: { grants: [
      { role: writerRole, kind: 'alarm_suppression', table: 'tenant_alarm_suppression', privileges: ['SELECT', 'INSERT'],
        columnPrivileges: { UPDATE: ['acked_at', 'expires_at'] } },
      { role: readerRole, kind: 'alarm_suppression', table: 'tenant_alarm_suppression', privileges: ['SELECT'] }
    ] }
  };
}

module.exports = { alarmInputs };
