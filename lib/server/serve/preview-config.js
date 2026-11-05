'use strict';

const fs = require('node:fs');
const net = require('node:net');
const createResolver = require('../../tenant-resolution');
const { createVaultTransit } = require('../../secrets/vault-transit');
const { readRaw } = require('./listeners');

class PreviewConfigError extends Error {}

function invalid (message) {
  throw new PreviewConfigError(message);
}

function fields (value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    invalid('invalid preview configuration fields');
  }
}

function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
      typeof source[name] !== 'string' || !source[name].trim()) {
    invalid('preview credential environment reference is missing or invalid');
  }
  return source[name];
}

function database (value) {
  let url;
  try { url = new URL(value); } catch { invalid('invalid preview PostgreSQL connection reference'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 ||
      (url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode')))) {
    invalid('invalid preview PostgreSQL connection reference');
  }
  return url;
}

function load (source) {
  const file = readRaw(source, 'MULTITENANT_PREVIEW_CONFIG');
  if (!file) invalid('api requires MULTITENANT_PREVIEW_CONFIG (explicit preview JSON file)');
  let config;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1048576) invalid('preview configuration must be a bounded regular file');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 1048576) invalid('preview configuration is too large');
    config = JSON.parse(bytes.toString('utf8'));
  } catch { invalid('cannot read valid preview JSON configuration'); }
  fields(config, ['version', 'postgres', 'vault', 'resolution', 'tenants']);
  if (config.version !== 1) invalid('unsupported preview configuration version');
  fields(config.postgres, ['connectionEnv', 'readinessConnectionEnv', 'namespaces']);
  const namespaces = config.postgres.namespaces;
  fields(namespaces, ['entries', 'authorization', 'secrets', 'legacy']);
  const names = Object.values(namespaces);
  if (new Set(names).size !== names.length || names.some(name =>
    typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name) ||
    name === 'public' || name.startsWith('pg_') || name === 'information_schema')) {
    invalid('preview requires distinct explicit non-system namespaces');
  }
  const connectionString = reference(config.postgres.connectionEnv, source);
  const readinessConnectionString = reference(config.postgres.readinessConnectionEnv, source);
  const serving = database(connectionString), readiness = database(readinessConnectionString);
  if (serving.username === readiness.username || serving.hostname !== readiness.hostname ||
      serving.port !== readiness.port || serving.pathname !== readiness.pathname) {
    invalid('preview requires separate serving and read-only readiness identities on the same database');
  }
  fields(config.vault, ['address', 'mount'], ['allowInsecureLoopback', 'timeoutMs']);
  if (config.vault.allowInsecureLoopback !== undefined && typeof config.vault.allowInsecureLoopback !== 'boolean') {
    invalid('invalid preview loopback opt-in');
  }
  fields(config.resolution, ['mode'], ['trustedPeers']);
  const { mode, trustedPeers } = config.resolution;
  if (!['direct-alias', 'canonical-internal'].includes(mode) ||
      (mode === 'direct-alias' && trustedPeers !== undefined) ||
      (mode === 'canonical-internal' && (!Array.isArray(trustedPeers) || !trustedPeers.length ||
        trustedPeers.some(peer => typeof peer !== 'string' || !net.isIP(peer))))) {
    invalid('canonical preview requires an explicit exact immediate-socket peer IP allowlist; direct mode has no proxy trust');
  }
  if (!Array.isArray(config.tenants) || !config.tenants.length) invalid('preview requires configured tenants');
  const aliases = [], internalNames = [], providers = new Map(), bindings = new Map();
  const providerKeys = new Set(), tokenReferences = new Set();
  for (const tenant of config.tenants) {
    fields(tenant, ['id', 'aliases', 'vault'], mode === 'canonical-internal' ? ['canonicalHost'] : []);
    if (typeof tenant.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant.id) ||
        bindings.has(tenant.id) || !Array.isArray(tenant.aliases) ||
        (mode === 'direct-alias' && !tenant.aliases.length)) invalid('invalid or duplicate preview tenant binding');
    fields(tenant.vault, ['tokenEnv', 'encryptionKey', 'signingKey', 'signingVersion']);
    if (tokenReferences.has(tenant.vault.tokenEnv) ||
        [tenant.vault.encryptionKey, tenant.vault.signingKey].some(key => providerKeys.has(key))) {
      invalid('preview tenants require separate provider keys and token environment references');
    }
    tokenReferences.add(tenant.vault.tokenEnv);
    providerKeys.add(tenant.vault.encryptionKey);
    providerKeys.add(tenant.vault.signingKey);
    reference(tenant.vault.tokenEnv, source);
    const provider = createVaultTransit({
      ...config.vault,
      encryptionKey: tenant.vault.encryptionKey,
      signingKey: tenant.vault.signingKey,
      signingVersion: tenant.vault.signingVersion,
      getToken: async () => reference(tenant.vault.tokenEnv, source)
    });
    providers.set(tenant.id, provider);
    bindings.set(tenant.id, Object.freeze({ tenant: tenant.id, principal: 'preview-api', consumer: 'tenant-api' }));
    aliases.push(...tenant.aliases.map(host => ({ host, tenant: tenant.id })));
    if (mode === 'canonical-internal') internalNames.push({ host: tenant.canonicalHost, tenant: tenant.id });
  }
  const resolver = createResolver(mode === 'direct-alias' ? { aliases } : {
    mode, aliases, internalNames,
    // Neither X-Forwarded-For nor Express trust-proxy participates in this decision.
    trustedProxy: req => !!req.socket && trustedPeers.includes(req.socket.remoteAddress)
  });
  return { namespaces, connectionString, readinessConnectionString, serving, readiness, providers, bindings, resolver };
}

module.exports = {
  load (source) {
    try { return load(source); } catch (error) {
      if (error instanceof PreviewConfigError) throw error;
      throw new PreviewConfigError('invalid preview tenant, provider or ingress configuration');
    }
  },
  PreviewConfigError
};
