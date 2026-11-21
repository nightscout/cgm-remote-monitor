'use strict';

// Graceful shutdown of a private listener (decision
// internal-listener-graceful-shutdown): close() stops accepting at once, lets a
// dispatched call finish and send its response up to the deadline, then
// force-closes what remains; the caller of a force-closed call sees
// SOCKET_IPC_UNAVAILABLE (uncertain, no retry). Actual UDS and loopback HTTP
// listeners with the production transport; a one-operation synthetic contract
// stands in for the role contracts, which share the same dispatch path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const Module = require('node:module');
const transport = require('../lib/server/internal-api/transport');
const BODY = { type: 'object', properties: { request: { type: 'string', pattern: '^[0-9a-f-]{36}$' } }, required: ['request'], additionalProperties: false };
const heldService = Object.freeze({ id: 'drain-probe', version: 1, operations: { hold: { path: '/drain/hold', request: BODY, response: BODY } } });

const REQUEST = '00000000-0000-4000-8000-000000000001';
const LIMITS = { maxBytes: 100000, timeoutMs: 5000 };

function deferred () { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function unusedPort () {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function endpoint (kind) {
  if (kind === 'uds') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-drain-')); fs.chmodSync(dir, 0o700);
    return { address: { socketPath: path.join(dir, 'internal.sock'), ...LIMITS }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }
  return { address: { url: 'http://127.0.0.1:' + await unusedPort(), trust: 'network', ...LIMITS }, cleanup: () => {} };
}
// A listener whose one operation holds until released.
async function held (kind, shutdownTimeoutMs, compose = transport.compose) {
  const { address, cleanup } = await endpoint(kind);
  const entered = deferred(), release = deferred(), finished = [];
  const listener = await compose(address, [{ service: heldService, create: () => ({
    async hold (request, body) { entered.resolve(); await release.promise; finished.push(Date.now()); return { request: body.request }; }
  }) }], { shutdownTimeoutMs });
  const client = transport.client(address, heldService);
  return { address, cleanup, entered, release, finished, listener, client };
}
const settle = promise => promise.then(value => ({ value, at: Date.now() }), error => ({ error, at: Date.now() }));

for (const kind of ['uds', 'http']) {
  describe('internal listener graceful shutdown (' + kind + ')', function () {
    this.timeout(10000);
    it('delivers a held call\'s response when its handler finishes within the deadline, and accepts nothing new', async function () {
      const f = await held(kind, 3000);
      try {
        const call = settle(f.client.hold({ request: REQUEST }));
        await f.entered.promise;
        const started = Date.now(), closing = settle(f.listener.close());
        // A new caller is refused while the held call drains.
        const late = await settle(transport.client(f.address, heldService).hold({ request: REQUEST }));
        assert.ok(late.error, 'INTERNAL_SHUTDOWN_REFUSES_NEW_CALLS');
        await new Promise(resolve => setTimeout(resolve, 150));
        f.release.resolve();
        const result = await call;
        assert.equal(result.error, undefined, 'INTERNAL_SHUTDOWN_HELD_CALL_ANSWERED: ' + (result.error && result.error.message));
        assert.equal(result.value.request, REQUEST);
        assert.ok(result.at - started >= 150, 'the response came after the release, not before');
        const closed = await closing;
        assert.equal(closed.error, undefined);
        assert.ok(closed.at - started < 3000, 'close resolves once the last call answered, before the deadline');
        if (kind === 'uds') assert.equal(fs.existsSync(f.address.socketPath), false, 'published socket removed');
      } finally { f.release.resolve(); await f.listener.close(); f.cleanup(); }
    });
    it('force-closes a call still running at the deadline; the caller sees an uncertain outcome', async function () {
      const f = await held(kind, 200);
      try {
        const call = settle(f.client.hold({ request: REQUEST }));
        await f.entered.promise;
        const started = Date.now(), closing = settle(f.listener.close());
        const result = await call;
        assert.equal(result.error && result.error.message, 'SOCKET_IPC_UNAVAILABLE', 'INTERNAL_SHUTDOWN_DEADLINE_UNCERTAIN');
        assert.ok(result.at - started >= 180, 'held until the deadline (' + (result.at - started) + ' ms), not dropped at shutdown start');
        f.release.resolve();
        const closed = await closing;
        assert.equal(closed.error, undefined);
        assert.equal(f.finished.length, 1, 'the handler itself still ran to completion');
      } finally { f.release.resolve(); await f.listener.close(); f.cleanup(); }
    });
    it('closes idle connections at once instead of waiting for the deadline', async function () {
      const f = await held(kind, 3000);
      try {
        const socket = f.address.socketPath ? net.connect(f.address.socketPath) : net.connect(Number(new URL(f.address.url).port), '127.0.0.1');
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
        const ended = new Promise(resolve => socket.once('close', resolve));
        const started = Date.now();
        await f.listener.close();
        await ended;
        assert.ok(Date.now() - started < 1000, 'idle connection did not hold the drain');
      } finally { f.cleanup(); }
    });
  });
}

describe('internal listener shutdown control', function () {
  this.timeout(10000);
  it('control: the early-drop close() (destroy every connection at shutdown start) loses the held response', async function () {
    const file = require.resolve('../lib/server/internal-api/transport');
    const source = fs.readFileSync(file, 'utf8'), marker = 'for (const socket of sockets) if (!active.has(socket)) socket.destroy();';
    assert(source.includes(marker), 'Mutation marker must match actual transport source');
    const output = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + source.replace(marker, 'for (const socket of sockets) socket.destroy();') + '\n})', { filename: file })(
      Module.createRequire(file), output, output.exports);
    const f = await held('uds', 3000, output.exports.compose);
    try {
      const call = settle(f.client.hold({ request: REQUEST }));
      await f.entered.promise;
      const started = Date.now(), closing = f.listener.close();
      const result = await call;
      assert.equal(result.error && result.error.message, 'SOCKET_IPC_UNAVAILABLE');
      assert.ok(result.at - started < 1000, 'dropped at shutdown start');
      f.release.resolve(); await closing;
    } finally { f.release.resolve(); await f.listener.close(); f.cleanup(); }
  });
});

describe('internal listener shutdown deadline settings', function () {
  it('refuses an unbounded deadline before binding', async function () {
    for (const shutdownTimeoutMs of [-1, 1.5, 2147483648, '100']) {
      await assert.rejects(transport.compose({ socketPath: '/nonexistent/x.sock', ...LIMITS }, [{ service: heldService, create: () => ({}) }], { shutdownTimeoutMs }), TypeError);
    }
  });
});


