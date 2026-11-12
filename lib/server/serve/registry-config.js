'use strict';

// The `registry` block a role configuration carries in registry mode (decision
// tenant-registry), and the role-level Vault credential that replaces per-tenant
// token references (key names follow lib/tenant-registry/rules.js):
//
//   "registry": { "namespace": "<registry namespace>", "maxTenants": 10000, "refreshMs": 2000 }
//   "vault": { "address", "mount", "tokenFile" | "tokenEnv", "timeoutMs"?, "allowInsecureLoopback"? }
//
// A configuration that carries `registry` refuses a `tenants` list (and any
// other per-tenant list): the registry is the one runtime home for tenants.
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const MAX_TENANTS = require('../../tenant-registry/resolver').MAX_TENANTS;
const REFUSAL = 'registry configuration refuses a tenants list';

function exact (value, required, optional = []) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function registry (value, invalid) {
  if (!exact(value, ['namespace'], ['maxTenants', 'refreshMs']) || typeof value.namespace !== 'string' || !NAME.test(value.namespace) ||
      value.namespace === 'public' || value.namespace === 'information_schema' || value.namespace.startsWith('pg_')) invalid('invalid tenant registry selection');
  const maxTenants = value.maxTenants === undefined ? 10000 : value.maxTenants;
  const refreshMs = value.refreshMs === undefined ? 2000 : value.refreshMs;
  if (!Number.isSafeInteger(maxTenants) || maxTenants < 1 || maxTenants > MAX_TENANTS ||
      !Number.isSafeInteger(refreshMs) || refreshMs < 250 || refreshMs > 60000) invalid('invalid tenant registry bounds');
  return Object.freeze({ namespace: value.namespace, maxTenants, refreshMs });
}

function vault (value, source, invalid) {
  if (!exact(value, ['address', 'mount'], ['tokenFile', 'tokenEnv', 'timeoutMs', 'allowInsecureLoopback']) ||
      (value.tokenFile === undefined) === (value.tokenEnv === undefined) || typeof value.address !== 'string' ||
      typeof value.mount !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.mount) ||
      (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 60000)) ||
      (value.allowInsecureLoopback !== undefined && typeof value.allowInsecureLoopback !== 'boolean')) {
    invalid('registry mode requires one role-level Vault credential (tokenFile or tokenEnv)');
  }
  let getToken;
  if (value.tokenFile !== undefined) {
    const { tokenFilePath, tokenFileReader } = require('../../secrets/vault-token-source');
    getToken = tokenFileReader(tokenFilePath(value.tokenFile, () => invalid('vault tokenFile must be a normalized absolute file path')));
  } else {
    if (typeof value.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.tokenEnv) || typeof source[value.tokenEnv] !== 'string' ||
        !source[value.tokenEnv].trim()) invalid('preview credential environment reference is missing or invalid');
    getToken = async () => source[value.tokenEnv];
  }
  // Validates the origin now; per-tenant providers are built on first use.
  require('../../secrets/vault-transit').createVaultTransit({ address: value.address, mount: value.mount, allowInsecureLoopback: value.allowInsecureLoopback === true,
    timeoutMs: value.timeoutMs === undefined ? 5000 : value.timeoutMs, encryptionKey: 'probe-a', signingKey: 'probe-b', signingVersion: 1, getToken });
  return Object.freeze({ address: value.address, mount: value.mount, getToken, timeoutMs: value.timeoutMs === undefined ? 5000 : value.timeoutMs,
    allowInsecureLoopback: value.allowInsecureLoopback === true });
}

module.exports = { registry, vault, REFUSAL };
