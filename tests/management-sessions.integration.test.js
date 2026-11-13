'use strict';

const assert = require('node:assert/strict'), crypto = require('node:crypto'), http = require('node:http');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const createFixture = require('./fixtures/api-fixed-roster-serving');
const { optInSuite } = require('./support/opt-in');
const issuerModule = require('../lib/management-sessions');
const { createPublicKey } = require('node:crypto');
const tokens = require('../lib/tenant-authorization/access-token');
const createAccess = require('../lib/tenant-authorization/access-postgres');
const namespaces = { access: 'preview_access', authorization: 'preview_auth', registry: 'preview_registry', control: 'preview_control' };
const SUBJECT = '000000000000000000000001', consumer = 'native-owner';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

optInSuite(process.env.NS_MANAGEMENT_SESSIONS_DOCKER_TEST === '1', 'NS_MANAGEMENT_SESSIONS_DOCKER_TEST=1')(
  'private operator management sessions (owned PostgreSQL/Vault and serving API cohort)', function () {
    this.timeout(120000);
    const f = createFixture(), [A, B] = f.base.tenants;
    const getKeyName = tenant => require('../lib/tenant-registry/rules').vaultKey(tenant, 'management');
    const publicKeys = new Map();
    let store, access, service, keySource, config, server, adminRuntime, now = Math.floor(Date.now() / 1000);
    const input = (tenant = A) => ({ tenant, subjectId: SUBJECT, requestId: crypto.randomUUID() });
    const admin = fn => f.withAdmin(fn);
    const requestRows = () => admin(async client => (await client.query('SELECT * FROM preview_access.management_session_requests ORDER BY request_id')).rows);
    const blocked = async getPid => f.base.until(async () => {
      const pid = getPid(); return pid && admin(async client => (await client.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked);
    }, 'actual writer waits on issuer-held lock');
    before(async () => {
      await f.setup();
      await run('up', { direct: true, connectionString: f.base.adminConnectionString, namespace: namespaces.registry,
        catalogue: require('../lib/tenant-registry/postgres-candidate.json') });
      let issuerURI, verifierURI;
      await admin(async client => {
        await client.query('CREATE ROLE native_management_authority NOLOGIN NOSUPERUSER NOBYPASSRLS');
        await client.query('CREATE ROLE native_registry_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
        const password = crypto.randomBytes(24).toString('hex');
        await client.query("CREATE ROLE native_management_issuer LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
        const url = new URL(f.base.adminConnectionString); url.username = 'native_management_issuer'; url.password = password; issuerURI = url.toString();
        const verifierPassword = crypto.randomBytes(24).toString('hex');
        await client.query("CREATE ROLE native_management_verifier LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + verifierPassword + "'");
        const verifyURL = new URL(f.base.adminConnectionString); verifyURL.username = 'native_management_verifier'; verifyURL.password = verifierPassword; verifierURI = verifyURL.toString();
        await client.query('GRANT USAGE ON SCHEMA preview_access,preview_auth TO native_management_verifier');
        await client.query('GRANT SELECT ON preview_access.access_tenants,preview_access.access_credentials,preview_access.access_sessions,preview_access.access_keys,preview_auth.tenant_authorization_config,preview_auth.tenant_authorization_subjects,preview_auth.tenant_authorization_roles,preview_auth.tenant_authorization_subject_roles TO native_management_verifier');
        for (const row of (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [namespaces.registry])).rows) await client.query('ALTER TABLE preview_registry."' + row.tablename + '" OWNER TO native_registry_owner');
        for (const row of (await client.query('SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespaces.registry])).rows) {
          await client.query('ALTER FUNCTION ' + row.name + ' OWNER TO native_registry_owner');
          await client.query('ALTER FUNCTION ' + row.name + ' SET search_path=preview_registry,pg_catalog');
        }
        await client.query('ALTER SCHEMA preview_registry OWNER TO native_registry_owner');
        for (const tenant of [A, B]) {
          await client.query("INSERT INTO preview_registry.tenant_registry(tenant_id,state,signing_version) VALUES($1,'active',1)", [tenant]);
          await f.base.operatorVault('transit/keys/' + getKeyName(tenant), { type: 'ed25519', exportable: false });
          const data = (await f.base.operatorVault('transit/keys/' + getKeyName(tenant))).data;
          publicKeys.set(tenant, data.keys['1'].public_key);
          await client.query("INSERT INTO preview_registry.tenant_registry_keys VALUES($1,'management','management1',$2)", [tenant, publicKeys.get(tenant)]);
          await client.query("INSERT INTO preview_access.access_keys VALUES($1,'management1','management',true)", [tenant]);
          const digest = require('../lib/subject-admin/owner-policy').catalogueDigest(['*']);
          await client.query("INSERT INTO preview_auth.tenant_owner_policy(tenant_id,catalogue_digest,ceiling) VALUES($1,$2,ARRAY['*'])", [tenant, digest]);
          await client.query("INSERT INTO preview_auth.tenant_owner_actors(tenant_id,principal,consumer,active,can_update,delegable) VALUES($1,$2,$3,true,true,ARRAY['*'])", [tenant, SUBJECT, consumer]);
          await require('../lib/tenant-activity/provisioning').provisionInTransaction((sql, values) => client.query(sql, values),
            { namespace: namespaces.control, tenant, principal: 'native', consumer: 'fixture' });
        }
        const sql = issuerModule.grants({ namespaces, issuer: 'native_management_issuer', authorityOwner: 'native_management_authority' });
        for (const statement of [...sql.authorityOwner, ...sql.issuer]) await client.query(statement);
      });
      await f.base.operatorVault('sys/policies/acl/native-management-sign', { policy: 'path "transit/keys/tenant-management-*" { capabilities=["read"] }\npath "transit/sign/tenant-management-*" { capabilities=["update"] }' });
      const scoped = (await f.base.operatorVault('auth/token/create', { policies: ['native-management-sign'], no_default_policy: true, ttl: '15m' })).auth.client_token;
      config = { connectionString: issuerURI, namespaces, consumer, actor: { principal: 'native-operator', consumer: 'native-adapter' }, maxLifetimeSeconds: 600, now: () => now };
      store = await issuerModule.createStore(config);
      keySource = issuerModule.createVaultKeySource({ address: f.base.vaultAddress, mount: 'transit', getToken: async () => scoped, allowInsecureLoopback: true });
      service = issuerModule.createManagementSessions({ store, keySource, issuer: 'native-management', audience: 'native-management' });
      access = await createAccess({ connectionString: verifierURI, namespace: namespaces.access, authorityNamespace: namespaces.authorization });
      adminRuntime = await require('../lib/server/serve/admin-preview').boot({ maxBytes: 16384, timeoutMs: 5000,
        managementSessions: { ...config, issuer: 'native-management', audience: 'native-management',
          vault: { address: f.base.vaultAddress, mount: 'transit', getToken: async () => scoped, allowInsecureLoopback: true } } });
      server = http.createServer(adminRuntime.app); await adminRuntime.attach(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    });
    after(async () => { if (server) await new Promise(resolve => server.close(resolve)); if (adminRuntime) await adminRuntime.close(); if (access) await access.close(); if (store) await store.close(); await f.cleanup(); });

    it('selects and signs only the current registry-mapped management key', async () => {
      const selected = await keySource.select({ tenant: A, keys: [{ kid: 'management1', public_key: publicKeys.get(A) }] });
      assert.equal(selected.keyVersion, 1); assert.equal((await selected.sign(Buffer.from('synthetic-management-probe'))).length, 64);
    });

    it('creates a current tenant-bound credential, is idempotent concurrently and never persists plaintext', async () => {
      const selected = input();
      const result = await service.issue(selected);
      assert.equal(result.outcome, 'created'); assert.equal(result.expiresAt, now + 600);
      const repeated = await Promise.all([service.issue(selected), service.issue(selected)]);
      assert(repeated.every(row => row.token === result.token && row.outcome === 'existing'));
      const rows = await requestRows(); assert.equal(rows.length, 1); assert(!JSON.stringify(rows).includes(result.token));
      const verify = tokens.createVerifier({ issuer: 'native-management', audience: 'native-management', purpose: 'management', maxLifetimeSeconds: 600, now: () => now,
        resolveKey: (tenant, kid) => ({ tenant, kid, issuer: 'native-management', purpose: 'management', publicKey: createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeys.get(tenant), 'base64').toString('base64url') } }) }) });
      assert.equal(verify(result.token, A).sid, selected.requestId);
      const authenticate = tokens.createAuthentication({ verifyToken: verify, snapshot: access.snapshot, now: () => now });
      assert.equal((await authenticate({ token: result.token, tenant: A })).claims.sid, selected.requestId);
      assert.throws(() => verify(result.token, B));
      await admin(client => client.query('UPDATE preview_access.access_sessions SET active=false WHERE tenant_id=$1 AND session_id=$2', [A, selected.requestId]));
      await assert.rejects(authenticate({ token: result.token, tenant: A }));
      await assert.rejects(service.issue(selected), { code: 'MANAGEMENT_SESSION_REFUSED' });
      await assert.rejects(service.issue({ ...selected, subjectId: 'foreign' }), { code: 'MANAGEMENT_SESSION_REFUSED' });
    });

    it('issues through the actual private admin composition and stays absent on API listeners', async () => {
      const request = input(), path = '/v1/tenants/' + A + '/management-sessions';
      const url = 'http://127.0.0.1:' + server.address().port + path;
      const body = { subjectId: request.subjectId, requestId: request.requestId };
      const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': request.requestId }, body: JSON.stringify(body) });
      let response = await post(); assert.equal(response.status, 201); const result = await response.json();
      assert.equal(result.sessionId, request.requestId); assert(Number.isSafeInteger(result.expiresAt));
      response = await post(); assert.equal(response.status, 200); assert.equal((await response.json()).token, result.token);
      const token = await f.base.localToken(A);
      assert.equal((await f.base.http(f.current.get('api-1'), A, 'POST', path, token, body)).status, 404);
    });
    const heldIssuer = () => {
      const entered = deferred(), released = deferred();
      const held = issuerModule.createManagementSessions({ store, issuer: 'native-management', audience: 'native-management',
        keySource: { select: async options => {
          const selected = await keySource.select(options);
          return { ...selected, sign: async bytes => { entered.resolve(); await released.promise; return selected.sign(bytes); } };
        } } });
      return { entered, released, held };
    };
    it('refuses revoked and expired sessions and requires an explicit fresh request', async () => {
      const request = input(), result = await service.issue(request);
      await admin(client => client.query('UPDATE preview_access.access_credentials SET enabled=false WHERE tenant_id=$1 AND credential_id=$2', [A, 'management_' + request.requestId.replaceAll('-', '')]));
      await assert.rejects(service.issue(request), { code: 'MANAGEMENT_SESSION_REFUSED' });
      const short = { ...input(), lifetimeSeconds: 1 }; await service.issue(short);
      now += 2;
      try { await assert.rejects(service.issue(short), { code: 'MANAGEMENT_SESSION_EXPIRED' }); }
      finally { now -= 2; }
      assert.equal((await service.issue(input())).outcome, 'created');
      assert(result.token);
      await assert.rejects(service.issue({ ...input(), lifetimeSeconds: 601 }), { code: 'MANAGEMENT_SESSION_INVALID' });
    });
    it('serializes the real owner revocation writer against signing, then refuses the next request', async () => {
      const gate = heldIssuer(); const issuing = gate.held.issue(input());
      await gate.entered.promise;
      let updated = false, writerPid;
      const revoke = admin(async client => { writerPid = client.processID; await client.query('UPDATE preview_auth.tenant_owner_actors SET active=false WHERE tenant_id=$1 AND principal=$2', [A, SUBJECT]); updated = true; });
      try { await blocked(() => writerPid); assert.equal(updated, false, 'OWNER_ROW_LOCK_EXCLUDES_REVOKE'); }
      finally { gate.released.resolve(); }
      await issuing; await revoke;
      try { await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_REFUSED' }); }
      finally { await admin(client => client.query('UPDATE preview_auth.tenant_owner_actors SET active=true WHERE tenant_id=$1 AND principal=$2', [A, SUBJECT])); }
    });
    it('serializes the real active-key revoke writer and refuses the next issuance', async () => {
      const gate = heldIssuer(); const issuing = gate.held.issue(input()); await gate.entered.promise;
      let revoked = false, writerPid;
      const revoke = admin(async client => { writerPid = client.processID; await client.query("UPDATE preview_access.access_keys SET active=false WHERE tenant_id=$1 AND kid='management1'", [A]); revoked = true; });
      try { await blocked(() => writerPid); assert.equal(revoked, false, 'KEY_SHARE_EXCLUDES_REVOKE'); }
      finally { gate.released.resolve(); }
      await issuing; await revoke;
      try { await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_REFUSED' }); }
      finally { await admin(client => client.query("UPDATE preview_access.access_keys SET active=true WHERE tenant_id=$1 AND kid='management1'", [A])); }
    });
    it('refuses a session that expires during a provider call without committing new authority', async () => {
      const request = { ...input(), lifetimeSeconds: 1 }, gate = heldIssuer();
      const issuing = gate.held.issue(request).then(value => ({ value }), error => ({ error })); await gate.entered.promise;
      now += 2; gate.released.resolve();
      try { assert.equal((await issuing).error?.code, 'MANAGEMENT_SESSION_EXPIRED'); }
      finally { now -= 2; }
      assert(!(await requestRows()).some(row => row.request_id === request.requestId));
    });
    it('rolls back all issuance rows after signing when the durable audit insert fails', async () => {
      const request = input();
      const broken = issuerModule.createManagementSessions({ store, issuer: 'native-management', audience: 'native-management', keySource: { select: async options => {
        const selected = await keySource.select(options);
        return { ...selected, sign: async bytes => { const signature = await selected.sign(bytes);
          await admin(client => client.query('REVOKE INSERT ON preview_access.management_session_requests FROM native_management_issuer')); return signature; } };
      } } });
      try { await assert.rejects(broken.issue(request), { code: 'MANAGEMENT_SESSION_UNAVAILABLE' }); }
      finally { await admin(client => client.query('GRANT INSERT ON preview_access.management_session_requests TO native_management_issuer')); }
      await admin(async client => {
        for (const [table, column, value] of [['management_session_requests', 'request_id', request.requestId], ['access_sessions', 'session_id', request.requestId],
          ['access_credentials', 'credential_id', 'management_' + request.requestId.replaceAll('-', '')]]) {
          assert.equal((await client.query('SELECT count(*)::int AS n FROM preview_access.' + table + ' WHERE tenant_id=$1 AND ' + column + '=$2', [A, value])).rows[0].n, 0);
        }
      });
    });
    it('keeps its live metadata-only backend compatible with actual restore and rejects a clinical-write grant', async () => {
      await service.issue(input());
      assert.equal((await f.restore(async () => 'metadata-issuer-live')).state, 'activated');
      await admin(client => client.query('GRANT UPDATE ON preview_clock.tenant_write_clock TO native_management_issuer'));
      try {
        await assert.rejects(f.restore(async () => assert.fail('unknown writer must not enter restore')), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' });
        await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_UNSAFE' });
      } finally { await admin(client => client.query('REVOKE UPDATE ON preview_clock.tenant_write_clock FROM native_management_issuer')); }
      assert.equal((await f.restore(async () => 'grant-removed')).state, 'activated');
    });
    it('holds the actual restore data window until issuance ends and refuses issuance after suspension', async () => {
      const tokenA = await f.base.localToken(A), tokenB = await f.base.localToken(B), request = input();
      const gate = heldIssuer(); const issuing = gate.held.issue(request).then(value => ({ value }), error => ({ error }));
      await gate.entered.promise;
      let entered = false;
      const restoring = f.restore(async () => { entered = true; return 'issuer-fenced-restore'; });
      const outcome = restoring.then(value => ({ value }), error => ({ error }));
      try {
        await f.base.until(async () => (await f.base.http(f.current.get('api-2'), A, 'GET', '/api/v3/entries', tokenA)).status !== 200, 'actual restore suspension');
        assert.equal(entered, false, 'SHARED_ISSUER_LEASE_EXCLUDES_RESTORE_DATA');
        assert.equal((await f.base.http(f.current.get('api-2'), B, 'GET', '/api/v3/entries', tokenB)).status, 200);
      } finally { gate.released.resolve(); }
      assert.equal((await issuing).error?.code, 'MANAGEMENT_SESSION_REFUSED');
      const restored = await outcome; assert.equal(restored.error, undefined, restored.error?.code); assert.equal(restored.value.state, 'activated');
      assert.equal(entered, true); assert(!(await requestRows()).some(row => row.request_id === request.requestId));
    });
    it('blocks the actual deletion activity writer until issuance commits and refuses subsequent issuance', async () => {
      const gate = heldIssuer(); const issuing = gate.held.issue(input()); await gate.entered.promise;
      let written = false, writerPid;
      const deletion = admin(async client => {
        writerPid = client.processID; await client.query('BEGIN');
        try {
          await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
          await require('../lib/tenant-activity/deletion').requested(client, { ledgerNamespace: namespaces.control, tenant: A, requestId: crypto.randomUUID() },
            { plane: 'operator', principal: 'native', consumer: 'fixture' });
          written = true; await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      });
      try { await blocked(() => writerPid); assert.equal(written, false, 'ACTIVITY_SHARE_EXCLUDES_DELETION_WRITER'); }
      finally { gate.released.resolve(); }
      await issuing; await deletion;
      try { await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_REFUSED' }); }
      finally { await admin(client => client.query('UPDATE preview_control.tenant_activity SET paused=false,deletion_request_id=NULL,paused_before_deletion=NULL WHERE tenant_id=$1', [A])); }
    });

    it('pins explicit Vault versions across rotation and refuses retired signing versions', async () => {
      const original = input(), first = await service.issue(original);
      await f.base.operatorVault('transit/keys/' + getKeyName(A) + '/rotate', {});
      const metadata = (await f.base.operatorVault('transit/keys/' + getKeyName(A))).data;
      await admin(async client => {
        await client.query("INSERT INTO preview_registry.tenant_registry_keys VALUES($1,'management','management2',$2)", [A, metadata.keys['2'].public_key]);
        await client.query("INSERT INTO preview_access.access_keys VALUES($1,'management2','management',true)", [A]);
      });
      const next = input(); const second = await service.issue(next);
      assert.equal(JSON.parse(Buffer.from(second.token.split('.')[0], 'base64url')).kid, 'management2');
      assert.equal((await service.issue(original)).token, first.token, 'retained enabled old mapping preserves retry');
      await f.base.operatorVault('transit/keys/' + getKeyName(A) + '/config', { min_encryption_version: 2 });
      await assert.rejects(service.issue(original), { code: 'MANAGEMENT_SESSION_KEY_REFUSED' });
      assert.equal((await service.issue(next)).token, second.token);
      const gate = heldIssuer(), request = input(); const issuing = gate.held.issue(request).then(value => ({ value }), error => ({ error }));
      await gate.entered.promise;
      await f.base.operatorVault('transit/keys/' + getKeyName(A) + '/rotate', {});
      await f.base.operatorVault('transit/keys/' + getKeyName(A) + '/config', { min_encryption_version: 3 });
      gate.released.resolve(); assert((await issuing).error, 'provider rotation must refuse stale pinned signing');
      assert(!(await requestRows()).some(row => row.request_id === request.requestId));
      await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_KEY_REFUSED' });
      await f.base.operatorVault('transit/keys/' + getKeyName(A) + '/config', { min_encryption_version: 1 });
    });
    it('rechecks exact authority function and extra EXECUTE grants before every issuance', async () => {
      await admin(client => client.query('CREATE FUNCTION preview_access.issuer_extra() RETURNS int LANGUAGE sql AS $$SELECT 1$$'));
      try { await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_UNSAFE' }); }
      finally { await admin(client => client.query('DROP FUNCTION preview_access.issuer_extra()')); }
      await admin(client => client.query('ALTER FUNCTION preview_access.management_session_authority(uuid,text,text) SET search_path=pg_catalog'));
      try { await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_UNSAFE' }); }
      finally { await admin(async client => { for (const sql of issuerModule.grants({ namespaces, issuer: 'native_management_issuer', authorityOwner: 'native_management_authority' }).authorityOwner) await client.query(sql); }); }
      await admin(client => client.query('CREATE OR REPLACE FUNCTION preview_access.management_session_authority(target_tenant uuid,target_subject text,target_consumer text) RETURNS TABLE(kid text,public_key text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$BEGIN RETURN; END$$'));
      try { await assert.rejects(service.issue(input()), { code: 'MANAGEMENT_SESSION_UNSAFE' }); }
      finally { await admin(async client => {
        await client.query(require('../lib/management-sessions/authority').CREATE.replace('CREATE FUNCTION management_session_authority', 'CREATE OR REPLACE FUNCTION preview_access.management_session_authority'));
        for (const sql of issuerModule.grants({ namespaces, issuer: 'native_management_issuer', authorityOwner: 'native_management_authority' }).authorityOwner) await client.query(sql);
      }); }
      assert.equal((await service.issue(input())).outcome, 'created');
      const client = new Client({ connectionString: config.connectionString }); await client.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
        await assert.rejects(client.query('SELECT * FROM preview_access.management_session_authority($1,$2,$3)', [B, SUBJECT, consumer]), { code: 'P0001' });
        await client.query('ROLLBACK');
        await assert.rejects(client.query('UPDATE preview_auth.tenant_owner_actors SET active=false'), { code: '42501' });
      } finally { await client.end(); }
    });
  });
