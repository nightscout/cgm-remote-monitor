'use strict';

const proxyaddr = require('proxy-addr');
const { isIP } = require('node:net');

// Compatibility mode retains the pre-15.0.9 edge-managed trust boundary.
// The marker also reaches raw API3/Socket.IO consumers through Express's trust fn.
const compatibilityTrust = Object.freeze(Object.assign(() => true, { legacyForwardedHeaders: true }));
const legacyHeaders = ['fastly-client-ip', 'x-forwarded-for', 'z-forwarded-for', 'forwarded', 'x-real-ip'];

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
  // Raw Socket.IO requests do not have Express getters or an app reference.
  const socket = req.socket || req.connection || {};
  const peer = socket.remoteAddress;
  if (!peer) return undefined;
  const headers = req.headers || {};
  if (trust.legacyForwardedHeaders) {
    // Fixed precedence avoids the old forwarded-for package's request-history
    // dependent ordering. Validate the entire selected chain before using it.
    for (const name of legacyHeaders) {
      if (!(name in headers)) continue;
      if (typeof headers[name] !== 'string') return peer;
      const addresses = headers[name].split(',').map(value => {
        const address = value.trim();
        if (isIP(address)) return address;
        const withPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(address);
        return withPort ? withPort[1] : address;
      });
      return addresses.every(address => isIP(address)) ? addresses[0] : peer;
    }
    return peer;
  }
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
