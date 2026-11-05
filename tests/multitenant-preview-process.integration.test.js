'use strict';

// covers: lib/server/serve/preview-api.js, lib/server/serve/preview-config.js, lib/cli/commands/multitenant.js, lib/server/serve/index.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const httpRequest = require('node:http').request;
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const { optInSuite } = require('./support/opt-in');

const root = path.resolve(__dirname, '..');
const BIN = path.join(root, 'bin/nightscout.js');
const image = 'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const namespaces = { entries: 'preview_data', authorization: 'preview_auth', secrets: 'preview_secrets', legacy: 'preview_legacy' };
const catalogues = {
  entries: require('../migrations/candidates/postgres-entries-v1.json'),
  authorization: require('../lib/tenant-authorization/postgres-candidate.json'),
  secrets: require('../lib/secrets/postgres-candidate.json'),
  legacy: require('../lib/secrets/legacy-credentials-candidate.json')
};
const random = () => crypto.randomBytes(24).toString('hex');
const hash = value => crypto.createHash('sha1').update(value).digest('hex');
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000
}).trim();

function configuration (address) {
  return {
    version: 1,
    postgres: { connectionEnv: 'PREVIEW_APP_PG', readinessConnectionEnv: 'PREVIEW_CHECK_PG', namespaces },
    vault: { address, mount: 'transit', allowInsecureLoopback: true, timeoutMs: 1000 },
    resolution: { mode: 'direct-alias' },
    tenants: [A, B].map((id, i) => ({
      id, aliases: [(i ? 'two' : 'one') + '.example.test'],
      vault: { tokenEnv: 'PREVIEW_VAULT_' + i, encryptionKey: 'tenant-' + i + '-data',
        signingKey: 'tenant-' + i + '-signing', signingVersion: 1 }
    }))
  };
}

optInSuite(process.env.NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST === '1',
  'NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST=1')(
  'executable nightscout multitenant api preview (owned PostgreSQL/Vault)', function () {
    this.timeout(120000);
    const suffix = crypto.randomBytes(8).toString('hex');
    const pgName = 'ns-preview-process-pg-' + suffix, vaultName = 'ns-preview-process-vault-' + suffix;
    // Outside the package: no cwd-relative implicit config or secrets file.
    const fixtureDirectory = path.resolve(root, '..', '.runnable-preview-fixtures-' + suffix);
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

    function start (config = configuration(address), extra) {
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

    async function refused (config, extra) {
      const worker = start(config, extra);
      await until(async () => worker.exit !== null || /Listening/.test(worker.stdout), 'refused preview termination');
      assert.doesNotMatch(worker.stdout, /Listening/, 'refused configuration must never bind');
      const exit = await worker.exited;
      assert.deepEqual(exit, { code: 78, signal: null });
      assert.doesNotMatch(worker.stdout, /Listening/);
      for (const credential of [appURI, checkURI, vaultRoot, ...tokens, ...roots]) {
        assert.ok(!worker.stderr.includes(credential), 'startup diagnostic must not disclose credentials');
      }
      children.delete(worker);
      return worker;
    }

    async function http (worker, tenant, method, resource, credential, body, selectors = {}) {
      // node:http preserves an explicit Host on the actual wire; fetch may
      // replace it with its URL authority.
      return new Promise((resolve, reject) => {
        const request = httpRequest({
          hostname: '127.0.0.1', port: worker.port, path: resource, method,
          headers: {
            Host: tenant === A ? 'one.example.test' : 'two.example.test',
            ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...selectors
          }, signal: AbortSignal.timeout(5000), agent: false
        }, response => {
          let bytes = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { bytes += chunk; });
          response.on('end', () => {
            try { resolve({ status: response.statusCode, body: JSON.parse(bytes) }); } catch (error) { reject(error); }
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

    before(async function () {
      fs.mkdirSync(fixtureDirectory, { mode: 0o700 });
      const pgPassword = random();
      execFileSync('docker', ['run', '--rm', '--name', pgName, '-d', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=preview', 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: pgPassword }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      pgOwned = true;
      const pgPort = docker(['port', pgName, '5432/tcp']).split(':').pop();
      adminURI = 'postgres://operator:' + pgPassword + '@127.0.0.1:' + pgPort + '/preview';
      await until(async () => {
        try {
          docker(['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'preview']);
          return true;
        } catch { return false; }
      }, 'owned PostgreSQL');
      for (const [kind, catalogue] of Object.entries(catalogues)) {
        await run('up', { direct: true, connectionString: adminURI, namespace: namespaces[kind], catalogue });
      }
      admin = new Client({ connectionString: adminURI });
      await admin.connect();
      for (const name of ['preview_app', 'preview_check']) {
        const password = random();
        await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(namespaces).join(', ')} TO ${name}`);
        const url = new URL(adminURI);
        url.username = name;
        url.password = password;
        if (name === 'preview_app') appURI = url.toString(); else checkURI = url.toString();
      }
      for (const namespace of Object.values(namespaces)) {
        await admin.query(`GRANT SELECT ON ${namespace}.schema_migrations TO preview_check`);
      }
      await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON preview_data.entries TO preview_app');
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
          ($1, 'viewer', ARRAY['api:entries:read','api:entries:create','api:entries:update'])`, [tenant]);
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
    });

    after(async function () {
      for (const worker of children) {
        if (!worker.exit) worker.child.kill('SIGKILL');
        await worker.exited;
      }
      if (admin) await admin.end();
      if (vaultOwned) docker(['rm', '-f', vaultName]);
      if (pgOwned) docker(['rm', '-f', pgName]);
      fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    });

    afterEach(async function () {
      for (const worker of children) {
        if (!worker.exit) worker.child.kill('SIGTERM');
        await worker.exited;
        children.delete(worker);
      }
    });

    it('runs the executable with no single secrets/Mongo and preserves tenant writes across process restart', async function () {
      const first = start();
      await ready(first);
      const credentials = [];
      for (const [i, tenant] of [A, B].entries()) {
        const result = await exchange(first, tenant);
        assert.equal(result.status, 200);
        assert.equal(result.body.exp - result.body.iat, 28800);
        credentials[i] = result.body.token;
        const write = await http(first, tenant, 'POST', '/api/v3/entries', credentials[i],
          { identifier: 'shared-entry', type: 'sgv', date: 1700000000000, utcOffset: 0,
            app: 'synthetic-preview', sgv: 101 + i });
        assert.equal(write.status, 201, JSON.stringify(write.body));
      }
      assert.equal((await http(first, B, 'POST', '/api/v3/entries', credentials[0],
        { identifier: 'foreign-write', type: 'sgv', date: 1700000000001, utcOffset: 0,
          app: 'synthetic-preview', sgv: 999 })).status, 401);
      await stop(first);
      const second = start();
      await ready(second);
      for (const [i, tenant] of [A, B].entries()) {
        const read = await http(second, tenant, 'GET', '/api/v3/entries/shared-entry', credentials[i]);
        assert.equal(read.status, 200);
        assert.equal(read.body.result.sgv, 101 + i);
        const search = await http(second, tenant, 'GET', '/api/v3/entries?sgv$eq=' + (101 + i), credentials[i]);
        assert.equal(search.status, 200);
        assert.equal(search.body.result.length, 1);
      }
      assert.equal((await http(second, B, 'GET', '/api/v3/entries/foreign-write', credentials[1])).status, 404);
      assert.equal((await http(second, A, 'GET', '/api/v3/entries', credentials[0], undefined, { Host: 'unknown.example.test' })).status, 404);
      assert.equal((await http(second, A, 'GET', '/api/v3/entries', credentials[0], undefined, { 'X-Forwarded-Host': 'one.example.test' })).status, 400);
      for (const management of ['/api/v1/tenant/settings', '/api/v1/operator/tenants/' + A + '/policy']) {
        assert.equal((await http(second, A, 'GET', management, credentials[0])).status, 404);
      }
      await admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions = ARRAY['denied'] WHERE tenant_id = $1", [A]);
      try {
        assert.equal((await http(second, A, 'GET', '/api/v3/entries', credentials[0])).status, 403);
      } finally {
        await admin.query(`UPDATE preview_auth.tenant_authorization_roles SET permissions =
          ARRAY['api:entries:read','api:entries:create','api:entries:update'] WHERE tenant_id = $1`, [A]);
      }
      docker(['pause', vaultName]);
      try {
        assert.equal((await http(second, B, 'GET', '/api/v3/entries', credentials[1])).status, 503);
      } finally { docker(['unpause', vaultName]); }
      assert.equal((await http(second, B, 'GET', '/api/v3/entries', credentials[1])).status, 200);
      await stop(second);
      const active = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename IN ('preview_app','preview_check')");
      assert.equal(active.rows[0].count, 0, 'signal shutdown must release all PG pools');
    });

    it('refuses invalid config, missing environment references and unsafe/read-write readiness before binding', async function () {
      await refused('{invalid');
      const config = configuration(address);
      config.postgres.password = random();
      await refused(config);
      await refused(configuration(address), { PREVIEW_APP_PG: '' });
      await refused(configuration(address), { PREVIEW_CHECK_PG: appURI });
      await refused(configuration(address), { PREVIEW_APP_PG: adminURI });
      const remoteHTTP = configuration('http://192.0.2.1:8200');
      await refused(remoteHTTP);
      const ambiguous = configuration(address);
      ambiguous.tenants[1].aliases = ambiguous.tenants[0].aliases;
      await refused(ambiguous);
      const missingTrust = configuration(address);
      missingTrust.resolution = { mode: 'canonical-internal' };
      await refused(missingTrust);
      const stale = await admin.query('DELETE FROM preview_auth.schema_migrations WHERE name = (SELECT max(name) FROM preview_auth.schema_migrations) RETURNING name, checksum');
      try {
        await refused(configuration(address));
      } finally {
        const row = stale.rows[0];
        await admin.query('INSERT INTO preview_auth.schema_migrations(name,checksum) VALUES($1,$2)', [row.name, row.checksum]);
      }
      await admin.query('GRANT INSERT ON preview_data.entries TO preview_check');
      try { await refused(configuration(address)); } finally {
        await admin.query('REVOKE INSERT ON preview_data.entries FROM preview_check');
      }
    });

    it('cleans acquired pools after late initialization or listener failure', async function () {
      await admin.query('ALTER TABLE preview_data.entries NO FORCE ROW LEVEL SECURITY');
      try { await refused(configuration(address)); } finally {
        await admin.query('ALTER TABLE preview_data.entries FORCE ROW LEVEL SECURITY');
      }
      const occupied = net.createServer();
      occupied.listen(0, '127.0.0.1');
      await once(occupied, 'listening');
      try {
        const worker = start(configuration(address), { API_PORT: String(occupied.address().port) });
        assert.deepEqual(await worker.exited, { code: 1, signal: null });
        assert.doesNotMatch(worker.stderr, /postgres:|password|vault:/i);
        children.delete(worker);
      } finally { await new Promise(resolve => occupied.close(resolve)); }
      const active = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename IN ('preview_app','preview_check')");
      assert.equal(active.rows[0].count, 0);
    });

    it('requires an explicitly allowlisted immediate peer even for Host-only canonical requests', async function () {
      const config = configuration(address);
      config.resolution = { mode: 'canonical-internal', trustedPeers: ['127.0.0.1'] };
      config.tenants.forEach((tenant, i) => { tenant.canonicalHost = 'tenant-' + i + '.internal.test'; });
      const worker = start(config);
      await until(async () => {
        assert.equal(worker.exit, null, worker.stderr);
        const found = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(worker.stdout);
        if (!found) return false;
        worker.port = Number(found[1]);
        return true;
      }, 'canonical preview listener');
      const credential = 'sameviewer-' + hash(hash(roots[0]) + SUBJECT).slice(0, 16);
      const response = await http(worker, A, 'GET', '/api/v2/authorization/request/' + credential, undefined, undefined,
        { Host: 'tenant-0.internal.test', 'X-Forwarded-Host': 'disposable.example.test' });
      assert.equal(response.status, 200);
      await stop(worker);
      config.resolution.trustedPeers = ['127.0.0.2'];
      const untrusted = start(config);
      await until(async () => {
        assert.equal(untrusted.exit, null, untrusted.stderr);
        const found = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(untrusted.stdout);
        if (!found) return false;
        untrusted.port = Number(found[1]);
        return true;
      }, 'untrusted preview listener');
      assert.equal((await http(untrusted, A, 'GET', '/api/v3/entries', response.body.token, undefined,
        { Host: 'tenant-0.internal.test', 'X-Forwarded-For': '127.0.0.2' })).status, 400);
      await stop(untrusted);
    });
  });
