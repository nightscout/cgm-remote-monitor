'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const internal = require('../lib/server/serve/internal-listener');
const contract = require('../lib/internal-hints/contract');

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const route = tenant => contract.path('storage-events', tenant);
const settings = { maxMessageBytes: 65536, operationTimeoutMs: 1000 };

describe('private realtime storage hint mount', function () {
  let dir, socketPath, server;
  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-hints-'));
    socketPath = path.join(dir, 'private.sock');
  });
  afterEach(async function () {
    if (server) await server.close();
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function open (fenced = true) {
    const rows = internal.plan(['realtime'], { realtimePreview: settings });
    server = await internal.open({ listen: { socketPath }, shutdownTimeoutMs: 2500 }, rows, {
      operationWindow: fenced ? { run: (tenant, work) => work() } : undefined,
      health: (req, res) => { res.writeHead(req.url === '/healthz/live' ? 204 : 404); res.end(); }
    });
    server.bind('realtime', { 'alarm-delivery': {
      resolveTenant: body => body.tenant, create: () => ({ deliverAlarm: () => ({ accepted: true, receipt: null, clearedRequestIds: [] }) })
    } });
  }

  function endpoint (url, method = 'POST', body = '{}') {
    return new Promise((resolve, reject) => {
      const req = http.request({socketPath, path: url, method, agent: false}, res => {
        let bytes = '';
        res.on('data', part => { bytes += part; });
        res.on('end', () => resolve([res.statusCode, bytes]));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('serves only the owned hint on the generation-aware realtime listener, alongside GET health and fixed contracts', async function () {
    await open();
    const lived = [];
    const receiver = { owns: tenant => tenant === A, receive: (tenant, hint) => lived.push({ tenant, hint }) };
    assert.deepEqual(await endpoint(route(A)), [503, '']);
    assert.throws(() => server.assertBound(), /INTERNAL_API_CONTRACT_UNBOUND.*storage-events/);
    assert.throws(() => server.bind('api', { 'storage-events': receiver }), /INTERNAL_API_CONTRACT_UNOWNED/);
    assert.throws(() => server.bind('realtime', { 'storage-events': {} }), /INTERNAL_API_BINDING_INVALID/);
    server.bind('realtime', { 'storage-events': receiver });
    server.assertBound();
    assert.throws(() => server.bind('realtime', { 'storage-events': receiver }), /INTERNAL_API_BINDING_INVALID/);
    assert.deepEqual(await endpoint('/healthz/live', 'GET', ''), [204, '']);
    assert.deepEqual(await endpoint(route(A), 'GET', ''), [405, '']);
    assert.deepEqual(await endpoint(contract.path('changed', A)), [404, '']);
    assert.deepEqual(await endpoint(route(B)), [421, '']);
    assert.deepEqual(await endpoint(route(A), 'POST', '[]'), [400, '']);
    assert.deepEqual(await endpoint(route(A), 'POST', JSON.stringify({ generation:'7', extension:'ignored' })), [202, '']);
    assert.deepEqual(lived, [{ tenant: A, hint: { generation:'7' } }]);
    assert.ok(server.routes.some(row => row.endsWith('/{tenant}/storage-events')));
    assert.ok(server.routes.some(row => row.includes('alarm')));
  });

  it('keeps listeners without a generation window on their existing fixed routes', async function () {
    await open(false);
    server.assertBound();
    assert.ok(server.routes.every(row => !row.endsWith('/storage-events')));
    assert.equal((await endpoint(route(A)))[0], 503);
    assert.throws(() => server.bind('realtime', { 'storage-events': {} }), /INTERNAL_API_CONTRACT_UNOWNED/);
  });

  it('drains an admitted body during graceful close before releasing its socket', async function () {
    await open();
    let submitted = 0, closing;
    server.bind('realtime', { 'storage-events': { owns: () => true, receive: () => { submitted++; } } });
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: route(A), method: 'POST', agent: false,
        headers: { Expect: '100-continue', 'Content-Length': 2 } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.on('continue', () => {
        closing = server.close();
        req.end('{}');
      });
      req.flushHeaders();
    });
    await closing;
    assert.equal(status, 202);
    assert.equal(submitted, 1);
    assert.equal(fs.existsSync(socketPath), false);
  });
});
