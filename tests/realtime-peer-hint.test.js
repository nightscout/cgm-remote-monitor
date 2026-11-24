'use strict';

const assert = require('node:assert/strict');
const dns = require('node:dns');
const http = require('node:http');
const ownership = require('../lib/realtime-ownership');
const wake = require('../lib/pgstream/output-wake');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000003';
const hosts = [0, 1].map(i => 'realtime-' + i + '.realtime-peers.synthetic.invalid');

describe('evaluator completed-output peer hints over HTTP', function () {
  let server, routes, originalLookup, lookups, connections, received, lookupAddress, closeResponses;
  beforeEach(async function () {
    lookups = [];
    connections = new Set();
    received = [];
    closeResponses = false;
    lookupAddress = () => '127.0.0.1';
    originalLookup = dns.lookup;
    dns.lookup = function (name, options, callback) {
      if (!hosts.includes(name)) return originalLookup.apply(this, arguments);
      lookups.push(name);
      const address = lookupAddress(name);
      setImmediate(() => {
        if (address instanceof Error) return callback(address);
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      });
    };
    server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ host: req.headers.host.split(':')[0], path: req.url, body: JSON.parse(Buffer.concat(chunks)) });
      connections.add(req.socket);
      if (closeResponses) res.setHeader('connection', 'close');
      res.setHeader('content-type', 'application/json');
      res.end('{"accepted":true}');
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const peers = hosts.map(name => ({url: 'http://' + name + ':' + server.address().port + '/'}));
    routes = ownership.peers({NS_REALTIME_SLICE_PEERS: JSON.stringify(peers)}, undefined, {maxBytes: 4096, timeoutMs: 1000});
  });
  afterEach(async function () {
    dns.lookup = originalLookup;
    routes?.close?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
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
  });
});
