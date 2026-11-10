'use strict';

// Private operator listener for the ownership-operations internal service.
// It is opened on its own internal endpoint (Unix socket or explicitly
// configured internal HTTP) and is never mounted on a public router. The
// operator identity is fixed by trusted composition; request content selects
// only the target tenant and the operation's identifiers.
const transport = require('../server/internal-api/transport');
const { ownershipOperations: contract } = require('../server/internal-api/contracts');

const NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DENIED = ['OWNERSHIP_FORBIDDEN', 'OWNERSHIP_TENANT_UNKNOWN', 'OWNERSHIP_INVALID'];

function fail (code) { throw Object.assign(new Error(code), { code }); }

// Deployment-supplied current authority: this operator acts only for the listed
// tenants. A deployment may compose a different current-authority callback with
// the same result shape; the component checks every field in the transaction.
function tenantSetAuthority ({ principal, consumer, tenants }) {
  if (typeof principal !== 'string' || !NAME.test(principal) || typeof consumer !== 'string' || !NAME.test(consumer) ||
      !Array.isArray(tenants) || !tenants.length || tenants.some(tenant => typeof tenant !== 'string' || !UUID.test(tenant)) ||
      new Set(tenants).size !== tenants.length) {
    throw new TypeError('Ownership operator authority requires a principal, consumer and explicit tenant list');
  }
  const allowed = new Set(tenants);
  return async request => ({ allowed: allowed.has(request.tenant) && request.principal === principal && request.consumer === consumer,
    current: true, tenant: request.tenant, plane: 'operator', principal, consumer });
}

function operations ({ token, ownership, operator }) {
  if (typeof token !== 'symbol' || !ownership || !operator || !NAME.test(operator.principal || '') || !NAME.test(operator.consumer || '')) {
    throw new TypeError('Ownership service requires a transport token, operations and a fixed operator identity');
  }
  const context = Object.freeze({ principal: operator.principal, consumer: operator.consumer });
  const call = method => async (request, body) => {
    if (!request || request.transport !== token) fail('OWNERSHIP_PRIVATE_REQUEST_REFUSED');
    try {
      const result = await ownership[method](context, body);
      return method === 'list' ? { outcome: 'listed', owners: result.owners } : result;
    } catch (error) {
      if (DENIED.includes(error.code)) return { outcome: 'denied', code: error.code, event: null };
      throw error;
    }
  };
  return { listOwners: call('list'), addOwner: call('add'), transferOwner: call('transfer'), recoverOwner: call('recover') };
}

function open (endpoint, { ownership, operator }) {
  return transport.open(endpoint, contract, token => operations({ token, ownership, operator }));
}

module.exports = { open, operations, tenantSetAuthority, contract };
