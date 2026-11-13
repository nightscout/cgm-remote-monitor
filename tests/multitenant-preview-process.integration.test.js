'use strict';

// covers: lib/server/serve/preview-api.js, lib/server/serve/preview-config.js, lib/cli/commands/multitenant.js, lib/server/serve/index.js, lib/tenant-authorization/access-token.js, lib/tenant-authorization/access-postgres.js
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
const domainNames = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];
const allNamespaces = { ...namespaces, ...Object.fromEntries(domainNames.filter(name => name !== 'entries')
  .map(name => [name, 'preview_' + name])) };
const catalogues = {
  entries: require('../migrations/candidates/postgres-entries-v1.json'),
  authorization: require('../lib/tenant-authorization/postgres-candidate.json'),
  secrets: require('../lib/secrets/postgres-candidate.json'),
  legacy: require('../lib/secrets/legacy-credentials-candidate.json')
};
for (const logical of domainNames) catalogues[logical] =
  require('../lib/server/serve/postgres-domains').get(logical).catalogue;
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

optInSuite(process.env.NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST === '1',
  'NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST=1')(
  'executable nightscout multitenant api preview (owned PostgreSQL/Vault)', function () {
    this.timeout(120000);
    const suffix = crypto.randomBytes(8).toString('hex');
    const pgName = 'ns-preview-process-pg-' + suffix, vaultName = 'ns-preview-process-vault-' + suffix;
    // Outside the package: no cwd-relative implicit config or secrets file.
    const fixtureDirectory = path.resolve(root, '..', '.runnable-preview-fixtures-' + suffix);
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
        PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', NODE_ENV: 'test', MULTITENANT_STATIC_TENANTS: 'lab',
        // Acceptance runs with every tenant initialized before the listener
        // opens (decision readiness-serve-then-warm); extra may override.
        NS_TENANT_READINESS: 'all',
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
        await run('up', { direct: true, connectionString: adminURI, namespace: allNamespaces[kind], catalogue });
      }
      await run('up', { direct: true, connectionString: adminURI, namespace: 'preview_access',
        catalogue: require('../lib/tenant-authorization/access-candidate.json') });
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
        await require('./fixtures/tenant-insertion-grants').grant(admin, { namespace: allNamespaces[logical], domain: logical,
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
    });

    after(async function () {
      for (const worker of children) {
        if (!worker.exit) worker.child.kill('SIGKILL');
        await worker.exited;
      }
      if (admin) await admin.end();
      if (vaultOwned) docker(['rm', '-f', '-v', vaultName]);
      if (pgOwned) docker(['rm', '-f', '-v', pgName]);
      fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    });

    afterEach(async function () {
      for (const worker of children) {
        if (!worker.exit) worker.child.kill('SIGTERM');
        await worker.exited;
        children.delete(worker);
      }
    });

    it('new-format actual API reads and writes use local keys and current PostgreSQL across processes', async function () {
      const first = start(localConfiguration()), second = start(localConfiguration());
      await ready(first); await ready(second);
      const a = await localToken(A), b = await localToken(B);
      const auditBefore = Number((await admin.query('SELECT count(*) FROM preview_secrets.secret_audit')).rows[0].count);
      for (const worker of [first, second]) {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', a)).status, 200);
        assert.equal((await http(worker, B, 'GET', '/api/v3/entries', b)).status, 200);
        const write = await http(worker, A, 'POST', '/api/v3/entries', a, {
          identifier: 'local-' + worker.port, date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 140, app: 'synthetic-local'
        });
        assert.equal(write.status, 201, JSON.stringify(write.body));
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-' + worker.port, a)).body.result.subject, 'Synthetic Viewer 0');
        assert.equal((await http(worker, A, 'PATCH', '/api/v3/entries/local-' + worker.port, a, { sgv: 143 })).status, 200);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-' + worker.port, a)).body.result.modifiedBy, 'Synthetic Viewer 0');
        const foreign = await http(worker, B, 'GET', '/api/v3/entries', a);
        assert.equal(foreign.status, 401); assert.equal(foreign.body.error, 'TOKEN_SIGNATURE');
        assert.equal((await http(worker, A, 'GET', '/api/v1/entries', a)).status, 200);
        assert.equal((await http(worker, A, 'GET', '/api/v2/authorization/permissions', a)).status, 401);
      }
      assert.equal(Number((await admin.query('SELECT count(*) FROM preview_secrets.secret_audit')).rows[0].count), auditBefore,
        'new-format requests must never call the audited secrets component');
      const old = await exchange(first, A);
      assert.equal(old.status, 200); assert.equal(old.body.exp - old.body.iat, 28800);
      assert.equal((await http(first, A, 'GET', '/api/v3/entries', old.body.token)).status, 200);
      await stop(first); await stop(second);
    });

    it('new-format signature and audience controls refuse before any handler effect', async function () {
      const worker = start(localConfiguration()); await ready(worker);
      const token = await localToken(A), parts = token.split('.');
      const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
      parts[2] = signature.toString('base64url');
      const invalid = [parts.join('.'), await localToken(A, { aud: 'wrong-audience' }),
        await localToken(A, { purpose: 'management' }), await localToken(A, { tid: B }),
        await localToken(A, {}, { kid: 'unknown' }), await localToken(A, { exp: Math.floor(Date.now() / 1000) - 1 })];
      for (const credential of invalid) {
        const result = await http(worker, A, 'POST', '/api/v3/entries', credential, {
          identifier: 'must-not-write-local', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 999, app: 'synthetic-local'
        });
        assert.equal(result.status, 401, 'invalid new token must refuse: ' + JSON.stringify(result.body));
      }
      assert.equal((await admin.query("SELECT count(*)::int n FROM preview_data.entries WHERE doc->>'identifier'='must-not-write-local'")).rows[0].n, 0);
      await stop(worker);
    });

    it('new-format same-token grant and session revocation are current across independent API processes', async function () {
      const first = start(localConfiguration()), second = start(localConfiguration());
      await ready(first); await ready(second);
      const token = await localToken(A);
      for (const worker of [first, second]) assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 200);
      await admin.query('BEGIN');
      await admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=ARRAY['denied'] WHERE tenant_id=$1", [A]);
      assert.equal((await http(second, A, 'GET', '/api/v3/entries', token)).status, 200);
      await admin.query('COMMIT');
      try {
        for (const worker of [first, second]) assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 403);
      } finally {
        await admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=ARRAY['api:entries:read','api:entries:create','api:entries:update'] WHERE tenant_id=$1", [A]);
      }
      for (const [table, change, restore] of [
        ['access_sessions', 'active=false', 'active=true'],
        ['access_credentials', 'generation=2', 'generation=1'],
        ['access_keys', 'active=false', 'active=true'],
        ['access_tenants', 'active=false', 'active=true']
      ]) {
        for (const worker of [first, second]) assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 200);
        await admin.query('UPDATE preview_access.' + table + ' SET ' + change + ' WHERE tenant_id=$1', [A]);
        try {
          for (const worker of [first, second]) {
            assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 403, table);
            assert.equal((await http(worker, A, 'POST', '/api/v3/entries', token, {
              identifier: 'local-revoked-' + table, date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 999, app: 'synthetic-local'
            })).status, 403, table + ' write');
          }
          assert.equal((await admin.query("SELECT count(*)::int n FROM preview_data.entries WHERE doc->>'identifier'=$1", ['local-revoked-' + table])).rows[0].n, 0);
        } finally { await admin.query('UPDATE preview_access.' + table + ' SET ' + restore + ' WHERE tenant_id=$1', [A]); }
      }
      await stop(first); await stop(second);
    });

    it('new-format preserves default-role validation from the current authority', async function () {
      const worker = start(localConfiguration()); await ready(worker);
      const local = await localToken(A), old = (await exchange(worker, A)).body.token;
      await admin.query("UPDATE preview_auth.tenant_authorization_config SET anonymous_roles=ARRAY['readable','readable'] WHERE tenant_id=$1", [A]);
      try {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', old)).status, 503, 'existing authority rejects malformed defaults');
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', local)).status, 503, 'new snapshot must reject malformed defaults too');
      } finally { await admin.query("UPDATE preview_auth.tenant_authorization_config SET anonymous_roles=ARRAY['denied'] WHERE tenant_id=$1", [A]); }
      await stop(worker);
    });

    it('new-format preserves incomplete-name reads and refuses unattributed writes', async function () {
      const worker = start(localConfiguration()); await ready(worker);
      const local = await localToken(A), old = (await exchange(worker, A)).body.token;
      assert.equal((await http(worker, A, 'POST', '/api/v3/entries', local, {
        identifier: 'local-null-name', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 145, app: 'synthetic-local'
      })).status, 201);
      await admin.query('UPDATE preview_auth.tenant_authorization_subjects SET display_name=NULL WHERE tenant_id=$1', [A]);
      try {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-null-name', old)).status, 200, 'existing read allows incomplete name metadata');
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-null-name', local)).status, 200, 'new read preserves this metadata behavior');
        for (const credential of [old, local]) assert.equal((await http(worker, A, 'PATCH', '/api/v3/entries/local-null-name', credential, { sgv: 999 })).status, 401);
        const stored = await admin.query("SELECT doc FROM preview_data.entries WHERE tenant_id=$1 AND doc->>'identifier'='local-null-name'", [A]);
        assert.equal(stored.rows[0].doc.sgv, 145);
      } finally { await admin.query("UPDATE preview_auth.tenant_authorization_subjects SET display_name='Synthetic Viewer 0' WHERE tenant_id=$1", [A]); }
      await stop(worker);
    });

    it('new-format startup refuses shared tenant keys and unsafe access-state privileges before binding', async function () {
      const config = localConfiguration();
      config.accessTokens.keys[1].publicKey = config.accessTokens.keys[0].publicKey;
      await refused(config);
      await admin.query('GRANT UPDATE ON preview_access.access_sessions TO preview_app');
      try { await refused(localConfiguration()); }
      finally { await admin.query('REVOKE UPDATE ON preview_access.access_sessions FROM preview_app'); }
      await admin.query('ALTER TABLE preview_access.access_keys DISABLE ROW LEVEL SECURITY');
      try { await refused(localConfiguration()); }
      finally { await admin.query('ALTER TABLE preview_access.access_keys ENABLE ROW LEVEL SECURITY'); }
    });

    it('new-format API continues through Vault outage but refuses an unavailable PostgreSQL authority', async function () {
      const worker = start(localConfiguration()); await ready(worker);
      const token = await localToken(A), old = await exchange(worker, A);
      docker(['pause', vaultName]);
      try {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 200);
        assert.equal((await http(worker, A, 'POST', '/api/v3/entries', token, {
          identifier: 'local-vault-down', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 142, app: 'synthetic-local'
        })).status, 201);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', old.body.token)).status, 503);
        await admin.query('UPDATE preview_access.access_sessions SET active=false WHERE tenant_id=$1', [A]);
        try { assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 403); }
        finally { await admin.query('UPDATE preview_access.access_sessions SET active=true WHERE tenant_id=$1', [A]); }
      } finally { docker(['unpause', vaultName]); }
      docker(['pause', pgName]);
      try {
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries', token)).status, 503);
        assert.equal((await http(worker, A, 'POST', '/api/v3/entries', token, {
          identifier: 'local-pg-down', date: 1793664000000, utcOffset: 0, type: 'sgv', sgv: 999, app: 'synthetic-local'
        })).status, 503);
      } finally { docker(['unpause', pgName]); }
      assert.equal((await http(worker, A, 'GET', '/api/v3/entries/local-pg-down', token)).status, 404);
      await stop(worker);
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

    it('runs entries replace, PATCH, logical delete, history and permanent delete through the executable', async function () {
      const baseGrants = ['api:entries:read', 'api:entries:create', 'api:entries:update'];
      const worker = start();
      await ready(worker);
      const credentials = [];
      for (const [i, tenant] of [A, B].entries()) {
        const exchanged = await exchange(worker, tenant);
        assert.equal(exchanged.status, 200);
        credentials[i] = exchanged.body.token;
        const created = await http(worker, tenant, 'POST', '/api/v3/entries', credentials[i], {
          identifier: 'crud-overlap', type: 'sgv', date: 1793664000000,
          utcOffset: 0, app: 'synthetic-crud', sgv: 111 + i
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
      }

      const rows = async tenant => (await admin.query(
        `SELECT doc FROM preview_data.entries WHERE tenant_id = $1 AND doc->>'identifier' = $2`,
        [tenant, 'crud-overlap'])).rows.map(row => row.doc);
      const changeGrants = permissions => admin.query(
        'UPDATE preview_auth.tenant_authorization_roles SET permissions = $1 WHERE tenant_id = $2 AND name = $3',
        [permissions, A, 'viewer']);
      const originalA = await rows(A);
      const originalB = await rows(B);
      assert.equal(originalA.length, 1);
      assert.equal(originalB.length, 1);
      if (process.env.NS_PREVIEW_PROCESS_CONTROL === 'intent') {
        const failedMutation = await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap',
          credentials[0], { sgv: 125 });
        assert.equal(failedMutation.status, 500);
        assert.deepEqual(await rows(A), originalA);
        return;
      }

      try {
        await changeGrants(['api:entries:read', 'api:entries:create']);
        const deniedReplace = await http(worker, A, 'PUT', '/api/v3/entries/crud-overlap',
          credentials[0], { identifier: 'body-identifier-is-ignored', type: 'sgv', date: 1793664000000,
            utcOffset: 0, app: 'synthetic-crud', sgv: 120 });
        assert.equal(deniedReplace.status, 403);
        assert.deepEqual(await rows(A), originalA);

        await changeGrants(baseGrants);
        const replaced = await http(worker, A, 'PUT', '/api/v3/entries/crud-overlap',
          credentials[0], { identifier: 'body-identifier-is-ignored', type: 'sgv', date: 1793664000000,
            utcOffset: 0, app: 'synthetic-crud', sgv: 121 });
        assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
        assert.ok(replaced.headers['last-modified']);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).body.result.sgv, 121);
        assert.equal((await http(worker, B, 'GET', '/api/v3/entries/crud-overlap', credentials[1])).body.result.sgv, 112);

        const patched = await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap', credentials[0],
          { sgv: 122, extension: { retained: true } });
        assert.equal(patched.status, 200, JSON.stringify(patched.body));
        const afterPatch = (await rows(A))[0];
        assert.equal(afterPatch.identifier, 'crud-overlap');
        assert.equal(afterPatch.sgv, 122);
        assert.deepEqual(afterPatch.extension, { retained: true });
        assert.equal(afterPatch.modifiedBy, 'Synthetic Viewer 0');
        assert.deepEqual(await rows(B), originalB);

        await admin.query('UPDATE preview_auth.tenant_authorization_subjects SET display_name = NULL WHERE tenant_id = $1 AND subject_id = $2',
          [A, SUBJECT]);
        try {
          const missingName = await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap', credentials[0], { sgv: 123 });
          assert.equal(missingName.status, 401);
          assert.deepEqual(await rows(A), [afterPatch]);
        } finally {
          await admin.query('UPDATE preview_auth.tenant_authorization_subjects SET display_name = $1 WHERE tenant_id = $2 AND subject_id = $3',
            ['Synthetic Viewer 0', A, SUBJECT]);
        }
        assert.equal((await http(worker, A, 'PATCH', '/api/v3/entries/crud-overlap', undefined, { sgv: 123 })).status, 403);
        assert.equal((await http(worker, B, 'PATCH', '/api/v3/entries/crud-overlap', credentials[0], { sgv: 123 })).status, 401);

        const deniedDelete = await http(worker, A, 'DELETE', '/api/v3/entries/crud-overlap', credentials[0]);
        assert.equal(deniedDelete.status, 403);
        assert.deepEqual(await rows(A), [afterPatch]);
        await changeGrants([...baseGrants, 'api:entries:delete']);

        const logicalDelete = await http(worker, A, 'DELETE', '/api/v3/entries/crud-overlap', credentials[0]);
        assert.equal(logicalDelete.status, 200, JSON.stringify(logicalDelete.body));
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).status, 410);
        const history = await http(worker, A, 'GET', '/api/v3/entries/history/1793664000000', credentials[0]);
        assert.equal(history.status, 200, JSON.stringify(history.body));
        const tombstone = history.body.result.find(entry => entry.identifier === 'crud-overlap');
        assert.ok(tombstone);
        assert.equal(tombstone.isValid, false);
        assert.equal((await http(worker, B, 'GET', '/api/v3/entries/crud-overlap', credentials[1])).body.result.sgv, 112);

        const permanentDelete = await http(worker, A, 'DELETE', '/api/v3/entries/crud-overlap?permanent=true', credentials[0]);
        assert.equal(permanentDelete.status, 200, JSON.stringify(permanentDelete.body));
        assert.deepEqual(await rows(A), []);
        assert.equal((await http(worker, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).status, 404);
        const historyAfterPermanentDelete = await http(worker, A, 'GET',
          '/api/v3/entries/history/1793664000000', credentials[0]);
        assert.equal(historyAfterPermanentDelete.status, 200);
        assert.equal(historyAfterPermanentDelete.body.result.some(entry => entry.identifier === 'crud-overlap'), false);
        assert.deepEqual(await rows(B), originalB);
      } finally {
        await changeGrants(baseGrants);
        await admin.query('UPDATE preview_auth.tenant_authorization_subjects SET display_name = $1 WHERE tenant_id = $2 AND subject_id = $3',
          ['Synthetic Viewer 0', A, SUBJECT]);
      }

      await stop(worker);
      const restarted = start();
      await ready(restarted);
      assert.equal((await http(restarted, A, 'GET', '/api/v3/entries/crud-overlap', credentials[0])).status, 404);
      const restartedHistory = await http(restarted, A, 'GET',
        '/api/v3/entries/history/1793664000000', credentials[0]);
      assert.equal(restartedHistory.status, 200);
      assert.equal(restartedHistory.body.result.some(entry => entry.identifier === 'crud-overlap'), false);
      assert.equal((await http(restarted, B, 'GET', '/api/v3/entries/crud-overlap', credentials[1])).body.result.sgv, 112);
      await stop(restarted);
    });

    it('composes explicitly prepared legacy and API3 domains with real snapshots and tenant-local authority', async function () {
      await admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions = ARRAY['*']");
      const worker = start(configuration(address, true));
      try {
        await ready(worker);
        const credentials = [];
        for (const tenant of [A, B]) credentials.push((await exchange(worker, tenant)).body.token);
        const id = '000000000000000000000901';
        const now = Date.now(), created_at = new Date(now).toISOString();
        const bodies = {
          entries: { _id: id, date: now, dateString: created_at, type: 'sgv', sgv: 141 },
          treatments: { _id: id, created_at, eventType: 'Note', carbs: 15, notes: 'synthetic' },
          devicestatus: { _id: id, created_at, date: now, device: 'synthetic', uploader: { battery: 75 } },
          profile: { _id: id, startDate: created_at, store: { Default: { basal: [{ time: '00:00', value: 1 }] } } },
          food: { _id: id, name: 'synthetic', carbs: 10, portion: 1, unit: 'g' },
          activity: { _id: id, created_at, steps: 10 }
        };
        for (const [i, tenant] of [A, B].entries()) {
          for (const [logical, body] of Object.entries(bodies)) {
            const result = await http(worker, tenant, 'POST', '/api/v' + (i + 1) + '/' + logical,
              credentials[i], { ...body, tenantMarker: i });
            assert.equal(result.status, 200, logical + ': ' + JSON.stringify(result.body));
            const listed = await http(worker, tenant, 'GET', '/api/v2/' + logical, credentials[i]);
            assert.equal(listed.status, 200, logical + ': ' + JSON.stringify(listed.body));
            assert.ok(listed.body.some(doc => doc.tenantMarker === i), logical + ' legacy snapshot isolation');
            if (logical !== 'activity') {
              const read = await http(worker, tenant, 'GET', '/api/v3/' + logical + '/' + id, credentials[i]);
              assert.equal(read.status, 200, logical + ': ' + JSON.stringify(read.body));
              assert.equal(read.body.result.tenantMarker, i);
              const history = await http(worker, tenant, 'GET', '/api/v3/' + logical + '/history/' + (now - 1000), credentials[i]);
              assert.equal(history.status, 200);
              assert.ok(history.body.result.some(doc => doc.tenantMarker === i));
            }
            const options = await http(worker, tenant, 'OPTIONS', '/api/v2/' + logical, credentials[i]);
            assert.equal(options.status, 200, logical);
            assert.match(options.headers.allow, /GET/);
          }
          const settings = await http(worker, tenant, 'POST', '/api/v3/settings', credentials[i],
            { identifier: 'overlapping-settings', date: now, utcOffset: 0, app: 'synthetic', marker: i });
          assert.equal(settings.status, 201, JSON.stringify(settings.body));
          assert.equal((await http(worker, tenant, 'GET', '/api/v3/settings/overlapping-settings',
            credentials[i])).body.result.marker, i);
          for (const resource of ['/api/v1/status', '/api/v2/verifyauth', '/api/v2/authorization/permissions',
            '/api/v3/status', '/api/v3/version', '/api/v3/lastModified', '/api/versions']) {
            const result = await http(worker, tenant, 'GET', resource, credentials[i]);
            assert.equal(result.status, 200, resource + ': ' + JSON.stringify(result.body));
          }
          assert.equal((await http(worker, tenant, 'HEAD', '/api/v2/entries', credentials[i])).status, 200);
          assert.equal((await http(worker, tenant, 'PUT', '/api/v1/entries', credentials[i], bodies.entries)).status, 405);
          assert.equal((await http(worker, tenant, 'GET', '/api/v3/activity', credentials[i])).status, 405);
          const summary = await http(worker, tenant, 'GET', '/api/v2/summary', credentials[i]);
          assert.equal(summary.status, 200);
          assert.ok(summary.body.sgvs.some(reading => reading.sgv === 141));
          assert.equal((await http(worker, tenant, 'GET', '/api/v1/summary', credentials[i])).status, 405);
          assert.equal((await http(worker, tenant, 'POST', '/api/v2/summary', credentials[i], {})).status, 405);
        }
        await admin.query('REVOKE SELECT ON preview_activity.activity FROM preview_app');
        try {
          const unavailable = await http(worker, A, 'GET', '/api/v1/entries', credentials[0]);
          assert.equal(unavailable.status, 503);
          assert.deepEqual(unavailable.body, { error: 'TENANT_SNAPSHOT_UNAVAILABLE' });
          assert.equal((await http(worker, A, 'GET', '/api/v3/entries/' + id, credentials[0])).status, 200);
        } finally { await admin.query('GRANT SELECT ON preview_activity.activity TO preview_app'); }
        await admin.query('ALTER TABLE preview_activity.activity RENAME TO activity_fault_fixture');
        try {
          const failed = await http(worker, A, 'GET', '/api/v2/entries', credentials[0]);
          assert.equal(failed.status, 500);
          assert.deepEqual(failed.body, { error: 'TENANT_SNAPSHOT_INTERNAL' });
        } finally { await admin.query('ALTER TABLE preview_activity.activity_fault_fixture RENAME TO activity'); }
        assert.equal((await http(worker, B, 'GET', '/api/v2/entries', credentials[0])).status, 401);
        await admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions = ARRAY['denied'] WHERE tenant_id=$1", [A]);
        assert.equal((await http(worker, A, 'POST', '/api/v1/entries', credentials[0], bodies.entries)).status, 401);
      } finally {
        if (worker.port) await stop(worker);
        await admin.query(`UPDATE preview_auth.tenant_authorization_roles SET permissions =
          ARRAY['api:entries:read','api:entries:create','api:entries:update']`);
      }
    });

    it('uses the actual common legacy parent even when only safe context routes are selected', async function () {
      await admin.query("UPDATE preview_auth.tenant_authorization_roles SET permissions = ARRAY['*']");
      const config = configuration(address);
      config.context = true;
      const worker = start(config);
      try {
        await ready(worker);
        const credential = (await exchange(worker, A)).body.token;
        const status = await http(worker, A, 'GET', '/api/v2/status.json', credential);
        assert.equal(status.status, 200);
        assert.equal((await http(worker, A, 'GET', '/api/v1/status?count=invalid', credential)).status, 400);
        assert.equal((await http(worker, A, 'GET', '/api/v1/entries', credential)).status, 405);
        const raw = 'sameviewer-' + hash(hash(roots[0]) + SUBJECT).slice(0, 16);
        const issued = await http(worker, A, 'GET', '/api/v2/status.json?token=' + raw);
        assert.equal(issued.status, 200);
        assert.equal(issued.body.authorized.sub, 'Synthetic Viewer 0');
      } finally {
        if (worker.port) await stop(worker);
        await admin.query(`UPDATE preview_auth.tenant_authorization_roles SET permissions =
          ARRAY['api:entries:read','api:entries:create','api:entries:update']`);
      }
    });

    it('refuses invalid config, missing environment references and unsafe/read-write readiness before binding', async function () {
      await refused('{invalid');
      const config = configuration(address);
      config.postgres.password = random();
      await refused(config);
      await refused(configuration(address), { PREVIEW_APP_PG: '' });
      await refused(configuration(address), { PREVIEW_CHECK_PG: appURI });
      await refused(configuration(address), { PREVIEW_APP_PG: adminURI });
      const incomplete = configuration(address);
      incomplete.legacy = true;
      await refused(incomplete);
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

    it('refuses an incomplete injected intent before the preview listener binds', async function () {
      await refused(configuration(address), {
        NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/preview-composition-control.cjs'),
        NS_PREVIEW_COMPOSITION_FAULT: 'intent'
      });
    });

    it('refuses a wrong backend catalogue before the preview listener binds', async function () {
      await refused(configuration(address), {
        NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/preview-composition-control.cjs'),
        NS_PREVIEW_COMPOSITION_FAULT: 'catalogue'
      });
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
