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
  // Read before any pool opens: an invalid bound refuses the boot with its own message.
  const restAdmission = require('./rest-admission').settings();
  const resources = [];
  const coldAdmission = require('../../storage/connection-admission').coldAdmission();
  let startup;
  let closed = false, ready = false;
  // API-local storage/REST serving admission, not clinical freshness or the
  // readiness of an evaluator/provider. Only this owned boot lifecycle writes it.
  const servingState = Object.freeze({ read: () => ready ? 'loaded' : 'unavailable' });
  function quiesce () { ready = false; }
  async function close () {
    quiesce();
    if (closed) return;
    closed = true;
    const coldClosed = coldAdmission ? await Promise.allSettled([startup?.close()]) : [];
    const results = [...coldClosed, ...await Promise.allSettled(resources.reverse().map(resource =>
      resource.end ? resource.end() : resource.close()))];
    if (results.some(result => result.status === 'rejected')) throw new Error('preview storage shutdown failed');
  }
  try {
    await postgresDomains.readiness(config);
    scope.setTenancyMode('multi');
    if (config.registry) {
      // Registry mode (decision tenant-registry): the tenant view comes from the
      // registry on first request; nothing per tenant is in the configuration.
      const trustedPeers = config.resolution.trustedPeers;
      const tenants = await require('./registry-tenants').create({ settings: config.registry, connectionString: config.connectionString,
        mode: config.resolution.mode, ...(trustedPeers ? { trustedProxy: req => !!req.socket && trustedPeers.includes(req.socket.remoteAddress) } : {}),
        vault: config.registryVault, accessTokens: config.accessTokens, binding: { principal: 'preview-api', consumer: 'tenant-api' },
        applicationName: 'nightscout-api-registry', environment: () => require('../tenant-app/environment')({}) });
      resources.push(tenants);
      config = { ...config, resolver: tenants.resolver, bindings: tenants.bindings, providers: tenants.providers, environments: tenants.environments,
        prepareRegistryTenant: tenants.prepare, registryStats: tenants.stats, humanRegistry: tenants.humanRegistry,
        ...(config.accessTokens ? { accessTokens: { ...config.accessTokens, resolveKey: tenants.resolveKey } } : {}) };
    }
    // The source-branded window catalogue identifies selected-v2. Its retained
    // activation link closes sessions from before same-ID recommission while
    // preserving current HS256 issuance and recovered long-lived credentials.
    const recommissionNamespace = operationWindow?.intakeProfileDigest && require('../../tenant-lifecycle/operation-window').catalogue(operationWindow).migrations
      .some(row => row.name === require('../../tenant-lifecycle/recommission-candidate').NAME) ? operationWindow.namespace : undefined;
    const connection = await connect({
      connectionString: config.connectionString, ...require('./pool-config').pool('api'),
      statement_timeout: 5000, application_name: 'nightscout-preview-data'
    });
    resources.push(connection);
    // Local DATA verification reads verifiers on the request connection, so data
    // access reads them with current authorization in one tenant transaction.
    const legacy = await createLegacyAuthority({
      connectionString: config.connectionString, connection, namespace: config.namespaces.legacy, localVerification: config.localDataAuthentication === true, ...(recommissionNamespace ? { recommissionNamespace } : {}),
      ...(config.localDataAuthentication === true ? { verificationConnection: connection } : {})
    });
    resources.push(legacy);
    let accessTokens;
    if (config.accessTokens) {
      const access = await createAccessAuthority({ connectionString: config.connectionString, connection,
        namespace: config.namespaces.access, authorityNamespace: config.namespaces.authorization });
      resources.push(access);
      accessTokens = { authenticate: createAuthentication({ verifyToken: createVerifier(config.accessTokens), snapshot: access.snapshot }) };
    }
    const persistence = await createPostgresSecrets({
      connectionString: config.connectionString, namespace: config.namespaces.secrets
    });
    resources.push(persistence);
    const authority = await createAuthority({
      connectionString: config.connectionString, connection, namespace: config.namespaces.authorization
    });
    resources.push(authority);
    // Decision readiness-serve-then-warm: 'serve' (default) opens the role once its
    // own dependencies are up and warms tenants in the background; NS_TENANT_READINESS=all
    // keeps ready meaning every tenant initialized.
    const readiness = require('./pool-config').tenantReadiness();
    const floors = await postgresDomains.assertServing(config, connection, { operationWindow, warm: readiness === 'all' });
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
        ownerPolicy: config.subjectAdmin.ownerPolicy, plane: 'root',
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
    let admitRequest, requestContext, writeConnection = connection;
    if (config.activity) {
      await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.connectionString,
        namespace: config.activity.namespace, catalogue: operationWindow ? require('../../tenant-lifecycle/operation-window').catalogue(operationWindow) : require('../../tenant-lifecycle/postgres-candidate.json'), statementTimeoutMs: 5000 });
      const activityStore = await require('../../tenant-activity/postgres').create({ connection,
        namespace: config.activity.namespace, capability: 'reader' });
      const gate = require('../../tenant-activity/serving').createServingGate(require('../../tenant-activity/eligibility').create({ read: activityStore.read }));
      const admission = require('./api-admission')(connection, gate);
      admitRequest = admission.request; requestContext = admission.context; writeConnection = admission.writes;
    }
    const dataConnection = config.writeClock
      ? require('../../storage/postgres-write-clock')(writeConnection, config.namespaces.clock) : writeConnection;
    const domains = await previewDomains({ config, connection: dataConnection,
      exchange: localCodec ? operation => exchange({ ...operation, renewPrevious: false }) : exchange, displaySettings, servingState, deferInitialization: true });
    startup = require('./tenant-startup').create(config.bindings.keys(), operationWindow, async tenant => {
      await floors.ensure(tenant);
      const metadata = await legacy.read(tenant);
      if (!metadata || !metadata.reference || !await persistence.store.get(tenant, metadata.reference.id)) {
        throw new Error('incomplete preview root preparation');
      }
      // Check current authority without inventing required subject display names.
      await authority.authorize({ tenant, principal: { kind: 'anonymous' }, permission: 'api:entries:read' });
      await domains.initializeTenant(tenant);
    }, { readiness, ...(coldAdmission ? {coldAdmission} : {}), ...(config.registry ? { accept: tenant => config.bindings.has(tenant) } : {}) });
    resources.push({ close: async () => startup.close() });
    await startup.warm();
    const prepareTenant = startup.admit;
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
      operationWindow, prepareTenant, admitRequest, requestContext, resolver: config.resolver, dataRouter: domains.data,
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
    if (config.socketForwarding) resources.push(privateApi = await require('../realtime/private-api').boot({
      config, operationWindow, secrets: dataCredentials, authority, accessTokens, humanSessions, verifierContext, displaySettings, contextForOperation: domains.socketContextFor, prepareTenant, admitRequest, requestContext
    }));
    // Shared graphs/private API are ready; suspended tenant warmup remains gated.
    // serve/index opens its listener only after this boot promise resolves.
    ready = true;
    // Decision trusted-worker-performance-boundary: the display settings screen
    // runs here, never in a tenant read: once the listener is open (DATA
    // ingestion is never gated on it) and after a datastore recovery.
    const screenSettings = () => { if (displaySettings) Promise.resolve().then(() => displaySettings.check()).catch(() => {}); };
    // A refused or not yet completed screen is reported as not ready.
    const health = displaySettings ? () => {
      const current = startup.health(), settings = displaySettings.health();
      return Object.freeze({ ...current, displaySettings: settings, storageReady: ready && current.ready, ready: ready && current.ready && settings.ready });
    } : startup.health;
    return { app, quiesce, close, health, attach: async () => screenSettings(), warmed: startup.drained, ...(restLimiter ? { restAdmission: restLimiter.stats } : {}), ...(privateApi ? { internal: privateApi.internal } : {}), async invalidateTenant (tenant) {
      // Request frames are acquired afresh; retained services hold ports/config only.
      if (config.registry) await config.prepareRegistryTenant(tenant);
      if (!config.bindings.has(tenant)) throw new Error('Unknown preview tenant');
      startup.invalidateTenant(tenant); floors.invalidateTenant(tenant);
    },
    // Decision datastore-loss-recover-in-place: after the datastore's postmaster
    // changed, every tenant is cold again, exactly as after a process start
    // (write-clock and insertion floors are read again on the next admission).
    // Nothing here reads the database.
    async invalidateAll () {
      for (const tenant of floors.tenants()) floors.invalidateTenant(tenant, { warm: false });
      for (const tenant of startup.tenants()) startup.invalidateTenant(tenant, { warm: false });
    },
    // The datastore is re-admitted: warm as at boot (in 'serve' readiness a
    // background queue; a request for a tenant not yet warm answers TENANT_WARMING).
    resume () { screenSettings(); Promise.resolve().then(() => startup.warm()).catch(() => {}); } };
  } catch {
    await close();
    throw new PreviewConfigError('preview readiness or storage initialization refused; check operator preparation and credential privileges');
  }
}

module.exports = { boot };
