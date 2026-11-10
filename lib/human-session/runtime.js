'use strict';

const { createEngine } = require('./engine');
const { createProvider } = require('./provider');
const { createHumanHTTP, PREFIX } = require('./http');
const SINGLE = 'single';

function enabled (env) { return Array.isArray(env?.settings?.enable) && env.settings.enable.includes('oidc'); }
function settings (source = process.env) {
  const required = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_ORIGIN', 'OIDC_COOKIE_KEY'];
  if (required.some(name => typeof source[name] !== 'string' || !source[name])) throw new TypeError('Enabled OIDC requires explicit issuer, client ID, origin and cookie key');
  const key = Buffer.from(source.OIDC_COOKIE_KEY, 'base64');
  if (key.length !== 32 || key.toString('base64') !== source.OIDC_COOKIE_KEY) throw new TypeError('OIDC cookie key must be 32 canonical base64 bytes');
  const origin = new URL(source.OIDC_ORIGIN);
  if (origin.origin !== source.OIDC_ORIGIN || origin.protocol !== 'https:') throw new TypeError('OIDC origin must be an HTTPS origin');
  return { issuer: source.OIDC_ISSUER, clientId: source.OIDC_CLIENT_ID,
    clientSecret: source.OIDC_CLIENT_SECRET, signingAlgorithm: source.OIDC_SIGNING_ALGORITHM || 'RS256',
    origin: origin.origin, cookieKey: key };
}

async function compose ({ config, store, resolver, originFor, access }) {
  const provider = await createProvider({ issuer: config.issuer, clientId: config.clientId,
    clientSecret: config.clientSecret, signingAlgorithm: config.signingAlgorithm,
    redirectUri: config.origin + PREFIX + '/callback', requestEmail: config.requestEmail === true });
  const engine = createEngine({ store, access });
  const http = createHumanHTTP({ engine, provider, resolver, cookieKey: config.cookieKey,
    originFor: originFor || (() => config.origin) });
  return Object.freeze({ ...http, engine, provider, prefix: PREFIX });
}

// Single-site: the bindings live in <prefix>human_authority; each names a local
// authorization subject (<prefix>subjects) whose current roles apply. The
// operator's identity list and fallback roles are applied at start.
async function single ({ env, storage, authorization, source = process.env }) {
  if (!enabled(env)) return null;
  const config = settings(source);
  const accessConfig = require('./access-config');
  const access = accessConfig.loadHumanAccess({ source, mode: 'single', tenants: [SINGLE] });
  const list = require('./identity-list').loadIdentityList({ source, issuer: config.issuer });
  const prefix = env.authentication_collections_prefix === undefined ? 'auth_' : env.authentication_collections_prefix;
  if (typeof prefix !== 'string' || prefix.includes('\0')) throw new TypeError('Explicit human authority collection prefix required');
  const collection = storage.collection(prefix + 'human_authority');
  await require('./provision').provision({ collection, authorization: authorization?.storage, tenant: SINGLE, consumer: 'oidc',
    entries: list.entries, fallbackRoles: list.fallbackRoles,
    localKeys: accessConfig.localSigning(source) ? access.keyBindings.map(({ kid, purpose }) => ({ kid, purpose })) : null });
  const roles = require('./subject-roles').createSubjectRoles({ subjects: storage.collection(prefix + 'subjects'),
    roles: storage.collection(prefix + 'roles'), fallbackRoles: [...list.fallbackRoles] });
  const store = require('./mongo').createMongoStore({ collection, tenant: SINGLE, consumer: 'oidc', roles });
  return compose({ config: { ...config, requestEmail: list.requestEmail }, store, access, resolver: { resolve: async () => SINGLE } });
}

async function multi ({ resolver, tenants, consumer, source = process.env, legacyProfiles = [] }) {
  if (!(source.ENABLE || '').split(/\s+/).includes('oidc')) return null;
  const config = settings(source);
  const access = require('./access-config').loadHumanAccess({ source, mode: 'multi', tenants, legacyProfiles });
  const origins = JSON.parse(source.OIDC_TENANT_ORIGINS || '{}');
  if (!Array.isArray(tenants) || Object.keys(origins).length !== tenants.length || tenants.some(tenant => !Object.hasOwn(origins, tenant))) {
    throw new TypeError('OIDC requires one explicit origin per configured tenant');
  }
  const store = await require('./postgres').createPostgresStore({ connectionString: source.OIDC_POSTGRES_CONNECTION,
    namespace: source.OIDC_NAMESPACE, authorityNamespace: source.OIDC_AUTHORITY_NAMESPACE,
    accessNamespace: source.OIDC_ACCESS_NAMESPACE, consumer });
  try {
    const selected = new Map();
    for (const tenant of tenants) selected.set(tenant, await compose({ config: { ...config, origin: origins[tenant] },
      store, resolver, access, originFor: requested => {
        if (requested !== tenant) throw new Error('OIDC foreign origin');
        return origins[tenant];
      } }));
    const router = require('express').Router();
    router.use((req, res, next) => Promise.resolve().then(async () => {
      const tenant = await resolver.resolve(req), runtime = selected.get(tenant);
      if (!runtime) return res.status(404).json({ error: 'TENANT_REFUSED' });
      runtime.router(req, res, next);
    }).catch(() => res.status(503).json({ error: 'HUMAN_SESSION_UNAVAILABLE' })));
    return { router, prefix: PREFIX, engine: selected.values().next().value.engine,
      credential: require('./http').credential,
      accepts: access.accepts,
      authenticate: input => {
        const runtime = selected.get(input.tenant);
        if (!runtime) return Promise.reject(new Error('OIDC tenant refused'));
        return runtime.authenticate(input);
      }, close: () => store.close() };
  } catch (error) { await store.close(); throw error; }
}

module.exports = { enabled, settings, compose, single, multi, SINGLE };
