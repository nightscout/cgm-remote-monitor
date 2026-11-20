'use strict';

// Decision provisioning-split on actual PostgreSQL and Vault: one idempotent
// provisioning library; a re-run gives the same state; a failure injected at
// any step leaves no partial tenant and a re-run converges; batches are
// bounded with one result per tenant. Synthetic tenants and hosts only.
// covers: lib/tenant-registry/provision.js, lib/tenant-registry/vault-keys.js
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const registry = require('../lib/tenant-registry/postgres');
const rules = require('../lib/tenant-registry/rules');
const { createProvisioning, provisionerGrants, MAX_BATCH } = require('../lib/tenant-registry/provision');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');

const STEPS = ['vault', 'database', 'registry', 'hosts', 'secret', 'authorization', 'access', 'clock', 'lifecycle', 'settings'];
// Every provisioning table, with the row count one tenant gets.
const COMPLETE = {
  'registry.tenant_registry': 1, 'registry.tenant_registry_changes': 1, 'registry.tenant_registry_hosts': 2, 'registry.tenant_registry_keys': 3,
  'legacy.legacy_credential_config': 1, 'legacy.legacy_data_keys': 1, 'secrets.secret_records': 1, 'secrets.secret_audit': 1,
  'authorization.tenant_authorization_config': 1, 'authorization.tenant_owner_policy': 1,
  'access.access_tenants': 1, 'access.access_keys': 3, 'clock.tenant_write_clock': 1, 'checkpoint.tenant_consumer_checkpoint': 1,
  'control.tenant_lifecycle_windows': 1, 'control.tenant_activity': 1, 'control.tenant_activity_audit': 1,
  'settings.tenant_settings': 1, 'settings.tenant_settings_history': 1, 'operatorPolicy.tenant_operator_policy': 1
};

optInSuite(enabled(), 'disposable NS_TEST_POSTGRES_ADMIN_URI and NS_VAULT_DOCKER_TEST=1 (or NS_TEST_VAULT_ADDR)')('tenant provisioning (actual PostgreSQL and Vault)', function () {
  this.timeout(180000);
  let lab, provisioning, prior;
  const spec = (n, extra = {}) => ({ id: randomUUID(), hosts: ['t' + n + '.example.test', 't' + n + '-alt.example.test'], ...extra });
  before(async function () {
    prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
    lab = await createLab();
    provisioning = createProvisioning(lab.provisioningOptions());
  });
  after(async function () {
    if (provisioning) await provisioning.close().catch(() => {});
    if (lab) await lab.close();
    scope.setTenancyMode(prior);
  });

  it('PV_CREATE: provisions every row, the one Vault key (data), the derived signing public keys, and the registry entry a serving identity can resolve', async function () {
    const request = spec(1, { ref: 'lab-1', issueRootSecret: true });
    const result = await provisioning.provision(request);
    assert.equal(result.outcome, 'created'); assert.equal(result.ref, 'lab-1');
    assert.match(result.rootSecret, /^[0-9a-f]{48}$/);
    assert.deepEqual(await lab.rowsFor(request.id), COMPLETE);
    assert.deepEqual(Object.keys(rules.PURPOSES), ['data']);
    assert.ok(await lab.vaultRequest(lab.mount + '/keys/' + rules.vaultKey(request.id, 'data')));
    // No Transit signing key exists for the tenant (decision deployment-signing-secret).
    for (const retired of ['signing', 'access', 'management', 'human-data', 'human-management']) {
      assert.equal(await lab.vaultRequest(lab.mount + '/keys/tenant-' + retired + '-' + request.id), null, retired);
    }
    // Public keys only, each this deployment's derivation at signing version 1.
    const signing = require('./fixtures/signing-secret').signing;
    const dataKeys = (await lab.admin.query(`SELECT kid, public_key, active, signing FROM "${lab.namespaces.legacy}".legacy_data_keys WHERE tenant_id = $1`, [request.id])).rows;
    assert.deepEqual(dataKeys, [{ kid: 'data-1', public_key: signing.key(request.id, 'data', 1).spki, active: true, signing: true }]);
    const window = (await lab.admin.query(`SELECT lock_key::text AS key FROM "${lab.namespaces.control}".tenant_lifecycle_windows WHERE tenant_id = $1`, [request.id])).rows[0];
    assert.equal(window.key, rules.lockKey(request.id));
    const connection = await connect({ connectionString: lab.urls.api, max: 1 });
    try {
      const reader = registry.create({ connection, namespace: lab.namespaces.registry });
      assert.deepEqual({ ...await reader.lookup('t1.example.test', 'alias') }, { tenant: request.id, state: 'active' });
      const entry = await reader.entry(request.id);
      assert.deepEqual(entry.keys.map(key => key.purpose + ':' + key.kid), ['human-data:human-data-1', 'human-management:human-management-1', 'management:management-1']);
      const signing = require('./fixtures/signing-secret').signing;
      for (const key of entry.keys) assert.equal(key.publicKey, signing.key(request.id, key.purpose, 1).raw, key.purpose);
    } finally { await connection.end(); }
    assert.deepEqual({ ...await provisioning.get(request.id) }, { id: request.id, state: 'active', signingVersion: 1, hosts: ['t1-alt.example.test', 't1.example.test'] });
  });

  it('reapplying registry or provisioning grants retires the old direct DELETE on registered keys', async function () {
    const { namespaces, roles, consumers, admin } = lab;
    const keys = '"' + namespaces.registry + '".tenant_registry_keys';
    const hosts = '"' + namespaces.registry + '".tenant_registry_hosts';
    const role = roles.provisioner;
    const privileges = async () => (await admin.query(
      "SELECT has_table_privilege($1,$2,'DELETE') AS key_delete, has_table_privilege($1,$2,'SELECT') AS key_read," +
      " has_table_privilege($1,$2,'INSERT') AS key_insert, has_table_privilege($1,$3,'DELETE') AS host_delete",
      [role, keys, hosts])).rows[0];
    for (const statements of [registry.grants({ namespace: namespaces.registry, provisioner: role }),
      provisionerGrants({ namespaces, role, checkpoints: consumers })]) {
      await admin.query('GRANT DELETE ON ' + keys + ' TO "' + role + '"');
      assert.equal((await privileges()).key_delete, true);
      for (const sql of statements) await admin.query(sql);
      assert.deepEqual(await privileges(), { key_delete: false, key_read: true, key_insert: true, host_delete: true });
    }
  });

  it('PV_LOCAL_AUTH: prepared Node keys and verifiers survive reader restart, enforce RLS and observe current revocations', async function () {
    const { createHash } = require('node:crypto');
    const createReader = require('../lib/secrets/legacy-postgres');
    const material = require('../lib/secrets/legacy-verifiers');
    const codec = require('../lib/tenant-authorization/legacy-data-token').create({ issuer: 'native-lab', audience: 'native-data' });
    const tenant = spec('local-auth', { issueRootSecret: true }), other = spec('local-other', { issueRootSecret: true });
    const root = await provisioning.provision(tenant); await provisioning.provision(other);
    const ns = lab.namespaces.legacy, who = '"' + lab.roles.api + '"';
    // Same SELECT-only contract as the selected API. No writer or owner membership.
    await lab.admin.query('GRANT USAGE ON SCHEMA "' + ns + '" TO ' + who);
    await lab.admin.query('GRANT SELECT ON "' + ns + '".legacy_credential_config,"' + ns + '".legacy_credential_subjects,"' + ns + '".legacy_data_keys TO ' + who);
    const subject = { subjectId: 'native-subject', tokenPrefix: 'native' };
    const prepared = material.prepare(Buffer.from(root.rootSecret), [subject]).subjects[0];
    await lab.admin.query('INSERT INTO "' + ns + '".legacy_credential_subjects (tenant_id,subject_id,token_prefix,verifiers,verifier_token_prefix) VALUES ($1,$2,$3,$4,$3)',
      [tenant.id, subject.subjectId, subject.tokenPrefix, prepared.verifiers]);
    const open = () => createReader({ connectionString: lab.urls.api, namespace: ns, localVerification: true });
    let reader = await open();
    const credentials = () => material.create({ read: reader.readVerification, verifyToken: codec.verify });
    try {
      const hash = createHash('sha1').update(root.rootSecret).digest('hex');
      assert.deepEqual(await credentials().verifyLegacyCredential({ tenant: tenant.id }, { apiSecret: hash }), { kind: 'root' });
      assert.equal(await credentials().verifyLegacyCredential({ tenant: other.id }, { apiSecret: hash }), null);
      const metadata = await reader.readVerification(tenant.id), stored = await reader.signingKey(tenant.id);
      assert(metadata.keys.every(key => !Object.hasOwn(key, 'privateKey')));
      assert.deepEqual(Object.keys(stored).sort(), ['kid', 'publicKey']);
      const signing = require('./fixtures/signing-secret').signing.matching(tenant.id, 'data', stored);
      const principal = { kind: 'subject', subjectId: subject.subjectId, credentialVersion: 1, rootVersion: metadata.rootVersion };
      const issued = codec.issue(tenant.id, principal, signing).token;
      assert.deepEqual(await credentials().verifyLegacyCredential({ tenant: tenant.id }, { token: issued }, async () => true), principal);
      await reader.close(); reader = await open();
      assert.equal((await reader.signingKey(tenant.id)).kid, signing.kid);
      assert.deepEqual(await credentials().verifyLegacyCredential({ tenant: tenant.id }, { token: issued }, async () => true), principal);
      const api = await connect({ connectionString: lab.urls.api, max: 1 });
      try {
        const foreign = await api.withTenant(tenant.id, () => api.query('SELECT kid FROM "' + ns + '".legacy_data_keys WHERE tenant_id=$1', [other.id]));
        assert.equal(foreign.rows.length, 0);
        await assert.rejects(api.withTenant(tenant.id, () => api.query('UPDATE "' + ns + '".legacy_data_keys SET active=false,signing=false WHERE tenant_id=$1', [tenant.id])), { code: '42501' });
      } finally { await api.end(); }
      // Reuse the warmed signature proof while changing current authority.
      await lab.admin.query('UPDATE "' + ns + '".legacy_credential_subjects SET credential_version=credential_version+1 WHERE tenant_id=$1', [tenant.id]);
      assert.equal(await credentials().verifyLegacyCredential({ tenant: tenant.id }, { token: issued }, async () => true), null);
      await lab.admin.query('UPDATE "' + ns + '".legacy_credential_subjects SET credential_version=1 WHERE tenant_id=$1', [tenant.id]);
      await lab.admin.query('UPDATE "' + ns + '".legacy_data_keys SET signing=false,active=false WHERE tenant_id=$1', [tenant.id]);
      assert.equal(await credentials().verifyLegacyCredential({ tenant: tenant.id }, { token: issued }, async () => true), null);
    } finally { await reader.close(); }
  });

  it('PV_IDEMPOTENT: provisioning twice gives the same state; the second run writes nothing and returns no secret', async function () {
    const request = spec(2, { issueRootSecret: true });
    assert.equal((await provisioning.provision(request)).outcome, 'created');
    const first = await lab.rowsFor(request.id);
    const revision = (await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision;
    let vaultCalls = 0;
    const retry = createProvisioning(lab.provisioningOptions({ fetchImpl: async () => { vaultCalls++; throw Error('unexpected Vault call'); } }));
    let again;
    try { again = await retry.provision({ ...request, hosts: request.hosts.slice().reverse() }); }
    finally { await retry.close(); }
    assert.equal(vaultCalls, 0, 'a registered retry reads PostgreSQL only');
    assert.deepEqual(again, { id: request.id, outcome: 'existing' });
    assert.deepEqual(await lab.rowsFor(request.id), first);
    assert.equal((await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision, revision, 'nothing written');
  });

  it('refuses key birth while another operation holds the tenant lifecycle lock', async function () {
    const request = spec('held');
    const key = rules.lockKey(request.id);
    let calls = 0;
    const retry = createProvisioning(lab.provisioningOptions({ fetchImpl: async () => { calls++; throw Error('unexpected Vault call'); } }));
    await lab.admin.query('SELECT pg_advisory_lock_shared($1::bigint)', [key]);
    try {
      assert.deepEqual(await retry.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_BUSY' });
      assert.equal(calls, 0);
      assert.deepEqual(await lab.rowsFor(request.id), {});
    } finally {
      await lab.admin.query('SELECT pg_advisory_unlock_shared($1::bigint)', [key]);
      await retry.close();
    }
  });

  it('refuses an unregistered tenant with retained settings history before creating any key', async function () {
    const request = spec('history');
    await lab.admin.query('INSERT INTO "' + lab.namespaces.settings + '".tenant_settings_history' +
      " (tenant_id,version,values,principal,consumer,operation,event_time) VALUES ($1,1,'{}','operator','lab','replace',1)", [request.id]);
    let calls = 0;
    const retry = createProvisioning(lab.provisioningOptions({ fetchImpl: async () => { calls++; throw Error('unexpected Vault call'); } }));
    try {
      assert.deepEqual(await retry.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_INCOMPLETE' });
      assert.equal(calls, 0);
      assert.deepEqual(await lab.rowsFor(request.id), { 'settings.tenant_settings_history': 1 });
    } finally { await retry.close(); }
  });

  it('PV_CONFLICT: same id with other hosts, or a host bound to another tenant, is refused and writes nothing', async function () {
    const first = spec(3); await provisioning.provision(first);
    assert.deepEqual(await provisioning.provision({ ...first, hosts: ['t3.example.test'] }), { id: first.id, outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' });
    const other = { id: randomUUID(), hosts: ['t3.example.test'] };
    assert.deepEqual(await provisioning.provision(other), { id: other.id, outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' });
    assert.deepEqual(await lab.rowsFor(other.id), {});
    assert.equal((await provisioning.provision({ id: randomUUID(), hosts: ['bad host'] })).code, 'TENANT_PROVISION_HOST_INVALID');
    assert.equal((await provisioning.provision({ id: randomUUID(), hosts: ['t9.example.test:443'] })).code, 'TENANT_PROVISION_HOST_INVALID');
  });

  for (const at of STEPS) it('PV_PARTIAL_' + at.toUpperCase() + ': a failure injected at "' + at + '" leaves no partial tenant; a re-run converges to the complete state', async function () {
    const request = spec('p-' + at);
    const failing = createProvisioning(lab.provisioningOptions({ inject: async step => { if (step === at) throw Object.assign(new Error('injected'), { code: 'TENANT_PROVISION_INJECTED' }); } }));
    try {
      assert.deepEqual(await failing.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_INJECTED' });
    } finally { await failing.close(); }
    assert.deepEqual(await lab.rowsFor(request.id), {}, 'no row of any provisioning table');
    assert.equal(await provisioning.get(request.id), null);
    assert.equal((await provisioning.provision(request)).outcome, 'created');
    assert.deepEqual(await lab.rowsFor(request.id), COMPLETE);
  });

  // Decision one-call-usable-provisioning: a bootstrap block makes the tenant
  // usable on return, in the provisioning transaction.
  const BOOTSTRAP = () => ({ owner: { consumer: 'lab-owner', name: 'Synthetic lab owner' },
    subject: { name: 'Synthetic lab uploader', role: { name: 'lab', permissions: ['api:*:read', 'api:*:create,update,delete'] } } });
  const BOOTSTRAP_ROWS = { 'authorization.tenant_authorization_roles': 1, 'authorization.tenant_authorization_subjects': 2,
    'authorization.tenant_authorization_subject_roles': 1, 'authorization.tenant_owner_actors': 1, 'authorization.tenant_subject_admin_audit': 4,
    'legacy.legacy_credential_subjects': 2, 'ownerConfiguration.tenant_owner_configuration_authority': 1 };
  async function verifyAccessToken (tenant, token) {
    const ns = lab.namespaces.legacy, who = '"' + lab.roles.api + '"';
    await lab.admin.query('GRANT USAGE ON SCHEMA "' + ns + '" TO ' + who);
    await lab.admin.query('GRANT SELECT ON "' + ns + '".legacy_credential_config,"' + ns + '".legacy_credential_subjects,"' + ns + '".legacy_data_keys TO ' + who);
    const reader = await require('../lib/secrets/legacy-postgres')({ connectionString: lab.urls.api, namespace: ns, localVerification: true });
    try {
      const codec = require('../lib/tenant-authorization/legacy-data-token').create({ issuer: 'native-lab', audience: 'native-data' });
      return await require('../lib/secrets/legacy-verifiers').create({ read: reader.readVerification, verifyToken: codec.verify })
        .verifyLegacyCredential({ tenant }, { apiSecret: token });
    } finally { await reader.close(); }
  }

  // A data JWT as the api verifies it: local verifiers and the stored public key.
  async function verifyDataJwt (tenant, token) {
    const ns = lab.namespaces.legacy, who = '"' + lab.roles.api + '"';
    await lab.admin.query('GRANT USAGE ON SCHEMA "' + ns + '" TO ' + who);
    await lab.admin.query('GRANT SELECT ON "' + ns + '".legacy_credential_config,"' + ns + '".legacy_credential_subjects,"' + ns + '".legacy_data_keys TO ' + who);
    const reader = await require('../lib/secrets/legacy-postgres')({ connectionString: lab.urls.api, namespace: ns, localVerification: true });
    try {
      const codec = require('../lib/tenant-authorization/legacy-data-token').create(require('./fixtures/signing-secret').DATA_REALM);
      return await require('../lib/secrets/legacy-verifiers').create({ read: reader.readVerification, verifyToken: codec.verify })
        .verifyLegacyCredential({ tenant }, { token }, async () => true);
    } finally { await reader.close(); }
  }

  it('PV_BOOTSTRAP: one call writes the role, owner, subject and credential rows and returns a working subject access token', async function () {
    const request = spec('boot', { issueRootSecret: true, bootstrap: BOOTSTRAP() });
    const committed = [];
    const hooked = createProvisioning(lab.provisioningOptions({ afterCommit: tenant => committed.push(tenant) }));
    let result;
    try { result = await hooked.provision(request); await new Promise(resolve => setImmediate(resolve)); } finally { await hooked.close(); }
    assert.equal(result.outcome, 'created');
    assert.deepEqual(committed, [request.id], 'one post-commit call');
    assert.match(result.bootstrap.ownerSubject, /^[0-9a-f]{32}$/); assert.match(result.bootstrap.subject, /^[0-9a-f]{32}$/);
    assert.match(result.bootstrap.accessToken, /^syntheticl-[0-9a-f]{16}$/);
    assert.deepEqual(await lab.rowsFor(request.id), { ...COMPLETE, ...BOOTSTRAP_ROWS });
    // The data JWT is the one the api's exchange issues: it verifies locally for the subject.
    assert.equal(typeof result.bootstrap.jwt, 'string');
    assert.deepEqual(await verifyDataJwt(request.id, result.bootstrap.jwt), { kind: 'subject', subjectId: result.bootstrap.subject, credentialVersion: 1, rootVersion: 1 });
    assert.equal(JSON.parse(Buffer.from(result.bootstrap.jwt.split('.')[1], 'base64url')).exp, result.bootstrap.jwtExpiresAt);
    const principal = await verifyAccessToken(request.id, result.bootstrap.accessToken);
    assert.equal(principal.kind, 'subject'); assert.equal(principal.subjectId, result.bootstrap.subject);
    assert.equal(await verifyAccessToken(request.id, result.rootSecret.slice(0, 11) + '-0123456789abcdef'), null);
    const a = lab.namespaces.authorization;
    const owner = (await lab.admin.query(`SELECT a.principal, a.consumer, a.active, a.can_update, a.delegable, s.display_name FROM "${a}".tenant_owner_actors a
      JOIN "${a}".tenant_authorization_subjects s ON s.tenant_id = a.tenant_id AND s.subject_id = a.principal WHERE a.tenant_id = $1`, [request.id])).rows;
    assert.deepEqual(owner, [{ principal: result.bootstrap.ownerSubject, consumer: 'lab-owner', active: true, can_update: true, delegable: ['*'], display_name: 'Synthetic lab owner' }]);
    const links = (await lab.admin.query(`SELECT subject_id, role_name FROM "${a}".tenant_authorization_subject_roles WHERE tenant_id = $1`, [request.id])).rows;
    assert.deepEqual(links, [{ subject_id: result.bootstrap.subject, role_name: 'lab' }]);
    // Retry: the same ids and a fresh data JWT, no access token, nothing written, no post-commit call.
    const rows = await lab.rowsFor(request.id);
    const retry = createProvisioning(lab.provisioningOptions({ afterCommit: tenant => committed.push(tenant) }));
    try {
      const again = await retry.provision(request);
      assert.deepEqual({ ...again, bootstrap: { ...again.bootstrap, jwt: undefined, jwtExpiresAt: undefined } }, { id: request.id, outcome: 'existing',
        bootstrap: { ownerSubject: result.bootstrap.ownerSubject, subject: result.bootstrap.subject, jwt: undefined, jwtExpiresAt: undefined } });
      assert.deepEqual(await verifyDataJwt(request.id, again.bootstrap.jwt), { kind: 'subject', subjectId: result.bootstrap.subject, credentialVersion: 1, rootVersion: 1 });
    } finally { await retry.close(); }
    assert.deepEqual(await lab.rowsFor(request.id), rows);
    assert.deepEqual(committed, [request.id]);
  });

  it('PV_BOOTSTRAP_REFUSED: a malformed, out-of-catalogue or mismatched bootstrap writes nothing', async function () {
    const plainTenant = spec('boot-plain'); assert.equal((await provisioning.provision(plainTenant)).outcome, 'created');
    assert.deepEqual(await provisioning.provision({ ...plainTenant, bootstrap: BOOTSTRAP() }),
      { id: plainTenant.id, outcome: 'refused', code: 'TENANT_PROVISION_BOOTSTRAP_CONFLICT' });
    assert.deepEqual(await lab.rowsFor(plainTenant.id), COMPLETE);
    const bad = spec('boot-bad', { bootstrap: { owner: { consumer: 'lab-owner' }, subject: { name: 'x', role: { name: 'bad name', permissions: [] } } } });
    assert.equal((await provisioning.provision(bad)).code, 'TENANT_PROVISION_BOOTSTRAP_INVALID');
    assert.deepEqual(await lab.rowsFor(bad.id), {});
    const narrow = createProvisioning(lab.provisioningOptions({ ownerCatalogue: ['api:*:read'] }));
    const wide = spec('boot-wide', { bootstrap: BOOTSTRAP() });
    try { assert.deepEqual(await narrow.provision(wide), { id: wide.id, outcome: 'refused', code: 'TENANT_PROVISION_BOOTSTRAP_FORBIDDEN' }); }
    finally { await narrow.close(); }
    assert.deepEqual(await lab.rowsFor(wide.id), {});
  });

  it('PV_PARTIAL_BOOTSTRAP: a failure after the bootstrap rows leaves no partial tenant; a re-run converges', async function () {
    const request = spec('p-bootstrap', { bootstrap: BOOTSTRAP() });
    const failing = createProvisioning(lab.provisioningOptions({ inject: async step => { if (step === 'bootstrap') throw Object.assign(new Error('injected'), { code: 'TENANT_PROVISION_INJECTED' }); } }));
    try { assert.deepEqual(await failing.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_INJECTED' }); }
    finally { await failing.close(); }
    assert.deepEqual(await lab.rowsFor(request.id), {});
    const created = await provisioning.provision(request);
    assert.equal(created.outcome, 'created'); assert.ok(created.bootstrap.accessToken);
    assert.deepEqual(await lab.rowsFor(request.id), { ...COMPLETE, ...BOOTSTRAP_ROWS });
  });

  it('PV_BATCH: one result per tenant in request order; a retried batch is all "existing"; bounded at ' + MAX_BATCH, async function () {
    const requests = Array.from({ length: 6 }, (_, i) => spec('b' + i, { ref: 'batch-' + i }));
    requests.splice(3, 0, { id: 'not-a-uuid', hosts: ['x.example.test'], ref: 'bad' });
    const results = await provisioning.provisionBatch(requests);
    assert.deepEqual(results.map(row => row.ref), requests.map(row => row.ref));
    assert.deepEqual(results.map(row => row.outcome), ['created', 'created', 'created', 'refused', 'created', 'created', 'created']);
    const retried = await provisioning.provisionBatch(requests);
    assert.deepEqual(retried.map(row => row.outcome), ['existing', 'existing', 'existing', 'refused', 'existing', 'existing', 'existing']);
    await assert.rejects(provisioning.provisionBatch([requests[0], requests[0]]), { code: 'TENANT_PROVISION_BATCH_DUPLICATE' });
    await assert.rejects(provisioning.provisionBatch(Array.from({ length: MAX_BATCH + 1 }, (_, i) => spec('o' + i))), { code: 'TENANT_PROVISION_BATCH_INVALID' });
  });

  it('PV_CONCURRENT: the pre-key fence refuses overlapping work; retries converge without duplicate writes', async function () {
    const request = spec(4, { issueRootSecret: true });
    let entered, release, vaultSteps = 0;
    const atVault = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const concurrent = createProvisioning(lab.provisioningOptions({ inject: async step => {
      if (step === 'vault' && ++vaultSteps === 1) { entered(); await held; }
    } }));
    const first = concurrent.provision(request);
    try {
      await atVault;
      const refused = await Promise.all([concurrent.provision(request), concurrent.provision(request)]);
      for (const result of refused) {
        assert.deepEqual(result, { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_BUSY' });
      }
      assert.equal(vaultSteps, 1, 'only the fence owner reaches Vault');
      assert.deepEqual(await lab.rowsFor(request.id), {}, 'no database rows before the owner continues');
      release();
      assert.equal((await first).outcome, 'created');
      assert.deepEqual(await lab.rowsFor(request.id), COMPLETE);
      const revision = (await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision;
      for (let retry = 0; retry < refused.length; retry++) {
        assert.deepEqual(await concurrent.provision(request), { id: request.id, outcome: 'existing' });
      }
      assert.equal(vaultSteps, 1, 'idempotent retries do not dispatch key work or return another secret');
      assert.deepEqual(await lab.rowsFor(request.id), COMPLETE);
      assert.equal((await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision, revision);
    } finally {
      release();
      await first.catch(() => {});
      await concurrent.close();
    }
  });

  it('PV_SETTINGS: a provisioned tenant has a settings row and an operator policy row; the effective settings reader answers defaults', async function () {
    const request = spec(5); assert.equal((await provisioning.provision(request)).outcome, 'created');
    const name = 'trl_settings_reader_' + lab.id, password = randomUUID().replace(/-/g, '');
    await lab.admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    try {
      for (const ns of [lab.namespaces.settings, lab.namespaces.operatorPolicy]) {
        await lab.admin.query(`GRANT USAGE ON SCHEMA "${ns}" TO "${name}"`);
        await lab.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${ns}" TO "${name}"`);
      }
      const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = name; url.password = password;
      const reader = await require('../lib/tenant-settings/effective-postgres')({ connectionString: url.toString(),
        namespaces: { settings: lab.namespaces.settings, operatorPolicy: lab.namespaces.operatorPolicy } });
      try {
        const state = await reader.read(request.id);
        assert.equal(state.version, 1);
        assert.equal(state.effective.DISPLAY_UNITS.value, 'mg/dl', 'shipped default');
        await assert.rejects(reader.read(randomUUID()), { code: 'SETTINGS_POLICY_UNAVAILABLE' }, 'an unprovisioned tenant has no settings');
      } finally { await reader.close(); }
    } finally {
      await lab.admin.query(`DROP OWNED BY "${name}"`).catch(() => {});
      await lab.admin.query(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
    }
  });

  for (const [kind, table] of [['registry', 'tenant_registry_keys'], ['control', 'tenant_activity'], ['settings', 'tenant_settings'], ['checkpoint', 'tenant_consumer_checkpoint']]) {
    it('PV_EXISTING_COMPLETE_' + kind.toUpperCase() + ': an incomplete existing tenant is refused without recreating or changing it', async function () {
      const request = spec('partial-' + kind); assert.equal((await provisioning.provision(request)).outcome, 'created');
      if (kind === 'control') await lab.admin.query(`DELETE FROM "${lab.namespaces.control}".tenant_activity_audit WHERE tenant_id=$1`, [request.id]);
      await lab.admin.query(`DELETE FROM "${lab.namespaces[kind]}"."${table}" WHERE tenant_id=$1`, [request.id]);
      const before = await lab.rowsFor(request.id);
      const result = await provisioning.provision(request);
      assert.equal(result.outcome, 'refused'); assert.equal(result.code, 'TENANT_PROVISION_INCOMPLETE');
      assert.deepEqual(await lab.rowsFor(request.id), before, 'no automatic partial repair or secret replacement');
    });
  }

  // A deletion ceremony that has executed, written as the superuser with the
  // shapes lib/tenant-lifecycle/ceremony.js writes (synthetic).
  async function executedDeletion (tenant) {
    const request = randomUUID(), at = Date.now();
    await lab.admin.query(`INSERT INTO "${lab.namespaces.control}".tenant_lifecycle_requests (request_id, tenant_id, artifact_digest, phase, requested_at, executed_at)
      VALUES ($1, $2, $3, 'executed', $4, $4)`, [request, tenant, 'b'.repeat(64), at]);
    await lab.admin.query(`INSERT INTO "${lab.namespaces.control}".tenant_lifecycle_ceremony (request_id, tenant_id, phase, requested_by, requested_consumer,
      confirmed_by, confirmed_consumer, confirmed_at, claim_id, started_by, started_consumer, started_at, executed_by, executed_consumer, executed_at)
      VALUES ($1, $2, 'executed', 'owner', 'owner', 'op', 'admin', $3, $4, 'op', 'admin', $3, 'op', 'admin', $3)`, [request, tenant, at, randomUUID()]);
  }

  it('PV_REMOVE: removal is refused until the deletion ceremony has executed, then removes hosts, refuses lookups and re-provisioning, and is idempotent', async function () {
    const request = spec(6); assert.equal((await provisioning.provision(request)).outcome, 'created');
    assert.deepEqual(await provisioning.remove(request.id), { id: request.id, outcome: 'refused', code: 'TENANT_REMOVAL_REQUIRES_DELETION' });
    assert.equal((await provisioning.get(request.id)).state, 'active', 'a refused removal writes nothing');
    assert.deepEqual(await provisioning.remove(randomUUID()).then(row => row.code), 'TENANT_NOT_FOUND');
    await executedDeletion(request.id);
    const before = (await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision;
    assert.deepEqual(await provisioning.remove(request.id), { id: request.id, outcome: 'removed', state: 'removed' });
    assert.notEqual((await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision, before, 'the revision moved');
    assert.deepEqual({ ...await provisioning.get(request.id) }, { id: request.id, state: 'removed', signingVersion: 1, hosts: [] });
    const connection = await connect({ connectionString: lab.urls.api, max: 1 });
    try { assert.equal(await registry.create({ connection, namespace: lab.namespaces.registry }).lookup(request.hosts[0], 'alias'), null); }
    finally { await connection.end(); }
    assert.deepEqual(await provisioning.remove(request.id), { id: request.id, outcome: 'existing', state: 'removed' });
    assert.equal((await provisioning.provision(request)).code, 'TENANT_PROVISION_REMOVED');
  });

  for (const at of ['remove-check', 'remove-hosts', 'remove-state']) it('PV_REMOVE_PARTIAL_' + at.toUpperCase().replace(/-/g, '_') + ': a failure at "' + at + '" leaves the tenant active with its hosts', async function () {
    const request = spec('r-' + at); assert.equal((await provisioning.provision(request)).outcome, 'created');
    await executedDeletion(request.id);
    const failing = createProvisioning(lab.provisioningOptions({ inject: async step => { if (step === at) throw Object.assign(new Error('injected'), { code: 'TENANT_PROVISION_INJECTED' }); } }));
    try { await assert.rejects(failing.remove(request.id), { code: 'TENANT_PROVISION_INJECTED' }); } finally { await failing.close(); }
    assert.deepEqual({ ...await provisioning.get(request.id) }, { id: request.id, state: 'active', signingVersion: 1, hosts: request.hosts.slice().sort() });
    assert.equal((await provisioning.remove(request.id)).outcome, 'removed');
  });
});
