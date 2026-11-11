'use strict';

// Fixed per-tenant names derived from the tenant id (decision tenant-registry):
// nothing per tenant is stored to find them.
//
// Vault Transit key names are `tenant-<purpose>-<tenant uuid>`. The purpose
// comes first so that one role-level ACL can cover every tenant with a prefix
// glob, for example `path "<mount>/decrypt/tenant-data-*"`.
//
// The operation-window advisory lock key is 1 + the first 62 bits of
// sha256('nightscout-tenant-lock-v1:' + id): a positive signed bigint, written
// once into tenant_lifecycle_windows.lock_key (UNIQUE) by provisioning. The
// window's in-transaction check against that row remains the fence.
const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TENANT = '00000000-0000-0000-0000-000000000000';
const PURPOSES = Object.freeze({ data: 'aes256-gcm96', signing: 'aes256-gcm96', access: 'ed25519', management: 'ed25519' });

function tenant (id) {
  if (typeof id !== 'string' || !UUID.test(id) || id === METADATA_TENANT) throw new TypeError('Canonical tenant id required');
  return id;
}
function vaultKey (id, purpose) {
  if (!Object.hasOwn(PURPOSES, purpose)) throw new TypeError('Unknown Vault key purpose');
  return 'tenant-' + purpose + '-' + tenant(id);
}
function lockKey (id) {
  const digest = createHash('sha256').update('nightscout-tenant-lock-v1:' + tenant(id)).digest();
  return String((digest.readBigUInt64BE(0) >> 2n) + 1n);
}

module.exports = { vaultKey, lockKey, tenant, PURPOSES, UUID, METADATA_TENANT };
