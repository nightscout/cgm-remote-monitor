'use strict';

const assert = require('assert');
const http = require('http');
const { once } = require('events');
const { randomBytes } = require('crypto');
const zlib = require('zlib');
const { Server } = require('engine.io');
const WebSocket = require('ws');

function wireRequest(url, {method = 'GET', headers = {}, chunks = []} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {method, headers}, response => {
      const data = [];
      response.on('data', chunk => data.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers,
        body: Buffer.concat(data)}));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('HTTP request timeout')));
    chunks.forEach(chunk => request.write(chunk));
    request.end();
  });
}

function packet(protocol, value) {
  return protocol === 3 ? value.length + ':' + value : value;
}
function decode(protocol, value) {
  return protocol === 3 ? value.slice(value.indexOf(':') + 1) : value;
}

describe('Engine.IO transport dependency regressions', function () {
  this.timeout(6000);
  let server, engine, url, sockets;
  beforeEach(async function () {
    server = http.createServer();
    engine = new Server({allowEIO3: true, transports: ['polling', 'websocket'],
      httpCompression: {threshold: 512}, perMessageDeflate: {threshold: 512}});
    engine.attach(server);
    engine.on('connection', peer => peer.on('message', message => peer.send(message)));
    sockets = [];
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port + '/engine.io/';
  });
  afterEach(async function () {
    sockets.forEach(socket => socket.terminate());
    engine.close();
    await new Promise(resolve => server.close(resolve));
  });
  async function handshake(protocol) {
    const response = await wireRequest(url + '?EIO=' + protocol + '&transport=polling');
    assert.strictEqual(response.status, 200);
    const open = decode(protocol, response.body.toString());
    assert.strictEqual(open[0], '0');
    return JSON.parse(open.slice(1)).sid;
  }
  [3, 4].forEach(function (protocol) {
    it('retains protocol ' + protocol + ' polling and unicode payload framing', async function () {
      const sid = await handshake(protocol);
      const endpoint = url + '?EIO=' + protocol + '&transport=polling&sid=' + sid;
      const value = '4Café 💉';
      const body = packet(protocol, value);
      assert.strictEqual((await wireRequest(endpoint, {method: 'POST',
        headers: {'Content-Type': 'text/plain;charset=UTF-8'}, chunks: [body]})).status, 200);
      const reply = await wireRequest(endpoint);
      assert.strictEqual(decode(protocol, reply.body.toString()), value);
    });
    ['polling', 'websocket'].forEach(function (transport) {
      it('rejects protocol changes from ' + protocol + ' on an existing ' + transport + ' session', async function () {
        const sid = await handshake(protocol);
        const other = protocol === 3 ? 4 : 3;
        const rejected = once(engine, 'connection_error', {signal: AbortSignal.timeout(2000)});
        const endpoint = url + '?EIO=' + other + '&transport=' + transport + '&sid=' + sid;
        if (transport === 'polling') {
          // A POST avoids leaving an accepted invalid-version poll open in negative controls.
          const response = await wireRequest(endpoint, {method: 'POST',
            headers: {'Content-Type': 'text/plain'}, chunks: [packet(other, '4invalid')]});
          assert.strictEqual(response.status, 400);
        } else {
          const socket = new WebSocket(endpoint.replace('http:', 'ws:'));
          sockets.push(socket);
          socket.on('error', () => {});
        }
        const [error] = await rejected;
        assert.strictEqual(error.context.name, 'PROTOCOL_MISMATCH');
        assert.strictEqual(error.context.previousProtocol, protocol);
        assert.strictEqual(error.context.protocol, other);
        // Rejection must not corrupt the valid session.
        engine.clients[sid].send('still connected');
        const reply = await wireRequest(url + '?EIO=' + protocol + '&transport=polling&sid=' + sid);
        assert.strictEqual(decode(protocol, reply.body.toString()), '4still connected');
      });
    });
  });

  [3, 4].forEach(function (protocol) {
    ['gzip', 'deflate'].forEach(function (encoding) {
      it('streams ' + encoding + ' protocol ' + protocol + ' polling updates without changing their payload', async function () {
        const sid = await handshake(protocol);
        const value = 'Café 💉'.repeat(10000);
        engine.clients[sid].send(value);
        const response = await wireRequest(url + '?EIO=' + protocol + '&transport=polling&sid=' + sid,
          {headers: {'Accept-Encoding': encoding}});
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers['content-encoding'], encoding);
        const decoded = encoding === 'gzip' ? zlib.gunzipSync(response.body) : zlib.inflateSync(response.body);
        assert.strictEqual(decode(protocol, decoded.toString()), '4' + value);
      });
    });
  });

  it('finishes an aborted compressed write exactly once and releases its polling request', async function () {
    const sid = await handshake(4);
    const peer = engine.clients[sid];
    const transport = peer.transport;
    const drained = once(transport, 'drain', {signal: AbortSignal.timeout(3000)});
    let callbacks = 0;
    peer.send(randomBytes(1024 * 1024).toString('base64'), () => { callbacks++; });
    await new Promise((resolve, reject) => {
      const request = http.get(url + '?EIO=4&transport=polling&sid=' + sid,
        {headers: {'Accept-Encoding': 'gzip'}}, response => {
          assert.strictEqual(response.headers['content-encoding'], 'gzip');
          request.destroy();
          resolve();
        });
      request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    });
    await drained;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(callbacks, 1);
    assert.strictEqual(transport.req, null);
    assert.strictEqual(transport.res, null);
    assert.ok(await handshake(4));
  });

  it('reassembles a chunked UTF-8 polling upload at arbitrary byte boundaries', async function () {
    const sid = await handshake(4);
    const endpoint = url + '?EIO=4&transport=polling&sid=' + sid;
    const value = '4' + 'Café 💉'.repeat(1000);
    const bytes = Buffer.from(value);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
    assert.strictEqual((await wireRequest(endpoint, {method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=UTF-8'}, chunks})).status, 200);
    assert.strictEqual((await wireRequest(endpoint)).body.toString(), value);
  });
});

// Use small explicit caps to exercise the same ws receiver limits without
// allocating the production defaults' thousands of fragments/chunks in CI.
describe('WebSocket bounded buffering', function () {
  it('rejects excessive message fragments', async function () {
    const receiver = new WebSocket.Receiver({maxFragments: 4});
    try {
      const error = once(receiver, 'error', {signal: AbortSignal.timeout(1000)});
      receiver.end(Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 128, 0]));
      assert.strictEqual((await error)[0].code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
    } finally { receiver.destroy(); }
  });
  it('accepts legal fragmentation and resets the count for the next message', function () {
    const receiver = new WebSocket.Receiver({maxFragments: 4});
    const received = [];
    receiver.on('message', data => received.push(Array.from(data)));
    const frame = Buffer.from([2, 1, 1, 0, 1, 2, 0, 1, 3, 128, 1, 4]);
    receiver.end(Buffer.concat([frame, frame]));
    assert.deepStrictEqual(received, [[1, 2, 3, 4], [1, 2, 3, 4]]);
  });
  it('rejects excessive buffered chunks in an incomplete frame', async function () {
    const receiver = new WebSocket.Receiver({maxBufferedChunks: 4});
    try {
      const error = once(receiver, 'error', {signal: AbortSignal.timeout(1000)});
      receiver.write(Buffer.from([130, 126, 1, 0]));
      for (let i = 0; i < 5; i++) receiver.write(Buffer.from([1]));
      assert.strictEqual((await error)[0].code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
    } finally { receiver.destroy(); }
  });
});
