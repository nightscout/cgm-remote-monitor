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
const previewDomains = require('./preview-domains');
const { PreviewConfigError } = require('./preview-config');
const roleReadiness = require('./role-readiness');


async function boot (config, { operationWindow } = {}) {
  // Read before any pool opens: an invalid bound refuses the boot with its own message.
  const restAdmission = require('./rest-admission').settings();
  const tenantCache = require('./api-tenant-cache').create(require('./pool-config').apiTenantCache(process.env,
    { capacity: config.registry?.maxTenants }));
  const resources = [tenantCache];
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
    // The role's own start check (decision platform-verification-removal):
    // its login cannot bypass row-level security and its ledgers are current.
    await roleReadiness.admit(config, 'api');
    scope.setTenancyMode('multi');
    if (config.registry) {
      // Registry mode (decision tenant-registry): the tenant view comes from the
      // registry on first request; nothing per tenant is in the configuration.
      const trustedPeers = config.resolution.trustedPeers;
      const tenants = await require('./registry-tenants').create({ settings: { ...config.registry, maxTenants: tenantCache.stats().capacity }, cache: tenantCache, connectionString: config.connectionString,
        mode: config.resolution.mode, ...(trustedPeers ? { trustedProxy: req => !!req.socket && trustedPeers.includes(req.socket.remoteAddress) } : {}),
        vault: config.registryVault, accessTokens: config.accessTokens, binding: { principal: 'preview-api', consumer: 'tenant-api' },
        applicationName: 'nightscout-api-registry', environment: () => require('../tenant-app/environment')({}) });
      resources.push(tenants);
      config = { ...config, resolver: tenants.resolver, bindings: tenants.bindings, providers: tenants.providers, environments: tenants.environments,
        prepareRegistryTenant: tenants.prepare, registryStats: tenants.stats, humanRegistry: tenants.humanRegistry,
        tenantRecord: tenants.record, runRegistryTenant: tenants.run,
        ...(config.accessTokens ? { accessTokens: { ...config.accessTokens, resolveKey: tenants.resolveKey } } : {}) };
    }
    // The source-branded window catalogue identifies selected-v2. Its retained
    // activation link closes sessions from before same-ID recommission while
    // preserving current HS256 issuance and recovered long-lived credentials.
    const recommissionNamespace = operationWindow?.selectionDigest && require('../../tenant-lifecycle/generation-scope').catalogue(operationWindow).migrations
      .some(row => row.name === require('../../tenant-lifecycle/recommission-candidate').NAME) ? operationWindow.namespace : undefined;
    const connection = await connect({
      connectionString: config.connectionString, ...require('./pool-config').pool('api'),
      // Borrowed request authority starts on this pool. A paused database cannot
      // enforce statement_timeout, so query failure needs a local deadline.
      statement_timeout: 5000, query_timeout: 1000, application_name: 'nightscout-preview-data'
    });
    resources.push(connection);
    // Local DATA verification reads verifiers on the request connection, so data
    // access reads them with current authorization in one tenant transaction.
    const legacy = await createLegacyAuthority({
      connectionString: config.connectionString, connection, namespace: config.namespaces.legacy, localVerification: config.localDataAuthentication === true, platformVerified: true, ...(recommissionNamespace ? { recommissionNamespace } : {}),
      ...(config.localDataAuthentication === true ? { verificationConnection: connection } : {})
    });
    resources.push(legacy);
    let accessTokens;
    if (config.accessTokens) {
      const access = await createAccessAuthority({ connectionString: config.connectionString, connection,
        namespace: config.namespaces.access, authorityNamespace: config.namespaces.authorization, platformVerified: true });
      resources.push(access);
      accessTokens = { authenticate: createAuthentication({ verifyToken: createVerifier(config.accessTokens), snapshot: access.snapshot }) };
    }
    const persistence = await createPostgresSecrets({
      connectionString: config.connectionString, namespace: config.namespaces.secrets, platformVerified: true
    });
    resources.push(persistence);
    const authority = await createAuthority({
      connectionString: config.connectionString, connection, namespace: config.namespaces.authorization, platformVerified: true
    });
    resources.push(authority);
    let displaySettings;
    if (config.tenantSettings) {
      // No display-store connection/read/privilege probe precedes raw DATA
      // listener startup. This owned lazy wrapper also drains a pending open
      // during shutdown, so an unavailable display plane cannot leak a pool.
      displaySettings = require('../../tenant-settings/presentation-reader')(config.tenantSettings, { platformVerified: true });
      resources.push(displaySettings);
    }
    // This capability is created only inside this process, for its configured
    // tenant/key bindings. A client principal or consumer never selects it.
    const secrets = createSecrets({
      ...persistence, maxTokenLifetimeSeconds: 28800,
      legacyAuthorityFor: tenant => legacy.read(tenant),
      ...(recommissionNamespace ? { legacySessionEpochFor: async tenant => (await legacy.read(tenant)).sessionEpoch } : {}),
      providerFor: async tenant => {
        const provider = config.providers.get(tenant);
        if (!provider) throw new Error('unconfigured preview tenant');
        return provider;
      },
      authorize: async (identity, action, legacyAuthority) => {
        const binding = config.bindings.get(identity.tenant);
        if (!binding || identity.principal !== binding.principal || identity.consumer !== binding.consumer) return false;
        if (action.operation === 'decrypt') {
          // Only the component's private legacy verifier supplies this fresh
          // operation-local read. Generic decrypt still reads current authority.
          const current = legacyAuthority || await legacy.read(identity.tenant);
          return !!current && current.reference.tenant === identity.tenant && current.reference.id === action.id;
        }
        return ['sign', 'verify', 'issue-legacy'].includes(action.operation);
      }
    });
    const verifierContext = tenant => config.bindings.get(tenant);
    const localCodec = config.localDataAuthentication
      ? require('../../tenant-authorization/legacy-data-token').create(config.accessTokens) : null;
    const dataCredentials = localCodec ? require('../../secrets/legacy-verifiers').create({
      read: legacy.readVerification, verifyToken: localCodec.verify, usesConnection: legacy.usesConnection
    }) : secrets;
    const exchange = localCodec ? require('../tenant-app/local-exchange')({ credentials: dataCredentials,
      secrets, authority, verifierContext, store: legacy, codec: localCodec, audit: persistence.audit })
      : createExchange({ secrets, authority, verifierContext });
    let rootAdmin;
    if (config.subjectAdmin) {
      // The tenant's root secret administers subjects and roles as on a single
      // site, through the owner-aware writer on its root plane (never owner authority).
      const store = await require('../../subject-admin/postgres')({ connectionString: config.subjectAdmin.connectionString,
        namespace: config.namespaces.authorization, credentialNamespace: config.namespaces.legacy,
        ownerPolicy: config.subjectAdmin.ownerPolicy, plane: 'root', platformVerified: true,
        ...(localCodec ? { prepareCredential: async (actor, subject) =>
          (await secrets.deriveLegacyVerifiers(verifierContext(actor.tenant), [subject])).subjects[0].verifiers } : {}) });
      resources.push(store);
      const service = require('../../subject-admin/component').createSubjectAdmin({ store,
        // Authentication established the tenant root or the route's admin
        // permission from the subject's current roles; the store fences the rest.
        authorizeManagement: async actor => actor.consumer === config.bindings.get(actor.tenant)?.consumer });
      rootAdmin = { ...service, authenticate: require('../tenant-app/root-admin').createRootAuthentication({ secrets: { ...secrets, verifyLegacyCredential: dataCredentials.verifyLegacyCredential }, authority,
        verifierContext, tenants: config.registry ? tenant => config.bindings.has(tenant) : [...config.bindings.keys()] }) };
    }
    let admitRequest, writeConnection = connection;
    if (config.activity) {
      const activityStore = await require('../../tenant-activity/postgres').create({ connection,
        namespace: config.activity.namespace, capability: 'reader', platformVerified: true });
      const gate = require('../../tenant-activity/serving').createServingGate(require('../../tenant-activity/eligibility').create({ read: activityStore.read }));
      const admission = require('./api-admission')(connection, gate);
      admitRequest = admission.request; writeConnection = admission.writes;
    }
    const dataConnection = require('../../storage/postgres-write-clock')(writeConnection, config.namespaces.clock);
    const domains = await previewDomains({ config, connection: dataConnection,
      exchange: localCodec ? operation => exchange({ ...operation, renewPrevious: false }) : exchange, displaySettings, servingState, tenantCache });
    const prepareTenant = (tenant, request) => domains.prepareTenant(tenant, request);
    const unavailable = async () => { throw new Error('preview management is unavailable'); };
    const app = express();
    app.disable('x-powered-by');
    // Bounded REST admission (NS_API_REST_*): first on the consumer listener, so a
    // refused request runs no handler and has no storage effect. serve.internal
    // (socket authority, lifecycle status) is a separate listener and is not counted.
    const restLimiter = restAdmission ? require('./rest-admission').create(restAdmission) : null;
    if (restLimiter) app.use(restLimiter.middleware);
    const humanSessions = await require('../../human-session/runtime').multi({ resolver: config.resolver,
      tenants: [...config.bindings.keys()], consumer: 'oidc', legacyProfiles: [config.accessTokens], registry: config.humanRegistry });
    if (humanSessions) { resources.push(humanSessions); app.use(humanSessions.prefix, humanSessions.router); }
    // No owner/operator listener or management route is enabled by this role.
    app.use(['/api/v1/tenant', '/api/v1/operator'], (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    app.use(createTenantApp({
      operationWindow, prepareTenant, admitRequest, resolver: config.resolver, dataRouter: domains.data,
      legacyRouter: domains.legacyRouter, rootRouter: domains.rootRouter, rootAdmin,
      dataAccess: createDataAccess({ secrets: dataCredentials, authority, verifierContext, accessTokens, humanSessions, readConnection: connection,
        collections: domains.v3Names, legacyCollections: domains.legacyNames, safeRoutes: domains.safeRoutes,
        derivedReads: config.legacyEnabled }),
      exchange,
      verifyCredential: async () => null, authorizeRequest: async () => false,
      tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }
    }));
    let privateApi;
    // Private authorization needs recorded tenant admission, not a DATA graph.
    // A forwarded mutation selects its service inside socketContextFor.
    if (config.socketForwarding) resources.push(privateApi = await require('../realtime/private-api').boot({
      config, operationWindow, secrets: dataCredentials, authority, accessTokens, humanSessions, verifierContext, displaySettings, contextForOperation: domains.socketContextFor, admitRequest
    }));
    // Shared graphs/private API are ready. Tenant state is built only on use.
    // serve/index opens its listener only after this boot promise resolves.
    ready = true;
    // Display reads fail closed independently. Their pending or failed component
    // state remains visible without withdrawing raw DATA serving readiness.
    const health = () => {
      const settings = displaySettings?.health();
      return { storageReady: ready, ready,
        tenantCache: tenantCache.stats(), ...(settings ? { displaySettings: settings } : {}) };
    };
    return { app, quiesce, close, health, attach: async () => {}, warmed: async () => {}, ...(restLimiter ? { restAdmission: restLimiter.stats } : {}), ...(privateApi ? { internal: privateApi.internal } : {}), async invalidateTenant (tenant) {
      // Request frames are acquired afresh; retained services hold ports/config only.
      const invalidate = () => {
        if (!config.bindings.has(tenant)) throw new Error('Unknown preview tenant');
        domains.invalidateTenant(tenant);
      };
      return config.runRegistryTenant ? config.runRegistryTenant(tenant, invalidate) : invalidate();
    },
    // Decision datastore-loss-recover-in-place: after the datastore's postmaster
    // changed, drop disposable services. Durable clocks and floors
    // remain in the database; no roster is queued for rewarming.
    async invalidateAll () { domains.invalidateAll(); },
    resume () {} };
  } catch (error) {
    await close();
    if (roleReadiness.keeps(error)) throw error;
    throw new PreviewConfigError('preview readiness or storage initialization refused; check operator preparation and credential privileges');
  }
}

module.exports = { boot };
