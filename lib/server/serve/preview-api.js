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


async function boot (config) {
  const resources = [];
  let closed = false;
  async function close () {
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
      connectionString: config.connectionString, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, application_name: 'nightscout-preview-data'
    });
    resources.push(connection);
    await postgresDomains.assertServing(config, connection);
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
    for (const tenant of config.bindings.keys()) {
      const metadata = await legacy.read(tenant);
      if (!metadata || !metadata.reference || !await persistence.store.get(tenant, metadata.reference.id)) {
        throw new Error('incomplete preview root preparation');
      }
      // Check current authority without inventing required subject display names.
      await authority.authorize({ tenant, principal: { kind: 'anonymous' }, permission: 'api:entries:read' });
    }
    const verifierContext = tenant => config.bindings.get(tenant);
    const exchange = createExchange({ secrets, authority, verifierContext });
    const dataConnection = config.writeClock
      ? require('../../storage/postgres-write-clock')(connection, config.namespaces.clock) : connection;
    const domains = await previewDomains({ config, connection: dataConnection, exchange });
    const unavailable = async () => { throw new Error('preview management is unavailable'); };
    const app = express();
    app.disable('x-powered-by');
    // No owner/operator listener or management route is enabled by this role.
    app.use(['/api/v1/tenant', '/api/v1/operator'], (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    app.use(createTenantApp({
      resolver: config.resolver, dataRouter: domains.data,
      legacyRouter: domains.legacyRouter, rootRouter: domains.rootRouter,
      dataAccess: createDataAccess({ secrets, authority, verifierContext, accessTokens,
        collections: domains.v3Names, legacyCollections: domains.legacyNames, safeRoutes: domains.safeRoutes,
        derivedReads: config.legacyEnabled }),
      exchange,
      verifyCredential: async () => null, authorizeRequest: async () => false,
      tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }
    }));
    return { app, close };
  } catch {
    await close();
    throw new PreviewConfigError('preview readiness or storage initialization refused; check operator preparation and credential privileges');
  }
}

module.exports = { boot };
