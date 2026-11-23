'use strict';

// covers: lib/tenant-connector/postgres-sources.js, lib/server/serve/role-readiness.js, lib/tenant-registry/provision.js
// The vcpool connector on a native-selection deployment (the one supported lifecycle topology,
// decision legacy-topology-retirement): connector secrets enter through the provisioning library's
// write-only entry (decision connector-secret-entry-admin), connector definitions are written with
// the deployment's native selection, and the vcpool role's start check reads the control ledger as
// the native catalogue. Without the native selection both refuse, as they did at d0aa44d2ed.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const scope = require('../lib/storage/tenant-scope');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const sources = require('../lib/tenant-connector/postgres-sources');
const { optInSuite } = require('./support/opt-in');

optInSuite(enabled(), 'disposable NS_TEST_POSTGRES_ADMIN_URI and NS_VAULT_DOCKER_TEST=1')('vcpool on a native-selection deployment (native PostgreSQL)', function () {
  this.timeout(180000);
  const A = randomUUID();
  const REFS = { sourceEndpoint: 'connector-nightscout-endpoint', sourceCredential: 'connector-nightscout-source', writeCredential: 'connector-nightscout-write' };
  let lab, provisioning, previous, ns, native;
  before(async function () {
    previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    lab = await createLab({ servingApi: true });
    native = lab.layout.native;
    const n = lab.layout.namespaces;
    ns = { settings: n.display_settings, registry: n.registry, secrets: n.secrets, control: n.control };
    assert.equal(native.binding.lifecycleNamespace, ns.control);
    provisioning = require('../lib/tenant-registry/provision').createProvisioning(lab.provisioningOptions());
    assert.equal((await provisioning.provision({ id: A, hosts: ['vcpool-a.example.test'] })).outcome, 'created');
  });
  after(async function () {
    if (provisioning) await provisioning.close();
    if (lab) await lab.close();
    scope.setTenancyMode(previous);
  });

  it('VC_SECRET_ENTRY: write-only entry stores one record and one audit row; repeats, root and malformed refs refuse', async function () {
    for (const [field, ref] of Object.entries(REFS)) {
      const value = 'synthetic-' + field + '-value';
      const row = await provisioning.enterSecret(A, ref, value);
      assert.deepEqual({ ...row }, { id: A, ref, outcome: 'created' }, field);
      assert.ok(!JSON.stringify(row).includes(value), 'the value is never returned');
      const stored = (await lab.admin.query(`SELECT ciphertext FROM "${ns.secrets}".secret_records WHERE tenant_id=$1 AND id=$2`, [A, ref])).rows;
      assert.equal(stored.length, 1);
      assert.match(stored[0].ciphertext, /^vault:v\d+:/);
      assert.ok(!stored[0].ciphertext.includes(value));
      const audits = (await lab.admin.query(`SELECT operation, phase FROM "${ns.secrets}".secret_audit WHERE tenant_id=$1 AND secret_id=$2`, [A, ref])).rows;
      assert.deepEqual(audits, [{ operation: 'encrypt', phase: 'authorized' }]);
    }
    assert.equal((await provisioning.enterSecret(A, REFS.sourceEndpoint, 'another')).code, 'TENANT_SECRET_EXISTS');
    assert.equal((await provisioning.enterSecret(A, 'root', 'x')).code, 'TENANT_SECRET_INVALID');
    assert.equal((await provisioning.enterSecret(A, 'connector-x', '')).code, 'TENANT_SECRET_INVALID');
    assert.equal((await provisioning.enterSecret(randomUUID(), 'connector-x', 'x')).code, 'TENANT_NOT_FOUND');
    assert.equal(Number((await lab.admin.query(`SELECT count(*) FROM "${ns.secrets}".secret_audit WHERE tenant_id=$1 AND secret_id LIKE 'connector-%'`, [A])).rows[0].count), 3);
  });

  it('VC_DEFINITION_NATIVE: a definition PUT with the native selection is created; without it the window admission refuses', async function () {
    const definition = { ifGeneration: 0, enabled: true, connector: { collections: ['entries'], ...REFS, sourceCredentialKind: 'token' } };
    const operator = { principal: 'synthetic-operator', consumer: 'admin' };
    const plain = await sources.create({ connectionString: lab.urls.connector_writer, namespaces: ns, writer: true, operator });
    try { await assert.rejects(plain.put(A, 'nightscout', definition), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' }); } finally { await plain.close(); }
    const writer = await sources.create({ connectionString: lab.urls.connector_writer, namespaces: ns, writer: true, operator, nativeSelection: native });
    try {
      assert.equal((await writer.put(A, 'nightscout', definition)).outcome, 'created');
      assert.equal((await writer.remove(A, 'nightscout', 1)).outcome, 'deleted');
    } finally { await writer.close(); }
  });

  it('VC_READINESS_NATIVE: the vcpool start check admits the native control ledger and refuses it as the plain catalogue', async function () {
    const readiness = require('../lib/server/serve/role-readiness');
    const config = { secretsConnectionString: lab.urls.api, activity: { connectionString: lab.urls.activity_reader, namespace: ns.control } };
    await assert.rejects(readiness.admit(config, 'vcpool'), { code: 'MIG_UNKNOWN' });
    await readiness.admit({ ...config, nativeSelection: native }, 'vcpool');
  });
});
