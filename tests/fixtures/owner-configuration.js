'use strict';

// Synthetic operator provisioning around the existing unchanged actual CLI/
// PostgreSQL/Vault fixture. No provisioning runs until explicit setup().
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const { run } = require('../../lib/migrations/postgres');
const { catalogueDigest } = require('../../lib/subject-admin/owner-policy');
const SUBJECT = '000000000000000000000001';
const catalogue = ['api:entries:read', 'api:entries:create'];
const consumer = 'owner-configuration';
const random = () => crypto.randomBytes(12).toString('hex');

module.exports = function ownerConfigurationFixture () {
  const data = require('./multitenant-preview-replicas')();
  const [A, B] = data.tenants, workers = [];
  const suffix = crypto.randomBytes(6).toString('hex');
  const namespaces = { settings: 'owner_settings_' + suffix, operatorPolicy: 'operator_policy_' + suffix,
    authority: 'owner_configuration_' + suffix };
  const roles = Object.fromEntries(['writer', 'access', 'settings', 'display'].map(kind => [kind, 'owner_config_' + kind + '_' + suffix]));
  const keys = [A, B].map(tenant => ({ tenant, ...crypto.generateKeyPairSync('ed25519') }));
  const connections = {};
  let directory;
  const settingsTable = '"' + namespaces.settings + '".tenant_settings';
  const historyTable = '"' + namespaces.settings + '".tenant_settings_history';
  const policyTable = '"' + namespaces.operatorPolicy + '".tenant_operator_policy';
  const authorityTable = '"' + namespaces.authority + '".tenant_owner_configuration_authority';
  const candidates = { settings: require('../../lib/tenant-settings/postgres-candidate.json'),
    operatorPolicy: require('../../lib/operator-policy/postgres-candidate.json'),
    authority: require('../../lib/tenant-settings/owner-authority-candidate.json') };
  const t = name => 'preview_auth.' + name;

  function ownerConfiguration () {
    return { version: 1, postgres: { writerConnectionEnv: 'OWNER_SUBJECT_CONNECTION', accessConnectionEnv: 'OWNER_ACCESS_CONNECTION',
      namespaces: { authorization: 'preview_auth', credentials: 'preview_legacy', access: 'preview_access' } },
    resolution: { mode: 'direct-alias' }, tenants: [{ id: A, aliases: ['one.example.test'] }, { id: B, aliases: ['two.example.test'] }],
    ownerPolicy: { catalogue }, ownerSettings: { connectionEnv: 'OWNER_SETTINGS_CONNECTION', namespaces },
    management: { issuer: 'synthetic-owner-configuration', audience: 'synthetic-management', purpose: 'management', consumer,
      keys: keys.map(key => ({ tenant: key.tenant, kid: 'owner-configuration-key',
        publicKey: Buffer.from(key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') })) } };
  }
  function dataConfiguration () {
    const config = data.configuration();
    config.tenantSettings = { connectionEnv: 'DISPLAY_SETTINGS_CONNECTION',
      namespaces: { settings: namespaces.settings, operatorPolicy: namespaces.operatorPolicy } };
    return config;
  }
  function token (tenant = A, overrides = {}, headerOverrides = {}) {
    const now = Math.floor(Date.now() / 1000), key = keys.find(value => value.tenant === tenant);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = encode({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'owner-configuration-key', ...headerOverrides }) + '.' +
      encode({ iss: 'synthetic-owner-configuration', aud: 'synthetic-management', purpose: 'management', tid: tenant,
        sub: SUBJECT, sid: 'owner-configuration-session', cv: 1, iat: now, nbf: now, exp: now + 600, ...overrides });
    return input + '.' + crypto.sign(null, Buffer.from(input), key.privateKey).toString('base64url');
  }
  async function setup () {
    await data.setup();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-configuration-'));
    const params = data.admin.connectionParameters;
    // Private URI derived exclusively from this fixture-owned live connection.
    const uri = new URL('postgres:' + '//'+ encodeURIComponent(params.user) + ':' + encodeURIComponent(params.password) +
      '@' + params.host + ':' + params.port + '/' + encodeURIComponent(params.database));
    for (const [kind, catalogue] of Object.entries(candidates)) await run('up', {
      direct: true, connectionString: uri.toString(), namespace: namespaces[kind], catalogue });
    for (const [kind, role] of Object.entries(roles)) {
      const password = random();
      await data.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      const address = new URL(uri); address.username = role; address.password = password; connections[kind] = address.toString();
    }
    const ownerSchemas = ['preview_auth', 'preview_legacy', 'preview_access'];
    for (const role of [roles.writer, roles.access]) await data.admin.query(`GRANT USAGE ON SCHEMA ${ownerSchemas.join(',')} TO "${role}"`);
    await data.admin.query(`GRANT SELECT,UPDATE,DELETE ON ${t('tenant_authorization_subjects')},preview_legacy.legacy_credential_subjects TO "${roles.writer}"`);
    await data.admin.query(`GRANT SELECT ON ${t('tenant_authorization_roles')} TO "${roles.writer}"`);
    await data.admin.query(`GRANT SELECT,INSERT,DELETE ON ${t('tenant_authorization_subject_roles')} TO "${roles.writer}"`);
    await data.admin.query(`GRANT INSERT ON ${t('tenant_subject_admin_audit')} TO "${roles.writer}"`);
    for (const table of ['tenant_authorization_config', 'tenant_authorization_roles', 'tenant_owner_policy', 'tenant_owner_actors']) {
      await data.admin.query(`GRANT SELECT,UPDATE(owner_fence) ON ${t(table)} TO "${roles.writer}"`);
    }
    for (const schema of ownerSchemas) await data.admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO "${roles.access}"`);
    for (const schema of Object.values(namespaces)) {
      await data.admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roles.settings}"`);
      await data.admin.query(`GRANT SELECT ON "${schema}".schema_migrations TO "${roles.settings}"`);
    }
    for (const schema of [namespaces.settings, namespaces.operatorPolicy]) {
      await data.admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roles.display}"`);
      await data.admin.query(`GRANT SELECT ON "${schema}".schema_migrations TO "${roles.display}"`);
    }
    await data.admin.query(`GRANT SELECT,INSERT,UPDATE ON ${settingsTable} TO "${roles.settings}"`);
    await data.admin.query(`GRANT SELECT,INSERT ON ${historyTable} TO "${roles.settings}"`);
    await data.admin.query(`GRANT SELECT ON ${policyTable} TO "${roles.settings}","${roles.display}"`);
    await data.admin.query(`GRANT SELECT,UPDATE(owner_fence) ON ${authorityTable} TO "${roles.settings}"`);
    await data.admin.query(`GRANT SELECT ON ${settingsTable} TO "${roles.display}"`);
    for (const tenant of [A, B]) {
      await data.admin.query(`INSERT INTO ${t('tenant_owner_policy')}(tenant_id,catalogue_digest,ceiling) VALUES($1,$2,$3)`,
        [tenant, catalogueDigest(catalogue), catalogue]);
      await data.admin.query(`INSERT INTO ${t('tenant_owner_actors')}(tenant_id,principal,consumer,active,can_update,delegable)
        VALUES($1,$2,$3,true,true,$4)`, [tenant, SUBJECT, consumer, catalogue]);
      await data.admin.query(`UPDATE ${t('tenant_authorization_roles')} SET permissions=ARRAY['*'] WHERE tenant_id=$1 AND name='viewer'`, [tenant]);
      await data.admin.query(`INSERT INTO preview_access.access_credentials VALUES($1,'owner-configuration-credential',$2,1,true)`, [tenant, SUBJECT]);
      await data.admin.query(`INSERT INTO preview_access.access_sessions VALUES($1,'owner-configuration-session',$2,
        'owner-configuration-credential',1,$3,true,'management')`, [tenant, SUBJECT, Math.floor(Date.now() / 1000) + 3600]);
      await data.admin.query(`INSERT INTO preview_access.access_keys VALUES($1,'owner-configuration-key','management',true)`, [tenant]);
    }
    await reset();
  }
  async function reset () {
    for (const table of [historyTable, settingsTable, policyTable, authorityTable]) await data.admin.query('DELETE FROM ' + table);
    for (const tenant of [A, B]) {
      await data.admin.query(`INSERT INTO ${settingsTable} VALUES($1,1,'{}')`, [tenant]);
      await data.admin.query(`INSERT INTO ${historyTable}(tenant_id,version,values,principal,consumer,operation,event_time)
        VALUES($1,1,'{}','operator','provisioning','replace',$2)`, [tenant, Date.now()]);
      await data.admin.query(`INSERT INTO ${policyTable} VALUES($1,1,$2,'operator','provisioning',$3)`,
        [tenant, { deployment: {}, overrides: {} }, Date.now()]);
      await data.admin.query(`INSERT INTO ${authorityTable}(tenant_id,principal,consumer,active,can_configure)
        VALUES($1,$2,$3,true,true)`, [tenant, SUBJECT, consumer]);
    }
  }
  async function start ({ ownerConfig = ownerConfiguration(), dataConfig = dataConfiguration(), extra = {}, refused = false } = {}) {
    const file = path.join(directory, 'owner-' + random() + '.json');
    fs.writeFileSync(file, JSON.stringify(ownerConfig), { mode: 0o600 });
    const queryAudit = path.join(directory, 'queries-' + random() + '.json');
    const worker = data.start(dataConfig, {
      MULTITENANT_OWNER_PREVIEW_CONFIG: file, OWNER_SUBJECT_CONNECTION: connections.writer,
      OWNER_ACCESS_CONNECTION: connections.access, OWNER_SETTINGS_CONNECTION: connections.settings,
      DISPLAY_SETTINGS_CONNECTION: connections.display, TENANT_ADMIN_HOSTNAME: '127.0.0.1', TENANT_ADMIN_PORT: '0',
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'owner-configuration-controls.js'),
      NS_OWNER_CONFIGURATION_QUERY_AUDIT: queryAudit,
      ...(process.env.NS_OWNER_CONFIGURATION_CONTROL ? { NS_OWNER_CONFIGURATION_CONTROL: process.env.NS_OWNER_CONFIGURATION_CONTROL } : {}), ...extra
    }, { roles: 'tenant-admin,api' });
    worker.queryAudit = queryAudit; workers.push(worker);
    if (refused) {
      await data.until(async () => worker.exit !== null || /Listening/.test(worker.stdout), 'refused owner configuration boot');
      assert.doesNotMatch(worker.stdout, /Listening/, 'unsafe owner configuration must never bind');
      const exit = await worker.exited; assert.equal(exit.code, 78);
    } else {
      await data.until(async () => {
        assert.equal(worker.exit, null, 'configuration worker exited before readiness');
        const owner = /Listening for role tenant-admin on 127\.0\.0\.1:(\d+)/.exec(worker.stdout);
        const api = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(worker.stdout);
        if (owner) worker.ownerPort = Number(owner[1]);
        if (api) worker.port = Number(api[1]);
        return owner && api;
      }, 'actual owner and DATA listeners');
      assert.notEqual(worker.ownerPort, worker.port);
      await data.ready(worker);
    }
    for (const credential of Object.values(connections)) {
      assert.ok(!worker.stdout.includes(credential) && !worker.stderr.includes(credential), 'diagnostics must not disclose credentials');
    }
    return worker;
  }
  async function stop (worker) {
    await data.stop(worker);
    await assert.rejects(fetch('http://127.0.0.1:' + worker.ownerPort + '/', { signal: AbortSignal.timeout(1000) }));
    const audit = JSON.parse(fs.readFileSync(worker.queryAudit));
    assert.equal(audit.ddl, 0, 'serving boot/runtime must not issue DDL');
  }
  function http (worker, tenant, method, resource, credential, body, selectors) {
    return data.http({ port: worker.ownerPort }, tenant, method, resource, credential, body, selectors);
  }
  async function state () {
    return { current: (await data.admin.query(`SELECT tenant_id,version,values FROM ${settingsTable} ORDER BY tenant_id`)).rows,
      history: (await data.admin.query(`SELECT tenant_id,version,values,principal,consumer,operation,restored_from FROM ${historyTable}
        ORDER BY tenant_id,version`)).rows };
  }
  async function configure (tenant, active, enabled = active) {
    await data.admin.query(`UPDATE ${authorityTable} SET active=$2,can_configure=$3 WHERE tenant_id=$1 AND principal=$4 AND consumer=$5`,
      [tenant, active, enabled, SUBJECT, consumer]);
  }
  async function policy (tenant, value, generation = 2) {
    await data.admin.query(`UPDATE ${policyTable} SET policy=$2,generation=$3 WHERE tenant_id=$1`, [tenant, value, generation]);
  }
  function barrier (kind) {
    const file = path.join(directory, kind + '-' + random());
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
    try { await data.cleanup(); }
    finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
  }
  return { setup, reset, start, stop, cleanup, http, state, configure, policy, barrier, token, data, queryAs,
    A, B, SUBJECT, consumer, namespaces, roles, workers, settingsTable, historyTable, policyTable, authorityTable };
};
