'use strict';

const http = require('http');
const https = require('https');

function send (endpoint, payload, options, callback) {
  options = options || {};
  var timeout = options.timeout || 5000;
  var body = Buffer.from(JSON.stringify(payload));
  var url;

  try {
    url = new URL(endpoint);
  } catch (err) {
    return process.nextTick(function invalidEndpoint () {
      callback(null, { sent: false, error: 'invalid-endpoint' });
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return process.nextTick(function unsupportedProtocol () {
      callback(null, { sent: false, error: 'unsupported-protocol' });
    });
  }

  var transport = url.protocol === 'https:' ? https : http;
  var req = transport.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    },
    timeout
  }, function onResponse (res) {
    res.resume();
    res.on('end', function ended () {
      callback(null, {
        sent: res.statusCode >= 200 && res.statusCode < 300,
        statusCode: res.statusCode
      });
    });
  });

  req.on('timeout', function onTimeout () {
    req.destroy(new Error('timeout'));
  });

  req.on('error', function onError (err) {
    callback(null, {
      sent: false,
      error: err.message
    });
  });

  req.write(body);
  req.end();
}

module.exports = {
  send
};
