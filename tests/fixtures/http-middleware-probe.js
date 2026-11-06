'use strict';

// Run crash/resource-leak probes in a child so a regression cannot terminate
// Mocha or retain its server. All traffic is bounded and stays on loopback.
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const express = require('express');
const app = express();
const mode = process.argv[2];
let compressor;

if (mode === 'compression') {
  const createGzip = zlib.createGzip;
  Object.defineProperty(zlib, 'createGzip', {value: function (...args) {
    compressor = createGzip(...args);
    return compressor;
  }});
  app.use(require('compression')());
  app.get('/', function (req, res) {
    res.type('text/plain');
    res.once('close', function () {
      setImmediate(function () {
        try {
          assert.ok(compressor, 'the response must be compressed');
          assert.equal(compressor.destroyed, true, 'client abort must release the compressor');
          console.log('compression cleanup passed');
        } finally {
          if (compressor) compressor.destroy();
          server.close();
        }
      });
    });
    res.write(crypto.randomBytes(65536));
    res.flush();
  });
} else {
  assert.equal(mode, 'parser');
  app.use(require('../../lib/middleware')({}).jsonParser);
  // The parser precedes authentication; malformed compression must not crash
  // the process even when the caller will ultimately be refused.
  app.use(function (req, res) { res.sendStatus(401); });
}

const server = app.listen(0, '127.0.0.1', function () {
  const options = {host: '127.0.0.1', port: server.address().port, agent: false};
  if (mode === 'compression') {
    options.headers = {'Accept-Encoding': 'gzip'};
    const request = http.get(options, function (res) {
      assert.equal(res.headers['content-encoding'], 'gzip');
      res.once('data', function () { res.destroy(); });
    });
    request.on('error', function (error) { throw error; });
  } else {
    const body = Buffer.concat([zlib.gzipSync('{"value":1}'), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
    options.method = 'POST';
    options.headers = {'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': body.length};
    const request = http.request(options, function (res) {
      res.resume();
      res.once('end', function () {
        assert.equal(res.statusCode, 401);
        // Late decompressor errors used to arrive after the response completed.
        setTimeout(function () {
          console.log('compressed parser survived');
          server.close();
        }, 100);
      });
    });
    request.on('error', function (error) { throw error; });
    request.end(body);
  }
});
setTimeout(function () { throw new Error('HTTP middleware probe timed out'); }, 3000).unref();
