'use strict';

// Explicit native acceptance fixtures. Importing this module opens no socket.
// Every resource created below is uniquely named and owned by this invocation.
const { randomBytes, randomUUID } = require('node:crypto');
const { MongoClient } = require('mongodb');
const { Pool } = require('pg');
const scope = require('../../lib/storage/tenant-scope');
const { validateCatalogue } = require('../../lib/migrations/catalogue');
const { createMongoStore, authorityId, principalId } = require('../../lib/human-session/mongo');
const { createPostgresStore } = require('../../lib/human-session/postgres');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
let postgresFixtureActive = false;

function requiredEnvironment (kind) {
  if (process.env.HUMAN_SESSION_NATIVE_RESERVED !== '1') {
    throw new Error('Explicit HUMAN_SESSION_NATIVE_RESERVED=1 required before native store connections');
  }
  const names = kind === 'mongo' ? ['HUMAN_SESSION_MONGO_URL'] : ['HUMAN_SESSION_PG_ADMIN_URL', 'HUMAN_SESSION_PG_APP_URL'];
  if (names.some(name => typeof process.env[name] !== 'string' || !process.env[name])) {
    throw new Error('Explicit native store environment required: ' + names.join(', '));
  }
}

function validate ({ kind, issuer, providerSubject, providerSession, tenant, consumer, acceptedKeys }) {
  if (!['mongo', 'postgres'].includes(kind) || typeof issuer !== 'string' || !issuer || issuer.length > 2048 ||
      typeof providerSubject !== 'string' || !providerSubject || providerSubject.length > 512 ||
      providerSession !== undefined && (typeof providerSession !== 'string' || !providerSession || providerSession.length > 512) ||
      tenant !== undefined && (typeof tenant !== 'string' || !tenant || tenant.length > 128) ||
      typeof consumer !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(consumer) ||
      !Array.isArray(acceptedKeys) || !acceptedKeys.length || acceptedKeys.length > 128 ||
      acceptedKeys.some(key => !key || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) ||
        !['data', 'management'].includes(key.purpose) || typeof key.active !== 'boolean')) {
    throw new TypeError('Explicit native fixture kind and bounded synthetic identity required');
  }
  if (kind === 'postgres' && tenant !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) {
    throw new TypeError('PostgreSQL native fixture requires a canonical UUID tenant');
  }
  if (kind === 'mongo' && tenant !== undefined && tenant !== 'single') {
    throw new TypeError('MongoDB human fixture uses only the fixed private single binding');
  }
}

function cleanupFailure (primary, errors, label) {
  if (primary && errors.length) return new globalThis.AggregateError([primary, ...errors], label + ' setup and owned cleanup failed');
  return primary || (errors.length ? new globalThis.AggregateError(errors, label + ' owned cleanup failed') : null);
}

async function mongoFixture ({ issuer, providerSubject, providerSession, tenant = 'single', consumer, acceptedKeys }) {
  const clientOptions = {
    serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000, socketTimeoutMS: 2000,
    readPreference: 'primary', retryWrites: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 2000 }
  };
  const client = new MongoClient(process.env.HUMAN_SESSION_MONGO_URL, clientOptions);
  const clients = new Set([client]), workerClients = new Set(), startingWorkers = new Set();
  const name = 'human_http_native_' + randomBytes(8).toString('hex');
  const subject = 'synthetic_local';
  let collection, created = false, closing, closed = false;
  function close () {
    if (!closing) closing = (async () => {
      closed = true;
      const errors = [];
      // Drain starts before dropping the owned collection or closing its
      // clients. A partially connected worker is tracked before connect().
      for (const outcome of await Promise.allSettled([...startingWorkers])) {
        if (outcome.status === 'rejected') errors.push(outcome.reason);
      }
      if (created) { try { await collection.drop(); } catch (error) { errors.push(error); } }
      for (const outcome of await Promise.allSettled([...clients].map(owned => owned.close()))) {
        if (outcome.status === 'rejected') errors.push(outcome.reason);
      }
      const failure = cleanupFailure(null, errors, 'MongoDB native fixture');
      if (failure) throw failure;
    })();
    return closing;
  }
  try {
    await client.connect();
    const db = process.env.HUMAN_SESSION_MONGO_DB ? client.db(process.env.HUMAN_SESSION_MONGO_DB) : client.db();
    collection = await db.createCollection(name);
    created = true;
    const id = authorityId(tenant);
    await collection.insertOne({ _id: id, tenant, revision: 1, keys: acceptedKeys,
      principals: [{ id: principalId(tenant, issuer, providerSubject), issuer, providerSubject, subject, consumer,
        enabled: true, generation: 1, credentialGeneration: 1, purposes: ['data', 'management'],
        permissionGroups: [['api:entries:read']] }], sessions: [], logoutEvents: [] });
    const createWorkerStore = async () => {
      if (closed) throw new Error('Native Mongo fixture is closed');
      const worker = new MongoClient(process.env.HUMAN_SESSION_MONGO_URL, clientOptions);
      clients.add(worker);
      workerClients.add(worker);
      const starting = (async () => {
        await worker.connect();
        if (closed) throw new Error('Native Mongo fixture closed while worker started');
        const workerDB = process.env.HUMAN_SESSION_MONGO_DB ? worker.db(process.env.HUMAN_SESSION_MONGO_DB) : worker.db();
        return createMongoStore({ collection: workerDB.collection(name), tenant, consumer });
      })();
      startingWorkers.add(starting);
      try { return await starting; }
      finally { startingWorkers.delete(starting); }
    };
    const store = await createWorkerStore();
    return Object.freeze({ kind: 'mongo', store, tenant, subject, providerSession, close, createWorkerStore,
      resources: Object.freeze({ collection: name }),
      async inspect () {
        if (closed) throw new Error('Native Mongo fixture is closed');
        const document = await collection.findOne({ _id: id }, { readPreference: 'primary', readConcern: { level: 'majority' } });
        if (!document) throw new Error('Owned native Mongo principal disappeared');
        return { kind: 'mongo', tenant, subject,
          execution: { nodeProcesses: 1, engineClientPools: workerClients.size, fixtureClientPools: 1 },
          keys: document.keys, identity: { enabled: document.principals[0].enabled, generation: document.principals[0].generation,
          credentialGeneration: document.principals[0].credentialGeneration, purposes: document.principals[0].purposes,
          permissionGroups: document.principals[0].permissionGroups, revision: document.revision },
        sessions: document.sessions.map(session => {
          const { tokens, ...state } = session;
          return { ...state, access: tokens.map(token => ({ expiresAt: token.expiresAt, issuedAt: token.issuedAt })) };
        }), logoutEvents: document.logoutEvents };
      }
    });
  } catch (primary) {
    const errors = [];
    try { await close(); } catch (error) { errors.push(error); }
    throw cleanupFailure(primary, errors, 'MongoDB native fixture');
  }
}

async function postgresFixture ({ issuer, providerSubject, providerSession, tenant = randomUUID(), consumer, acceptedKeys }) {
  if (postgresFixtureActive) throw new Error('Only one native PostgreSQL fixture may own the process tenancy mode');
  postgresFixtureActive = true;
  const previousMode = scope.getTenancyMode();
  const suffix = randomBytes(8).toString('hex');
  const human = 'hh_human_' + suffix, authority = 'hh_authority_' + suffix, access = 'hh_access_' + suffix;
  const subject = 'synthetic_local';
  const created = [], stores = [];
  let admin, probe, probeClosed = false, closing, closed = false;
  async function boundAdmin (work) {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (primary) {
      try { await client.query('ROLLBACK'); }
      catch (rollback) { throw new globalThis.AggregateError([primary, rollback], 'Native fixture operation and rollback failed'); }
      throw primary;
    } finally { client.release(); }
  }
  function close () {
    if (!closing) closing = (async () => {
      closed = true;
      const errors = [];
      for (const outcome of await Promise.allSettled(stores.map(store => store.close()))) {
        if (outcome.status === 'rejected') errors.push(outcome.reason);
      }
      if (probe && !probeClosed) { try { await probe.end(); probeClosed = true; } catch (error) { errors.push(error); } }
      for (const schema of created.slice().reverse()) {
        try { await admin.query('DROP SCHEMA ' + quote(schema) + ' CASCADE'); } catch (error) { errors.push(error); }
      }
      if (admin) { try { await admin.end(); } catch (error) { errors.push(error); } }
      scope.setTenancyMode(previousMode);
      postgresFixtureActive = false;
      const failure = cleanupFailure(null, errors, 'PostgreSQL native fixture');
      if (failure) throw failure;
    })();
    return closing;
  }
  async function migrate (schema, candidate) {
    await admin.query('CREATE SCHEMA ' + quote(schema));
    created.push(schema);
    await boundAdmin(async client => {
      await client.query('SET LOCAL search_path=' + quote(schema) + ',pg_catalog');
      for (const migration of validateCatalogue(candidate)) for (const sql of migration.up) await client.query(sql);
    });
  }
  try {
    admin = new Pool({ connectionString: process.env.HUMAN_SESSION_PG_ADMIN_URL, max: 2,
      connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2000 });
    probe = new Pool({ connectionString: process.env.HUMAN_SESSION_PG_APP_URL, max: 1,
      connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2000 });
    const appRole = (await probe.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    const adminRole = (await admin.query('SELECT current_user AS name')).rows[0];
    if (!appRole || appRole.rolsuper || appRole.rolbypassrls || appRole.name === adminRole.name) {
      throw new Error('Native PostgreSQL fixture needs distinct admin and NOSUPERUSER NOBYPASSRLS application identities');
    }
    await probe.end();
    probeClosed = true;
    await migrate(access, require('../../lib/tenant-authorization/access-candidate.json'));
    await migrate(authority, require('../../lib/tenant-authorization/postgres-candidate.json'));
    await migrate(human, require('../../lib/human-session/candidate.json'));
    for (const schema of created) await admin.query('GRANT USAGE ON SCHEMA ' + quote(schema) + ' TO ' + quote(appRole.name));
    const reads = [[human,'human_identities'],[human,'human_sessions'],[human,'human_access_tokens'],[human,'human_logout_events'],
      [access,'access_tenants'],[access,'access_credentials'],[access,'access_keys'],[authority,'tenant_authorization_subjects'],
      [authority,'tenant_authorization_roles'],[authority,'tenant_authorization_subject_roles'],
      [authority,'tenant_authorization_config'],[authority,'tenant_owner_actors']];
    for (const [schema, table] of reads) await admin.query('GRANT SELECT ON ' + quote(schema) + '.' + table + ' TO ' + quote(appRole.name));
    await admin.query('GRANT INSERT,UPDATE ON ' + quote(human) + '.human_sessions TO ' + quote(appRole.name));
    await admin.query('GRANT INSERT ON ' + quote(human) + '.human_access_tokens,' + quote(human) + '.human_logout_events TO ' + quote(appRole.name));
    await boundAdmin(async client => {
      await client.query('INSERT INTO ' + quote(access) + '.access_tenants VALUES ($1,true)', [tenant]);
      for (const key of acceptedKeys) await client.query('INSERT INTO ' + quote(access) + '.access_keys VALUES ($1,$2,$3,$4)', [tenant,key.kid,key.purpose,key.active]);
      await client.query('INSERT INTO ' + quote(access) + '.access_credentials VALUES ($1,$2,$3,1,true)', [tenant,'synthetic_human',subject]);
      await client.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_config (tenant_id,anonymous_roles) VALUES ($1,$2)', [tenant,['denied']]);
      await client.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_subjects (tenant_id,subject_id) VALUES ($1,$2)', [tenant,subject]);
      await client.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_roles (tenant_id,name,permissions) VALUES ($1,$2,$3)', [tenant,'synthetic_reader',['api:entries:read']]);
      await client.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_subject_roles VALUES ($1,$2,$3)', [tenant,subject,'synthetic_reader']);
      await client.query('INSERT INTO ' + quote(authority) + '.tenant_owner_policy (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,$3)', [tenant,'a'.repeat(64),[]]);
      await client.query('INSERT INTO ' + quote(authority) + '.tenant_owner_actors (tenant_id,principal,consumer,active,can_update,delegable) VALUES ($1,$2,$3,true,true,$4)', [tenant,subject,consumer,[]]);
      await client.query('INSERT INTO ' + quote(human) + '.human_identities VALUES ($1,$2,$3,$4,$5,true,1,$6)', [tenant,issuer,providerSubject,subject,'synthetic_human',['data','management']]);
    });
    scope.setTenancyMode('multi');
    const createWorkerStore = async () => {
      if (closed) throw new Error('Native PostgreSQL fixture is closed');
      const store = await createPostgresStore({ connectionString: process.env.HUMAN_SESSION_PG_APP_URL,
        namespace: human, authorityNamespace: authority, accessNamespace: access, consumer });
      if (closed) { await store.close(); throw new Error('Native PostgreSQL fixture closed while worker started'); }
      stores.push(store);
      return store;
    };
    const store = await createWorkerStore();
    return Object.freeze({ kind: 'postgres', store, tenant, subject, providerSession, close, createWorkerStore,
      resources: Object.freeze({ human, authority, access }),
      async inspect () {
        if (closed) throw new Error('Native PostgreSQL fixture is closed');
        return boundAdmin(async client => {
          const sessions = await client.query('SELECT session_id AS id,subject_id AS subject,purpose,authenticated_at,created_at,absolute_expires_at,idle_expires_at,active FROM ' + quote(human) + '.human_sessions WHERE tenant_id=$1 ORDER BY created_at,session_id', [tenant]);
          const identity = await client.query('SELECT enabled,generation,purposes FROM ' + quote(human) + '.human_identities WHERE tenant_id=$1 AND issuer=$2 AND provider_subject=$3', [tenant,issuer,providerSubject]);
          const events = await client.query('SELECT event_id,issued_at FROM ' + quote(human) + '.human_logout_events WHERE tenant_id=$1 AND issuer=$2 ORDER BY issued_at,event_id', [tenant,issuer]);
          const keys = await client.query('SELECT kid,purpose,active FROM ' + quote(access) + '.access_keys WHERE tenant_id=$1 ORDER BY purpose,kid', [tenant]);
          return { kind: 'postgres', tenant, subject, keys: keys.rows, identity: identity.rows[0],
            sessions: sessions.rows.map(session => ({ id: session.id, tenant, subject: session.subject, purpose: session.purpose,
              authenticatedAt: Number(session.authenticated_at), createdAt: Number(session.created_at),
              absoluteExpiresAt: session.absolute_expires_at === null ? null : Number(session.absolute_expires_at),
              idleExpiresAt: session.idle_expires_at === null ? null : Number(session.idle_expires_at), active: session.active })),
            logoutEvents: events.rows.map(event => ({ eventId: event.event_id, issuedAt: Number(event.issued_at) })) };
        });
      }
    });
  } catch (primary) {
    const errors = [];
    try { await close(); } catch (error) { errors.push(error); }
    throw cleanupFailure(primary, errors, 'PostgreSQL native fixture');
  }
}

async function createNativeStore ({ kind, issuer, providerSubject, providerSession, tenant, consumer = 'oidc', acceptedKeys } = {}) {
  const options = { kind, issuer, providerSubject, providerSession, tenant, consumer, acceptedKeys };
  validate(options);
  // Keep this before every driver constructor/connection, not just before DDL.
  requiredEnvironment(kind);
  return kind === 'mongo' ? mongoFixture(options) : postgresFixture(options);
}

module.exports = { createNativeStore };
