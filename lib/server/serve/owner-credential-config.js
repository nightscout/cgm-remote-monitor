'use strict';

const { createVaultTransit } = require('../../secrets/vault-transit');
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const namespace = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
  !['public', 'information_schema'].includes(value) && !value.startsWith('pg_');

// Optional, operator-supplied secrets capability. No secret bytes live in JSON.
module.exports = function ownerCredentialConfig (value, source, existing, invalid = () => {
  throw new TypeError('Invalid explicit owner credential configuration');
}) {
  if (value === undefined) return undefined;
  if (!exact(value, ['connectionEnv', 'namespace', 'vault', 'tenants']) || !namespace(value.namespace) ||
      existing.existingNamespaces.includes(value.namespace) ||
      !exact(value.vault, ['address', 'mount', 'allowInsecureLoopback']) ||
      typeof value.vault.allowInsecureLoopback !== 'boolean' ||
      typeof value.connectionEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.connectionEnv) ||
      typeof source[value.connectionEnv] !== 'string' || !source[value.connectionEnv].trim()) invalid();
  const connectionString = source[value.connectionEnv];
  let url;
  try { url = new URL(connectionString); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 ||
      url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode'))) invalid();
  for (const address of existing.existingConnections) {
    const other = new URL(address);
    let sameUser;
    try { sameUser = decodeURIComponent(url.username) === decodeURIComponent(other.username); } catch { invalid(); }
    if (sameUser || url.hostname !== other.hostname || url.port !== other.port || url.pathname !== other.pathname) invalid();
  }
  if (!Array.isArray(value.tenants) || value.tenants.length !== existing.tenants.length) invalid();
  const providers = new Map(), keys = new Set(), references = new Set();
  for (const tenant of value.tenants) {
    if (!exact(tenant, ['id', 'tokenEnv', 'encryptionKey', 'signingKey', 'signingVersion']) ||
        !existing.tenants.includes(tenant.id) || providers.has(tenant.id) ||
        typeof tenant.tokenEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(tenant.tokenEnv) ||
        references.has(tenant.tokenEnv) || [tenant.encryptionKey, tenant.signingKey].some(key => keys.has(key)) ||
        typeof source[tenant.tokenEnv] !== 'string' || !source[tenant.tokenEnv]) invalid();
    const tokenEnv = tenant.tokenEnv;
    references.add(tokenEnv); keys.add(tenant.encryptionKey); keys.add(tenant.signingKey);
    try {
      providers.set(tenant.id, createVaultTransit({ ...value.vault, ...tenant, getToken: async () => source[tokenEnv] }));
    } catch { invalid(); }
  }
  return { connectionString, namespace: value.namespace, providers, consumer: existing.consumer,
    legacyConnectionString: existing.legacyConnectionString, legacyNamespace: existing.legacyNamespace };
};
