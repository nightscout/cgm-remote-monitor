'use strict';

// Pure reconstruction input, not database/current-authority admission. The
// caller verifies the complete selected catalogue, current profile and retained
// request under its real maintenance claim before writing any returned row.
const { createPrivateKey, createPublicKey } = require('node:crypto');
const artifacts = require('./artifact');
const insertion = require('./insertion-inventory');
const clinical = require('./clinical-catalogue').CLINICAL;
const logical = require('./logical-restore');
const localTokens = require('../tenant-authorization/legacy-data-token');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const INT8 = 9223372036854775807n;
const HISTORY_LIMIT = 8640000000000000n;
const INT4 = 2147483647;
const ordered = new Set(['entries', 'treatments', 'devicestatus', 'profile', 'food']);
const rules = new Map();
const add = (kind, tables, disposition) => tables.forEach(table => rules.set(kind + '.' + table, disposition));
for (const kind of clinical) add(kind, [kind], 'clinical');
for (const kind of ordered) add(kind, ['tenant_insertion_ordinal'], 'counter');
add('clock', ['tenant_write_clock'], 'clock');
add('authorization', ['tenant_authorization_config', 'tenant_authorization_roles', 'tenant_authorization_subjects',
  'tenant_authorization_subject_roles', 'tenant_subject_admin_audit'], 'copy');
add('authorization', ['tenant_owner_policy', 'tenant_owner_actors'], 'current');
add('subject_policy', ['subject_policy'], 'current');
add('subject_policy', ['subject_policy_audit'], 'copy');
add('operator_policy', ['tenant_operator_policy'], 'current');
add('owner_configuration', ['tenant_owner_configuration_authority'], 'current');
add('tenant_settings', ['tenant_settings', 'tenant_settings_history', 'tenant_connector_sources', 'tenant_connector_source_history'], 'copy');
add('secrets', ['secret_records', 'secret_audit'], 'copy');
add('legacy', ['legacy_credential_config'], 'root');
add('legacy', ['legacy_credential_subjects'], 'subject');
add('legacy', ['legacy_data_keys'], 'signer');
add('access', ['access_tenants'], 'current');
add('access', ['access_keys'], 'current');
add('access', ['access_credentials'], 'credential');
add('access', ['access_sessions', 'management_session_requests'], 'reset');
add('human_session', ['human_identities'], 'identity');
add('human_session', ['human_sessions', 'human_access_tokens'], 'reset');
add('human_session', ['human_logout_events'], 'copy');
add('checkpoint', ['tenant_consumer_checkpoint'], 'reset');
add('evaluator_checkpoint', ['tenant_consumer_checkpoint'], 'reset');
add('alarm_suppression', ['tenant_alarm_suppression'], 'copy');
add('notification_outbox', ['tenant_notification_heads', 'tenant_notification_requests', 'tenant_notification_state'], 'reset');

const fail = (code, detail) => { throw artifacts.refuse('LIFECYCLE_RECOMMISSION_' + code, detail); };
function own (value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value)) return value.map(own);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, own(item)]));
  }
  fail('ROW_INVALID');
}
function freeze (value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function decimal (value, code = 'CLOCK_INVALID') {
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) > INT8) fail(code);
  return BigInt(value);
}
function epoch (value) {
  if (!Number.isInteger(value) || value < 1 || value >= INT4) fail('EPOCH_INVALID');
  return value + 1;
}
function clockFloor (tables) {
  const rows = tables['clock.tenant_write_clock'];
  if (!Array.isArray(rows) || rows.length !== 1) fail('CLOCK_REQUIRED');
  const stamp = decimal(rows[0].last_stamp), deleted = decimal(rows[0].last_delete_stamp);
  if (stamp >= HISTORY_LIMIT || deleted > stamp) fail('CLOCK_INVALID');
  return { last_stamp: stamp.toString(), last_delete_stamp: deleted.toString() };
}
function keyBytes (value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('KEY_INVALID');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('KEY_INVALID');
  return bytes;
}
function signingRows (rows, tenant) {
  if (!Array.isArray(rows) || !rows.length) fail('KEY_REQUIRED');
  const seen = new Set();
  let signer;
  for (const row of rows) {
    if (typeof row.kid !== 'string' || !NAME.test(row.kid) || seen.has(row.kid) || typeof row.active !== 'boolean' || typeof row.signing !== 'boolean') fail('KEY_INVALID');
    seen.add(row.kid);
    try {
      const publicBytes = keyBytes(row.public_key);
      const publicKey = createPublicKey({ key: publicBytes, format: 'der', type: 'spki' });
      if (publicKey.asymmetricKeyType !== 'ed25519') fail('KEY_INVALID');
      if (row.private_key !== null) {
        const privateKey = createPrivateKey({ key: keyBytes(row.private_key), format: 'der', type: 'pkcs8' });
        if (privateKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicBytes)) fail('KEY_INVALID');
      }
    } catch { fail('KEY_INVALID'); }
    if (row.signing) {
      if (signer || !row.active || row.private_key === null) fail('KEY_INVALID');
      signer = row;
    }
  }
  if (!signer) fail('KEY_REQUIRED');
  const fresh = localTokens.generateKey();
  if (seen.has(fresh.kid)) fail('KEY_INVALID');
  return [...rows.map(row => ({ ...row, active: false, signing: false, private_key: null })),
    { ...signer, tenant_id: tenant, kid: fresh.kid, public_key: fresh.publicKey, private_key: fresh.privateKey, active: true, signing: true }];
}

function plan (artifact, { tenant, artifactDigest } = {}) {
  artifacts.validateArtifact(artifact);
  if (!UUID.test(tenant || '') || artifact.manifest.tenant !== tenant) fail('TENANT_MISMATCH');
  if (typeof artifactDigest !== 'string' || artifact.digest !== artifactDigest) fail('ARTIFACT_MISMATCH');
  const tables = {}, reset = [], current = [], dispositions = new Map();
  for (const catalogue of artifact.manifest.catalogues) for (const table of catalogue.tables) {
    const key = artifacts.tableKey(catalogue.kind, table.table), disposition = rules.get(key);
    if (!disposition) fail('TABLE_UNSUPPORTED', key);
    dispositions.set(key, disposition);
    tables[key] = own(artifact.tables[key]);
  }
  const floors = { clock: clockFloor(tables), insertion: {} };
  const roots = tables['legacy.legacy_credential_config'];
  if (!Array.isArray(roots) || roots.length !== 1) fail('CREDENTIAL_REQUIRED');
  // Require the captured signer even when an omitted table was rehashed into
  // an otherwise self-consistent artifact. Complete catalogues remain caller-owned.
  const freshKeys = signingRows(tables['legacy.legacy_data_keys'], tenant);
  const management = new Set((tables['access.management_session_requests'] || []).map(row => row.credential_id));
  for (const [key, disposition] of dispositions) {
    const kind = key.slice(0, key.indexOf('.')), rows = tables[key];
    if (disposition === 'reset' || disposition === 'current') {
      (disposition === 'reset' ? reset : current).push(key); delete tables[key];
    } else if (disposition === 'root') {
      tables[key] = rows.map(row => ({ ...row, root_version: epoch(row.root_version) }));
    } else if (disposition === 'subject') {
      tables[key] = rows.map(row => ({ ...row, credential_version: epoch(row.credential_version) }));
    } else if (disposition === 'credential') {
      tables[key] = rows.filter(row => !management.has(row.credential_id) && !/^management_[0-9a-f]{32}$/.test(row.credential_id))
        .map(row => ({ ...row, generation: epoch(row.generation) }));
    } else if (disposition === 'identity') {
      tables[key] = rows.map(row => ({ ...row, generation: epoch(row.generation) }));
    } else if (disposition === 'signer') {
      tables[key] = freshKeys;
    } else if (disposition === 'counter') {
      floors.insertion[kind] = insertion.assertArtifact(artifact, kind).floor;
    } else if (disposition === 'clinical') {
      const hasCounter = dispositions.has(kind + '.' + insertion.COUNTER);
      if (!hasCounter && rows.some(row => Object.hasOwn(row, 'insertion_ordinal'))) fail('COUNTER_REQUIRED', kind);
      logical.planRows({ kind, current: [], desired: rows, ordered: hasCounter });
      for (const row of rows) for (const name of ['srvCreated', 'srvModified']) {
        const value = row.doc[name];
        if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || BigInt(value) >= HISTORY_LIMIT || BigInt(value) > BigInt(floors.clock.last_stamp))) fail('METADATA_AHEAD', kind);
      }
      if (hasCounter) tables[key] = rows.slice().sort((a, b) => BigInt(a.insertion_ordinal) < BigInt(b.insertion_ordinal) ? -1 : 1);
    }
  }
  return freeze({ tables, floors, reset: reset.sort(), current: current.sort() });
}

module.exports = { plan };
