'use strict';

// Bounded REST admission (lib/server/serve/rest-admission.js) on actual HTTP
// listeners, and in the production api composition with its real tenant router
// and a separately bound real socket-authority transport. Storage is a recording
// synthetic store; this measures admission and listener isolation, not
// PostgreSQL pool behaviour or clinical delivery latency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const admission = require('../lib/server/serve/rest-admission');

const FAST_MS = 500; // a refusal must not wait for a held handler (held for seconds)

function send (port, { method = 'POST', path: target = '/write', body = '{"synthetic":true}' } = {}) {
  const started = Date.now();
  let request;
  const done = new Promise((resolve, reject) => {
    request = http.request({ host: '127.0.0.1', port, method, path: target, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text, ms: Date.now() - started }));
    });
    request.on('error', reject); request.end(body);
  });
  return { done, abort: () => request.destroy() };
}
async function listen (handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server;
}
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
async function until (check, label, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out waiting for ' + label); await new Promise(resolve => setTimeout(resolve, 5)); }
}
// A held synthetic write handler. Its storage effect happens only after release.
function heldStore () {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const state = { entered: 0, effects: [] };
  const handler = async (req, res) => {
    state.entered++;
    await gate;
    state.effects.push(state.entered);
    res.status(201).json({ stored: true });
  };
  return { state, handler, release: () => release() };
}
function withEnv (values, fn) {
  const previous = Object.fromEntries(Object.keys(admission.NAMES).map(key => [admission.NAMES[key], process.env[admission.NAMES[key]]]));
  for (const name of Object.values(admission.NAMES)) delete process.env[name];
  Object.assign(process.env, values);
  return Promise.resolve().then(fn).finally(() => {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
}

describe('REST admission settings', function () {
  it('is off unless a concurrency is selected and refuses partial or out-of-range settings', function () {
    assert.equal(admission.settings({}), null);
    assert.equal(admission.settings({ NS_API_REST_CONCURRENCY: '' }), null);
    assert.deepEqual({ ...admission.settings({ NS_API_REST_CONCURRENCY: '8' }) }, { concurrency: 8, queue: 0, queueTimeoutMs: 1000, retryAfterSeconds: 1 });
    assert.deepEqual({ ...admission.settings({ NS_API_REST_CONCURRENCY: '8', NS_API_REST_QUEUE: '16', NS_API_REST_QUEUE_TIMEOUT_MS: '250', NS_API_REST_RETRY_AFTER_SECONDS: '5' }) },
      { concurrency: 8, queue: 16, queueTimeoutMs: 250, retryAfterSeconds: 5 });
    for (const bad of [{ NS_API_REST_CONCURRENCY: '0' }, { NS_API_REST_CONCURRENCY: '-1' }, { NS_API_REST_CONCURRENCY: '1.5' }, { NS_API_REST_CONCURRENCY: '100001' },
      { NS_API_REST_CONCURRENCY: '4', NS_API_REST_QUEUE_TIMEOUT_MS: '0' }, { NS_API_REST_CONCURRENCY: '4', NS_API_REST_RETRY_AFTER_SECONDS: '0' }]) {
      assert.throws(() => admission.settings(bad), /invalid NS_API_REST_/, JSON.stringify(bad));
    }
    for (const stray of ['NS_API_REST_QUEUE', 'NS_API_REST_QUEUE_TIMEOUT_MS', 'NS_API_REST_RETRY_AFTER_SECONDS']) {
      assert.throws(() => admission.settings({ [stray]: '1' }), new RegExp(stray + ' requires NS_API_REST_CONCURRENCY'));
    }
  });
});

describe('REST admission limiter on an actual listener', function () {
  this.timeout(10000);
  let server;
  afterEach(async () => { if (server) await closeServer(server); server = null; });

  it('admits the queue in order when a slot frees, refuses beyond it, and never refuses an admitted request', async function () {
    const store = heldStore(), limiter = admission.create({ concurrency: 1, queue: 1, queueTimeoutMs: 2000 });
    const app = express(); app.use(limiter.middleware); app.post('/write', store.handler);
    server = await listen(app); const port = server.address().port;
    const first = send(port); await until(() => store.state.entered === 1, 'first admitted');
    const second = send(port); await until(() => limiter.stats().waiting === 1, 'second queued');
    const third = await send(port).done;
    assert.equal(third.status, 503); assert(third.ms < FAST_MS, 'refusal took ' + third.ms + ' ms');
    assert.equal(store.state.entered, 1, 'a queued or refused request must not reach the handler');
    store.release();
    const replies = await Promise.all([first.done, second.done]);
    assert.deepEqual(replies.map(reply => reply.status), [201, 201]);
    assert.deepEqual(store.state.effects, [1, 2]);
    assert.deepEqual({ ...limiter.stats(), concurrency: undefined }, { concurrency: undefined, queue: 1, queueTimeoutMs: 2000, retryAfterSeconds: 1,
      inflight: 0, waiting: 0, admitted: 2, queued: 1, refused: 1, expired: 0, abandoned: 0 });
  });

  it('refuses a waiting request at its deadline before any handler runs, even when a slot frees later', async function () {
    const store = heldStore(), limiter = admission.create({ concurrency: 1, queue: 4, queueTimeoutMs: 100, retryAfterSeconds: 7 });
    const app = express(); app.use(limiter.middleware); app.post('/write', store.handler);
    server = await listen(app); const port = server.address().port;
    const first = send(port); await until(() => store.state.entered === 1, 'first admitted');
    const waited = await send(port).done;
    assert.equal(waited.status, 503); assert.equal(waited.headers['retry-after'], '7');
    assert(waited.ms >= 90 && waited.ms < 100 + FAST_MS, 'expiry took ' + waited.ms + ' ms');
    store.release(); assert.equal((await first.done).status, 201);
    assert.deepEqual(store.state.effects, [1], 'an expired request must never be stored');
    assert.equal(limiter.stats().expired, 1);
  });

  it('forgets a waiting request whose client disconnects without running it', async function () {
    const store = heldStore(), limiter = admission.create({ concurrency: 1, queue: 1, queueTimeoutMs: 5000 });
    const app = express(); app.use(limiter.middleware); app.post('/write', store.handler);
    server = await listen(app); const port = server.address().port;
    const first = send(port); await until(() => store.state.entered === 1, 'first admitted');
    const gone = send(port); gone.done.catch(() => {});
    await until(() => limiter.stats().waiting === 1, 'second queued');
    gone.abort(); await until(() => limiter.stats().abandoned === 1, 'abandoned');
    store.release(); await first.done;
    assert.deepEqual(store.state.effects, [1]); assert.equal(limiter.stats().inflight, 0);
    const later = send(port); store.release();
    assert.equal((await later.done).status, 201, 'a released slot admits the next request');
  });
  it('runs a request admitted from the queue in its own async context, never the releasing request\'s', async function () {
    // The tenant app wraps each request in an AsyncLocalStorage operation-window
    // scope and refuses a request that arrives inside another request's scope.
    // This mirrors that wrapping with a plain AsyncLocalStorage.
    const { AsyncLocalStorage } = require('node:async_hooks');
    const scopes = new AsyncLocalStorage(), store = heldStore(), inherited = [];
    const limiter = admission.create({ concurrency: 1, queue: 2, queueTimeoutMs: 3000 });
    const app = express(); app.use(limiter.middleware);
    let sequence = 0;
    app.use((req, res, next) => { inherited.push(scopes.getStore()?.owner ?? null); scopes.run({ owner: ++sequence }, next); });
    app.post('/write', store.handler);
    server = await listen(app); const port = server.address().port;
    const first = send(port); await until(() => store.state.entered === 1, 'first admitted');
    const second = send(port), third = send(port); await until(() => limiter.stats().waiting === 2, 'two queued');
    store.release();
    assert.deepEqual((await Promise.all([first.done, second.done, third.done])).map(reply => reply.status), [201, 201, 201]);
    assert.equal(limiter.stats().queued, 2, 'both later requests were admitted from the queue');
    assert.deepEqual(inherited, [null, null, null], 'a queued request must not inherit another request\'s async scope');
  });
});

describe('REST admission in the production api composition', function () {
  this.timeout(15000);
  const transport = require('../lib/server/internal-api/transport');
  const descriptor = require('../lib/server/internal-api/contracts').socketAuthority;
  const tenant = '11111111-1111-4111-8111-111111111111';

  // Boot the actual preview-api module with its real tenant HTTP router and real
  // limiter wiring. Storage, credentials and domain routers are recording stubs;
  // the private receiver is a real separately bound socket-authority transport.
  async function composition () {
    const scope = require('../lib/storage/tenant-scope');
    const file = require.resolve('../lib/server/serve/preview-api');
    const local = require('node:module').createRequire(file);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-admission-')); fs.chmodSync(directory, 0o700);
    const internalOptions = { socketPath: path.join(directory, 'api.sock'), maxBytes: 4096, timeoutMs: 1000 };
    const store = heldStore(), internalCalls = [];
    const router = express.Router();
    router.post('/held', store.handler);
    let listener;
    const resource = extra => ({ async end () {}, ...extra });
    const stubs = {
      '../../storage/postgres-connection': async () => resource(),
      '../../secrets/legacy-postgres': async () => resource({ read: async () => ({ reference: { tenant, id: 'synthetic' } }) }),
      '../../tenant-authorization/postgres': async () => resource({ authorize: async () => false }),
      '../../secrets/postgres': { createPostgresSecrets: async () => resource({ store: { get: async () => ({}) } }) },
      '../../secrets/component': { createSecrets: () => ({}) },
      './platform-verification': require('./fixtures/platform-proof')(), './tenant-floor-verification': { createReader: () => async () => {} },
      './preview-domains': async () => ({ data: router, v3Names: [], legacyNames: [], safeRoutes: {}, async prepareTenant () {}, invalidateTenant () {}, invalidateAll () {} }),
      '../tenant-app/data-access': () => async () => ({ tenant, principal: 'synthetic', consumer: 'api' }),
      '../tenant-app/exchange': () => async () => null,
      '../../human-session/runtime': { multi: async () => null },
      '../realtime/private-api': { async boot () {
        listener = await transport.open(internalOptions, descriptor, () => ({
          async authorizeSocket () { internalCalls.push('authorize'); return { denied: true }; },
          async executeSocketMutation () { internalCalls.push('mutate'); return { replyArgs: [] }; }
        }));
        return { close: () => listener.close() };
      } }
    };
    const output = { exports: {} };
    require('node:vm').runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
      name => Object.hasOwn(stubs, name) ? stubs[name] : local(name), output, output.exports);
    const previousMode = scope.getTenancyMode();
    let role;
    try {
      role = await output.exports.boot({ bindings: new Map([[tenant, { principal: 'synthetic', consumer: 'api' }]]),
        providers: new Map(), namespaces: { clock: 'synthetic_clock' }, resolver: { resolve: async () => tenant }, socketForwarding: true });
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); scope.setTenancyMode(previousMode); throw error; }
    const server = await listen(role.app);
    return { role, store, internalCalls, port: server.address().port, internal: transport.client(internalOptions, descriptor),
      async close () {
        store.release();
        try { await closeServer(server); await role.close(); } finally { fs.rmSync(directory, { recursive: true, force: true }); scope.setTenancyMode(previousMode); }
      } };
  }
  function tcpConnects (port) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(1500);
      socket.once('connect', () => { socket.end(); resolve(Date.now() - started); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('health probe timed out')); });
      socket.once('error', reject);
    });
  }
  // Fire n+k writes; wait until each is admitted (held) or refused, or the bound passes.
  async function saturate (f, n, k) {
    const requests = Array.from({ length: n + k }, () => send(f.port, { path: '/api/v3/held' }));
    const refused = () => f.role.restAdmission ? f.role.restAdmission().refused : 0;
    await until(() => f.store.state.entered + refused() >= n + k, 'every request admitted or refused', 1000).catch(() => {});
    return requests;
  }

  it('with the limit at N, N+k held writes give exactly k fast 503s and no refused storage effect, while serve.internal and the health probe answer', async function () {
    const N = 3, k = 2;
    await withEnv({ NS_API_REST_CONCURRENCY: String(N), NS_API_REST_RETRY_AFTER_SECONDS: '2' }, async () => {
      const f = await composition();
      try {
        const requests = await saturate(f, N, k);
        assert.equal(f.store.state.entered, N, N + ' admitted and held');
        const settled = await Promise.race([Promise.all(requests.map(r => r.done.then(reply => reply))).then(() => 'all'), new Promise(resolve => setTimeout(() => resolve('held'), 300))]);
        assert.equal(settled, 'held', 'admitted writes stay held');
        // Refusals already answered while N are still held.
        const refusals = [];
        for (const r of requests) {
          const reply = await Promise.race([r.done, new Promise(resolve => setTimeout(() => resolve(null), 50))]);
          if (reply) refusals.push(reply);
        }
        assert.equal(refusals.length, k, 'REST_ADMISSION_REFUSALS: expected ' + k + ' refusals while ' + N + ' were held, got ' + refusals.length);
        for (const reply of refusals) {
          assert.equal(reply.status, 503); assert.equal(reply.headers['retry-after'], '2'); assert.equal(reply.headers['cache-control'], 'no-store');
          assert.equal(JSON.parse(reply.body).error, 'REST_ADMISSION_REFUSED');
          assert(reply.ms < FAST_MS, 'refusal took ' + reply.ms + ' ms');
        }
        assert.equal(f.store.state.entered, N, 'a refused write never reaches its handler');
        // While REST is saturated: serve.internal socket authority and the TCP health probe answer.
        const before = Date.now();
        assert.deepEqual(await f.internal.authorizeSocket({ host: 'synthetic.example', tenant, namespace: '/', credential: {} }), { denied: true });
        assert(Date.now() - before < FAST_MS, 'internal socket authority waited on REST');
        assert.deepEqual(f.internalCalls, ['authorize']);
        assert((await tcpConnects(f.port)) < FAST_MS);
        f.store.release();
        const replies = await Promise.all(requests.map(r => r.done));
        assert.deepEqual(replies.map(reply => reply.status).sort(), [201, 201, 201, 503, 503]);
        assert.equal(f.store.state.effects.length, N, 'exactly the admitted writes were stored');
        assert.deepEqual({ inflight: f.role.restAdmission().inflight, refused: f.role.restAdmission().refused, admitted: f.role.restAdmission().admitted },
          { inflight: 0, refused: k, admitted: N }, 'only the admitted writes consume REST slots');
      } finally { await f.close(); }
    });
  });

  it('keeps the unbounded default when NS_API_REST_CONCURRENCY is unset: every request reaches its handler', async function () {
    await withEnv({}, async () => {
      const f = await composition();
      try {
        assert.equal(f.role.restAdmission, undefined);
        const requests = Array.from({ length: 5 }, () => send(f.port, { path: '/api/v3/held' }));
        await until(() => f.store.state.entered === 5, 'all five admitted');
        f.store.release();
        assert.deepEqual((await Promise.all(requests.map(r => r.done))).map(reply => reply.status), [201, 201, 201, 201, 201]);
      } finally { await f.close(); }
    });
  });

  it('refuses the boot on an invalid bound before any pool opens', async function () {
    await withEnv({ NS_API_REST_QUEUE: '4' }, async () => {
      await assert.rejects(composition(), /NS_API_REST_QUEUE requires NS_API_REST_CONCURRENCY/);
    });
  });
});
