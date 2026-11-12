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
const { createProvisioning, MAX_BATCH } = require('../lib/tenant-registry/provision');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');

const STEPS = ['vault', 'database', 'registry', 'hosts', 'secret', 'authorization', 'access', 'clock', 'lifecycle', 'settings'];
// Every provisioning table, with the row count one tenant gets.
const COMPLETE = {
  'registry.tenant_registry': 1, 'registry.tenant_registry_hosts': 2, 'registry.tenant_registry_keys': 4,
  'legacy.legacy_credential_config': 1, 'secrets.secret_records': 1, 'secrets.secret_audit': 1,
  'authorization.tenant_authorization_config': 1, 'authorization.tenant_owner_policy': 1,
  'access.access_tenants': 1, 'access.access_keys': 4, 'clock.tenant_write_clock': 1, 'checkpoint.tenant_consumer_checkpoint': 1,
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

  it('PV_CREATE: provisions every row, the six Vault keys, and the registry entry a serving identity can resolve', async function () {
    const request = spec(1, { ref: 'lab-1', issueRootSecret: true });
    const result = await provisioning.provision(request);
    assert.equal(result.outcome, 'created'); assert.equal(result.ref, 'lab-1');
    assert.match(result.rootSecret, /^[0-9a-f]{48}$/);
    assert.deepEqual(await lab.rowsFor(request.id), COMPLETE);
    for (const purpose of Object.keys(rules.PURPOSES)) assert.ok(await lab.vaultRequest(lab.mount + '/keys/' + rules.vaultKey(request.id, purpose)), purpose);
    const window = (await lab.admin.query(`SELECT lock_key::text AS key FROM "${lab.namespaces.control}".tenant_lifecycle_windows WHERE tenant_id = $1`, [request.id])).rows[0];
    assert.equal(window.key, rules.lockKey(request.id));
    const connection = await connect({ connectionString: lab.urls.api, max: 1 });
    try {
      const reader = registry.create({ connection, namespace: lab.namespaces.registry });
      assert.deepEqual({ ...await reader.lookup('t1.example.test', 'alias') }, { tenant: request.id, state: 'active' });
      const entry = await reader.entry(request.id);
      assert.deepEqual(entry.keys.map(key => key.purpose + ':' + key.kid), ['access:key1', 'human-data:human-data-1', 'human-management:human-management-1', 'management:management1']);
    } finally { await connection.end(); }
    assert.deepEqual({ ...await provisioning.get(request.id) }, { id: request.id, state: 'active', signingVersion: 1, hosts: ['t1-alt.example.test', 't1.example.test'] });
  });

  it('PV_IDEMPOTENT: provisioning twice gives the same state; the second run writes nothing and returns no secret', async function () {
    const request = spec(2, { issueRootSecret: true });
    assert.equal((await provisioning.provision(request)).outcome, 'created');
    const first = await lab.rowsFor(request.id);
    const revision = (await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision;
    const again = await provisioning.provision({ ...request, hosts: request.hosts.slice().reverse() });
    assert.deepEqual(again, { id: request.id, outcome: 'existing' });
    assert.deepEqual(await lab.rowsFor(request.id), first);
    assert.equal((await lab.admin.query(`SELECT revision::text FROM "${lab.namespaces.registry}".tenant_registry_clock`)).rows[0].revision, revision, 'nothing written');
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

  it('PV_CONCURRENT: the same tenant provisioned concurrently is created once', async function () {
    const request = spec(4);
    const results = await Promise.all([provisioning.provision(request), provisioning.provision(request), provisioning.provision(request)]);
    assert.deepEqual(results.map(row => row.outcome).sort(), ['created', 'existing', 'existing']);
    assert.deepEqual(await lab.rowsFor(request.id), COMPLETE);
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
