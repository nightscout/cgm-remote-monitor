'use strict';

// Decision credential-rotation-next-request (amended 2026-11-19) / D23: a
// socket write or ack forwarded to the api is its own admitted api request,
// authorized once at admission: one credential verification and one authority
// read. Revocation after admission applies from the next request.
// Production pieces: tenant authorization (PostgreSQL), the socket authority,
// the private api receiver and the alarm receiver/writer. Labelled stand-ins:
// the legacy credential verifier (synthetic token map); admitRequest, which
// runs the operation once as api-admission's request does (its effect-time
// re-check is lane Z1's to delete); executeWrite, standing for the canonical
// socket handlers; alarm storage (privileges, clock, upsert). Synthetic data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/tenant-authorization/postgres-candidate.json');
const createTenantAuthorization = require('../lib/tenant-authorization/postgres');
const createSocketAuthority = require('../lib/server/realtime/authority').create;
const privateApi = require('../lib/server/realtime/private-api');
const apiAdmission = require('../lib/server/serve/api-admission');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const HOST = 'one.example.test';
const NAMESPACE = 'socket_write_authority';
const T = name => '"' + NAMESPACE + '".tenant_authorization_' + name;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TOKENS = { 'synthetic-writer': { kind: 'subject', subjectId: 'writer' }, 'synthetic-reader': { kind: 'subject', subjectId: 'reader' } };

optInSuite(process.env.NS_TENANT_AUTHORITY_POSTGRES_DOCKER_TEST === '1',
  'NS_TENANT_AUTHORITY_POSTGRES_DOCKER_TEST=1')('forwarded socket write authority (disposable PostgreSQL)', function () {
  this.timeout(30000);
  const container = 'ns-z2-socket-authority-pg-' + crypto.randomBytes(8).toString('hex');
  let owned = false, previousMode, admin, authority;
  const counts = { credential: 0, authority: 0 };

  before(async function () {
    previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=socket_authority',
      process.env.NS_TENANT_AUTHORITY_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    const adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/socket_authority';
    const deadline = Date.now() + 15000;
    let ready = false;
    do {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'socket_authority']); ready = true; } catch (error) {
        if (error.status !== 1 && error.status !== 2) throw error;
        await sleep(100);
      }
    } while (!ready && Date.now() < deadline);
    assert.ok(ready, 'owned PostgreSQL must become responsive');
    // pg_isready can answer during the image's init restart; retry the first migration.
    for (let attempt = 0; ; attempt++) {
      try { await run('up', { direct: true, connectionString: adminURI, namespace: NAMESPACE, catalogue }); break; } catch (error) {
        if (attempt > 50) throw error;
        await sleep(200);
      }
    }
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    const appRole = 'socket_authority_app', appPassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${NAMESPACE}" TO ${appRole}`);
    await admin.query(`GRANT SELECT ON ${T('config')}, ${T('roles')}, ${T('subjects')}, ${T('subject_roles')} TO ${appRole}`);
    const url = new URL(adminURI);
    url.username = appRole; url.password = appPassword;
    const real = await createTenantAuthorization({ connectionString: url.toString(), namespace: NAMESPACE });
    // Every adapter call is one SQL statement; count calls, keep behaviour.
    authority = Object.fromEntries(Object.entries(real).map(([name, value]) => [name,
      typeof value === 'function' && name !== 'close' && name !== 'usesConnection'
        ? (...args) => { counts.authority++; return value(...args); } : value]));
    authority.close = real.close;
  });

  beforeEach(async function () {
    await admin.query(`DELETE FROM ${T('subject_roles')}`);
    await admin.query(`DELETE FROM ${T('subjects')}`);
    await admin.query(`DELETE FROM ${T('roles')}`);
    await admin.query(`DELETE FROM ${T('config')}`);
    await admin.query(`INSERT INTO ${T('config')} (tenant_id, anonymous_roles) VALUES ($1, ARRAY['readable'])`, [A]);
    await admin.query(`INSERT INTO ${T('roles')} (tenant_id, name, permissions) VALUES
      ($1, 'writer', ARRAY['api:*:read', 'api:*:create,update,delete', 'notifications:*:ack'])`, [A]);
    await admin.query(`INSERT INTO ${T('subjects')} (tenant_id, subject_id, display_name) VALUES ($1, 'writer', 'Writer'), ($1, 'reader', 'Reader')`, [A]);
    await admin.query(`INSERT INTO ${T('subject_roles')} (tenant_id, subject_id, role_name) VALUES ($1, 'writer', 'writer')`, [A]);
    counts.credential = 0; counts.authority = 0;
  });

  after(async function () {
    try {
      if (authority) await authority.close();
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
    }
  });

  function compose ({ beforeEffect, admitRequest = (tenant, req, fn) => fn() } = {}) {
    const token = Symbol('transport'), effects = [];
    const secrets = { async verifyLegacyCredential (context, { apiSecret, token: carried }) {
      counts.credential++;
      if (apiSecret === 'synthetic-root-secret') return { kind: 'root', rootVersion: 1 };
      return TOKENS[carried] ? { ...TOKENS[carried], credentialVersion: 1 } : (apiSecret || carried ? null : { kind: 'anonymous' });
    } };
    const admission = Object.freeze({ registry: true, resolveHost: async host => host === HOST ? A : null, allows: async tenant => tenant === A });
    const socketAuthority = createSocketAuthority({ secrets, authority, verifierContext: async tenant => ({ tenant }), admission });
    const alarmConnection = { async transaction (fn) { if (beforeEffect) await beforeEffect(); return fn(); }, async query (text, values) {
      if (text.includes('FROM pg_class')) return { rows: [{ secured: true, owns: false, reads: true, inserts: true, state_updates: true, broad_writes: false, any_writes: true, schema_writes: false }] };
      if (text.includes('tenant_authorization_')) { counts.authority++; return admin.query(text, values); }
      if (text.includes('clock_timestamp')) return { rows: [{ now_ms: '1000' }] };
      if (text.startsWith('INSERT INTO')) { effects.push('ack'); return { rows: [{ tenant_id: values[0], alarm_group: values[1], alarm_level: values[2], acked_at: String(values[3]), expires_at: String(values[4]) }] }; }
      throw new Error('unexpected alarm query');
    } };
    const executeWrite = async operation => {
      if (beforeEffect) await beforeEffect(operation);
      effects.push(operation.args[0].collection);
      return [{ result: 'stored' }];
    };
    const ops = privateApi.operations({ token, admission, authority: socketAuthority, executeWrite, alarmConnection,
      admitRequest,
      config: { socketForwarding: { alarm: { namespace: 'socket_alarm' } }, namespaces: { authorization: NAMESPACE } } });
    const write = credential => ops.executeSocketMutation({ transport: token }, { host: HOST, envelope: { tenant: A, credential,
      namespace: '/', event: 'dbAdd', args: [{ collection: 'entries', data: { type: 'sgv', sgv: 120, date: 1 } }] } });
    const ack = credential => ops.executeSocketMutation({ transport: token }, { host: HOST, envelope: { tenant: A, credential,
      namespace: '/', event: 'ack', args: [1, 'default', 60000] } });
    const connect = credential => ops.authorizeSocket({ transport: token }, { host: HOST, tenant: A, namespace: '/', credential });
    return { write, ack, connect, effects };
  }

  it('connect: anonymous and subject sockets keep their permissions and collections', async function () {
    const f = compose();
    assert.deepEqual(await f.connect({}), { permissions: { read: true, write: false, write_treatment: false, ack: false },
      collections: ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'] });
    assert.deepEqual(await f.connect({ token: 'synthetic-writer' }), { permissions: { read: true, write: true, write_treatment: true, ack: true },
      collections: ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'] });
    assert.deepEqual(await f.connect({ token: 'synthetic-reader' }), { permissions: { read: true, write: false, write_treatment: false, ack: false },
      collections: ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'] });
    assert.deepEqual(await f.connect({ token: 'unknown' }), { denied: true });
  });

  it('a forwarded write is its own admitted api request: api-admission runs its gate and authorization', async function () {
    // Real api-admission (stand-in tenant connection). Its write-time re-check
    // is lane Z1's; this control needs only the admission.
    const gated = [];
    let paused = false;
    const api = apiAdmission({ withTenant: (tenant, fn) => fn(), transaction: fn => fn() }, async tenant => {
      gated.push(tenant);
      if (paused) throw Object.assign(new Error('TENANT_PAUSED'), { code: 'TENANT_PAUSED' });
    });
    const f = compose({ admitRequest: api.request });
    assert.deepEqual((await f.write({ token: 'synthetic-writer' })).replyArgs, [{ result: 'stored' }]);
    assert.deepEqual(gated, [A], 'Z2_FORWARDED_WRITE_ADMITTED');
    paused = true;
    await assert.rejects(f.write({ token: 'synthetic-writer' }), { code: 'SOCKET_FORWARD_UNAVAILABLE' });
    assert.deepEqual(f.effects, ['entries'], 'a refused admission has no effect');
  });

  it('a forwarded write is authorized once at admission: one credential verification, one authority read', async function () {
    const f = compose();
    assert.deepEqual((await f.write({ token: 'synthetic-writer' })).replyArgs, [{ result: 'stored' }]);
    assert.deepEqual(f.effects, ['entries']);
    assert.deepEqual(counts, { credential: 1, authority: 1 }, 'Z2_ONE_VERIFICATION_PER_SOCKET_WRITE');
  });

  it('API_SECRET root write: one credential verification, one authority read, accepted', async function () {
    const f = compose();
    assert.deepEqual((await f.write({ secret: 'synthetic-root-secret' })).replyArgs, [{ result: 'stored' }]);
    assert.deepEqual(counts, { credential: 1, authority: 1 });
  });

  it('read-only subject and wrong credential are refused before any effect', async function () {
    const f = compose();
    await assert.rejects(f.write({ token: 'synthetic-reader' }), { code: 'SOCKET_FORWARD_AUTHORITY_REFUSED' });
    // A refused credential surfaces as the receiver's generic refusal.
    await assert.rejects(f.write({ secret: 'wrong' }), { code: 'SOCKET_FORWARD_UNAVAILABLE' });
    assert.deepEqual(f.effects, []);
  });

  it('a forwarded ack is authorized once at admission: one credential verification, one authority read', async function () {
    const f = compose();
    assert.deepEqual((await f.ack({ token: 'synthetic-writer' })).replyArgs, []);
    assert.deepEqual(f.effects, ['ack']);
    assert.deepEqual(counts, { credential: 1, authority: 1 }, 'Z2_ONE_VERIFICATION_PER_SOCKET_ACK');
  });

  const removeRole = () => admin.query(`DELETE FROM ${T('subject_roles')} WHERE tenant_id = $1 AND subject_id = 'writer'`, [A]);
  const deleteSubject = async () => { await removeRole(); await admin.query(`DELETE FROM ${T('subjects')} WHERE tenant_id = $1 AND subject_id = 'writer'`, [A]); };
  for (const [label, change] of [['role removed', removeRole], ['subject deleted', deleteSubject]]) {
    it(label + ' after a write was admitted: that write completes, the next write is refused', async function () {
      const f = compose({ beforeEffect: change });
      assert.deepEqual((await f.write({ token: 'synthetic-writer' })).replyArgs, [{ result: 'stored' }]);
      await assert.rejects(f.write({ token: 'synthetic-writer' }), label === 'role removed'
        ? { code: 'SOCKET_FORWARD_AUTHORITY_REFUSED' } : { code: 'SOCKET_FORWARD_UNAVAILABLE' });
      assert.deepEqual(f.effects, ['entries'], 'Z2_NEXT_REQUEST_REFUSED');
    });
    it(label + ' after an ack was admitted: that ack completes, the next ack is refused', async function () {
      const f = compose({ beforeEffect: change });
      assert.deepEqual((await f.ack({ token: 'synthetic-writer' })).replyArgs, []);
      await assert.rejects(f.ack({ token: 'synthetic-writer' }));
      assert.deepEqual(f.effects, ['ack']);
    });
  }
});
