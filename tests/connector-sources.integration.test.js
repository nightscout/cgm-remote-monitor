'use strict';

const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const sources = require('../lib/tenant-connector/postgres-sources');
const { optInSuite } = require('./support/opt-in');

optInSuite(enabled(), 'disposable NS_TEST_POSTGRES_ADMIN_URI and NS_VAULT_DOCKER_TEST=1')('durable connector source definitions and registry refresh (native PostgreSQL)', function () {
  this.timeout(120000);
  const A = randomUUID(), B = randomUUID();
  let lab, provisioning, writer, reader, writerURL, readerURL, view, previous, ns;
  const roles = [];
  const connector = n => ({ collections: ['entries'], sourceEndpoint: 'endpoint-' + n, sourceCredential: 'credential-' + n,
    sourceCredentialKind: 'token', writeCredential: 'write-' + n });
  async function role (kind) {
    const name = 'cs_' + kind + '_' + lab.id, password = randomBytes(16).toString('hex');
    await lab.admin.query(`CREATE ROLE "${name}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`); roles.push(name);
    const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = name; url.password = password;
    return { name, url: url.toString() };
  }
  before(async function () {
    previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); lab = await createLab();
    provisioning = require('../lib/tenant-registry/provision').createProvisioning(lab.provisioningOptions());
    for (const [id, host] of [[A, 'a.example.test'], [B, 'b.example.test']]) assert.equal((await provisioning.provision({ id, hosts: [host] })).outcome, 'created');
    ns = { settings: lab.namespaces.settings, registry: lab.namespaces.registry, secrets: lab.namespaces.secrets, control: lab.namespaces.control };
    writerURL = await role('writer'); readerURL = await role('reader');
    for (const sql of sources.grants({ namespaces: ns, writer: writerURL.name, reader: readerURL.name })) await lab.admin.query(sql);
    writer = await sources.create({ connectionString: writerURL.url, namespaces: ns, writer: true, operator: { principal: 'synthetic-operator', consumer: 'admin' } });
    reader = await sources.create({ connectionString: readerURL.url, namespaces: ns });
    // Provision encrypted tenant secret references, through the shipping secrets
    // component and Vault. The private fixture persists them as its owner.
    for (const tenant of [A, B]) {
      const provider = require('../lib/secrets/vault-transit').createVaultTransit({ ...lab.vault,
        encryptionKey: require('../lib/tenant-registry/rules').vaultKey(tenant, 'data'), signingKey: require('../lib/tenant-registry/rules').vaultKey(tenant, 'signing'), signingVersion: 1 });
      const secrets = require('../lib/secrets/component').createSecrets({ maxTokenLifetimeSeconds: 1, providerFor: async () => provider,
        authorize: async () => true, audit: async () => {}, store: { get: async () => null,
          insert: async row => lab.admin.query(`INSERT INTO "${ns.secrets}".secret_records (tenant_id,id,format,ciphertext) VALUES ($1,$2,$3,$4)`, [row.tenant, row.id, row.format, row.ciphertext]) } });
      for (const n of [1, 2]) for (const id of Object.values(connector(n)).filter(value => typeof value === 'string' && value !== 'token')) {
        await secrets.encrypt({ tenant, principal: 'synthetic', consumer: 'seed' }, id, Buffer.from('synthetic-value-' + id));
      }
    }
  });
  after(async function () {
    if (view) await view.close();
    if (writer) await writer.close(); if (reader) await reader.close(); if (provisioning) await provisioning.close();
    if (lab) {
      for (const name of roles) { await lab.admin.query(`DROP OWNED BY "${name}"`); await lab.admin.query(`DROP ROLE "${name}"`); }
      await lab.close();
    }
    scope.setTenancyMode(previous);
  });
  it('CS_CAS: creates, retries, updates and tombstones with generation CAS; stale updates refuse and no values leave the API shape', async function () {
    const input = { ifGeneration: 0, enabled: true, connector: connector(1) };
    const first = await writer.put(A, 'nightscout', input); assert.equal(first.outcome, 'created'); assert.equal(first.definition.generation, 1);
    assert.equal((await writer.put(A, 'nightscout', input)).outcome, 'existing');
    const next = { ifGeneration: 1, enabled: true, connector: connector(2) };
    assert.equal((await writer.put(A, 'nightscout', next)).definition.generation, 2);
    assert.equal((await writer.put(A, 'nightscout', next)).outcome, 'existing');
    await assert.rejects(writer.put(A, 'nightscout', input), { code: 'CONNECTOR_GENERATION_CONFLICT' });
    assert.equal((await writer.remove(A, 'nightscout', 2)).definition.generation, 3);
    assert.equal((await writer.remove(A, 'nightscout', 2)).outcome, 'existing');
    assert.equal((await reader.get(A, 'nightscout')).deleted, true);
    assert.equal((await reader.list(A, { activeOnly: true })).length, 0);
    assert.ok(!JSON.stringify(first).includes('synthetic-value-'));
  });
  it('CS_RLS: tenant-bound reads cannot see foreign rows, unbound SQL sees none; writer cannot read ciphertext; foreign references refuse', async function () {
    await writer.put(A, 'isolated', { ifGeneration: 0, enabled: true, connector: connector(1) });
    assert.equal(await reader.get(B, 'isolated'), null);
    const client = new Client({ connectionString: writerURL.url }); await client.connect();
    try {
      assert.equal((await client.query(`SELECT * FROM "${ns.settings}".tenant_connector_sources`)).rows.length, 0);
      await assert.rejects(client.query(`SELECT ciphertext FROM "${ns.secrets}".secret_records`), error => error.code === '42501');
      await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [B]);
      await assert.rejects(client.query(`INSERT INTO "${ns.settings}".tenant_connector_sources (tenant_id,source_id,generation,enabled,deleted,definition) VALUES ($1,'wrong',1,true,false,$2)`, [A, connector(1)]), error => error.code === '42501');
      await client.query('ROLLBACK');
    } finally { await client.end(); }
    await lab.admin.query(`DELETE FROM "${ns.secrets}".secret_records WHERE tenant_id=$1 AND id='endpoint-2'`, [B]);
    await assert.rejects(writer.put(B, 'foreign', { ifGeneration: 0, enabled: true, connector: connector(2) }), { code: 'CONNECTOR_SECRET_REFERENCE_REFUSED' });
  });
  it('CS_MAINTENANCE: config writes refuse during a real exclusive lock or suspended window and succeed afterwards', async function () {
    const lock = require('../lib/tenant-registry/rules').lockKey(A), operator = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await operator.connect();
    const input = { ifGeneration: 0, enabled: true, connector: connector(1) };
    try {
      await operator.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
      await assert.rejects(writer.put(A, 'maintenance', input), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      await operator.query('SELECT pg_advisory_unlock($1::bigint)', [lock]);
      await operator.query(`UPDATE "${ns.control}".tenant_lifecycle_windows SET phase='suspended',claim_id=$2,artifact_digest=$3 WHERE tenant_id=$1`, [A, randomUUID(), 'a'.repeat(64)]);
      await assert.rejects(writer.put(A, 'maintenance', input), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      await operator.query(`UPDATE "${ns.control}".tenant_lifecycle_windows SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id=$1`, [A]);
      assert.equal((await writer.put(A, 'maintenance', input)).outcome, 'created');
    } finally { await operator.end(); }
  });
  it('CS_REFRESH: registry revisions refresh multiple sources, destination alias is tenant-bound, unchanged polls issue no source enumeration, deletion removes the assignment', async function () {
    await writer.put(A, 'refresh-existing', { ifGeneration: 0, enabled: true, connector: connector(1) });
    const config = { maxTenants: 10000, maxSources: 10000, registry: { namespace: ns.registry, refreshMs: 500 },
      definitions: { connectionString: readerURL.url, namespaces: ns }, registryVault: lab.vault };
    const registryModule = require('../lib/tenant-registry/postgres'), original = registryModule.create;
    let enumerations = 0;
    registryModule.create = options => { const store = original(options); return { ...store, enumerate: async (...args) => { enumerations++; return store.enumerate(...args); } }; };
    try { view = await require('../lib/tenant-connector/registry-view').open({ config, schedule: () => null, cancel: () => {} }); }
    finally { registryModule.create = original; }

    await writer.put(A, 'second', { ifGeneration: 0, enabled: true, connector: connector(1) });
    await view.refresh();
    const selected = view.current().get(A + '/second'); assert.ok(selected, 'changed definition becomes visible after the registry revision'); assert.equal(selected.id, A); assert.equal(selected.host, 'a.example.test');
    const before = view.current().get(A + '/refresh-existing'), count = enumerations; await view.refresh(); assert.equal(view.current().get(A + '/refresh-existing'), before);
    assert.equal(enumerations, count, 'CS_NORMAL_COST: unchanged revision does not enumerate tenants');
    assert.ok(view.stats().sources >= 2);
    await writer.remove(A, 'second', 1); await view.refresh(); assert.equal(view.current().has(A + '/second'), false);
    const client = new Client({ connectionString: readerURL.url }); await client.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
      await assert.rejects(client.query(`SELECT "${ns.registry}".tenant_registry_alias($1::uuid)`, [B]), error => error.code === '42501');
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  });
  it('CS_CENSUS: an open source metadata writer is exempt in the actual restore census; adding clock-write authority refuses, and restoration passes', async function () {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const ipc = require('../lib/server/internal-api/transport'), contracts = require('../lib/server/internal-api/contracts');
    const cohorts = require('../lib/server/serve/operation-cohort'), datastore = require('../lib/storage/postgres-datastore');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-census-')); fs.chmodSync(dir, 0o700);
    const endpoint = { socketPath: path.join(dir, 'peer.sock'), maxBytes: 100000, timeoutMs: 5000 };
    const namespaces = [ns.settings, ns.registry, ns.secrets, ns.control, lab.namespaces.clock].sort();
    const roles = ['api', 'evaluator', 'realtime', 'tenant-admin'].sort(), incarnation = randomUUID();
    const database = await datastore.read(lab.admin);
    const status = async request => ({ version: 1, participant: 'serving-reference', incarnation, namespace: ns.control, roles, tenants: [A, B].sort(), namespaces,
      identity: { namespaceOid: 1 }, datastore: database, request,
      // Synthetic peers report the other actual fixture backends. The source
      // writer is deliberately NOT a participant: its real grants determine exemption.
      backends: (await lab.admin.query("SELECT pid,usename AS role,extract(epoch from backend_start)::text AS birth FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND backend_type='client backend' AND usename<>$1", [writerURL.name])).rows });
    let server, cohort, pin;
    try {
      await writer.get(A, 'isolated'); // hold its real pool/backend open throughout preflight
      server = await ipc.open(endpoint, contracts.lifecycleParticipant, () => ({ getStatus: async (context, body) => status(body.request),
        invalidateTenant: async (context, body) => ({ ...await status(body.request), tenant: body.tenant }) }));
      cohort = await cohorts.createRemote({ namespace: ns.control, tenants: [A, B], participants: [{ id: 'serving-reference', roles, namespaces, endpoint }] });
      pin = await cohorts.pin(cohort, A, { client: lab.admin });
      const before = await cohorts.assertComplete(cohort, A, { client: lab.admin }); assert.ok(before.exempt >= 1);
      await lab.admin.query(`GRANT USAGE ON SCHEMA "${lab.namespaces.clock}" TO "${writerURL.name}"`);
      await lab.admin.query(`GRANT UPDATE (last_stamp) ON "${lab.namespaces.clock}".tenant_write_clock TO "${writerURL.name}"`);
      await assert.rejects(cohorts.assertComplete(cohort, A, { client: lab.admin }), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' });
      await lab.admin.query(`REVOKE UPDATE (last_stamp) ON "${lab.namespaces.clock}".tenant_write_clock FROM "${writerURL.name}"`);
      assert.ok((await cohorts.assertComplete(cohort, A, { client: lab.admin })).exempt >= 1);
    } finally {
      if (pin) await cohorts.releasePin(pin); if (cohort) await cohort.close(); if (server) await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('CS_ADMIN: real admin composition exposes only the versioned source resource with stable errors and generation metadata', async function () {
    const http = require('node:http');
    const context = await require('../lib/server/serve/admin-preview').boot({ maxBytes: 65536, timeoutMs: 5000,
      connectorSources: { connectionString: writerURL.url, namespaces: ns, operator: { principal: 'synthetic-operator', consumer: 'admin' } } });
    const server = http.createServer(context.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/v1/tenants/' + B + '/connector-sources/nightscout';
    try {
      const first = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifGeneration: 0, enabled: true, connector: connector(1) }) });
      assert.equal(first.status, 201); const body = await first.json(); assert.equal(body.definition.generation, 1);
      assert.ok(!JSON.stringify(body).includes('synthetic-value-'));
      const stale = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifGeneration: 0, enabled: false, connector: connector(1) }) });
      assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'CONNECTOR_GENERATION_CONFLICT');
    } finally { await new Promise(resolve => server.close(resolve)); await context.close(); }
  });

  it('CS_HISTORY_RLS: disabling forced row security on the history table refuses a new writer, then restored policy accepts it', async function () {
    await lab.admin.query(`ALTER TABLE "${ns.settings}".tenant_connector_source_history NO FORCE ROW LEVEL SECURITY`);
    try { await assert.rejects(sources.create({ connectionString: writerURL.url, namespaces: ns, writer: true,
      operator: { principal: 'synthetic-operator', consumer: 'admin' } }), { code: 'CONNECTOR_DEFINITION_UNSAFE' }); }
    finally { await lab.admin.query(`ALTER TABLE "${ns.settings}".tenant_connector_source_history FORCE ROW LEVEL SECURITY`); }
    const restored = await sources.create({ connectionString: writerURL.url, namespaces: ns, writer: true, operator: { principal: 'synthetic-operator', consumer: 'admin' } });
    await restored.close();
  });

  it('CS_ALIAS_BODY: a changed alias definer body is refused before its answer is used, then the exact restored function passes', async function () {
    const module = require('../lib/tenant-registry/postgres'), connect = require('../lib/storage/postgres-connection');
    const connection = await connect({ connectionString: readerURL.url, max: 1 });
    const registry = module.create({ connection, namespace: ns.registry });
    const original = module.catalogue.migrations.flatMap(row => row.up).find(sql => sql.startsWith('CREATE FUNCTION tenant_registry_alias('));
    const rewritten = original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace(/AS \$fn\$[\s\S]*\$fn\$$/, "AS $fn$BEGIN RETURN 'foreign.example.test'; END$fn$");
    const apply = async sql => { await lab.admin.query('SET search_path="' + ns.registry + '",pg_catalog'); await lab.admin.query(sql); };
    try {
      await apply(rewritten); await assert.rejects(registry.alias(A), { code: 'TENANT_REGISTRY_FUNCTION_UNSAFE' });
    } finally { await apply(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')); await connection.end(); }
    const restored = await connect({ connectionString: readerURL.url, max: 1 });
    try { assert.equal(await module.create({ connection: restored, namespace: ns.registry }).alias(A), 'a.example.test'); }
    finally { await restored.end(); }
  });

});
