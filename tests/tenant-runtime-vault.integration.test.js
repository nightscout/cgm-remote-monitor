'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const express = require('express');
const request = require('supertest');
const { run } = require('../lib/migrations/postgres');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const createAuthority = require('../lib/tenant-authorization/postgres');
const createLegacyAuthority = require('../lib/secrets/legacy-postgres');
const { createPostgresSecrets } = require('../lib/secrets/postgres');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const createExchange = require('../lib/server/tenant-app/exchange');
const { createTenantApp } = require('../lib/server/tenant-app');
const createResolver = require('../lib/tenant-resolution');
const Api3Collection = require('../lib/api3/generic/collection');
const writer = require('../lib/storage/postgres-entries-write');
const entriesOptions = require('../lib/server/tenant-app/entries');
const purifier = require('../lib/server/purifier');
const { optInSuite } = require('./support/opt-in');

const image = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const ALIASES = [
  { host: 'one.example.test', tenant: A }, { host: 'two.example.test', tenant: B }
];
const INTERNAL_NAMES = [
  { host: 'tenant-a.internal.test', tenant: A }, { host: 'tenant-b.internal.test', tenant: B }
];
const NAMESPACES = [
  ['runtime_data', require('../migrations/candidates/postgres-entries-v1.json')],
  ['runtime_auth', require('../lib/tenant-authorization/postgres-candidate.json')],
  ['runtime_secrets', require('../lib/secrets/postgres-candidate.json')],
  ['runtime_identity', require('../lib/secrets/legacy-credentials-candidate.json')]
];
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
}).trim();

optInSuite(process.env.NS_TENANT_RUNTIME_VAULT_DOCKER_TEST === '1',
  'NS_TENANT_RUNTIME_VAULT_DOCKER_TEST=1')(
  'tenant runtime composition with real Vault Transit and PostgreSQL (disposable Docker)', function () {
    this.timeout(120000);
    const pgName = 'ns-tenant-runtime-pg-' + crypto.randomBytes(8).toString('hex');
    const vaultName = 'ns-tenant-runtime-vault-' + crypto.randomBytes(8).toString('hex');
    const role = 'tenant_runtime_app';
    const roots = [crypto.randomBytes(24).toString('hex'), crypto.randomBytes(24).toString('hex')];
    const subjectTokens = roots.map(root => 'sameviewer-' + hash(hash(root) + SUBJECT).slice(0, 16));
    const providerTokens = new Map();
    const providerOverrides = new Map();
    const workers = [];
    const testTransport = { trusted: true, decisions: 0 };
    let resolverMode = 'direct-alias';
    let pgOwned = false, vaultOwned = false, admin, adminURI, appURI, vaultAddress;
    let previousMode, vaultRoot;

    function context (tenant, principal = 'verifier') {
      return Object.freeze({ tenant, principal, consumer: 'tenant-api' });
    }

    async function vaultRequest (path, body, token = vaultRoot) {
      const response = await fetch(vaultAddress + '/v1/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) {
        if (response.body) await response.body.cancel();
        throw new Error('owned Vault setup failed with HTTP ' + response.status);
      }
      return response.status === 204 ? {} : response.json();
    }

    function transit (tenant, token = providerTokens.get(tenant), address = vaultAddress, timeoutMs = 5000) {
      const label = tenant === A ? 'tenant-a' : 'tenant-b';
      return createVaultTransit({
        address,
        mount: 'transit',
        encryptionKey: label + '-data',
        signingKey: label + '-signing',
        signingVersion: 1,
        getToken: async () => token,
        allowInsecureLoopback: true,
        timeoutMs
      });
    }

    async function waitForPostgres () {
      const deadline = Date.now() + 20000;
      for (;;) {
        assert.equal(docker(['inspect', '--format', '{{.State.Running}}', pgName]), 'true');
        try {
          docker(['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'tenant_runtime']);
          return;
        } catch (error) {
          if (![1, 2].includes(error.status) || Date.now() >= deadline) throw error;
          await delay(100);
        }
      }
    }

    async function waitForVault () {
      const deadline = Date.now() + 20000;
      for (;;) {
        assert.equal(docker(['inspect', '--format', '{{.State.Running}}', vaultName]), 'true');
        try {
          const response = await fetch(vaultAddress + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
          if (response.ok) {
            await response.body.cancel();
            return;
          }
          if (response.body) await response.body.cancel();
        } catch (error) {
          if (!error.cause || !['ECONNREFUSED', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause.code)) throw error;
        }
        if (Date.now() >= deadline) throw new Error('owned Vault did not become ready');
        await delay(100);
      }
    }

    async function checkCatalogues () {
      for (const [namespace, catalogue] of NAMESPACES) {
        const state = await run('check', { direct: true, connectionString: adminURI, namespace, catalogue });
        if (!state.current) throw new Error('runtime schema is stale: ' + namespace);
      }
    }

    async function makeWorker () {
      const worker = {};
      workers.push(worker);
      worker.legacy = await createLegacyAuthority({ connectionString: appURI, namespace: 'runtime_identity' });
      worker.authority = await createAuthority({ connectionString: appURI, namespace: 'runtime_auth' });
      worker.persistence = await createPostgresSecrets({ connectionString: appURI, namespace: 'runtime_secrets' });
      worker.secrets = createSecrets({
        ...worker.persistence,
        providerFor: async tenant => providerOverrides.get(tenant) || transit(tenant, providerTokens.get(tenant)),
        authorize: async (identity, action) => identity.consumer === 'tenant-api' &&
          ((identity.principal === 'verifier' && ['decrypt', 'sign', 'verify'].includes(action.operation)) ||
           (identity.principal === 'importer' && action.operation === 'encrypt')),
        maxTokenLifetimeSeconds: 28800,
        legacyAuthorityFor: tenant => worker.legacy.read(tenant)
      });
      worker.connection = await connect({ connectionString: appURI, max: 1 });
      const data = express.Router();
      data.use((req, res, next) => scope.withTenant(req.tenantContext.tenant, next));
      for (const tenant of [A, B]) {
        const routes = express.Router();
        const bus = new EventEmitter();
        const env = {};
        const routeApp = {
          get: (path, handler) => handler === undefined
            ? (path === 'API3_DEDUP_FALLBACK_ENABLED' ? true : undefined) : routes.get(path, handler),
          setENVTruthy: () => undefined
        };
        for (const method of ['post', 'put', 'patch', 'delete']) routeApp[method] = routes[method].bind(routes);
        const collection = new Api3Collection({
          ctx: { bus, purifier: purifier({}, {}) },
          env, app: routeApp, colName: 'entries', storageColName: 'entries',
          fallbackGetDate: doc => new Date(doc.srvModified),
          dedupFallbackFields: ['date', 'type'], fallbackDateField: 'date',
          ...entriesOptions({ connection: worker.connection, table: 'runtime_data.entries', bus, env })
        });
        collection.mapRoutes();
        data.use((req, res, next) => req.tenantContext.tenant === tenant ? routes(req, res, next) : next());
      }
      const unavailable = async () => { throw new Error('owner services are not installed in this test'); };
      const app = createTenantApp({
        resolver: resolverMode === 'canonical-internal'
          ? createResolver({
            mode: 'canonical-internal',
            internalNames: INTERNAL_NAMES,
            aliases: ALIASES,
            // Test-local loopback provenance only; this is not a production trust adapter.
            trustedProxy: req => {
              testTransport.decisions++;
              return testTransport.trusted && req.socket.remoteAddress === '127.0.0.1';
            }
          })
          : createResolver({ aliases: ALIASES }),
        dataAccess: createDataAccess({
          secrets: worker.secrets, authority: worker.authority,
          verifierContext: tenant => context(tenant)
        }),
        exchange: createExchange({
          secrets: worker.secrets, authority: worker.authority,
          verifierContext: tenant => context(tenant)
        }),
        verifyCredential: async () => null,
        authorizeRequest: async () => false,
        tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
        subjectPolicy: { read: unavailable, replace: unavailable },
        dataRouter: data
      });
      worker.server = app.listen(0, '127.0.0.1');
      await once(worker.server, 'listening');
      assert.equal(worker.server.address().address, '127.0.0.1');
      return worker;
    }

    async function startRuntime () {
      // Operator-owned, read-only readiness only. Never migrate from serving code.
      await checkCatalogues();
      await makeWorker();
      await makeWorker();
    }

    async function stopRuntime () {
      const closing = workers.splice(0);
      await Promise.all(closing.map(async worker => {
        if (worker.server && worker.server.listening) {
          if (typeof worker.server.closeAllConnections === 'function') worker.server.closeAllConnections();
          await new Promise((resolve, reject) =>
            worker.server.close(error => error ? reject(error) : resolve()));
        }
        for (const resource of [worker.connection, worker.legacy, worker.authority, worker.persistence]) {
          if (resource && typeof resource.end === 'function') await resource.end();
          else if (resource && typeof resource.close === 'function') await resource.close();
        }
      }));
      assert.equal(workers.length, 0);
    }

    function ingress (outgoing, tenant, options = {}) {
      const defaultHost = resolverMode === 'canonical-internal'
        ? (tenant === A ? 'tenant-a.internal.test' : 'tenant-b.internal.test')
        : (tenant === A ? 'one.example.test' : 'two.example.test');
      outgoing.set('Host', options.host || defaultHost);
      if (options.forwardedHost !== undefined) outgoing.set('X-Forwarded-Host', options.forwardedHost);
      if (options.resolvedTenant !== undefined) outgoing.set('X-Resolved-Tenant', options.resolvedTenant);
      return outgoing;
    }

    function http (worker, tenant, method, path, credential, options) {
      return ingress(request(workers[worker].server)[method](path), tenant, options)
        .set('Authorization', 'Bearer ' + credential)
        .set('Accept', 'application/json')
        .timeout({ response: 5000, deadline: 15000 });
    }

    function exchange (worker, tenant, credential, options) {
      return ingress(request(workers[worker].server)
        .get('/api/v2/authorization/request/' + encodeURIComponent(credential)), tenant, options)
        .set('Accept', 'application/json')
        .timeout({ response: 5000, deadline: 15000 });
    }

    async function seedEntries () {
      for (const [tenant, sgv] of [[A, 101], [B, 202]]) {
        await workers[0].connection.withTenant(tenant, () => writer({
          connection: workers[0].connection, table: 'runtime_data.entries'
        }).insertOne({
          _id: 'same-id', identifier: 'shared-entry', sgv,
          date: 1793664000000, srvModified: 1793664000000, type: 'sgv'
        }, { normalize: false }));
      }
    }

    async function permissions (tenant, grants = ['api:entries:read']) {
      await admin.query(`UPDATE runtime_auth.tenant_authorization_roles
        SET permissions = $2 WHERE tenant_id = $1 AND name = 'viewer'`, [tenant, grants]);
    }

    async function mutationRows () {
      return (await admin.query(`SELECT tenant_id, doc FROM runtime_data.entries
        WHERE identifier = 'runtime-post' ORDER BY tenant_id`)).rows;
    }

    async function clearMutations () {
      await admin.query("DELETE FROM runtime_data.entries WHERE identifier = 'runtime-post'");
    }

    beforeEach(async function () {
      if (!workers.length) await startRuntime();
    });

    before(async function () {
      previousMode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      const pgPassword = crypto.randomBytes(24).toString('hex');
      execFileSync('docker', ['run', '--rm', '--name', pgName, '-d', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=tenant_runtime', 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: pgPassword }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      pgOwned = true;
      const pgPort = docker(['port', pgName, '5432/tcp']).split(':').pop();
      adminURI = 'postgres://operator:' + pgPassword + '@127.0.0.1:' + pgPort + '/tenant_runtime';
      await waitForPostgres();
      for (const [namespace, catalogue] of NAMESPACES) {
        await run('up', { direct: true, connectionString: adminURI, namespace, catalogue });
      }
      admin = new Client({ connectionString: adminURI });
      await admin.connect();
      const appPassword = crypto.randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
      await admin.query(`GRANT USAGE ON SCHEMA runtime_data, runtime_auth, runtime_secrets, runtime_identity TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON runtime_data.entries TO ${role}`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA runtime_auth, runtime_identity TO ${role}`);
      await admin.query('GRANT SELECT, INSERT ON runtime_secrets.secret_records TO ' + role);
      await admin.query('GRANT INSERT ON runtime_secrets.secret_audit TO ' + role);
      const appURL = new URL(adminURI);
      appURL.username = role;
      appURL.password = appPassword;
      appURI = appURL.toString();
      await admin.query(`INSERT INTO runtime_identity.legacy_credential_config VALUES
        ($1, 'root-a'), ($2, 'root-b')`, [A, B]);
      for (const tenant of [A, B]) {
        await admin.query(`INSERT INTO runtime_identity.legacy_credential_subjects VALUES ($1, $2, 'sameviewer')`,
          [tenant, SUBJECT]);
        await admin.query(`INSERT INTO runtime_auth.tenant_authorization_config VALUES ($1, ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO runtime_auth.tenant_authorization_subjects
          (tenant_id, subject_id, display_name) VALUES ($1, $2, $3)`,
        [tenant, SUBJECT, tenant === A ? 'Same Viewer A' : 'Same Viewer B']);
        await admin.query(`INSERT INTO runtime_auth.tenant_authorization_roles VALUES
          ($1, 'viewer', ARRAY['api:entries:read'])`, [tenant]);
        await admin.query(`INSERT INTO runtime_auth.tenant_authorization_subject_roles VALUES ($1, $2, 'viewer')`,
          [tenant, SUBJECT]);
      }

      vaultRoot = crypto.randomBytes(32).toString('hex');
      execFileSync('docker', ['run', '--name', vaultName, '-d', '-p', '127.0.0.1::8200',
        '-e', 'VAULT_DEV_ROOT_TOKEN_ID', image, 'server', '-dev', '-dev-listen-address=0.0.0.0:8200'],
      { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: vaultRoot },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      vaultOwned = true;
      const vaultPort = docker(['port', vaultName, '8200/tcp']).split(':').pop();
      vaultAddress = 'http://127.0.0.1:' + vaultPort;
      await waitForVault();
      await vaultRequest('sys/mounts/transit', { type: 'transit' });
      for (const [tenant, label] of [[A, 'tenant-a'], [B, 'tenant-b']]) {
        for (const purpose of ['data', 'signing']) {
          await vaultRequest('transit/keys/' + label + '-' + purpose, {
            type: 'aes256-gcm96', exportable: false
          });
        }
        const policy = ['encrypt', 'decrypt'].map(operation =>
          `path "transit/${operation}/${label}-data" { capabilities = ["update"] }`).concat(
          ['hmac', 'verify'].map(operation =>
            `path "transit/${operation}/${label}-signing" { capabilities = ["update"] }`)).join('\n');
        await vaultRequest('sys/policies/acl/' + label, { policy });
        const result = await vaultRequest('auth/token/create', {
          policies: [label], no_default_policy: true, ttl: '5m', renewable: false
        });
        providerTokens.set(tenant, result.auth.client_token);
      }

      await startRuntime();
      for (const [tenant, index] of [[A, 0], [B, 1]]) {
        await workers[0].secrets.encrypt(context(tenant, 'importer'), 'root-' + (index === 0 ? 'a' : 'b'),
          Buffer.from(roots[index]));
      }
      await seedEntries();
    });

    after(async function () {
      try { await stopRuntime(); } finally {
        if (admin) await admin.end();
        if (vaultOwned) docker(['rm', '-f', vaultName]);
        if (pgOwned) docker(['rm', '-f', pgName]);
        scope.setTenancyMode(previousMode);
      }
    });

    it('exchanges both tenants through real Transit and returns only same-ID tenant-local GET/search results across workers', async function () {
      for (const [index, tenant, sgv] of [[0, A, 101], [1, B, 202]]) {
        const response = await exchange(index, tenant, subjectTokens[index]).expect(200);
        assert.equal(response.body.sub, index === 0 ? 'Same Viewer A' : 'Same Viewer B');
        assert.equal(response.body.exp - response.body.iat, 28800);
        assert.deepEqual(response.body.permissionGroups, [['api:entries:read'], []]);
        const read = await http(1 - index, tenant, 'get', '/api/v3/entries/shared-entry', response.body.token).expect(200);
        assert.equal(read.body.result.sgv, sgv);
        const search = await request(workers[1 - index].server).get('/api/v3/entries')
          .set('Host', tenant === A ? 'one.example.test' : 'two.example.test')
          .set('Authorization', 'Bearer ' + response.body.token)
          .query({ 'sgv$eq': String(sgv), limit: '1' })
          .expect(200);
        assert.deepEqual(search.body.result.map(entry => entry.sgv), [sgv]);
        const foreign = await request(workers[1 - index].server).get('/api/v3/entries')
          .set('Host', tenant === A ? 'two.example.test' : 'one.example.test')
          .set('Authorization', 'Bearer ' + response.body.token)
          .query({ 'sgv$eq': String(sgv === 101 ? 202 : 101), limit: '1' })
          .expect(401);
        assert.deepEqual(foreign.body, { error: 'CREDENTIAL_REFUSED' });
      }
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM runtime_data.entries')).rows[0].count, 2);
    });

    it('observes committed permission revocation on another worker and recovers after current grants return', async function () {
      const issued = await exchange(0, A, subjectTokens[0]).expect(200);
      await admin.query(`DELETE FROM runtime_auth.tenant_authorization_subject_roles
        WHERE tenant_id = $1 AND subject_id = $2`, [A, SUBJECT]);
      try {
        const response = await http(1, A, 'get', '/api/v3/entries/shared-entry', issued.body.token).expect(403);
        assert.deepEqual(response.body, { error: 'TENANT_DATA_FORBIDDEN' });
      } finally {
        await admin.query(`INSERT INTO runtime_auth.tenant_authorization_subject_roles
          VALUES ($1, $2, 'viewer')`, [A, SUBJECT]);
      }
      await http(0, A, 'get', '/api/v3/entries/shared-entry', issued.body.token).expect(200);
      await http(1, B, 'get', '/api/v3/entries/shared-entry',
        (await exchange(0, B, subjectTokens[1]).expect(200)).body.token).expect(200);
    });

    it('POSTs through real Transit across workers with tenant-local replacement and fresh create/update grants', async function () {
      const tokens = [];
      const payload = sgv => ({
        identifier: 'runtime-post', date: 1793664001000, utcOffset: 0, app: 'synthetic-runtime', type: 'sgv', sgv
      });
      try {
        for (const [index, tenant] of [[0, A], [1, B]]) {
          tokens[index] = (await exchange(index, tenant, subjectTokens[index]).expect(200)).body.token;
          await permissions(tenant, ['api:entries:read', 'api:entries:create', 'api:entries:update']);
          await http(index, tenant, 'post', '/api/v3/entries', tokens[index])
            .send({ ...payload(index ? 222 : 111), syntheticUnknown: 'remove-on-replacement' })
            .expect(res => assert.equal(res.status, 201, JSON.stringify(res.body)));
          const read = await http(1 - index, tenant, 'get', '/api/v3/entries/runtime-post', tokens[index]).expect(200);
          assert.equal(read.body.result.sgv, index ? 222 : 111);
          assert.equal(read.body.result.syntheticUnknown, 'remove-on-replacement');
        }
        const before = await mutationRows();
        await permissions(A, ['api:entries:read', 'api:entries:create']);
        await http(1, A, 'post', '/api/v3/entries', tokens[0]).send(payload(333)).expect(403);
        assert.deepEqual(await mutationRows(), before);
        await permissions(A, ['api:entries:read', 'api:entries:update']);
        await http(1, A, 'post', '/api/v3/entries', tokens[0]).send(payload(333)).expect(200);
        const replaced = await http(0, A, 'get', '/api/v3/entries/runtime-post', tokens[0]).expect(200);
        assert.equal(replaced.body.result.sgv, 333);
        assert.equal(Object.hasOwn(replaced.body.result, 'syntheticUnknown'), false);
        const after = await mutationRows();
        assert.deepEqual(after.find(row => row.tenant_id === B), before.find(row => row.tenant_id === B));
        await http(0, A, 'post', '/api/v3/entries', tokens[0])
          .send({ ...payload(444), identifier: 'runtime-post-new' }).expect(403);
        assert.equal((await admin.query("SELECT count(*)::int AS n FROM runtime_data.entries WHERE identifier = 'runtime-post-new'")).rows[0].n, 0);
        await permissions(A);
        await http(0, A, 'post', '/api/v3/entries', tokens[0]).send(payload(444)).expect(403);
        assert.deepEqual(await mutationRows(), after);
        const other = await http(0, B, 'get', '/api/v3/entries/runtime-post', tokens[1]).expect(200);
        assert.equal(other.body.result.sgv, 222);
      } finally {
        await permissions(A);
        await permissions(B);
        await clearMutations();
      }
    });

    it('composes canonical ingress with test-local loopback trust and real Vault-backed POST across workers', async function () {
      const previousMode = resolverMode;
      const previousTrust = testTransport.trusted;
      const payload = sgv => ({
        identifier: 'runtime-post', date: 1793664001000, utcOffset: 0,
        app: 'synthetic-runtime', type: 'sgv', sgv
      });
      async function checked (operation) {
        const before = testTransport.decisions;
        const response = await operation;
        assert.equal(testTransport.decisions, before + 1, 'canonical trust is evaluated for every request');
        return response;
      }

      try {
        await stopRuntime();
        resolverMode = 'canonical-internal';
        testTransport.trusted = true;
        await startRuntime();
        await permissions(A, ['api:entries:read', 'api:entries:create', 'api:entries:update']);

        const issued = await checked(exchange(0, A, subjectTokens[0], {
          forwardedHost: 'disposable-first.example.test'
        }).expect(200));
        assert.equal(issued.body.sub, 'Same Viewer A');
        assert.deepEqual(issued.body.permissionGroups, [['api:entries:read', 'api:entries:create', 'api:entries:update'], []]);

        await checked(http(1, A, 'post', '/api/v3/entries', issued.body.token, {
          forwardedHost: 'disposable-write.example.test'
        }).send(payload(111)).expect(201));
        const read = await checked(http(0, A, 'get', '/api/v3/entries/runtime-post', issued.body.token, {
          forwardedHost: 'disposable-rotated.example.test'
        }).expect(200));
        assert.equal(read.body.result.sgv, 111);
        const initialRows = await mutationRows();
        assert.equal(initialRows.length, 1);
        assert.equal(initialRows[0].tenant_id, A);

        const rotated = await checked(exchange(0, A, subjectTokens[0], {
          forwardedHost: 'disposable-next-name.example.test'
        }).expect(200));
        assert.equal(rotated.body.sub, issued.body.sub);
        const rotatedRead = await checked(http(1, A, 'get', '/api/v3/entries/runtime-post', issued.body.token, {
          forwardedHost: 'disposable-final-name.example.test'
        }).expect(200));
        assert.equal(rotatedRead.body.result.sgv, 111);

        await checked(http(1, A, 'post', '/api/v3/entries', issued.body.token, {
          forwardedHost: 'two.example.test'
        }).send(payload(222)).expect(400));
        assert.deepEqual(await mutationRows(), initialRows);

        await checked(exchange(0, A, subjectTokens[0], {
          host: 'missing.internal.test',
          forwardedHost: 'one.example.test',
          resolvedTenant: A
        }).expect(404));
        assert.deepEqual(await mutationRows(), initialRows);

        const tenantB = await checked(exchange(0, B, subjectTokens[1], {
          forwardedHost: 'disposable-tenant-b.example.test'
        }).expect(200));
        const tenantBRead = await checked(http(0, B, 'get', '/api/v3/entries/shared-entry', tenantB.body.token, {
          forwardedHost: 'disposable-tenant-b-read.example.test'
        }).expect(200));
        assert.equal(tenantBRead.body.result.sgv, 202);
        await checked(http(1, B, 'get', '/api/v3/entries/runtime-post', issued.body.token, {
          forwardedHost: 'disposable-tenant-b-foreign-read.example.test'
        }).expect(401));
        await checked(http(1, B, 'post', '/api/v3/entries', issued.body.token, {
          forwardedHost: 'disposable-tenant-b-foreign-write.example.test'
        }).send(payload(333)).expect(401));
        assert.deepEqual(await mutationRows(), initialRows);

        testTransport.trusted = false;
        await checked(http(1, A, 'post', '/api/v3/entries', issued.body.token)
          .send(payload(444)).expect(400));
        assert.deepEqual(await mutationRows(), initialRows);

        testTransport.trusted = true;
        await checked(http(1, A, 'post', '/api/v3/entries', issued.body.token, {
          forwardedHost: 'disposable-restored.example.test'
        }).send(payload(555)).expect(200));
        const restoredRead = await checked(http(0, A, 'get', '/api/v3/entries/runtime-post', issued.body.token, {
          forwardedHost: 'disposable-restored-read.example.test'
        }).expect(200));
        assert.equal(restoredRead.body.result.sgv, 555);
      } finally {
        resolverMode = previousMode;
        testTransport.trusted = previousTrust;
        try {
          await permissions(A);
          await permissions(B);
          await clearMutations();
        } finally {
          await stopRuntime();
        }
      }
    });

    it('fails closed on a real cross-tenant Transit ACL refusal and provider outage, then recovers without local signing', async function () {
      const valid = await exchange(0, A, subjectTokens[0]).expect(200);
      const ciphertext = (await workers[0].persistence.store.get(A, 'root-a')).ciphertext;
      const wrongKeyProvider = transit(A, providerTokens.get(B));
      await assert.rejects(wrongKeyProvider.decrypt(ciphertext), { code: 'SECRETS_PROVIDER_REFUSED' });
      providerOverrides.set(A, wrongKeyProvider);
      try {
        const refused = await exchange(0, A, subjectTokens[0]).expect(503);
        assert.deepEqual(refused.body, { error: 'AUTHORITY_UNAVAILABLE' });
      } finally {
        providerOverrides.delete(A);
      }

      const pausedVaultProvider = transit(A, providerTokens.get(A), vaultAddress, 250);
      await permissions(A, ['api:entries:read', 'api:entries:create']);
      const before = await mutationRows();
      docker(['pause', vaultName]);
      assert.equal(docker(['inspect', '--format', '{{.State.Paused}}', vaultName]), 'true');
      providerOverrides.set(A, pausedVaultProvider);
      try {
        for (const operation of [() => exchange(0, A, subjectTokens[0]),
          () => http(1, A, 'get', '/api/v3/entries/shared-entry', valid.body.token),
          () => http(1, A, 'post', '/api/v3/entries', valid.body.token)
            .send({ identifier: 'runtime-post', date: 1793664001000, utcOffset: 0,
              app: 'synthetic-runtime', type: 'sgv', sgv: 123 })]) {
          const response = await operation().expect(503);
          assert.deepEqual(response.body, { error: 'AUTHORITY_UNAVAILABLE' });
        }
        assert.deepEqual(await mutationRows(), before);
      } finally {
        docker(['unpause', vaultName]);
        providerOverrides.delete(A);
        await waitForVault();
        await permissions(A);
      }
      const recovered = await exchange(1, A, subjectTokens[0]).expect(200);
      await http(0, A, 'get', '/api/v3/entries/shared-entry', recovered.body.token).expect(200);
      await http(1, A, 'get', '/api/v3/entries/shared-entry', valid.body.token).expect(200);
      try {
        await permissions(A, ['api:entries:read', 'api:entries:create']);
        await http(0, A, 'post', '/api/v3/entries', valid.body.token)
          .send({ identifier: 'runtime-post', date: 1793664001000, utcOffset: 0,
            app: 'synthetic-runtime', type: 'sgv', sgv: 123 }).expect(201);
        const read = await http(1, A, 'get', '/api/v3/entries/runtime-post', valid.body.token).expect(200);
        assert.equal(read.body.result.sgv, 123);
      } finally {
        await permissions(A);
        await clearMutations();
      }
    });

    it('refuses unsafe serving privileges and refuses stale required schema before listener bind', async function () {
      await admin.query('GRANT UPDATE (display_name) ON runtime_auth.tenant_authorization_subjects TO ' + role);
      try {
        await assert.rejects(createAuthority({ connectionString: appURI, namespace: 'runtime_auth' }),
          { code: 'TENANT_AUTHORITY_UNSAFE' });
      } finally {
        await admin.query('REVOKE UPDATE (display_name) ON runtime_auth.tenant_authorization_subjects FROM ' + role);
      }

      await stopRuntime();
      const altered = await admin.query(`UPDATE runtime_data.schema_migrations SET checksum = $1
        WHERE name = '0001_entries' RETURNING checksum`, ['0'.repeat(64)]);
      assert.equal(altered.rowCount, 1);
      try {
        await assert.rejects(startRuntime(), error => ['MIG_STALE', 'MIG_DRIFT'].includes(error.code));
        assert.equal(workers.length, 0, 'read-only readiness must refuse before constructing or binding serving apps');
      } finally {
        await admin.query(`UPDATE runtime_data.schema_migrations SET checksum = $1 WHERE name = '0001_entries'`,
          [NAMESPACES[0][1].migrations[0].checksum]);
      }
      await startRuntime();
      const current = await exchange(0, A, subjectTokens[0]).expect(200);
      await http(0, A, 'get', '/api/v3/entries/shared-entry', current.body.token).expect(200);
    });

    it('closes both serving workers and their PostgreSQL pools cleanly', async function () {
      await stopRuntime();
      assert.equal(workers.length, 0);
    });
  });
