'use strict';

// Operator provisioning on actual PostgreSQL and Vault: inspection, refusal on
// partial failure and safe retry (decisions provisioning-split, operator-rest-api).
// Each partial failure is produced by the real dependency, not a hook: Vault
// refusing a key creation or an encryption by policy, Vault unreachable, a key
// of the wrong type, the admin role killed inside the provisioning transaction,
// two tenants racing for one alias, tenant rows with no registry entry, and a
// lock-key collision. After each: no registry entry and no provisioning row
// (never a half-admitted tenant), a stable code, an inspection that names the
// state, and a retry that converges where one is safe. Synthetic only.
// covers: lib/tenant-registry/provision.js, lib/tenant-registry/vault-keys.js, lib/tenant-registry/rest.js, lib/tenant-registry/openapi.json, lib/cli/commands/admin.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const registry = require('../lib/tenant-registry/postgres');
const rules = require('../lib/tenant-registry/rules');
const { createProvisioning } = require('../lib/tenant-registry/provision');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');

const ROOT = path.resolve(__dirname, '..');
const PURPOSES = Object.keys(rules.PURPOSES);
const RECORDS = ['registryKeys', 'legacyCredential', 'localDataKey', 'rootSecret', 'authorizationConfig', 'ownerPolicy', 'accessTenant', 'accessKeys', 'writeClock', 'lifecycleWindow',
  'activity', 'settings', 'operatorPolicy'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); server.on('error', reject); });
async function until (fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(50); }
}
function cli (args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/nightscout.js'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => { out.stdout += chunk; });
    child.stderr.on('data', chunk => { out.stderr += chunk; });
    child.once('exit', code => resolve({ ...out, code }));
  });
}

optInSuite(enabled(), 'disposable NS_TEST_POSTGRES_ADMIN_URI and NS_VAULT_DOCKER_TEST=1 (or NS_TEST_VAULT_ADDR)')('operator provisioning: inspect, partial failure and retry (actual PostgreSQL and Vault)', function () {
  this.timeout(180000);
  let lab, provisioning, prior, serial = 0;
  const spec = (extra = {}) => ({ id: randomUUID(), hosts: ['op' + (++serial) + '.example.test'], ...extra });
  const keyStates = (present, other = 'absent') => Object.fromEntries(PURPOSES.map(purpose => [purpose, present.includes(purpose) ? 'present' : other]));
  // A provisioning credential narrowed by a Vault policy (the real refusal).
  async function token (name, lines) {
    await lab.vaultRequest('sys/policies/acl/' + lab.mount + '_' + name, { policy: lines.join('\n') });
    return (await lab.vaultRequest('auth/token/create', { policies: [lab.mount + '_' + name], no_default_policy: true, ttl: '1h' })).auth.client_token;
  }
  const withToken = (value, extra = {}) => createProvisioning(lab.provisioningOptions({ vault: { address: lab.vault.address, mount: lab.mount, allowInsecureLoopback: true, timeoutMs: 5000,
    getToken: async () => value, ...extra } }));
  const nothingAdmitted = async id => {
    assert.deepEqual(await lab.rowsFor(id), {}, 'no row of any provisioning table');
    assert.equal(await provisioning.get(id), null, 'no registry entry');
  };

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

  it('PO_INSPECT: absent before, complete after; presence only, never the root secret or a key', async function () {
    const request = spec({ issueRootSecret: true });
    assert.deepEqual({ ...await provisioning.inspect(request.id) }, { id: request.id, provisioning: 'absent', action: 'provision', registry: { state: null, hosts: [] },
      records: { ...Object.fromEntries(RECORDS.map(name => [name, 'absent'])), checkpoints: { 'realtime-registry-lab': 'absent' } },
      vault: { status: 'read', keys: keyStates([]) }, findings: [] });
    const created = await provisioning.provision(request);
    assert.equal(created.outcome, 'created');
    const report = await provisioning.inspect(request.id);
    assert.deepEqual({ ...report }, { id: request.id, provisioning: 'complete', action: 'none', registry: { state: 'active', hosts: request.hosts },
      records: { ...Object.fromEntries(RECORDS.map(name => [name, 'present'])), checkpoints: { 'realtime-registry-lab': 'present' } },
      vault: { status: 'read', keys: keyStates(PURPOSES) }, findings: [] });
    const text = JSON.stringify(report);
    assert.ok(!text.includes(created.rootSecret), 'the root secret is not in an inspection');
    for (const row of (await lab.admin.query(`SELECT public_key FROM "${lab.namespaces.registry}".tenant_registry_keys WHERE tenant_id = $1`, [request.id])).rows) {
      assert.ok(!text.includes(row.public_key), 'no key material is in an inspection');
    }
    await assert.rejects(provisioning.inspect('not-a-uuid'), { code: 'TENANT_PROVISION_INVALID' });
  });

  // One Transit key per tenant (`data`); signing keys are derived (decision deployment-signing-secret).
  it('PO_VAULT_CREATE_REFUSED: Vault refuses the data key creation; nothing is admitted or left, the inspection says absent, a retry completes', async function () {
    const request = spec();
    const narrow = withToken(await token('readonly', [`path "${lab.mount}/keys/tenant-*" { capabilities = ["read"] }`]));
    try { assert.deepEqual(await narrow.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_VAULT_REFUSED' }); } finally { await narrow.close(); }
    await nothingAdmitted(request.id);
    const residue = await provisioning.inspect(request.id);
    assert.equal(residue.provisioning, 'absent'); assert.equal(residue.action, 'provision');
    assert.deepEqual(residue.vault.keys, keyStates([]));
    assert.deepEqual(residue.findings, []);
    assert.equal((await provisioning.provision(request)).outcome, 'created');
    assert.equal((await provisioning.inspect(request.id)).provisioning, 'complete');
  });

  it('PO_VAULT_ENCRYPT_REFUSED: Vault refuses the root-secret encryption inside the transaction; every row rolls back and a retry completes', async function () {
    const request = spec();
    const noEncrypt = withToken(await token('noencrypt', [`path "${lab.mount}/keys/tenant-*" { capabilities = ["create", "read", "update"] }`]));
    let refused;
    try { refused = await noEncrypt.provision(request); } finally { await noEncrypt.close(); }
    assert.equal(refused.outcome, 'refused'); assert.match(refused.code, /^TENANT_PROVISION_[A-Z_]+$/);
    await nothingAdmitted(request.id);
    const residue = await provisioning.inspect(request.id);
    assert.equal(residue.provisioning, 'residue'); assert.deepEqual(residue.vault.keys, keyStates(PURPOSES));
    assert.equal((await provisioning.provision(request)).outcome, 'created');
    assert.equal((await provisioning.inspect(request.id)).provisioning, 'complete');
  });

  it('PO_VAULT_UNAVAILABLE: an unreachable Vault refuses with a retryable code and admits nothing; the inspection is unverified, not a guess', async function () {
    const request = spec();
    const down = withToken('unused', { address: 'http://127.0.0.1:' + await freePort() + '/', timeoutMs: 1000 });
    try {
      assert.deepEqual(await down.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_VAULT_UNAVAILABLE' });
      const report = await down.inspect(request.id);
      assert.equal(report.provisioning, 'unverified'); assert.equal(report.action, 'inspect-again');
      assert.deepEqual(report.vault, { status: 'unavailable' }); assert.deepEqual(report.findings, ['vault:unavailable']);
    } finally { await down.close(); }
    await nothingAdmitted(request.id);
    assert.equal((await provisioning.inspect(request.id)).provisioning, 'absent');
    assert.equal((await provisioning.provision(request)).outcome, 'created');
  });

  it('PO_VAULT_KEY_MISMATCH: an existing key of the wrong type is never adopted; refused for an operator on every retry, nothing admitted', async function () {
    const request = spec();
    await lab.vaultRequest(lab.mount + '/keys/' + rules.vaultKey(request.id, 'data'), { type: 'ed25519' });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await provisioning.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_VAULT_KEY_MISMATCH' });
    }
    await nothingAdmitted(request.id);
    const report = await provisioning.inspect(request.id);
    assert.equal(report.provisioning, 'incomplete'); assert.equal(report.action, 'operator');
    assert.equal(report.vault.keys.data, 'mismatch'); assert.deepEqual(report.findings, ['vault:data:mismatch']);
  });

  it('PO_UNREGISTERED_ROWS: tenant rows with no registry entry are refused as incomplete (not as a retryable failure) and are left as found', async function () {
    const request = spec();
    await lab.admin.query(`INSERT INTO "${lab.namespaces.settings}".tenant_settings (tenant_id, version, values) VALUES ($1, 1, '{}'::jsonb)`, [request.id]);
    const planted = (await lab.admin.query(`SELECT xmin::text AS x FROM "${lab.namespaces.settings}".tenant_settings WHERE tenant_id = $1`, [request.id])).rows[0].x;
    assert.deepEqual(await provisioning.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_INCOMPLETE' });
    assert.deepEqual(await lab.rowsFor(request.id), { 'settings.tenant_settings': 1 });
    assert.equal((await lab.admin.query(`SELECT xmin::text AS x FROM "${lab.namespaces.settings}".tenant_settings WHERE tenant_id = $1`, [request.id])).rows[0].x, planted, 'the row is the one found, not rewritten');
    assert.equal(await provisioning.get(request.id), null);
    const report = await provisioning.inspect(request.id);
    assert.equal(report.provisioning, 'incomplete'); assert.equal(report.action, 'operator');
    assert.deepEqual(report.findings, ['record:settings:unregistered']);
    assert.deepEqual(report.vault.keys, keyStates([]), 'refused before any Vault key is created');
  });

  it('PO_LOCK_COLLISION: a lock key held by another tenant is a stable conflict, not a retryable failure; nothing admitted', async function () {
    const request = spec(), other = randomUUID();
    await lab.admin.query(`INSERT INTO "${lab.namespaces.control}".tenant_lifecycle_windows (tenant_id, lock_key, phase, generation) VALUES ($1, $2, 'active', 1)`, [other, rules.lockKey(request.id)]);
    try {
      assert.deepEqual(await provisioning.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_LOCK_COLLISION' });
      await nothingAdmitted(request.id);
    } finally { await lab.admin.query(`DELETE FROM "${lab.namespaces.control}".tenant_lifecycle_windows WHERE tenant_id = $1`, [other]); }
    assert.equal((await provisioning.provision(request)).outcome, 'created', 'the same request completes once the colliding window is gone');
  });

  it('PO_STORE_UNPREPARED: a registry function without its pinned search_path, or a missing table grant, is refused as an unprepared store (not a retryable failure); nothing admitted; completes once prepared', async function () {
    const request = spec(), touch = `"${lab.namespaces.registry}".tenant_registry_touch()`, settings = `"${lab.namespaces.settings}".tenant_settings`;
    await lab.admin.query(`ALTER FUNCTION ${touch} RESET search_path`);
    try {
      assert.deepEqual(await provisioning.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_STORE_UNPREPARED' });
      await nothingAdmitted(request.id);
    } finally { await lab.admin.query(`ALTER FUNCTION ${touch} SET search_path = "${lab.namespaces.registry}", pg_catalog`); }
    await lab.admin.query(`REVOKE INSERT ON ${settings} FROM "${lab.roles.provisioner}"`);
    try {
      assert.deepEqual(await provisioning.provision(request), { id: request.id, outcome: 'refused', code: 'TENANT_PROVISION_STORE_UNPREPARED' });
      await nothingAdmitted(request.id);
      await lab.admin.query(`REVOKE SELECT ON ${settings} FROM "${lab.roles.provisioner}"`);
      await assert.rejects(provisioning.inspect(request.id), { code: 'TENANT_PROVISION_STORE_UNPREPARED' });
    } finally { await lab.admin.query(`GRANT SELECT, INSERT ON ${settings} TO "${lab.roles.provisioner}"`); }
    assert.equal((await provisioning.provision(request)).outcome, 'created');
    assert.equal((await provisioning.inspect(request.id)).provisioning, 'complete');
  });

  it('PO_ALIAS_RACE: two tenants racing for one alias: exactly one is created, the other is refused with nothing admitted, and the alias resolves to the winner', async function () {
    const connection = await connect({ connectionString: lab.urls.api, max: 1 });
    try {
      const reader = registry.create({ connection, namespace: lab.namespaces.registry });
      for (let round = 0; round < 6; round++) {
        const host = 'race' + round + '.example.test', pair = [{ id: randomUUID(), hosts: [host] }, { id: randomUUID(), hosts: [host] }];
        const results = await Promise.all(pair.map(request => provisioning.provision(request)));
        assert.deepEqual(results.map(row => row.outcome).sort(), ['created', 'refused'], 'round ' + round);
        const loser = results.find(row => row.outcome === 'refused'), winner = results.find(row => row.outcome === 'created');
        assert.equal(loser.code, 'TENANT_PROVISION_CONFLICT');
        await nothingAdmitted(loser.id);
        assert.deepEqual({ ...await reader.lookup(host, 'alias') }, { tenant: winner.id, state: 'active' });
        assert.equal((await provisioning.inspect(winner.id)).provisioning, 'complete');
        assert.ok(['absent', 'residue'].includes((await provisioning.inspect(loser.id)).provisioning));
      }
    } finally { await connection.end(); }
  });

  it('PO_ALIAS_BATCH: an alias repeated inside a batch refuses the whole batch before any work; an alias held by an existing tenant refuses only that tenant', async function () {
    const a = spec(), b = { id: randomUUID(), hosts: a.hosts };
    await assert.rejects(provisioning.provisionBatch([a, b]), { code: 'TENANT_PROVISION_BATCH_DUPLICATE' });
    await nothingAdmitted(a.id); await nothingAdmitted(b.id);
    assert.deepEqual((await provisioning.inspect(a.id)).vault.keys, keyStates([]), 'no Vault key either');
    assert.equal((await provisioning.provision(a)).outcome, 'created');
    const fresh = spec();
    const results = await provisioning.provisionBatch([fresh, b]);
    assert.deepEqual(results.map(row => [row.outcome, row.code]), [['created', undefined], ['refused', 'TENANT_PROVISION_CONFLICT']]);
    assert.deepEqual((await provisioning.provisionBatch([fresh, a])).map(row => row.outcome), ['existing', 'existing']);
    await nothingAdmitted(b.id);
  });

  it('PO_INSPECT_INCOMPLETE: an admitted tenant missing a record or a Vault key is reported incomplete for an operator, naming what is missing', async function () {
    const request = spec(); assert.equal((await provisioning.provision(request)).outcome, 'created');
    await lab.admin.query(`DELETE FROM "${lab.namespaces.settings}".tenant_settings WHERE tenant_id = $1`, [request.id]);
    await lab.admin.query(`DELETE FROM "${lab.namespaces.legacy}".legacy_data_keys WHERE tenant_id = $1`, [request.id]);
    await lab.admin.query(`DELETE FROM "${lab.namespaces.access}".access_keys WHERE tenant_id = $1 AND kid = 'management-1'`, [request.id]);
    const name = rules.vaultKey(request.id, 'data');
    await lab.vaultRequest(lab.mount + '/keys/' + name + '/config', { deletion_allowed: true });
    await lab.vaultRequest(lab.mount + '/keys/' + name, undefined, 'DELETE');
    const before = await lab.rowsFor(request.id);
    const report = await provisioning.inspect(request.id);
    assert.equal(report.provisioning, 'incomplete'); assert.equal(report.action, 'operator');
    assert.deepEqual(report.findings, ['record:localDataKey:missing', 'record:accessKeys:partial', 'record:settings:missing', 'vault:data:missing']);
    assert.equal(report.records.localDataKey, 'absent');
    assert.equal(report.records.accessKeys, 'partial'); assert.equal(report.records.settings, 'absent'); assert.equal(report.vault.keys.data, 'absent');
    assert.deepEqual(await lab.rowsFor(request.id), before, 'inspection writes nothing');
    assert.equal(await lab.vaultRequest(lab.mount + '/keys/' + name), null, 'inspection creates no key');
  });

  describe('through the admin role (REST, CLI) and a killed process', function () {
    let dir, environment, port, base, role;
    async function start () {
      const child = spawn(process.execPath, [path.join(ROOT, 'bin/nightscout.js'), 'multitenant', 'admin'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, ADMIN_HOSTNAME: '127.0.0.1', ADMIN_PORT: String(port), ...environment } });
      role = { child, out: { stdout: '', stderr: '' } };
      child.stdout.on('data', chunk => { role.out.stdout += chunk; });
      child.stderr.on('data', chunk => { role.out.stderr += chunk; });
      await until(() => { if (child.exitCode !== null) throw new Error('admin role exited: ' + role.out.stderr); return /Listening for role admin/.test(role.out.stdout); }, 'the admin listener', 30000);
    }
    const request = async (method, route, body) => {
      const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    // The provisioning session stopped on a lock (this process's own provisioning pool is idle meanwhile).
    const blocked = async () => (await lab.admin.query("SELECT pid FROM pg_stat_activity WHERE application_name = 'nightscout-admin-provisioning' AND usename = $1 AND wait_event_type = 'Lock'",
      [lab.roles.provisioner])).rows[0]?.pid;
    const alive = async pid => (await lab.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rows.length === 1;

    before(async function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-operator-provision-'));
      environment = await lab.adminEnvironment(dir);
      port = await freePort(); base = 'http://127.0.0.1:' + port;
      await start();
    });
    after(async function () {
      if (role && role.child.exitCode === null && role.child.signalCode === null) { role.child.kill('SIGTERM'); await new Promise(resolve => role.child.once('exit', resolve)); }
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('PO_REST_INSPECT: GET /v1/tenants/{id}/provisioning answers 200 for a known and an unknown id, with stable problems; the description publishes it', async function () {
      const unknown = randomUUID();
      const absent = await request('GET', '/v1/tenants/' + unknown + '/provisioning');
      assert.equal(absent.status, 200); assert.equal(absent.body.provisioning, 'absent'); assert.equal(absent.body.action, 'provision');
      assert.equal((await request('GET', '/v1/tenants/' + unknown)).status, 404, 'the registry view of an unknown id is unchanged');
      const created = spec();
      assert.equal((await request('POST', '/v1/tenants', created)).status, 201);
      const complete = await request('GET', '/v1/tenants/' + created.id + '/provisioning');
      assert.equal(complete.status, 200); assert.equal(complete.body.provisioning, 'complete'); assert.deepEqual(complete.body.registry, { state: 'active', hosts: created.hosts });
      const invalid = await request('GET', '/v1/tenants/not-a-uuid/provisioning');
      assert.equal(invalid.status, 422); assert.equal(invalid.body.code, 'TENANT_PROVISION_INVALID');
      assert.equal((await request('POST', '/v1/tenants/' + unknown + '/provisioning', {})).body.code, 'METHOD_NOT_ALLOWED');
      const openapi = (await request('GET', '/v1/openapi.json')).body;
      assert.equal(openapi.paths['/v1/tenants/{id}/provisioning'].get.operationId, 'inspectTenantProvisioning');
      assert.deepEqual(openapi.components.schemas.ProvisioningInspection.properties.provisioning.enum, ['absent', 'residue', 'complete', 'incomplete', 'removed', 'unverified']);
    });

    it('PO_KILL: the admin role killed inside the provisioning transaction admits nothing; after a restart the operator inspects (residue) and retries to a complete tenant', async function () {
      const target = spec({ ref: 'kill-1' });
      // Hold the last table provisioning writes so its transaction stops there,
      // after the registry row and every other row are written and before COMMIT.
      const locker = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await locker.connect();
      let pending, session;
      try {
        await locker.query('BEGIN');
        await locker.query(`LOCK TABLE "${lab.namespaces.operatorPolicy}".tenant_operator_policy IN SHARE MODE`);
        pending = request('POST', '/v1/tenants', target).then(value => ({ value }), error => ({ error }));
        session = await until(blocked, 'the provisioning transaction to reach the held table');
        role.child.kill('SIGKILL');
        await new Promise(resolve => role.child.once('exit', resolve));
      } finally { await locker.query('ROLLBACK').catch(() => {}); await locker.end(); }
      assert.ok((await pending).error, 'the operator received no answer');
      await until(async () => !await alive(session), 'the killed role\'s provisioning session to end');
      await nothingAdmitted(target.id);
      await start();
      const before = await cli(['admin', 'inspect', '--id', target.id, '--url', base]);
      assert.equal(before.code, 1, before.stderr); assert.equal(before.stdout, target.id + ' residue provision\n');
      const residue = await request('GET', '/v1/tenants/' + target.id + '/provisioning');
      assert.deepEqual(residue.body.vault.keys, keyStates(PURPOSES)); assert.deepEqual(residue.body.registry, { state: null, hosts: [] });
      const retry = await cli(['admin', 'provision', '--id', target.id, '--host', target.hosts[0], '--ref', 'kill-1', '--url', base]);
      assert.equal(retry.code, 0, retry.stderr); assert.equal(retry.stdout, 'kill-1 ' + target.id + ' created\n');
      const after = await cli(['admin', 'inspect', '--id', target.id, '--url', base]);
      assert.equal(after.code, 0, after.stderr); assert.equal(after.stdout, target.id + ' complete none\n');
      const again = await cli(['admin', 'provision', '--id', target.id, '--host', target.hosts[0], '--ref', 'kill-1', '--url', base]);
      assert.equal(again.stdout, 'kill-1 ' + target.id + ' existing\n');
    });

    it('PO_CLI_INCOMPLETE: the CLI names an incomplete tenant\'s findings on one line, prints the whole inspection with --json, and exits 1', async function () {
      const target = spec();
      assert.equal((await request('POST', '/v1/tenants', target)).status, 201);
      await lab.admin.query(`DELETE FROM "${lab.namespaces.clock}".tenant_write_clock WHERE tenant_id = $1`, [target.id]);
      const line = await cli(['admin', 'inspect', '--id', target.id, '--url', base]);
      assert.equal(line.code, 1); assert.equal(line.stdout, target.id + ' incomplete operator record:writeClock:missing\n');
      const json = await cli(['admin', 'inspect', '--id', target.id, '--json', '--url', base]);
      assert.equal(json.code, 1); assert.deepEqual(JSON.parse(json.stdout), (await request('GET', '/v1/tenants/' + target.id + '/provisioning')).body);
      const retry = await cli(['admin', 'provision', '--id', target.id, '--host', target.hosts[0], '--url', base]);
      assert.equal(retry.code, 1); assert.match(retry.stdout, / refused TENANT_PROVISION_INCOMPLETE\n$/);
    });
  });
});
