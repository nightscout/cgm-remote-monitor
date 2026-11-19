'use strict';

// covers: lib/server/serve/vcpool-preview.js, lib/server/serve/platform-verification.js, lib/server/serve/platform-verification-admin.js, lib/pool-membership/postgres.js

// Decision vcpool-proof-role: vcpool checks the platform proof once at start,
// like the other serving roles, and its ledger, catalogue and privilege screens
// run in the admin pre-start step. Source protocol with recorded dependencies
// for the start check; real PostgreSQL (PLATFORM_TEST_PG or
// NS_TEST_POSTGRES_ADMIN_URI) for the admin screen. Synthetic identities only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');

function load (relative, overrides, transform = source => source) {
  const filename = path.resolve(__dirname, '..', relative), local = createRequire(filename);
  const sandbox = { module: { exports: {} }, console: { log () {}, warn () {}, error () {} }, process,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) };
  vm.runInNewContext(transform(fs.readFileSync(filename, 'utf8')), sandbox, { filename }); return sandbox.module.exports;
}

// The actual vcpool boot with recorded stores. `proof` decides the start check.
function vcpoolBoot ({ proof = true, transform } = {}) {
  const calls = { admitted: [], member: [], activity: [], secrets: [], ledger: 0, runtime: 0 };
  const resource = () => ({ close: async () => {} });
  const boot = load('lib/server/serve/vcpool-preview.js', {
    './platform-verification': { ...require('../lib/server/serve/platform-verification'), admit: async (_config, role) => {
      calls.admitted.push(role);
      if (!proof) throw Object.assign(new Error('PLATFORM_VERIFICATION_REQUIRED'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      return { role };
    } },
    '../../pool-membership': { member: async (selected, options) => { calls.member.push(options); return {
      ...resource(), register: async () => {}, slice: async () => ({ eligible: true }), configured: { ordinal: 0, mode: 'standalone' } }; } },
    '../../migrations/postgres': { run: async () => { calls.ledger++; } },
    '../../tenant-activity/postgres': { create: async options => { calls.activity.push(options); return { ...resource(), read: async () => null }; } },
    '../../secrets/postgres': { createPostgresSecrets: async options => { calls.secrets.push(options); return resource(); } },
    '../../secrets/component': { createSecrets: () => ({ decrypt: async () => '' }) },
    '../../tenant-connector/runtime': { create: () => { calls.runtime++; return { start () {}, close: async () => {}, inspect: async () => ({}), cycle: async () => {} }; } }
  }, transform);
  const config = { platformVerification: { namespace: 'synthetic_verification', role: 'vcpool' }, partition: { kind: 'vcpool', partitioned: false },
    activity: { connectionString: 'postgresql://activity@synthetic/db', namespace: 'synthetic_control' }, secretsConnectionString: 'postgresql://secrets@synthetic/db',
    namespaces: { secrets: 'synthetic_secrets' }, tenants: new Map(), egress: { proxy: null } };
  return { boot: () => boot.boot(config), calls };
}

describe('vcpool platform proof (decision vcpool-proof-role)', function () {
  it('checks the proof once at start and runs no ledger, catalogue or privilege screen while serving', async function () {
    const lab = vcpoolBoot(), role = await lab.boot();
    try {
      assert.deepEqual(lab.calls.admitted, ['vcpool'], 'ONE_PLATFORM_CHECK_AT_START');
      assert.equal(lab.calls.ledger, 0, 'NO_SERVING_LEDGER_CHECK');
      assert.deepEqual(lab.calls.member.map(options => options.platformVerified), [true]);
      assert.deepEqual(lab.calls.activity.map(options => options.platformVerified), [true]);
      assert.deepEqual(lab.calls.secrets.map(options => options.platformVerified), [true]);
      assert.equal(lab.calls.runtime, 1);
    } finally { await role.close(); }
  });

  it('requires the connector definitions reader to pass its admin pre-start check', async function () {
    const definitions = { connectionString: 'postgresql://reader@synthetic/db', namespaces: { settings: 'synthetic_settings' } };
    let checks = 0;
    const admin = load('lib/server/serve/platform-verification-admin.js', {
      './platform-verification-lifecycle': { inspect: async () => null },
      '../../tenant-connector/postgres-sources': { create: async options => {
        assert.equal(options.connectionString, definitions.connectionString);
        assert.equal(options.namespaces, definitions.namespaces);
        assert.equal(options.platformVerified, undefined);
        checks++;
        throw Object.assign(new Error('CONNECTOR_DEFINITION_UNSAFE'), { code: 'CONNECTOR_DEFINITION_UNSAFE' });
      } }
    });
    await assert.rejects(admin.checkTarget({ role: 'vcpool', config: { definitions } }), error => {
      assert.deepEqual(error.verificationDiagnostic, {
        targetRole: 'vcpool', checkPhase: 'CONNECTOR_DEFINITIONS', causeCode: 'CONNECTOR_DEFINITION_UNSAFE'
      });
      return true;
    });
    assert.equal(checks, 1);
  });

  it('refuses to start without the proof, with its typed code and no store or cycle', async function () {
    const lab = vcpoolBoot({ proof: false });
    await assert.rejects(lab.boot(), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
    assert.deepEqual(lab.calls.admitted, ['vcpool']);
    assert.equal(lab.calls.member.length + lab.calls.activity.length + lab.calls.secrets.length + lab.calls.runtime, 0, 'NO_STORE_WITHOUT_PROOF');
  });

  it('control: removing the start check lets an unproven vcpool start (red); restored source refuses', async function () {
    const omitCheck = source => {
      const needle = "await platform.admit(config, 'vcpool');";
      assert.equal(source.split(needle).length, 2, 'PLATFORM_CHECK_CONTROL_SEAM_REQUIRED');
      return source.replace(needle, '');
    };
    const criterion = async transform => {
      const lab = vcpoolBoot({ proof: false, transform });
      let role;
      try { role = await lab.boot(); } catch (error) { assert.equal(error.code, 'PLATFORM_VERIFICATION_REQUIRED'); return; }
      await role.close(); assert.fail('UNPROVEN_VCPOOL_MUST_NOT_START');
    };
    await criterion();
    await assert.rejects(criterion(omitCheck), /UNPROVEN_VCPOOL_MUST_NOT_START/);
    console.log('    CONTROL RED: UNPROVEN_VCPOOL_MUST_NOT_START');
    await criterion();
    console.log('    CONTROL RESTORED: PLATFORM_VERIFICATION_REQUIRED, no store or cycle');
  });

  it('binds the proof to the secrets identity and the selected connector stores', function () {
    const platform = require('../lib/server/serve/platform-verification');
    assert(platform.ROLES.includes('vcpool'));
    const config = { secretsConnectionString: 'postgresql://secrets:x@db.example.test/ns', namespaces: { secrets: 'ns_secrets' },
      activity: { connectionString: 'postgresql://activity:x@db.example.test/ns', namespace: 'ns_control' }, partition: { kind: 'vcpool', partitioned: false } };
    assert.equal(platform.proofConnection(config, 'vcpool'), config.secretsConnectionString);
    const before = platform.contract(config, 'vcpool');
    assert.notEqual(platform.contract({ ...config, activity: { ...config.activity, namespace: 'ns_other' } }, 'vcpool'), before, 'ACTIVITY_SELECTION_IN_CONTRACT');
    assert.notEqual(platform.contract({ ...config, partition: { kind: 'vcpool', partitioned: true, namespace: 'ns_pool', connectionString: 'postgresql://member:x@db.example.test/ns' } }, 'vcpool'), before, 'POOL_SELECTION_IN_CONTRACT');
  });
});

// Real PostgreSQL. The admin pre-start step runs vcpool's pool privilege screen
// with the member login. A member login also granted INSERT on pool_desired is
// refused there and gets no proof. Removing that screen lets it through (red).
const database = process.env.PLATFORM_TEST_PG || process.env.NS_TEST_POSTGRES_ADMIN_URI;
(database ? describe : describe.skip)('Native PostgreSQL vcpool pre-start privilege verification', function () {
  this.timeout(30000);
  const { Client } = require('pg');
  const id = crypto.randomBytes(5).toString('hex');
  const roles = { owner: 'pvv_' + id + '_owner', writer: 'pvv_' + id + '_writer', member: 'pvv_' + id + '_member', secrets: 'pvv_' + id + '_secrets' };
  const pool = 'pvv_' + id + '_pool', state = 'pvv_' + id + '_state';
  const password = crypto.randomBytes(24).toString('hex');
  const quote = name => '"' + name + '"';
  const membership = require('../lib/pool-membership/postgres');
  const address = role => { const url = new URL(database); url.username = role; url.password = password; return url.toString(); };
  let admin;
  // The actual admin target check for vcpool. The activity and secrets screens
  // are recorded here; each has its own native suite.
  const admin_ = (poolModule = membership) => load('lib/server/serve/platform-verification-admin.js', {
    '../../pool-membership/postgres': poolModule,
    '../../tenant-activity/postgres': { create: async () => ({ close: async () => {} }) },
    '../../secrets/postgres': { createPostgresSecrets: async () => ({ close: async () => {} }) },
    '../../migrations/postgres': { run: async () => {} }
  });
  const screenWithoutPrivilegeCheck = () => {
    const file = require.resolve('../lib/pool-membership/postgres'), source = fs.readFileSync(file, 'utf8');
    const needle = "JSON.stringify(row.updates) !== JSON.stringify(updates)) throw refuse('POOL_STORE_UNSAFE');";
    assert.equal(source.split(needle).length, 2, 'POOL_SCREEN_CONTROL_SEAM_REQUIRED');
    const value = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + source.replace(needle, 'JSON.stringify(row.updates) !== JSON.stringify(updates)) {}') + '\n})', { filename: file })(createRequire(file), value, value.exports);
    return value.exports;
  };
  const config = () => ({ platformVerification: { namespace: state, role: 'vcpool' }, secretsConnectionString: address(roles.secrets),
    namespaces: { secrets: state + '_secrets' }, activity: { connectionString: address(roles.secrets) + '?application_name=activity', namespace: state + '_control' },
    partition: { kind: 'vcpool', partitioned: true, ordinal: 0, leaseMs: 1000, connectionString: address(roles.member), namespace: pool } });
  before(async function () {
    admin = new Client({ connectionString: database }); await admin.connect();
    for (const role of Object.values(roles)) await admin.query('CREATE ROLE ' + quote(role) + " LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + password + "'");
    await admin.query('CREATE SCHEMA ' + quote(pool) + ' AUTHORIZATION ' + quote(roles.owner));
    const name = (await admin.query('SELECT current_database() AS name')).rows[0].name;
    await admin.query('GRANT CREATE ON DATABASE ' + quote(name) + ' TO ' + quote(roles.owner));
    await require('../lib/migrations/postgres').run('up', { direct: true, connectionString: address(roles.owner), namespace: pool, catalogue: membership.catalogue });
    await admin.query('REVOKE CREATE ON DATABASE ' + quote(name) + ' FROM ' + quote(roles.owner));
    for (const statement of membership.grants({ namespace: pool, member: roles.member })) await admin.query(statement);
    await require('../lib/server/serve/platform-verification').install(admin, { namespace: state, writer: roles.writer, readers: [roles.secrets] });
  });
  after(async function () {
    if (!admin) return;
    for (const schema of [pool, state]) await admin.query('DROP SCHEMA IF EXISTS ' + quote(schema) + ' CASCADE');
    for (const role of Object.values(roles)) { await admin.query('DROP OWNED BY ' + quote(role)); await admin.query('DROP ROLE ' + quote(role)); }
    await admin.end();
  });
  async function criterion (poolModule) {
    const platform = require('../lib/server/serve/platform-verification'), selected = config();
    const target = { role: 'vcpool', config: selected, async check () { await admin_(poolModule).checkTarget({ role: 'vcpool', config: selected, operationConfig: null }); } };
    const service = platform.create({ namespace: state, connectionString: address(roles.writer), targets: [target] });
    try {
      await service.verify(); await platform.admit(selected, 'vcpool');
      await admin.query('GRANT INSERT ON ' + quote(pool) + '.pool_desired TO ' + quote(roles.member));
      try {
        let issued = true;
        try { await service.verify(); } catch (error) { assert.equal(error.code, 'PLATFORM_VERIFICATION_FAILED'); issued = false; }
        assert.equal(issued, false, 'MISGRANTED_VCPOOL_LOGIN_MUST_NOT_RECEIVE_A_PROOF');
        const failed = await service.inspect();
        assert.deepEqual(failed.operation.diagnostic, { targetRole: 'vcpool', checkPhase: 'CONNECTOR_POOL', causeCode: 'POOL_STORE_UNSAFE' });
        await assert.rejects(platform.admit(selected, 'vcpool'), { code: 'PLATFORM_VERIFICATION_REQUIRED' });
      } finally { await admin.query('REVOKE INSERT ON ' + quote(pool) + '.pool_desired FROM ' + quote(roles.member)); }
      await service.verify(); await platform.admit(selected, 'vcpool');
    } finally { await service.close(); }
  }
  it('refuses a vcpool member login with an INSERT grant on pool_desired; removing the screen is red', async function () {
    await criterion(membership);
    await assert.rejects(criterion(screenWithoutPrivilegeCheck()), /MISGRANTED_VCPOOL_LOGIN_MUST_NOT_RECEIVE_A_PROOF/);
    console.log('    CONTROL RED: MISGRANTED_VCPOOL_LOGIN_MUST_NOT_RECEIVE_A_PROOF');
    await criterion(membership);
    console.log('    CONTROL RESTORED: PLATFORM_VERIFICATION_FAILED (CONNECTOR_POOL, POOL_STORE_UNSAFE), vcpool start refused');
  });
});
