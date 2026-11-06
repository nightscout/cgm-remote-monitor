'use strict';

const assert = require('assert');
const http = require('http');
const { once } = require('events');
const { Encoder, Decoder, PacketType } = require('socket.io-parser');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

function roundTrip(packet) {
  const decoder = new Decoder();
  const decoded = [];
  decoder.on('decoded', value => decoded.push(value));
  try {
    new Encoder().encode(packet).forEach(frame => decoder.add(frame));
    assert.strictEqual(decoded.length, 1);
    return decoded[0];
  } finally {
    decoder.destroy();
  }
}

describe('Socket.IO parser dependency compatibility', function () {
  [PacketType.EVENT, PacketType.ACK].forEach(function (type) {
    it('preserves binary data, namespace and acknowledgement ID for packet type ' + type, function () {
      const data = ['dataUpdate', { note: 'Fish & Chips', value: 5.5, binary: Buffer.from([0, 127, 255]) }];
      const decoded = roundTrip({ type, nsp: '/storage', id: 12, data });
      assert.deepStrictEqual(decoded, { type, nsp: '/storage', id: 12, data });
    });

    it('honors toJSON for binary packet type ' + type, function () {
      const binary = Buffer.from('payload');
      const message = { privateField: 'omit', toJSON() { return { binary }; } };
      const decoded = roundTrip({ type, nsp: '/', data: ['event', message] });
      assert.deepStrictEqual(decoded.data, ['event', { binary }]);
    });
  });

  it('preserves ordinary JSON, dates, unicode and nulls', function () {
    const date = new Date('2026-01-02T03:04:05Z');
    const decoded = roundTrip({ type: PacketType.EVENT, nsp: '/', data: ['dataUpdate', { date, note: 'Café 💉', missing: null }] });
    assert.deepStrictEqual(decoded.data, ['dataUpdate', { date: date.toISOString(), note: 'Café 💉', missing: null }]);
  });

  ['50-["event"]', '60-1[]', '51.5-["event"]', '511-["event"]', '5999999999-["event"]'].forEach(function (frame) {
    it('rejects invalid attachment header ' + frame + ' and decodes the next normal packet', function () {
      const decoder = new Decoder();
      const decoded = [];
      decoder.on('decoded', packet => decoded.push(packet));
      try {
        assert.throws(() => decoder.add(frame), /attachments/i);
        assert.strictEqual(decoded.length, 0);
        decoder.add('2["dataUpdate",{"sgv":123}]');
        assert.deepStrictEqual(decoded[0].data, ['dataUpdate', { sgv: 123 }]);
      } finally {
        decoder.destroy();
      }
    });
  });

  it('accepts the default limit of ten binary attachments', function () {
    const data = ['event', Array.from({ length: 10 }, (_, i) => Buffer.from([i]))];
    assert.deepStrictEqual(roundTrip({ type: PacketType.EVENT, nsp: '/', data }).data, data);
  });

  it('discards partial binary reconstruction when destroyed', function () {
    const decoder = new Decoder();
    const decoded = [];
    decoder.on('decoded', value => decoded.push(value));
    try {
      decoder.add('52-["event",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]');
      decoder.add(Buffer.from('partial'));
      decoder.destroy();
      decoder.add('2["dataUpdate",{"sgv":100}]');
      assert.strictEqual(decoded.length, 1);
      assert.deepStrictEqual(decoded[0].data, ['dataUpdate', { sgv: 100 }]);
    } finally {
      decoder.destroy();
    }
  });
});

// Exercise the installed Node client here. The prebuilt browser script served
// by Socket.IO is exercised separately in tests/browser/socket-client.test.js;
// npm overrides do not rewrite that script.
describe('Socket.IO Node transport compatibility', function () {
  this.timeout(10000);
  let io;
  let url;
  let socket;

  beforeEach(async function () {
    const server = http.createServer();
    io = new Server(server, { allowEIO3: true, perMessageDeflate: {threshold: 512}, httpCompression: {threshold: 512} });
    io.on('connection', peer => {
      peer.on('echo', (data, acknowledge) => acknowledge(data));
      peer.on('snapshot', acknowledge => {
        peer.emit('dataUpdate', { sgvs: [{ sgv: 123 }], treatments: [{ notes: 'Fish & Chips' }] });
        acknowledge({ ok: true });
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port;
  });

  afterEach(async function () {
    if (socket) socket.disconnect();
    socket = undefined;
    await new Promise(resolve => io.close(resolve));
  });

  function connect(client) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('connection timeout')), 3000);
      const connected = () => finish();
      function finish(error) {
        clearTimeout(timer);
        client.off('connect', connected);
        client.off('connect_error', finish);
        if (error) reject(error); else resolve();
      }
      client.once('connect', connected);
      client.once('connect_error', finish);
      client.connect();
    });
  }

  function acknowledge(event, ...args) {
    return new Promise((resolve, reject) => {
      socket.timeout(3000).emit(event, ...args, (error, reply) => error ? reject(error) : resolve(reply));
    });
  }

  ['polling', 'websocket', 'upgrade'].forEach(function (transport) {
    it('node exchanges updates and acknowledgements across two reconnects over ' + transport, async function () {
      socket = ioClient(url, { autoConnect: false, forceNew: true, reconnection: false, transports: transport === 'upgrade' ? ['polling', 'websocket'] : [transport] });
      for (let cycle = 0; cycle < 3; cycle++) {
        await connect(socket);
        if (transport === 'upgrade' && socket.io.engine.transport.name !== 'websocket') {
          await once(socket.io.engine, 'upgrade', {signal: AbortSignal.timeout(3000)});
        }
        assert.strictEqual(socket.io.engine.transport.name, transport === 'upgrade' ? 'websocket' : transport);
        const update = once(socket, 'dataUpdate');
        assert.strictEqual((await acknowledge('snapshot')).ok, true);
        assert.deepStrictEqual(JSON.parse(JSON.stringify((await update)[0])), {
          sgvs: [{ sgv: 123 }], treatments: [{ notes: 'Fish & Chips' }]
        });
        const large = {notes: 'Café 💉'.repeat(2048)};
        const largeReply = await acknowledge('echo', large);
        assert.strictEqual(largeReply.notes, large.notes);
        const reply = await acknowledge('echo', { notes: 'Café 💉', binary: Buffer.from([0, 127, 255]) });
        assert.strictEqual(reply.notes, 'Café 💉');
        assert.deepStrictEqual(Array.from(reply.binary), [0, 127, 255]);
        socket.disconnect();
      }
    });
  });

  it('node automatically reconnects and receives updates after two network drops', async function () {
    socket = ioClient(url, {autoConnect: false, forceNew: true, reconnectionDelay: 10,
      reconnectionDelayMax: 20, randomizationFactor: 0, transports: ['polling', 'websocket']});
    await connect(socket);
    for (let cycle = 0; cycle < 2; cycle++) {
      const reconnected = once(socket, 'connect', {signal: AbortSignal.timeout(3000)});
      socket.io.engine.close();
      await reconnected;
      const update = once(socket, 'dataUpdate', {signal: AbortSignal.timeout(3000)});
      assert.strictEqual((await acknowledge('snapshot')).ok, true);
      assert.strictEqual((await update)[0].sgvs[0].sgv, 123);
      assert.strictEqual(io.of('/').sockets.size, 1);
    }
  });

  it('closes a malformed binary connection and accepts a fresh connection', async function () {
    socket = ioClient(url, { autoConnect: false, forceNew: true, reconnection: false, transports: ['websocket'] });
    await connect(socket);
    const disconnected = once(socket, 'disconnect', { signal: AbortSignal.timeout(3000) });
    socket.io.engine.write('50-["invalid"]');
    assert.strictEqual((await disconnected)[0], 'transport close');
    await connect(socket);
    assert.deepStrictEqual(await acknowledge('echo', { sgv: 123 }), { sgv: 123 });
  });
});
