'use strict';

const proxyaddr = require('proxy-addr');
const { isIP } = require('node:net');

function compileTrust (value) {
  if (value === undefined || value === null || value === '') return () => false;
  if (typeof value !== 'string') throw new Error('TRUST_PROXY must be a comma-separated list of proxy IP addresses or CIDRs');
  const addresses = value.split(',').map(value => value.trim());
  if (addresses.some(value => !isIP(value.split('/')[0]))) {
    throw new Error('TRUST_PROXY must contain explicit proxy IP addresses or CIDRs; booleans, hop counts and subnet aliases are unsupported');
  }
  return proxyaddr.compile(addresses);
}

function getClientIP (req, trust) {
  // Raw Socket.IO requests do not have Express getters or an app reference.
  const socket = req.socket || req.connection || {};
  const peer = socket.remoteAddress;
  if (!peer) return undefined;
  const address = proxyaddr({ socket, headers: req.headers || {} }, trust);
  // Ports and malformed forwarding values are deliberately not accepted. The
  // trusted edge must emit bare IPs; fall back to the peer for throttling.
  return isIP(address) ? address : peer;
}

function createClientIP (value) {
  const trust = compileTrust(value);
  return req => getClientIP(req, trust);
}

module.exports = { compileTrust, getClientIP, createClientIP };
