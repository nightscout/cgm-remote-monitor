'use strict';

// The api role in registry mode (decision tenant-registry), as the shipping CLI
// child: no tenant in its configuration; a tenant provisioned while it runs is
// served without a restart within the refresh bound; an unknown host gets the
// same refusal as before; a removed tenant is refused within the same bound.
// Actual PostgreSQL and Vault; synthetic tenants and hosts only.
// covers: lib/server/serve/registry-tenants.js, lib/server/serve/registry-config.js, lib/server/serve/preview-config.js, lib/server/serve/preview-api.js
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { createProvisioning } = require('./../lib/tenant-registry/provision');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

const BIN = path.resolve(__dirname, '../bin/nightscout.js');
const REFRESH_MS = 500;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(enabled(), 'disposable NS_TEST_POSTGRES_ADMIN_URI and NS_VAULT_DOCKER_TEST=1 (or NS_TEST_VAULT_ADDR)')('api role in registry mode (actual PostgreSQL and Vault)', function () {
  this.timeout(180000);
  let lab, dir, worker, provisioning, prior;
  const env = {};
  // fetch cannot set Host; node:http sends it as given.
  const exchange = (host, method, route, body) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = require('node:http').request({ hostname: '127.0.0.1', port: worker.port, path: route, method, agent: false, timeout: 5000,
      headers: { host, ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } },
    res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') })); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(bytes || undefined);
  });
  const status = host => new Promise((resolve, reject) => {
    const req = require('node:http').request({ hostname: '127.0.0.1', port: worker.port, path: '/api/v3/entries', method: 'GET', headers: { host }, agent: false, timeout: 5000 },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end();
  });
  before(async function () {
    prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
    lab = await createLab({ servingApi: true });
    // One role-level Vault credential: the deployment's one api rule, decrypt on
    // every tenant's data key. Signing keys are derived in process (decision
    // deployment-signing-secret), so there is no Transit HMAC or verify grant.
    await lab.vaultRequest('sys/policies/acl/' + lab.mount + '_api', { policy:
      `path "${lab.mount}/decrypt/tenant-data-*" { capabilities = ["update"] }` });
    const apiToken = (await lab.vaultRequest('auth/token/create', { policies: [lab.mount + '_api'], no_default_policy: true, ttl: '1h' })).auth.client_token;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-api-registry-'));
    Object.assign(env, {
      PATH: process.env.PATH, API_HOSTNAME: '127.0.0.1', API_PORT: '0',
      NS_PG_PREFIX: lab.prefix, NS_REGISTRY_REFRESH_MS: String(REFRESH_MS), NS_SECRETS_DIR: dir,
      NS_SERVE_INTERNAL_SOCKET: path.join(dir, 'api.sock'),
      NS_VAULT_ADDR: lab.vault.address, NS_VAULT_ALLOW_INSECURE_LOOPBACK: 'true', NS_VAULT_TOKEN: apiToken, ...require('./fixtures/signing-secret').env(),
      NS_API_PG: lab.urls.api, NS_READINESS_PG: lab.urls.readiness, NS_API_ROOT_WRITER_PG: lab.urls.root_writer,
      NS_ALARM_PG: lab.urls.alarm, NS_DISPLAY_PG: lab.urls.display_reader
    });
    const child = spawn(process.execPath, [BIN, 'multitenant', 'api'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    worker = { child, stdout: '', stderr: '' };
    child.stdout.on('data', bytes => { worker.stdout += bytes; });
    child.stderr.on('data', bytes => { worker.stderr += bytes; });
    const until = Date.now() + 30000;
    for (;;) {
      const found = /Listening for role api on 127\.0\.0\.1:(\d+)/.exec(worker.stdout);
      if (found) { worker.port = Number(found[1]); break; }
      if (child.exitCode !== null || Date.now() > until) throw new Error('api did not listen: ' + worker.stderr);
      await sleep(50);
    }
    provisioning = createProvisioning(lab.provisioningOptions());
  });
  after(async function () {
    if (worker && worker.child.exitCode === null) { worker.child.kill('SIGTERM'); await new Promise(resolve => worker.child.once('exit', resolve)); }
    if (provisioning) await provisioning.close().catch(() => {});
    if (lab) await lab.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    scope.setTenancyMode(prior);
  });

  it('AR_PROVISIONING_PRIVATE: /v1/tenants (one, batch, read, description) on the public api listener answers exactly as an unknown route', async function () {
    const id = crypto.randomUUID();
    await provisioning.provision({ id, hosts: ['private-check.example.test'] });
    for (const host of ['private-check.example.test', 'nobody.example.test']) {
      const unknownPost = await exchange(host, 'POST', '/v1/no-such-route', { id: crypto.randomUUID(), hosts: ['x.example.test'] });
      const unknownGet = await exchange(host, 'GET', '/v1/no-such-route');
      for (const [method, route, body] of [['POST', '/v1/tenants', { id: crypto.randomUUID(), hosts: ['leak.example.test'] }],
        ['POST', '/v1/tenants/batch', { tenants: [{ id: crypto.randomUUID(), hosts: ['leak2.example.test'] }] }], ['GET', '/v1/tenants/' + id], ['GET', '/v1/openapi.json']]) {
        const answer = await exchange(host, method, route, body);
        const expected = method === 'POST' ? unknownPost : unknownGet;
        assert.deepEqual({ status: answer.status, body: answer.body }, { status: expected.status, body: expected.body }, host + ' ' + method + ' ' + route);
      }
    }
    assert.equal(await provisioning.get(crypto.randomUUID()), null);
    const leaked = (await lab.admin.query(`SELECT count(*)::int AS n FROM "${lab.namespaces.registry}".tenant_registry_hosts WHERE host LIKE 'leak%'`)).rows[0].n;
    assert.equal(leaked, 0, 'nothing provisioned through the public listener');
  });

  it('AR_UNKNOWN_HOST: a host the registry does not hold is refused as before (404)', async function () {
    assert.equal(await status('nobody.example.test'), 404);
  });

  it('AR_NEW_TENANT: a tenant provisioned while the api runs is served without a restart, within the refresh bound', async function () {
    const id = crypto.randomUUID();
    assert.equal(await status('late.example.test'), 404, 'not yet provisioned');
    assert.equal((await provisioning.provision({ id, hosts: ['late.example.test'] })).outcome, 'created');
    const started = Date.now();
    let code;
    // 403 is the anonymous refusal of a served tenant (anonymous access is denied);
    // 503 is a tenant still warming (decision readiness-serve-then-warm).
    while (Date.now() - started < REFRESH_MS * 3 + 2000) {
      code = await status('late.example.test');
      if (code === 403) break;
      await sleep(50);
    }
    const elapsed = Date.now() - started;
    assert.equal(code, 403, 'served (anonymous refusal from the tenant\'s own authority) within the bound; last status ' + code + '; stderr ' + worker.stderr);
    console.log('      AR_NEW_TENANT served after ' + elapsed + ' ms (refresh ' + REFRESH_MS + ' ms)');
    assert.equal(worker.child.exitCode, null, 'no restart');
  });

  it('AR_REMOVED: a removed tenant (hosts deleted, state removed) is refused within the refresh bound', async function () {
    const id = crypto.randomUUID();
    await provisioning.provision({ id, hosts: ['gone.example.test'] });
    const until = Date.now() + REFRESH_MS * 3 + 2000;
    while (await status('gone.example.test') !== 403 && Date.now() < until) await sleep(50);
    assert.equal(await status('gone.example.test'), 403);
    await lab.admin.query(`DELETE FROM "${lab.namespaces.registry}".tenant_registry_hosts WHERE tenant_id = $1`, [id]);
    await lab.admin.query(`UPDATE "${lab.namespaces.registry}".tenant_registry SET state = 'removed' WHERE tenant_id = $1`, [id]);
    const started = Date.now();
    let code;
    while (Date.now() - started < REFRESH_MS * 3 + 2000) { code = await status('gone.example.test'); if (code === 404) break; await sleep(50); }
    assert.equal(code, 404);
  });
});
