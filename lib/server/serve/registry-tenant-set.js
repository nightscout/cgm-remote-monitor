'use strict';

// The tenant set of a role that works without requests (evaluator, realtime)
// in registry mode (decision tenant-registry): the active tenants enumerated
// from the registry at start (paged definer, ids only), refreshed on the
// aggregate revision.
//
// Stage 1 (this module): the set a role serves is fixed at start, as it was
// with a configuration file. Within one refresh interval a removed tenant is
// no longer active (`isActive` false, so readCurrent answers null and its work
// stops); a tenant added after start raises one
// TENANT_REGISTRY_EXPANSION_RESTART alert carrying the count of tenants waiting
// (also in `waiting()`, which roles show in health) and is served after the next start
// (the file-based behaviour was a refused re-read). A lost revision poll keeps
// the last known set: evaluation of known tenants never stops on a registry
// outage.
const connect = require('../../storage/postgres-connection');
const registry = require('../../tenant-registry/postgres');

async function open ({ settings, connectionString, maxTenants, build, applicationName = 'nightscout-registry-set',
  alert = (code, detail) => console.warn('Tenant registry alert', code, detail), schedule = setInterval, cancel = clearInterval }) {
  if (!settings || typeof build !== 'function' || !Number.isSafeInteger(maxTenants) || maxTenants < 1) throw new TypeError('Registry tenant set requires settings, a bound and an entry builder');
  const connection = await connect({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000, application_name: applicationName });
  let store, first;
  try {
    store = registry.create({ connection, namespace: settings.namespace });
    first = await store.enumerate({ pageSize: 1000 });
    if (first.tenants.length > maxTenants) throw Object.assign(new Error('TENANT_REGISTRY_OVER_BOUND'), { code: 'TENANT_REGISTRY_OVER_BOUND' });
  } catch (error) { await connection.end().catch(() => {}); throw error; }
  const initial = new Set(first.tenants);
  const tenants = new Map(first.tenants.map(tenant => [tenant, build(tenant)]));
  let active = new Set(first.tenants), revision = first.revision, waiting = 0, polling = null, closed = false;
  const counters = { polls: 0, pollErrors: 0, enumerations: 1, removed: 0 };
  async function poll () {
    if (closed || polling) return polling;
    polling = (async () => {
      counters.polls++;
      try {
        const now = await store.revision();
        if (now === revision) return;
        const next = await store.enumerate({ pageSize: 1000 });
        counters.enumerations++;
        revision = next.revision;
        active = new Set(next.tenants.filter(tenant => initial.has(tenant)));
        counters.removed = initial.size - active.size;
        // Tenants provisioned after start wait for the next start; the alert
        // carries how many, and is raised again whenever that count grows.
        const count = next.tenants.filter(tenant => !initial.has(tenant)).length;
        if (count > waiting) {
          try { alert('TENANT_REGISTRY_EXPANSION_RESTART', { waiting: count }); } catch { /* alerts never fail the poll */ }
        }
        waiting = count;
      } catch { counters.pollErrors++; } finally { polling = null; }
    })();
    return polling;
  }
  const timer = schedule(() => { poll(); }, settings.refreshMs);
  timer?.unref?.();
  return Object.freeze({
    tenants,
    isActive: tenant => active.has(tenant),
    // The active tenants this role serves (a copy).
    activeIds: () => new Set(active),
    poll,
    revision: () => revision,
    // Active tenants provisioned after start, waiting for the next start.
    waiting: () => waiting,
    tenantIds: Object.freeze(['registry:' + settings.namespace]),
    stats: () => Object.freeze({ ...counters, configured: tenants.size, active: active.size, revision, waiting }),
    async close () { closed = true; cancel(timer); await connection.end(); }
  });
}

module.exports = { open };
