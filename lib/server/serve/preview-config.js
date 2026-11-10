'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { createPublicKey } = require('node:crypto');
const createResolver = require('../../tenant-resolution');
const { createVaultTransit } = require('../../secrets/vault-transit');
const { tokenFilePath, tokenFileReader } = require('../../secrets/vault-token-source');
const { readRaw } = require('./listeners');
const domainsCatalogue = require('../tenant-app/domain-catalogue');

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
  fields(config, ['version', 'postgres', 'vault', 'resolution', 'tenants'], ['domains', 'legacy', 'context', 'accessTokens', 'writeClock', 'tenantSettings', 'socketForwarding', 'subjectAdmin']);
  if (config.writeClock !== undefined && config.writeClock !== true) invalid('writeClock must be explicitly true or omitted');
  if (config.version !== 1) invalid('unsupported preview configuration version');
  fields(config.postgres, ['connectionEnv', 'readinessConnectionEnv', 'namespaces']);
  const namespaces = config.postgres.namespaces;
  const domains = config.domains === undefined ? ['entries'] : config.domains;
  if (!Array.isArray(domains) || !domains.includes('entries') || new Set(domains).size !== domains.length ||
      domains.some(name => !domainsCatalogue.names.includes(name)) ||
      ['legacy', 'context'].some(key => config[key] !== undefined && typeof config[key] !== 'boolean')) {
    invalid('preview requires an explicit unique list of implemented domains');
  }
  if (config.legacy && domainsCatalogue.legacyNames.some(name => !domains.includes(name))) {
    invalid('legacy preview requires every runtime snapshot domain explicitly');
  }
  fields(namespaces, ['entries', 'authorization', 'secrets', 'legacy', ...domains.filter(name => name !== 'entries'),
    ...(config.accessTokens === undefined ? [] : ['access']), ...(config.writeClock ? ['clock'] : [])]);
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
  let subjectAdmin;
  if (config.subjectAdmin !== undefined) {
    // Root (API_SECRET) subject administration: a separate writer identity on the
    // same database, never the serving or readiness identity.
    fields(config.subjectAdmin, ['writerConnectionEnv', 'ownerPolicy']);
    fields(config.subjectAdmin.ownerPolicy, ['catalogue']);
    try { require('../../subject-admin/owner-policy').catalogueDigest(config.subjectAdmin.ownerPolicy.catalogue); }
    catch { invalid('invalid root subject administration catalogue'); }
    const writerConnectionString = reference(config.subjectAdmin.writerConnectionEnv, source);
    const writer = database(writerConnectionString);
    if ([serving, readiness].some(url => url.username === writer.username) || writer.hostname !== serving.hostname ||
        writer.port !== serving.port || writer.pathname !== serving.pathname) {
      invalid('root subject administration requires a separate writer identity on the same database');
    }
    subjectAdmin = { connectionString: writerConnectionString, ownerPolicy: { catalogue: config.subjectAdmin.ownerPolicy.catalogue.slice() } };
  }
  const tenantSettings = require('./settings-config')(config.tenantSettings, source, {
    namespaces, connections: [connectionString, readinessConnectionString]
  }, { invalid: () => invalid('invalid explicit presentation settings reader') });
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
  const aliases = [], internalNames = [], providers = new Map(), bindings = new Map(), environments = new Map();
  const providerKeys = new Set(), tokenReferences = new Set();
  for (const tenant of config.tenants) {
    fields(tenant, ['id', 'aliases', 'vault'],
      [...(mode === 'canonical-internal' ? ['canonicalHost'] : []), 'settings', 'extendedSettings']);
    for (const key of ['settings', 'extendedSettings']) {
      if (tenant[key] !== undefined && (!tenant[key] || typeof tenant[key] !== 'object' || Array.isArray(tenant[key]))) {
        invalid('tenant client settings must be an object');
      }
    }
    if (tenantSettings && require('../tenant-app/environment').CLIENT_KEYS.concat(['enable', 'thresholds']).some(key => Object.hasOwn(tenant.settings || {}, key))) {
      invalid('selected tenant settings requires explicit migration of static projected settings');
    }
    if (typeof tenant.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant.id) ||
        bindings.has(tenant.id) || !Array.isArray(tenant.aliases) ||
        (mode === 'direct-alias' && !tenant.aliases.length)) invalid('invalid or duplicate preview tenant binding');
    fields(tenant.vault, ['encryptionKey', 'signingKey', 'signingVersion'], ['tokenEnv', 'tokenFile']);
    // Exactly one credential source per tenant: an environment reference resolved at
    // bootstrap, or a Vault Agent sink file read at every call. Never both, never neither.
    if ((tenant.vault.tokenEnv === undefined) === (tenant.vault.tokenFile === undefined)) {
      invalid('preview tenant vault requires exactly one of tokenEnv or tokenFile');
    }
    if ((tenant.vault.tokenEnv !== undefined && tokenReferences.has(tenant.vault.tokenEnv)) ||
        [tenant.vault.encryptionKey, tenant.vault.signingKey].some(key => providerKeys.has(key))) {
      invalid('preview tenants require separate provider keys and token environment references');
    }
    providerKeys.add(tenant.vault.encryptionKey);
    providerKeys.add(tenant.vault.signingKey);
    let getToken;
    if (tenant.vault.tokenEnv !== undefined) {
      tokenReferences.add(tenant.vault.tokenEnv);
      reference(tenant.vault.tokenEnv, source);
      getToken = async () => reference(tenant.vault.tokenEnv, source);
    } else {
      // Several tenants may share one sink: one Agent, one login, one token.
      getToken = tokenFileReader(tokenFilePath(tenant.vault.tokenFile,
        () => invalid('preview vault tokenFile must be a normalized absolute file path')));
    }
    const provider = createVaultTransit({
      ...config.vault,
      encryptionKey: tenant.vault.encryptionKey,
      signingKey: tenant.vault.signingKey,
      signingVersion: tenant.vault.signingVersion,
      getToken
    });
    providers.set(tenant.id, provider);
    bindings.set(tenant.id, Object.freeze({ tenant: tenant.id, principal: 'preview-api', consumer: 'tenant-api' }));
    environments.set(tenant.id, require('../tenant-app/environment')({
      settings: tenant.settings, extendedSettings: tenant.extendedSettings
    }));
    aliases.push(...tenant.aliases.map(host => ({ host, tenant: tenant.id })));
    if (mode === 'canonical-internal') internalNames.push({ host: tenant.canonicalHost, tenant: tenant.id });
  }
  const socketForwarding = require('../realtime/private-config')(config.socketForwarding, source, {
    namespaces, connections: [connectionString, readinessConnectionString]
  });
  if (socketForwarding && (!config.writeClock || !config.legacy)) invalid('socket forwarding requires explicit legacy domains and write clock');
  const resolver = createResolver(mode === 'direct-alias' ? { aliases } : {
    mode, aliases, internalNames,
    // Neither X-Forwarded-For nor Express trust-proxy participates in this decision.
    trustedProxy: req => !!req.socket && trustedPeers.includes(req.socket.remoteAddress)
  });
  let accessTokens;
  if (config.accessTokens !== undefined) {
    fields(config.accessTokens, ['issuer', 'audience', 'keys']);
    const { issuer, audience, keys } = config.accessTokens;
    if (![issuer, audience].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) ||
        !Array.isArray(keys) || !keys.length || keys.length > 10000) invalid('invalid local token trust policy');
    const trustedKeys = new Map();
    const publicMaterial = new Set();
    for (const key of keys) {
      fields(key, ['tenant', 'kid', 'publicKey']);
      if (!bindings.has(key.tenant) || typeof key.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) ||
          typeof key.publicKey !== 'string') invalid('invalid local token key binding');
      const bytes = Buffer.from(key.publicKey, 'base64');
      if (bytes.length !== 32 || bytes.toString('base64') !== key.publicKey) invalid('invalid local token public key');
      const id = key.tenant + ':' + key.kid;
      if (trustedKeys.has(id) || publicMaterial.has(key.publicKey)) invalid('duplicate local token key binding or material');
      publicMaterial.add(key.publicKey);
      trustedKeys.set(id, Object.freeze({ tenant: key.tenant, kid: key.kid, issuer, purpose: 'data',
        publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') } }) }));
    }
    accessTokens = { issuer, audience, purpose: 'data', maxLifetimeSeconds: 28800,
      resolveKey: (tenant, kid) => trustedKeys.get(tenant + ':' + kid) };
  }
  return { namespaces, domains, writeClock: config.writeClock === true, legacyEnabled: config.legacy === true, contextEnabled: config.context === true,
    aliases, socketForwarding, environments, connectionString, readinessConnectionString, serving, readiness, providers, bindings, resolver, accessTokens, tenantSettings, subjectAdmin };
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
