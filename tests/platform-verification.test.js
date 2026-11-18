'use strict';
// covers: lib/server/serve/platform-verification.js, lib/server/serve/platform-verification-admin.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const platform = require('../lib/server/serve/platform-verification');
const api = require('../lib/server/serve/platform-verification-admin').api;
const diagnostics = require('../lib/server/serve/platform-verification-diagnostic');
function sourceControl (before, after) {
  const file = require.resolve('../lib/server/serve/platform-verification'), source = require('node:fs').readFileSync(file, 'utf8');
  assert(source.includes(before));
  const value = { exports: {} };
  require('node:vm').runInThisContext('(function(require,module,exports){' + source.replace(before, after) + '\n})', { filename: file })(require('node:module').createRequire(file), value, value.exports);
  return value.exports;
}

describe('Internal admin platform verification contract', function () {
  it('selects exactly one explicit role and namespace', function () {
    assert.equal(platform.selected(undefined, 'api'), undefined);
    assert.deepEqual(platform.selected({ namespace: 'test_platform', role: 'api' }, 'api'), { namespace: 'test_platform', role: 'api' });
    for (const value of [{ namespace: 'public', role: 'api' }, { namespace: 'test_platform', role: 'evaluator' }, { namespace: 'test_platform', role: 'api', bypass: true }]) assert.throws(() => platform.selected(value, 'api'), { code: 'PLATFORM_VERIFICATION_CONFIG' });
  });
  it('keeps platform verification operational state outside tenant restore', function () {
    const names = require('../lib/server/serve/role-topology').protectedNamespaces({ namespaces: { entries: 'test_clinical' }, platformVerification: { namespace: 'test_platform', role: 'api' } });
    assert.deepEqual(names, ['test_clinical']);
  });
  it('refuses a serving role without a selected proof before any database read', async function () {
    // Decision platform-application-boundary: the proof is mandatory for every
    // serving role; there is no self-verification fallback.
    for (const role of platform.ROLES) await assert.rejects(platform.admit({ connectionString: 'postgres://unused.invalid/none' }, role), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    assert.deepEqual(platform.TERMINAL, ['PLATFORM_VERIFICATION_REQUIRED', 'PLATFORM_SERVING_IDENTITY_UNSAFE']);
  });
  it('binds the contract to role, selection and catalogues, not to runtime source files', function () {
    const config = { connectionString: 'postgres://reader@localhost/synthetic', domains: ['entries'], namespaces: { entries: 'test_entries' }, platformVerification: { namespace: 'test_platform', role: 'api' } };
    const digest = platform.contract(config, 'api');
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(platform.contract({ ...config }, 'api'), digest);
    assert.notEqual(platform.contract({ ...config, domains: ['entries', 'treatments'] }, 'api'), digest);
    const source = require('node:fs').readFileSync(require.resolve('../lib/server/serve/platform-verification'), 'utf8');
    assert.equal(/readFileSync|sourceGeneration/.test(source), false, 'NO_RUNTIME_SOURCE_HASHING');
  });
  it('retains only fixed target, phase and cause diagnostics', function () {
    const privateValue = 'PRIVATE_ERROR_PATH_OR_DATABASE_DETAIL';
    const value = diagnostics.annotate({ code: '42501', message: privateValue, detail: privateValue }, 'evaluator', 'CLINICAL_READINESS');
    assert.deepEqual(diagnostics.read(value), { targetRole: 'evaluator', checkPhase: 'CLINICAL_READINESS', causeCode: 'PG_PRIVILEGE_REFUSED' });
    assert(!JSON.stringify(value).includes(privateValue));
    const hostile = { code: privateValue, message: privateValue, verificationDiagnostic: { targetRole: privateValue, checkPhase: privateValue, causeCode: privateValue } };
    assert.deepEqual(diagnostics.classify(hostile, 'api', 'LOAD_TARGET'), { targetRole: 'api', checkPhase: 'LOAD_TARGET', causeCode: 'UNCLASSIFIED' });
    assert.equal(diagnostics.read(hostile), null);
    assert.deepEqual(diagnostics.classify({ code: '__proto__', message: 'constructor' }, 'api', 'LOAD_TARGET'), { targetRole: 'api', checkPhase: 'LOAD_TARGET', causeCode: 'UNCLASSIFIED' });
    assert.deepEqual(diagnostics.classify(new TypeError(privateValue), 'realtime', 'OPERATION_READINESS'), { targetRole: 'realtime', checkPhase: 'OPERATION_READINESS', causeCode: 'TYPE_ERROR' });
  });
  it('requires bounded empty operation bodies and never returns raw errors', async function () {
    const service = { inspect: async () => ({ version: 1, roles: [] }), verify: async () => { throw new Error('PRIVATE_CONNECTION_OR_BODY'); } };
    const server = http.createServer(api({ service, fallback: (_req, res) => { res.writeHead(404); res.end(); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      assert.equal((await fetch(origin + '/v1/platform-verification')).status, 200);
      for (const [body, status] of [['{', 400], ['{"bypass":true}', 422], [' '.repeat(129), 413], ['{}', 503]]) {
        const response = await fetch(origin + '/v1/platform-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        assert.equal(response.status, status); assert(!((await response.text()).includes('PRIVATE')));
      }
      service.verify = async () => { throw diagnostics.annotate({ code: '42501', message: 'PRIVATE_CONNECTION_DETAIL' }, 'api', 'AUTHORIZATION'); };
      const response = await fetch(origin + '/v1/platform-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'PLATFORM_VERIFICATION_FAILED', diagnostic: { targetRole: 'api', checkPhase: 'AUTHORIZATION', causeCode: 'PG_PRIVILEGE_REFUSED' } });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

const database = process.env.PLATFORM_TEST_PG || process.env.NS_TEST_POSTGRES_ADMIN_URI;
const native = database ? describe : describe.skip;
native('Native PostgreSQL admin verification state', function () {
  this.timeout(30000);
  const { Client } = require('pg');
  const prefix = 'pv_' + crypto.randomBytes(5).toString('hex');
  const writer = prefix + '_writer', reader = prefix + '_reader', schema = prefix + '_state';
  const password = crypto.randomBytes(24).toString('hex');
  const quote = name => '"' + name + '"';
  let admin, service, config, readerUrl, writerUrl, checks = 0, held, operationProfileDigest;
  const target = { role: 'api', get config () { return config; }, get operationProfileDigest () { return operationProfileDigest; }, async check () {
    checks++;
    if (held) await held;
    const rows = (await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [schema + '.probe'])).rows;
    if (!rows[0]?.relrowsecurity || !rows[0]?.relforcerowsecurity) throw new Error('CONTROL_SCHEMA_DRIFT');
  } };
  before(async function () {
    admin = new Client({ connectionString: database }); await admin.connect();
    for (const role of [writer, reader]) await admin.query('CREATE ROLE ' + quote(role) + " LOGIN PASSWORD '" + password + "'");
    await platform.install(admin, { namespace: schema, writer, readers: [reader] });
    await admin.query('CREATE TABLE ' + quote(schema) + '.probe (id integer)');
    await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY');
    await admin.query('ALTER TABLE ' + quote(schema) + '.probe FORCE ROW LEVEL SECURITY');
    const address = role => { const url = new URL(database); url.username = role; url.password = password; return url.toString(); };
    readerUrl = address(reader); writerUrl = address(writer);
    config = { connectionString: readerUrl, domains: ['entries'], namespaces: { entries: schema }, platformVerification: { namespace: schema, role: 'api' } };
    service = platform.create({ namespace: schema, connectionString: writerUrl, targets: [target] });
  });
  after(async function () {
    await service?.close();
    if (admin) { await admin.query('DROP SCHEMA ' + quote(schema) + ' CASCADE'); for (const role of [writer, reader]) await admin.query('DROP ROLE ' + quote(role)); await admin.end(); }
  });
  it('refuses unverified state, admits checked state, refuses drift and restores', async function () {
    await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    await service.verify(); await platform.admit(config, 'api');
    await admin.query('ALTER TABLE ' + quote(schema) + '.probe DISABLE ROW LEVEL SECURITY');
    await assert.rejects(service.verify(), { code: 'PLATFORM_VERIFICATION_FAILED' });
    const failed = await service.inspect();
    assert.equal(failed.roles[0].status, 'revoked');
    assert.deepEqual(failed.operation.diagnostic, { targetRole: 'api', checkPhase: 'TARGET_CHECK', causeCode: 'UNCLASSIFIED' });
    await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY');
    await service.verify(); await platform.admit(config, 'api');
    assert(checks >= 3);
  });
  it('refuses wrong schema contract, database and role replacement then restores', async function () {
    for (const column of ['contract_digest', 'database_oid', 'database_name', 'role_oid', 'role_name']) {
      await admin.query('UPDATE ' + quote(schema) + '.verified_role SET ' + column + "='foreign' WHERE role='api'");
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      await service.verify(); await platform.admit(config, 'api');
    }
    await assert.rejects(platform.admit({ ...config, domains: ['entries', 'treatments'] }, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    // A datastore restart is not authority drift: recover-in-place keeps
    // serving and a role started afterwards still admits the same proof.
    await admin.query('UPDATE ' + quote(schema) + ".verified_role SET database_birth='restarted' WHERE role='api'");
    await platform.admit(config, 'api'); await service.verify();
    await admin.query('ALTER ROLE ' + quote(reader) + ' CREATEDB');
    await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_SERVING_IDENTITY_UNSAFE' });
    await admin.query('ALTER ROLE ' + quote(reader) + ' NOCREATEDB');
    await platform.admit(config, 'api');
  });
  it('binds the selected native lifecycle catalogue and generation to admin and serving admission', async function () {
    const selection = generation => require('../lib/tenant-lifecycle/native-selection').create({
      namespace: prefix + '_checkpoint', lifecycleNamespace: schema, consumer: 'evaluator-synthetic', generation,
      source: { system_id: '123456789', timeline: 1, database: 'synthetic', slot: 'synthetic_slot' } });
    const first = selection('generation_a').digest, next = selection('generation_b').digest;
    assert.notEqual(first, next);
    try {
      operationProfileDigest = first; await service.verify(); await platform.admit(config, 'api', first);
      await assert.rejects(platform.admit(config, 'api', next), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      operationProfileDigest = next; await service.verify(); await platform.admit(config, 'api', next);
      await assert.rejects(platform.admit(config, 'api', first), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      const broken = sourceControl('if (operationProfileDigest !== undefined) selection.operationProfileDigest = operationProfileDigest;', '');
      const faulty = broken.create({ namespace: schema, connectionString: writerUrl, targets: [target] });
      try {
        await faulty.verify();
        await assert.rejects(assert.rejects(broken.admit(config, 'api', first), { code: 'PLATFORM_VERIFICATION_REQUIRED' }), { name: 'AssertionError', message: /Missing expected rejection/ });
        await assert.rejects(platform.admit(config, 'api', next), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      } finally { await faulty.close(); }
      await service.verify(); await platform.admit(config, 'api', next);
      assert.throws(() => platform.contract(config, 'api', 'invalid'), { code: 'PLATFORM_VERIFICATION_CONFIG' });
    } finally { operationProfileDigest = undefined; await service.verify(); }
    await platform.admit(config, 'api');
  });
  it('binds each serving role start check to the actual selected generation scope', async function () {
    const windows = require('../lib/tenant-lifecycle/generation-scope');
    const makeWindow = generation => windows.create({ namespace: schema, lockRule: 'tenant-id-sha256-v1',
      pool: { options: { max: 1 }, connect: async () => { throw new Error('This certificate fixture never opens lifecycle sessions'); } },
      ...(generation ? { intakeProfile: require('../lib/tenant-lifecycle/native-selection').create({
        namespace: prefix + '_checkpoint', lifecycleNamespace: schema, consumer: 'evaluator-synthetic', generation,
        source: { system_id: '123456789', timeline: 1, database: 'synthetic', slot: 'synthetic_slot' }
      }) } : {}) });
    const selected = makeWindow('selected_generation'), foreign = makeWindow('foreign_generation'), legacy = makeWindow();
    const check = (role, own) => platform.admit({ ...config, platformVerification: { namespace: schema, role } }, role, platform.operationProfileDigest(own));
    try {
      // vcpool has no tenant generation scope (decision vcpool-proof-role).
      for (const role of platform.ROLES.filter(role => role !== 'vcpool')) {
        const roleConfig = { ...config, platformVerification: { namespace: schema, role } };
        let selectedDigest = selected.intakeProfileDigest;
        const issuer = platform.create({ namespace: schema, connectionString: writerUrl,
          targets: [{ role, config: roleConfig, get operationProfileDigest () { return selectedDigest; }, check: target.check }] });
        try {
          await issuer.verify();
          await check(role, selected);
          await assert.rejects(check(role, undefined), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          await assert.rejects(check(role, foreign), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          assert.throws(() => platform.operationProfileDigest({ intakeProfileDigest: selected.intakeProfileDigest }), { code: 'PLATFORM_VERIFICATION_CONFIG' });
          await issuer.invalidate();
          await assert.rejects(check(role, selected), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          await issuer.verify(); await check(role, selected);
          selectedDigest = undefined; await issuer.verify();
          await check(role, undefined); await check(role, legacy);
          await assert.rejects(check(role, selected), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
        } finally { await issuer.close(); }
      }
      await selected.close();
      assert.throws(() => platform.operationProfileDigest(selected), { code: 'PLATFORM_VERIFICATION_CONFIG' });
    } finally {
      await Promise.all([selected.close(), foreign.close(), legacy.close()]);
      operationProfileDigest = undefined; await service.verify();
    }
  });

  it('has no lease: a proof verified long ago still admits a serving start', async function () {
    // C-01 retired the expiring certificate and its 5 s poll. Old rows from the
    // lease era carry an expires_at; it is ignored.
    await admin.query('UPDATE ' + quote(schema) + ".verified_role SET verified_at=clock_timestamp()-interval '30 days',expires_at=clock_timestamp()-interval '29 days'");
    await platform.admit(config, 'api');
    assert.equal((await service.inspect()).roles[0].status, 'verified');
    await service.verify(); await platform.admit(config, 'api');
    assert.equal((await admin.query('SELECT expires_at FROM ' + quote(schema) + ".verified_role WHERE role='api'")).rows[0].expires_at, null);
  });
  it('keeps serving state read-only and retains the published proof during held re-verification', async function () {
    const own = new Client({ connectionString: readerUrl }); await own.connect();
    try { await assert.rejects(own.query('UPDATE ' + quote(schema) + ".verified_role SET status='verified'"), error => error.code === '42501'); } finally { await own.end(); }
    let release; held = new Promise(resolve => { release = resolve; });
    const before = checks, pending = service.verify();
    try {
      for (let n = 0; n < 100 && checks === before; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(checks > before);
      await platform.admit(config, 'api');
      assert.equal((await service.inspect()).operation.status, 'RUNNING');
      await assert.rejects(service.verify(), { code: 'PLATFORM_VERIFICATION_IN_PROGRESS' });
    } finally { held = null; release(); await pending; }
    await platform.admit(config, 'api');
  });
  it('fences explicit platform invalidation during a held check', async function () {
    let release; held = new Promise(resolve => { release = resolve; });
    const before = checks, pending = service.verify();
    const refused = assert.rejects(pending, { code: 'PLATFORM_VERIFICATION_FAILED' });
    try {
      for (let n = 0; n < 100 && checks === before; n++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(checks > before); await service.invalidate();
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    } finally { held = null; release(); await refused; }
    await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    await service.verify(); await platform.admit(config, 'api');
  });
  it('detects a removed digest comparison and restored source refuses', async function () {
    await service.verify();
    await admin.query('UPDATE ' + quote(schema) + ".verified_role SET contract_digest='foreign'");
    const broken = sourceControl('row.contract_digest !== expected || ', '');
    await assert.rejects(assert.rejects(broken.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' }), { name: 'AssertionError', message: /Missing expected rejection/ });
    await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    await service.verify(); await platform.admit(config, 'api');
  });
  it('detects an omitted verifier target invocation and restores the strict check', async function () {
    const broken = sourceControl('await target.check();', '');
    const faulty = broken.create({ namespace: schema, connectionString: writerUrl, targets: [target] });
    try {
      await admin.query('ALTER TABLE ' + quote(schema) + '.probe DISABLE ROW LEVEL SECURITY');
      await assert.rejects(assert.rejects(faulty.verify(), { code: 'PLATFORM_VERIFICATION_FAILED' }), { name: 'AssertionError', message: /Missing expected rejection/ });
      await assert.rejects(service.verify(), { code: 'PLATFORM_VERIFICATION_FAILED' });
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    } finally { await faulty.close(); await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY'); }
    await service.verify(); await platform.admit(config, 'api');
  });
  it('detects omitted failure revocation and restored source revokes', async function () {
    const before = `await client.query('UPDATE ' + quote(namespace) + ".verified_role SET status='revoked',verified_at=NULL,expires_at=NULL").catch(() => {});`;
    const broken = sourceControl(before, "await client.query('SELECT 1');");
    const faulty = broken.create({ namespace: schema, connectionString: writerUrl, targets: [target] });
    try {
      await admin.query('ALTER TABLE ' + quote(schema) + '.probe DISABLE ROW LEVEL SECURITY');
      await assert.rejects(faulty.verify(), { code: 'PLATFORM_VERIFICATION_FAILED' });
      await assert.rejects(assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' }), { name: 'AssertionError', message: /Missing expected rejection/ });
      await assert.rejects(service.verify(), { code: 'PLATFORM_VERIFICATION_FAILED' });
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    } finally { await faulty.close(); await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY'); }
    await service.verify(); await platform.admit(config, 'api');
  });
});

// Census A-13 control on real PostgreSQL. The trusted reader's catalogue screen
// is part of the admin pre-start step: a trusted login with a write grant on the
// clock table is refused there and gets no proof. Removing that screen from the
// step lets the misgranted role through (red); restored source refuses again.
native('Native PostgreSQL pre-start grant verification', function () {
  this.timeout(30000);
  const { Client } = require('pg');
  const prefix = 'pg_' + crypto.randomBytes(5).toString('hex');
  const id = prefix.slice(3), writer = 'pvg_' + id + '_writer', worker = 'pvg_' + id + '_worker', state = 'pvg_' + id + '_state';
  const ns = { activity: 'pvg_' + id + '_activity', clock: 'pvg_' + id + '_clock', settings: 'pvg_' + id + '_settings', operatorPolicy: 'pvg_' + id + '_policy' };
  const password = crypto.randomBytes(24).toString('hex');
  const quote = name => '"' + name + '"';
  const trusted = require('../lib/trusted-worker/postgres');
  let admin, workerUrl, writerUrl;
  const address = role => { const url = new URL(database); url.username = role; url.password = password; return url.toString(); };
  // The pre-start target: the same screen the admin role runs for an evaluator
  // or realtime target, through a read-only connection as that trusted login.
  const step = implementation => {
    const config = { connectionString: workerUrl, domains: ['entries'], namespaces: { entries: ns.activity }, platformVerification: { namespace: state, role: 'realtime' } };
    return { config, service: platform.create({ namespace: state, connectionString: writerUrl, targets: [{ role: 'realtime', config, async check () {
      const client = new Client({ connectionString: workerUrl }); await client.connect();
      try { await implementation.screen({ connection: { readOnly: (text, values) => client.query(text, values) }, namespaces: ns }); } finally { await client.end(); }
    } }] }) };
  };
  const screenWithoutGrantCheck = () => {
    const file = require.resolve('../lib/trusted-worker/postgres'), source = require('node:fs').readFileSync(file, 'utf8');
    const needle = 'if (rows.length !== expected.length || rows.some(row => !row.secured || row.owns || row.writes)) throw failure();';
    assert.equal(source.split(needle).length, 2, 'GRANT_SCREEN_CONTROL_SEAM_REQUIRED');
    const value = { exports: {} };
    require('node:vm').runInThisContext('(function(require,module,exports){' + source.replace(needle, '') + '\n})', { filename: file })(require('node:module').createRequire(file), value, value.exports);
    return value.exports;
  };
  before(async function () {
    admin = new Client({ connectionString: database }); await admin.connect();
    for (const role of [writer, worker]) await admin.query('CREATE ROLE ' + quote(role) + " LOGIN PASSWORD '" + password + "'");
    await platform.install(admin, { namespace: state, writer, readers: [worker] });
    for (const schema of Object.values(ns)) await admin.query('CREATE SCHEMA ' + quote(schema));
    await admin.query('CREATE TABLE ' + quote(ns.activity) + '.tenant_activity (tenant_id uuid PRIMARY KEY, version bigint, paused boolean, suspended boolean)');
    await admin.query('CREATE TABLE ' + quote(ns.clock) + '.tenant_write_clock (tenant_id uuid PRIMARY KEY, last_stamp bigint, last_delete_stamp bigint)');
    await admin.query('CREATE TABLE ' + quote(ns.settings) + '.tenant_settings (tenant_id uuid PRIMARY KEY, version bigint, "values" jsonb)');
    await admin.query('CREATE TABLE ' + quote(ns.operatorPolicy) + '.tenant_operator_policy (tenant_id uuid PRIMARY KEY, generation bigint, policy jsonb)');
    for (const row of trusted.relations(ns)) { await admin.query('ALTER TABLE ' + row.name + ' ENABLE ROW LEVEL SECURITY'); await admin.query('ALTER TABLE ' + row.name + ' FORCE ROW LEVEL SECURITY'); }
    for (const statement of trusted.grants({ namespaces: ns, roles: [worker] })) await admin.query(statement);
    workerUrl = address(worker); writerUrl = address(writer);
  });
  after(async function () {
    if (!admin) return;
    for (const schema of [...Object.values(ns), state]) await admin.query('DROP SCHEMA IF EXISTS ' + quote(schema) + ' CASCADE');
    for (const role of [writer, worker]) { await admin.query('DROP OWNED BY ' + quote(role)); await admin.query('DROP ROLE ' + quote(role)); }
    await admin.end();
  });
  async function criterion (implementation) {
    const { config, service } = step(implementation);
    try {
      await service.verify(); await platform.admit(config, 'realtime');
      await admin.query('GRANT UPDATE (last_stamp) ON ' + quote(ns.clock) + '.tenant_write_clock TO ' + quote(worker));
      try {
        let issued = true;
        try { await service.verify(); } catch (error) { assert.equal(error.code, 'PLATFORM_VERIFICATION_FAILED'); issued = false; }
        assert.equal(issued, false, 'MISGRANTED_TRUSTED_LOGIN_MUST_NOT_RECEIVE_A_PROOF');
        await assert.rejects(platform.admit(config, 'realtime'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      } finally { await admin.query('REVOKE UPDATE (last_stamp) ON ' + quote(ns.clock) + '.tenant_write_clock FROM ' + quote(worker)); }
      await service.verify(); await platform.admit(config, 'realtime');
    } finally { await service.close(); }
  }
  it('refuses a trusted login with a clock write grant in the pre-start step; removing the screen is red', async function () {
    await criterion(trusted);
    await assert.rejects(criterion(screenWithoutGrantCheck()), /MISGRANTED_TRUSTED_LOGIN_MUST_NOT_RECEIVE_A_PROOF/);
    console.log('    CONTROL RED: MISGRANTED_TRUSTED_LOGIN_MUST_NOT_RECEIVE_A_PROOF');
    await criterion(trusted);
    console.log('    CONTROL RESTORED: PLATFORM_VERIFICATION_FAILED, serving start refused');
  });
});
