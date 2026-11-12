'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, fork } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/secrets/postgres-candidate.json');
const { createPostgresSecrets, createPostgresSecretsMaintenance } = require('../lib/secrets/postgres');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const scope = require('../lib/storage/tenant-scope');
const postgresConnection = require('../lib/storage/postgres-connection');
const { createSubjectPolicy } = require('../lib/subject-policy/component');
const createPostgresSubjectPolicy = require('../lib/subject-policy/postgres');
const policyCatalogue = require('../lib/subject-policy/postgres-candidate.json');
const { createTenantSettings } = require('../lib/tenant-settings/component');
const createPostgresTenantSettings = require('../lib/tenant-settings/postgres');
const settingsCatalogue = require('../lib/tenant-settings/postgres-candidate.json');
const { createOperatorPolicy } = require('../lib/operator-policy/component');
const createPostgresOperatorPolicy = require('../lib/operator-policy/postgres');
const operatorPolicyCatalogue = require('../lib/operator-policy/postgres-candidate.json');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rewrapWorker (options) {
  const child = fork(require.resolve('./fixtures/secrets-rewrap-worker'), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  try {
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Secrets worker checkpoint timeout')), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Secrets worker exited before reply')); });
      child.once('message', reply => { clearTimeout(timer); resolve(reply); });
      child.send(options);
    });
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
    if (options.pauseAt) {
      assert.deepEqual(message, { checkpoint: options.pauseAt });
      assert.equal(child.kill('SIGKILL'), true);
      assert.deepEqual(await exited, [null, 'SIGKILL']);
    } else {
      assert.deepEqual(message, { reference: { tenant: options.tenant, id: options.id } });
      assert.deepEqual(await exited, [0, null]);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
}

optInSuite(process.env.NS_SECRETS_POSTGRES_DOCKER_TEST === '1', 'NS_SECRETS_POSTGRES_DOCKER_TEST=1')('secrets persistence (disposable PostgreSQL)', function () {
  this.timeout(30000);
  const container = 'ns-secrets-pg-' + crypto.randomBytes(8).toString('hex');
  const namespace = 'secrets_test';
  const appRole = 'secrets_app';
  const operatorRole = 'operator_policy_app';
  const operatorNamespace = 'operator_test';
  const operatorPolicyTable = '"operator_test".tenant_operator_policy';
  const records = '"' + namespace + '".secret_records';
  const audits = '"' + namespace + '".secret_audit';
  let owned = false, admin, adminURI, appURI, maintenanceURI, operatorURI, persistence, operatorStore,
    operatorPolicy, previousMode, port;

  async function connectApp () {
    const client = new Client({ connectionString: appURI });
    await client.connect();
    return client;
  }

  async function open () {
    return createPostgresSecrets({ connectionString: appURI, namespace });
  }

  before(async function () {
    previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--rm', '--name', container, '-d', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=secrets_test', process.env.NS_SECRETS_PG_IMAGE || 'postgres@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97',
      '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'pg_stat_statements.track=all'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    port = docker(['port', container, '5432/tcp']).split(':').pop();
    adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/secrets_test';
    const deadline = Date.now() + 15000;
    let ready = false;
    do {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'secrets_test']);
        ready = true;
      } catch (error) {
        if (error.status !== 1 && error.status !== 2) throw error;
        await sleep(100);
      }
    } while (!ready && Date.now() < deadline);
    assert.ok(ready, 'owned PostgreSQL must become responsive');
    assert.equal(docker(['inspect', '--format', '{{.State.Running}}', container]), 'true');
    await run('up', { direct: true, connectionString: adminURI, namespace,
      catalogue: { version: 1, migrations: [catalogue.migrations[0]] } });
    const upgrade = await run('up', { direct: true, connectionString: adminURI, namespace, catalogue });
    assert.deepEqual(upgrade.done, ['0002_secrets_rewrap', '0003_secrets_legacy_issuance']);
    await run('check', { direct: true, connectionString: adminURI, namespace, catalogue });
    await run('up', { direct: true, connectionString: adminURI, namespace: operatorNamespace,
      catalogue: operatorPolicyCatalogue });
    await run('check', { direct: true, connectionString: adminURI, namespace: operatorNamespace,
      catalogue: operatorPolicyCatalogue });
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    const appPassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO ${appRole}`);
    await admin.query(`GRANT SELECT, INSERT ON ${records} TO ${appRole}`);
    await admin.query(`GRANT INSERT ON ${audits} TO ${appRole}`);
    await admin.query(`GRANT USAGE ON SCHEMA "${operatorNamespace}" TO ${appRole}`);
    await admin.query(`GRANT SELECT ON ${operatorPolicyTable} TO ${appRole}`);
    const url = new URL(adminURI);
    url.username = appRole;
    url.password = appPassword;
    appURI = url.toString();
    const operatorPassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${operatorRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${operatorPassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${operatorNamespace}" TO ${operatorRole}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${operatorPolicyTable} TO ${operatorRole}`);
    url.username = operatorRole;
    url.password = operatorPassword;
    operatorURI = url.toString();
    operatorStore = await createPostgresOperatorPolicy({ connectionString: operatorURI, namespace: operatorNamespace });
    operatorPolicy = createOperatorPolicy({
      store: operatorStore,
      authorizeManagement: async ctx => ctx.principal === 'root' && ctx.consumer === 'owner'
    });
    for (const tenant of [A, B]) {
      await operatorPolicy.replace({ tenant, principal: 'root', consumer: 'owner' }, 0, {});
    }
    const maintenancePassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE secrets_maintenance LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${maintenancePassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO secrets_maintenance`);
    await admin.query(`GRANT SELECT, UPDATE (ciphertext) ON ${records} TO secrets_maintenance`);
    await admin.query(`GRANT INSERT ON ${audits} TO secrets_maintenance`);
    url.username = 'secrets_maintenance';
    url.password = maintenancePassword;
    maintenanceURI = url.toString();
    persistence = await open();
  });

  after(async function () {
    try {
      if (persistence) await persistence.close();
      if (operatorStore) await operatorStore.close();
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
    }
  });

  it('stores immutable tenant-local ciphertext and preserves it across independent adapter instances', async function () {
    await persistence.store.insert({ format: 1, tenant: A, id: 'same', ciphertext: 'opaque-a' });
    await persistence.store.insert({ format: 1, tenant: B, id: 'same', ciphertext: 'opaque-b' });
    const otherWorker = await open();
    try {
      assert.equal((await otherWorker.store.get(A, 'same')).ciphertext, 'opaque-a');
      assert.equal((await otherWorker.store.get(B, 'same')).ciphertext, 'opaque-b');
      assert.equal(await otherWorker.store.get(A, 'missing'), undefined);
      await assert.rejects(otherWorker.store.insert({ format: 1, tenant: A, id: 'same', ciphertext: 'overwrite' }),
        { code: 'SECRETS_REFERENCE_EXISTS' });
    } finally { await otherWorker.close(); }
    assert.equal((await persistence.store.get(A, 'same')).ciphertext, 'opaque-a');
  });

  it('enforces persistent current subject authority across workers, conflicts, floors and outages', async function () {
    const policyNamespace = 'policy_test';
    const policyTable = '"policy_test".subject_policy';
    const policyAudit = '"policy_test".subject_policy_audit';
    await run('up', { direct: true, connectionString: adminURI, namespace: policyNamespace, catalogue: policyCatalogue });
    await run('check', { direct: true, connectionString: adminURI, namespace: policyNamespace, catalogue: policyCatalogue });
    await admin.query(`GRANT USAGE ON SCHEMA "${policyNamespace}" TO ${appRole}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${policyTable} TO ${appRole}`);
    await admin.query(`GRANT INSERT ON ${policyAudit} TO ${appRole}`);
    const stores = [];
    const grant = { principal: 'subject', consumer: 'connector', operation: 'decrypt', id: 'current' };
    const additional = { ...grant, id: 'additional' };
    let operatorCeiling = [grant];
    const options = {
      limitsFor: async () => ({ code: [grant, additional], operator: operatorCeiling, generation: 1 }),
      authorizeManagement: async ctx => ctx.principal === 'root' && ctx.consumer === 'owner'
    };
    const owner = tenant => ({ tenant, principal: 'root', consumer: 'owner' });
    const subject = tenant => ({ tenant, principal: 'subject', consumer: 'connector' });
    const action = { operation: 'decrypt', id: 'current' };
    try {
      for (let n = 0; n < 2; n++) stores.push(await createPostgresSubjectPolicy({
        connectionString: appURI, namespace: policyNamespace, policyNamespace: operatorNamespace
      }));
      const [first, second] = stores.map(store => createSubjectPolicy({ ...options, store }));
      assert.equal(await second.authorize(subject(A), action), false);
      assert.deepEqual(await first.replace(owner(A), 0, [grant]), { version: 1, grants: [grant] });
      await first.replace(owner(B), 0, [grant]);
      assert.equal(await second.authorize(subject(A), action), true);
      assert.equal(await second.authorize(subject(B), action), true);
      assert.equal(await second.authorize(subject(A), { operation: 'decrypt', id: 'foreign' }), false);
      await assert.rejects(first.replace(subject(A), 1, []), { code: 'POLICY_FORBIDDEN' });
      await assert.rejects(first.replace(owner(A), 1, [additional]), { code: 'POLICY_FLOOR' });
      operatorCeiling = [grant, additional];
      await assert.rejects(first.replace(owner(A), 1, [{ ...grant, operation: 'reveal' }]), { code: 'POLICY_FLOOR' });
      await assert.rejects(first.replace(owner(A), 1, [{ ...grant, id: '*' }]), /Invalid exact/);
      await assert.rejects(first.replace(owner(A), 1, [grant, grant]), /Duplicate/);
      const results = await Promise.allSettled([first, second].map(worker => worker.replace(owner(A), 1, [])));
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(results.find(value => value.status === 'rejected').reason.code, 'POLICY_VERSION_CONFLICT');
      assert.equal(await second.authorize(subject(A), action), false);
      assert.equal(await first.authorize(subject(B), action), true);
      await assert.rejects(first.replace(owner(A), 1, [grant]), { code: 'POLICY_VERSION_CONFLICT' });
      await second.replace(owner(A), 2, [grant]);
      const secret = createSecrets({
        ...persistence, authorize: first.authorize, maxTokenLifetimeSeconds: 28800,
        providerFor: async () => ({ decrypt: async () => Buffer.from(JSON.stringify({
          tenant: A, id: 'current', data: Buffer.from('synthetic-current').toString('base64')
        })) })
      });
      await persistence.store.insert({ tenant: A, id: 'current', format: 1, ciphertext: 'synthetic-ciphertext' });
      assert.equal((await secret.decrypt(subject(A), { tenant: A, id: 'current' })).toString(), 'synthetic-current');
      await second.replace(owner(A), 3, []);
      await assert.rejects(secret.decrypt(subject(A), { tenant: A, id: 'current' }), { code: 'SECRETS_FORBIDDEN' });
      await second.replace(owner(A), 4, [grant]);
      operatorCeiling = [];
      assert.equal(await first.authorize(subject(A), action), false, 'narrowed operator limits govern existing rows');
      operatorCeiling = [grant];
      await admin.query(`REVOKE SELECT ON ${policyTable} FROM ${appRole}`);
      try {
        await assert.rejects(secret.decrypt(subject(A), { tenant: A, id: 'current' }), { code: 'POLICY_STORE_UNAVAILABLE' });
      } finally { await admin.query(`GRANT SELECT ON ${policyTable} TO ${appRole}`); }
      docker(['pause', container]);
      try {
        await assert.rejects(second.authorize(subject(A), action), { code: 'POLICY_STORE_UNAVAILABLE' });
      } finally { docker(['unpause', container]); }
      await admin.query(`REVOKE INSERT ON ${policyAudit} FROM ${appRole}`);
      try {
        await assert.rejects(first.replace(owner(A), 5, []), { code: 'POLICY_STORE_UNAVAILABLE' });
      } finally { await admin.query(`GRANT INSERT ON ${policyAudit} TO ${appRole}`); }
      assert.equal((await first.read(owner(A))).version, 5, 'audit failure rolls back policy write');
      const events = (await admin.query(`SELECT principal, consumer, phase, version FROM ${policyAudit}
        WHERE tenant_id = $1 ORDER BY version`, [A])).rows;
      assert.deepEqual(events.map(event => event.version), [1, 2, 3, 4, 5]);
      assert.ok(events.every(event => event.principal === 'root' && event.consumer === 'owner' && event.phase === 'committed'));
      const raw = await connectApp();
      try {
        assert.equal((await raw.query(`SELECT * FROM ${policyTable}`)).rowCount, 0);
        await assert.rejects(raw.query(`SELECT * FROM ${policyAudit}`), { code: '42501' });
        await assert.rejects(raw.query(`DELETE FROM ${policyAudit}`), { code: '42501' });
        await raw.query('BEGIN');
        await raw.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
        await assert.rejects(raw.query(`UPDATE ${policyTable} SET tenant_id = $1`, [B]), { code: '42501' });
        await raw.query('ROLLBACK');
      } finally { await raw.end(); }
      await admin.query(`ALTER TABLE ${policyTable} DISABLE ROW LEVEL SECURITY`);
      const unbound = await connectApp();
      try {
        assert.ok((await unbound.query(`SELECT tenant_id FROM ${policyTable}`)).rows.some(row => row.tenant_id === B));
        await assert.rejects(createPostgresSubjectPolicy({
          connectionString: appURI, namespace: policyNamespace, policyNamespace: operatorNamespace
        }),
          { code: 'POLICY_STORE_UNSAFE' });
      } finally {
        await unbound.end();
        await admin.query(`ALTER TABLE ${policyTable} ENABLE ROW LEVEL SECURITY`);
      }
    } finally {
      for (const store of stores) await store.close();
    }
  });

  it('persists typed display settings, provenance, version conflicts and whole rollback refusal', async function () {
        const settingsNamespace = 'settings_test';
        const settingsTable = '"settings_test".tenant_settings';
        const historyTable = '"settings_test".tenant_settings_history';
        await run('up', { direct: true, connectionString: adminURI, namespace: settingsNamespace, catalogue: settingsCatalogue });
        await run('check', { direct: true, connectionString: adminURI, namespace: settingsNamespace, catalogue: settingsCatalogue });
        await admin.query(`GRANT USAGE ON SCHEMA "${settingsNamespace}" TO ${appRole}`);
        await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${settingsTable} TO ${appRole}`);
        await admin.query(`GRANT SELECT, INSERT ON ${historyTable} TO ${appRole}`);
        const stores = [];
        let deployment = {}, overrides = {};
        const options = {
          authorize: async ctx => ctx.principal === 'root' && ctx.consumer === 'owner',
          policyFor: async tenant => {
            assert.ok([A, B].includes(tenant));
            return { generation: 1, overrides: tenant === A ? overrides : {}, deployment };
          }
        };
        const owner = tenant => ({ tenant, principal: 'root', consumer: 'owner' });
        try {
          for (let n = 0; n < 2; n++) stores.push(await createPostgresTenantSettings({
            connectionString: appURI, namespace: settingsNamespace, policyNamespace: operatorNamespace
          }));
          const [first, second] = stores.map(store => createTenantSettings({ ...options, store }));
          await assert.rejects(first.read(owner(A)), { code: 'SETTINGS_NOT_FOUND' });
          await assert.rejects(first.replace({ ...owner(A), principal: 'uploader' }, 0, {}), { code: 'SETTINGS_FORBIDDEN' });
          await assert.rejects(first.replace(owner(A), 0, { API_SECRET: 'refused' }), { code: 'SETTINGS_UNSUPPORTED' });
          await assert.rejects(first.replace(owner(A), 0, { TIMEZONE: 'UTC' }), { code: 'SETTINGS_UNSUPPORTED' });
          for (const invalid of [{ SHOW_SECONDS: 'true' }, { DISPLAY_UNITS: 'mg/dL' }, { DISPLAY_UNITS: null }]) {
            await assert.rejects(first.replace(owner(A), 0, invalid), { code: 'SETTINGS_VALUE' });
          }
          await assert.rejects(first.replace(owner(A), undefined, {}), /expected version/);
          const initial = await first.replace(owner(A), 0, {});
          assert.deepEqual(initial.effective.DISPLAY_UNITS, {
            value: 'mg/dl', source: 'code', policy: { mode: 'open', source: 'catalogue' }
          });
          assert.equal(initial.effective.SHOW_SECONDS.value, false);
          await first.replace(owner(B), 0, { SHOW_SECONDS: true });
          const old = { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true };
          await second.replace(owner(A), 1, old);
          assert.equal((await first.read(owner(A))).effective.DISPLAY_UNITS.source, 'owner');
          const races = await Promise.allSettled([first, second].map(worker => worker.replace(owner(A), 2, { SHOW_SECONDS: false })));
          assert.equal(races.filter(value => value.status === 'fulfilled').length, 1);
          assert.equal(races.find(value => value.status === 'rejected').reason.code, 'SETTINGS_VERSION_CONFLICT');
          assert.equal((await first.read(owner(B))).version, 1);
          assert.equal((await first.read(owner(B))).effective.SHOW_SECONDS.value, true);
          await assert.rejects(second.replace(owner(A), 2, old), { code: 'SETTINGS_VERSION_CONFLICT' });
          await second.rollback(owner(A), 3, 2);
          assert.deepEqual((await first.read(owner(A))).values, old);
          deployment = {
            DISPLAY_UNITS: { mode: 'bounded', default: 'mg/dl', allowed: ['mg/dl'] },
            SHOW_SECONDS: { mode: 'pinned', pin: false }
          };
          const narrowed = await first.read(owner(A));
          assert.equal(narrowed.effective.DISPLAY_UNITS.value, 'mg/dl');
          assert.equal(narrowed.effective.DISPLAY_UNITS.source, 'operator-default');
          assert.equal(narrowed.effective.DISPLAY_UNITS.storedOwnerValue, 'mmol');
          assert.equal(narrowed.effective.DISPLAY_UNITS.ignoredReason, 'outside-constraint');
          assert.equal(narrowed.effective.SHOW_SECONDS.value, false);
          assert.equal(narrowed.effective.SHOW_SECONDS.source, 'operator-pin');
          assert.equal(narrowed.effective.SHOW_SECONDS.ignoredReason, 'pinned');
          await assert.rejects(first.rollback(owner(A), 4, 2), error => {
            assert.equal(error.code, 'SETTINGS_POLICY_REFUSED');
            assert.deepEqual(error.details, [
              { name: 'DISPLAY_UNITS', reason: 'outside-constraint', policy: 'deployment' },
              { name: 'SHOW_SECONDS', reason: 'pinned', policy: 'deployment' }
            ]);
            return true;
          });
          assert.equal((await first.read(owner(A))).version, 4, 'whole rollback refused with no new version');
          overrides = { DISPLAY_UNITS: { mode: 'open' }, SHOW_SECONDS: { mode: 'open' } };
          await first.replace(owner(A), 4, old);
          deployment = { DISPLAY_UNITS: { mode: 'pinned', pin: 'mg/dl' } };
          assert.equal((await second.read(owner(A))).effective.DISPLAY_UNITS.value, 'mmol', 'whole override replaces deployment');
          await first.replace(owner(A), 5, {});
          const reset = await second.read(owner(A));
          assert.equal(reset.effective.DISPLAY_UNITS.value, 'mg/dl');
          assert.equal(reset.effective.DISPLAY_UNITS.source, 'code', 'override does not inherit deployment pin/default');
          await second.rollback(owner(A), 6, 2);
          await assert.rejects(first.rollback(owner(A), 7, 100), /rollback target/);
          const malformed = createTenantSettings({ ...options, store: stores[0], policyFor: async () => ({
            deployment: { SHOW_SECONDS: { mode: 'pinned', pin: 'false' } }, overrides: {}
          }) });
          await assert.rejects(malformed.read(owner(A)), { code: 'SETTINGS_POLICY_INVALID' });
          const unavailable = createTenantSettings({ ...options, store: stores[0], policyFor: async () => undefined });
          await assert.rejects(unavailable.read(owner(A)), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
          await admin.query(`REVOKE INSERT ON ${historyTable} FROM ${appRole}`);
          try {
            await assert.rejects(first.replace(owner(A), 7, {}), { code: 'SETTINGS_STORE_UNAVAILABLE' });
          } finally { await admin.query(`GRANT INSERT ON ${historyTable} TO ${appRole}`); }
          assert.equal((await first.read(owner(A))).version, 7, 'failed history append rolls back current state');
          await admin.query(`REVOKE SELECT ON ${settingsTable} FROM ${appRole}`);
          try {
            await assert.rejects(second.read(owner(A)), { code: 'SETTINGS_STORE_UNAVAILABLE' });
          } finally { await admin.query(`GRANT SELECT ON ${settingsTable} TO ${appRole}`); }
          const history = (await admin.query(`SELECT version, values, principal, consumer, operation, restored_from
            FROM ${historyTable} WHERE tenant_id = $1 ORDER BY version`, [A])).rows;
          assert.deepEqual(history.map(row => row.version), [1, 2, 3, 4, 5, 6, 7]);
          assert.ok(history.every(row => row.principal === 'root' && row.consumer === 'owner'));
          assert.deepEqual(history.filter(row => row.operation === 'rollback').map(row => row.restored_from), [2, 2]);
          assert.deepEqual(history[1].values, old);
          const raw = await connectApp();
          try {
            assert.equal((await raw.query(`SELECT * FROM ${settingsTable}`)).rowCount, 0);
            assert.equal((await raw.query(`SELECT * FROM ${historyTable}`)).rowCount, 0);
            await assert.rejects(raw.query(`UPDATE ${historyTable} SET principal = 'forged'`), { code: '42501' });
            await assert.rejects(raw.query(`DELETE FROM ${historyTable}`), { code: '42501' });
            await raw.query('BEGIN');
            await raw.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
            assert.ok((await raw.query(`SELECT tenant_id FROM ${settingsTable}`)).rows.every(row => row.tenant_id === A));
            await assert.rejects(raw.query(`UPDATE ${settingsTable} SET values = '{"API_SECRET":"bad"}'`), { code: '23514' });
            await raw.query('ROLLBACK');
            for (const bad of ['{"SHOW_SECONDS":"true"}', '{"DISPLAY_UNITS":null}']) {
              await raw.query('BEGIN');
              await raw.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
              await assert.rejects(raw.query(`UPDATE ${settingsTable} SET values = $1`, [bad]), { code: '23514' });
              await raw.query('ROLLBACK');
            }
          } finally { await raw.end(); }
          await admin.query(`ALTER TABLE ${settingsTable} DISABLE ROW LEVEL SECURITY`);
          const unbound = await connectApp();
          try {
            assert.ok((await unbound.query(`SELECT tenant_id FROM ${settingsTable}`)).rows.some(row => row.tenant_id === B));
            await assert.rejects(createPostgresTenantSettings({
              connectionString: appURI, namespace: settingsNamespace, policyNamespace: operatorNamespace
            }),
              { code: 'SETTINGS_STORE_UNSAFE' });
          } finally {
            await unbound.end();
            await admin.query(`ALTER TABLE ${settingsTable} ENABLE ROW LEVEL SECURITY`);
          }
        } finally {
          for (const store of stores) await store.close();
        }
      });
  it('fences cross-worker settings and grant writes and rollback against stored policy generations', async function () {
    const settingsNamespace = 'fence_settings_test';
    const settingsTable = '"' + settingsNamespace + '".tenant_settings';
    const historyTable = '"' + settingsNamespace + '".tenant_settings_history';
    const subjectNamespace = 'fence_subject_test';
    const subjectTable = '"' + subjectNamespace + '".subject_policy';
    const subjectAudit = '"' + subjectNamespace + '".subject_policy_audit';
    const grant = { principal: 'subject', consumer: 'connector', operation: 'decrypt', id: 'item' };
    const owner = { tenant: C, principal: 'root', consumer: 'owner' };
    await run('up', { direct: true, connectionString: adminURI, namespace: settingsNamespace, catalogue: settingsCatalogue });
    await run('up', { direct: true, connectionString: adminURI, namespace: subjectNamespace, catalogue: policyCatalogue });
    await admin.query(`GRANT USAGE ON SCHEMA "${settingsNamespace}" TO ${appRole}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${settingsTable} TO ${appRole}`);
    await admin.query(`GRANT SELECT, INSERT ON ${historyTable} TO ${appRole}`);
    await admin.query(`GRANT USAGE ON SCHEMA "${subjectNamespace}" TO ${appRole}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${subjectTable} TO ${appRole}`);
    await admin.query(`GRANT INSERT ON ${subjectAudit} TO ${appRole}`);
    const policyStores = [];
    const settingsStores = [];
    const subjectStores = [];
    let settingsGate, subjectGate;
    function gateNext (kind) {
      let arrive, release;
      const gate = {
        arrived: new Promise(resolve => { arrive = resolve; }),
        wait: new Promise(resolve => { release = resolve; }),
        arrive: () => arrive(),
        release: () => release()
      };
      if (kind === 'settings') settingsGate = gate;
      else subjectGate = gate;
      return gate;
    }
    async function pausePolicyRead (kind) {
      const gate = kind === 'settings' ? settingsGate : subjectGate;
      if (!gate) return;
      if (kind === 'settings') settingsGate = undefined;
      else subjectGate = undefined;
      gate.arrive();
      await gate.wait;
    }
    const policyFor = reader => async tenant => {
      const state = await reader.read({ ...owner, tenant });
      await pausePolicyRead('settings');
      return { ...state.policy.settings, generation: state.generation };
    };
    const limitsFor = reader => async tenant => {
      const state = await reader.read({ ...owner, tenant });
      await pausePolicyRead('subject');
      return { code: [grant], operator: state.policy.subjectGrants, generation: state.generation };
    };
    try {
      const initialPolicy = { settings: { deployment: {}, overrides: {} }, subjectGrants: [grant] };
      const created = await operatorPolicy.replace(owner, 0, initialPolicy);
      assert.equal(created.generation, 1);
      for (let n = 0; n < 2; n++) {
        policyStores.push(await createPostgresOperatorPolicy({ connectionString: operatorURI, namespace: operatorNamespace }));
        settingsStores.push(await createPostgresTenantSettings({
          connectionString: appURI, namespace: settingsNamespace, policyNamespace: operatorNamespace
        }));
        subjectStores.push(await createPostgresSubjectPolicy({
          connectionString: appURI, namespace: subjectNamespace, policyNamespace: operatorNamespace
        }));
      }
      const readers = policyStores.map(store => createOperatorPolicy({
        store, authorizeManagement: async ctx => ctx.principal === 'root' && ctx.consumer === 'owner'
      }));
      const settingsWorkers = settingsStores.map((store, index) => createTenantSettings({
        store, authorize: async ctx => ctx.principal === 'root' && ctx.consumer === 'owner',
        policyFor: policyFor(readers[index])
      }));
      const subjectWorkers = subjectStores.map((store, index) => createSubjectPolicy({
        store,
        authorizeManagement: async ctx => ctx.principal === 'root' && ctx.consumer === 'owner',
        limitsFor: limitsFor(readers[index])
      }));
      const [settingsWorker, otherSettingsWorker] = settingsWorkers;
      const [subjectWorker, otherSubjectWorker] = subjectWorkers;
      await settingsWorker.replace(owner, 0, { DISPLAY_UNITS: 'mmol' });
      await settingsWorker.replace(owner, 1, { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true });
      await subjectWorker.replace(owner, 0, []);

      const subjectRace = gateNext('subject');
      const staleGrantWrite = otherSubjectWorker.replace(owner, 1, [grant]);
      await subjectRace.arrived;
      const gen2 = await operatorPolicy.replace(owner, 1, {
        settings: initialPolicy.settings, subjectGrants: []
      });
      assert.equal(gen2.generation, 2);
      subjectRace.release();
      await assert.rejects(staleGrantWrite, { code: 'POLICY_GENERATION_CONFLICT' });
      assert.deepEqual(await subjectWorker.read(owner), { version: 1, grants: [] });

      const settingsRace = gateNext('settings');
      const staleSettingsWrite = otherSettingsWorker.replace(owner, 2, { SHOW_SECONDS: true });
      await settingsRace.arrived;
      const gen3 = await operatorPolicy.replace(owner, 2, {
        settings: {
          deployment: { SHOW_SECONDS: { mode: 'pinned', pin: false } },
          overrides: {}
        },
        subjectGrants: []
      });
      assert.equal(gen3.generation, 3);
      settingsRace.release();
      await assert.rejects(staleSettingsWrite, { code: 'POLICY_GENERATION_CONFLICT' });
      assert.deepEqual((await settingsWorker.read(owner)).values,
        { DISPLAY_UNITS: 'mmol', SHOW_SECONDS: true });

      const rollbackRace = gateNext('settings');
      const staleRollback = otherSettingsWorker.rollback(owner, 2, 1);
      await rollbackRace.arrived;
      const gen4 = await operatorPolicy.replace(owner, 3, {
        settings: {
          deployment: {
            DISPLAY_UNITS: { mode: 'bounded', allowed: ['mg/dl'] },
            SHOW_SECONDS: { mode: 'pinned', pin: false }
          },
          overrides: {}
        },
        subjectGrants: []
      });
      assert.equal(gen4.generation, 4);
      rollbackRace.release();
      await assert.rejects(staleRollback, { code: 'POLICY_GENERATION_CONFLICT' });
      assert.equal((await settingsWorker.read(owner)).version, 2, 'stale rollback created no version');
      assert.equal((await operatorPolicy.read(owner)).generation, 4);

      await admin.query(`REVOKE SELECT ON ${operatorPolicyTable} FROM ${operatorRole}`);
      try {
        await assert.rejects(otherSettingsWorker.replace(owner, 2, {}), { code: 'OPERATOR_POLICY_STORE_UNAVAILABLE' });
        await assert.rejects(otherSubjectWorker.replace(owner, 1, []), { code: 'OPERATOR_POLICY_STORE_UNAVAILABLE' });
      } finally { await admin.query(`GRANT SELECT ON ${operatorPolicyTable} TO ${operatorRole}`); }
    } finally {
      for (const store of policyStores) await store.close();
      for (const store of settingsStores) await store.close();
      for (const store of subjectStores) await store.close();
    }
  });
  it('serializes competing inserts to exactly one immutable reference', async function () {
    const otherWorker = await open();
    try {
      const attempts = await Promise.allSettled([persistence, otherWorker].map((p, index) =>
        p.store.insert({ format: 1, tenant: A, id: 'race', ciphertext: 'winner-' + index })));
      assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'SECRETS_REFERENCE_EXISTS');
    } finally { await otherWorker.close(); }
  });

  it('commits audit before provider work even when an unrelated caller transaction rolls back', async function () {
    const outer = await postgresConnection({ connectionString: appURI, max: 1 });
    let providerCalled = false;
    const component = createSecrets({
      ...persistence,
      providerFor: async () => ({
        async encrypt () {
          providerCalled = true;
          const result = await admin.query(`SELECT principal, consumer, operation, secret_id, phase FROM ${audits}
            WHERE tenant_id = $1 AND secret_id = 'audited-failure'`, [A]);
          assert.deepEqual(result.rows, [{
            principal: 'root', consumer: 'issuer', operation: 'encrypt', secret_id: 'audited-failure', phase: 'authorized'
          }]);
          throw new Error('synthetic provider outage');
        }
      }),
      authorize: async () => true,
      maxTokenLifetimeSeconds: 30
    });
    try {
      await assert.rejects(outer.withTenant(A, () =>
        component.encrypt({ tenant: A, principal: 'root', consumer: 'issuer' },
          'audited-failure', Buffer.from('synthetic-plaintext'))), /synthetic provider outage/);
    } finally { await outer.end(); }
    assert.equal(providerCalled, true);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${audits}
      WHERE tenant_id = $1 AND secret_id = 'audited-failure'`, [A])).rows[0].n, 1);
    assert.equal(await persistence.store.get(A, 'audited-failure'), undefined);
  });

  it('commits every concurrent audit row in one tenant-local SQL batch without dropping receipts', async function () {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    await admin.query('SELECT pg_stat_statements_reset()');
    const base = Date.now();
    const pending = Array.from({ length: 16 }, (_, i) => persistence.audit({ tenant: A, principal: 'subject', consumer: 'batch_probe',
      operation: 'verify', phase: 'authorized', time: base + i }));
    await Promise.all(pending);
    const rows = (await admin.query(`SELECT event_time FROM ${audits} WHERE tenant_id=$1 AND consumer='batch_probe' ORDER BY event_time`, [A])).rows;
    assert.deepEqual(rows.map(row => Number(row.event_time)), Array.from({ length: 16 }, (_, i) => base + i), 'all receipts are visible to another connection after append resolves');
    const stats = (await admin.query(`SELECT calls::integer,rows::integer FROM pg_stat_statements WHERE userid=$1::regrole::oid AND query LIKE 'INSERT INTO %secret_audit%'`, [appRole])).rows;
    assert.equal(stats.length, 1); assert.equal(stats[0].calls, 1); assert.equal(stats[0].rows, 16);
    process.stdout.write('AUTHZ_NATIVE_AUDIT_BATCH ' + JSON.stringify({ statements: stats[0].calls, rows: stats[0].rows }) + '\n');
  });

  it('refuses extra audit fields instead of persisting secret payloads', async function () {
    await assert.rejects(persistence.audit({
      tenant: A, principal: 'root', consumer: 'issuer', operation: 'sign', phase: 'authorized',
      time: Date.now(), plaintext: 'must-not-persist'
    }), /record fields/);
    await assert.rejects(persistence.store.insert({
      tenant: A, id: 'extra', format: 1, ciphertext: 'opaque', key: 'must-not-persist'
    }), /record fields/);
    await assert.rejects(persistence.audit({
      tenant: A, principal: 'root', consumer: 'issuer', operation: 'reveal', phase: 'authorized', time: Date.now()
    }), /audit event/);
    await assert.rejects(persistence.store.get('tenant-slug', 'same'), /canonical UUID/);
  });

  it('enforces RLS against omitted predicates, unbound reads and foreign-tenant inserts', async function () {
    const client = await connectApp();
    try {
      assert.equal((await client.query(`SELECT * FROM ${records}`)).rowCount, 0);
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
      assert.ok((await client.query(`SELECT tenant_id FROM ${records}`)).rows.every(row => row.tenant_id === A));
      await assert.rejects(client.query(`INSERT INTO ${records} VALUES ($1,'forged',1,'opaque')`, [B]),
        { code: '42501' });
      await client.query('ROLLBACK');
      await assert.rejects(client.query(`INSERT INTO ${records} VALUES ($1,'unbound',1,'opaque')`, [A]),
        { code: '42501' });
    } finally { await client.end(); }
  });

  it('makes audit append-only and unreadable to the application role', async function () {
    await persistence.audit({
      tenant: A, principal: 'root', consumer: 'issuer', operation: 'sign', phase: 'authorized', time: Date.now()
    });
    const client = await connectApp();
    try {
      for (const sql of [`SELECT * FROM ${audits}`, `UPDATE ${audits} SET principal = 'forged'`,
        `DELETE FROM ${audits}`, `TRUNCATE ${audits}`, `DELETE FROM ${records}`,
        `UPDATE ${records} SET ciphertext = 'forged'`]) {
        await assert.rejects(client.query(sql), { code: '42501' });
      }
    } finally { await client.end(); }
  });

  it('uses a separate ciphertext-only maintenance role with compare-and-swap protection', async function () {
    const maintenance = await createPostgresSecretsMaintenance({ connectionString: maintenanceURI, namespace });
    const client = new Client({ connectionString: maintenanceURI });
    await client.connect();
    try {
      assert.equal(maintenance.store.insert, undefined);
      assert.equal(persistence.store.compareAndSwapCiphertext, undefined);
      assert.equal(await maintenance.store.compareAndSwapCiphertext(A, 'same', 'stale', 'replacement'), false);
      assert.equal(await maintenance.store.compareAndSwapCiphertext(A, 'same', 'opaque-a', 'wrapped-a'), true);
      assert.equal(await maintenance.store.compareAndSwapCiphertext(A, 'same', 'opaque-a', 'lost-update'), false);
      assert.equal((await persistence.store.get(B, 'same')).ciphertext, 'opaque-b');
      assert.equal(await maintenance.store.compareAndSwapCiphertext(A, 'same', 'wrapped-a', 'opaque-a'), true);
      for (const sql of [`INSERT INTO ${records} VALUES ($1,'forged',1,'opaque')`,
        `UPDATE ${records} SET id = 'forged'`, `UPDATE ${records} SET tenant_id = $1`,
        `DELETE FROM ${records}`, `SELECT * FROM ${audits}`]) {
        await assert.rejects(client.query(sql, sql.includes('$1') ? [A] : []), { code: '42501' });
      }
      await assert.rejects(createPostgresSecrets({ connectionString: maintenanceURI, namespace }),
        { code: 'SECRETS_STORE_UNSAFE' });
      await assert.rejects(createPostgresSecretsMaintenance({ connectionString: appURI, namespace }),
        { code: 'SECRETS_STORE_UNSAFE' });
    } finally {
      await client.end();
      await maintenance.close();
    }
    await admin.query(`GRANT UPDATE (ciphertext) ON ${records} TO ${appRole}`);
    try { await assert.rejects(open(), { code: 'SECRETS_STORE_UNSAFE' }); } finally {
      await admin.query(`REVOKE UPDATE (ciphertext) ON ${records} FROM ${appRole}`);
    }
  });

  it('refuses unsafe startup roles and missing schemas without migrating', async function () {
    await assert.rejects(createPostgresSecrets({ connectionString: adminURI, namespace }),
      { code: 'SECRETS_STORE_UNAVAILABLE' });
    await assert.rejects(createPostgresSecrets({ connectionString: appURI, namespace: 'not_installed' }),
      { code: 'SECRETS_STORE_UNSAFE' });
    assert.equal((await admin.query("SELECT to_regnamespace('not_installed') AS n")).rows[0].n, null);
    await admin.query(`GRANT UPDATE ON ${audits} TO ${appRole}`);
    try { await assert.rejects(open(), { code: 'SECRETS_STORE_UNSAFE' }); } finally {
      await admin.query(`REVOKE UPDATE ON ${audits} FROM ${appRole}`);
    }
  });

  it('red control: disabling actual RLS exposes foreign rows to omitted-predicate SQL', async function () {
    await admin.query(`ALTER TABLE ${records} DISABLE ROW LEVEL SECURITY`);
    const client = await connectApp();
    try {
      assert.ok((await client.query(`SELECT tenant_id FROM ${records}`)).rows.some(row => row.tenant_id === B));
      await assert.rejects(open(), { code: 'SECRETS_STORE_UNSAFE' });
    } finally {
      await client.end();
      await admin.query(`ALTER TABLE ${records} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it('fails before decryption when the audit insert is refused', async function () {
    let providerCalled = false;
    const component = createSecrets({
      ...persistence,
      providerFor: async () => { providerCalled = true; throw new Error('must not reach provider'); },
      authorize: async () => true, maxTokenLifetimeSeconds: 30
    });
    await admin.query(`REVOKE INSERT ON ${audits} FROM ${appRole}`);
    try {
      await assert.rejects(component.reveal({ tenant: A, principal: 'root', consumer: 'issuer' },
        { tenant: A, id: 'same' }), { code: 'SECRETS_STORE_UNAVAILABLE' });
      assert.equal(providerCalled, false);
    } finally { await admin.query(`GRANT INSERT ON ${audits} TO ${appRole}`); }
  });

  it('survives a database restart and preserves committed audit/reference records', async function () {
    await persistence.close();
    persistence = undefined;
    await admin.end();
    admin = undefined;
    docker(['restart', container]);
    const deadline = Date.now() + 15000;
    let ready = false;
    do {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'secrets_test']);
        ready = true;
      } catch (error) {
        if (error.status !== 1 && error.status !== 2) throw error;
        await sleep(100);
      }
    } while (!ready && Date.now() < deadline);
    assert.ok(ready);
    // Docker may assign a new ephemeral host port when restarting this container.
    port = docker(['port', container, '5432/tcp']).split(':').pop();
    const adminURL = new URL(adminURI), appURL = new URL(appURI), maintenanceURL = new URL(maintenanceURI);
    adminURL.port = port;
    appURL.port = port;
    maintenanceURL.port = port;
    adminURI = adminURL.toString();
    appURI = appURL.toString();
    maintenanceURI = maintenanceURL.toString();
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    persistence = await open();
    assert.equal((await persistence.store.get(A, 'same')).ciphertext, 'opaque-a');
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${audits}
      WHERE secret_id = 'audited-failure'`)).rows[0].n, 1);
  });

  (process.env.NS_VAULT_DOCKER_TEST === '1' ? it : it.skip)('restores ciphertext, audit and required Vault key versions from synthetic backups', async function () {
    this.timeout(90000);
    const vaults = new Set();
    let restored, restoredAdmin;
    async function api (server, path, body) {
      const response = await fetch(server.address + '/v1/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Vault-Token': server.root || '', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
      });
      assert.ok(response.ok, 'Vault recovery fixture HTTP ' + response.status);
      return response.status === 204 ? {} : response.json();
    }
    async function waitHealth (server, status) {
      const deadline = Date.now() + 15000;
      do {
        try {
          const response = await fetch(server.address + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
          await response.body.cancel();
          if (response.status === status) return;
        } catch (error) {
          if (!error.cause || !['ECONNREFUSED', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause.code)) throw error;
        }
        await sleep(100);
      } while (Date.now() < deadline);
      assert.fail('Vault recovery fixture did not reach expected health ' + status);
    }
    async function startVault () {
      const name = 'ns-secrets-recovery-' + crypto.randomBytes(8).toString('hex');
      const config = {
        storage: { raft: { path: '/vault/file', node_id: name } }, disable_mlock: true,
        listener: { tcp: { address: '0.0.0.0:8200', tls_disable: true } },
        api_addr: 'http://127.0.0.1:8200', cluster_addr: 'https://127.0.0.1:8201'
      };
      execFileSync('docker', ['run', '--rm', '--name', name, '-d', '-p', '127.0.0.1::8200',
        '-e', 'VAULT_LOCAL_CONFIG',
        'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2', 'server'],
      { env: { ...process.env, VAULT_LOCAL_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'] });
      vaults.add(name);
      const server = { name, address: 'http://127.0.0.1:' + docker(['port', name, '8200/tcp']).split(':').pop() };
      await waitHealth(server, 501);
      const initialized = await api(server, 'sys/init', { secret_shares: 1, secret_threshold: 1 });
      server.root = initialized.root_token;
      server.unsealKey = initialized.keys_base64[0];
      await api(server, 'sys/unseal', { key: server.unsealKey });
      await waitHealth(server, 200);
      return server;
    }
    async function snapshot (server) {
      const response = await fetch(server.address + '/v1/sys/storage/raft/snapshot', {
        headers: { 'X-Vault-Token': server.root }, signal: AbortSignal.timeout(10000)
      });
      assert.equal(response.status, 200);
      return Buffer.from(await response.arrayBuffer());
    }
    async function restoreSnapshot (server, archive, source) {
      const response = await fetch(server.address + '/v1/sys/storage/raft/snapshot-force', {
        method: 'POST', headers: { 'X-Vault-Token': server.root, 'Content-Type': 'application/octet-stream' },
        body: archive, signal: AbortSignal.timeout(15000)
      });
      if (response.body) await response.body.cancel();
      assert.equal(response.status, 204);
      server.root = source.root;
      await api(server, 'sys/unseal', { key: source.unsealKey });
      await waitHealth(server, 200);
    }
    const state = async client => ({
      records: (await client.query(`SELECT * FROM ${records} ORDER BY tenant_id, id`)).rows,
      audit: (await client.query(`SELECT * FROM ${audits} ORDER BY event_id`)).rows
    });
    const c = { tenant: A, principal: 'root', consumer: 'issuer' };
    const make = (p, server, token, signingVersion) => createSecrets({
      ...p, providerFor: async tenant => {
        assert.equal(tenant, A);
        return createVaultTransit({
          address: server.address, mount: 'transit', encryptionKey: 'tenant-a-data', signingKey: 'tenant-a-signing',
          signingVersion, getToken: async () => token, allowInsecureLoopback: true
        });
      },
      authorize: async context => context.tenant === A && context.principal === 'root' && context.consumer === 'issuer',
      maxTokenLifetimeSeconds: 300
    });
    try {
      const source = await startVault();
      await api(source, 'sys/mounts/transit', { type: 'transit' });
      for (const key of ['tenant-a-data', 'tenant-a-signing']) {
        await api(source, 'transit/keys/' + key, { type: 'aes256-gcm96', exportable: false });
      }
      const policy = ['encrypt', 'decrypt'].map(operation =>
        `path "transit/${operation}/tenant-a-data" { capabilities = ["update"] }`).concat(
        ['hmac', 'verify'].map(operation =>
          `path "transit/${operation}/tenant-a-signing" { capabilities = ["update"] }`)).join('\n');
      await api(source, 'sys/policies/acl/runtime', { policy });
      const scoped = (await api(source, 'auth/token/create', {
        policies: ['runtime'], no_default_policy: true, ttl: '5m', renewable: false
      })).auth.client_token;
      const first = make(persistence, source, scoped, 1);
      const oldRef = await first.encrypt(c, 'backup-v1', Buffer.from('synthetic-recovery-v1'));
      const oldJWT = await first.signJWT(c, 'synthetic-subject', 300);
      const oldKeys = await snapshot(source);
      for (const key of ['tenant-a-data', 'tenant-a-signing']) await api(source, 'transit/keys/' + key + '/rotate', {});
      const second = make(persistence, source, scoped, 2);
      const newRef = await second.encrypt(c, 'backup-v2', Buffer.from('synthetic-recovery-v2'));
      const newJWT = await second.signJWT(c, 'synthetic-subject', 300);
      await persistence.store.insert({ tenant: B, id: 'backup-foreign', format: 1, ciphertext: 'opaque-foreign' });
      const allKeys = await snapshot(source);
      const expected = await state(admin);
      const dump = execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'operator', '-Fc', 'secrets_test'],
        { maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      await admin.query('CREATE DATABASE secrets_restored');
      execFileSync('docker', ['exec', '-i', container, 'pg_restore', '-U', 'operator',
        '--exit-on-error', '-d', 'secrets_restored'], { input: dump, stdio: ['pipe', 'pipe', 'pipe'] });
      const adminURL = new URL(adminURI), appURL = new URL(appURI);
      adminURL.pathname = appURL.pathname = '/secrets_restored';
      await run('check', { direct: true, connectionString: adminURL.toString(), namespace, catalogue });
      restoredAdmin = new Client({ connectionString: adminURL.toString() });
      await restoredAdmin.connect();
      assert.equal((await restoredAdmin.query('SELECT current_database() AS name')).rows[0].name, 'secrets_restored');
      assert.deepEqual(await state(restoredAdmin), expected, 'restore preserves every reference and audit event');
      restored = await createPostgresSecrets({ connectionString: appURL.toString(), namespace });
      assert.match((await restored.store.get(A, oldRef.id)).ciphertext, /^vault:v1:/);
      assert.match((await restored.store.get(A, newRef.id)).ciphertext, /^vault:v2:/);
      const restoredClient = new Client({ connectionString: appURL.toString() });
      await restoredClient.connect();
      try {
        assert.equal((await restoredClient.query(`SELECT * FROM ${records}`)).rowCount, 0);
        await assert.rejects(restoredClient.query(`SELECT * FROM ${audits}`), { code: '42501' });
        await assert.rejects(restoredClient.query(`UPDATE ${records} SET ciphertext = 'forged'`), { code: '42501' });
        await restoredClient.query('BEGIN');
        await restoredClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
        assert.deepEqual((await restoredClient.query(`SELECT tenant_id, id FROM ${records} ORDER BY id`)).rows,
          expected.records.filter(row => row.tenant_id === A).map(row => ({ tenant_id: row.tenant_id, id: row.id })));
        await restoredClient.query('ROLLBACK');
      } finally { await restoredClient.end(); }
      const target = await startVault();
      await api(target, 'sys/mounts/transit', { type: 'transit' });
      const missing = await fetch(target.address + '/v1/transit/keys/tenant-a-data', {
        headers: { 'X-Vault-Token': target.root }, signal: AbortSignal.timeout(5000)
      });
      await missing.body.cancel();
      assert.equal(missing.status, 404, 'negative control has no data key, not merely a denied credential');
      await assert.rejects(make(restored, target, target.root, 1).reveal(c, oldRef),
        { code: 'SECRETS_PROVIDER_REFUSED' });
      docker(['rm', '-f', '-v', source.name]);
      vaults.delete(source.name);
      await restoreSnapshot(target, oldKeys, source);
      assert.equal((await api(target, 'transit/keys/tenant-a-data')).data.latest_version, 1);
      assert.equal((await make(restored, target, scoped, 1).reveal(c, oldRef)).toString(), 'synthetic-recovery-v1');
      assert.equal((await make(restored, target, scoped, 1).verifyJWT(c, oldJWT)).accessToken, 'synthetic-subject');
      await assert.rejects(make(restored, target, scoped, 2).reveal(c, newRef), { code: 'SECRETS_PROVIDER_REFUSED' });
      await assert.rejects(make(restored, target, scoped, 2).verifyJWT(c, newJWT), { code: 'SECRETS_PROVIDER_REFUSED' });
      await restoreSnapshot(target, allKeys, source);
      const recovered = make(restored, target, scoped, 2);
      for (const key of ['tenant-a-data', 'tenant-a-signing']) {
        const metadata = (await api(target, 'transit/keys/' + key)).data;
        assert.equal(metadata.latest_version, 2);
        assert.equal(metadata.exportable, false);
      }
      assert.equal((await recovered.reveal(c, oldRef)).toString(), 'synthetic-recovery-v1');
      assert.equal((await recovered.reveal(c, newRef)).toString(), 'synthetic-recovery-v2');
      for (const token of [oldJWT, newJWT]) {
        assert.equal((await recovered.verifyJWT(c, token)).accessToken, 'synthetic-subject');
      }
      const final = await state(restoredAdmin);
      assert.deepEqual(final.records, expected.records, 'restoration never replaces immutable references');
      const originalEvents = new Set(expected.audit.map(event => event.event_id));
      assert.deepEqual(final.audit.filter(event => originalEvents.has(event.event_id)), expected.audit);
      assert.ok(final.audit.length > expected.audit.length, 'restored audit remains appendable');
      docker(['rm', '-f', '-v', target.name]);
      vaults.delete(target.name);
      await assert.rejects(recovered.reveal(c, oldRef), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    } finally {
      try {
        if (restored) await restored.close();
        if (restoredAdmin) await restoredAdmin.end();
      } finally {
        for (const name of vaults) docker(['rm', '-f', '-v', name]);
      }
    }
  });

  (process.env.NS_VAULT_DOCKER_TEST === '1' ? it : it.skip)('persists real Vault ciphertext and retries scoped rewrap across races, failures and SIGKILL', async function () {
    const vaultName = 'ns-secrets-pg-vault-' + crypto.randomBytes(8).toString('hex');
    const root = crypto.randomBytes(32).toString('hex');
    let vaultOwned = false;
    try {
      execFileSync('docker', ['run', '--rm', '--name', vaultName, '-d', '-p', '127.0.0.1::8200',
        '-e', 'VAULT_DEV_ROOT_TOKEN_ID',
        'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2',
        'server', '-dev', '-dev-listen-address=0.0.0.0:8200'],
      { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: root }, stdio: ['ignore', 'pipe', 'pipe'] });
      vaultOwned = true;
      const address = 'http://127.0.0.1:' + docker(['port', vaultName, '8200/tcp']).split(':').pop();
      const deadline = Date.now() + 15000;
      let ready = false;
      do {
        try {
          const health = await fetch(address + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
          ready = health.ok;
          await health.body.cancel();
        } catch (error) {
          if (!error.cause || !['ECONNREFUSED', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause.code)) throw error;
        }
        if (!ready) await sleep(100);
      } while (!ready && Date.now() < deadline);
      assert.ok(ready, 'owned Vault must become responsive');
      async function provision (path, body) {
        const response = await fetch(address + '/v1/' + path, {
          method: 'POST', headers: { 'X-Vault-Token': root, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
        });
        assert.ok(response.ok, 'Vault provisioning HTTP ' + response.status);
        return response.status === 204 ? {} : response.json();
      }
      await provision('sys/mounts/transit', { type: 'transit' });
      for (const key of ['tenant-a-data', 'tenant-a-signing']) {
        await provision('transit/keys/' + key, { type: 'aes256-gcm96', exportable: false });
      }
      const policy = ['encrypt', 'decrypt'].map(operation =>
        `path "transit/${operation}/tenant-a-data" { capabilities = ["update"] }`).concat(
        ['hmac', 'verify'].map(operation =>
          `path "transit/${operation}/tenant-a-signing" { capabilities = ["update"] }`)).join('\n');
      await provision('sys/policies/acl/runtime', { policy });
      const scoped = (await provision('auth/token/create', {
        policies: ['runtime'], no_default_policy: true, ttl: '5m', renewable: false
      })).auth.client_token;
      const provider = createVaultTransit({
        address, mount: 'transit', encryptionKey: 'tenant-a-data', signingKey: 'tenant-a-signing',
        signingVersion: 1, getToken: async () => scoped, allowInsecureLoopback: true
      });
      const makeComponent = () => createSecrets({
        ...persistence,
        providerFor: async tenant => { assert.equal(tenant, A); return provider; },
        authorize: async c => c.tenant === A && c.principal === 'root' && c.consumer === 'issuer',
        maxTokenLifetimeSeconds: 30
      });
      const c = { tenant: A, principal: 'root', consumer: 'issuer' };
      const ref = await makeComponent().encrypt(c, 'real-vault', Buffer.from('synthetic-persisted-secret'));
      assert.match((await persistence.store.get(A, ref.id)).ciphertext, /^vault:v1:/);
      await persistence.close();
      persistence = await open();
      assert.equal((await makeComponent().reveal(c, ref)).toString(), 'synthetic-persisted-secret');
      const stored = await admin.query(`SELECT * FROM ${records} WHERE id = 'real-vault'`);
      const audited = await admin.query(`SELECT * FROM ${audits} WHERE secret_id = 'real-vault' ORDER BY event_time`);
      assert.deepEqual(audited.rows.map(row => row.operation), ['encrypt', 'reveal']);
      assert.doesNotMatch(JSON.stringify([stored.rows, audited.rows]), /synthetic-persisted-secret/);
      await provision('sys/policies/acl/rewrapper', {
        policy: 'path "transit/rewrap/tenant-a-data" { capabilities = ["update"] }'
      });
      const wrapperToken = (await provision('auth/token/create', {
        policies: ['rewrapper'], no_default_policy: true, ttl: '5m', renewable: false
      })).auth.client_token;
      const wrapper = createVaultTransit({
        address, mount: 'transit', encryptionKey: 'tenant-a-data', signingKey: 'tenant-a-signing',
        signingVersion: 1, getToken: async () => wrapperToken, allowInsecureLoopback: true
      });
      const original = (await persistence.store.get(A, ref.id)).ciphertext;
      await assert.rejects(wrapper.decrypt(original), { code: 'SECRETS_PROVIDER_REFUSED' });
      await assert.rejects(provider.rewrap(original, 2), { code: 'SECRETS_PROVIDER_REFUSED' });
      await provision('transit/keys/tenant-a-data/rotate', {});
      const maintenance = await createPostgresSecretsMaintenance({ connectionString: maintenanceURI, namespace });
      const secondWorker = await createPostgresSecretsMaintenance({ connectionString: maintenanceURI, namespace });
      const wrapComponent = (p, cryptoProvider = wrapper, store = p.store) => createSecrets({
        store, audit: p.audit, providerFor: async tenant => { assert.equal(tenant, A); return cryptoProvider; },
        authorize: async (ctx, action) => ctx.tenant === A && ctx.consumer === 'maintenance' &&
          ctx.principal === 'operator' && action.operation === 'rewrap',
        maxTokenLifetimeSeconds: 30
      });
      const operator = { tenant: A, principal: 'operator', consumer: 'maintenance' };
      try {
        let arrived = 0, release;
        const barrier = new Promise(resolve => { release = resolve; });
        const synchronized = { ...wrapper, async rewrap (...args) {
          if (++arrived === 2) release();
          await barrier;
          return wrapper.rewrap(...args);
        } };
        const races = await Promise.allSettled([maintenance, secondWorker].map(p =>
          wrapComponent(p, synchronized).rewrap(operator, ref, 2)));
        assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(races.find(result => result.status === 'rejected').reason.code, 'SECRETS_REWRAP_CONFLICT');
        const wrapped = (await persistence.store.get(A, ref.id)).ciphertext;
        assert.match(wrapped, /^vault:v2:/);
        await wrapComponent(maintenance).rewrap(operator, ref, 2);
        assert.equal((await persistence.store.get(A, ref.id)).ciphertext, wrapped);
        assert.equal((await makeComponent().reveal(c, ref)).toString(), 'synthetic-persisted-secret');

        await provision('transit/keys/tenant-a-data/rotate', {});
        await admin.query(`REVOKE UPDATE (ciphertext) ON ${records} FROM secrets_maintenance`);
        try {
          await assert.rejects(wrapComponent(maintenance).rewrap(operator, ref, 3),
            { code: 'SECRETS_STORE_UNAVAILABLE' });
          assert.equal((await persistence.store.get(A, ref.id)).ciphertext, wrapped);
        } finally { await admin.query(`GRANT UPDATE (ciphertext) ON ${records} TO secrets_maintenance`); }
        const lostReply = {
          ...maintenance.store,
          async compareAndSwapCiphertext (...args) {
            assert.equal(await maintenance.store.compareAndSwapCiphertext(...args), true);
            throw new Error('simulated lost reply after commit');
          }
        };
        await assert.rejects(wrapComponent(maintenance, wrapper, lostReply).rewrap(operator, ref, 3), /lost reply/);
        const committed = (await persistence.store.get(A, ref.id)).ciphertext;
        assert.match(committed, /^vault:v3:/);
        await wrapComponent(secondWorker).rewrap(operator, ref, 3);
        assert.equal((await persistence.store.get(A, ref.id)).ciphertext, committed);
        assert.equal((await makeComponent().reveal(c, ref)).toString(), 'synthetic-persisted-secret');
        await assert.rejects(wrapComponent(maintenance).rewrap(operator, ref, 2), /downgrade/);
        const attempts = await admin.query(`SELECT target_version FROM ${audits}
          WHERE secret_id = 'real-vault' AND operation = 'rewrap'`);
        assert.deepEqual(attempts.rows.map(row => row.target_version).sort(), ['2', '2', '2', '2', '3', '3', '3']);
        await provision('transit/keys/tenant-a-data/config', { min_decryption_version: 3 });
        await assert.rejects(provider.decrypt(original), { code: 'SECRETS_PROVIDER_REFUSED' });
        assert.equal((await makeComponent().reveal(c, ref)).toString(), 'synthetic-persisted-secret');

        for (const [pauseAt, targetVersion] of [['before-cas', 4], ['after-commit', 5]]) {
          await provision('transit/keys/tenant-a-data/rotate', {});
          const before = (await persistence.store.get(A, ref.id)).ciphertext;
          const count = async () => (await admin.query(`SELECT count(*)::int AS n FROM ${audits}
            WHERE secret_id = $1 AND operation = 'rewrap'`, [ref.id])).rows[0].n;
          const attemptsBefore = await count();
          const workerOptions = {
            connectionString: maintenanceURI, namespace, address, token: wrapperToken,
            tenant: A, id: ref.id, targetVersion
          };
          await rewrapWorker({ ...workerOptions, pauseAt });
          const afterKill = (await persistence.store.get(A, ref.id)).ciphertext;
          if (pauseAt === 'before-cas') assert.equal(afterKill, before);
          else assert.match(afterKill, /^vault:v5:/);
          assert.equal(await count(), attemptsBefore + 1, 'audit survives actual worker termination');
          assert.equal((await makeComponent().reveal(c, ref)).toString(), 'synthetic-persisted-secret');
          await rewrapWorker(workerOptions);
          const retried = (await persistence.store.get(A, ref.id)).ciphertext;
          assert.ok(retried.startsWith('vault:v' + targetVersion + ':'));
          if (pauseAt === 'after-commit') assert.equal(retried, afterKill, 'retry preserves committed bytes');
          assert.equal(await count(), attemptsBefore + 2);
          assert.equal((await makeComponent().reveal(c, ref)).toString(), 'synthetic-persisted-secret');
        }
      } finally {
        await maintenance.close();
        await secondWorker.close();
      }
      docker(['rm', '-f', '-v', vaultName]);
      vaultOwned = false;
      await assert.rejects(makeComponent().decrypt(c, ref), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    } finally { if (vaultOwned) docker(['rm', '-f', '-v', vaultName]); }
  });
});
