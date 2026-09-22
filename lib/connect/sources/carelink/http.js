'use strict';

const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const ConnectError = require('../../errors');

function publicAddress(address) {
  // DNS is resolved once and the checked address is used for the connection.
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19)));
}

function providerUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new ConnectError('provider_configuration', 502); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['minimed.eu', 'minimed.com'].some(domain => url.hostname.endsWith('.' + domain))) {
    throw new ConnectError('provider_configuration', 502);
  }
  return url;
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, { family: 4 }, (err, address, family) => {
    if (err || !publicAddress(address)) return callback(new ConnectError('provider_unavailable', 502));
    if (options && options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  });
}

function request(value, options = {}) {
  const url = providerUrl(value);
  return new Promise((resolve, reject) => {
    const body = options.body;
    const fail = (reason, httpStatus, code = 'provider_unavailable') => new ConnectError(code, code === 'reconnect_required' ? 401 : 502,
      { reason, httpStatus, operation: options.operation });
    let failureReason;
    const req = https.request(url, {
      method: options.method || 'GET', lookup: publicLookup,
      // CareLink's edge rejects requests with no User-Agent before OAuth sees
      // them. Identify this client honestly; do not impersonate a browser/app.
      headers: { Accept: 'application/json', 'User-Agent': 'Nightscout-CareLink/0.1', ...options.headers }, timeout: 20000
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) { failureReason = 'response_too_large'; req.destroy(new Error('limit')); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(fail(failureReason || 'network_error', res.statusCode)));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {
          return reject(fail('invalid_json', res.statusCode));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const expired = data?.error === 'invalid_grant' || res.statusCode === 401;
          return reject(fail('http_error', res.statusCode, expired ? 'reconnect_required' : 'provider_unavailable'));
        }
        resolve(data);
      });
    });
    req.on('timeout', () => { failureReason = 'timeout'; req.destroy(new Error('timeout')); });
    req.on('error', err => reject(fail(failureReason || (['ENOTFOUND', 'EAI_AGAIN'].includes(err.code) ? 'dns_error' : 'network_error'))));
    req.end(body);
  });
}
module.exports = { request, providerUrl, publicAddress, publicLookup };
