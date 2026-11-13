'use strict';

// Registry provisioning for a suite that owns its PostgreSQL and used to pass a
// static `tenants` list to a role (decision static-mode-lab-flag,
// MT-STATIC-MODE-RETIRE). The suite keeps its own schemas; this fixture adds
// the provisioning catalogues the suite does not already hold, a provisioning
// identity with exactly provisionerGrants, and a dev-mode Vault Transit mount,
// then provisions tenants through the shipping createProvisioning. The role
// under test is then started with `registry` in place of `tenants` and without
// MULTITENANT_STATIC_TENANTS. Synthetic only; close() removes what create() made.
//
//   const lab = await provisionedTenants.create({ admin, adminURI, owner, namespaces: { authorization, control } });
//   await lab.provision({ id, hosts: ['one.example.test'] });
//   ... role config: { registry: { namespace: lab.namespaces.registry } }, grants from lab.registryGrants({ readers: [role] })
//
// tests/fixtures/tenant-registry-lab.js is the equivalent for suites that share
// NS_TEST_POSTGRES_ADMIN_URI and create every schema themselves.
const { randomBytes } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { run } = require('../../lib/migrations/postgres');
const registry = require('../../lib/tenant-registry/postgres');
const { createProvisioning, provisionerGrants } = require('../../lib/tenant-registry/provision');

const VAULT_IMAGE = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
// The nine namespaces provisioning writes, with the catalogue of each.
const CATALOGUES = {
  registry: () => registry.catalogue,
  legacy: () => require('../../lib/secrets/legacy-credentials-candidate.json'),
  secrets: () => require('../../lib/secrets/postgres-candidate.json'),
  authorization: () => require('../../lib/tenant-authorization/postgres-candidate.json'),
  access: () => require('../../lib/tenant-authorization/access-candidate.json'),
  clock: () => require('../../migrations/candidates/postgres-write-clock-v1.json'),
  control: () => require('../../lib/tenant-lifecycle/postgres-candidate.json'),
  settings: () => require('../../lib/tenant-settings/postgres-candidate.json'),
  operatorPolicy: () => require('../../lib/operator-policy/postgres-candidate.json')
};
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();

async function waitFor (probe, label, ms = 30000) {
  const until = Date.now() + ms; let last;
  while (Date.now() < until) { try { return await probe(); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 200)); } }
  throw new Error(label + ' did not become ready' + (last ? ': ' + last.message : ''));
}

async function startVault (id) {
  const token = randomBytes(16).toString('hex'), name = 'ns-provisioned-vault-' + id;
  execFileSync('docker', ['run', '--rm', '-d', '--name', name, '--label', 'nightscout.test=provisioned-tenants', '-p', '127.0.0.1::8200',
    '-e', 'VAULT_DEV_ROOT_TOKEN_ID', VAULT_IMAGE, 'server', '-dev'], { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: token }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  // Reaper: removes the container if the test process dies before close().
  const reaper = spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; docker rm -f -v "$2" >/dev/null 2>&1', 'reaper', String(process.pid), name],
    { detached: true, stdio: 'ignore' });
  reaper.unref();
  const address = 'http://127.0.0.1:' + docker(['port', name, '8200/tcp']).split('\n')[0].split(':').pop() + '/';
  await waitFor(async () => { const response = await fetch(address + 'v1/sys/health', { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (!response.ok) throw new Error('HTTP ' + response.status); }, 'owned Vault');
  return { name, address, token, close () { try { docker(['rm', '-f', '-v', name]); } catch { /* already gone */ } } };
}

// options:
//   admin        a connected superuser pg Client on the suite's database (stays the suite's)
//   adminURI     its connection string
//   owner        an existing NOLOGIN role that owns the catalogues this fixture adds
//   namespaces   provisioning namespaces the suite already created and migrated, by kind
//   checkpoints  [{ namespace, consumer, digest }] as createProvisioning takes them
async function create ({ admin, adminURI, owner, namespaces = {}, checkpoints = [] } = {}) {
  if (!admin || typeof adminURI !== 'string' || !NAME.test(owner || '') || Object.keys(namespaces).some(kind => !Object.hasOwn(CATALOGUES, kind) || !NAME.test(namespaces[kind]))) {
    throw new TypeError('provisioned-tenants needs the suite admin client, its URI, a catalogue owner and known namespaces');
  }
  const id = randomBytes(5).toString('hex');
  const q = (sql, values) => admin.query(sql, values);
  const created = [], all = { ...namespaces };
  let vault, provisioning, role;
  async function close () {
    if (provisioning) await provisioning.close().catch(() => {});
    if (vault) vault.close();
    // The suite usually removes its whole database container next; this keeps a shared database clean too.
    for (const namespace of created) await q(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`).catch(() => {});
    if (role) { await q(`DROP OWNED BY "${role}"`).catch(() => {}); await q(`DROP ROLE IF EXISTS "${role}"`).catch(() => {}); }
  }
  try {
    for (const [kind, catalogue] of Object.entries(CATALOGUES)) {
      if (all[kind]) continue;
      const namespace = all[kind] = 'pvt_' + kind.toLowerCase() + '_' + id;
      await q(`CREATE SCHEMA "${namespace}"`); created.push(namespace);
      await run('up', { direct: true, connectionString: adminURI, namespace, catalogue: catalogue() });
      for (const row of (await q('SELECT tablename FROM pg_tables WHERE schemaname = $1', [namespace])).rows) await q(`ALTER TABLE "${namespace}"."${row.tablename}" OWNER TO "${owner}"`);
      for (const row of (await q('SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1', [namespace])).rows) {
        await q(`ALTER FUNCTION ${row.fn} OWNER TO "${owner}"`);
      }
      await q(`ALTER SCHEMA "${namespace}" OWNER TO "${owner}"`);
    }
    role = 'pvt_prov_' + id;
    const password = randomBytes(18).toString('hex');
    await q(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    // registry.grants also pins the search_path of the registry's definer and
    // trigger functions; provisionerGrants carries only its GRANT statements.
    for (const sql of registry.grants({ namespace: all.registry, provisioner: role })) await q(sql);
    for (const sql of provisionerGrants({ namespaces: all, role, checkpoints })) await q(sql);
    const url = new URL(adminURI); url.username = role; url.password = password;
    vault = await startVault(id);
    const mount = 'transit';
    const vaultRequest = async (path, body) => {
      const response = await fetch(vault.address + 'v1/' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Vault-Token': vault.token, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('provisioned-tenants Vault preparation HTTP ' + response.status); }
      return response.status === 204 ? null : response.json();
    };
    await vaultRequest('sys/mounts/' + mount, { type: 'transit' });
    // The provisioning credential: create/read tenant keys, encrypt with tenant data keys.
    await vaultRequest('sys/policies/acl/provision', { policy: [
      `path "${mount}/keys/tenant-*" { capabilities = ["create", "read", "update"] }`,
      `path "${mount}/encrypt/tenant-data-*" { capabilities = ["update"] }`].join('\n') });
    const token = (await vaultRequest('auth/token/create', { policies: ['provision'], no_default_policy: true, ttl: '1h' })).auth.client_token;
    const vaultOptions = { address: vault.address, mount, allowInsecureLoopback: true, timeoutMs: 5000, getToken: async () => token };
    provisioning = createProvisioning({ connectionString: url.toString(), namespaces: { ...all }, checkpoints, vault: vaultOptions,
      actor: { principal: 'provisioned-tenants-operator', consumer: 'provisioned-tenants' } });
    return {
      namespaces: Object.freeze({ ...all }), provisioner: role, provisioning, vaultRequest,
      vault: Object.freeze({ address: vault.address, mount, container: vault.name }),
      // Provision one tenant; anything but a fresh 'created' is a fixture error.
      async provision (spec) {
        const result = await provisioning.provision(spec);
        if (result.outcome !== 'created') throw new Error('provisioned-tenants: ' + spec.id + ' was not created: ' + JSON.stringify(result));
        return result;
      },
      // The registry's own grant statements for the roles under test.
      registryGrants: roles => registry.grants({ namespace: all.registry, ...roles }),
      close
    };
  } catch (error) { await close(); throw error; }
}

module.exports = { create, CATALOGUES };
