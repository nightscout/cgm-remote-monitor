'use strict';

const net = require('node:net');
const domainsCatalogue = require('../tenant-app/domain-catalogue');

const { PreviewConfigError } = require('./preview-config-error');

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

// The api configuration, built from the environment (lib/server/serve/deployment-settings.js).
function load (raw) {
  const source = require('./deployment-settings').withSecrets(raw);
  return parse(require('./deployment-settings').configuration('api', source), source);
}

function parse (config, source) {
  // Registry mode (decision tenant-registry): tenants come from the registry,
  // never from this file; a configuration naming both is refused.
  const registryMode = config && typeof config === 'object' && Object.hasOwn(config, 'registry');
  if (!registryMode || Object.hasOwn(config, 'tenants')) invalid(require('./registry-config').REFUSAL);
  fields(config, ['version', 'postgres', 'vault', 'resolution', 'registry'], ['domains', 'legacy', 'context', 'accessTokens', 'writeClock', 'tenantSettings', 'socketForwarding', 'subjectAdmin', 'activity', 'localDataAuthentication']);
  if (config.localDataAuthentication !== undefined && (config.localDataAuthentication !== 'node' || !registryMode || !config.accessTokens)) {
    invalid('localDataAuthentication requires node, registry mode and an explicit accessTokens realm');
  }
  if (config.writeClock !== true) throw Object.assign(new PreviewConfigError(
    'API_WRITE_CLOCK_REQUIRED: multitenant API serving requires writeClock: true'), { code: 'API_WRITE_CLOCK_REQUIRED' });
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
    ...(config.accessTokens === undefined ? [] : ['access']), 'clock']);
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
    // Decision root-grant-ceiling-default-all: every tenant data permission ('*')
    // unless the operator narrows the deployment catalogue. The policy row's
    // digest and ceiling must match what the operator provisioned.
    fields(config.subjectAdmin, ['writerConnectionEnv'], ['ownerPolicy']);
    const catalogue = config.subjectAdmin.ownerPolicy === undefined ? ['*'] : config.subjectAdmin.ownerPolicy.catalogue;
    if (config.subjectAdmin.ownerPolicy !== undefined) fields(config.subjectAdmin.ownerPolicy, ['catalogue']);
    try { require('../../subject-admin/owner-policy').catalogueDigest(catalogue); }
    catch { invalid('invalid root subject administration catalogue'); }
    const writerConnectionString = reference(config.subjectAdmin.writerConnectionEnv, source);
    const writer = database(writerConnectionString);
    if ([serving, readiness].some(url => url.username === writer.username) || writer.hostname !== serving.hostname ||
        writer.port !== serving.port || writer.pathname !== serving.pathname) {
      invalid('root subject administration requires a separate writer identity on the same database');
    }
    subjectAdmin = { connectionString: writerConnectionString, ownerPolicy: { catalogue: catalogue.slice() } };
  }
  const tenantSettings = require('./settings-config')(config.tenantSettings, source, {
    namespaces, connections: [connectionString, readinessConnectionString]
  }, { invalid: () => invalid('invalid explicit presentation settings reader') });
  // API activity reads share the API's tenant-bound serving connection.
  let activity;
  if (config.activity !== undefined) {
    fields(config.activity, ['namespace']);
    const namespace = config.activity.namespace;
    if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
        ['public', 'information_schema'].includes(namespace) || namespace.startsWith('pg_') || names.includes(namespace)) {
      invalid('invalid API activity namespace');
    }
    activity = Object.freeze({ namespace });
  }
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
  if (registryMode) {
    const selection = require('./registry-config');
    // Per-tenant settings come from the tenant settings store; socket
    // admission and human OIDC origins come from registered aliases.
    if (!tenantSettings) invalid('registry mode requires the tenant settings reader (tenantSettings)');
    const socketForwarding = require('../realtime/private-config')(config.socketForwarding, source, {
      namespaces, connections: [connectionString, readinessConnectionString], registry: true });
    if (socketForwarding && config.legacy !== true) invalid('socket forwarding requires explicit legacy domains');
    let accessTokens;
    if (config.accessTokens !== undefined) {
      if (Object.hasOwn(config.accessTokens || {}, 'keys')) invalid(selection.REFUSAL);
      fields(config.accessTokens, ['issuer', 'audience']);
      const { issuer, audience } = config.accessTokens;
      if (![issuer, audience].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)) invalid('invalid local token trust policy');
      accessTokens = { issuer, audience, purpose: 'data', maxLifetimeSeconds: 28800 };
    }
    return { namespaces, domains, writeClock: true, legacyEnabled: config.legacy === true, contextEnabled: config.context === true,
      registry: selection.registry(config.registry, invalid), registryVault: selection.vault(config.vault, source, invalid),
      resolution: Object.freeze({ mode, ...(mode === 'canonical-internal' ? { trustedPeers: trustedPeers.slice() } : {}) }),
      aliases: null, socketForwarding, environments: null, connectionString, readinessConnectionString, serving, readiness,
      providers: null, bindings: null, resolver: null, tenantIds: ['registry:' + config.registry.namespace], accessTokens, tenantSettings, subjectAdmin, activity, localDataAuthentication: config.localDataAuthentication === 'node' };
  }
}

const guarded = fn => (...args) => {
  try { return fn(...args); } catch (error) {
    if (error instanceof PreviewConfigError) throw error;
    throw new PreviewConfigError('invalid preview tenant, provider or ingress configuration');
  }
};
module.exports = {
  load: guarded(load),
  parse: guarded(parse),
  PreviewConfigError
};
