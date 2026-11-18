'use strict';

// Disposable deployment fixture. The child is the shipping multitenant CLI; no routes are copied.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const httpRequest = require('node:http').request;
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { run } = require('../../lib/migrations/postgres');
const provisionedTenants = require('./provisioned-tenants');
const prestart = require('./platform-prestart');

const root = path.resolve(__dirname, '../..');
const BIN = path.join(root, 'bin/nightscout.js');
const image = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const namespaces = { entries: 'preview_data', authorization: 'preview_auth', secrets: 'preview_secrets', legacy: 'preview_legacy' };
const domainNames = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];
const allNamespaces = { ...namespaces, ...Object.fromEntries(domainNames.filter(name => name !== 'entries')
  .map(name => [name, 'preview_' + name])) };
const catalogues = {
  entries: require('../../migrations/candidates/postgres-entries-v1.json'),
  authorization: require('../../lib/tenant-authorization/postgres-candidate.json'),
  secrets: require('../../lib/secrets/postgres-candidate.json'),
  legacy: require('../../lib/secrets/legacy-credentials-candidate.json')
};
for (const logical of domainNames) catalogues[logical] =
  require('../../lib/server/serve/postgres-domains').get(logical).catalogue;
const random = () => crypto.randomBytes(24).toString('hex');
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
}).trim();

// Registry mode (decision static-mode-lab-flag, MT-STATIC-MODE-RETIRE): both
// tenants are provisioned through the shipping provisioning; the api reads
// them from the registry with one role-level Vault credential.
const HOSTS = ['one.example.test', 'two.example.test'];
// The serving api checks this fixture's platform proof at start.
const PROOF_NAMESPACE = 'client_replay_proof';
function configuration (address, provisioned) {
  return {
    version: 1,
    domains: domainNames, legacy: true, context: true,
    postgres: { connectionEnv: 'PREVIEW_APP_PG', readinessConnectionEnv: 'PREVIEW_CHECK_PG', namespaces: allNamespaces },
    vault: { address, mount: 'transit', tokenEnv: 'PREVIEW_VAULT_TOKEN', allowInsecureLoopback: true, timeoutMs: 1000 },
    resolution: { mode: 'direct-alias' },
    registry: { namespace: provisioned.registry, maxTenants: 100, refreshMs: 500 },
    tenantSettings: { connectionEnv: 'PREVIEW_SETTINGS_PG', namespaces: { settings: provisioned.settings, operatorPolicy: provisioned.operatorPolicy } },
    platformVerification: { namespace: PROOF_NAMESPACE, role: 'api' }
  };
}

module.exports = function clientReplayHTTP () {
    const permissions = domainNames.flatMap(domain => ['read', 'create', 'update', 'delete'].map(action => 'api:' + domain + ':' + action));
    const suffix = crypto.randomBytes(8).toString('hex');
    const pgName = 'ns-client-replay-pg-' + suffix, vaultName = 'ns-client-replay-vault-' + suffix;
    // Outside the package: no cwd-relative implicit config or secrets file.
    const fixtureDirectory = path.resolve(root, '..', '.client-replay-test-' + suffix);
    const configFile = path.join(fixtureDirectory, 'preview.json');
    const roots = [], children = new Set();
    let pgOwned = false, vaultOwned = false, admin, adminURI, appURI, checkURI, settingsURI, address, vaultRoot, roleToken, provisioned, proof, lastVerified = null;

    async function until (probe, label) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await probe()) return;
        await delay(100);
      }
      throw new Error(label + ' did not become ready');
    }

    async function vault (resource, body) {
      const response = await fetch(address + '/v1/' + resource, {
        method: 'POST', headers: { 'X-Vault-Token': vaultRoot, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
      });
      assert.ok(response.ok, 'operator Vault preparation HTTP ' + response.status);
      return response.status === 204 ? {} : response.json();
    }

    function environment (extra = {}) {
      const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', NODE_ENV: 'test',
        // Acceptance runs with every tenant initialized before the listener
        // opens (decision readiness-serve-then-warm); extra may override.
        NS_TENANT_READINESS: 'all',
        MULTITENANT_PREVIEW_CONFIG: configFile,
        API_HOSTNAME: '127.0.0.1', API_PORT: '0',
        PREVIEW_APP_PG: appURI, PREVIEW_CHECK_PG: checkURI, PREVIEW_SETTINGS_PG: settingsURI,
        PREVIEW_VAULT_TOKEN: roleToken
      };
      for (const key of ['NODE_OPTIONS', 'NS_PREVIEW_PROCESS_CONTROL']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      return { ...env, ...extra };
    }

    function start (config = configuration(address, provisioned.namespaces), extra) {
      const text = typeof config === 'string' ? config : JSON.stringify(config);
      fs.writeFileSync(configFile, text, { mode: 0o600 });
      // The deployment's pre-start step; an unchanged configuration keeps its
      // published proof and a refusal leaves none, so the role refuses at start.
      const key = JSON.stringify([text, extra || null]);
      if (key !== lastVerified) {
        const result = prestart.verifySync({ directory: fixtureDirectory, namespace: proof.namespace, writerURI: proof.writerURI,
          targets: [{ role: 'api', configFile }], source: environment(extra) });
        lastVerified = result.status === 'verified' ? key : null;
        if (result.status !== 'verified') console.log('CLIENT_REPLAY_PRE_START_REFUSED ' + JSON.stringify({ code: result.code, diagnostic: result.diagnostic }));
      }
      const child = spawn(process.execPath, [BIN, 'multitenant', 'api'], {
        cwd: fixtureDirectory, env: environment(extra), stdio: ['ignore', 'pipe', 'pipe']
      });
      const worker = { child, stdout: '', stderr: '', exit: null };
      children.add(worker);
      child.stdout.on('data', bytes => { worker.stdout += bytes; });
      child.stderr.on('data', bytes => { worker.stderr += bytes; });
      worker.exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          worker.exit = { code, signal };
          resolve(worker.exit);
        });
      });
      return worker;
    }

    async function ready (worker) {
      await until(async () => {
        assert.equal(worker.exit, null, 'preview exited before readiness: ' + worker.stderr);
        const found = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(worker.stdout);
        if (!found) return false;
        worker.port = Number(found[1]);
        // The registry tenant is resolved and warmed on its first request; ready
        // means the listener answers through the current anonymous authority.
        const result = await http(worker, A, 'GET', '/api/v3/entries', undefined);
        return result.status === 403;
      }, 'preview child listener');
    }

    async function stop (worker) {
      if (!worker.exit) worker.child.kill('SIGTERM');
      const result = await Promise.race([worker.exited, delay(12000).then(() => { throw new Error('preview child did not close'); })]);
      assert.deepEqual(result, { code: 0, signal: null }, worker.stderr);
      children.delete(worker);
      await assert.rejects(fetch('http://127.0.0.1:' + worker.port + '/', { signal: AbortSignal.timeout(1000) }));
    }

    async function http (worker, tenant, method, resource, credential, body, selectors = {}) {
      // node:http preserves an explicit Host on the actual wire; fetch may
      // replace it with its URL authority.
      return new Promise((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1', port: worker.port, path: resource, method,
          headers: {
            Host: HOSTS[tenant === A ? 0 : 1],
            Accept: 'application/json',
            ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...selectors
          }, signal: AbortSignal.timeout(5000), agent: false
        }, response => {
          let bytes = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { bytes += chunk; });
          response.on('end', () => {
            try { resolve({ status: response.statusCode, body: bytes &&
              (response.headers['content-type'] || '').includes('json') ? JSON.parse(bytes) : bytes,
            headers: response.headers }); } catch (error) { reject(error); }
          });
          response.on('error', reject);
        });
        request.on('error', reject);
        request.end(body ? JSON.stringify(body) : undefined);
      });
    }

    async function exchange (worker, tenant) {
      const i = tenant === A ? 0 : 1;
      const credential = 'sameviewer-' + hash(hash(roots[i]) + SUBJECT).slice(0, 16);
      return http(worker, tenant, 'GET', '/api/v2/authorization/request/' + credential);
    }

    async function open () {
      fs.mkdirSync(fixtureDirectory, { mode: 0o700 });
      const pgPassword = random();
      execFileSync('docker', ['run', '--rm', '--name', pgName, '-d', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=client_replay_test', 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: pgPassword }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      pgOwned = true;
      const pgPort = docker(['port', pgName, '5432/tcp']).split(':').pop();
      adminURI = 'postgres://operator:' + pgPassword + '@127.0.0.1:' + pgPort + '/client_replay_test';
      await until(async () => {
        try {
          docker(['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'client_replay_test']);
          return true;
        } catch { return false; }
      }, 'owned PostgreSQL');
      for (const [kind, catalogue] of Object.entries(catalogues)) {
        await run('up', { direct: true, connectionString: adminURI, namespace: allNamespaces[kind], catalogue });
      }
      admin = new Client({ connectionString: adminURI });
      await admin.connect();
      for (const name of ['preview_app', 'preview_check', 'preview_settings']) {
        const password = random();
        await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        if (name !== 'preview_settings') await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(allNamespaces).join(', ')} TO ${name}`);
        const url = new URL(adminURI);
        url.username = name;
        url.password = password;
        if (name === 'preview_app') appURI = url.toString(); else if (name === 'preview_check') checkURI = url.toString(); else settingsURI = url.toString();
      }
      for (const namespace of Object.values(allNamespaces)) {
        await admin.query(`GRANT SELECT ON ${namespace}.schema_migrations TO preview_check`);
      }
      for (const logical of domainNames) {
        await require('./tenant-insertion-grants').grant(admin, { namespace: allNamespaces[logical], domain: logical,
          role: 'preview_app', catalogue: catalogues[logical] });
      }
      await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA preview_auth, preview_legacy TO preview_app');
      await admin.query('GRANT SELECT, INSERT ON preview_secrets.secret_records TO preview_app');
      await admin.query('GRANT INSERT ON preview_secrets.secret_audit TO preview_app');
      vaultRoot = random();
      execFileSync('docker', ['run', '--name', vaultName, '-d', '-p', '127.0.0.1::8200',
        '-e', 'VAULT_DEV_ROOT_TOKEN_ID', image, 'server', '-dev', '-dev-listen-address=0.0.0.0:8200'],
      { env: { ...process.env, VAULT_DEV_ROOT_TOKEN_ID: vaultRoot }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      vaultOwned = true;
      address = 'http://127.0.0.1:' + docker(['port', vaultName, '8200/tcp']).split(':').pop();
      await until(async () => {
        try {
          const response = await fetch(address + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
          await response.body.cancel();
          return response.ok;
        } catch { return false; }
      }, 'owned Vault');
      // Provisioning: the registry, each tenant's keys, root secret, anonymous denial and settings.
      await admin.query('CREATE ROLE preview_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
      provisioned = await provisionedTenants.create({ admin, adminURI, owner: 'preview_owner', vault: { address: address + '/', token: vaultRoot },
        namespaces: { authorization: 'preview_auth', secrets: 'preview_secrets', legacy: 'preview_legacy' } });
      for (const [i, tenant] of [A, B].entries()) roots[i] = (await provisioned.provision({ id: tenant, hosts: [HOSTS[i]], issueRootSecret: true })).rootSecret;
      for (const sql of provisioned.registryGrants({ resolvers: ['preview_app'], readers: ['preview_app'] })) await admin.query(sql);
      for (const namespace of [provisioned.namespaces.settings, provisioned.namespaces.operatorPolicy]) {
        await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO preview_settings`);
        await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${namespace}" TO preview_settings`);
      }
      // Lab priming beyond provisioning: a subject, its role and legacy name.
      for (const [i, tenant] of [A, B].entries()) {
        await admin.query('INSERT INTO preview_legacy.legacy_credential_subjects VALUES ($1, $2, $3)', [tenant, SUBJECT, 'sameviewer']);
        await admin.query(`INSERT INTO preview_auth.tenant_authorization_subjects
          (tenant_id, subject_id, display_name) VALUES ($1, $2, $3)`, [tenant, SUBJECT, 'Synthetic Viewer ' + i]);
        await admin.query(`INSERT INTO preview_auth.tenant_authorization_roles VALUES
          ($1, 'viewer', $2)`, [tenant, permissions]);
        await admin.query("INSERT INTO preview_auth.tenant_authorization_subject_roles VALUES ($1, $2, 'viewer')", [tenant, SUBJECT]);
      }
      // The api role's one Vault credential, scoped by key purpose.
      await vault('sys/policies/acl/preview-api', { policy: [
        'path "transit/decrypt/tenant-data-*" { capabilities = ["update"] }',
        'path "transit/hmac/tenant-signing-*" { capabilities = ["update"] }',
        'path "transit/verify/tenant-signing-*" { capabilities = ["update"] }'].join('\n') });
      roleToken = (await vault('auth/token/create', { policies: ['preview-api'], no_default_policy: true, ttl: '15m', renewable: false })).auth.client_token;
      proof = await prestart.install(admin, { namespace: PROOF_NAMESPACE, adminURI, readers: ['preview_app', 'preview_check'] });
    }

    async function close () {
      for (const worker of children) {
        if (!worker.exit) worker.child.kill('SIGKILL');
        await worker.exited;
      }
      if (provisioned) await provisioned.close();
      if (admin) await admin.end();
      if (vaultOwned) docker(['rm', '-f', '-v', vaultName]);
      if (pgOwned) docker(['rm', '-f', '-v', pgName]);
      fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }

    async function rows (domain, tenant = A) {
      assert.ok(domainNames.includes(domain));
      return (await admin.query(`SELECT doc FROM ${allNamespaces[domain]}.${domain}
        WHERE tenant_id=$1 ORDER BY "_id", id_kind`, [tenant])).rows.map(row => row.doc);
    }
    async function reset () {
      for (const domain of domainNames) await admin.query(`DELETE FROM ${allNamespaces[domain]}.${domain}`);
      await grants(permissions);
      await admin.query("UPDATE preview_auth.tenant_authorization_subjects SET display_name='Synthetic Viewer 0' WHERE tenant_id=$1", [A]);
    }
    async function grants (value, tenant = A) {
      await admin.query('UPDATE preview_auth.tenant_authorization_roles SET permissions=$1 WHERE tenant_id=$2', [value, tenant]);
    }
    const credential = tenant => 'sameviewer-' + hash(hash(roots[tenant === B ? 1 : 0]) + SUBJECT).slice(0, 16);
    const rootCredential = tenant => hash(roots[tenant === B ? 1 : 0]);
    return { A, B, open, close, start, ready, stop, http, exchange, rows, reset, grants,
      credential, rootCredential, permissions };
};
