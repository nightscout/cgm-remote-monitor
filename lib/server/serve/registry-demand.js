'use strict';

const { createRegistryResolver } = require('../../tenant-registry/resolver');
const { predecessor, UUID } = require('./registry-tenant-set');
const failure = code => Object.assign(new Error(code), { code });

// Serve background work from its addressed tenant. The existing enumeration
// grant permits a one-row membership check without exposing hosts or keys.
module.exports = async function createDemand ({ store, settings, maxTenants, build, accept = () => true,
  schedule = setInterval, cancel = clearInterval, now = Date.now, close = async () => {} }) {
  if (typeof build !== 'function' || !Number.isSafeInteger(maxTenants) || maxTenants < 1) {
    throw new TypeError('Demand registry needs a builder and a positive working-set bound');
  }
  const tenants = new Map(), versions = new Map(), lookups = new Map(), listeners = new Set(), draining = new Map();
  let closed = false, closing, timer, polling, overBound = false, registryFailure = null;
  let lastPoll = -Infinity, pressureRevision = null, removalFailed = false;
  const resolver = createRegistryResolver({ store, maxTenants: settings.maxTenants, refreshMs: settings.refreshMs,
    now, schedule: () => null, onError: () => { registryFailure = 'TENANT_REGISTRY_UNAVAILABLE'; } });
  const fresh = () => !registryFailure && now() - lastPoll <= settings.refreshMs * 3;
  const isActive = tenant => !closed && accept(tenant) && fresh() && tenants.has(tenant) && BigInt(versions.get(tenant)) >= BigInt(resolver.revision());

  function withdraw (tenant) {
    versions.delete(tenant);
    if (tenants.delete(tenant)) {
      // Hide the tenant synchronously. A listener's drain can depend on the
      // very operation that found the removal, so lookup must return first.
      const jobs = [...listeners].map(async listener => listener(tenant));
      const done = Promise.allSettled(jobs).then(results => {
        if (results.some(result => result.status === 'rejected')) removalFailed = true;
        else {
          draining.delete(tenant);
          if (tenants.size + draining.size < maxTenants) overBound = false;
          pressureRevision = null;
        }
      });
      draining.set(tenant, done);
    }
    return null;
  }
  async function read (tenant) {
    if (!accept(tenant)) return withdraw(tenant);
    const row = await store.page(predecessor(tenant), 1);
    if (closed) throw failure('TENANT_REGISTRY_CLOSED');
    if (BigInt(row.revision) < BigInt(resolver.revision())) throw failure('TENANT_REGISTRY_ADMISSION_STALE');
    if (row.tenants[0] !== tenant || !accept(tenant)) return withdraw(tenant);
    if (!tenants.has(tenant)) {
      if (tenants.size + draining.size >= maxTenants) {
        overBound = true;
        throw failure('TENANT_REGISTRY_OVER_BOUND');
      }
      tenants.set(tenant, build(tenant));
    }
    versions.set(tenant, row.revision);
    return tenants.get(tenant);
  }
  function lookup (tenant) {
    if (closed) return Promise.reject(failure('TENANT_REGISTRY_CLOSED'));
    if (typeof tenant !== 'string' || !UUID.test(tenant)) return Promise.resolve(null);
    if (draining.has(tenant)) return Promise.reject(failure('TENANT_REGISTRY_ADMISSION_STALE'));
    if (lookups.has(tenant)) return lookups.get(tenant);
    if (isActive(tenant)) return Promise.resolve(tenants.get(tenant));
    const pending = read(tenant).finally(() => lookups.delete(tenant));
    lookups.set(tenant, pending);
    return pending;
  }
  async function refresh () {
    registryFailure = null;
    await resolver.poll();
    if (registryFailure || closed) return;
    lastPoll = now();
    // Normal revisions only stale cached answers. Streams, due work and
    // sockets recheck their addressed tenant. If a full working set refused
    // demand, reclaim removed residents once per revision to make room.
    const revision = resolver.revision();
    if (overBound && revision !== pressureRevision) {
      for (const tenant of tenants.keys()) {
        if (closed || !overBound) break;
        await lookup(tenant);
      }
      pressureRevision = revision;
    }
  }
  function poll () {
    if (!closed && !polling) {
      polling = refresh().catch(() => { registryFailure = 'TENANT_REGISTRY_UNAVAILABLE'; }).finally(() => { polling = null; });
    }
    return polling;
  }
  try {
    await resolver.start();
    lastPoll = now();
    timer = schedule(poll, settings.refreshMs);
    timer?.unref?.();
  } catch (error) { resolver.close(); throw error; }
  return Object.freeze({ tenants, lookup, resolver, isActive, poll,
    revision: resolver.revision, activeIds: () => new Set([...tenants.keys()].filter(isActive)),
    onRemove (listener) {
      if (typeof listener !== 'function') throw new TypeError('Registry removal listener required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats: () => Object.freeze({ ...resolver.stats(), configured: tenants.size, active: tenants.size, waiting: lookups.size, pending: lookups.size,
      failure: registryFailure || (removalFailed ? 'TENANT_REGISTRY_REMOVAL_REFUSED' : null) || (overBound ? 'TENANT_REGISTRY_OVER_BOUND' : null) }),
    close () {
      if (!closing) {
        closed = true;
        cancel(timer);
        resolver.close();
        closing = (async () => {
          await polling;
          await Promise.allSettled([...lookups.values()]);
          await Promise.allSettled([...draining.values()]);
          listeners.clear(); tenants.clear(); versions.clear();
          await close();
        })();
      }
      return closing;
    }
  });
};
