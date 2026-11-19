'use strict';

// Registry-backed tenant resolution (decision tenant-registry). The same
// `resolve(request)` contract, header rules and refusal codes as
// lib/tenant-resolution, with hosts looked up in the registry on first use and
// kept in a bounded cache.
//
// Refresh (stage 1, aggregate poll): one statement per `refreshMs`, whatever
// the number of tenants. Every cached answer carries the revision it is known
// current at. When the revision moves, the same statement names which cached
// tenants (and `candidates()`, a caller's own residents) changed since the
// previous revision (decision ack-path-tenant-independent): only those
// answers are dropped; every other cached answer is carried to the new
// revision. Provisioning other tenants therefore costs a cached tenant
// nothing. A changed tenant (removed, hosts or keys changed) is looked up
// again on its next use, so a removed tenant is refused within one refresh
// interval. If the poll has not succeeded within `staleAfterMs`, nothing
// cached is used (fail closed on a lost change signal). A store without
// `changed()` treats every move as changing every tenant.
//
// Unknown hosts are cached too (at most maxTenants, the same bound), so
// repeated unknown Host headers cost no more than one lookup per host per
// revision.
const resolution = require('../tenant-resolution');
const { selectors, hostname, tenantId, refuse } = resolution;
const MAX_TENANTS = 100000;

function createRegistryResolver ({ store, mode = 'direct-alias', trustedProxy, maxTenants = 10000, refreshMs = 2000,
  staleAfterMs, now = Date.now, schedule = setInterval, cancel = clearInterval, onError = () => {}, candidates = () => [] } = {}) {
  if (!store || typeof store.lookup !== 'function' || typeof store.revision !== 'function' || typeof store.entry !== 'function') {
    throw new TypeError('Registry resolver requires a registry store');
  }
  if (!['direct-alias', 'canonical-internal'].includes(mode)) throw new TypeError('Invalid tenant resolution mode');
  const predicate = trustedProxy === undefined && mode === 'direct-alias' ? () => false : trustedProxy;
  if (typeof predicate !== 'function') throw new TypeError('Tenant resolution requires a trusted-proxy predicate');
  if (!Number.isSafeInteger(maxTenants) || maxTenants < 1 || maxTenants > MAX_TENANTS) throw new TypeError('Registry cache bound must be 1..' + MAX_TENANTS);
  if (!Number.isSafeInteger(refreshMs) || refreshMs < 250 || refreshMs > 60000) throw new TypeError('Registry refresh interval must be 250..60000 ms');
  const stale = staleAfterMs === undefined ? refreshMs * 3 : staleAfterMs;
  if (!Number.isSafeInteger(stale) || stale < refreshMs) throw new TypeError('Registry staleness bound must be at least the refresh interval');
  if (typeof candidates !== 'function') throw new TypeError('Registry change candidates must be a function');

  let current = null, polledAt = -Infinity, timer = null, closed = false, polling = null;
  const hosts = new Map(), negative = new Map(), entries = new Map(), inflight = new Map(), listeners = new Set();
  const counters = { hits: 0, misses: 0, lookups: 0, negativeHits: 0, evictions: 0, polls: 0, pollErrors: 0, revisions: 0, invalidations: 0 };
  const fresh = () => current !== null && now() - polledAt <= stale;
  function remember (map, key, value, max) {
    map.delete(key); map.set(key, value);
    while (map.size > max) { map.delete(map.keys().next().value); counters.evictions++; }
  }

  async function poll () {
    if (closed) return current;
    if (polling) return polling;
    polling = (async () => {
      counters.polls++;
      try {
        const previous = current;
        // Snapshot the cached tenants before the read: an answer cached while
        // the read is in flight is not covered by it and stays at `previous`.
        const checked = new Set([...hosts.values()].map(hit => hit.value.tenant).concat([...entries.keys()], [...candidates()]));
        let revision, changed = null;
        if (previous !== null && typeof store.changed === 'function') ({ revision, changed } = await store.changed(previous, [...checked]));
        else revision = await store.revision();
        polledAt = now();
        if (revision !== current) {
          current = revision; counters.revisions++;
          negative.clear();
          const stale = changed === null ? null : new Set(changed);
          const carry = (map, tenantOf) => {
            for (const [key, hit] of map) {
              const tenant = tenantOf(key, hit);
              if (hit.revision === previous && stale && checked.has(tenant) && !stale.has(tenant)) hit.revision = revision;
              else { map.delete(key); counters.invalidations++; }
            }
          };
          carry(hosts, (key, hit) => hit.value.tenant);
          carry(entries, key => key);
          const unchanged = tenant => !!stale && checked.has(tenant) && !stale.has(tenant);
          if (previous !== null) for (const listener of listeners) { try { listener(revision, { previous, unchanged }); } catch { /* a listener never stops the poll */ } }
        }
      } catch (error) { counters.pollErrors++; try { onError(error); } catch { /* reporting never fails the poll */ } }
      finally { polling = null; }
      return current;
    })();
    return polling;
  }

  // host+kind -> { tenant, state } | null, through the cache.
  async function find (host, kind) {
    if (closed) throw refuse('TENANT_REGISTRY_CLOSED');
    const key = kind + ' ' + host;
    if (fresh()) {
      const hit = hosts.get(key);
      if (hit && hit.revision === current) { counters.hits++; remember(hosts, key, hit, maxTenants); return hit.value; }
      const miss = negative.get(key);
      if (miss === current) { counters.negativeHits++; return null; }
    }
    counters.misses++;
    if (inflight.has(key)) return inflight.get(key);
    const revision = fresh() ? current : null;
    const pending = (async () => {
      counters.lookups++;
      const value = await store.lookup(host, kind);
      // Cache only an answer read after a known revision.
      if (revision !== null && revision === current) {
        if (value) { hosts.delete(key); remember(hosts, key, { value, revision }, maxTenants); negative.delete(key); }
        else { hosts.delete(key); remember(negative, key, revision, maxTenants); }
      }
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }
  async function active (host, kind) {
    const found = await find(host, kind);
    return found && found.state === 'active' ? found.tenant : undefined;
  }

  return Object.freeze({
    mode,
    async start () {
      await poll();
      if (current === null) throw refuse('TENANT_REGISTRY_UNAVAILABLE');
      if (!timer && !closed) { timer = schedule(() => { poll(); }, refreshMs); timer?.unref?.(); }
      return current;
    },
    poll,
    async resolve (request) {
      const values = selectors(request);
      const host = hostname(values.get('host'));
      const forwarded = values.get('x-forwarded-host');
      const resolved = values.get('x-resolved-tenant');
      if (mode === 'canonical-internal') {
        const forwardedHost = forwarded === undefined ? undefined : hostname(forwarded);
        const assertedTenant = resolved === undefined ? undefined : tenantId(resolved);
        let trusted;
        try { trusted = predicate(request); } catch { throw new Error('Tenant trust decision unavailable'); }
        if (trusted !== true) throw refuse('TENANT_PROXY_UNTRUSTED');
        if (values.get('host').includes(':')) throw refuse('TENANT_HOST_UNKNOWN');
        const tenant = await active(host, 'internal');
        if (tenant === undefined) throw refuse('TENANT_HOST_UNKNOWN');
        if (forwardedHost !== undefined) {
          const alias = await find(forwardedHost, 'alias');
          if (alias && alias.tenant !== tenant) throw refuse('TENANT_SELECTOR_CONFLICT');
        }
        if (assertedTenant !== undefined && assertedTenant !== tenant) throw refuse('TENANT_SELECTOR_CONFLICT');
        return tenant;
      }
      if ((forwarded !== undefined || resolved !== undefined) && predicate(request) !== true) throw refuse('TENANT_PROXY_UNTRUSTED');
      const publicHost = forwarded === undefined ? host : hostname(forwarded);
      const tenant = await active(publicHost, 'alias');
      if (tenant === undefined) throw refuse('TENANT_HOST_UNKNOWN');
      if (resolved !== undefined && tenantId(resolved) !== tenant) throw refuse('TENANT_SELECTOR_CONFLICT');
      return tenant;
    },
    // The public origin must be an alias that resolved to this tenant. An
    // internal name or a merely trusted forwarded host is not a login origin.
    async resolveOrigin (request) {
      const tenant = await this.resolve(request);
      const values = selectors(request);
      const alias = hostname(values.get('x-forwarded-host') || values.get('host'));
      if (await active(alias, 'alias') !== tenant) throw refuse('TENANT_ORIGIN_REFUSED');
      return Object.freeze({ tenant, origin: 'https://' + alias });
    },
    // Per-tenant attributes (signing version, public keys), cached under the
    // same revision rule. A removed or absent tenant refuses.
    async entry (tenant) {
      if (closed) throw refuse('TENANT_REGISTRY_CLOSED');
      const cached = entries.get(tenant);
      if (cached && fresh() && cached.revision === current) { remember(entries, tenant, cached, maxTenants); return cached.value; }
      const revision = fresh() ? current : null;
      const value = await store.entry(tenant);
      if (!value || value.state !== 'active') { entries.delete(tenant); throw refuse('TENANT_REMOVED'); }
      if (revision !== null && revision === current) remember(entries, tenant, { value, revision }, maxTenants);
      return value;
    },
    // Called with (revision, { previous, unchanged }) whenever the poll sees
    // the revision move. `unchanged(tenant)` is true only for a tenant checked
    // by this poll (cached here or named by `candidates()` when it began) that
    // did not change after `previous`.
    onRevision (listener) {
      if (typeof listener !== 'function') throw new TypeError('Registry revision listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => current,
    stats: () => Object.freeze({ ...counters, cached: hosts.size, negative: negative.size, entries: entries.size, revision: current }),
    close () { closed = true; if (timer) cancel(timer); timer = null; hosts.clear(); negative.clear(); entries.clear(); listeners.clear(); }
  });
}

module.exports = { createRegistryResolver, MAX_TENANTS };
