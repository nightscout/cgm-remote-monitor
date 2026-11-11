'use strict';

// Explicit preview socket allowlist, NOT full D15 tenant suspension/lifecycle.
// It is checked for root, opaque, JWT and current local-token families alike.
const resolver = require('../../tenant-resolution');
const c = require('./contract');
function parse (value, maxTenants) {
  if (!c.exact(value, ['version', 'mode', 'tenants']) || value.version !== 1 || value.mode !== 'preview-socket-allowlist' ||
      !c.integer(maxTenants) || !Array.isArray(value.tenants) || value.tenants.length > maxTenants) c.fail('SOCKET_ADMISSION_REFUSED');
  const tenants = new Map(), aliases = [];
  for (const tenant of value.tenants) {
    if (!c.exact(tenant, ['id', 'enabled', 'aliases']) || !c.uuid(tenant.id) || tenants.has(tenant.id) ||
        typeof tenant.enabled !== 'boolean' || !Array.isArray(tenant.aliases) || !tenant.aliases.length) c.fail('SOCKET_ADMISSION_REFUSED');
    tenants.set(tenant.id, Object.freeze({ tenant: tenant.id, enabled: tenant.enabled }));
    aliases.push(...tenant.aliases.map(host => ({ host, tenant: tenant.id })));
  }
  // No client engine path or forwarded selector is a tenant authority.
  const resolve = aliases.length ? resolver({ aliases }) : null;
  return { tenants, aliases, resolve };
}
function load ({ file, maxTenants }) {
  const initial = parse(c.file(file), maxTenants), initialIds = new Set(initial.tenants.keys());
  function read () {
    const current = parse(c.file(file), maxTenants);
    if ([...current.tenants.keys()].some(id => !initialIds.has(id))) c.fail('SOCKET_ADMISSION_EXPANSION_RESTART');
    return current;
  }
  return Object.freeze({
    ids: Object.freeze([...initialIds]), aliases: Object.freeze(initial.aliases),
    async allows (tenant) { return read().tenants.get(tenant)?.enabled === true; },
    async enabled () { return new Set([...read().tenants.values()].filter(row => row.enabled === true).map(row => row.tenant)); },
    async resolve (request) {
      const current = read(), tenant = current.resolve?.resolve(request);
      if (!tenant || current.tenants.get(tenant)?.enabled !== true) c.fail('SOCKET_ADMISSION_REFUSED');
      return tenant;
    },
    async resolveHost (host) {
      return this.resolve({ rawHeaders: ['Host', host], socket: {} });
    }
  });
}
module.exports = { load, parse };
