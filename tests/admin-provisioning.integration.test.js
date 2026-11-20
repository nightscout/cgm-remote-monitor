'use strict';

// Tenant provisioning through the admin role's REST resource and the
// `nightscout admin provision` client (decisions provisioning-split and
// operator-rest-api), on actual PostgreSQL and Vault with the shipping CLI as a
// child process. Synthetic tenants, hosts and labels only.
// covers: lib/tenant-registry/rest.js, lib/tenant-registry/openapi.json, lib/server/serve/admin-config.js, lib/server/serve/admin-preview.js, lib/cli/commands/admin.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { optInSuite } = require('./support/opt-in');

const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); server.on('error', reject); });
function cli (args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/nightscout.js'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...env } });
    const out = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => { out.stdout += chunk; });
    child.stderr.on('data', chunk => { out.stderr += chunk; });
    child.once('exit', code => resolve({ ...out, code }));
  });
}

optInSuite(enabled(), 'disposable NS_TEST_POSTGRES_ADMIN_URI and NS_VAULT_DOCKER_TEST=1 (or NS_TEST_VAULT_ADDR)')('admin provisioning REST and CLI (actual PostgreSQL and Vault)', function () {
  this.timeout(180000);
  let lab, dir, role, base;
  const request = async (method, route, body, headers = {}) => {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, type: response.headers.get('content-type'), location: response.headers.get('location'), body: await response.json() };
  };
  before(async function () {
    lab = await createLab();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-admin-provision-'));
    const env = await lab.adminEnvironment(dir);
    const port = await freePort();
    base = 'http://127.0.0.1:' + port;
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/nightscout.js'), 'multitenant', 'admin'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, ADMIN_HOSTNAME: '127.0.0.1', ADMIN_PORT: String(port), ...env } });
    role = { child, out: { stdout: '', stderr: '' } };
    child.stdout.on('data', chunk => { role.out.stdout += chunk; });
    child.stderr.on('data', chunk => { role.out.stderr += chunk; });
    const until = Date.now() + 30000;
    while (!/Listening for role admin/.test(role.out.stdout)) {
      if (child.exitCode !== null || Date.now() > until) throw new Error('admin role did not listen: ' + role.out.stderr);
      await sleep(50);
    }
  });
  after(async function () {
    if (role && role.child.exitCode === null) { role.child.kill('SIGTERM'); await new Promise(resolve => role.child.once('exit', resolve)); }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (lab) await lab.close();
  });

  it('AP_REST_ONE: POST creates (201, Location), a retry answers existing (200), GET reads it back; problems carry stable codes', async function () {
    const id = randomUUID();
    const created = await request('POST', '/v1/tenants', { id, hosts: ['rest-one.example.test'], ref: 'rest-1' }, { 'Idempotency-Key': id });
    assert.equal(created.status, 201); assert.equal(created.location, '/v1/tenants/' + id);
    assert.deepEqual(created.body, { id, ref: 'rest-1', outcome: 'created' }, 'no secret unless requested');
    const again = await request('POST', '/v1/tenants', { id, hosts: ['rest-one.example.test'] });
    assert.equal(again.status, 200); assert.equal(again.body.outcome, 'existing');
    assert.deepEqual((await request('GET', '/v1/tenants/' + id)).body, { id, state: 'active', signingVersion: 1, hosts: ['rest-one.example.test'] });
    const mismatch = await request('POST', '/v1/tenants', { id: randomUUID(), hosts: ['x.example.test'] }, { 'Idempotency-Key': id });
    assert.equal(mismatch.status, 422); assert.equal(mismatch.type, 'application/problem+json'); assert.equal(mismatch.body.code, 'TENANT_PROVISION_IDEMPOTENCY_KEY_MISMATCH');
    const conflict = await request('POST', '/v1/tenants', { id: randomUUID(), hosts: ['rest-one.example.test'] });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'TENANT_PROVISION_CONFLICT');
    const missing = await request('GET', '/v1/tenants/' + randomUUID());
    assert.equal(missing.status, 404); assert.equal(missing.body.code, 'TENANT_NOT_FOUND');
    assert.equal((await request('POST', '/v1/tenants/batch', { tenants: [] })).body.code, 'TENANT_PROVISION_BATCH_INVALID');
    assert.equal((await request('GET', '/v1/openapi.json')).body.openapi, '3.1.0');
  });

  it('AP_REST_INCOMPLETE: retrying an incomplete tenant returns a stable 409 without issuing another secret', async function () {
    const spec = { id: randomUUID(), hosts: ['incomplete.example.test'], issueRootSecret: true };
    assert.equal((await request('POST', '/v1/tenants', spec)).status, 201);
    await lab.admin.query(`DELETE FROM "${lab.namespaces.settings}".tenant_settings WHERE tenant_id=$1`, [spec.id]);
    const retry = await request('POST', '/v1/tenants', spec);
    assert.equal(retry.status, 409); assert.equal(retry.type, 'application/problem+json');
    assert.equal(retry.body.code, 'TENANT_PROVISION_INCOMPLETE'); assert.equal(retry.body.rootSecret, undefined);
  });

  it('AP_REST_SECRET_ONCE: the root secret is returned only on created and only when requested, never logged by the role', async function () {
    const id = randomUUID();
    const first = await request('POST', '/v1/tenants', { id, hosts: ['secret-once.example.test'], issueRootSecret: true });
    assert.equal(first.status, 201); assert.match(first.body.rootSecret, /^[0-9a-f]{48}$/);
    const second = await request('POST', '/v1/tenants', { id, hosts: ['secret-once.example.test'], issueRootSecret: true });
    assert.equal(second.body.outcome, 'existing'); assert.equal(second.body.rootSecret, undefined);
    assert.ok(!role.out.stdout.includes(first.body.rootSecret) && !role.out.stderr.includes(first.body.rootSecret), 'role output never carries a secret');
  });

  it('AP_REST_BOOTSTRAP: a batch with bootstrap returns each tenant usable; a retry returns the same ids and a fresh data JWT, never the access token; nothing is logged', async function () {
    const bootstrap = { owner: { consumer: 'lab-owner' }, subject: { name: 'Synthetic uploader', role: { name: 'demo', permissions: ['api:*:read', 'api:*:create,update,delete'] } } };
    const tenants = Array.from({ length: 3 }, (_, i) => ({ id: randomUUID(), hosts: ['boot-' + i + '.example.test'], bootstrap }));
    const first = await request('POST', '/v1/tenants/batch', { tenants });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.results.map(row => row.outcome), ['created', 'created', 'created']);
    for (const row of first.body.results) {
      assert.deepEqual(Object.keys(row.bootstrap).sort(), ['accessToken', 'jwt', 'jwtExpiresAt', 'ownerSubject', 'subject']);
      assert.match(row.bootstrap.accessToken, /^syntheticu-[0-9a-f]{16}$/);
      // The data JWT (deployment-signing-secret): the api's own token, signed with the tenant's derived key.
      const header = JSON.parse(Buffer.from(row.bootstrap.jwt.split('.')[0], 'base64url'));
      assert.deepEqual(header, { alg: 'EdDSA', typ: 'ns-legacy-data+jwt', kid: 'data-1' });
      assert.equal(JSON.parse(Buffer.from(row.bootstrap.jwt.split('.')[1], 'base64url')).exp, row.bootstrap.jwtExpiresAt);
      for (const secret of [row.bootstrap.accessToken, row.bootstrap.jwt]) {
        assert.ok(!role.out.stdout.includes(secret) && !role.out.stderr.includes(secret), 'a token reached the role output');
      }
      const configure = (await lab.admin.query(`SELECT principal, consumer, active, can_configure FROM "${lab.namespaces.ownerConfiguration}".tenant_owner_configuration_authority WHERE tenant_id=$1`, [row.id])).rows;
      assert.deepEqual(configure, [{ principal: row.bootstrap.ownerSubject, consumer: 'lab-owner', active: true, can_configure: true }]);
    }
    const again = await request('POST', '/v1/tenants/batch', { tenants });
    assert.deepEqual(again.body.results.map(row => ({ ...row, bootstrap: { ...row.bootstrap, jwt: typeof row.bootstrap.jwt, jwtExpiresAt: typeof row.bootstrap.jwtExpiresAt } })),
      first.body.results.map(row => ({ id: row.id, outcome: 'existing',
        bootstrap: { ownerSubject: row.bootstrap.ownerSubject, subject: row.bootstrap.subject, jwt: 'string', jwtExpiresAt: 'number' } })));
    const one = { id: randomUUID(), hosts: ['boot-one.example.test'], bootstrap };
    const single = await request('POST', '/v1/tenants', one);
    assert.equal(single.status, 201); assert.ok(single.body.bootstrap.accessToken); assert.ok(single.body.bootstrap.jwt);
    const invalid = await request('POST', '/v1/tenants', { id: randomUUID(), hosts: ['boot-bad.example.test'], bootstrap: { owner: {} } });
    assert.equal(invalid.status, 422); assert.equal(invalid.body.code, 'TENANT_PROVISION_BOOTSTRAP_INVALID');
  });

  it('AP_ROTATE: `admin rotate-signing` rotates one tenant through the REST resource; the data JWT moves to the new kid; refusals carry stable codes', async function () {
    const bootstrap = { owner: { consumer: 'lab-owner' }, subject: { name: 'Synthetic uploader', role: { name: 'demo', permissions: ['api:*:read'] } } };
    const id = randomUUID(), spec = { id, hosts: ['rotate.example.test'], bootstrap };
    const created = await request('POST', '/v1/tenants', spec);
    assert.equal(created.status, 201);
    const kid = jwt => JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url')).kid;
    assert.equal(kid(created.body.bootstrap.jwt), 'data-1');
    const rotated = await cli(['admin', 'rotate-signing', '--id', id, '--url', base]);
    assert.equal(rotated.code, 0, rotated.stderr); assert.equal(rotated.stdout, id + ' rotated 2\n');
    assert.equal((await request('GET', '/v1/tenants/' + id)).body.signingVersion, 2);
    assert.equal(kid((await request('POST', '/v1/tenants', spec)).body.bootstrap.jwt), 'data-2');
    const again = await request('POST', '/v1/tenants/' + id + '/signing-version');
    assert.deepEqual({ status: again.status, body: again.body }, { status: 200, body: { id, outcome: 'rotated', signingVersion: 3 } });
    const unknown = randomUUID(), missing = await cli(['admin', 'rotate-signing', '--id', unknown, '--url', base]);
    assert.equal(missing.code, 1); assert.equal(missing.stdout, unknown + ' refused TENANT_NOT_FOUND\n');
    assert.equal((await request('GET', '/v1/tenants/' + id + '/signing-version')).status, 405);
    assert.equal((await cli(['admin', 'rotate-signing', '--id', 'not-a-uuid', '--url', base])).code, 64);
    assert.ok(/"operation":"rotate-signing","outcome":"rotated","signingVersion":2/.test(role.out.stdout), 'counts and codes only in the role log');
    assert.ok((await request('GET', '/v1/openapi.json')).body.paths['/v1/tenants/{id}/signing-version'].post);
  });

  for (const format of ['csv', 'json']) it('AP_CLI_SEED_' + format.toUpperCase() + ': the CLI provisions a seed in bounded batches, one line per tenant, secrets only to --secrets-out (0600); a re-run is all existing', async function () {
    const tenants = Array.from({ length: 7 }, (_, i) => ({ id: randomUUID(), hosts: [format + '-' + i + '.example.test', format + '-' + i + '-b.example.test'], ref: format + '-lab-' + i }));
    const seed = path.join(dir, 'seed.' + format);
    fs.writeFileSync(seed, format === 'json' ? JSON.stringify({ version: 1, tenants })
      : 'id,hosts,ref\n' + tenants.map(row => [row.id, row.hosts.join(';'), row.ref].join(',')).join('\n') + '\n');
    const secretsOut = path.join(dir, 'secrets-' + format + '.jsonl');
    const first = await cli(['admin', 'provision', '--seed', seed, '--batch', '3', '--url', base, '--secrets-out', secretsOut]);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.stdout.trim().split('\n'), tenants.map(row => row.ref + ' ' + row.id + ' created'));
    assert.equal(fs.statSync(secretsOut).mode & 0o777, 0o600);
    const secrets = fs.readFileSync(secretsOut, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(secrets.map(row => row.ref), tenants.map(row => row.ref));
    // AP_CLI_NO_SECRET_LEAK: not one secret appears on stdout or stderr.
    for (const row of secrets) {
      assert.match(row.rootSecret, /^[0-9a-f]{48}$/);
      assert.ok(!first.stdout.includes(row.rootSecret) && !first.stderr.includes(row.rootSecret), 'AP_CLI_NO_SECRET_LEAK: a root secret reached the terminal');
    }
    const again = await cli(['admin', 'provision', '--seed', seed, '--url', base, '--secrets-out', secretsOut]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.stdout.trim().split('\n'), tenants.map(row => row.ref + ' ' + row.id + ' existing'));
    assert.equal(fs.readFileSync(secretsOut, 'utf8').trim().split('\n').length, tenants.length, 'no secret issued again');
  });

  it('AP_CLI_ONE_AND_REFUSALS: one tenant from flags; a refused tenant exits 1; a bad seed exits 64; an unreachable listener exits 69', async function () {
    const id = randomUUID();
    const one = await cli(['admin', 'provision', '--id', id, '--host', 'flags.example.test', '--ref', 'flag-1', '--url', base]);
    assert.equal(one.code, 0, one.stderr); assert.equal(one.stdout, 'flag-1 ' + id + ' created\n');
    const refused = await cli(['admin', 'provision', '--id', randomUUID(), '--host', 'flags.example.test', '--url', base]);
    assert.equal(refused.code, 1); assert.match(refused.stdout, / refused TENANT_PROVISION_CONFLICT\n$/);
    const bad = path.join(dir, 'bad.csv'); fs.writeFileSync(bad, 'id,hosts,password\nx,y,z\n');
    assert.equal((await cli(['admin', 'provision', '--seed', bad, '--url', base])).code, 64);
    const closed = await freePort();
    assert.equal((await cli(['admin', 'provision', '--id', randomUUID(), '--host', 'z.example.test', '--url', 'http://127.0.0.1:' + closed])).code, 69);
    const loose = path.join(dir, 'loose.jsonl'); fs.writeFileSync(loose, '', { mode: 0o644 });
    // Creation mode is filtered by the runner umask; make the refusal input explicit.
    fs.chmodSync(loose, 0o644);
    assert.equal(fs.statSync(loose).mode & 0o777, 0o644, 'the unsafe fixture is effectively mode 0644');
    assert.equal((await cli(['admin', 'provision', '--id', randomUUID(), '--host', 'loose.example.test', '--url', base, '--secrets-out', loose])).code, 64, 'a group- or world-readable secrets file is refused');
  });
});
