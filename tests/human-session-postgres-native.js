'use strict';

// Explicit reserved-runtime instrument. Never runs from the ordinary suite.
// Supply isolated ADMIN and non-bypass APP URLs through the environment only.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const { createEngine, tokenHash } = require('../lib/human-session/engine');
const humanAccessFixture = require('./fixtures/human-access-issuer');
const { createPostgresStore } = require('../lib/human-session/postgres');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const tenant = '00000000-0000-0000-0000-000000000001';
const foreignTenant = '00000000-0000-0000-0000-000000000002';
const issuer = 'https://synthetic-provider.invalid';

async function run () {
  if (process.env.HUMAN_SESSION_NATIVE_RESERVED !== '1' || !process.env.HUMAN_SESSION_PG_ADMIN_URL || !process.env.HUMAN_SESSION_PG_APP_URL) {
    throw new Error('Explicit reserved HUMAN_SESSION_PG_ADMIN_URL and HUMAN_SESSION_PG_APP_URL required; no default datastore');
  }
  const admin = new Pool({ connectionString: process.env.HUMAN_SESSION_PG_ADMIN_URL, max: 2,
    connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2000 });
  const appProbe = new Pool({ connectionString: process.env.HUMAN_SESSION_PG_APP_URL, max: 1,
    connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2000 });
  const suffix = randomBytes(6).toString('hex');
  const human = 'hs_human_' + suffix, authority = 'hs_authority_' + suffix, access = 'hs_access_' + suffix;
  const created = [], stores = [], checks = [], cleanupErrors = [];
  let probeClosed = false, result, primary;
  let clock = 1000;
  const crypto = humanAccessFixture({ tenant, now: () => clock });
  const foreignCrypto = humanAccessFixture({ tenant: foreignTenant, now: () => clock });
  const proof = () => ({ issuer, subject: 'provider-a', providerSession: 'provider-session-a', authenticatedAt: clock });
  async function check (name, fn) { await fn(); checks.push({ name, pass: true }); }
  async function migrate (schema, candidate) {
    await admin.query('CREATE SCHEMA ' + quote(schema));
    created.push(schema);
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path=' + quote(schema) + ',pg_catalog');
      for (const migration of validateCatalogue(candidate)) for (const sql of migration.up) await client.query(sql);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  try {
    const appRole = (await appProbe.query('SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    const adminRole = (await admin.query('SELECT current_user AS name')).rows[0];
    assert.equal(appRole.rolsuper, false, 'native app role must be NOSUPERUSER');
    assert.equal(appRole.rolbypassrls, false, 'native app role must be NOBYPASSRLS');
    assert.notEqual(appRole.name, adminRole.name, 'separate native app/admin identities required');
    await appProbe.end();
    probeClosed = true;
    await migrate(access, require('../lib/tenant-authorization/access-candidate.json'));
    await migrate(authority, require('../lib/tenant-authorization/postgres-candidate.json'));
    await migrate(human, require('../lib/human-session/candidate.json'));
    for (const schema of created) await admin.query('GRANT USAGE ON SCHEMA ' + quote(schema) + ' TO ' + quote(appRole.name));
    const readTables = [
      [human, 'human_identities'], [human, 'human_sessions'], [human, 'human_access_tokens'], [human, 'human_logout_events'],
      [access, 'access_tenants'], [access, 'access_credentials'], [access, 'access_keys'],
      [authority, 'tenant_authorization_subjects'], [authority, 'tenant_authorization_roles'],
      [authority, 'tenant_authorization_subject_roles'], [authority, 'tenant_authorization_config'], [authority, 'tenant_owner_actors']
    ];
    for (const [schema, table] of readTables) await admin.query('GRANT SELECT ON ' + quote(schema) + '.' + table + ' TO ' + quote(appRole.name));
    await admin.query('GRANT INSERT,UPDATE ON ' + quote(human) + '.human_sessions TO ' + quote(appRole.name));
    await admin.query('GRANT INSERT ON ' + quote(human) + '.human_access_tokens,' + quote(human) + '.human_logout_events TO ' + quote(appRole.name));
    for (const [id, localSubject, providerSubject] of [[tenant,'local_a','provider-a'],[foreignTenant,'local_b','provider-b']]) {
      await admin.query('INSERT INTO ' + quote(access) + '.access_tenants VALUES ($1,true)', [id]);
      for (const key of (id === tenant ? crypto : foreignCrypto).acceptedKeys) await admin.query('INSERT INTO ' + quote(access) + '.access_keys VALUES ($1,$2,$3,$4)', [id,key.kid,key.purpose,key.active]);
      await admin.query('INSERT INTO ' + quote(access) + '.access_credentials VALUES ($1,$2,$3,1,true)', [id,'credential_a',localSubject]);
      await admin.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_config (tenant_id,anonymous_roles) VALUES ($1,$2)', [id,['denied']]);
      await admin.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_subjects (tenant_id,subject_id) VALUES ($1,$2)', [id,localSubject]);
      await admin.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_roles VALUES ($1,$2,$3,false)', [id,'reader',['api:status:read']]);
      await admin.query('INSERT INTO ' + quote(authority) + '.tenant_authorization_subject_roles VALUES ($1,$2,$3)', [id,localSubject,'reader']);
      await admin.query('INSERT INTO ' + quote(authority) + '.tenant_owner_policy (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,$3)', [id,'a'.repeat(64),[]]);
      await admin.query('INSERT INTO ' + quote(authority) + '.tenant_owner_actors (tenant_id,principal,consumer,active,can_update,delegable) VALUES ($1,$2,$3,true,true,$4)', [id,localSubject,'oidc',[]]);
      await admin.query('INSERT INTO ' + quote(human) + '.human_identities VALUES ($1,$2,$3,$4,$5,true,1,$6)',
        [id,issuer,providerSubject,localSubject,'credential_a',['data','management']]);
    }
    scope.setTenancyMode('multi');
    for (let index = 0; index < 2; index++) stores.push(await createPostgresStore({
      connectionString: process.env.HUMAN_SESSION_PG_APP_URL, namespace: human,
      authorityNamespace: authority, accessNamespace: access, consumer: 'oidc'
    }));
    const engine = createEngine({ store: stores[0], access: crypto.access, now: () => clock });
    const worker = createEngine({ store: stores[1], access: crypto.access, now: () => clock });
    const login = () => engine.login({ tenant, identity: proof(), purpose: 'management' });
    const authenticate = token => worker.authenticate({ tenant, token, purpose: 'management' });
    let issued;
    await check('actual PG current mapping and role grants', async () => {
      issued = await login();
      assert.equal((await authenticate(issued.token)).actor.allows('api:status:read'), true);
      await assert.rejects(engine.login({ tenant, identity: { ...proof(), subject: 'unknown' }, purpose: 'management' }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    });
    await check('actual PG same-second signed renewal is idempotent under the session-row fence', async () => {
      const renewed = await Promise.all(Array.from({ length: 4 }, () => worker.renew({ tenant, token: issued.token, identity: proof() })));
      assert.equal(new Set(renewed.map(result => result.token)).size, 1);
      const stored = await admin.query('SELECT count(*)::integer AS count FROM ' + quote(human) + '.human_access_tokens WHERE tenant_id=$1 AND session_id=$2', [tenant,issued.session.id]);
      assert.equal(stored.rows[0].count, 1);
      for (const result of renewed) await authenticate(result.token);
    });
    await check('foreign tenant replay refuses signed binding and actual RLS token lookup', async () => {
      await assert.rejects(worker.authenticate({ tenant: foreignTenant, token: issued.token, purpose: 'management' }), { code: 'HUMAN_SESSION_REFUSED' });
      await stores[1].transaction({ tenant: foreignTenant, tokenHash: tokenHash(issued.token), keyIds: [] }, async tx => {
        assert.equal(tx.session, null); assert.equal(tx.token, null);
      });
    });
    await check('committed role removal is visible to second worker next operation', async () => {
      await admin.query('UPDATE ' + quote(authority) + '.tenant_authorization_roles SET permissions=$2 WHERE tenant_id=$1', [tenant,[]]);
      assert.equal((await authenticate(issued.token)).actor.allows('api:status:read'), false);
      await admin.query('UPDATE ' + quote(authority) + '.tenant_authorization_roles SET permissions=$2 WHERE tenant_id=$1', [tenant,['api:status:read']]);
    });
    await check('explicit owner membership removal refuses management', async () => {
      await admin.query('UPDATE ' + quote(authority) + '.tenant_owner_actors SET active=false WHERE tenant_id=$1', [tenant]);
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await admin.query('UPDATE ' + quote(authority) + '.tenant_owner_actors SET active=true WHERE tenant_id=$1', [tenant]);
    });
    await check('actual PG current key retirement refuses access and renewal while known logout remains available', async () => {
      await admin.query('UPDATE ' + quote(access) + '.access_keys SET active=false WHERE tenant_id=$1 AND purpose=$2', [tenant,'management']);
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await assert.rejects(worker.renew({ tenant, token: issued.token, identity: proof() }), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await engine.logout({ tenant, token: issued.token });
      await admin.query('UPDATE ' + quote(access) + '.access_keys SET active=true WHERE tenant_id=$1 AND purpose=$2', [tenant,'management']);
      issued = await login();
    });
    await check('logout through worker A refuses copied access through worker B', async () => {
      await engine.logout({ tenant, token: issued.token });
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
    });
    await check('pending renewal waits on durable session fence then refuses committed revocation', async () => {
      issued = await login();
      const lock = await admin.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT session_id FROM ' + quote(human) + '.human_sessions WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE', [tenant,issued.session.id]);
        const renewal = worker.renew({ tenant, token: issued.token, identity: proof() });
        // Attach immediately so a premature rejection cannot be unhandled.
        const refused = assert.rejects(renewal, { code: 'HUMAN_SESSION_REFUSED' });
        refused.catch(() => {});
        let blocked = false;
        const deadline = Date.now() + 1000;
        while (!blocked && Date.now() < deadline) {
          const waiting = await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name='nightscout-human-session' AND $1=ANY(pg_blocking_pids(pid))", [lock.processID]);
          blocked = waiting.rows.length > 0;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'actual application renewal must be observed waiting on the owned session-row lock');
        await lock.query('UPDATE ' + quote(human) + '.human_sessions SET active=false WHERE tenant_id=$1 AND session_id=$2', [tenant,issued.session.id]);
        await lock.query('COMMIT');
        await refused;
        await assert.rejects(authenticate(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      } catch (error) { await lock.query('ROLLBACK'); throw error; }
      finally { lock.release(); }
    });
    await check('access and idle deadlines remain independent and renewal never extends idle', async () => {
      issued = await login();
      clock = 2799;
      const renewed = await worker.renew({ tenant, token: issued.token, identity: proof() });
      assert.equal(renewed.session.idleExpiresAt, 2800);
      assert.equal(renewed.session.authenticatedAt, 1000);
      assert.equal(renewed.session.absoluteExpiresAt, 44200);
      clock = 2800;
      await assert.rejects(authenticate(renewed.token), { code: 'HUMAN_SESSION_REFUSED' });
    });
    await check('provider logout and replay commit durable event and matching revocation', async () => {
      issued = await login();
      const event = { issuer, eventId: 'native-logout-a', issuedAt: clock, subject: 'provider-a', providerSession: 'provider-session-a' };
      // Includes the still-active record whose idle deadline already expired;
      // both NS sessions were bound to this same provider session.
      assert.deepEqual(await engine.logoutProvider({ tenant, event }), { revoked: 2, replayed: false });
      await assert.rejects(authenticate(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      assert.deepEqual(await worker.logoutProvider({ tenant, event }), { revoked: 0, replayed: true });
      const persisted = await admin.query('SELECT count(*)::integer AS count FROM ' + quote(human) + '.human_logout_events WHERE tenant_id=$1', [tenant]);
      assert.equal(persisted.rows[0].count, 1);
    });
    result = { instrument: 'human-session-postgres-native', checks, passed: checks.length };
  } catch (error) {
    primary = error;
  } finally {
    for (const closed of await Promise.allSettled(stores.map(store => store.close()))) {
      if (closed.status === 'rejected') cleanupErrors.push(closed.reason);
    }
    if (!probeClosed) { try { await appProbe.end(); } catch (error) { cleanupErrors.push(error); } }
    for (const schema of created.reverse()) {
      try { await admin.query('DROP SCHEMA ' + quote(schema) + ' CASCADE'); } catch (error) { cleanupErrors.push(error); }
    }
    try { await admin.end(); } catch (error) { cleanupErrors.push(error); }
    scope.setTenancyMode('single');
  }
  if (primary && cleanupErrors.length) throw new globalThis.AggregateError([primary, ...cleanupErrors], 'Native PostgreSQL check and owned cleanup failed');
  if (primary) throw primary;
  if (cleanupErrors.length) throw new globalThis.AggregateError(cleanupErrors, 'Native PostgreSQL owned cleanup failed');
  process.stdout.write(JSON.stringify({ ...result, cleanup: 'closed' }) + '\n');
}

if (require.main === module) run().catch(error => {
  // Do not dump a connection object or environment in the failure record.
  process.stderr.write(JSON.stringify({ instrument: 'human-session-postgres-native', error: error.code || error.name,
    message: error.message }) + '\n');
  process.exitCode = 1;
});

module.exports = { run };
