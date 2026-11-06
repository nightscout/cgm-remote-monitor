'use strict';

// Test-only, opt-in ablations loaded into owned CLI children with --require.
// These deliberately break current authority, tenant binding or schema admission.
// A failing setup is not evidence: the integration assertion must observe the
// resulting stale permission, foreign row or unsafe listener binding.
const Module = require('node:module');
const path = require('node:path');
const control = process.env.NS_PREVIEW_REPLICA_CONTROL;
const valid = new Set(['stale-authority', 'cross-tenant', 'readiness', 'history-clock']);
if (control !== undefined && !valid.has(control)) throw new Error('Unknown replica semantic control');

if (control === 'history-clock') {
  const fixed = Number(process.env.NS_PREVIEW_REPLICA_CLOCK_MS);
  if (!Number.isSafeInteger(fixed) || fixed < 1) throw new Error('Replica history clock requires an explicit millisecond value');
  const realNow = Date.now;
  Date.now = function () {
    // Preserve actual authentication, expiry, provider and timeout clocks. Only
    // the unmodified srv-dates allocator sees the same time in both children.
    return new Error().stack.includes(path.join('lib', 'server', 'srv-dates.js') + ':') ? fixed : realNow();
  };
  process.stderr.write('replica-control: history-clock installed\n');
}

if (control && control !== 'history-clock') {
  const originalLoad = Module._load;
  const wrapped = new WeakMap();
  const file = suffix => path.normalize(suffix);
  const ends = (resolved, suffix) => typeof resolved === 'string' && resolved.endsWith(file(suffix));
  function memo (fn, cache, key) {
    return async function (...args) {
      const id = key(...args);
      if (!cache.has(id)) cache.set(id, await fn(...args));
      return cache.get(id);
    };
  }
  Module._load = function (request, parent, isMain) {
    const value = originalLoad.call(this, request, parent, isMain);
    const resolved = Module._resolveFilename(request, parent, isMain);
    if ((typeof value !== 'function' && (typeof value !== 'object' || value === null))) return value;
    if (wrapped.has(value)) return wrapped.get(value);
    let replacement = value;
    if (control === 'stale-authority' && ends(resolved, '/lib/tenant-authorization/access-postgres.js')) {
      replacement = async function (...args) {
        const authority = await value(...args);
        return { ...authority, snapshot: memo(authority.snapshot, new Map(), claims =>
          JSON.stringify([claims.tid, claims.sub, claims.sid, claims.kid, claims.cv, claims.purpose])) };
      };
    } else if (control === 'stale-authority' && ends(resolved, '/lib/tenant-authorization/postgres.js')) {
      replacement = async function (...args) {
        const authority = await value(...args);
        return { ...authority,
          authorize: memo(authority.authorize, new Map(), input => JSON.stringify(input)),
          subjectSnapshot: memo(authority.subjectSnapshot, new Map(), input => JSON.stringify(input)) };
      };
    } else if (control === 'readiness' && ends(resolved, '/lib/server/serve/postgres-domains.js')) {
      replacement = { ...value, readiness: async () => undefined };
    } else if (control === 'cross-tenant' && ends(resolved, '/lib/server/serve/preview-domains.js')) {
      replacement = async function (options) {
        const domains = await value(options);
        const tenants = [...options.config.bindings.keys()];
        if (tenants.length !== 2) throw new Error('Replica tenant control requires exactly two configured tenants');
        return { ...domains, data (req, res, next) {
          if (req.method !== 'GET' || req.tenantContext.tenant !== tenants[0]) return domains.data(req, res, next);
          // Authentication has already accepted tenant A. Deliberately substitute
          // B only for data routing, reproducing an authorization/storage misbind.
          // Express resets the request prototype on entry to a subapp. Keep
          // actual wire fields as own properties so the control reaches data.
          const descriptors = Object.getOwnPropertyDescriptors(req);
          delete descriptors.tenantContext;
          const shadow = Object.create(Object.getPrototypeOf(req), descriptors);
          Object.defineProperty(shadow, 'tenantContext', { value: Object.freeze({ ...req.tenantContext, tenant: tenants[1] }) });
          const authentication = require('../../lib/api3/tenant-authentication');
          const bound = authentication.get(req);
          if (!bound) throw new Error('Cross-tenant control requires verified authority');
          authentication.bind(shadow, bound);
          return domains.data(shadow, res, next);
        } };
      };
    }
    if (replacement !== value) {
      process.stderr.write('replica-control: ' + control + ' loaded ' + path.basename(resolved) + '\n');
      wrapped.set(value, replacement);
    }
    return replacement;
  };
}
