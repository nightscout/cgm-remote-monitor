'use strict';

// `nightscout admin inspect` against a stand-in admin listener, without a
// database: the line and JSON forms, exit codes, and that only an answer of the
// published shape is ever printed. Synthetic only.
// covers: lib/cli/commands/admin.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const admin = require('../lib/cli/commands/admin');

describe('admin inspect client', function () {
  let server, base, answer, seen;
  before(async function () {
    server = http.createServer((req, res) => {
      seen.push(req.method + ' ' + req.url);
      const { status = 200, body } = answer(req);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  });
  after(() => new Promise(resolve => server.close(resolve)));
  beforeEach(() => { seen = []; });
  async function run (args) {
    const out = { stdout: '', stderr: '' };
    const code = await admin.run(args, { env: {}, stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } });
    return { ...out, code };
  }
  const report = (id, provisioning, action, findings = []) => ({ id, provisioning, action, registry: { state: null, hosts: [] }, vault: { status: 'read', keys: {} }, findings });

  it('prints one line per state and exits 0 only for a complete tenant', async function () {
    const id = randomUUID();
    for (const [provisioning, action, findings, code] of [['complete', 'none', [], 0], ['absent', 'provision', [], 1], ['residue', 'provision', [], 1],
      ['incomplete', 'operator', ['record:settings:missing', 'vault:access:mismatch'], 1], ['removed', 'none', [], 1], ['unverified', 'inspect-again', ['vault:unavailable'], 1]]) {
      answer = () => ({ body: report(id, provisioning, action, findings) });
      const result = await run(['inspect', '--id', id, '--url', base]);
      assert.equal(result.code, code, provisioning);
      assert.equal(result.stdout, [id, provisioning, action, ...findings].join(' ') + '\n');
      assert.equal(result.stderr, '');
    }
    assert.deepEqual([...new Set(seen)], ['GET /v1/tenants/' + id + '/provisioning'], 'inspection only reads');
  });

  it('prints the whole inspection with --json', async function () {
    const id = randomUUID(), body = report(id, 'residue', 'provision');
    answer = () => ({ body });
    const result = await run(['inspect', '--id', id, '--json', '--url', base]);
    assert.equal(result.code, 1); assert.deepEqual(JSON.parse(result.stdout), body);
  });

  it('prints nothing from an answer outside the published shape and exits 69', async function () {
    const id = randomUUID(), marker = 'synthetic-marker-value';
    for (const body of [report(randomUUID(), 'complete', 'none'), report(id, marker, 'none'), report(id, 'complete', marker), report(id, 'incomplete', 'operator', [marker]),
      report(id, 'incomplete', 'operator', ['record:' + marker + ' with space']), { ...report(id, 'complete', 'none'), findings: marker }, marker]) {
      answer = () => ({ body });
      const result = await run(['inspect', '--id', id, '--url', base]);
      assert.equal(result.code, 69, JSON.stringify(body)); assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes(marker), 'an unexpected answer is not echoed');
    }
    answer = () => ({ status: 503, body: { code: 'TENANT_PROVISION_FAILED', detail: marker } });
    const unavailable = await run(['inspect', '--id', id, '--url', base]);
    assert.equal(unavailable.code, 69); assert.equal(unavailable.stdout, '');
    assert.equal(unavailable.stderr, 'nightscout admin: admin listener answered 503 TENANT_PROVISION_FAILED\n');
  });

  it('refuses arguments that are not an inspection, before any request', async function () {
    const id = randomUUID();
    answer = () => ({ body: report(id, 'complete', 'none') });
    for (const args of [['inspect'], ['inspect', '--id', 'NOT-A-UUID', '--url', base], ['inspect', '--id', id, '--host', 'a.example.test', '--url', base],
      ['inspect', '--seed', 'x.json', '--url', base], ['inspect', '--id', id, '--secrets-out', '/tmp/x', '--url', base],
      ['provision', '--id', id, '--host', 'a.example.test', '--json', '--url', base], ['remove', '--id', id, '--json', '--url', base]]) {
      assert.equal((await run(args)).code, 64, JSON.stringify(args));
    }
    assert.deepEqual(seen, []);
  });

  it('refuses unknown fields and invalid nested inspection values before either output form', async function () {
    const id = randomUUID(), marker = 'synthetic-private-response-marker';
    const changes = [
      body => { body.unpublished = marker; },
      body => { body.registry.unpublished = marker; },
      body => { body.vault.unpublished = marker; },
      body => { delete body.registry; },
      body => { body.registry.state = marker; },
      body => { body.registry.hosts = marker; },
      body => { body.registry.hosts = [false]; },
      body => { body.registry.internalHost = false; },
      body => { body.vault.status = marker; },
      body => { body.vault.keys = { data: marker }; },
      body => { body.records = { settings: marker }; },
      body => { body.records = { checkpoints: { 'evaluator-test': marker } }; }
    ];
    for (const change of changes) {
      const body = report(id, 'complete', 'none'); change(body);
      answer = () => ({ body });
      for (const format of [[], ['--json']]) {
        const result = await run(['inspect', '--id', id, ...format, '--url', base]);
        assert.equal(result.code, 69, 'invalid inspection must refuse');
        assert.equal(result.stdout, ''); assert(!result.stderr.includes(marker));
      }
    }
  });

  it('preserves valid optional presence maps and registry hosts from the published description', async function () {
    const id = randomUUID(), body = report(id, 'complete', 'none');
    body.registry = { state: 'active', hosts: ['a.example.test'], internalHost: 'a.internal.test' };
    body.records = { settings: 'present', rootSecret: 'absent', checkpoints: { 'evaluator-test': 'partial' } };
    body.vault.keys = { data: 'present', access: 'mismatch' };
    answer = () => ({ body });
    const result = await run(['inspect', '--id', id, '--json', '--url', base]);
    assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), body);
  });

  it('actual executable refuses an unpublished response field without printing its value', async function () {
    const id = randomUUID(), marker = 'synthetic-private-executable-marker';
    answer = () => ({ body: { ...report(id, 'complete', 'none'), unpublished: marker } });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, '../bin/nightscout.js'), 'admin', 'inspect', '--id', id, '--json', '--url', base],
        { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = { stdout: '', stderr: '' };
      child.stdout.on('data', chunk => { out.stdout += chunk; }); child.stderr.on('data', chunk => { out.stderr += chunk; });
      child.on('error', reject); child.once('exit', code => resolve({ ...out, code }));
    });
    assert.equal(result.code, 69); assert.equal(result.stdout, ''); assert(!result.stderr.includes(marker));
  });

  it('uses the published referenced schemas and refuses unsupported schema changes', function () {
    const filename = require.resolve('../lib/tenant-registry/inspection-shape');
    const schema = require('../lib/tenant-registry/openapi.json');
    const compile = change => {
      const document = structuredClone(schema); change(document.components.schemas);
      const loaded = new Module(filename, module); loaded.filename = filename;
      loaded.paths = Module._nodeModulePaths(path.dirname(filename));
      loaded.require = name => name === './openapi.json' ? document : Module.prototype.require.call(loaded, name);
      loaded._compile(fs.readFileSync(filename, 'utf8'), filename); return loaded.exports;
    };
    const body = report(randomUUID(), 'complete', 'none'); body.registry.hosts = ['a.example.test'];
    assert.equal(compile(() => {})(body), true);
    assert.equal(compile(schemas => { schemas.Host.maxLength = 1; })(body), false, 'referenced published constraint is live');
    assert.throws(() => compile(schemas => { schemas.ProvisioningInspection.unevaluatedProperties = false; }), /unsupported keyword/);
    assert.throws(() => compile(schemas => { schemas.Host = { $ref: 'https://schema.invalid/host' }; }), /unsupported inspection response schema reference/);
    assert.throws(() => compile(schemas => { schemas.Host = { $ref: '#/components/schemas/Host' }; }), /unsupported inspection response schema reference/);
  });
});
