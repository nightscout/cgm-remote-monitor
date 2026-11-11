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
  applicationName = 'nightscout-registry', environment = () => ({}) }) {
  const connection = await connect({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: applicationName });
  let resolver;
  try {
    const store = registry.create({ connection, namespace: settings.namespace });
    resolver = createRegistryResolver({ store, mode, trustedProxy, maxTenants: settings.maxTenants, refreshMs: settings.refreshMs,
      onError: () => console.warn('Tenant registry revision poll failed') });
    await resolver.start();
  } catch (error) { await connection.end().catch(() => {}); throw error; }
  const records = new Map();
  function materialize (entry) {
    const current = records.get(entry.tenant);
    if (current && current.entry === entry) { remember(records, entry.tenant, current, settings.maxTenants); return current; }
    const keys = new Map();
    if (accessTokens) {
      for (const key of entry.keys.filter(row => row.purpose === keyPurpose)) {
        const bytes = Buffer.from(key.publicKey, 'base64');
        keys.set(key.kid, Object.freeze({ tenant: entry.tenant, kid: key.kid, issuer: accessTokens.issuer, purpose: keyPurpose === 'access' ? 'data' : 'management',
          publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: bytes.toString('base64url') } }) }));
      }
    }
    const record = Object.freeze({ entry, keys,
      binding: binding ? Object.freeze({ tenant: entry.tenant, ...binding }) : undefined,
      provider: vault ? createVaultTransit({ ...vault, encryptionKey: rules.vaultKey(entry.tenant, 'data'), signingKey: rules.vaultKey(entry.tenant, 'signing'),
        signingVersion: entry.signingVersion }) : undefined,
      // Kept across entry refreshes: domain graphs hold this object per tenant.
      environment: current ? current.environment : environment(entry.tenant) });
    remember(records, entry.tenant, record, settings.maxTenants);
    return record;
  }
  const known = tenant => records.get(tenant);
  const view = {
    resolver: Object.freeze({ async resolve (request) {
      const tenant = await resolver.resolve(request);
      materialize(await resolver.entry(tenant));
      return tenant;
    } }),
    // Load (or refresh) one tenant's entry by id, for paths that name a tenant
    // without a request (internal calls, startup).
    async prepare (tenant) { return materialize(await resolver.entry(tenant)); },
    bindings: Object.freeze({ get: tenant => known(tenant)?.binding, has: tenant => records.has(tenant), keys: () => [][Symbol.iterator]() }),
    providers: Object.freeze({ get: tenant => known(tenant)?.provider, has: tenant => records.has(tenant) }),
    environments: Object.freeze({ get: tenant => known(tenant)?.environment }),
    resolveKey: (tenant, kid) => known(tenant)?.keys.get(kid),
    registry: Object.freeze({ namespace: settings.namespace }),
    tenantIds: Object.freeze(['registry:' + settings.namespace]),
    onRevision: listener => resolver.onRevision(listener),
    stats: () => Object.freeze({ ...resolver.stats(), materialized: records.size }),
    async close () { resolver.close(); records.clear(); await connection.end(); }
  };
  return Object.freeze(view);
}

module.exports = { create };
