'use strict';

const proxyaddr = require('proxy-addr');
const { isIP } = require('node:net');
const forwarded = require('forwarded-for');

// Compatibility mode retains the pre-15.0.9 edge-managed trust boundary.
// The marker also reaches raw API3/Socket.IO consumers through Express's trust fn.
const compatibilityTrust = Object.freeze(Object.assign(() => true, { legacyForwardedHeaders: true }));

function compileTrust (value) {
  if (typeof value === 'string') value = value.trim();
  if (value === undefined || value === null || value === '') return compatibilityTrust;
  if (value === false || value === 'false') return () => false;
  if (typeof value !== 'string') throw new Error('TRUST_PROXY must be false or a comma-separated list of proxy IP addresses or CIDRs');
  const addresses = value.split(',').map(value => value.trim());
  if (addresses.some(value => !isIP(value.split('/')[0]))) {
    throw new Error('TRUST_PROXY must contain explicit proxy IP addresses or CIDRs; true, hop counts and subnet aliases are unsupported');
  }
  return proxyaddr.compile(addresses);
}

function getClientIP (req, trust) {
  // BACKPORT DIFFERENCE -- bf2/auth-hardening only, NOT the code on
  // chore/nightscout-modernization (395f3207). With TRUST_PROXY unset this
  // branch resolves the client address with the exact call every consumer on
  // dev makes today, forwarded-for, instead of 395f3207's fixed-precedence
  // reimplementation of it. The maintainer's rule for this setting is that the
  // default is TODAY's behaviour, and the reimplementation, though tidier, is
  // not. Measured against dev 74fc6619 it differs in four ways:
  //   - an IPv6 entry after the first in a comma-and-space chain: dev rejects
  //     the whole chain and uses the socket peer; 395f3207 keeps entry one;
  //   - an IPv4 entry with a non-numeric port suffix: dev strips the suffix;
  //     395f3207 uses the socket peer;
  //   - no socket remote address: dev falls back to headers, then 127.0.0.1;
  //     395f3207 returns undefined;
  //   - more than one forwarding header family on one request: dev's winner
  //     depends on which families EARLIER requests carried; 395f3207's is fixed.
  // tests/client-ip.test.js ("dev behaviour with TRUST_PROXY unset") pins dev's
  // answers. Dropping this block reverts to 395f3207 and fails those pins.
  if (trust.legacyForwardedHeaders) {
    return forwarded(req, req.headers || {}).ip;
  }
  // Raw Socket.IO requests do not have Express getters or an app reference.
  const socket = req.socket || req.connection || {};
  const peer = socket.remoteAddress;
  if (!peer) return undefined;
  const headers = req.headers || {};
  const address = proxyaddr({ socket, headers }, trust);
  // Ports and malformed forwarding values are deliberately not accepted. The
  // trusted edge must emit bare IPs; fall back to the peer for throttling.
  return isIP(address) ? address : peer;
}

function createClientIP (value) {
  const trust = compileTrust(value);
  return req => getClientIP(req, trust);
}

module.exports = { compileTrust, getClientIP, createClientIP };
