'use strict';

const { isIP } = require('node:net');

function refuse (code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hostname (value) {
  if (typeof value !== 'string' || value.length > 259 || /[^a-zA-Z0-9.:-]/.test(value)) {
    throw refuse('TENANT_HOST_INVALID');
  }
  const parts = value.split(':');
  if (parts.length > 2 || (parts.length === 2 &&
      (!/^[0-9]{1,5}$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > 65535))) {
    throw refuse('TENANT_HOST_INVALID');
  }
  const host = parts[0].toLowerCase();
  if (!host || host.length > 253 || isIP(host) || host.split('.').some(label =>
    label.length > 63 || !/^[a-z0-9-]+$/.test(label) || label.startsWith('-') || label.endsWith('-'))) {
    throw refuse('TENANT_HOST_INVALID');
  }
  return host;
}

function tenantId (value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[^a-zA-Z0-9_-]/.test(value)) {
    throw refuse('TENANT_ID_INVALID');
  }
  return value;
}

function selectors (request) {
  // Node's normalized headers can hide duplicate Host fields. Read the wire list.
  if (!request || !Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 !== 0) {
    throw refuse('TENANT_HEADERS_INVALID');
  }
  const values = new Map();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i];
    if (typeof name !== 'string') throw refuse('TENANT_HEADERS_INVALID');
    const key = name.toLowerCase();
    if (key !== 'host' && key !== 'x-forwarded-host' && key !== 'x-resolved-tenant') continue;
    if (values.has(key)) throw refuse('TENANT_SELECTOR_DUPLICATE');
    const value = request.rawHeaders[i + 1];
    if (typeof value !== 'string' || !value || value.includes(',')) throw refuse('TENANT_SELECTOR_INVALID');
    values.set(key, value);
  }
  return values;
}

function createResolver (options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Invalid tenant resolution configuration');
  }
  const { mode = 'direct-alias', aliases, internalNames, trustedProxy } = options;
  if (mode !== 'direct-alias' && mode !== 'canonical-internal') {
    throw new TypeError('Invalid tenant resolution mode');
  }
  const allowed = mode === 'direct-alias'
    ? ['mode', 'aliases', 'trustedProxy']
    : ['mode', 'aliases', 'internalNames', 'trustedProxy'];
  if (Object.keys(options).some(key => !allowed.includes(key))) {
    throw new TypeError('Invalid tenant resolution configuration');
  }
  if (mode === 'direct-alias' && internalNames !== undefined) {
    throw new TypeError('Internal names require canonical-internal mode');
  }
  const predicate = trustedProxy === undefined && mode === 'direct-alias'
    ? () => false
    : trustedProxy;
  if (typeof predicate !== 'function') {
    throw new TypeError('Tenant resolution requires a trusted-proxy predicate');
  }

  function hostMap (entries, duplicateCode, requireNoPort = false) {
    const hosts = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('Invalid tenant host mapping');
      }
      const host = hostname(entry.host);
      if (requireNoPort && entry.host.includes(':')) throw refuse('TENANT_HOST_INVALID');
      const tenant = tenantId(entry.tenant);
      if (hosts.has(host)) throw refuse(duplicateCode);
      hosts.set(host, tenant);
    }
    return hosts;
  }

  let hosts;
  let publicAliases;
  if (mode === 'direct-alias') {
    if (!Array.isArray(aliases) || aliases.length === 0) {
      throw new TypeError('Tenant resolution requires aliases');
    }
    hosts = hostMap(aliases, 'TENANT_ALIAS_DUPLICATE');
  } else {
    if (!Array.isArray(internalNames) || internalNames.length === 0 ||
        !Object.hasOwn(options, 'trustedProxy') || typeof trustedProxy !== 'function') {
      throw new TypeError('Canonical tenant resolution requires internal names and a trusted-proxy predicate');
    }
    hosts = hostMap(internalNames, 'TENANT_INTERNAL_NAME_DUPLICATE', true);
    const canonicalTenants = new Set();
    for (const tenant of hosts.values()) {
      if (canonicalTenants.has(tenant)) throw refuse('TENANT_CANONICAL_NAME_DUPLICATE');
      canonicalTenants.add(tenant);
    }
    if (aliases !== undefined && !Array.isArray(aliases)) {
      throw new TypeError('Tenant public aliases must be an array');
    }
    publicAliases = aliases === undefined
      ? new Map()
      : hostMap(aliases, 'TENANT_ALIAS_DUPLICATE');
    for (const host of hosts.keys()) {
      if (publicAliases.has(host)) throw refuse('TENANT_HOST_AMBIGUOUS');
    }
    for (const tenant of publicAliases.values()) {
      if (!canonicalTenants.has(tenant)) throw refuse('TENANT_CANONICAL_NAME_MISSING');
    }
  }

  return Object.freeze({
    resolve (request) {
      const values = selectors(request);
      const host = hostname(values.get('host'));
      const forwarded = values.get('x-forwarded-host');
      const resolved = values.get('x-resolved-tenant');
      if (mode === 'canonical-internal') {
        const forwardedHost = forwarded === undefined ? undefined : hostname(forwarded);
        const assertedTenant = resolved === undefined ? undefined : tenantId(resolved);
        let trusted;
        try {
          trusted = predicate(request);
        } catch {
          throw new Error('Tenant trust decision unavailable');
        }
        if (trusted !== true) throw refuse('TENANT_PROXY_UNTRUSTED');
        const tenant = hosts.get(host);
        if (tenant === undefined) throw refuse('TENANT_HOST_UNKNOWN');
        if (forwardedHost !== undefined && publicAliases.has(forwardedHost) &&
            publicAliases.get(forwardedHost) !== tenant) {
          throw refuse('TENANT_SELECTOR_CONFLICT');
        }
        if (assertedTenant !== undefined && assertedTenant !== tenant) {
          throw refuse('TENANT_SELECTOR_CONFLICT');
        }
        return tenant;
      }
      if ((forwarded !== undefined || resolved !== undefined) && predicate(request) !== true) {
        throw refuse('TENANT_PROXY_UNTRUSTED');
      }
      const publicHost = forwarded === undefined ? host : hostname(forwarded);
      const tenant = hosts.get(publicHost);
      if (tenant === undefined) throw refuse('TENANT_HOST_UNKNOWN');
      if (resolved !== undefined && tenantId(resolved) !== tenant) throw refuse('TENANT_SELECTOR_CONFLICT');
      return tenant;
    }
  });
}

module.exports = createResolver;
// The registry resolver (lib/tenant-registry/resolver.js) applies the same
// header, host and id rules before any lookup.
module.exports.selectors = selectors;
module.exports.hostname = hostname;
module.exports.tenantId = tenantId;
module.exports.refuse = refuse;
