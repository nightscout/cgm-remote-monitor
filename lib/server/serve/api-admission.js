'use strict';

const scope = require('../../storage/tenant-scope');

// One role-owned connection. A request checks activity and is authorized once,
// in one tenant transaction (decision credential-rotation-next-request: rotation,
// subject deletion and role changes apply from the next request). A write checks
// activity again inside its effect's transaction, before allocating history
// dates or mutating canonical storage: pause, suspension and the restore fence
// hold at the effect; authorization is not read again.
module.exports = function apiAdmission (connection, gate) {
  if (typeof connection?.withTenant !== 'function' || typeof gate !== 'function') throw new TypeError('API connection and activity gate required');
  const request = (tenant, req, fn) => connection.withTenant(tenant, async () => {
    await gate(tenant, req);
    return fn();
  });
  const writes = Object.assign({}, connection, {
    transaction: fn => connection.transaction(async () => {
      await gate(scope.requireTenant('API effect admission'), { method: 'POST' });
      return fn();
    })
  });
  return Object.freeze({ request, writes });
};
