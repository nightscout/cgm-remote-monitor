'use strict';

const assert = require('assert');
const http = require('http');
const {once} = require('events');
const {Readable} = require('stream');
const {createRequire} = require('module');
const fromBridge = createRequire(require.resolve('minimed-connect-to-nightscout'));
const request = fromBridge('request');

describe('legacy request multipart compatibility', function () {
  let server, url, received;
  beforeEach(async function () {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        received = {headers: req.headers, body: Buffer.concat(chunks)};
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = 'http://127.0.0.1:' + server.address().port;
  });
  afterEach(async function () {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  function post(formData) {
    return new Promise((resolve, reject) => request.post({url, formData, proxy: null, timeout: 2000},
      (error, response, body) => error ? reject(error) : resolve({response, body})));
  }

  it('sends ordinary unicode values and binary files with correct boundaries and length', async function () {
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    const result = await post({notes: 'Café 💉', file: {value: bytes, options: {filename: 'reading.bin', contentType: 'application/octet-stream'}}});
    assert.strictEqual(result.response.statusCode, 200);
    assert.strictEqual(result.body, 'ok');
    assert.strictEqual(Number(received.headers['content-length']), received.body.length);
    const form = await new Response(received.body, {headers: received.headers}).formData();
    assert.strictEqual(form.get('notes'), 'Café 💉');
    assert.strictEqual(form.get('file').name, 'reading.bin');
    assert.deepStrictEqual(Buffer.from(await form.get('file').arrayBuffer()), bytes);
  });

  for (const field of [true, false]) {
    it('escapes quotes and CRLF in the multipart ' + (field ? 'field name' : 'filename'), async function () {
      const hostile = 'value"\r\nX-Injected: yes\r\nextra="';
      await post({[field ? hostile : 'file']: {
        value: Readable.from(['fixture']),
        options: {filename: field ? 'safe.txt' : hostile, contentType: 'text/plain', knownLength: 7}
      }});
      const body = received.body.toString();
      assert.strictEqual(body.includes('\r\nX-Injected:'), false);
      assert.ok(body.includes('value%22%0D%0AX-Injected: yes%0D%0Aextra=%22'));
      assert.strictEqual((body.match(/Content-Disposition:/g) || []).length, 1);
      const form = await new Response(received.body, {headers: received.headers}).formData();
      assert.strictEqual([...form.keys()].length, 1);
      assert.strictEqual(await [...form.values()][0].text(), 'fixture');
    });
  }
});
