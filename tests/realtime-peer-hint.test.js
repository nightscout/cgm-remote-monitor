'use strict';

const assert = require('node:assert/strict');
const dns = require('node:dns');
const http = require('node:http');
const { mock } = require('node:test');
const ownership = require('../lib/realtime-ownership');
const wake = require('../lib/pgstream/output-wake');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000003';
const hosts = [0, 1].map(i => 'realtime-' + i + '.realtime-peers.synthetic.invalid');

describe('evaluator completed-output peer hints over HTTP', function () {
  let server, replacement, routes, originalLookup, lookups, connections, received, lookupAddress, closeResponses;
  function peerServer () {
    const peer = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ host: req.headers.host.split(':')[0], ip: req.socket.localAddress, path: req.url,
        body: JSON.parse(Buffer.concat(chunks)) });
      connections.add(req.socket);
      if (closeResponses) res.setHeader('connection', 'close');
      res.setHeader('content-type', 'application/json');
      res.end('{"accepted":true}');
    });
    peer.keepAliveTimeout = 60000;
    return peer;
  }
  function listen (peer, host, port) {
    return new Promise((resolve, reject) => peer.once('error', reject).listen(port, host, resolve));
  }
  async function close (peer) {
    if (!peer?.listening) return;
    const stopped = new Promise(resolve => peer.close(resolve));
    peer.closeAllConnections();
    await stopped;
  }
  beforeEach(async function () {
    lookups = [];
    connections = new Set();
    received = [];
    closeResponses = false;
    replacement = null;
    lookupAddress = () => '127.0.0.1';
    originalLookup = dns.lookup;
    dns.lookup = function (name, options, callback) {
      if (!hosts.includes(name)) return originalLookup.apply(this, arguments);
      lookups.push(name);
      Promise.resolve(lookupAddress(name)).then(address => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      }, callback);
    };
    server = peerServer();
    await listen(server, '127.0.0.1', 0);
    const peers = hosts.map(name => ({url: 'http://' + name + ':' + server.address().port + '/'}));
    routes = ownership.peers({NS_REALTIME_SLICE_PEERS: JSON.stringify(peers)}, undefined, {maxBytes: 4096, timeoutMs: 1000});
  });
  afterEach(async function () {
    dns.lookup = originalLookup;
    routes?.close?.();
    await Promise.all([close(server), close(replacement)]);
  });

  it('resolves each destination once across committed wakes even when the peer closes each connection', async function () {
    closeResponses = true;
    const sender = wake.create({send: body => routes.hint(body)});
    try {
      for (let i = 0; i < 6; i++) {
        assert.equal(sender.wake(A), undefined);
        assert.equal(sender.wake(B), undefined);
        await sender.flush();
      }
      assert.equal(sender.stats().failures, 0);
      assert.equal(connections.size, 12);
      for (const [i, tenant] of [A, B].entries()) {
        const hits = received.filter(row => row.host === hosts[i]);
        assert.equal(hits.length, 6);
        assert(hits.every(row => row.path === '/completed-output/hint' && row.body.tenants.join() === tenant));
      }
      assert.deepEqual(lookups.sort(), hosts);
    } finally { await sender.close(); }
  });

  it('reuses one keep-alive connection per destination', async function () {
    for (let i = 0; i < 6; i++) await routes.hint({tenants: [A, B]});
    assert.equal(received.length, 12);
    assert.equal(connections.size, 2);
    const disconnected = [...connections].map(socket => new Promise(resolve => socket.once('close', resolve)));
    routes.close();
    await Promise.all(disconnected);
  });

  it('refreshes a named peer while the original address still serves keep-alive requests', async function () {
    replacement = peerServer();
    await listen(replacement, '127.0.0.2', server.address().port);
    let now = 0;
    const clock = mock.method(performance, 'now', () => now);
    try {
      await routes.hint({tenants: [A]});
      lookupAddress = () => '127.0.0.2';
      now = 4999;
      await routes.hint({tenants: [A]});
      now = 5000;
      await routes.hint({tenants: [A]});
      assert.deepEqual(received.map(row => row.ip), ['127.0.0.1', '127.0.0.1', '127.0.0.2']);
      assert.deepEqual(lookups, [hosts[0], hosts[0]]);
    } finally { clock.mock.restore(); }
  });

  it('drops a refused address and resolves on the next independent hint', async function () {
    closeResponses = true;
    replacement = peerServer();
    await listen(replacement, '127.0.0.2', server.address().port);
    await routes.hint({tenants: [A]});
    lookupAddress = () => '127.0.0.2';
    await close(server);
    await assert.rejects(routes.hint({tenants: [A]}), {code: 'REALTIME_OUTPUT_HINT_UNAVAILABLE'});
    assert.deepEqual(lookups, [hosts[0]]);
    await routes.hint({tenants: [A]});
    assert.deepEqual(lookups, [hosts[0], hosts[0]]);
    assert.deepEqual(received.map(row => row.ip), ['127.0.0.1', '127.0.0.2']);
  });

  it('recovers from a resolver error on the next hint', async function () {
    lookupAddress = () => Promise.reject(Object.assign(Error('peer restarting'), {code: 'EAI_AGAIN'}));
    await assert.rejects(routes.hint({tenants: [A]}), {code: 'REALTIME_OUTPUT_HINT_UNAVAILABLE'});
    lookupAddress = () => '127.0.0.1';
    await routes.hint({tenants: [A]});
    assert.deepEqual(lookups, [hosts[0], hosts[0]]);
    assert.equal(received.length, 1);
  });

  it('lets a single-peer wake expire during DNS and never replays the expired POST', async function () {
    const client = require('../lib/server/internal-api/clients').completedOutput({...routes.endpoints[0], timeoutMs: 100});
    const sender = wake.create({send: body => client.hintCompletedOutput(body)});
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    lookupAddress = () => slow;
    try {
      assert.equal(sender.wake(A), undefined);
      await sender.flush();
      assert.equal(sender.stats().failures, 1);
      sender.wake(A);
      await sender.flush();
      assert.equal(sender.stats().failures, 2);
      assert.deepEqual(lookups, [hosts[0]], 'expired requests share the outstanding system lookup');
      assert.equal(received.length, 0);
      release('127.0.0.1');
      await new Promise(resolve => setImmediate(resolve));
      sender.wake(B);
      await sender.flush();
      assert.equal(sender.stats().failures, 2);
      assert.deepEqual(received.map(row => row.body.tenants), [[B]]);
      assert.deepEqual(lookups, [hosts[0], hosts[0]]);
    } finally { release('127.0.0.1'); await sender.close(); client.close(); }
  });
});
