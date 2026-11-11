'use strict';

// covers: lib/server/serve/preview-api.js, lib/server/serve/preview-config.js, lib/cli/commands/multitenant.js, lib/server/serve/index.js, lib/tenant-authorization/access-token.js, lib/tenant-authorization/access-postgres.js
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
  require('../../lib/server/serve/postgres-domains').get(logical).catalogue;
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

// A fixture-only response barrier: the actual handler reaches end() after its
// storage operation resolves. Parent independently confirms the committed row
// before killing this process; the client has not received a success response.
if (process.env.NS_PREVIEW_REPLICA_HOLD_RESPONSE === '1') {
  const http = require('node:http');
  const end = http.ServerResponse.prototype.end;
  http.ServerResponse.prototype.end = function (...args) {
    if (this.req.method === 'POST' && (this.req.originalUrl || this.req.url).startsWith('/api/v3/entries') && this.statusCode === 201) {
      process.stdout.write('REPLICA_POSTCOMMIT_RESPONSE_HELD\n');
      return this;
    }
    return end.apply(this, args);
  };
}

module.exports = function createReplicaFixture () {
    const suffix = crypto.randomBytes(8).toString('hex');
    const pgName = 'ns-preview-replicas-pg-' + suffix, vaultName = 'ns-preview-replicas-vault-' + suffix;
    // Outside the package: no cwd-relative implicit config or secrets file.
    const fixtureDirectory = path.resolve(root, '..', '.replica-preview-fixtures-' + suffix);
    const configFile = path.join(fixtureDirectory, 'preview.json');
    const roots = [random(), random()], children = new Set(), tokens = [], publicKeys = [];
    let pgOwned = false, vaultOwned = false, admin, adminURI, appURI, checkURI, address, vaultRoot;

    async function until (probe, label) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await probe()) return;
        await delay(100);
      }
      throw new Error(label + ' did not become ready');
    }

    async function vault (resource, body, credential = vaultRoot) {
      const response = await fetch(address + '/v1/' + resource, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'X-Vault-Token': credential, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)
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
        PREVIEW_APP_PG: appURI, PREVIEW_CHECK_PG: checkURI,
        PREVIEW_VAULT_0: tokens[0], PREVIEW_VAULT_1: tokens[1]
      };
      for (const key of ['NS_PREVIEW_REPLICA_CONTROL', 'NS_PREVIEW_REPLICA_CLOCK_MS']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      return { ...env, ...extra };
    }

    function start (config = localConfiguration(), extra = {}, options = {}) {
      const workerConfig = path.join(fixtureDirectory, 'preview-' + random() + '.json');
      fs.writeFileSync(workerConfig, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 });
      const preload = (extra.NS_PREVIEW_REPLICA_CONTROL || process.env.NS_PREVIEW_REPLICA_CONTROL) ?
        ['--require', path.join(__dirname, 'multitenant-preview-replica-controls.js')] : [];
      if (options.holdResponse) preload.push('--require', __filename);
      const roles = options.roles || 'api';
      assert.ok(['api', 'api,tenant-admin', 'tenant-admin,api'].includes(roles), 'explicit fixture CLI roles required');
      const child = spawn(process.execPath, [...preload, BIN, 'multitenant', roles], {
        cwd: fixtureDirectory, env: environment({ ...extra, MULTITENANT_PREVIEW_CONFIG: workerConfig,
          ...(options.holdResponse ? { NS_PREVIEW_REPLICA_HOLD_RESPONSE: '1' } : {}) }), stdio: ['ignore', 'pipe', 'pipe']
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
      const unexpected = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(worker.stdout);
      if (unexpected) worker.port = Number(unexpected[1]);
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

    function localConfiguration () {
      const config = configuration(address, true);
      config.postgres.namespaces = { ...config.postgres.namespaces, access: 'preview_access' };
      config.accessTokens = { issuer: 'nightscout-test', audience: 'nightscout-data', keys: publicKeys.map(key => ({ ...key })) };
      return config;
    }

    async function localToken (tenant, overrides = {}, headerOverrides = {}) {
      const now = Math.floor(Date.now() / 1000), i = tenant === A ? 0 : 1;
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'key1', ...headerOverrides })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: 'nightscout-test', aud: 'nightscout-data', tid: tenant,
        purpose: 'data', sub: SUBJECT, sid: 'local-session', cv: 1, iat: now, nbf: now, exp: now + 28800,
        ...overrides })).toString('base64url');
      const input = header + '.' + body;
      const signed = await vault('transit/sign/tenant-' + i + '-access', {
        input: Buffer.from(input).toString('base64'), key_version: 1
      }, tokens[i]);
      return input + '.' + Buffer.from(signed.data.signature.split(':')[2], 'base64').toString('base64url');
    }


    async function setup () {
      fs.mkdirSync(fixtureDirectory, { mode: 0o700 });
      const pgPassword = random();
      execFileSync('docker', ['run', '--rm', '--name', pgName, '-d', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_USER=operator', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=preview_replicas_test', 'postgres:16'],
      { env: { ...process.env, POSTGRES_PASSWORD: pgPassword }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
      pgOwned = true;
      const pgPort = docker(['port', pgName, '5432/tcp']).split(':').pop();
      adminURI = 'postgres://operator:' + pgPassword + '@127.0.0.1:' + pgPort + '/preview_replicas_test';
      await until(async () => {
        try {
          docker(['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator', '-d', 'preview_replicas_test']);
          return true;
        } catch { return false; }
      }, 'owned PostgreSQL');
      for (const [kind, catalogue] of Object.entries(catalogues)) {
        await run('up', { direct: true, connectionString: adminURI, namespace: allNamespaces[kind], catalogue });
      }
      await run('up', { direct: true, connectionString: adminURI, namespace: 'preview_access',
        catalogue: require('../../lib/tenant-authorization/access-candidate.json') });
      admin = new Client({ connectionString: adminURI });
      await admin.connect();
      for (const name of ['preview_app', 'preview_check']) {
        const password = random();
        await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        await admin.query(`GRANT USAGE ON SCHEMA ${Object.values(allNamespaces).concat(['preview_access']).join(', ')} TO ${name}`);
        const url = new URL(adminURI);
        url.username = name;
        url.password = password;
        if (name === 'preview_app') appURI = url.toString(); else checkURI = url.toString();
      }
      for (const namespace of Object.values(allNamespaces)) {
        await admin.query(`GRANT SELECT ON ${namespace}.schema_migrations TO preview_check`);
      }
      for (const logical of domainNames) {
        await require('./tenant-insertion-grants').grant(admin, { namespace: allNamespaces[logical], domain: logical,
          role: 'preview_app', catalogue: catalogues[logical] });
      }
      await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA preview_auth, preview_legacy TO preview_app');
      await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA preview_access TO preview_app');
      await admin.query('GRANT SELECT ON preview_access.schema_migrations TO preview_check');
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
        await vault('transit/keys/tenant-' + i + '-access', { type: 'ed25519', exportable: false });
        publicKeys[i] = { tenant, kid: 'key1', publicKey: (await vault('transit/keys/tenant-' + i + '-access')).data.keys['1'].public_key };
        await admin.query('INSERT INTO preview_access.access_tenants VALUES ($1,true)', [tenant]);
        await admin.query('INSERT INTO preview_access.access_credentials VALUES ($1,$2,$2,1,true)', [tenant, SUBJECT]);
        await admin.query(`INSERT INTO preview_access.access_sessions VALUES ($1,'local-session',$2,$2,1,$3,true,'data')`,
          [tenant, SUBJECT, Math.floor(Date.now() / 1000) + 86400]);
        await admin.query(`INSERT INTO preview_access.access_keys VALUES ($1,'key1','data',true)`, [tenant]);
        const policy = ['decrypt'].map(operation =>
          `path "transit/${operation}/tenant-${i}-data" { capabilities = ["update"] }`).concat(
          ['hmac', 'verify'].map(operation =>
            `path "transit/${operation}/tenant-${i}-signing" { capabilities = ["update"] }`)).concat(
          [`path "transit/sign/tenant-${i}-access" { capabilities = ["update"] }`]).join('\n');
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
    function removeOwnedContainer (name) {
      // Images may declare anonymous database volumes. Capture exact ownership
      // before removal, then verify that rm -v removed only these owned volumes.
      const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', name]));
      const volumes = mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name);
      console.log('REPLICA_OWNED_VOLUME_CLEANUP ' + JSON.stringify({ container: name, volumes }));
      docker(['rm', '-fv', name]);
      for (const volume of volumes) {
        assert.throws(() => docker(['volume', 'inspect', volume]), /no such volume/i,
          'owned anonymous volume must be removed with its container');
      }
    }

    async function cleanup () {
      const errors = [];
      for (const worker of children) {
        try {
          if (!worker.exit) worker.child.kill('SIGKILL');
          await worker.exited;
        } catch (error) { errors.push(error); }
      }
      try { if (admin) await admin.end(); } catch (error) { errors.push(error); }
      // Attempt every owned cleanup even when one resource is unavailable.
      for (const name of [vaultOwned && vaultName, pgOwned && pgName].filter(Boolean)) {
        try { removeOwnedContainer(name); } catch (error) { errors.push(error); }
      }
      try { fs.rmSync(fixtureDirectory, { recursive: true, force: true }); }
      catch (error) { errors.push(error); }
      if (errors.length) throw new globalThis.AggregateError(errors, 'Owned replica fixture cleanup failed');
    }
    async function kill (worker) {
      worker.child.kill('SIGKILL');
      const result = await worker.exited;
      assert.deepEqual(result, { code: null, signal: 'SIGKILL' });
      children.delete(worker);
    }
    return { setup, cleanup, start, ready, stop, kill, refused, http, exchange, localToken,
      configuration: localConfiguration, until, tenants: [A, B],
      get admin () { return admin; }, get workers () { return children; } };
};
