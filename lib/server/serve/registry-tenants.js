'use strict';

// A role's tenant view in registry mode (decision tenant-registry): the same
// shapes the static tenant list produced in preview-config (resolver, bindings,
// providers, environments, access-token keys), filled from the registry on a
// tenant's first request instead of from a configuration file.
//
// `resolve(request)` resolves the host through the registry resolver and then
// loads that tenant's registry entry (signing version, public keys), so every
// request path that knows its tenant has the entry materialized; the
// synchronous views (bindings.get, resolveKey) read only materialized tenants.
// Materialized tenants are bounded by the registry cache bound and follow its
// revision rule: an entry is rebuilt when the registry returns a new one.
const { createPublicKey } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const connect = require('../../storage/postgres-connection');
const registry = require('../../tenant-registry/postgres');
const rules = require('../../tenant-registry/rules');
const { createRegistryResolver } = require('../../tenant-registry/resolver');
const { createVaultTransit } = require('../../secrets/vault-transit');

function remember (map, key, value, max) {
  map.delete(key); map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

async function create ({ settings, connectionString, mode = 'direct-alias', trustedProxy, vault, accessTokens, binding, keyPurpose = 'access',
  applicationName = 'nightscout-registry', environment = () => ({}), cache }) {
  if (cache !== undefined && ['get', 'peek', 'set', 'delete', 'clear', 'stats'].some(name => typeof cache?.[name] !== 'function')) {
    throw new TypeError('Registry tenant cache requires a shared record LRU');
  }
  const capacity = cache ? cache.stats().capacity : settings.maxTenants;
  // A paused server cannot enforce statement_timeout. Bound both pool checkout
  // and the driver's read locally, within the HTTP request failure bound.
  const connection = await connect({ connectionString, max: 2, connectionTimeoutMillis: 1000, query_timeout: 1000,
    statement_timeout: 5000, application_name: applicationName });
  let resolver;
  try {
    const store = registry.create({ connection, namespace: settings.namespace });
    resolver = createRegistryResolver({ store, mode, trustedProxy, maxTenants: capacity, refreshMs: settings.refreshMs,
      onError: () => console.warn('Tenant registry revision poll failed') });
    await resolver.start();
  } catch (error) { await connection.end().catch(() => {}); throw error; }
  const records = cache || new Map(), requests = new AsyncLocalStorage(), preparing = new Map();
  const rememberRecord = (tenant, record) => cache ? cache.set(tenant, record) : remember(records, tenant, record, capacity);
  const pinned = tenant => {
    const current = requests.getStore();
    return current?.registry.entry.tenant === tenant ? current : undefined;
  };
  const recordOf = tenant => pinned(tenant) || records.get(tenant);
  function materialize (entry) {
    const currentRecord = records.get(entry.tenant), current = currentRecord?.registry;
    if (current && current.entry === entry) { rememberRecord(entry.tenant, currentRecord); return currentRecord; }
    const keys = new Map();
    if (accessTokens) {
      for (const key of entry.keys.filter(row => row.purpose === keyPurpose)) {
        const bytes = Buffer.from(key.publicKey, 'base64');
        keys.set(key.kid, Object.freeze({ tenant: entry.tenant, kid: key.kid, issuer: accessTokens.issuer, purpose: keyPurpose === 'access' ? 'data' : 'management',
          publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') } }) }));
      }
    }
    const metadata = Object.freeze({ entry, keys,
      binding: binding ? Object.freeze({ tenant: entry.tenant, ...binding }) : undefined,
      provider: vault ? createVaultTransit({ ...vault, encryptionKey: rules.vaultKey(entry.tenant, 'data') }) : undefined,
      // Kept across entry refreshes: domain graphs hold this object per tenant.
      environment: current ? current.environment : environment(entry.tenant) });
    const record = { registry: metadata };
    rememberRecord(entry.tenant, record);
    return record;
  }
  const known = tenant => recordOf(tenant)?.registry;
  function prepareRecord (tenant) {
    if (!preparing.has(tenant)) {
      const pending = resolver.entry(tenant).then(materialize);
      preparing.set(tenant, pending);
      pending.finally(() => { if (preparing.get(tenant) === pending) preparing.delete(tenant); }).catch(() => {});
    }
    return preparing.get(tenant);
  }
  async function resolveRecord (request) {
    const tenant = await resolver.resolve(request);
    return { tenant, record: await prepareRecord(tenant) };
  }
  async function run (tenant, fn) {
    const current = requests.getStore();
    if (current && current.registry.entry.tenant !== tenant) throw new Error('Cannot rebind a registry request to another tenant');
    const record = current || await prepareRecord(tenant);
    return requests.run(record, () => fn(record));
  }
  const view = {
    resolver: Object.freeze({ async resolve (request) {
      const tenant = await resolver.resolve(request);
      if (!pinned(tenant)) await prepareRecord(tenant);
      return tenant;
    }, async runRequest (request, next) {
      const { record } = await resolveRecord(request);
      return requests.run(record, next);
    } }),
    humanRegistry: Object.freeze({
      entry: tenant => resolver.entry(tenant),
      resolveOrigin: request => resolver.resolveOrigin(request),
      maxTenants: capacity
    }),
    // Load (or refresh) one tenant's entry by id, for paths that name a tenant
    // without a request (internal calls, startup).
    async prepare (tenant) { return (pinned(tenant) || await prepareRecord(tenant)).registry; },
    run,
    record: recordOf,
    bindings: Object.freeze({ get: tenant => known(tenant)?.binding, has: tenant => !!known(tenant), keys: () => [][Symbol.iterator]() }),
    providers: Object.freeze({ get: tenant => known(tenant)?.provider, has: tenant => !!known(tenant) }),
    environments: Object.freeze({ get: tenant => known(tenant)?.environment }),
    resolveKey: (tenant, kid) => known(tenant)?.keys.get(kid),
    registry: Object.freeze({ namespace: settings.namespace }),
    tenantIds: Object.freeze(['registry:' + settings.namespace]),
    onRevision: listener => resolver.onRevision(listener),
    stats: () => Object.freeze({ ...resolver.stats(), materialized: cache ? cache.stats().entries : records.size }),
    async close () { resolver.close(); records.clear(); await connection.end(); }
  };
  return Object.freeze(view);
}

module.exports = { create };
