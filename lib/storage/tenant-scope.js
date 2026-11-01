'use strict';

// The tenant scope of the storage interface.
//
// A multitenant Nightscout on PostgreSQL binds the tenant to a connection with
// set_config('app.current_tenant_id', ..., is_local => true), and is_local
// means transaction-local, so every tenant-bound operation runs inside a scope
// the storage layer can see. This module is that scope, and the assertion
// every storage operation makes against it. Three properties shape it (storage
// seam interface, section 9):
//
// 1. Only PostgreSQL fails closed. Under row-level security an unbound
//    transaction returns no rows. MongoDB has no equivalent: an unbound query
//    has no tenant predicate and returns every tenant's documents. So a
//    multitenant MongoDB adapter has to assert the binding and throw, which is
//    what requireTenant does.
//
// 2. No transaction on MongoDB. A standalone mongod cannot start one and many
//    sites run exactly that. withTenant binds; it opens nothing, and the
//    interface does not promise atomicity across operations.
//
// 3. Single-tenant has no tenant. `nightscout single` is not a multitenant
//    deployment with one tenant in it. SINGLE_TENANT is its binding: a Symbol,
//    so it cannot equal a tenant id, be serialised into a log line, a query or
//    a stored document, or be concatenated into a key. Under single an unbound
//    operation resolves to it and nothing throws, so no call site needs a scope.
//
// AsyncLocalStorage rather than a handle threaded through every call: if the
// async chain breaks and the scope is lost, the caller has no binding, which
// throws here under multi and returns no rows under row-level security. A lost
// scope cannot become another tenant's binding; there is nothing to fall back
// to.
//
// The mode belongs to the entrypoint, not to a setting. `nightscout single`
// leaves it 'single', which is the default. Every `nightscout serve` role is
// multitenant and is refused today, so nothing sets 'multi' yet: where a
// tenant comes from under serve is tenant resolution (TEN-RESOLVE). Until then
// this module changes nothing a single-tenant site does: requireTenant returns
// without reading or writing anything, and no AsyncLocalStorage context is
// entered unless withTenant is called.

const { AsyncLocalStorage } = require('node:async_hooks');

const SINGLE_TENANT = Symbol('single-tenant');
const MODES = Object.freeze(['single', 'multi']);

const scope = new AsyncLocalStorage();

// Process-wide, as the async context is. 'single' is what every existing
// deployment is; a default that enabled the multitenant assertion would break
// them all at once.
let mode = 'single';

function setTenancyMode (next) {
  if (!MODES.includes(next)) {
    throw new TypeError('tenancy mode must be \'single\' or \'multi\', got ' + JSON.stringify(next));
  }
  mode = next;
}

function getTenancyMode () {
  return mode;
}

function assertValidTenant (tenant) {
  if (tenant === SINGLE_TENANT) {
    if (mode === 'multi') throw new TypeError('SINGLE_TENANT is not a binding a multitenant Nightscout may use');
    return;
  }
  // Narrow on purpose. A tenant id reaches SQL as a bound parameter, but also
  // log lines, metric labels and cache keys; refuse anything strange first.
  if (typeof tenant !== 'string' || !tenant.length) {
    throw new TypeError('tenant must be a non-empty string, or SINGLE_TENANT');
  }
  if (mode === 'single') throw new TypeError('a single-tenant Nightscout cannot bind a tenant id');
}

/**
 * Run fn with tenant bound for its duration, including everything it awaits.
 *
 * Opens no transaction (property 2). Nesting is allowed only with the same
 * binding: rebinding mid-request is how a request reads under one tenant and
 * writes under another, and crossing tenants is an admin-plane operation that
 * belongs on its own request.
 *
 * @param {string|symbol} tenant a tenant id, or SINGLE_TENANT
 * @param {Function} fn
 * @returns whatever fn returns
 */
function withTenant (tenant, fn) {
  assertValidTenant(tenant);
  if (typeof fn !== 'function') throw new TypeError('withTenant requires a function');
  const outer = scope.getStore();
  if (outer !== undefined && outer.tenant !== tenant) {
    throw new Error('cannot rebind the tenant inside an existing tenant scope');
  }
  return scope.run(Object.freeze({ tenant }), fn);
}

/** The tenant bound now, or undefined outside any scope. */
function currentTenant () {
  const bound = scope.getStore();
  return bound === undefined ? undefined : bound.tenant;
}

/**
 * The assertion every storage operation makes (property 1).
 *
 * Under 'single' an unbound operation is legitimate and resolves to
 * SINGLE_TENANT. Under 'multi' an unbound operation throws before the query
 * reaches the driver.
 *
 * @param {string} [operation] named in the error, so the throw points at a call site
 * @returns {string|symbol} the effective binding
 */
function requireTenant (operation) {
  const bound = currentTenant();
  if (bound !== undefined) return bound;
  if (mode === 'single') return SINGLE_TENANT;
  throw new Error((operation || 'storage operation') + ' ran with no tenant bound. '
    + 'A multitenant Nightscout runs every storage operation inside withTenant(); '
    + 'MongoDB has no row-level security to fall back on, so an unbound query would '
    + 'return every tenant\'s documents.');
}

module.exports = {
  SINGLE_TENANT
  , withTenant
  , currentTenant
  , requireTenant
  , setTenancyMode
  , getTenancyMode
};
