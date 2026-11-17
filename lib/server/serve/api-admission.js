'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const scope = require('../../storage/tenant-scope');

// One role-owned connection. A request checks activity and current authority in
// one tenant transaction. A write checks activity again inside its effect's
// transaction, before allocating history dates or mutating canonical storage.
module.exports = function apiAdmission (connection, gate) {
  if (typeof connection?.withTenant !== 'function' || typeof gate !== 'function') throw new TypeError('API connection and activity gate required');
  const requests = new AsyncLocalStorage();
  const context = (tenant, req, fn) => requests.run({ tenant }, fn);
  const request = (tenant, req, fn, authorizeEffect = fn) => connection.withTenant(tenant, async () => {
    await gate(tenant, req);
    const result = await fn();
    const current = requests.getStore();
    if (current && current.tenant !== tenant) throw new Error('API request belongs to another tenant');
    // Retain the operation, never its allow result. Credentials and authority
    // are read again at each mutation boundary after any queued/client wait.
    if (current && result) current.authorizeEffect = authorizeEffect;
    return result;
  });
  const writes = Object.assign({}, connection, {
    transaction: fn => connection.transaction(async () => {
      const tenant = scope.requireTenant('API effect admission');
      await gate(tenant, { method: 'POST' });
      const current = requests.getStore();
      if (current) {
        if (current.tenant !== tenant || typeof current.authorizeEffect !== 'function' || !await current.authorizeEffect()) {
          throw Object.assign(new Error('TENANT_DATA_FORBIDDEN'), { code: 'TENANT_DATA_FORBIDDEN' });
        }
      }
      return fn();
    })
  });
  return Object.freeze({ context, request, writes });
};
