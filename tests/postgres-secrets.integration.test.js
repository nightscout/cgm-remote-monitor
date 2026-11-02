'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/secrets/postgres-candidate.json');
const { createPostgresSecrets, createPostgresSecretsMaintenance } = require('../lib/secrets/postgres');
const { createSecrets } = require('../lib/secrets/component');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const scope = require('../lib/storage/tenant-scope');
const postgresConnection = require('../lib/storage/postgres-connection');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(process.env.NS_SECRETS_POSTGRES_DOCKER_TEST === '1' ? describe : describe.skip)('secrets persistence (disposable PostgreSQL)', function () {
  this.timeout(30000);
  const container = 'ns-secrets-pg-' + crypto.randomBytes(8).toString('hex');
  const namespace = 'secrets_test';
  const appRole = 'secrets_app';
  const records = '"' + namespace + '".secret_records';
  const audits = '"' + namespace + '".secret_audit';
  let owned = false, admin, adminURI, appURI, maintenanceURI, persistence, previousMode, port;

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
      '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=secrets_test', 'postgres:16'],
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
    assert.deepEqual(upgrade.done, ['0002_secrets_rewrap']);
    await run('check', { direct: true, connectionString: adminURI, namespace, catalogue });
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    const appPassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO ${appRole}`);
    await admin.query(`GRANT SELECT, INSERT ON ${records} TO ${appRole}`);
    await admin.query(`GRANT INSERT ON ${audits} TO ${appRole}`);
    const url = new URL(adminURI);
    url.username = appRole;
    url.password = appPassword;
    appURI = url.toString();
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
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', container]);
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

  (process.env.NS_VAULT_DOCKER_TEST === '1' ? it : it.skip)('persists real Vault ciphertext and safely retries scoped rewrap across competing workers and failures', async function () {
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
      } finally {
        await maintenance.close();
        await secondWorker.close();
      }
      docker(['rm', '-f', vaultName]);
      vaultOwned = false;
      await assert.rejects(makeComponent().decrypt(c, ref), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    } finally { if (vaultOwned) docker(['rm', '-f', vaultName]); }
  });
});
