'use strict';

// Every PostgreSQL config family uses either namespaces or namespace. Include
// nested consumer outbox/suppression stores, not just clinical collections.
function protectedNamespaces (value) {
  const names = new Set();
  function collect (node) {
    if (!node || typeof node !== 'object' || node instanceof Map || node instanceof Set) return;
    for (const [key, child] of Object.entries(node)) {
      // The tenant registry is operational (census OPERATIONAL), never restored with a tenant.
      if (key === 'registry' || key === 'platformVerification') continue;
      if (key === 'namespace' && typeof child === 'string') names.add(child);
      else if (key === 'namespaces' && child && typeof child === 'object') {
        for (const name of Object.values(child)) if (typeof name === 'string') names.add(name);
      } else if (child && typeof child === 'object') collect(child);
    }
  }
  collect(value); return [...names];
}

// A process must bind the topology and restore lock domain its role config
// actually names.
function assertRole (role, config, selection) {
  const ids = config.registry ? config.tenantIds : config.bindings ? [...config.bindings.keys()] :
    config.tenants ? [...config.tenants.keys()] : config.tenantIds;
  const expected = selection.tenantIds || selection.locks.map(row => row.tenant);
  const same = require('node:util').isDeepStrictEqual;
  if (!Array.isArray(ids) || !same([...ids].sort(), [...expected].sort())) throw new Error('RESTORE_COHORT_TENANT_MISMATCH');
}
module.exports = { protectedNamespaces, assertRole };
