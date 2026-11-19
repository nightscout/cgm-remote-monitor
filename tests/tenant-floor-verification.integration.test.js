'use strict';
// Actual migrations, forced RLS, floor scans, recorded result and restore
// controller. Synthetic DATA replacement exercises the postcondition boundary;
// full logical artifact and client-history equivalence belong to their suites.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), vm = require('node:vm'), http = require('node:http');
const { createRequire } = require('node:module');
const { Client, Pool } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const platform = require('../lib/server/serve/platform-verification');
const floors = require('../lib/server/serve/tenant-floor-verification');
const migration = require('../lib/migrations/postgres');
const maintenance = require('../lib/tenant-lifecycle/maintenance-window');
const recovery = require('../lib/tenant-lifecycle/restore-resume');
const scopeFactory = require('../lib/tenant-lifecycle/generation-scope');
const source = require.resolve('../lib/server/serve/tenant-floor-verification');
const enabled = process.env.NS_TEST_POSTGRES_ADMIN_URI ? describe : describe.skip;
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const q = name => '"' + name + '"';
function controlled (before, after) {
  const text = fs.readFileSync(source, 'utf8'); assert(text.includes(before));
  const loaded = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + text.replace(before, after) + '\n})', { filename: source })(createRequire(source), loaded, loaded.exports);
  return loaded.exports;
}
function withoutFloorCheck () {
  return controlled("await require('./postgres-domains').checkTenantFloors(config, connection, tenant);", '/* deliberate control: floor validation removed */');
}
enabled('admin-owned tenant floor verification on native PostgreSQL', function () {
  this.timeout(60000);
  const prefix = 'floor_' + crypto.randomBytes(5).toString('hex');
  const roles = { api: prefix + '_api', vcpool: prefix + '_vcpool', writer: prefix + '_writer', operator: prefix + '_operator', provisioner: prefix + '_provisioner', owner: prefix + '_owner' };
  const namespaces = Object.fromEntries(['entries', 'clock', 'legacy', 'secrets', 'control', 'platform', 'registry', 'authorization', 'access', 'settings', 'operatorPolicy'].map(name => [name, prefix + '_' + name.toLowerCase()]));
  const locks = [{ tenant: A, key: String(10000000 + crypto.randomInt(1000000)) }, { tenant: B, key: String(12000000 + crypto.randomInt(1000000)) }];
  let admin, config, writerURI, apiURI, operatorURI, provisionerURI, window, apiPool, operatorPool, readerConnection, assertTenant, previousMode;
  const owned = [];
  const table = name => q(namespaces[name]) + '.' + (name === 'clock' ? 'tenant_write_clock' : name);
  const verify = (tenant, module = floors) => module.verifyTenant({ namespace: namespaces.platform, connectionString: writerURI,
    item: { role: 'api', config, operationConfig: { namespace: namespaces.control } }, tenant });
  const read = tenant => window.run(tenant, () => assertTenant(tenant));
  async function state (tenant) { return (await admin.query('SELECT status,generation::text FROM ' + q(namespaces.platform) + '.verified_tenant_floor WHERE tenant_id=$1', [tenant])).rows[0]; }
  async function current (tenant) { return (await admin.query('SELECT phase,generation::text,claim_id FROM ' + q(namespaces.control) + '.tenant_lifecycle_windows WHERE tenant_id=$1', [tenant])).rows[0]; }
  async function assertReplacementHeld (tenant) {
    assert.equal((await current(tenant)).phase, 'suspended');
    await admin.query('BEGIN');
    try {
      const key = locks.find(row => row.tenant === tenant).key;
      const row = (await admin.query('SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS held', [key])).rows[0];
      assert.equal(row.held, false, 'POSTCONDITION_MUST_RETAIN_EXCLUSIVE_REPLACEMENT_LOCK');
    } finally { await admin.query('ROLLBACK'); }
  }
  before(async function () {
    previousMode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const baseURI = process.env.NS_TEST_POSTGRES_ADMIN_URI, parsed = new URL(baseURI);
    assert.match(parsed.pathname, /test/i, 'Explicit disposable test database required');
    admin = new Client({ connectionString: baseURI }); await admin.connect();
    console.log('TENANT_FLOOR_NATIVE_DATABASE ' + (await admin.query('SELECT version() AS version')).rows[0].version);
    for (const [kind, role] of Object.entries(roles)) {
      const password = crypto.randomBytes(24).toString('hex');
      await admin.query('CREATE ROLE ' + q(role) + (kind === 'owner' ? ' NOLOGIN' : " LOGIN PASSWORD '" + password + "'") + ' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
      const url = new URL(baseURI); url.username = role; url.password = password;
      if (kind === 'api') apiURI = url.toString();
      if (kind === 'writer') writerURI = url.toString();
      if (kind === 'operator') operatorURI = url.toString();
      if (kind === 'provisioner') provisionerURI = url.toString();
    }
    const catalogues = { entries: require('../migrations/candidates/postgres-entries-v1.json'), clock: require('../migrations/candidates/postgres-write-clock-v1.json'),
      legacy: require('../lib/secrets/legacy-credentials-candidate.json'), secrets: require('../lib/secrets/postgres-candidate.json'), control: require('../lib/tenant-lifecycle/postgres-candidate.json'), registry: require('../lib/tenant-registry/postgres-candidate.json'),
      authorization: require('../lib/tenant-authorization/postgres-candidate.json'), access: require('../lib/tenant-authorization/access-candidate.json'),
      settings: require('../lib/tenant-settings/postgres-candidate.json'), operatorPolicy: require('../lib/operator-policy/postgres-candidate.json') };
    for (const [kind, catalogue] of Object.entries(catalogues)) {
      const namespace = namespaces[kind]; await admin.query('CREATE SCHEMA ' + q(namespace)); owned.push(namespace);
      await migration.run('up', { direct: true, connectionString: baseURI, namespace, catalogue });
      for (const { tablename } of (await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [namespace])).rows) await admin.query('ALTER TABLE ' + q(namespace) + '.' + q(tablename) + ' OWNER TO ' + q(roles.owner));
      for (const { signature } of (await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1', [namespace])).rows) await admin.query('ALTER FUNCTION ' + signature + ' OWNER TO ' + q(roles.owner));
      await admin.query('ALTER SCHEMA ' + q(namespace) + ' OWNER TO ' + q(roles.owner));
      await admin.query('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(roles.api));
    }
    await require('./fixtures/tenant-insertion-grants').grant(admin, { namespace: namespaces.entries, domain: 'entries', role: roles.api, catalogue: catalogues.entries });
    await admin.query('GRANT SELECT ON ' + table('clock') + ',' + q(namespaces.legacy) + '.legacy_credential_config,' + q(namespaces.secrets) + '.secret_records TO ' + q(roles.api));
    for (const name of ['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations']) await admin.query('GRANT SELECT ON ' + q(namespaces.control) + '.' + name + ' TO ' + q(roles.api));
    for (const sql of require('../lib/tenant-registry/postgres').grants({ namespace: namespaces.registry, provisioner: roles.provisioner })) await admin.query(sql);
    for (const sql of require('../lib/tenant-registry/provision').provisionerGrants({ namespaces, role: roles.provisioner })) await admin.query(sql);
    for (const sql of maintenance.operatorGrants({ namespace: namespaces.control, role: roles.operator })) await admin.query(sql);
    await admin.query('GRANT USAGE ON SCHEMA ' + q(namespaces.entries) + ',' + q(namespaces.clock) + ' TO ' + q(roles.operator));
    await require('./fixtures/tenant-insertion-grants').grant(admin, { namespace: namespaces.entries, domain: 'entries', role: roles.operator, catalogue: catalogues.entries, mode: 'restore' });
    await admin.query('GRANT UPDATE(last_stamp),SELECT ON ' + table('clock') + ' TO ' + q(roles.operator));
    for (const { tenant, key } of locks) {
      await admin.query('INSERT INTO ' + q(namespaces.control) + ".tenant_lifecycle_windows(tenant_id,lock_key,phase,generation) VALUES($1,$2,'active',1)", [tenant, key]);
      await admin.query('INSERT INTO ' + q(namespaces.control) + '.tenant_lifecycle_restore_authority(tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)', [tenant, roles.operator]);
      await admin.query('INSERT INTO ' + table('clock') + '(tenant_id,last_stamp) VALUES($1,100)', [tenant]);
      await require('./fixtures/tenant-insertion-grants').withTenant(admin, tenant, () => admin.query('INSERT INTO ' + table('entries') + '(tenant_id,id_kind,doc) VALUES($1,\'string\',$2)', [tenant, { _id: 'synthetic-entry', srvModified: 100, sgv: tenant === A ? 111 : 222 }]));
      await admin.query('INSERT INTO ' + q(namespaces.legacy) + '.legacy_credential_config(tenant_id,root_reference_id) VALUES($1,\'synthetic-root\')', [tenant]);
      await admin.query('INSERT INTO ' + q(namespaces.secrets) + '.secret_records(tenant_id,id,format,ciphertext) VALUES($1,\'synthetic-root\',1,\'synthetic-ciphertext\')', [tenant]);
    }
    // Start with the actual former installer shape, then execute the explicit
    // admin migration. No pre-created floor table can make this gate vacuous.
    const platformSource = require.resolve('../lib/server/serve/platform-verification');
    const legacy = { exports: {} }, text = fs.readFileSync(platformSource, 'utf8');
    const installation = "  await require('./tenant-floor-verification').install(client, { namespace, writer, readers });";
    assert(text.includes(installation));
    vm.runInThisContext('(function(require,module,exports){' + text.replace(installation, '').replace("'api','evaluator','realtime','vcpool'", "'api','evaluator','realtime'") + '\n})', { filename: platformSource })(createRequire(platformSource), legacy, legacy.exports);
    await legacy.exports.install(admin, { namespace: namespaces.platform, writer: roles.writer, readers: [roles.api] }); owned.push(namespaces.platform);
    assert.equal((await admin.query('SELECT to_regclass($1) AS relation', [namespaces.platform + '.verified_tenant_floor'])).rows[0].relation, null);
    const upgraded = await platform.upgrade(admin, { namespace: namespaces.platform, writer: roles.writer, readers: [roles.api, roles.vcpool] });
    assert.equal(upgraded.created, true); assert.equal(upgraded.status, 'revoked');
    assert.equal(String(upgraded.epoch), '2');
    // Existing v3 deployments admitted only three roles. Prove the upgraded
    // table accepts the joined vcpool certificate, as a fresh install does.
    await admin.query('INSERT INTO ' + q(namespaces.platform) + ".verified_role VALUES ('vcpool','revoked','','','','','','',NULL,NULL,2)");
    assert.equal((await admin.query("SELECT has_schema_privilege($1,$2,'USAGE') AND has_table_privilege($1,$3,'SELECT') AS readable",
      [roles.vcpool, namespaces.platform, namespaces.platform + '.verified_role'])).rows[0].readable, true);
    config = { connectionString: apiURI, domains: ['entries'], writeClock: true, namespaces: { entries: namespaces.entries, clock: namespaces.clock, legacy: namespaces.legacy, secrets: namespaces.secrets },
      bindings: new Map([[A, {}], [B, {}]]), platformVerification: { namespace: namespaces.platform, role: 'api' } };
    const digest = platform.contract(config, 'api');
    await admin.query('INSERT INTO ' + q(namespaces.platform) + ".verified_role SELECT 'api','verified',$1,d.oid::text,d.datname,pg_postmaster_start_time()::text,r.oid::text,r.rolname,clock_timestamp(),NULL,2 FROM pg_database d CROSS JOIN pg_roles r WHERE d.datname=current_database() AND r.rolname=$2", [digest, roles.api]);
    apiPool = new Pool({ connectionString: apiURI, max: 2 }); operatorPool = new Pool({ connectionString: operatorURI, max: 1 });
    window = scopeFactory.create({ namespace: namespaces.control, locks, pool: apiPool }); await window.ready();
    readerConnection = await connect({ connectionString: apiURI, operationWindow: window, max: 2 });
    assertTenant = floors.createReader({ config, connection: readerConnection, operationWindow: window });
    assert.equal((await migration.run('check', { direct: true, connectionString: baseURI, namespace: namespaces.entries, catalogue: catalogues.entries })).current, true);
    await verify(A); await verify(B);
  });
  after(async function () {
    await readerConnection?.end(); await window?.close(); await apiPool?.end(); await operatorPool?.end();
    if (admin) {
      for (const namespace of [...owned].reverse()) await admin.query('DROP SCHEMA ' + q(namespace) + ' CASCADE');
      for (const role of Object.values(roles)) await admin.query('DROP ROLE ' + q(role));
      await admin.end();
    }
    if (previousMode) scope.setTenancyMode(previousMode);
  });
  it('records migration postconditions and admits tenants with one indexed result read', async function () {
    assert.deepEqual(await state(A), { status: 'verified', generation: '1' });
    await read(A); await read(B);
    const rows = await window.run(A, () => readerConnection.withTenant(A, () => readerConnection.query('SELECT tenant_id::text FROM ' + q(namespaces.platform) + '.verified_tenant_floor')));
    assert.deepEqual(rows.rows.map(row => row.tenant_id), [A], 'RESULT_ROWS_KEEP_TENANT_ISOLATION');
    await assert.rejects(window.run(A, () => readerConnection.withTenant(A, () => readerConnection.query('UPDATE ' + q(namespaces.platform) + ".verified_tenant_floor SET status='verified'"))), error => error.code === '42501', 'API_CANNOT_WRITE_FLOOR_PROOF');
  });
  it('records the same native lifecycle selection in floor and serving proofs', async function () {
    const nativeSelection = require('../lib/tenant-lifecycle/native-selection').create({
      namespace: prefix + '_checkpoint', lifecycleNamespace: namespaces.control, consumer: 'evaluator-synthetic',
      generation: 'selected_generation', source: { system_id: '123456789', timeline: 1, database: 'synthetic', slot: 'synthetic_slot' }
    });
    const item = { role: 'api', config, operationConfig: { namespace: namespaces.control, nativeSelection } };
    async function check (module) {
      await module.verifyTenant({ namespace: namespaces.platform, connectionString: writerURI, item, tenant: A });
      const proof = await admin.query('SELECT contract_digest FROM ' + q(namespaces.platform) + '.verified_tenant_floor WHERE tenant_id=$1', [A]);
      assert.equal(proof.rows[0].contract_digest, platform.contract(config, 'api', nativeSelection.digest), 'FLOOR_MUST_BIND_SELECTED_GENERATION');
    }
    try {
      const omitted = controlled('(item.operationConfig?.nativeSelection ?? item.operationConfig?.intakeProfile)?.digest', 'item.operationConfig?.intakeProfile?.digest');
      await assert.rejects(check(omitted), /FLOOR_MUST_BIND_SELECTED_GENERATION/);
      await check(floors);
    } finally { await verify(A); }
  });
  it('detects a counter behind its DATA; control skipping the admin check goes red, then restores', async function () {
    const corrupt = () => admin.query('UPDATE ' + q(namespaces.entries) + '.tenant_insertion_ordinal SET last_ordinal=0 WHERE tenant_id=$1', [A]);
    const detection = async module => {
      await corrupt();
      await assert.rejects(verify(A, module), { code: 'TENANT_FLOOR_VERIFICATION_FAILED' }, 'ADMIN_MUST_DETECT_STALE_INSERTION_FLOOR');
      assert.equal((await state(A)).status, 'failed');
      await assert.rejects(read(A), { code: 'TENANT_FLOOR_VERIFICATION_REQUIRED' }, 'API_MUST_REFUSE_RECORDED_FAILURE');
      await read(B);
    };
    await detection(floors);
    await assert.rejects(detection(withoutFloorCheck()), /ADMIN_MUST_DETECT_STALE_INSERTION_FLOOR/);
    console.log('TENANT_FLOOR_CONTROL_RED ADMIN_MUST_DETECT_STALE_INSERTION_FLOOR');
    await detection(floors);
    await admin.query('UPDATE ' + q(namespaces.entries) + '.tenant_insertion_ordinal SET last_ordinal=1 WHERE tenant_id=$1', [A]);
    await verify(A); await read(A);
  });
  it('records a stale history floor without scanning from API admission; the other tenant continues', async function () {
    await admin.query('UPDATE ' + table('clock') + ' SET last_stamp=0 WHERE tenant_id=$1', [A]);
    await assert.rejects(verify(A), { code: 'TENANT_FLOOR_VERIFICATION_FAILED' });
    assert.equal((await state(A)).status, 'failed');
    await assert.rejects(read(A), { code: 'TENANT_FLOOR_VERIFICATION_REQUIRED' }); await read(B);
    await admin.query('UPDATE ' + table('clock') + ' SET last_stamp=100 WHERE tenant_id=$1', [A]);
    await verify(A); await read(A);
  });
  it('provisioning records its postcondition after releasing the tenant lock; retries preserve the service', async function () {
    // Real provisioner/SQL and HTTP transport; this fixture supplies a bounded
    // synthetic Transit protocol, not a real Vault acceptance claim.
    const keys = new Map(), token = crypto.randomBytes(24).toString('hex');
    const publicKey = () => Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
    const server = http.createServer(async (req, res) => {
      const route = req.url.split('/').slice(3), chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? undefined : JSON.stringify(value)); };
      if (req.headers['x-vault-token'] !== token) return send(403, {});
      if (route[0] === 'keys') {
        if (req.method === 'POST') { keys.set(route[1], { type: input.type, exportable: false, ...(input.type === 'ed25519' ? { keys: { 1: { public_key: publicKey() } } } : {}) }); return send(204); }
        return keys.has(route[1]) ? send(200, { data: keys.get(route[1]) }) : send(404, {});
      }
      if (route[0] === 'encrypt') return send(200, { data: { ciphertext: 'vault:v1:' + crypto.randomBytes(32).toString('base64') } });
      return send(404, {});
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let refuse = false, postconditions = 0; const stages = [];
    const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
    const provisioning = require('../lib/tenant-registry/provision').createProvisioning({ connectionString: provisionerURI, namespaces,
      actor: { principal: 'synthetic-operator', consumer: 'synthetic-admin' }, inject: async stage => stages.push(stage),
      vault: { address: 'http://127.0.0.1:' + server.address().port, mount: 'synthetic', allowInsecureLoopback: true, getToken: async () => token },
      postcondition: async tenant => { postconditions++; if (refuse) throw new Error('synthetic postcondition failure'); await verify(tenant); } });
    try {
      const first = await provisioning.provision({ id: C, hosts: ['synthetic-c.example.test'] });
      assert.equal(first.outcome, 'created', JSON.stringify({ result: first, stages })); assert.deepEqual(await state(C), { status: 'verified', generation: '1' });
      assert.equal(postconditions, 1, 'POSTCONDITION_MUST_COMPLETE_BEFORE_SUCCESS');
      assert.equal((await provisioning.provision({ id: C, hosts: ['synthetic-c.example.test'] })).outcome, 'existing');
      assert.equal(postconditions, 2);
      refuse = true;
      assert.deepEqual(await provisioning.provision({ id: D, hosts: ['synthetic-d.example.test'], issueRootSecret: true }), { id: D, outcome: 'refused', code: 'TENANT_PROVISION_POSTCONDITION_FAILED' });
      assert.equal(await state(D), undefined);
      refuse = false;
      assert.equal((await provisioning.provision({ id: D, hosts: ['synthetic-d.example.test'] })).outcome, 'existing');
      assert.deepEqual(await state(D), { status: 'verified', generation: '1' });
    } finally { await provisioning.close(); await new Promise(resolve => server.close(resolve)); }
  });
  it('refuses to publish a scan under a changed platform epoch; bypass control goes red and restores', async function () {
    const epochRace = async module => {
      const blocker = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await blocker.connect();
      let pending;
      const service = platform.create({ namespace: namespaces.platform, connectionString: writerURI,
        targets: [{ role: 'api', config, check: async () => { await verify(A); await verify(B); } }] });
      try {
        await blocker.query('BEGIN'); await blocker.query('LOCK TABLE ' + table('entries') + ' IN ACCESS EXCLUSIVE MODE');
        pending = verify(A, module);
        let blocked = false;
        for (const deadline = Date.now() + 3000; !blocked && Date.now() < deadline;) {
          blocked = (await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name='nightscout-admin-floor-data' AND wait_event_type='Lock' AND query LIKE $1", ['%' + namespaces.entries + '%'])).rows.length > 0;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'ACTUAL_ADMIN_FLOOR_SCAN_MUST_BE_HELD');
        await service.invalidate(); await blocker.query('COMMIT');
        await assert.rejects(pending, { code: 'TENANT_FLOOR_VERIFICATION_INVALIDATED' }, 'SCAN_MUST_NOT_INHERIT_NEW_PLATFORM_EPOCH');
        await assert.rejects(read(A), { code: 'TENANT_FLOOR_VERIFICATION_REQUIRED' });
      } finally {
        await blocker.query('ROLLBACK').catch(() => {}); await blocker.end();
        if (pending) await pending.catch(() => {});
        await service.verify(); await service.close();
      }
    };
    await epochRace(floors);
    const bypass = controlled('WHERE singleton AND epoch=$6 ON CONFLICT', 'WHERE singleton AND $6::bigint IS NOT NULL ON CONFLICT');
    await assert.rejects(epochRace(bypass), /SCAN_MUST_NOT_INHERIT_NEW_PLATFORM_EPOCH/);
    console.log('TENANT_FLOOR_EPOCH_CONTROL_RED SCAN_MUST_NOT_INHERIT_NEW_PLATFORM_EPOCH');
    await epochRace(floors); await read(A); await read(B);
  });
  it('admin verifies committed replacement before activation; a failed postcondition stays suspended until verified resume', async function () {
    const controller = maintenance.create({ namespace: namespaces.control, locks, pool: operatorPool, drainTimeoutMs: 1000 });
    try {
      await controller.withRestore(A, { artifactDigest: 'a'.repeat(64) }, async ({ connection }) => {
        await connection.query('UPDATE ' + table('entries') + " SET doc=jsonb_set(doc,'{sgv}','123') WHERE tenant_id=$1", [A]);
        connection.afterCommit(async () => { await assertReplacementHeld(A); await verify(A); await assertReplacementHeld(A); });
      });
      assert.deepEqual(await state(A), { status: 'verified', generation: '2' }); await read(A); await read(B);
      await assert.rejects(controller.withRestore(A, { artifactDigest: 'b'.repeat(64) }, async ({ connection }) => {
        await connection.query('UPDATE ' + table('clock') + ' SET last_stamp=0 WHERE tenant_id=$1', [A]);
        connection.afterCommit(() => verify(A));
      }), { code: 'TENANT_FLOOR_VERIFICATION_FAILED' });
      assert.equal((await current(A)).phase, 'suspended'); assert.equal((await state(A)).status, 'failed'); await read(B);
      let verified = false;
      const resume = recovery.create({ namespace: namespaces.control, locks, pool: operatorPool, beforeActivation: async tenant => {
        await assertReplacementHeld(tenant); await verify(tenant); await assertReplacementHeld(tenant); verified = true;
      } });
      try {
        const claim = (await current(A)).claim_id;
        let seen;
        for (const deadline = Date.now() + 3000; ;) { seen = await resume.inspect(A); if (seen.resumable || Date.now() >= deadline) break; await new Promise(resolve => setTimeout(resolve, 20)); }
        assert.equal(seen.resumable, true);
        await assert.rejects(resume.resume(A, { claimId: claim }), { code: 'TENANT_FLOOR_VERIFICATION_FAILED' });
        assert.equal(verified, false); assert.equal((await current(A)).phase, 'suspended'); await read(B);
        await admin.query('UPDATE ' + table('clock') + ' SET last_stamp=100 WHERE tenant_id=$1', [A]);
        await resume.resume(A, { claimId: claim }); assert.equal(verified, true);
      } finally { await resume.close(); }
      assert.deepEqual(await state(A), { status: 'verified', generation: '3' }); await read(A);
    } finally { await controller.close(); }
  });
});
