'use strict';
// covers: lib/tenant-lifecycle/key-retention.js, lib/tenant-lifecycle/index.js, lib/tenant-lifecycle/ceremony.js, lib/secrets/vault-transit-custodian.js
// Native post-deletion key retention: disposable PostgreSQL 16 and Vault dev,
// synthetic tenants only. The lifecycle ledger namespace holds every table the
// lifecycle candidate creates (0001-0005); the tenant catalogue is the secrets
// domain, so the measured restore is the credential restore the decision names.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const scope = require('../lib/storage/tenant-scope');
const lowerPort = require('../lib/storage/postgres-connection');
const lifecycleModule = require('../lib/tenant-lifecycle');
const retention = require('../lib/tenant-lifecycle/key-retention');
const { createVaultTransit } = require('../lib/secrets/vault-transit');
const { createVaultTransitCustodian } = require('../lib/secrets/vault-transit-custodian');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 60 * 60 * 1000;
const T0 = 1800000000000;
const VAULT_IMAGE = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = (label, value) => { if (process.env.NS_KEY_RETENTION_REPORT) process.stdout.write('KEY_RETENTION ' + label + ' ' + JSON.stringify(value) + '\n'); };

optInSuite(process.env.NS_KEY_RETENTION_DOCKER_TEST === '1', 'NS_KEY_RETENTION_DOCKER_TEST=1')('tenant key retention (disposable PostgreSQL and Vault)', function () {
  this.timeout(60000);
  const suffix = crypto.randomBytes(6).toString('hex');
  const pgName = 'ns-kr-pg-' + suffix, vaultName = 'ns-kr-vault-' + suffix;
  const ledgerNamespace = 'kr_lifecycle', namespaces = { secrets: 'kr_secrets' };
  const root = crypto.randomBytes(16).toString('hex');
  const keysOf = tenant => [{ mount: 'transit', name: 'tenant-' + tenant.slice(0, 8) + '-data' }, { mount: 'transit', name: 'tenant-' + tenant.slice(0, 8) + '-signing' }];
  const owned = new Set();
  let admin, port, vault, runtimeToken, custodianToken, artifactDirectory, life, pgVersion;

  async function vaultApi (pathname, body, method) {
    const response = await fetch(vault + '/v1/' + pathname, { method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'X-Vault-Token': root, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  const keyStatus = async key => (await vaultApi(key.mount + '/keys/' + key.name)).status;
  const transit = tenant => createVaultTransit({ address: vault, mount: 'transit', encryptionKey: keysOf(tenant)[0].name, signingKey: keysOf(tenant)[1].name,
    signingVersion: 1, getToken: async () => runtimeToken, allowInsecureLoopback: true });
  async function decrypts (tenant, ciphertext) {
    const value = JSON.parse((await transit(tenant).decrypt(ciphertext)).toString('utf8'));
    return { tenant: value.tenant, id: value.id, data: Buffer.from(value.data, 'base64').toString('utf8') };
  }
  async function seedSecret (tenant, id, data) {
    const ciphertext = await transit(tenant).encrypt(Buffer.from(JSON.stringify({ tenant, id, data: Buffer.from(data).toString('base64') })));
    await admin.query('INSERT INTO kr_secrets.secret_records (tenant_id, id, format, ciphertext) VALUES ($1, $2, 1, $3)', [tenant, id, ciphertext]);
    await admin.query("INSERT INTO kr_secrets.secret_audit (event_id, tenant_id, principal, consumer, operation, secret_id, phase, event_time) VALUES ($1, $2, 'issuer', 'runtime', 'encrypt', $3, 'authorized', $4)",
      [crypto.randomUUID(), tenant, id, String(T0 - DAY)]);
    return ciphertext;
  }
  const count = async (table, tenant) => (await admin.query('SELECT count(*)::int AS n FROM kr_secrets.' + table + ' WHERE tenant_id = $1', [tenant])).rows[0].n;
  const records = async () => (await admin.query('SELECT * FROM kr_lifecycle.tenant_lifecycle_key_retention ORDER BY retained_at')).rows;

  before(async function () {
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--rm', '--name', pgName, '-d', '--tmpfs', '/var/lib/postgresql/data', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=kr_test', 'postgres:16'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned.add(pgName);
    execFileSync('docker', ['run', '--rm', '--name', vaultName, '-d', '-p', '127.0.0.1::8200', '-e', 'VAULT_DEV_ROOT_TOKEN_ID', VAULT_IMAGE,
      'server', '-dev', '-dev-listen-address=0.0.0.0:8200'], { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned.add(vaultName);
    port = docker(['port', pgName, '5432/tcp']).split(':').pop();
    vault = 'http://127.0.0.1:' + docker(['port', vaultName, '8200/tcp']).split(':').pop();
    const adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/kr_test';
    const deadline = Date.now() + 20000;
    let ready = false;
    do {
      try { docker(['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'kr_test']); ready = (await vaultApi('sys/health')).status === 200; } catch (error) {
        if (error.status !== 1 && error.status !== 2 && !(error.cause && ['ECONNREFUSED', 'UND_ERR_SOCKET', 'ECONNRESET'].includes(error.cause.code))) throw error;
      }
      if (!ready) await sleep(150);
    } while (!ready && Date.now() < deadline);
    assert.ok(ready, 'owned PostgreSQL and Vault must become responsive');
    await run('up', { direct: true, connectionString: adminURI, namespace: ledgerNamespace, catalogue: require('../lib/tenant-lifecycle/postgres-candidate.json') });
    await run('up', { direct: true, connectionString: adminURI, namespace: namespaces.secrets, catalogue: require('../lib/secrets/postgres-candidate.json') });
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    pgVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
    const rolePassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE kr_operator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${rolePassword}'`);
    for (const statement of [
      'GRANT USAGE ON SCHEMA kr_lifecycle, kr_secrets TO kr_operator',
      'GRANT SELECT ON kr_lifecycle.schema_migrations, kr_secrets.schema_migrations TO kr_operator',
      'GRANT SELECT, INSERT, DELETE ON kr_secrets.secret_records, kr_secrets.secret_audit TO kr_operator',
      'GRANT SELECT, INSERT, UPDATE ON kr_lifecycle.tenant_lifecycle_requests, kr_lifecycle.tenant_lifecycle_ceremony TO kr_operator',
      'GRANT SELECT, INSERT (request_id, tenant_id, artifact_digest, key_names, key_references, phase, retained_at, retain_until), ' +
        'UPDATE (phase, restored_at, destroy_started_by, destroy_started_consumer, destroy_started_at, destroyed_by, destroyed_consumer, destroyed_at) ' +
        'ON kr_lifecycle.tenant_lifecycle_key_retention TO kr_operator'
    ]) await admin.query(statement);
    // Every tenant has a lifecycle window and an activity row; the ceremony's
    // role pauses/suspends through it (decision deletion-request-auto-pauses).
    for (const statement of require('../lib/tenant-activity/postgres').grants({ namespace: ledgerNamespace, ceremony: 'kr_operator' })) await admin.query(statement);
    for (const [tenant, key] of [[A, '7101'], [B, '7102']]) {
      await admin.query("INSERT INTO kr_lifecycle.tenant_lifecycle_windows (tenant_id,lock_key,phase,generation) VALUES ($1,$2,'active',1)", [tenant, key]);
      await require('../lib/tenant-activity/provisioning').provisionInTransaction((text, values) => admin.query(text, values),
        { namespace: ledgerNamespace, tenant, principal: 'synthetic_operator', consumer: 'synthetic_control' });
    }
    const url = new URL(adminURI); url.username = 'kr_operator'; url.password = rolePassword;
    const operatorPort = await lowerPort({ connectionString: url.toString(), max: 2 });
    owned.add(operatorPort);
    await vaultApi('sys/mounts/transit', { type: 'transit' });
    for (const key of [...keysOf(A), ...keysOf(B)]) assert.equal((await vaultApi('transit/keys/' + key.name, { type: 'aes256-gcm96', exportable: false })).status, 200);
    const runtimePolicy = [A, B].flatMap(tenant => ['encrypt', 'decrypt'].map(op => `path "transit/${op}/${keysOf(tenant)[0].name}" { capabilities = ["update"] }`)).join('\n');
    const custodianPolicy = keysOf(A).map(key => `path "transit/keys/${key.name}/config" { capabilities = ["update"] }\npath "transit/keys/${key.name}" { capabilities = ["read", "delete"] }`).join('\n');
    await vaultApi('sys/policies/acl/kr-runtime', { policy: runtimePolicy });
    await vaultApi('sys/policies/acl/kr-custodian', { policy: custodianPolicy });
    runtimeToken = (await vaultApi('auth/token/create', { policies: ['kr-runtime'], no_default_policy: true, ttl: '10m' })).body.auth.client_token;
    custodianToken = (await vaultApi('auth/token/create', { policies: ['kr-custodian'], no_default_policy: true, ttl: '10m' })).body.auth.client_token;
    artifactDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-kr-artifacts-'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Directory this suite just created with mkdtemp.
    fs.chmodSync(artifactDirectory, 0o700);
    const inventory = async ({ tenant }) => keysOf(tenant);
    life = lifecycleModule.createLifecycle({
      catalogues: lifecycleModule.admittedCatalogue().filter(entry => entry.kind === 'secrets'),
      admissionCheck: ({ catalogues }) => assert.deepEqual(catalogues.map(entry => entry.kind), ['secrets']),
      authorize: async ({ tenant }) => ({ tenant, allowed: true, current: true, plane: 'operator', principal: 'synthetic_operator', consumer: 'synthetic_control' }),
      verifyDurableArtifact: lifecycleModule.createFilesystemArtifactVerifier({ directory: artifactDirectory }),
      executionWindow: async ({ tenant }) => ({ tenant, current: true, quiesced: true }),
      keyInventory: inventory,
      keyCustodian: createVaultTransitCustodian({ address: vault, getToken: async () => custodianToken, allowInsecureLoopback: true,
        keyAllowed: async ({ tenant, mount, name }) => (await inventory({ tenant })).some(key => key.mount === mount && key.name === name) })
    });
    life.port = operatorPort;
    report('environment', { postgres: pgVersion, vault: (await vaultApi('sys/health')).body.version, ledgerTables: retention.LEDGER_TABLES.length });
  });

  after(async function () {
    for (const item of owned) if (typeof item === 'object') await item.end();
    if (admin) await admin.end();
    for (const item of owned) if (typeof item === 'string') docker(['rm', '-f', '-v', item]);
    if (artifactDirectory) fs.rmSync(artifactDirectory, { recursive: true, force: true });
  });

  async function deleteTenant (at, keyNames) {
    const exportLife = keyNames === undefined ? life : lifecycleModule.createLifecycle({ catalogues: life.admittedCatalogue() });
    const artifact = await exportLife.exportTenant(life.port, { tenant: A, namespaces, sourceCommit: 'dc795bd1', now: () => at - 10, ...(keyNames === undefined ? {} : { keyNames }) });
    await lifecycleModule.saveTenantArtifact(artifact, { directory: artifactDirectory });
    const request = await life.requestDeletion(life.port, { tenant: A, ledgerNamespace, artifact, now: () => at - 3 });
    await life.confirmDeletion(life.port, { tenant: A, ledgerNamespace, artifact, requestId: request.requestId, now: () => at - 2 });
    const execute = () => life.executeDeletion(life.port, { tenant: A, namespaces, ledgerNamespace, artifact, requestId: request.requestId, now: () => at });
    return { artifact, requestId: request.requestId, execute };
  }
  const restore = (artifact, at) => life.importArtifact(life.port, artifact, { tenant: A, namespaces, ledgerNamespace, now: () => at });
  const destroyArgs = (requestId, at, extra = {}) => ({ tenant: A, namespaces, ledgerNamespace, requestId, now: () => at, intent: retention.destroyIntent(A, requestId), ...extra });

  let firstCipher, foreignCipher;
  it('control: an artifact missing one key reference refuses deletion; rows, audit and keys stay', async function () {
    firstCipher = await seedSecret(A, 'vendor-cloud', 'synthetic-credential-a');
    foreignCipher = await seedSecret(B, 'vendor-cloud', 'synthetic-credential-b');
    const { execute } = await deleteTenant(T0, [keysOf(A)[0]]);
    await assert.rejects(execute(), error => { report('control-missing-key-reference', { code: error.code, detail: error.detail }); return error.code === 'LIFECYCLE_KEY_REFERENCE_MISSING'; });
    assert.deepEqual([await count('secret_records', A), await count('secret_audit', A)], [1, 1]);
    assert.equal((await records()).length, 0);
    assert.deepEqual(await Promise.all(keysOf(A).map(keyStatus)), [200, 200]);
  });

  let first;
  it('executes deletion with a complete artifact and records a 30-day window; keys are retained', async function () {
    first = await deleteTenant(T0);
    const result = await first.execute();
    assert.deepEqual(result.retention, { retainedAt: T0, retainUntil: T0 + 30 * DAY, keys: 2 });
    assert.deepEqual([await count('secret_records', A), await count('secret_audit', A), await count('secret_records', B)], [0, 0, 1]);
    const [row] = await records();
    assert.deepEqual([row.phase, Number(row.retain_until), row.key_references, row.key_names], ['retained', T0 + 30 * DAY, 1, keysOf(A)]);
    assert.deepEqual(await Promise.all(keysOf(A).map(keyStatus)), [200, 200]);
    report('executed', { deleted: result.total, phase: row.phase, retainUntilMinusRetainedAt: Number(row.retain_until) - Number(row.retained_at) });
  });

  it('gate: restore inside the window succeeds and the credential decrypts', async function () {
    const at = T0 + 30 * DAY - 1;
    const result = await restore(first.artifact, at);
    assert.equal(result.total, 2);
    const [row] = await admin.query('SELECT ciphertext FROM kr_secrets.secret_records WHERE tenant_id = $1', [A]).then(r => r.rows);
    assert.equal(row.ciphertext, firstCipher);
    assert.deepEqual(await decrypts(A, row.ciphertext), { tenant: A, id: 'vendor-cloud', data: 'synthetic-credential-a' });
    const [record] = await records();
    assert.deepEqual([record.phase, Number(record.restored_at)], ['restored', at]);
    await assert.rejects(life.destroyRetainedKeys(life.port, destroyArgs(first.requestId, T0 + 31 * DAY)), { code: 'LIFECYCLE_RETENTION_RESTORED' });
    report('restore-inside-window', { written: result.total, phase: record.phase });
  });

  let second;
  it('gate: restore after the window refuses before any write', async function () {
    second = await deleteTenant(T0 + 40 * DAY);
    await second.execute();
    await assert.rejects(restore(second.artifact, T0 + 70 * DAY), error => { report('restore-after-window', { code: error.code }); return error.code === 'LIFECYCLE_RETENTION_EXPIRED'; });
    assert.equal(await count('secret_records', A), 0);
  });

  it('gate: operator destroy deletes the provider keys irreversibly, audits it, then restore refuses', async function () {
    const at = T0 + 70 * DAY;
    await assert.rejects(life.destroyRetainedKeys(life.port, destroyArgs(second.requestId, at - 1)), { code: 'LIFECYCLE_RETENTION_WINDOW_OPEN' });
    await assert.rejects(life.destroyRetainedKeys(life.port, destroyArgs(second.requestId, at, { intent: 'yes' })), { code: 'LIFECYCLE_DESTROY_INTENT_REQUIRED' });
    assert.deepEqual(await Promise.all(keysOf(A).map(keyStatus)), [200, 200], 'refusals reach no provider');
    const done = await life.destroyRetainedKeys(life.port, destroyArgs(second.requestId, at));
    assert.equal(done.phase, 'destroyed');
    assert.ok(!JSON.stringify(done).includes('vault:'));
    assert.deepEqual(await Promise.all(keysOf(A).map(keyStatus)), [404, 404]);
    assert.deepEqual(await Promise.all(keysOf(B).map(keyStatus)), [200, 200], 'foreign keys untouched');
    const row = (await records()).find(item => item.request_id === second.requestId);
    assert.deepEqual([row.phase, row.destroy_started_by, row.destroyed_by, Number(row.destroyed_at)], ['destroyed', 'synthetic_operator', 'synthetic_operator', at]);
    for (const when of [at + 1, T0 + 41 * DAY]) {
      await assert.rejects(restore(second.artifact, when), { code: 'LIFECYCLE_KEYS_DESTROYED' });
      await assert.rejects(restore(first.artifact, when), { code: 'LIFECYCLE_KEYS_DESTROYED' });
    }
    assert.equal(await count('secret_records', A), 0);
    // Cryptographic erasure: the retained artifact's ciphertext no longer decrypts.
    await assert.rejects(decrypts(A, second.artifact.tables['secrets.secret_records'][0].ciphertext), { code: 'SECRETS_PROVIDER_REFUSED' });
    assert.deepEqual(await decrypts(B, foreignCipher), { tenant: B, id: 'vendor-cloud', data: 'synthetic-credential-b' });
    report('destroyed', { keysAfter: [404, 404], foreignKeys: [200, 200], restore: 'LIFECYCLE_KEYS_DESTROYED', artifactDecrypt: 'SECRETS_PROVIDER_REFUSED' });
  });

  it('the custodian credential cannot destroy a key outside its tenant inventory or policy', async function () {
    const custodian = createVaultTransitCustodian({ address: vault, getToken: async () => custodianToken, allowInsecureLoopback: true, keyAllowed: async () => true });
    await assert.rejects(custodian.destroy({ tenant: B, keys: [keysOf(B)[0]] }), { code: 'SECRETS_PROVIDER_REFUSED' });
    const fenced = createVaultTransitCustodian({ address: vault, getToken: async () => root, allowInsecureLoopback: true, keyAllowed: async () => false });
    await assert.rejects(fenced.destroy({ tenant: B, keys: [keysOf(B)[0]] }), { code: 'SECRETS_KEY_NOT_ADMITTED' });
    assert.deepEqual(await Promise.all(keysOf(B).map(keyStatus)), [200, 200]);
  });
});
