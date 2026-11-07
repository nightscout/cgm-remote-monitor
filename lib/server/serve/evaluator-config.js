'use strict';

// Operator-trusted preview configuration, independent of human authorization and
// the presentation-only owner settings store. Read afresh at every cycle.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const environment = require('../tenant-app/environment');
const domains = require('../../data/tenant-projection-evaluator').domains;
const { PreviewConfigError } = require('./preview-config');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const identity = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const invalid = () => { throw new PreviewConfigError('invalid explicit evaluator preview configuration'); };
const exact = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = n => Number.isSafeInteger(n) && n >= 1;

function parse (value, source) {
  const required = ['version', 'postgres', 'consumer', 'pageSize', 'maxRows', 'maxBytes', 'maxTenants',
    'recoveryIntervalMs', 'timeIntervalMs', 'tenants'];
  if (!exact(value, required, ['consumers', 'socketOrderDomains']) || value.version !== 1 ||
      !['pageSize', 'maxRows', 'maxBytes', 'maxTenants', 'recoveryIntervalMs', 'timeIntervalMs'].every(k => integer(value[k])) ||
      value.pageSize > value.maxRows || value.recoveryIntervalMs > 2147483647 || value.timeIntervalMs > 2147483647 ||
      typeof value.consumer !== 'string' || !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(value.consumer) ||
      !exact(value.postgres, ['connectionEnv', 'namespaces']) ||
      !exact(value.postgres.namespaces, [...domains, 'clock', 'checkpoint'])) invalid();
  const namespaces = value.postgres.namespaces, names = Object.values(namespaces);
  if (new Set(names).size !== names.length || names.some(name => typeof name !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(name) || ['public', 'information_schema'].includes(name) || name.startsWith('pg_'))) invalid();
  const reference = value.postgres.connectionEnv;
  if (typeof reference !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference) || typeof source[reference] !== 'string') invalid();
  const connectionString = source[reference];
  let url;
  try { url = new URL(connectionString); } catch { invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
      !url.pathname.slice(1) || url.hash || [...url.searchParams.keys()].some(k => k !== 'sslmode') ||
      url.searchParams.getAll('sslmode').length > 1 || url.search && !['disable', 'verify-full'].includes(url.searchParams.get('sslmode'))) invalid();
  if (!Array.isArray(value.tenants) || !value.tenants.length || value.tenants.length > value.maxTenants) invalid();
  const tenants = new Map();
  for (const tenant of value.tenants) {
    if (!exact(tenant, ['id', 'revision', 'settings'], ['extendedSettings']) || typeof tenant.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant.id) || tenants.has(tenant.id) ||
        typeof tenant.revision !== 'string' || !tenant.revision.length || tenant.revision.length > 128 ||
        !tenant.settings || typeof tenant.settings !== 'object' || Array.isArray(tenant.settings)) invalid();
    const env = environment(tenant);
    // Refuse unsupported/mistyped input rather than pretending it is effective.
    if (!isDeepStrictEqual(tenant.settings, env.settings.filteredSettings(tenant.settings)) ||
        tenant.extendedSettings !== undefined && !isDeepStrictEqual(tenant.extendedSettings, env.extendedSettings)) invalid();
    const effective = { revision: tenant.revision, settings: env.settings.filteredSettings(env.settings),
      extendedSettings: env.extendedSettings, plugins: [...env.settings.enable] };
    tenants.set(tenant.id, Object.freeze({ tenant: tenant.id, revision: tenant.revision, identity: identity(effective), env }));
  }
  const consumers = require('./evaluator-consumer-config')(value.consumers, source, namespaces, connectionString);
  if (value.socketOrderDomains !== undefined && (!Array.isArray(value.socketOrderDomains) ||
      new Set(value.socketOrderDomains).size !== value.socketOrderDomains.length ||
      value.socketOrderDomains.some(domain => !['treatments', 'devicestatus', 'profile'].includes(domain)))) invalid();
  const infrastructure = { ...value }; delete infrastructure.tenants;
  return { ...value, namespaces, connectionString, tenants, consumers,
    infrastructure: identity([infrastructure, connectionString, consumers]) };
}

function load (source) {
  const file = source.MULTITENANT_EVALUATOR_CONFIG;
  if (typeof file !== 'string' || !file) invalid();
  function read () {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1048576) invalid();
      const bytes = fs.readFileSync(file); if (bytes.length > 1048576) invalid();
      return parse(JSON.parse(bytes.toString('utf8')), source);
    } catch { invalid(); }
  }
  const initial = read();
  return Object.freeze({ ...initial, async readCurrent (tenant) {
    const current = read();
    if (current.infrastructure !== initial.infrastructure || [...current.tenants.keys()].some(id => !initial.tenants.has(id))) {
      throw new PreviewConfigError('evaluator preview infrastructure or tenant expansion requires restart');
    }
    return current.tenants.get(tenant) || null;
  } });
}
module.exports = { load, parse };
