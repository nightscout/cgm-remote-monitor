'use strict';

// covers: lib/server/serve/tenant-startup.js, lib/server/internal-api/transport.js, lib/server/serve/internal-listener.js, lib/server/serve/pool-config.js, lib/server/serve/preview-realtime.js
// Realtime warms its tenants against the api over the internal transport. When
// the api restarts with realtime, its first answers are "not ready" (no
// listener, the listener up before the api role has bound, TENANT_WARMING).
// Those are retried with bounded jittered backoff inside the warm's bounded
// concurrency, until a deadline; a refusal (401/403/423, a tenant the api does
// not know) is never retried. Actual UDS and loopback HTTP listeners; synthetic
// tenants only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const transport = require('../lib/server/internal-api/transport');
const contracts = require('../lib/server/internal-api/contracts');
const startup = require('../lib/server/serve/tenant-startup');
const poolConfig = require('../lib/server/serve/pool-config');

const tenantId = i => '7e570000-0000-4000-8000-' + String(i).padStart(12, '0');
const host = tenant => 'tenant-' + tenant.slice(-4) + '.synthetic.example.test';
const body = tenant => ({ host: host(tenant), tenant, namespace: '/', credential: {} });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedPort () {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function endpoint (kind) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-retry-'));
  fs.chmodSync(directory, 0o700);
  const base = kind === 'uds' ? { socketPath: path.join(directory, 'api.sock') } : { url: 'http://127.0.0.1:' + await unusedPort(), trust: 'network' };
  return { options: { ...base, maxBytes: 4096, timeoutMs: 1000 }, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
// The api side of a restart: a real serve-then-warm startup (TENANT_WARMING
// for a cold tenant, which moves it to the front) behind the real handler.
function apiModule (tenants, { warmMs = 20, concurrency = 4, refuse = new Set() } = {}) {
  const seen = { requests: 0, inFlight: 0, maxInFlight: 0, warming: 0, refused: 0 };
  const apiStartup = startup.create(tenants, undefined, () => delay(warmMs), { readiness: 'serve', concurrency, coldAlertMs: null,
    alert () {}, drainedLog () {} });
  const module = { service: contracts.socketAuthority, create: () => ({
    async authorizeSocket (ctx, request) {
      seen.requests++; seen.inFlight++; seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
      try {
        if (refuse.has(request.tenant)) seen.refused++;
        if (refuse.has(request.tenant)) throw Object.assign(new Error('SOCKET_PRIVATE_TENANT_REFUSED'), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' });
        try { await apiStartup.admit(request.tenant); } catch (error) { if (error.code === 'TENANT_WARMING') seen.warming++; throw error; }
        return { denied: true };
      } finally { seen.inFlight--; }
    },
    async executeSocketMutation () { throw new Error('unused'); } }) };
  // The api's own background warm starts with its listener (a restart).
  return { module, seen, start: () => apiStartup.warm(), close: () => apiStartup.close() };
}
// The realtime side: its own serve-then-warm startup whose initialization
// authorizes against the api through `retry`, as lib/server/serve/preview-realtime.js does.
function realtimeWarm (tenants, options, retry, { concurrency = 4 } = {}) {
  const api = transport.client(options, contracts.socketAuthority);
  const rt = startup.create(tenants, undefined, tenant => retry.run(() => api.authorizeSocket(body(tenant))),
    { readiness: 'serve', concurrency, coldAlertMs: null, alert () {}, drainedLog () {} });
  rt.warm();
  return rt;
}

describe('realtime startup warm against a restarting api', function () {
  this.timeout(20000);

  it('reads NS_TENANT_WARM_RETRY_MS: default 60000, 0 disables, bounded at 600000', function () {
    assert.equal(poolConfig.warmRetryMs({}), 60000);
    assert.equal(poolConfig.warmRetryMs({ NS_TENANT_WARM_RETRY_MS: '0' }), 0);
    assert.equal(poolConfig.warmRetryMs({ NS_TENANT_WARM_RETRY_MS: '600000' }), 600000);
    for (const raw of ['600001', '-1', '1.5', 'soon', '00']) assert.throws(() => poolConfig.warmRetryMs({ NS_TENANT_WARM_RETRY_MS: raw }), /NS_TENANT_WARM_RETRY_MS/, raw);
  });

  it('backs off with jitter until the shared deadline, resets on success, and never retries a refusal', async function () {
    let clock = 0; const sleeps = [];
    const retry = startup.notReadyRetry({ deadlineMs: 1000, baseDelayMs: 100, maxDelayMs: 400, now: () => clock,
      random: () => 0.5, sleep: async ms => { sleeps.push(ms); clock += ms; } });
    const notReady = () => Object.assign(new Error('SOCKET_IPC_UNAVAILABLE'), { notReady: true });
    let calls = 0;
    assert.equal(await retry.run(async () => { if (++calls < 4) throw notReady(); return 'ok'; }), 'ok');
    assert.deepEqual(sleeps, [75, 150, 300], 'equal jitter over 100, 200, 400 ms');
    // Past the deadline every caller fails at once; the outage clock is shared.
    sleeps.length = 0; calls = 0;
    await assert.rejects(retry.run(async () => { calls++; throw notReady(); }), /SOCKET_IPC_UNAVAILABLE/);
    assert.ok(sleeps.reduce((a, b) => a + b, 0) <= 1000, 'retries stop at the deadline');
    const before = calls;
    await assert.rejects(retry.run(async () => { calls++; throw notReady(); }));
    assert.equal(calls - before, 1, 'past the deadline a caller fails on its first not-ready answer');
    assert.equal(await retry.run(async () => 'back'), 'back');
    sleeps.length = 0; calls = 0;
    assert.equal(await retry.run(async () => { if (++calls < 2) throw notReady(); return 'again'; }), 'again', 'a success resets the outage');
    // A refusal (and an unmarked unavailable) is thrown on the first answer.
    for (const refusal of [new Error('SOCKET_IPC_UNAVAILABLE'), Object.assign(new Error('TENANT_UNAVAILABLE'), { code: 'TENANT_UNAVAILABLE' })]) {
      calls = 0;
      await assert.rejects(retry.run(async () => { calls++; throw refusal; }), error => error === refusal);
      assert.equal(calls, 1, 'not retried: ' + refusal.message);
    }
  });

  for (const kind of ['uds', 'http']) {
    it('marks not ready only a missing listener, an unbound role and TENANT_WARMING over ' + kind, async function () {
      const e = await endpoint(kind);
      let listener;
      try {
        const client = transport.client(e.options, contracts.socketAuthority);
        await assert.rejects(client.authorizeSocket(body(tenantId(1))), error => error.message === 'SOCKET_IPC_UNAVAILABLE' && error.notReady === true, 'no listener');
        let mode = 'unbound';
        listener = await transport.compose(e.options, [{ service: contracts.socketAuthority, create: () => ({
          async authorizeSocket () {
            if (mode === 'unbound') throw Object.assign(new Error('SOCKET_IPC_NOT_READY'), { code: 'SOCKET_IPC_NOT_READY' });
            if (mode === 'warming') throw Object.assign(new Error('TENANT_WARMING'), { code: 'TENANT_WARMING', retryAfter: 5 });
            if (mode === 'refused') throw Object.assign(new Error('SOCKET_PRIVATE_TENANT_REFUSED'), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' });
            if (mode === 'unavailable') throw Object.assign(new Error('TENANT_UNAVAILABLE'), { code: 'TENANT_UNAVAILABLE' });
            return { denied: true };
          }, async executeSocketMutation () { return { replyArgs: [] }; } }) }]);
        for (const [state, notReady] of [['unbound', true], ['warming', true], ['refused', false], ['unavailable', false]]) {
          mode = state;
          await assert.rejects(client.authorizeSocket(body(tenantId(1))), error => error.message === 'SOCKET_IPC_UNAVAILABLE' && (error.notReady === true) === notReady, state);
        }
        mode = 'ok';
        assert.deepEqual(await client.authorizeSocket(body(tenantId(1))), { denied: true });
      } finally { if (listener) await listener.close(); e.cleanup(); }
    });
  }

  it('answers SOCKET_IPC_NOT_READY from the process listener until the api role binds', async function () {
    const e = await endpoint('uds');
    const internalListener = require('../lib/server/serve/internal-listener');
    let opened;
    try {
      opened = await internalListener.open({ listen: e.options, shutdownTimeoutMs: 1000 },
        [{ id: 'socket-authority', roles: ['api'], tenantScoped: false, bounds: { maxBytes: 4096, timeoutMs: 1000 } }]);
      const client = transport.client(e.options, contracts.socketAuthority);
      await assert.rejects(client.authorizeSocket(body(tenantId(1))), error => error.notReady === true, 'unbound role is not ready');
      opened.bind('api', { 'socket-authority': { create: () => ({ async authorizeSocket () { return { denied: true }; }, async executeSocketMutation () { return { replyArgs: [] }; } }) } });
      assert.deepEqual(await client.authorizeSocket(body(tenantId(1))), { denied: true });
    } finally { if (opened) await opened.close(); e.cleanup(); }
  });

  for (const kind of ['uds', 'http']) {
    it('warms every tenant through an api restart, at most the warm concurrency in flight, over ' + kind, async function () {
      const tenants = Array.from({ length: 40 }, (_, i) => tenantId(i + 1));
      async function run (deadlineMs) {
        const e = await endpoint(kind);
        const api = apiModule(tenants);
        let listener, rt;
        try {
          // Realtime starts while the api is down: no listener for 300 ms, then
          // the api serves while it warms its own tenants (TENANT_WARMING).
          const retry = startup.notReadyRetry({ deadlineMs, baseDelayMs: 10, maxDelayMs: 100 });
          rt = realtimeWarm(tenants, e.options, retry);
          await delay(300);
          listener = await transport.compose(e.options, [api.module]); api.start();
          await rt.drained();
          return { health: rt.health(), warm: tenants.filter(rt.isReady).length, seen: api.seen, retry: retry.stats() };
        } finally { rt?.close(); api.close(); if (listener) await listener.close(); e.cleanup(); }
      }
      const retried = await run(10000);
      assert.equal(retried.health.failed, 0, 'RESTART_OVERLAP_NO_TENANT_FAILED');
      assert.equal(retried.warm, tenants.length);
      assert.ok(retried.retry.retries > 0, 'the overlap was exercised');
      assert.ok(retried.seen.warming > 0, 'TENANT_WARMING answers were retried: ' + retried.seen.warming);
      assert.ok(retried.seen.maxInFlight <= 4, 'no more than NS_TENANT_STARTUP_CONCURRENCY requests in flight: ' + retried.seen.maxInFlight);
      // The behaviour before the change: no retry, the first not-ready answer fails the tenant.
      const unretried = await run(0);
      assert.ok(unretried.health.failed > 0, 'without retry the overlap fails tenants');
    });
  }

  for (const status of [401, 403, 423]) {
    it('never retries a ' + status + ' refusal during warm', async function () {
      const e = await endpoint('http');
      let requests = 0;
      const server = http.createServer((req, res) => { requests++; req.resume(); req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":"REFUSED"}'); }); });
      await new Promise(resolve => server.listen(Number(new URL(e.options.url).port), '127.0.0.1', resolve));
      const tenants = Array.from({ length: 6 }, (_, i) => tenantId(i + 1));
      try {
        const retry = startup.notReadyRetry({ deadlineMs: 10000, baseDelayMs: 10, maxDelayMs: 100 });
        const rt = realtimeWarm(tenants, e.options, retry);
        await rt.drained(); rt.close();
        assert.equal(requests, tenants.length, 'REFUSAL_NOT_RETRIED: one request per tenant');
        assert.equal(rt.health().failed, tenants.length, 'each refused tenant is marked failed at once');
        assert.equal(retry.stats().retries, 0);
      } finally { await new Promise(resolve => server.close(resolve)); e.cleanup(); }
    });
  }

  it('never retries a tenant the api does not know, while a restart is retried for the others', async function () {
    const tenants = Array.from({ length: 8 }, (_, i) => tenantId(i + 1));
    const e = await endpoint('uds');
    const api = apiModule(tenants, { refuse: new Set([tenants[0]]) });
    let listener, rt;
    try {
      const retry = startup.notReadyRetry({ deadlineMs: 10000, baseDelayMs: 10, maxDelayMs: 100 });
      rt = realtimeWarm(tenants, e.options, retry);
      await delay(100);
      listener = await transport.compose(e.options, [api.module]); api.start();
      await rt.drained();
      const health = rt.health();
      assert.equal(health.failed, 1);
      assert.equal(api.seen.refused, 1, 'UNKNOWN_TENANT_NOT_RETRIED: one request for the refused tenant');
      assert.equal(tenants.filter(rt.isReady).length, tenants.length - 1);
      assert.deepEqual(health.alerts.filter(row => row.code === 'TENANT_WARM_FAILED').map(row => row.tenant), [tenants[0]]);
    } finally { rt?.close(); api.close(); if (listener) await listener.close(); e.cleanup(); }
  });
});
