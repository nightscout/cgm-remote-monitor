'use strict';

const express = require('express');
const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const { createSecrets } = require('../../secrets/component');
const { createPostgresSecrets } = require('../../secrets/postgres');
const createLegacyAuthority = require('../../secrets/legacy-postgres');
const createAuthority = require('../../tenant-authorization/postgres');
const createAccessAuthority = require('../../tenant-authorization/access-postgres');
const { createVerifier, createAuthentication } = require('../../tenant-authorization/access-token');
const createDataAccess = require('../tenant-app/data-access');
const createExchange = require('../tenant-app/exchange');
const { createTenantApp } = require('../tenant-app');
const postgresDomains = require('./postgres-domains');
const previewDomains = require('./preview-domains');
const { PreviewConfigError } = require('./preview-config');


async function boot (config, { operationWindow } = {}) {
  const resources = [];
  let closed = false, ready = false;
  // API-local storage/REST serving admission, not clinical freshness or the
  // readiness of an evaluator/provider. Only this owned boot lifecycle writes it.
  const servingState = Object.freeze({ read: () => ready ? 'loaded' : 'unavailable' });
  function quiesce () { ready = false; }
  async function close () {
    quiesce();
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled(resources.reverse().map(resource =>
      resource.end ? resource.end() : resource.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('preview storage shutdown failed');
  }
  try {
    await postgresDomains.readiness(config);
    scope.setTenancyMode('multi');
    const legacy = await createLegacyAuthority({
      connectionString: config.connectionString, namespace: config.namespaces.legacy
    });
    resources.push(legacy);
    const authority = await createAuthority({
      connectionString: config.connectionString, namespace: config.namespaces.authorization
    });
    resources.push(authority);
    let accessTokens;
    if (config.accessTokens) {
      const access = await createAccessAuthority({ connectionString: config.connectionString,
        namespace: config.namespaces.access, authorityNamespace: config.namespaces.authorization });
      resources.push(access);
      accessTokens = { authenticate: createAuthentication({ verifyToken: createVerifier(config.accessTokens), snapshot: access.snapshot }) };
    }
    const persistence = await createPostgresSecrets({
      connectionString: config.connectionString, namespace: config.namespaces.secrets
    });
    resources.push(persistence);
    const connection = await connect({
      connectionString: config.connectionString, ...require('./pool-config').pool('api'),
      statement_timeout: 5000, application_name: 'nightscout-preview-data'
    });
    resources.push(connection);
    const floors = await postgresDomains.assertServing(config, connection, { operationWindow });
    let displaySettings;
    if (config.tenantSettings) {
      // No display-store connection/read/privilege probe precedes raw DATA
      // listener startup. This owned lazy wrapper also drains a pending open
      // during shutdown, so an unavailable display plane cannot leak a pool.
      displaySettings = require('../../tenant-settings/presentation-reader')(config.tenantSettings);
      resources.push(displaySettings);
    }
    // This capability is created only inside this process, for its configured
    // tenant/key bindings. A client principal or consumer never selects it.
    const secrets = createSecrets({
      ...persistence, maxTokenLifetimeSeconds: 28800,
      legacyAuthorityFor: tenant => legacy.read(tenant),
      providerFor: async tenant => {
        const provider = config.providers.get(tenant);
        if (!provider) throw new Error('unconfigured preview tenant');
        return provider;
      },
      authorize: async (identity, action) => {
        const binding = config.bindings.get(identity.tenant);
        if (!binding || identity.principal !== binding.principal || identity.consumer !== binding.consumer) return false;
        if (action.operation === 'decrypt') {
          const current = await legacy.read(identity.tenant);
          return !!current && current.reference.tenant === identity.tenant && current.reference.id === action.id;
        }
        return ['sign', 'verify'].includes(action.operation);
      }
    });
    const verifierContext = tenant => config.bindings.get(tenant);
    const exchange = createExchange({ secrets, authority, verifierContext });
    let rootAdmin;
    if (config.subjectAdmin) {
      // The tenant's root secret administers subjects and roles as on a single
      // site, through the owner-aware writer on its root plane (never owner authority).
      const store = await require('../../subject-admin/postgres')({ connectionString: config.subjectAdmin.connectionString,
        namespace: config.namespaces.authorization, credentialNamespace: config.namespaces.legacy,
        ownerPolicy: config.subjectAdmin.ownerPolicy, plane: 'root' });
      resources.push(store);
      const service = require('../../subject-admin/component').createSubjectAdmin({ store,
        // Authentication established the tenant root or the route's admin
        // permission from the subject's current roles; the store fences the rest.
        authorizeManagement: async actor => actor.consumer === config.bindings.get(actor.tenant)?.consumer });
      rootAdmin = { ...service, authenticate: require('../tenant-app/root-admin').createRootAuthentication({ secrets, authority,
        verifierContext, tenants: [...config.bindings.keys()] }) };
    }
    const dataConnection = config.writeClock
      ? require('../../storage/postgres-write-clock')(connection, config.namespaces.clock) : connection;
    const domains = await previewDomains({ config, connection: dataConnection, exchange, displaySettings, servingState, deferInitialization: true });
    const startup = require('./tenant-startup').create(config.bindings.keys(), operationWindow, async tenant => {
      await floors.ensure(tenant);
      const metadata = await legacy.read(tenant);
      if (!metadata || !metadata.reference || !await persistence.store.get(tenant, metadata.reference.id)) {
        throw new Error('incomplete preview root preparation');
      }
      // Check current authority without inventing required subject display names.
      await authority.authorize({ tenant, principal: { kind: 'anonymous' }, permission: 'api:entries:read' });
      await domains.initializeTenant(tenant);
    });
    await startup.warm();
    let prepareTenant = startup.ensure;
    if (config.activity) {
      await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, catalogue: require('../../tenant-lifecycle/postgres-candidate.json'), statementTimeoutMs: 5000 });
      const activityStore = await require('../../tenant-activity/postgres').create({ connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, capability: 'reader', applicationName: 'nightscout-api-activity' });
      resources.push(activityStore);
      const gate = require('../../tenant-activity/serving').createServingGate(require('../../tenant-activity/eligibility').create({ read: activityStore.read }));
      // Read afresh per request: a pause or suspension applies to the next request.
      prepareTenant = async (tenant, req) => { await gate(tenant, req); await startup.ensure(tenant); };
    }
    const unavailable = async () => { throw new Error('preview management is unavailable'); };
    const app = express();
    app.disable('x-powered-by');
    const humanSessions = await require('../../human-session/runtime').multi({ resolver: config.resolver,
      tenants: [...config.bindings.keys()], consumer: 'oidc', legacyProfiles: [config.accessTokens] });
    if (humanSessions) { resources.push(humanSessions); app.use(humanSessions.prefix, humanSessions.router); }
    // No owner/operator listener or management route is enabled by this role.
    app.use(['/api/v1/tenant', '/api/v1/operator'], (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    app.use(createTenantApp({
      operationWindow, prepareTenant, resolver: config.resolver, dataRouter: domains.data,
      legacyRouter: domains.legacyRouter, rootRouter: domains.rootRouter, rootAdmin,
      dataAccess: createDataAccess({ secrets, authority, verifierContext, accessTokens, humanSessions,
        collections: domains.v3Names, legacyCollections: domains.legacyNames, safeRoutes: domains.safeRoutes,
        derivedReads: config.legacyEnabled }),
      exchange,
      verifyCredential: async () => null, authorizeRequest: async () => false,
      tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }
    }));
    let privateApi;
    if (config.socketForwarding) resources.push(privateApi = await require('../realtime/private-api').boot({
      config, operationWindow, secrets, authority, accessTokens, humanSessions, verifierContext, displaySettings, contextForOperation: domains.socketContextFor, prepareTenant
    }));
    // Shared graphs/private API are ready; suspended tenant warmup remains gated.
    // serve/index opens its listener only after this boot promise resolves.
    ready = true;
    return { app, quiesce, close, ...(privateApi ? { internal: privateApi.internal } : {}), async invalidateTenant (tenant) {
      // Request frames are acquired afresh; retained services hold ports/config only.
      if (!config.bindings.has(tenant)) throw new Error('Unknown preview tenant');
      startup.invalidateTenant(tenant); floors.invalidateTenant(tenant);
    } };
  } catch {
    await close();
    throw new PreviewConfigError('preview readiness or storage initialization refused; check operator preparation and credential privileges');
  }
}

module.exports = { boot };
