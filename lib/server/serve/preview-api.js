'use strict';

const { EventEmitter } = require('node:events');
const { Client } = require('pg');
const express = require('express');
const scope = require('../../storage/tenant-scope');
const connect = require('../../storage/postgres-connection');
const { run } = require('../../migrations/postgres');
const { createSecrets } = require('../../secrets/component');
const { createPostgresSecrets } = require('../../secrets/postgres');
const createLegacyAuthority = require('../../secrets/legacy-postgres');
const createAuthority = require('../../tenant-authorization/postgres');
const createDataAccess = require('../tenant-app/data-access');
const createExchange = require('../tenant-app/exchange');
const { createTenantApp } = require('../tenant-app');
const Api3Collection = require('../../api3/generic/collection');
const apiConst = require('../../api3/const.json');
const entriesOptions = require('../tenant-app/entries');
const purifier = require('../purifier');
const { PreviewConfigError } = require('./preview-config');

const CATALOGUES = {
  entries: require('../../../migrations/candidates/postgres-entries-v1.json'),
  authorization: require('../../tenant-authorization/postgres-candidate.json'),
  secrets: require('../../secrets/postgres-candidate.json'),
  legacy: require('../../secrets/legacy-credentials-candidate.json')
};

async function readiness (config) {
  const client = new Client({
    connectionString: config.readinessConnectionString,
    connectionTimeoutMillis: 5000, statement_timeout: 5000,
    application_name: 'nightscout-preview-readiness'
  });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const role = (await client.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
      FROM pg_roles WHERE rolname = current_user`)).rows[0];
    if (!role || Object.values(role).some(Boolean)) throw new Error('unsafe readiness identity');
    for (const namespace of Object.values(config.namespaces)) {
      const state = await client.query(`SELECT
        has_schema_privilege($1, 'CREATE') AS creates,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND
          (pg_has_role(current_user, c.relowner, 'MEMBER') OR
           has_table_privilege(c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
           has_any_column_privilege(c.oid, 'INSERT,UPDATE,REFERENCES'))) AS mutates`, [namespace]);
      if (state.rows[0].creates || state.rows[0].mutates) throw new Error('unsafe readiness privileges');
    }
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  for (const [kind, catalogue] of Object.entries(CATALOGUES)) {
    await run('check', {
      direct: true, connectionString: config.readinessConnectionString,
      namespace: config.namespaces[kind], catalogue, statementTimeoutMs: 5000
    });
  }
}

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
    await readiness(config);
    scope.setTenancyMode('multi');
    const legacy = await createLegacyAuthority({
      connectionString: config.connectionString, namespace: config.namespaces.legacy
    });
    resources.push(legacy);
    const authority = await createAuthority({
      connectionString: config.connectionString, namespace: config.namespaces.authorization
    });
    resources.push(authority);
    const persistence = await createPostgresSecrets({
      connectionString: config.connectionString, namespace: config.namespaces.secrets
    });
    resources.push(persistence);
    const connection = await connect({
      connectionString: config.connectionString, max: 4, connectionTimeoutMillis: 5000,
      statement_timeout: 5000, application_name: 'nightscout-preview-entries'
    });
    resources.push(connection);
    await connection.withTenant('00000000-0000-0000-0000-000000000000', async () => {
      const roles = await connection.query(`SELECT rolcreaterole, rolcreatedb, rolreplication
        FROM pg_roles WHERE rolname = current_user`);
      if (!roles.rows[0] || Object.values(roles.rows[0]).some(Boolean)) throw new Error('unsafe serving identity');
      for (const namespace of Object.values(config.namespaces)) {
        const privilege = await connection.query("SELECT has_schema_privilege($1, 'CREATE') AS creates", [namespace]);
        if (privilege.rows[0].creates) throw new Error('unsafe serving schema privileges');
      }
      const result = await connection.query(`SELECT
        c.relrowsecurity AND c.relforcerowsecurity AS secured,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AND has_table_privilege(c.oid, 'INSERT') AND
          has_table_privilege(c.oid, 'UPDATE') AND has_table_privilege(c.oid, 'DELETE') AS serves,
        has_table_privilege(c.oid, 'TRUNCATE,REFERENCES,TRIGGER') AS extra
        FROM pg_class c WHERE c.oid = to_regclass($1)`, [config.namespaces.entries + '.entries']);
      if (result.rows.length !== 1 || !result.rows[0].secured || result.rows[0].owns ||
          !result.rows[0].serves || result.rows[0].extra) throw new Error('unsafe entries privileges');
    });
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
    const data = express.Router();
    data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
    for (const tenant of config.bindings.keys()) {
      const routes = express(), bus = new EventEmitter(), env = {};
      routes.disable('x-powered-by');
      routes.disable('etag');
      routes.set('trust proxy', false);
      for (const [name, value] of Object.entries(apiConst)) {
        if (name.startsWith('API3_')) routes.set(name, value);
      }
      routes.setENVTruthy = (name, value) => {
        routes.set(name, value);
        return value;
      };
      const collection = new Api3Collection({
        ctx: { bus, purifier: purifier({}, {}) }, env, app: routes, colName: 'entries', storageColName: 'entries',
        fallbackGetDate: doc => new Date(doc.srvModified),
        dedupFallbackFields: ['date', 'type'], fallbackDateField: 'date',
        ...entriesOptions({ connection, table: config.namespaces.entries + '.entries', bus, env })
      });
      collection.mapRoutes();
      data.use((req, res, next) => req.tenantContext.tenant === tenant ? routes(req, res, next) : next());
    }
    const verifierContext = tenant => config.bindings.get(tenant);
    const unavailable = async () => { throw new Error('preview management is unavailable'); };
    const app = express();
    app.disable('x-powered-by');
    // No owner/operator listener or management route is enabled by this role.
    app.use(['/api/v1/tenant', '/api/v1/operator'], (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
    app.use(createTenantApp({
      resolver: config.resolver, dataRouter: data,
      dataAccess: createDataAccess({ secrets, authority, verifierContext }),
      exchange: createExchange({ secrets, authority, verifierContext }),
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
