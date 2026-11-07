'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { createPublicKey } = require('node:crypto');
const { readRaw } = require('./listeners');
const { PreviewConfigError } = require('./preview-config');
const createResolver = require('../../tenant-resolution');
const { catalogueDigest } = require('../../subject-admin/owner-policy');
const invalid = () => { throw new PreviewConfigError('invalid explicit headless owner preview configuration'); };
function fields (value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function reference (name, source) {
  if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || typeof source[name] !== 'string' || !source[name].trim()) invalid();
  return source[name];
}
function database (value) {
  let url; try { url = new URL(value); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(key => key !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 ||
      (url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode')))) invalid();
  return url;
}
function parse (config, source) {
  fields(config, ['version', 'postgres', 'resolution', 'tenants', 'management', 'ownerPolicy'], ['ownerSettings']);
  if (config.version !== 1) invalid();
  fields(config.postgres, ['writerConnectionEnv', 'accessConnectionEnv', 'namespaces']);
  const namespaces = config.postgres.namespaces;
  fields(namespaces, ['authorization', 'credentials', 'access']);
  const names = Object.values(namespaces);
  if (new Set(names).size !== 3 || names.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name) ||
      name === 'public' || name === 'information_schema' || name.startsWith('pg_'))) invalid();
  const writerConnectionString = reference(config.postgres.writerConnectionEnv, source);
  const accessConnectionString = reference(config.postgres.accessConnectionEnv, source);
  const writer = database(writerConnectionString), access = database(accessConnectionString);
  if (writer.username === access.username || writer.hostname !== access.hostname || writer.port !== access.port || writer.pathname !== access.pathname) invalid();
  const ownerSettings = require('./settings-config')(config.ownerSettings, source, {
    namespaces, connections: [writerConnectionString, accessConnectionString]
  }, { owner: true, invalid });
  fields(config.ownerPolicy, ['catalogue']); catalogueDigest(config.ownerPolicy.catalogue);
  fields(config.resolution, ['mode'], ['trustedPeers']);
  const { mode, trustedPeers } = config.resolution;
  if (!['direct-alias', 'canonical-internal'].includes(mode) || mode === 'direct-alias' && trustedPeers !== undefined ||
      mode === 'canonical-internal' && (!Array.isArray(trustedPeers) || !trustedPeers.length || trustedPeers.some(peer => !net.isIP(peer)))) invalid();
  if (!Array.isArray(config.tenants) || !config.tenants.length) invalid();
  const tenants = new Set(), aliases = [], internalNames = [];
  for (const tenant of config.tenants) {
    fields(tenant, ['id', 'aliases'], mode === 'canonical-internal' ? ['canonicalHost'] : []);
    if (typeof tenant.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant.id) ||
        tenants.has(tenant.id) || !Array.isArray(tenant.aliases) || mode === 'direct-alias' && !tenant.aliases.length) invalid();
    tenants.add(tenant.id); aliases.push(...tenant.aliases.map(host => ({ host, tenant: tenant.id })));
    if (mode === 'canonical-internal') internalNames.push({ host: tenant.canonicalHost, tenant: tenant.id });
  }
  const resolver = createResolver(mode === 'direct-alias' ? { aliases } : { mode, aliases, internalNames,
    trustedProxy: req => !!req.socket && trustedPeers.includes(req.socket.remoteAddress) });
  fields(config.management, ['issuer', 'audience', 'purpose', 'keys', 'consumer'], ['maxLifetimeSeconds']);
  const { issuer, audience, purpose, consumer, keys } = config.management;
  const lifetime = config.management.maxLifetimeSeconds === undefined ? 600 : config.management.maxLifetimeSeconds;
  if (![issuer, audience].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256) ||
      purpose !== 'management' || typeof consumer !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(consumer) ||
      !Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > 600 || !Array.isArray(keys) || !keys.length || keys.length > 10000) invalid();
  const trusted = new Map(), material = new Set();
  for (const key of keys) {
    fields(key, ['tenant', 'kid', 'publicKey']);
    if (!tenants.has(key.tenant) || typeof key.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) || typeof key.publicKey !== 'string') invalid();
    const bytes = Buffer.from(key.publicKey, 'base64'), id = key.tenant + ':' + key.kid;
    if (bytes.length !== 32 || bytes.toString('base64') !== key.publicKey || trusted.has(id) || material.has(key.publicKey)) invalid();
    material.add(key.publicKey);
    trusted.set(id, Object.freeze({ tenant: key.tenant, kid: key.kid, issuer, purpose,
      publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') } }) }));
  }
  return { namespaces, writerConnectionString, accessConnectionString, resolver, consumer, ownerSettings,
    ownerPolicy: { catalogue: config.ownerPolicy.catalogue.slice() },
    verification: { issuer, audience, purpose, maxLifetimeSeconds: lifetime, resolveKey: (tenant, kid) => trusted.get(tenant + ':' + kid) } };
}
function load (source) {
  const file = readRaw(source, 'MULTITENANT_OWNER_PREVIEW_CONFIG');
  if (!file) throw new PreviewConfigError('tenant-admin requires MULTITENANT_OWNER_PREVIEW_CONFIG (explicit headless preview JSON file)');
  try {
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 1048576) invalid();
    const bytes = fs.readFileSync(file); if (bytes.length > 1048576) invalid();
    return parse(JSON.parse(bytes.toString('utf8')), source);
  } catch { invalid(); }
}
module.exports = { load, parse };
