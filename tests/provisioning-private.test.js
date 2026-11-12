'use strict';

// Decision operator-rest-api: the provisioning resource is reachable only on the
// admin listener. On the realtime public listener and on every serve.internal
// contract listener, /v1/tenants (one, batch, read) and its description answer
// exactly as an unknown route does. (The api and tenant-admin listeners are
// checked in tests/api-registry.integration.test.js and
// tests/owner-preview.integration.test.js.) Synthetic only.
// covers: lib/server/serve/preview-realtime.js, lib/server/internal-api/transport.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const transport = require('../lib/server/internal-api/transport');
const contracts = require('../lib/server/internal-api/contracts');
const { publicApp } = require('../lib/server/serve/preview-realtime');

const PROBES = [['POST', '/v1/tenants', { id: randomUUID(), hosts: ['leak.example.test'] }], ['POST', '/v1/tenants/batch', { tenants: [{ id: randomUUID(), hosts: ['leak.example.test'] }] }],
  ['GET', '/v1/tenants/' + randomUUID()], ['GET', '/v1/openapi.json']];

async function serve (handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server.address().port); } finally { await new Promise(resolve => server.close(resolve)); }
}
function call (port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port, method, path, agent: false, headers: { host: 'one.example.test', ...headers,
      ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(bytes || undefined);
  });
}
async function assertPrivate (handler, headers = {}) {
  await serve(handler, async port => {
    const unknown = { POST: await call(port, 'POST', '/v1/no-such-route', { id: randomUUID() }, headers), GET: await call(port, 'GET', '/v1/no-such-route', undefined, headers) };
    for (const [method, path, body] of PROBES) assert.deepEqual(await call(port, method, path, body, headers), unknown[method], method + ' ' + path);
  });
}

describe('provisioning resource stays on the admin listener', function () {
  it('PP_REALTIME: the realtime public listener answers /v1/tenants as an unknown route', async function () {
    await assertPrivate(publicApp(() => ({ ready: true })));
  });
  it('PP_INTERNAL: a serve.internal listener composing every internal contract answers /v1/tenants as an unknown route', async function () {
    const modules = Object.values(contracts).map(service => ({ service, token: Symbol(service.id),
      operations: Object.fromEntries(Object.keys(service.operations).map(name => [name, async () => ({})])) }));
    const handler = transport.handler({ maxBytes: 65536, timeoutMs: 5000, modules, admitted: () => true });
    for (const service of Object.values(contracts)) {
      await assertPrivate(handler, { 'x-nightscout-internal-service': service.id, 'x-nightscout-internal-version': String(service.version) });
    }
  });
});
