'use strict';

const assert = require('assert');
const {once} = require('events');
const {createRequire} = require('module');
const analyzerRequire = createRequire(require.resolve('webpack-bundle-analyzer/package.json'));
const WebSocket = analyzerRequire('ws');

describe('Bundle analyzer WebSocket compatibility', function () {
  it('bounds retained message fragments', async function () {
    const receiver = new WebSocket.Receiver('nodebuffer', {}, false, 0, 0, 4);
    try {
      const error = once(receiver, 'error', {signal: AbortSignal.timeout(1000)});
      receiver.end(Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 128, 0]));
      assert.strictEqual((await error)[0].code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
    } finally { receiver.destroy(); }
  });
  it('resets the fragment count between consecutive valid messages', function () {
    const receiver = new WebSocket.Receiver('nodebuffer', {}, false, 0, 0, 4);
    const received = [];
    const errors = [];
    receiver.on('message', data => received.push(Array.from(data)));
    receiver.on('error', error => errors.push(error));
    try {
      const frame = Buffer.from([2, 1, 1, 0, 1, 2, 0, 1, 3, 128, 1, 4]);
      receiver.end(Buffer.concat([frame, frame]));
      assert.deepStrictEqual(received, [[1, 2, 3, 4], [1, 2, 3, 4]]);
      assert.deepStrictEqual(errors, []);
    } finally { receiver.destroy(); }
  });
  it('bounds tiny buffered chunks in an incomplete frame', async function () {
    const receiver = new WebSocket.Receiver('nodebuffer', {}, false, 0, 4, 0);
    try {
      const error = once(receiver, 'error', {signal: AbortSignal.timeout(1000)});
      receiver.write(Buffer.from([130, 126, 1, 0]));
      for (let i = 0; i < 5; i++) receiver.write(Buffer.from([1]));
      assert.strictEqual((await error)[0].code, 'WS_ERR_TOO_MANY_BUFFERED_PARTS');
    } finally { receiver.destroy(); }
  });
  it('exchanges Unicode and fragmented binary messages over fresh connections', async function () {
    const server = new WebSocket.Server({host: '127.0.0.1', port: 0});
    server.on('connection', peer => peer.on('message', data => peer.send(data)));
    await once(server, 'listening');
    let client;
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        client = new WebSocket('ws://127.0.0.1:' + server.address().port);
        await once(client, 'open');
        let response = once(client, 'message');
        client.send('Café 💉 ' + cycle);
        assert.strictEqual(String((await response)[0]), 'Café 💉 ' + cycle);
        response = once(client, 'message');
        client.send(Buffer.from([0, 127]), {fin: false});
        client.send(Buffer.from([255]), {fin: true});
        assert.deepStrictEqual(Array.from((await response)[0]), [0, 127, 255]);
        const closed = once(client, 'close');
        client.close();
        await closed;
      }
    } finally {
      if (client) client.terminate();
      server.clients.forEach(peer => peer.terminate());
      await new Promise(resolve => server.close(resolve));
    }
  });
});
