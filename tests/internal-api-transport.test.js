'use strict';

// Exercise the actual transport listeners. These checks do not certify deployment
// credential custody or the domain services' authorization/lifecycle semantics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const transport = require('../lib/server/internal-api/transport');

const requestSchema = {
  type: 'object', additionalProperties: false, required: ['tenant'],
  properties: { tenant: { type: 'string', minLength: 1 } }
};
const responseSchema = {
  type: 'object', additionalProperties: false, required: ['accepted'],
  properties: { accepted: { type: 'boolean' } }
};
const service = Object.freeze({ id: 'synthetic-authority', version: 1, operations: {
  authorizeSocket: { path: '/authorize', request: requestSchema, response: responseSchema }
} });
const otherService = Object.freeze({ id: 'synthetic-lifecycle', version: 1, operations: {
  getStatus: { path: '/cohort/status', request: requestSchema, response: responseSchema }
} });

async function unusedPort () {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture (kind = 'uds', limits = {}, implementation = transport) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-api-'));
  fs.chmodSync(directory, 0o700);
  const endpoint = kind === 'uds' ? { socketPath: path.join(directory, 'service.sock') } : {
    url: 'http://127.0.0.1:' + await unusedPort(), trust: 'network'
  };
  const options = { ...endpoint, maxBytes: 1024, timeoutMs: 500, ...limits };
  let listener;
  return {
    options, directory,
    async open (operations, descriptor = service, lifetime) {
      listener = await implementation.open(options, descriptor, () => operations, lifetime);
      return implementation.client(options, descriptor);
    },
    async closeListener () { if (listener) await listener.close(); },
    async close () {
      try { if (listener) await listener.close(); }
      finally { fs.rmSync(directory, { recursive: true, force: true }); }
    }
  };
}
function headers (options, overrides = {}) {
  return {
    'content-type': 'application/json',
    'x-nightscout-internal-service': service.id,
    'x-nightscout-internal-version': String(service.version),
    ...overrides
  };
}
function raw (options, requestPath, body = { tenant: 'synthetic' }, overrides = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const target = options.socketPath ? { socketPath: options.socketPath } : {
    hostname: '127.0.0.1', port: new URL(options.url).port
  };
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, path: requestPath, method: overrides.method || 'POST',
      headers: headers(options, overrides.headers) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(bytes);
  });
}
function refused (reply) {
  assert.equal(reply.status, 503);
  assert.deepEqual(JSON.parse(reply.body), { error: 'SOCKET_IPC_UNAVAILABLE' });
}

for (const kind of ['uds', 'http']) describe('Internal API service boundary over ' + kind, function () {
  this.timeout(10000);
  it('exposes only named client methods and calls the selected service', async function () {
    const f = await fixture(kind); let calls = 0;
    try {
      const client = await f.open({ async authorizeSocket (ctx, body) {
        assert.equal(typeof ctx.transport, 'symbol'); assert.deepEqual(body, { tenant: 'synthetic' });
        calls++; return { accepted: true };
      } });
      assert.deepEqual(Object.keys(client), ['authorizeSocket']);
      assert.deepEqual(await client.authorizeSocket({ tenant: 'synthetic' }), { accepted: true });
      assert.equal(calls, 1);
      assert.equal(client.getStatus, undefined);
    } finally { await f.close(); }
  });
  it('rejects raw unknown, cross-service, query, encoded, and prototype paths before effects', async function () {
    const f = await fixture(kind); let calls = 0;
    try {
      await f.open({ async authorizeSocket () { calls++; return { accepted: true }; } });
      for (const requestPath of ['/cohort/status', '/alarm', '/authorize?tenant=synthetic', '/%61uthorize', '/constructor', '/__proto__', '/authorize/']) {
        refused(await raw(f.options, requestPath));
      }
      for (const value of [otherService.id, '', service.id + ', ' + otherService.id]) {
        refused(await raw(f.options, '/authorize', undefined, { headers: { 'x-nightscout-internal-service': value } }));
      }
      for (const value of ['0', '2', '', '1, 1']) {
        refused(await raw(f.options, '/authorize', undefined, { headers: { 'x-nightscout-internal-version': value } }));
      }
      assert.equal(calls, 0, 'No rejected route/service/version may invoke a domain handler');
      assert.equal((await raw(f.options, '/authorize')).status, 200);
      assert.equal(calls, 1, 'Positive control must reach the actual selected handler');
    } finally { await f.close(); }
  });
  it('rejects malformed or oversized requests before effects, including client bypass', async function () {
    const f = await fixture(kind); let calls = 0;
    try {
      const client = await f.open({ async authorizeSocket () { calls++; return { accepted: true }; } });
      for (const body of [{}, { tenant: 1 }, { tenant: 'synthetic', unexpected: true }, [], '{invalid']) refused(await raw(f.options, '/authorize', body));
      refused(await raw(f.options, '/authorize', { tenant: 'x'.repeat(2048) }));
      refused(await raw(f.options, '/authorize', undefined, { method: 'GET' }));
      refused(await raw(f.options, '/authorize', undefined, { headers: { 'content-type': 'text/plain' } }));
      await assert.rejects(client.authorizeSocket({ tenant: 'synthetic', unexpected: true }));
      assert.equal(calls, 0);
      assert.deepEqual(await client.authorizeSocket({ tenant: 'synthetic' }), { accepted: true });
      assert.equal(calls, 1);
    } finally { await f.close(); }
  });
  it('rejects malformed domain responses instead of delivering them', async function () {
    const f = await fixture(kind);
    try {
      const client = await f.open({ async authorizeSocket () { return { accepted: 'yes', secretDetail: 'synthetic' }; } });
      refused(await raw(f.options, '/authorize'));
      await assert.rejects(client.authorizeSocket({ tenant: 'synthetic' }));
    } finally { await f.close(); }
  });
  it('keeps tenant resolution and the domain handler inside the selected lifecycle window', async function () {
    const f = await fixture(kind); const events = []; let active = false;
    try {
      const client = await f.open({ async authorizeSocket () {
        assert.equal(active, true); events.push('handler'); return { accepted: true };
      } }, service, {
        async resolveTenant (body) { events.push('resolve'); return body.tenant; },
        operationWindow: { async run (tenant, operation, lifetime) {
          assert.equal(tenant, 'synthetic'); assert.equal(typeof lifetime.onInvalidated, 'function');
          active = true; events.push('enter');
          try { return await operation(); } finally { active = false; events.push('leave'); }
        } }
      });
      refused(await raw(f.options, '/authorize', { tenant: 1 }));
      assert.deepEqual(events, [], 'Schema refusal must precede tenant resolution and lifecycle admission');
      assert.deepEqual(await client.authorizeSocket({ tenant: 'synthetic' }), { accepted: true });
      assert.deepEqual(events, ['resolve', 'enter', 'handler', 'leave']);
    } finally { await f.close(); }
  });
  it('rejects cancellation and operation deadline without delivering a late result', async function () {
    const f = await fixture(kind, { timeoutMs: 60 }); let release;
    try {
      const client = await f.open({ async authorizeSocket () {
        await new Promise(resolve => { release = resolve; }); return { accepted: true };
      } });
      const controller = new AbortController(); controller.abort();
      await assert.rejects(client.authorizeSocket({ tenant: 'synthetic' }, controller.signal));
      await assert.rejects(client.authorizeSocket({ tenant: 'synthetic' }));
    } finally { if (release) release(); await f.close(); }
  });
});

describe('Internal API transport registration and custody', function () {
  this.timeout(10000);
  it('detects removal of the service ownership fence and passes restored source', async function () {
    const file = require.resolve('../lib/server/internal-api/transport');
    const source = fs.readFileSync(file, 'utf8');
    const fence = "req.headers['x-nightscout-internal-service'] !== route.service.id || ";
    assert.equal(source.split(fence).length, 2, 'The intended service fence must exist exactly once');
    const output = { exports: {} };
    require('node:vm').runInThisContext('(function(require,module,exports){' + source.replace(fence, '') + '\n})', { filename: file })(
      require('node:module').createRequire(file), output, output.exports);
    async function check (implementation) {
      const f = await fixture('uds', {}, implementation); let calls = 0;
      try {
        await f.open({ async authorizeSocket () { calls++; return { accepted: true }; } });
        refused(await raw(f.options, '/authorize', undefined, { headers: { 'x-nightscout-internal-service': otherService.id } }));
        assert.equal(calls, 0);
      } finally { await f.close(); }
    }
    await assert.rejects(check(output.exports), error => {
      assert.equal(error.code, 'ERR_ASSERTION'); assert.equal(error.actual, 200); assert.equal(error.expected, 503); return true;
    });
    await check(transport);
  });
  it('refuses missing, extra, and non-function service handlers at registration', async function () {
    for (const operations of [{}, { authorizeSocket: async () => ({ accepted: true }), getStatus: async () => ({ accepted: true }) }, { authorizeSocket: true }]) {
      const f = await fixture();
      try { await assert.rejects(f.open(operations)); }
      finally { await f.close(); }
    }
  });
  it('refuses a foreign named client against another service listener', async function () {
    const f = await fixture(); let calls = 0;
    try {
      await f.open({ async authorizeSocket () { calls++; return { accepted: true }; } });
      await assert.rejects(transport.client(f.options, otherService).getStatus({ tenant: 'synthetic' }));
      assert.equal(calls, 0);
    } finally { await f.close(); }
  });
  it('validates client requests before sending and responses from an independently implemented peer', async function () {
    const f = await fixture('http'); let calls = 0;
    const server = http.createServer((req, res) => {
      calls++; req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 'synthetic invalid response' }));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(Number(new URL(f.options.url).port), '127.0.0.1', resolve);
      });
      const client = transport.client(f.options, service);
      await assert.rejects(client.authorizeSocket({ tenant: 1 }));
      assert.equal(calls, 0, 'Client request schema must reject before network activity');
      await assert.rejects(client.authorizeSocket({ tenant: 'synthetic' }), error => {
        assert.equal(error.message.includes('synthetic invalid response'), false); return true;
      });
      assert.equal(calls, 1, 'Response validation must exercise an actual independently implemented peer');
    } finally {
      await new Promise(resolve => server.close(resolve)); await f.close();
    }
  });
  it('requires a private UDS directory and refuses replacing an existing endpoint', async function () {
    const f = await fixture();
    try {
      fs.chmodSync(f.directory, 0o755);
      await assert.rejects(f.open({ async authorizeSocket () { return { accepted: true }; } }));
      fs.chmodSync(f.directory, 0o700);
      fs.writeFileSync(f.options.socketPath, 'synthetic existing owner');
      await assert.rejects(f.open({ async authorizeSocket () { return { accepted: true }; } }));
      assert.equal(fs.readFileSync(f.options.socketPath, 'utf8'), 'synthetic existing owner');
    } finally { await f.close(); }
  });
  it('requires explicit HTTP trust and accepts configured DNS, link-local, private and loopback endpoints', function () {
    const limits = { maxBytes: 1024, timeoutMs: 500 };
    const trusted = { ...limits, trust: 'network' };
    for (const url of ['http://169.254.1.1:12345', 'http://192.0.2.1:12345', 'http://10.1.2.3:12345', 'http://nightscout-api.namespace.svc.cluster.local:8080', 'http://localhost:12345', 'http://127.0.0.1:12345', 'http://nightscout-api']) {
      assert.equal(typeof transport.client({ ...trusted, url }, service).authorizeSocket, 'function');
      assert.equal(typeof transport.client({ ...trusted, url, bindHost: '0.0.0.0' }, service).authorizeSocket, 'function');
    }
    for (const url of ['http://127.0.0.1:12345/forward', 'http://127.0.0.1:12345?target=elsewhere', 'http://user:pass@127.0.0.1:12345', 'http://127.0.0.1:12345#fragment', 'https://nightscout-api']) {
      assert.throws(() => transport.client({ ...trusted, url }, service));
    }
    const url = 'http://127.0.0.1:12345';
    assert.throws(() => transport.client({ ...limits, url }, service));
    assert.throws(() => transport.client({ ...trusted, url, token: 'synthetic unsupported credential' }, service));
    assert.throws(() => transport.client({ ...limits, url, trust: 'implicit' }, service));
  });
  it('serves explicitly trusted-network HTTP without an application credential and uses an explicit bind address', async function () {
    const f = await fixture('http'); let calls = 0;
    f.options.url = f.options.url.replace('127.0.0.1', 'synthetic-service.invalid');
    f.options.bindHost = '127.0.0.1';
    try {
      await f.open({ async authorizeSocket () { calls++; return { accepted: true }; } });
      const reply = await raw(f.options, '/authorize');
      assert.equal(reply.status, 200); assert.deepEqual(JSON.parse(reply.body), { accepted: true });
      assert.equal(calls, 1);
      refused(await raw(f.options, '/cohort/status'));
      refused(await raw(f.options, '/authorize', { tenant: 1 }));
      assert.equal(calls, 1, 'Network trust must preserve service routing and schema admission');
    } finally { await f.close(); }
  });
  it('closes its owned socket and leaves a replacement endpoint intact', async function () {
    const f = await fixture();
    try {
      await f.open({ async authorizeSocket () { return { accepted: true }; } });
      fs.unlinkSync(f.options.socketPath);
      fs.writeFileSync(f.options.socketPath, 'synthetic replacement');
      await f.closeListener();
      assert.equal(fs.readFileSync(f.options.socketPath, 'utf8'), 'synthetic replacement');
      await assert.rejects(transport.client(f.options, service).authorizeSocket({ tenant: 'synthetic' }));
    } finally { await f.close(); }
  });
});

// Boot the production API composition with its real tenant HTTP router. Storage
// preparation and clinical domain routers are recording dependencies; the selected
// private receiver is a real, separately bound transport using the real contract.
// This measures listener/mount isolation, not PostgreSQL/domain authorization.
describe('Production public API and internal listener isolation', function () {
  this.timeout(10000);
  async function checkPublicIsolation (mutate = source => source) {
    const express = require('express');
    const scope = require('../lib/storage/tenant-scope');
    const descriptor = require('../lib/server/internal-api/contracts').socketAuthority;
    const file = require.resolve('../lib/server/serve/preview-api');
    const local = require('node:module').createRequire(file);
    const tenant = '11111111-1111-4111-8111-111111111111';
    const f = await fixture('http'); const internalCalls = []; let internalClient, role, publicServer;
    const previousMode = scope.getTenancyMode();
    const resource = extra => ({ async end () {}, ...extra });
    const router = express.Router();
    router.get('/synthetic', (req, res) => res.json({ public: true }));
    const stubs = {
      '../../storage/postgres-connection': async () => resource(),
      '../../secrets/legacy-postgres': async () => resource({ read: async () => ({ reference: { tenant, id: 'synthetic' } }) }),
      '../../tenant-authorization/postgres': async () => resource({ authorize: async () => false }),
      '../../secrets/postgres': { createPostgresSecrets: async () => resource({ store: { get: async () => ({}) } }) },
      '../../secrets/component': { createSecrets: () => ({}) },
      './postgres-domains': { async readiness () {}, assertServing: async () => ({ async ensure () {}, invalidateTenant () {} }) },
      './preview-domains': async () => ({ data: router, v3Names: [], legacyNames: [], safeRoutes: {}, async initializeTenant () {} }),
      '../tenant-app/data-access': () => async () => ({ tenant, principal: 'synthetic', consumer: 'api' }),
      '../tenant-app/exchange': () => async () => null,
      '../../human-session/runtime': { multi: async () => null },
      '../realtime/private-api': { async boot () {
        internalClient = await f.open({
          async authorizeSocket () { internalCalls.push('authorize'); return { denied: true }; },
          async executeSocketMutation () { internalCalls.push('mutate'); return { replyArgs: [] }; }
        }, descriptor);
        return { close: () => f.closeListener() };
      } }
    };
    const output = { exports: {} };
    require('node:vm').runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(file, 'utf8')) + '\n})', { filename: file })(
      name => Object.hasOwn(stubs, name) ? stubs[name] : local(name), output, output.exports);
    try {
      role = await output.exports.boot({ bindings: new Map([[tenant, { principal: 'synthetic', consumer: 'api' }]]),
        providers: new Map(), namespaces: {}, resolver: { resolve: async () => tenant }, socketForwarding: true });
      publicServer = http.createServer(role.app);
      await new Promise((resolve, reject) => { publicServer.once('error', reject); publicServer.listen(0, '127.0.0.1', resolve); });
      const publicEndpoint = { url: 'http://127.0.0.1:' + publicServer.address().port };
      assert.notEqual(new URL(publicEndpoint.url).port, new URL(f.options.url).port, 'Public and internal APIs must use separate listeners');
      const publicPositive = await raw(publicEndpoint, '/api/v3/synthetic', '', { method: 'GET' });
      assert.equal(publicPositive.status, 200); assert.deepEqual(JSON.parse(publicPositive.body), { public: true });
      const credential = { host: 'synthetic.example', tenant, namespace: '/', credential: {} };
      const contractPaths = Object.values(require('../lib/server/internal-api/contracts')).flatMap(service => Object.values(service.operations).map(operation => operation.path));
      assert.deepEqual(contractPaths, ['/authorize', '/mutate', '/alarm', '/cohort/status', '/cohort/invalidate',
        '/ownership/list', '/ownership/add', '/ownership/transfer', '/ownership/recover', '/vcpool/inspect',
        '/evaluator/inspect', '/pool/get', '/pool/members']);
      for (const requestPath of [...contractPaths, '/api/v1/authorize', '/api/v3/authorize']) {
        const reply = await raw(publicEndpoint, requestPath, credential, { headers: {
          'x-nightscout-internal-service': descriptor.id, 'x-nightscout-internal-version': String(descriptor.version)
        } });
        assert.equal(reply.status, 404, 'Internal path must remain absent from public app: ' + requestPath);
        assert.deepEqual(JSON.parse(reply.body), { error: 'NOT_FOUND' });
      }
      assert.deepEqual(internalCalls, [], 'Public requests must never execute internal operation handlers');
      assert.deepEqual(await internalClient.authorizeSocket(credential), { denied: true });
      assert.deepEqual(internalCalls, ['authorize'], 'The same operation must be callable through the separate private listener');
    } finally {
      if (publicServer) await new Promise(resolve => publicServer.close(resolve));
      try { if (role) await role.close(); } finally { await f.close(); scope.setTenancyMode(previousMode); }
    }
  }
  it('keeps internal operations off the actual public API app while the private service remains callable', async function () {
    await checkPublicIsolation();
  });
  it('detects accidental mounting of an internal operation on the public production app', async function () {
    await assert.rejects(checkPublicIsolation(source => {
      const mount = 'app.use(createTenantApp({';
      assert.equal(source.split(mount).length, 2, 'Actual production tenant-app mount must exist exactly once');
      return source.replace(mount, "app.post('/authorize', (req, res) => res.json({ denied: true }));\n    " + mount);
    }), error => {
      assert.equal(error.code, 'ERR_ASSERTION'); assert.equal(error.actual, 200); assert.equal(error.expected, 404); return true;
    });
    await checkPublicIsolation();
  });
});
