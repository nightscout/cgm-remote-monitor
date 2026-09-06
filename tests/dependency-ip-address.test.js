'use strict';

const assert = require('assert');
const net = require('net');
const { once } = require('events');
const { createRequire } = require('module');
const { Address4, Address6, AddressError } = require('ip-address');
// Resolve the actual SOCKS consumer loaded by the MongoDB driver.
const requireMongo = createRequire(require.resolve('mongodb'));
const { SocksClient } = requireMongo('socks');

describe('ip-address dependency compatibility', function () {
  const ipv6Cases = [
    ['::', '00000000000000000000000000000000'],
    ['::1', '00000000000000000000000000000001'],
    ['2001:db8::1234', '20010db8000000000000000000001234'],
    ['::ffff:192.0.2.1', '00000000000000000000ffffc0000201'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ffffffffffffffffffffffffffffffff']
  ];
  ipv6Cases.forEach(function ([input, hex]) {
    it('preserves all sixteen IPv6 bytes for ' + input, function () {
      const address = new Address6(input);
      const bytes = Array.from(Buffer.from(hex, 'hex'));
      assert.deepStrictEqual(address.toByteArray(), bytes);
      assert.deepStrictEqual(address.toUnsignedByteArray(), bytes);
      assert.strictEqual(Address6.fromByteArray(bytes).canonicalForm(), address.canonicalForm());
      assert.strictEqual(Address6.fromUnsignedByteArray(bytes).canonicalForm(), address.canonicalForm());
    });
  });

  ['127.0.0.1', '192.0.2.1', '255.255.255.255'].forEach(function (input) {
    it('preserves IPv4 octets for ' + input, function () {
      assert.deepStrictEqual(new Address4(input).toArray(), input.split('.').map(Number));
    });
  });

  [[], Array(15).fill(0), Array(17).fill(0), Array(16).fill(256), Array(16).fill(1.5), Array(16).fill(NaN)].forEach(function (bytes, index) {
    it('rejects malformed IPv6 byte array case ' + index, function () {
      assert.throws(() => Address6.fromByteArray(bytes), AddressError);
      assert.throws(() => Address6.fromUnsignedByteArray(bytes), AddressError);
    });
  });

  it('preserves signed-byte compatibility while rejecting signed values in the unsigned API', function () {
    assert.strictEqual(Address6.fromByteArray(Array(16).fill(-1)).canonicalForm(), 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
    assert.throws(() => Address6.fromUnsignedByteArray(Array(16).fill(-1)), AddressError);
    assert.throws(() => Address6.fromByteArray(Array(16).fill(-129)), AddressError);
  });

  ['::/0/1', '2001:db8::/64/64', '::ffff:192.168.001.1'].forEach(function (input) {
    it('rejects ambiguous IPv6 syntax ' + input, function () {
      assert.strictEqual(Address6.isValid(input), false);
      assert.throws(() => new Address6(input), AddressError);
    });
  });

  it('returns a graceful fromURL error for a non-IPv6 host', function () {
    const result = Address6.fromURL('http://127.0.0.1:8080/');
    assert.ok(result.error);
    assert.strictEqual(result.address, null);
    assert.strictEqual(result.port, null);
  });

  it('accepts the highest valid URL port and discards an out-of-range port', function () {
    assert.strictEqual(Address6.fromURL('http://[::1]:65535/').port, 65535);
    assert.strictEqual(Address6.fromURL('http://[::1]:65536/').port, null);
  });
});

describe('MongoDB SOCKS consumer address compatibility', function () {
  let server;
  let peers;
  let client;
  let requests;
  const boundBytes = Buffer.from('20010db8000000000000000000000001', 'hex');
  const boundHost = '2001:0db8:0000:0000:0000:0000:0000:0001';

  beforeEach(async function () {
    peers = new Set();
    requests = [];
    server = net.createServer(peer => {
      peers.add(peer);
      peer.on('close', () => peers.delete(peer));
      let pending = Buffer.alloc(0);
      let stage = 'greeting';
      peer.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        if (stage === 'greeting' && pending.length >= 2 + pending[1]) {
          pending = pending.subarray(2 + pending[1]);
          stage = 'request';
          peer.write(Buffer.from([5, 0]));
        }
        if (stage === 'request' && pending.length >= 5) {
          const length = pending[3] === 1 ? 10 : pending[3] === 4 ? 22 : 7 + pending[4];
          if (pending.length < length) return;
          requests.push(Buffer.from(pending.subarray(0, length)));
          pending = pending.subarray(length);
          stage = 'connected';
          // Fragment the sixteen-byte reply to exercise SOCKS buffering before
          // Address6.fromByteArray receives its complete fixed-width input.
          peer.write(Buffer.from([5, 0, 0, 4]));
          setImmediate(() => {
            if (!peer.destroyed) peer.write(Buffer.concat([boundBytes, Buffer.from([0x69, 0x87])]));
          });
        }
        if (stage === 'connected' && pending.length) {
          peer.write(pending);
          pending = Buffer.alloc(0);
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  afterEach(async function () {
    if (client) client.destroy();
    client = undefined;
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  [
    ['192.0.2.1', Buffer.from([1, 192, 0, 2, 1])],
    ['2001:db8::1234', Buffer.concat([Buffer.from([4]), Buffer.from('20010db8000000000000000000001234', 'hex')])],
    ['db.example.test', Buffer.concat([Buffer.from([3, 15]), Buffer.from('db.example.test')])]
  ].forEach(function ([host, addressBytes]) {
    it('connects twice with ' + host + ' and decodes fragmented IPv6 proxy replies', async function () {
      const requireSocks = createRequire(requireMongo.resolve('socks'));
      assert.strictEqual(requireSocks('ip-address').Address6, Address6);
      for (let cycle = 0; cycle < 2; cycle++) {
        const result = await SocksClient.createConnection({
          command: 'connect',
          proxy: { host: '127.0.0.1', port: server.address().port, type: 5 },
          destination: { host, port: 27017 },
          timeout: 2000
        });
        client = result.socket;
        assert.deepStrictEqual(result.remoteHost, { host: boundHost, port: 27015 });
        assert.deepStrictEqual(requests[cycle], Buffer.concat([Buffer.from([5, 1, 0]), addressBytes, Buffer.from([0x69, 0x89])]));
        const response = once(client, 'data', { signal: AbortSignal.timeout(2000) });
        client.write('proxy-echo-' + cycle);
        assert.strictEqual((await response)[0].toString(), 'proxy-echo-' + cycle);
        client.destroy();
      }
    });
  });
});
