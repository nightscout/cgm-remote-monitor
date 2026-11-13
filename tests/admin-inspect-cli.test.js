'use strict';

// `nightscout admin inspect` against a stand-in admin listener, without a
// database: the line and JSON forms, exit codes, and that only an answer of the
// published shape is ever printed. Synthetic only.
// covers: lib/cli/commands/admin.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
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
});
