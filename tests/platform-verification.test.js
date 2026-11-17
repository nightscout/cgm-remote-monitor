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
    const names = require('../lib/server/serve/operation-cohort').protectedNamespaces({ namespaces: { entries: 'test_clinical' }, platformVerification: { namespace: 'test_platform', role: 'api' } });
    assert.deepEqual(names, ['test_clinical']);
  });
  it('expires cached serving admission at its conservative monotonic deadline even during a held refresh', async function () {
    let at = 0, held, release;
    const selected = { platformVerification: { namespace: 'test_platform', role: 'api' } };
    const guard = await platform.guard(selected, 'api', { now: () => at, read: async () => { if (held) await held; return { validityMs: 1000 }; } });
    try {
      assert.equal(guard.ready(), true);
      held = new Promise(resolve => { release = resolve; });
      const refreshing = guard.verify();
      const refused = assert.rejects(refreshing, { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      at = 1000; assert.equal(guard.ready(), false); assert.equal(guard.health().ready, false);
      release(); await refused; held = null;
      await guard.verify(); at = 1999; assert.equal(guard.ready(), true); at = 2000; assert.equal(guard.ready(), false);
    } finally { release?.(); await guard.close(); }
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

const native = process.env.PLATFORM_TEST_PG ? describe : describe.skip;
native('Native PostgreSQL admin verification state', function () {
  this.timeout(30000);
  const { Client } = require('pg');
  const prefix = 'pv_' + crypto.randomBytes(5).toString('hex');
  const writer = prefix + '_writer', reader = prefix + '_reader', schema = prefix + '_state';
  const password = crypto.randomBytes(24).toString('hex');
  const quote = name => '"' + name + '"';
  let admin, service, config, readerUrl, writerUrl, checks = 0, held;
  const target = { role: 'api', get config () { return config; }, async check () {
    checks++;
    if (held) await held;
    const rows = (await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [schema + '.probe'])).rows;
    if (!rows[0]?.relrowsecurity || !rows[0]?.relforcerowsecurity) throw new Error('CONTROL_SCHEMA_DRIFT');
  } };
  before(async function () {
    admin = new Client({ connectionString: process.env.PLATFORM_TEST_PG }); await admin.connect();
    for (const role of [writer, reader]) await admin.query('CREATE ROLE ' + quote(role) + " LOGIN PASSWORD '" + password + "'");
    await platform.install(admin, { namespace: schema, writer, readers: [reader] });
    await admin.query('CREATE TABLE ' + quote(schema) + '.probe (id integer)');
    await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY');
    await admin.query('ALTER TABLE ' + quote(schema) + '.probe FORCE ROW LEVEL SECURITY');
    const address = role => { const url = new URL(process.env.PLATFORM_TEST_PG); url.username = role; url.password = password; return url.toString(); };
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
  it('refuses wrong schema contract, database birth and role replacement then restores', async function () {
    for (const column of ['contract_digest', 'database_oid', 'database_name', 'database_birth', 'role_oid', 'role_name']) {
      await admin.query('UPDATE ' + quote(schema) + '.verified_role SET ' + column + "='foreign' WHERE role='api'");
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      await service.verify(); await platform.admit(config, 'api');
    }
    await assert.rejects(platform.admit({ ...config, domains: ['entries', 'treatments'] }, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    await admin.query('ALTER ROLE ' + quote(reader) + ' CREATEDB');
    await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_SERVING_IDENTITY_UNSAFE' });
    await admin.query('ALTER ROLE ' + quote(reader) + ' NOCREATEDB');
    await platform.admit(config, 'api');
  });
  it('refuses expired verification until an admin refresh', async function () {
    await admin.query('UPDATE ' + quote(schema) + ".verified_role SET expires_at=clock_timestamp()-interval '1 second'");
    await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    await service.verify(); await platform.admit(config, 'api');
  });
  it('keeps serving state read-only and retains an unexpired result during held re-verification', async function () {
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
      await admin.query('UPDATE ' + quote(schema) + ".verified_role SET expires_at=clock_timestamp()-interval '1 second'");
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
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
  it('refreshes cheap serving health after revocation and restoration', async function () {
    const guard = await platform.guard(config, 'api', { intervalMs: 100 });
    try {
      assert.equal(guard.ready(), true);
      await admin.query('UPDATE ' + quote(schema) + ".verified_role SET status='revoked'");
      await assert.rejects(guard.verify(), { code: 'PLATFORM_VERIFICATION_REQUIRED' }); assert.equal(guard.ready(), false);
      await service.verify(); await guard.verify(); assert.equal(guard.ready(), true);
    } finally { await guard.close(); }
  });
});
