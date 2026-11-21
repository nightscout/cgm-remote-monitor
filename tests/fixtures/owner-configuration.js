'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { createLab } = require('./tenant-registry-lab');
const scope = require('../../lib/storage/tenant-scope');
const settings = require('../../lib/server/serve/deployment-settings');
const { createProvisioning } = require('../../lib/tenant-registry/provision');
const SUBJECT = '000000000000000000000001';
const consumer = settings.IDENTITY.managementConsumer;
const random = () => crypto.randomBytes(8).toString('hex');

module.exports = function ownerConfigurationFixture () {
  const { tenants: [A, B], hosts, http: request } = require('./multitenant-preview-replicas')();
  const workers = [], ownerTokens = {}, credentials = {}, connections = {}, roles = {};
  let settingsTable, historyTable, policyTable, authorityTable, namespaces, lab, dir, scopeBefore, operator, ownership;
  let servingEnv;
  const host = id => hosts[id === A ? 0 : 1];
  const hash = text => crypto.createHash('sha1').update(text).digest('hex');
  function spawnRole (role, env) {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../bin/nightscout.js'), 'multitenant', role], {
      env: { PATH: process.env.PATH, NS_PG_PREFIX: lab.prefix, NS_SECRETS_DIR: dir, NS_VAULT_ADDR: lab.vault.address,
        NS_VAULT_ALLOW_INSECURE_LOOPBACK: 'true', NS_REGISTRY_REFRESH_MS: '250',
        // The issuing roles derive tenant signing keys from the deployment secret (decision deployment-signing-secret).
        ...require('./signing-secret').env(), ...env },
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const worker = { child, exit: null, stdout: '', stderr: '' };
    child.stdout.on('data', bytes => { worker.stdout += bytes; });
    child.stderr.on('data', bytes => { worker.stderr += bytes; });
    worker.exited = new Promise(resolve => child.once('exit', (code, signal) => { worker.exit = { code, signal }; resolve(worker.exit); }));
    workers.push(worker);
    return worker;
  }
  async function until (condition, description) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Timeout waiting for ' + description);
  }
  function port (worker, role) {
    if (worker.exit) throw new Error(role + ' exited before listening: ' + worker.stderr);
    const match = new RegExp('Listening for role ' + role + ' on 127[.]0[.]0[.]1:([0-9]+)').exec(worker.stdout);
    return match && Number(match[1]);
  }
  async function vaultToken (label, policy) {
    const name = lab.prefix + '_' + label;
    await lab.vaultRequest('sys/policies/acl/' + name, { policy });
    return (await lab.vaultRequest('auth/token/create', { policies: [name], no_default_policy: true, ttl: '30m' })).auth.client_token;
  }
  async function setup () {
    scopeBefore = scope.getTenancyMode(); scope.setTenancyMode('multi');
    lab = await createLab({ servingApi: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-configuration-'));
    namespaces = settings.layout({ NS_PG_PREFIX: lab.prefix }).namespaces;
    settingsTable = namespaces.display_settings + '.tenant_settings';
    historyTable = namespaces.display_settings + '.tenant_settings_history';
    policyTable = namespaces.operator_policy + '.tenant_operator_policy';
    authorityTable = namespaces.owner_configuration + '.tenant_owner_configuration_authority';
    Object.assign(roles, { settings: lab.roles.owner_settings, display: lab.roles.display_reader });
    Object.assign(connections, { settings: lab.urls.owner_settings, display: lab.urls.display_reader });
    const authorityOwner = lab.prefix + '_management_authority';
    await lab.admin.query('CREATE ROLE "' + authorityOwner + '" NOLOGIN NOSUPERUSER NOBYPASSRLS');
    // The function owner is a separate NOLOGIN identity, as in the deployment bootstrap.
    const ns = Object.fromEntries(['registry', 'access', 'authorization', 'control'].map(k => [k, namespaces[k]]));
    const grants = require('../../lib/management-sessions/authority').grants({ namespaces: ns, issuer: lab.roles.management_issuer, authorityOwner });
    for (const sql of [...grants.authorityOwner, ...grants.issuer]) await lab.admin.query(sql);
    // Signing keys are derived in process (decision deployment-signing-secret):
    // no role holds a Transit sign, HMAC or verify grant. The admin holds the
    // deployment's provisioner rule; the serving roles decrypt (and encrypt) data keys.
    const signer = await vaultToken('provisioner', ['path "' + lab.mount + '/keys/tenant-data-*" { capabilities=["create","read","update"] }',
      'path "' + lab.mount + '/encrypt/tenant-data-*" { capabilities=["update"] }'].join('\n'));
    const roleToken = await vaultToken('serving', ['decrypt/tenant-data-', 'encrypt/tenant-data-']
      .map(op => 'path "' + lab.mount + '/' + op + '*" { capabilities=["update"] }').join('\n'));
    servingEnv = { NS_VAULT_TOKEN: roleToken, NS_API_PG: lab.urls.api, NS_READINESS_PG: lab.urls.readiness,
      NS_API_ROOT_WRITER_PG: lab.urls.root_writer, NS_ALARM_PG: lab.urls.alarm, NS_DISPLAY_PG: lab.urls.display_reader,
      NS_OWNER_WRITER_PG: lab.urls.owner_writer, NS_OWNER_READER_PG: lab.urls.owner_reader,
      NS_OWNER_CREDENTIALS_PG: lab.urls.owner_credentials, NS_OWNER_SETTINGS_PG: lab.urls.owner_settings };
    operator = spawnRole('admin', { ADMIN_HOSTNAME: '127.0.0.1', ADMIN_PORT: '0', NS_OWNERSHIP_PG: lab.urls.ownership_operator,
      NS_MANAGEMENT_SESSIONS_PG: lab.urls.management_issuer, NS_VAULT_TOKEN: signer });
    await until(() => (operator.port = port(operator, 'admin')), 'private admin');
    ownership = require('../../lib/server/internal-api/clients').ownershipOperations({
      url: 'http://127.0.0.1:' + operator.port + '/', trust: 'network', maxBytes: 1048576, timeoutMs: 10000 });
    const provisioning = createProvisioning(lab.provisioningOptions());
    try {
      for (const id of [A, B]) {
        const provisioned = await provisioning.provision({ id, hosts: [host(id)], issueRootSecret: true });
        const root = provisioned.rootSecret;
        await lab.admin.query('INSERT INTO ' + ns.authorization + '.tenant_authorization_subjects(tenant_id,subject_id,display_name) VALUES($1,$2,$3)', [id,SUBJECT,'Owner']);
        await lab.admin.query('INSERT INTO ' + ns.authorization + ".tenant_authorization_roles VALUES($1,'viewer',ARRAY['*'])", [id]);
        await lab.admin.query('INSERT INTO ' + ns.authorization + ".tenant_authorization_subject_roles VALUES($1,$2,'viewer')", [id,SUBJECT]);
        const prefix = 'viewer', material = require('../../lib/secrets/legacy-verifiers').prepare(Buffer.from(root), [{ subjectId: SUBJECT, tokenPrefix: prefix }]);
        await lab.admin.query('INSERT INTO ' + namespaces.legacy + '.legacy_credential_subjects(tenant_id,subject_id,token_prefix,verifier_token_prefix,verifiers) VALUES ($1,$2,$3,$3,$4)',
          [id, SUBJECT, prefix, material.subjects[0].verifiers]);
        credentials[id] = prefix + '-' + hash(hash(root) + SUBJECT).slice(0,16);
        assert.equal((await ownership.addOwner({ tenant: id, owner: { principal: SUBJECT, consumer }, expectedOwners: [], delegable: ['*'] })).outcome, 'applied');
        assert.deepEqual((await lab.admin.query('SELECT active,can_configure FROM ' + authorityTable +
          ' WHERE tenant_id=$1 AND principal=$2 AND consumer=$3', [id, SUBJECT, consumer])).rows, [{ active: true, can_configure: true }]);
        const requestId = crypto.randomUUID();
        const result = await request(operator, id, 'POST', '/v1/tenants/' + id + '/management-sessions', undefined, { subjectId: SUBJECT, requestId }, { 'idempotency-key': requestId });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        ownerTokens[id] = result.body.token;
      }
    } finally { await provisioning.close(); }
  }
  async function token (tenant = A, overrides) {
    if (!overrides) return ownerTokens[tenant];
    const [hdr, payload] = ownerTokens[tenant].split('.');
    const claims = { ...JSON.parse(Buffer.from(payload, 'base64url')), ...overrides };
    const input = hdr + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url');
    // The tenant's derived management key (decision deployment-signing-secret); no Transit sign key exists.
    return input + '.' + require('./signing-secret').signing.key(tenant, 'management', 1).sign(Buffer.from(input)).toString('base64url');
  }
  async function start ({ extra = {}, refused = false } = {}) {
    const queryAudit = path.join(dir, random() + '.json');
    const worker = spawnRole('tenant-admin,api', { ...servingEnv, TENANT_ADMIN_HOSTNAME: '127.0.0.1', TENANT_ADMIN_PORT: '0',
      API_HOSTNAME: '127.0.0.1', API_PORT: '0', NS_SERVE_INTERNAL_SOCKET: path.join(dir, random() + '.sock'),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'owner-configuration-controls.js'), NS_OWNER_CONFIGURATION_QUERY_AUDIT: queryAudit,
      ...(process.env.NS_OWNER_CONFIGURATION_CONTROL ? { NS_OWNER_CONFIGURATION_CONTROL: process.env.NS_OWNER_CONFIGURATION_CONTROL } : {}), ...extra });
    worker.queryAudit = queryAudit;
    if (refused) {
      await until(() => worker.exit || /Listening/.test(worker.stdout), 'unsafe owner role refusal');
      assert.doesNotMatch(worker.stdout, /Listening/);
      assert.equal(worker.exit.code, 1);
    } else {
      await until(() => (worker.ownerPort = port(worker, 'tenant-admin')) && (worker.port = port(worker, 'api')), 'owner and DATA listeners');
    }
    return worker;
  }
  async function stop (worker) {
    if (!worker.exit) worker.child.kill('SIGTERM');
    await worker.exited;
    if (worker.queryAudit) assert.equal(JSON.parse(fs.readFileSync(worker.queryAudit)).ddl, 0);
  }
  const exchange = (worker, tenant) => request(worker, tenant, 'GET', '/api/v2/authorization/request/' + credentials[tenant]);
  async function localToken (tenant) {
    const result = await exchange(workers.find(w => w.port && w.ownerPort && !w.exit), tenant);
    assert.equal(result.status, 200);
    return result.body.token;
  }
  const data = { http: request, localToken, exchange, until, get admin () { return lab?.admin; } };
  const http = (worker, ...args) => request({ port: worker.ownerPort }, ...args);
  async function reset () {
    for (const table of [historyTable, settingsTable, policyTable, authorityTable]) await lab.admin.query('DELETE FROM ' + table);
    for (const tenant of [A, B]) {
      await lab.admin.query(`INSERT INTO ${settingsTable} VALUES($1,1,'{}')`, [tenant]);
      await lab.admin.query(`INSERT INTO ${historyTable}(tenant_id,version,values,principal,consumer,operation,event_time)
        VALUES($1,1,'{}','operator','provisioning','replace',$2)`, [tenant, Date.now()]);
      await lab.admin.query(`INSERT INTO ${policyTable} VALUES($1,1,$2,'operator','provisioning',$3)`,
        [tenant, { deployment: {}, overrides: {} }, Date.now()]);
      await lab.admin.query(`INSERT INTO ${authorityTable}(tenant_id,principal,consumer,active,can_configure)
        VALUES($1,$2,$3,true,true)`, [tenant, SUBJECT, consumer]);
    }
  }
  async function state () {
    return { current: (await lab.admin.query(`SELECT tenant_id,version,values FROM ${settingsTable} ORDER BY tenant_id`)).rows,
      history: (await lab.admin.query(`SELECT tenant_id,version,values,principal,consumer,operation,restored_from FROM ${historyTable}
        ORDER BY tenant_id,version`)).rows };
  }
  async function configure (tenant, active, enabled = active) {
    await lab.admin.query(`UPDATE ${authorityTable} SET active=$2,can_configure=$3 WHERE tenant_id=$1 AND principal=$4 AND consumer=$5`,
      [tenant, active, enabled, SUBJECT, consumer]);
  }
  async function policy (tenant, value, generation = 2) {
    await lab.admin.query(`UPDATE ${policyTable} SET policy=$2,generation=$3 WHERE tenant_id=$1`, [tenant, value, generation]);
  }
  function barrier (kind) {
    const file = path.join(dir, kind + '-' + random());
    return { file, arm () { fs.writeFileSync(file + '.armed', 'armed', { mode: 0o600 }); },
      release () { fs.writeFileSync(file, 'released', { mode: 0o600 }); } };
  }
  async function queryAs (kind, tenant, sql, parameters = []) {
    const client = new Client({ connectionString: connections[kind], connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      return await client.query(sql, parameters);
    } finally { await client.query('ROLLBACK'); await client.end(); }
  }
  async function cleanup () {
    for (const w of workers) if (!w.exit) await stop(w);
    if (lab) {
      await lab.admin.query('DROP OWNED BY "' + lab.prefix + '_management_authority"').catch(() => {});
      await lab.admin.query('DROP ROLE IF EXISTS "' + lab.prefix + '_management_authority"').catch(() => {});
      await lab.close();
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    scope.setTenancyMode(scopeBefore);
  }
  return { setup, reset, start, stop, cleanup, http, state, configure, policy, barrier, token, data, queryAs, A, B, SUBJECT, consumer, roles,
    get ownership () { return ownership; }, get namespaces () { return namespaces; }, get settingsTable () { return settingsTable; },
    get historyTable () { return historyTable; }, get policyTable () { return policyTable; }, get authorityTable () { return authorityTable; } };
};
