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
    const req = https.request(url, {
      method: options.method || 'GET', lookup: publicLookup,
      headers: { Accept: 'application/json', ...options.headers }, timeout: 20000
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) req.destroy(new Error('limit'));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new ConnectError('provider_unavailable', 502)));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {
          return reject(new ConnectError('provider_unavailable', 502));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const expired = data.error === 'invalid_grant' || res.statusCode === 401;
          return reject(new ConnectError(expired ? 'reconnect_required' : 'provider_unavailable', expired ? 401 : 502));
        }
        resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new ConnectError('provider_unavailable', 502)));
    req.end(body);
  });
}
module.exports = { request, providerUrl, publicAddress, publicLookup };
