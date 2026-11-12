'use strict';

// Origin-specific provider clients are created only for registry-resolved
// aliases. Cache settled and pending clients together, with bounded concurrent
// discovery: an alias flood cannot create an unbounded provider-client graph.
const { createEngine } = require('./engine');
const { createProvider } = require('./provider');
const { createHumanHTTP, PREFIX, credential } = require('./http');
const { createRegistryHumanAccess } = require('./registry-access');
const fail = () => Object.assign(new Error('HUMAN_SESSION_UNAVAILABLE'), { code: 'HUMAN_SESSION_UNAVAILABLE' });

function createOriginRuntimes ({ registry, resolver, store, access, config, max = 128, create = createProvider }) {
  if (typeof registry?.resolveOrigin !== 'function' || typeof resolver?.resolve !== 'function' ||
      !Number.isSafeInteger(max) || max < 1 || max > 10000) throw new TypeError('Bounded registry OIDC provider cache required');
  const cache = new Map();
  const engine = createEngine({ store, access });
  let closed = false;
  async function runtime (request, expectedTenant) {
    if (closed) throw fail();
    const { tenant, origin } = await registry.resolveOrigin(request);
    if (expectedTenant !== undefined && tenant !== expectedTenant) throw fail();
    const key = tenant + ':' + origin;
    let row = cache.get(key);
    if (row) { cache.delete(key); cache.set(key, row); return row.promise; }
    if ([...cache.values()].filter(value => value.pending).length >= Math.min(8, max)) throw fail();
    if (cache.size >= max) {
      const oldest = [...cache].find(([, value]) => !value.pending);
      if (!oldest) throw fail();
      cache.delete(oldest[0]);
    }
    row = { pending: true };
    row.promise = Promise.resolve().then(async () => {
      const provider = await create({ issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret,
        signingAlgorithm: config.signingAlgorithm, redirectUri: origin + PREFIX + '/callback', requestEmail: config.requestEmail === true });
      if (closed) throw fail();
      return createHumanHTTP({ engine, provider, resolver, cookieKey: config.cookieKey,
        originFor: requested => { if (requested !== tenant) throw fail(); return origin; } });
    }).then(value => { row.pending = false; return value; }, error => { if (cache.get(key) === row) cache.delete(key); throw error; });
    cache.set(key, row);
    return row.promise;
  }
  const router = require('express').Router();
  router.use((req, res, next) => runtime(req).then(value => value.router(req, res, next))
    .catch(() => res.status(503).json({ error: 'HUMAN_SESSION_UNAVAILABLE' })));
  return Object.freeze({ router, prefix: PREFIX, credential, engine, accepts: access.accepts,
    async authenticate (input) { return (await runtime(input.request, input.tenant)).authenticate(input); },
    stats: () => Object.freeze({ origins: cache.size, pending: [...cache.values()].filter(row => row.pending).length }),
    close () { closed = true; cache.clear(); } });
}

async function createRegistryRuntime ({ resolver, registry, consumer, source, legacyProfiles, config }) {
  if (source.OIDC_TENANT_ORIGINS !== undefined) throw new TypeError('Registry OIDC derives origins from aliases; remove OIDC_TENANT_ORIGINS');
  const access = createRegistryHumanAccess({ source, registry, legacyProfiles });
  const max = source.OIDC_PROVIDER_CACHE_MAX === undefined ? 128 : Number(source.OIDC_PROVIDER_CACHE_MAX);
  const store = await require('./postgres').createPostgresStore({ connectionString: source.OIDC_POSTGRES_CONNECTION,
    namespace: source.OIDC_NAMESPACE, authorityNamespace: source.OIDC_AUTHORITY_NAMESPACE,
    accessNamespace: source.OIDC_ACCESS_NAMESPACE, consumer });
  try {
    const selected = createOriginRuntimes({ registry, resolver, store, access, config, max });
    return Object.freeze({ ...selected, async close () { selected.close(); await store.close(); } });
  } catch (error) { await store.close(); throw error; }
}

module.exports = { createRegistryRuntime, createOriginRuntimes };
