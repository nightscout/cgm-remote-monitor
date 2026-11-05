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
  require('../../lib/server/tenant-app/domain-catalogue').get(logical).catalogue;
const random = () => crypto.randomBytes(24).toString('hex');
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
}).trim();

function configuration (address, full = false) {
  return {
    version: 1,
    ...(full ? { domains: domainNames, legacy: true, context: true } : {}),
    postgres: { connectionEnv: 'PREVIEW_APP_PG', readinessConnectionEnv: 'PREVIEW_CHECK_PG',
      namespaces: full ? allNamespaces : namespaces },
    vault: { address, mount: 'transit', allowInsecureLoopback: true, timeoutMs: 1000 },
    resolution: { mode: 'direct-alias' },
    tenants: [A, B].map((id, i) => ({
      id, aliases: [(i ? 'two' : 'one') + '.example.test'],
      vault: { tokenEnv: 'PREVIEW_VAULT_' + i, encryptionKey: 'tenant-' + i + '-data',
        signingKey: 'tenant-' + i + '-signing', signingVersion: 1 }
    }))
  };
}

module.exports = function clientReplayHTTP () {
    const permissions = domainNames.flatMap(domain => ['read', 'create', 'update', 'delete'].map(action => 'api:' + domain + ':' + action));
    const suffix = crypto.randomBytes(8).toString('hex');
    const pgName = 'ns-client-replay-pg-' + suffix, vaultName = 'ns-client-replay-vault-' + suffix;
    // Outside the package: no cwd-relative implicit config or secrets file.
    const fixtureDirectory = path.resolve(root, '..', '.client-replay-test-' + suffix);
    const configFile = path.join(fixtureDirectory, 'preview.json');
    const roots = [random(), random()], children = new Set(), tokens = [];
    let pgOwned = false, vaultOwned = false, admin, adminURI, appURI, checkURI, address, vaultRoot;

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
        MULTITENANT_PREVIEW_CONFIG: configFile,
        API_HOSTNAME: '127.0.0.1', API_PORT: '0',
        PREVIEW_APP_PG: appURI, PREVIEW_CHECK_PG: checkURI,
        PREVIEW_VAULT_0: tokens[0], PREVIEW_VAULT_1: tokens[1]
      };
      for (const key of ['NODE_OPTIONS', 'NS_PREVIEW_PROCESS_CONTROL']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      return { ...env, ...extra };
    }

    function start (config = configuration(address, true), extra) {
      fs.writeFileSync(configFile, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 });
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
        const result = await http(worker, A, 'GET', '/api/v3/entries', undefined);
        assert.equal(result.status, 403, 'listener must answer through current anonymous authority');
        return true;
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
            Host: tenant === A ? 'one.example.test' : 'two.example.test',
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
      for (const name of ['preview_app', 'preview_check']) {
        const password = random();
        await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(allNamespaces).join(', ')} TO ${name}`);
        const url = new URL(adminURI);
        url.username = name;
        url.password = password;
        if (name === 'preview_app') appURI = url.toString(); else checkURI = url.toString();
      }
      for (const namespace of Object.values(allNamespaces)) {
        await admin.query(`GRANT SELECT ON ${namespace}.schema_migrations TO preview_check`);
      }
      for (const logical of domainNames) {
        await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${allNamespaces[logical]}.${logical} TO preview_app`);
        await admin.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${allNamespaces[logical]} TO preview_app`);
      }
      await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA preview_auth, preview_legacy TO preview_app');
      await admin.query('GRANT SELECT, INSERT ON preview_secrets.secret_records TO preview_app');
      await admin.query('GRANT INSERT ON preview_secrets.secret_audit TO preview_app');
      for (const [i, tenant] of [A, B].entries()) {
        await admin.query('INSERT INTO preview_legacy.legacy_credential_config VALUES ($1, $2)', [tenant, 'root-' + i]);
        await admin.query('INSERT INTO preview_legacy.legacy_credential_subjects VALUES ($1, $2, $3)', [tenant, SUBJECT, 'sameviewer']);
        await admin.query("INSERT INTO preview_auth.tenant_authorization_config VALUES ($1, ARRAY['denied'])", [tenant]);
        await admin.query(`INSERT INTO preview_auth.tenant_authorization_subjects
          (tenant_id, subject_id, display_name) VALUES ($1, $2, $3)`, [tenant, SUBJECT, 'Synthetic Viewer ' + i]);
        await admin.query(`INSERT INTO preview_auth.tenant_authorization_roles VALUES
          ($1, 'viewer', $2)`, [tenant, permissions]);
        await admin.query("INSERT INTO preview_auth.tenant_authorization_subject_roles VALUES ($1, $2, 'viewer')", [tenant, SUBJECT]);
      }
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
      await vault('sys/mounts/transit', { type: 'transit' });
      for (const [i, tenant] of [A, B].entries()) {
        for (const purpose of ['data', 'signing']) {
          await vault('transit/keys/tenant-' + i + '-' + purpose, { type: 'aes256-gcm96', exportable: false });
        }
        const policy = ['decrypt'].map(operation =>
          `path "transit/${operation}/tenant-${i}-data" { capabilities = ["update"] }`).concat(
          ['hmac', 'verify'].map(operation =>
            `path "transit/${operation}/tenant-${i}-signing" { capabilities = ["update"] }`)).join('\n');
        await vault('sys/policies/acl/tenant-' + i, { policy });
        tokens[i] = (await vault('auth/token/create', {
          policies: ['tenant-' + i], no_default_policy: true, ttl: '15m', renewable: false
        })).auth.client_token;
        const envelope = Buffer.from(JSON.stringify({ tenant, id: 'root-' + i, data: Buffer.from(roots[i]).toString('base64') }));
        const encrypted = await vault('transit/encrypt/tenant-' + i + '-data', { plaintext: envelope.toString('base64') });
        await admin.query('INSERT INTO preview_secrets.secret_records (tenant_id,id,format,ciphertext) VALUES ($1,$2,1,$3)',
          [tenant, 'root-' + i, encrypted.data.ciphertext]);
      }
    }

    async function close () {
      for (const worker of children) {
        if (!worker.exit) worker.child.kill('SIGKILL');
        await worker.exited;
      }
      if (admin) await admin.end();
      if (vaultOwned) docker(['rm', '-f', vaultName]);
      if (pgOwned) docker(['rm', '-f', pgName]);
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
