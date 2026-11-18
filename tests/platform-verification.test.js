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
      const guard = await platform.guard(config, 'api', { operationProfileDigest: next });
      try { assert.equal(guard.ready(), true); await guard.verify(); } finally { await guard.close(); }
      assert.throws(() => platform.contract(config, 'api', 'invalid'), { code: 'PLATFORM_VERIFICATION_CONFIG' });
    } finally { operationProfileDigest = undefined; await service.verify(); }
    await platform.admit(config, 'api');
  });
  it('keeps all serving admission paths bound to the actual selected operation window', async function () {
    const windows = require('../lib/tenant-lifecycle/operation-window');
    const domains = require('../lib/server/serve/postgres-domains');
    const clinical = require('../lib/server/serve/evaluator-readiness');
    const makeWindow = generation => windows.create({ namespace: schema, lockRule: 'tenant-id-sha256-v1',
      pool: { options: { max: 1 }, connect: async () => { throw new Error('This certificate fixture never opens lifecycle sessions'); } },
      ...(generation ? { intakeProfile: require('../lib/tenant-lifecycle/native-selection').create({
        namespace: prefix + '_checkpoint', lifecycleNamespace: schema, consumer: 'evaluator-synthetic', generation,
        source: { system_id: '123456789', timeline: 1, database: 'synthetic', slot: 'synthetic_slot' }
      }) } : {}) });
    const selected = makeWindow('selected_generation'), foreign = makeWindow('foreign_generation'), legacy = makeWindow();
    const connection = { withTenant: async () => { assert.fail('Platform admission must not repeat clinical schema inspection'); } };
    const component = (file, before, after) => {
      const filename = require.resolve(file), source = require('node:fs').readFileSync(filename, 'utf8');
      assert(source.includes(before));
      const value = { exports: {} };
      require('node:vm').runInThisContext('(function(require,module,exports){' + source.replace(before, after) + '\n})', { filename })(require('node:module').createRequire(filename), value, value.exports);
      return value.exports;
    };
    const check = async (role, own, implementation = role === 'api' ? domains : clinical) => {
      const value = { ...config, bindings: new Map(), platformVerification: { namespace: schema, role } };
      if (role === 'api') {
        await implementation.readiness(value, { operationWindow: own });
        const startup = await implementation.assertServing(value, connection, { operationWindow: own, warm: false });
        await startup.close();
      } else await implementation(value, { operationWindow: own });
    };
    try {
      for (const role of platform.ROLES) {
        const roleConfig = { ...config, platformVerification: { namespace: schema, role } };
        let selectedDigest = selected.intakeProfileDigest;
        const issuer = platform.create({ namespace: schema, connectionString: writerUrl,
          targets: [{ role, config: roleConfig, get operationProfileDigest () { return selectedDigest; }, check: target.check }] });
        try {
          await issuer.verify();
          const guard = await platform.guard(roleConfig, role, { operationProfileDigest: selected.intakeProfileDigest });
          try { assert.equal(guard.ready(), true); } finally { await guard.close(); }
          // This call fails on the original source although the outer guard admitted the same certificate.
          await check(role, selected);
          await assert.rejects(check(role, undefined), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          await assert.rejects(check(role, foreign), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          await assert.rejects(check(role, { intakeProfileDigest: selected.intakeProfileDigest }), { code: 'PLATFORM_VERIFICATION_CONFIG' });
          if (role === 'api') {
            const wrong = component('../lib/server/serve/postgres-domains',
              "platform.admit(config, 'api', platform.operationProfileDigest(operationWindow))",
              "platform.admit(config, 'api')");
            await assert.rejects(check(role, selected, wrong), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
            const wrongServing = component('../lib/server/serve/postgres-domains',
              "await platform.admit(config, 'api', platform.operationProfileDigest(operationWindow))",
              "await platform.admit(config, 'api')");
            await wrongServing.readiness({ ...roleConfig, bindings: new Map() }, { operationWindow: selected });
            await assert.rejects(wrongServing.assertServing({ ...roleConfig, bindings: new Map() }, connection,
              { operationWindow: selected, warm: false }), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          } else {
            const wrong = component('../lib/server/serve/evaluator-readiness',
              'platform.admit(config, config.platformVerification.role, platform.operationProfileDigest(options.operationWindow))',
              'platform.admit(config, config.platformVerification.role)');
            await assert.rejects(check(role, selected, wrong), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          }
          await check(role, selected);
          await issuer.invalidate();
          await assert.rejects(check(role, selected), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
          await issuer.verify(); await check(role, selected);
          await admin.query('UPDATE ' + quote(schema) + ".verified_role SET expires_at=clock_timestamp()-interval '1 second' WHERE role=$1", [role]);
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
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until (predicate, code) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
    assert.fail(code);
  }
  async function timerPauseOracle (implementation) {
    let callsA = 0, callsB = 0, server;
    const own = check => ({ role: 'api', get config () { return config; }, check });
    const a = implementation.create({ namespace: schema, connectionString: writerUrl, maxAgeMs: 10000, refreshMs: 1000,
      targets: [own(async () => { callsA++; await target.check(); })] });
    const b = implementation.create({ namespace: schema, connectionString: writerUrl, maxAgeMs: 10000, refreshMs: 1000,
      targets: [own(async () => { callsB++; await target.check(); })] });
    try {
      await a.verify(); await b.verify(); await platform.admit(config, 'api');
      server = http.createServer(api({ service: b, fallback: (_req, res) => { res.writeHead(404); res.end(); } }));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + server.address().port;
      const call = method => fetch(origin + '/v1/platform-verification', { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      const deleted = await call('DELETE'); assert.equal(deleted.status, 200); await deleted.json();
      await delay(2200); // Two scheduled refreshes, well before the old 10 s expiry.
      let state = await b.inspect();
      assert.equal(state.roles[0].status, 'revoked', 'AUTOMATIC_REPUBLISHED_AFTER_DELETE');
      assert.equal(state.operation.automaticEnabled, false, 'AUTOMATIC_REENABLED_AFTER_DELETE');
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      const pausedA = callsA;
      // A failed explicit POST must not release the operator's pause.
      await admin.query('ALTER TABLE ' + quote(schema) + '.probe DISABLE ROW LEVEL SECURITY');
      const refused = await call('POST'); assert.equal(refused.status, 503); await refused.json();
      await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY');
      await delay(1200);
      state = await b.inspect(); assert.equal(state.operation.automaticEnabled, false); assert.equal(state.roles[0].status, 'revoked');
      const posted = await call('POST'); assert.equal(posted.status, 200); assert.equal((await posted.json()).status, 'verified');
      assert.equal((await b.inspect()).operation.automaticEnabled, true); await platform.admit(config, 'api');
      const resumedB = callsB;
      await until(() => callsB > resumedB, 'MANUAL_POST_MUST_RESUME_AUTOMATIC_REFRESH');
      assert.equal(callsA, pausedA, 'OLD_TIMER_MUST_NOT_ADOPT_NEW_EPOCH');
      await platform.admit(config, 'api');
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([a.close(), b.close()]);
      await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY');
      await service.verify();
    }
  }
  it('DELETE pauses two native service timers until a successful explicit HTTP POST', async function () {
    await timerPauseOracle(platform);
  });
  it('detects the old timer calling public verification after DELETE and restores the private epoch path', async function () {
    const broken = sourceControl('const pending = track(runVerification({ automatic: true, expectedEpoch }));', 'const pending = verify();');
    await assert.rejects(timerPauseOracle(broken), error => error.name === 'AssertionError' && error.message.includes('AUTOMATIC_REPUBLISHED_AFTER_DELETE'));
    console.log('    CONTROL RED: AUTOMATIC_REPUBLISHED_AFTER_DELETE');
    await timerPauseOracle(platform);
    console.log('    CONTROL RESTORED: operator pause retained until successful POST');
  });
  it('checks the durable pause before automatic target work without requiring an epoch change', async function () {
    let calls = 0;
    const worker = platform.create({ namespace: schema, connectionString: writerUrl, maxAgeMs: 10000, refreshMs: 1000,
      targets: [{ role: 'api', get config () { return config; }, async check () { calls++; await target.check(); } }] });
    try {
      await worker.verify(); const before = calls;
      await admin.query('UPDATE ' + quote(schema) + '.verification_control SET automatic_enabled=false WHERE singleton');
      await delay(1300); assert.equal(calls, before, 'PAUSED_TIMER_MUST_NOT_ENTER_TARGET');
      assert.equal((await worker.inspect()).operation.automaticEnabled, false);
    } finally { await worker.close(); await service.verify(); }
  });
  it('keeps ordinary failed automatic refresh retry separate from an operator pause', async function () {
    let calls = 0;
    const worker = platform.create({ namespace: schema, connectionString: writerUrl, maxAgeMs: 10000, refreshMs: 1000,
      targets: [{ role: 'api', get config () { return config; }, async check () { calls++; await target.check(); } }] });
    try {
      await worker.verify();
      // Model unexpected drift rather than a supported platform mutation.
      await admin.query('ALTER TABLE ' + quote(schema) + '.probe DISABLE ROW LEVEL SECURITY');
      await until(async () => (await worker.inspect()).roles[0].status === 'revoked', 'AUTOMATIC_FAILURE_MUST_REVOKE');
      assert.equal((await worker.inspect()).operation.automaticEnabled, true);
      const failedAt = calls;
      await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY');
      await until(async () => calls > failedAt && (await worker.inspect()).roles[0].status === 'verified', 'AUTOMATIC_FAILURE_MUST_RETRY_WITHOUT_MANUAL_POST');
      await platform.admit(config, 'api');
    } finally {
      await worker.close(); await admin.query('ALTER TABLE ' + quote(schema) + '.probe ENABLE ROW LEVEL SECURITY'); await service.verify();
    }
  });
  it('fences an already entered automatic check and prevents its timer from resuming after DELETE', async function () {
    let hold = false, release, entered, calls = 0;
    const entry = new Promise(resolve => { entered = resolve; }), heldCheck = new Promise(resolve => { release = resolve; });
    const worker = platform.create({ namespace: schema, connectionString: writerUrl, maxAgeMs: 10000, refreshMs: 1000,
      targets: [{ role: 'api', get config () { return config; }, async check () { calls++; if (hold) { entered(); await heldCheck; } await target.check(); } }] });
    try {
      await worker.verify(); hold = true;
      await Promise.race([entry, delay(6000).then(() => assert.fail('AUTOMATIC_CHECK_MUST_ENTER'))]);
      await service.invalidate(); release();
      await until(async () => (await service.inspect()).operation.status === 'FAILED', 'INVALIDATED_AUTOMATIC_CHECK_MUST_REFUSE');
      const stoppedAt = calls;
      await delay(1300); assert.equal(calls, stoppedAt, 'INVALIDATED_AUTOMATIC_TIMER_MUST_STOP');
      const state = await service.inspect(); assert.equal(state.operation.automaticEnabled, false); assert.equal(state.roles[0].status, 'revoked');
      await assert.rejects(platform.admit(config, 'api'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    } finally { release(); await worker.close(); await service.verify(); }
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
