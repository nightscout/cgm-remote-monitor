'use strict';

// Disposable tenant-registry lab: the catalogues provisioning writes, a NOLOGIN
// owner, a provisioning identity with exactly provisionerGrants, a serving
// (resolver/reader) and an enumerator identity, and a dev-mode Vault with a
// Transit mount (a container this lab starts, or NS_TEST_VAULT_ADDR with
// NS_TEST_VAULT_TOKEN). Synthetic only; everything is removed by close().
const { randomBytes, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../../lib/migrations/postgres');
const registry = require('../../lib/tenant-registry/postgres');
const { provisionerGrants } = require('../../lib/tenant-registry/provision');

const VAULT_IMAGE = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const CATALOGUES = {
  registry: () => registry.catalogue,
  legacy: () => require('../../lib/secrets/legacy-credentials-candidate.json'),
  secrets: () => require('../../lib/secrets/postgres-candidate.json'),
  authorization: () => require('../../lib/tenant-authorization/postgres-candidate.json'),
  access: () => require('../../lib/tenant-authorization/access-candidate.json'),
  clock: () => require('../../migrations/candidates/postgres-write-clock-v1.json'),
  control: () => require('../../lib/tenant-lifecycle/postgres-candidate.json'),
  settings: () => require('../../lib/tenant-settings/postgres-candidate.json'),
  operatorPolicy: () => require('../../lib/operator-policy/postgres-candidate.json'),
  checkpoint: () => require('../../migrations/candidates/postgres-consumer-checkpoint-v1.json'),
  ownerConfiguration: () => require('../../lib/tenant-settings/owner-authority-candidate.json')
};
// Lab kinds whose deployment layout kind differs.
const LAYOUT_KIND = { settings: 'display_settings', operatorPolicy: 'operator_policy', checkpoint: 'rt_checkpoint', ownerConfiguration: 'owner_configuration' };
const enabled = () => !!process.env.NS_TEST_POSTGRES_ADMIN_URI && /test/i.test(new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI || 'postgres://x/none').pathname) &&
  (process.env.NS_VAULT_DOCKER_TEST === '1' || !!process.env.NS_TEST_VAULT_ADDR);

async function waitFor (fn, ms = 30000) {
  const until = Date.now() + ms; let last;
  while (Date.now() < until) { try { return await fn(); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 250)); } }
  throw last;
}

async function startVault () {
  if (process.env.NS_TEST_VAULT_ADDR) return { address: process.env.NS_TEST_VAULT_ADDR, token: process.env.NS_TEST_VAULT_TOKEN, close: async () => {} };
  const token = randomBytes(16).toString('hex'), name = 'ns-registry-vault-' + randomBytes(6).toString('hex');
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::8200', '-e', 'VAULT_DEV_ROOT_TOKEN_ID', VAULT_IMAGE, 'server', '-dev'],
    { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = execFileSync('docker', ['port', name, '8200/tcp']).toString().trim().split('\n')[0].split(':').pop();
  const address = 'http://127.0.0.1:' + port + '/';
  await waitFor(async () => { const r = await fetch(address + 'v1/sys/health'); if (!r.ok) throw new Error('vault not ready'); });
  return { address, token, close: async () => { try { execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' }); } catch { /* already gone */ } } };
}

async function createLab ({ servingApi = false, database = process.env.NS_TEST_POSTGRES_ADMIN_URI, deploymentPrefix, vaultService } = {}) {
  if (!/test/i.test(new URL(database).pathname)) throw new Error('Expected a disposable test database');
  const ADMIN = database;
  const id = randomUUID().replace(/-/g, '').slice(0, 10);
  // Names follow the deployment layout, <prefix>_<kind> (lib/server/serve/deployment-settings.js),
  // so a role process started with NS_PG_PREFIX=prefix reads this lab's schemas.
  const prefix = deploymentPrefix || 'trl_' + id;
  const deployment = require('../../lib/server/serve/deployment-settings');
  const defaults = deployment.layout({ NS_PG_PREFIX: prefix });
  const namespaces = Object.fromEntries(Object.keys(CATALOGUES).map(kind => [kind, prefix + '_' + (LAYOUT_KIND[kind] || kind)]));
  const owner = 'trl_owner_' + id;
  const roles = deploymentPrefix ? { provisioner: prefix + '_provisioner', api: prefix + '_api', realtime: prefix + '_realtime' }
    : { provisioner: 'trl_prov_' + id, api: 'trl_api_' + id, realtime: 'trl_rt_' + id };
  const migrations = Object.fromEntries(Object.entries(CATALOGUES).map(([kind, build]) => [namespaces[kind], build()]));
  const extraSchemas = [];
  let layout;
  if (servingApi) {
    const plan = require('./multitenant-plan');
    const catalogues = { ...require('./realtime-preview/bootstrap-grants').catalogues(),
      owner_configuration: require('../../lib/tenant-settings/owner-authority-candidate.json') };
    const native = deployment.nativeSelection(defaults);
    catalogues.control = require('../../lib/tenant-lifecycle/native-selection').catalogue(native);
    const selected = {};
    for (const [kind, catalogue] of Object.entries(catalogues)) {
      const namespace = defaults.namespaces[kind];
      if (!Object.hasOwn(migrations, namespace)) extraSchemas.push(namespace);
      selected[kind] = namespace;
      migrations[namespace] = catalogue;
    }
    for (const kind of [...plan.roleNames(plan.layout(prefix)), 'ui_registry']) {
      roles[kind] ||= prefix + '_' + kind;
    }
    layout = { owner, roles, namespaces: selected, native };
  }
  const urls = {};
  const admin = new Client({ connectionString: ADMIN }); await admin.connect();
  const mount = prefix + '_transit';
  const q = (sql, values) => admin.query(sql, values);
  await q(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  for (const [kind, role] of Object.entries(roles)) {
    const password = randomBytes(18).toString('hex');
    await q(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    const url = new URL(ADMIN); url.username = role; url.password = password; urls[kind] = url.toString();
  }
  for (const [namespace, migration] of Object.entries(migrations)) {
    await q(`CREATE SCHEMA "${namespace}"`);
    await run('up', { direct: true, connectionString: ADMIN, namespace, catalogue: migration });
    for (const row of (await q('SELECT tablename FROM pg_tables WHERE schemaname = $1', [namespace])).rows) await q(`ALTER TABLE "${namespace}"."${row.tablename}" OWNER TO "${owner}"`);
    for (const row of (await q('SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1', [namespace])).rows) {
      await q(`ALTER FUNCTION ${row.fn} OWNER TO "${owner}"`);
    }
    await q(`ALTER SCHEMA "${namespace}" OWNER TO "${owner}"`);
  }
  const consumers = [{ namespace: namespaces.checkpoint, consumer: 'realtime-registry-lab', digest: 'a'.repeat(64) }];
  if (layout) for (const sql of require('../../lib/server/ordinary-deployment-grants').grants(layout, { nativeSelection: layout.native })) await q(sql);
  for (const sql of registry.grants({ namespace: namespaces.registry, resolvers: [roles.api], enumerators: [roles.realtime], readers: [roles.api] })) await q(sql);
  for (const sql of provisionerGrants({ namespaces, role: roles.provisioner, checkpoints: consumers })) await q(sql);
  const vault = vaultService || await startVault();
  const vaultRequest = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(vault.address + 'v1/' + path, { method, headers: { 'X-Vault-Token': vault.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok && response.status !== 404) throw new Error('vault lab request refused ' + response.status);
    return response.status === 204 || response.status === 404 ? null : response.json();
  };
  await vaultRequest('sys/mounts/' + mount, { type: 'transit' });
  // The provisioning token: create/read tenant keys, encrypt with tenant data keys.
  await vaultRequest('sys/policies/acl/' + mount + '_provision', { policy: [
    `path "${mount}/keys/tenant-data-*" { capabilities = ["create", "read", "update"] }`,
    `path "${mount}/encrypt/tenant-data-*" { capabilities = ["update"] }`].join('\n') });
  const provisionToken = (await vaultRequest('auth/token/create', { policies: [mount + '_provision'], no_default_policy: true, ttl: '1h' })).auth.client_token;
  return {
    id, prefix, namespaces, roles, urls, owner, admin, mount, consumers, layout,
    // The environment of an admin process that provisions into this lab:
    // adds the evaluator checkpoint schema and grants the provisioner the
    // checkpoint rows the admin role derives. The Vault token goes in dir.
    async adminEnvironment (dir) {
      const settings = require('../../lib/server/serve/deployment-settings'), layout = settings.layout({ NS_PG_PREFIX: prefix });
      const evaluator = layout.namespaces.eval_checkpoint;
      if (!extraSchemas.includes(evaluator)) {
        await q(`CREATE SCHEMA "${evaluator}"`);
        // The deployment's evaluator checkpoint catalogue (lib/server/serve/evaluator-readiness.js):
        // provisioning writes the completed-work row typed and pending in every input transport.
        await run('up', { direct: true, connectionString: ADMIN, namespace: evaluator, catalogue: require('../../migrations/candidates/postgres-evaluator-work-v2.json') });
        for (const row of (await q('SELECT tablename FROM pg_tables WHERE schemaname = $1', [evaluator])).rows) await q(`ALTER TABLE "${evaluator}"."${row.tablename}" OWNER TO "${owner}"`);
        await q(`ALTER SCHEMA "${evaluator}" OWNER TO "${owner}"`);
        extraSchemas.push(evaluator);
        for (const sql of provisionerGrants({ namespaces, role: roles.provisioner, checkpoints: settings.checkpoints(layout) })) await q(sql);
      }
      const { writeFileSync } = require('node:fs');
      writeFileSync(require('node:path').join(dir, 'vault-token'), provisionToken, { mode: 0o600 });
      return { NS_PG_PREFIX: prefix, NS_SECRETS_DIR: dir, NS_VAULT_ADDR: vault.address, NS_VAULT_ALLOW_INSECURE_LOOPBACK: 'true', NS_PROVISIONER_PG: urls.provisioner,
        ...require('./signing-secret').env(dir) };
    },
    vault: { address: vault.address, mount, allowInsecureLoopback: true, timeoutMs: 5000, getToken: async () => provisionToken },
    vaultRequest,
    provisioningOptions: (extra = {}) => ({ connectionString: urls.provisioner, namespaces: { ...namespaces }, checkpoints: consumers,
      vault: { address: vault.address, mount, allowInsecureLoopback: true, timeoutMs: 5000, getToken: async () => provisionToken },
      actor: { principal: 'registry-lab-operator', consumer: 'registry-lab' },
      signing: require('./signing-secret').signing, accessTokens: require('./signing-secret').DATA_REALM, ...extra }),
    // Every row any provisioning table holds for a tenant (as the superuser).
    async rowsFor (tenant) {
      const out = {};
      for (const [kind, namespace] of Object.entries(namespaces)) {
        for (const row of (await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1", [namespace])).rows) {
          const n = (await q(`SELECT count(*)::int AS n FROM "${namespace}"."${row.relname}" WHERE tenant_id = $1`, [tenant])).rows[0].n;
          if (n) out[kind + '.' + row.relname] = n;
        }
      }
      return out;
    },
    async close () {
      for (const namespace of [...Object.values(namespaces), ...extraSchemas]) await q(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`).catch(() => {});
      for (const role of [...Object.values(roles), owner]) {
        await q(`DROP OWNED BY "${role}"`).catch(() => {});
        await q(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
      }
      await admin.end().catch(() => {});
      if (vaultService || process.env.NS_TEST_VAULT_ADDR) await vaultRequest('sys/mounts/' + mount, undefined, 'DELETE').catch(() => {});
      if (!vaultService) await vault.close();
    }
  };
}

module.exports = { createLab, enabled, CATALOGUES };
