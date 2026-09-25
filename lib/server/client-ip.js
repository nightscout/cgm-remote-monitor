'use strict';

const proxyaddr = require('proxy-addr');
const { isIP } = require('node:net');
const forwarded = require('forwarded-for');

// Compatibility mode retains the pre-15.0.9 edge-managed trust boundary.
// The marker reaches every consumer through trustFor(env) below.
const compatibilityTrust = Object.freeze(Object.assign(() => true, { legacyForwardedHeaders: true }));

// TRUST_PROXY=true is Express's `true`: every hop is trusted, so the client
// address is the left-most X-Forwarded-For entry. It is resolved through
// proxy-addr like the other explicit settings, never through the legacy path.
const trustEveryHop = Object.freeze(Object.assign(() => true, { trustsEveryHop: true }));

// A whole number n is Express's numeric `trust proxy`: the n closest hops are
// trusted, and the address is the one the n-th closest proxy saw.
function trustHops (hops) {
  return Object.freeze(Object.assign((addr, i) => i < hops, { trustedHops: hops }));
}

const SUBNET_ALIASES = ['loopback', 'linklocal', 'uniquelocal'];

const INVALID = 'TRUST_PROXY must be false, true, a whole number of proxy hops (1 or more), '
  + 'or a comma-separated list of proxy IP addresses or CIDRs';

function compileTrust (value) {
  if (value === true || typeof value === 'number') value = String(value);
  if (typeof value === 'string') value = value.trim();
  if (value === undefined || value === null || value === '') return compatibilityTrust;
  if (value === false || value === 'false') return () => false;
  if (typeof value !== 'string') throw new Error(INVALID);
  if (value.toLowerCase() === 'true') return trustEveryHop;
  if (/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) return trustHops(Number(value));
  const addresses = value.split(',').map(value => value.trim());
  // Express's subnet aliases are refused on their own path, so that decision
  // can be changed without touching the address check below.
  if (addresses.some(value => SUBNET_ALIASES.includes(value))) {
    throw new Error(INVALID + '; the subnet aliases ' + SUBNET_ALIASES.join(', ') + ' are not accepted');
  }
  if (addresses.some(value => !isIP(value.split('/')[0]))) {
    throw new Error(INVALID + '; each list entry must be an IP address or CIDR, and a hop count cannot be combined with addresses');
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
  const headers = withoutPorts(req.headers || {});
  const address = proxyaddr({ socket, headers }, trust);
  // Malformed forwarding values are not accepted; fall back to the peer.
  return isIP(address) ? address : peer;
}

// Some edges write each X-Forwarded-For entry with the port it saw:
// Azure App Service sends `203.0.113.5:51234`. Without this, every explicit
// setting fell back to the peer on Azure, so all visitors shared one address.
// Only a numeric port on an otherwise valid address is removed
// (`a.b.c.d:port`, `[v6]:port`, `[v6]`); anything else is left as it is and
// still falls back to the peer. Only the explicit modes read this; the
// compatibility path above never sees it.
const IPV4_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const IPV6_BRACKETED = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/;

function stripPort (entry) {
  const value = entry.trim();
  const match = IPV4_PORT.exec(value) || IPV6_BRACKETED.exec(value);
  return match && isIP(match[1]) ? match[1] : value;
}

function withoutPorts (headers) {
  const chain = headers['x-forwarded-for'];
  if (typeof chain !== 'string' || !/[:\]]/.test(chain)) return headers;
  return Object.assign({}, headers, {
    'x-forwarded-for': chain.split(',').map(stripPort).join(', ')
  });
}

function createClientIP (value) {
  const trust = compileTrust(value);
  return req => getClientIP(req, trust);
}

// The one TRUST_PROXY policy for a running Nightscout. app.js hands it to
// Express, and every other consumer of the client address (authorization,
// the status API, the Socket.IO servers, API v3 authentication, the delay
// list's boot messages) reads it here, so none can disagree with another.
// It is compiled once per env, and again only if env.trustProxy changes.
const policies = new WeakMap();

function trustFor (env) {
  const value = env ? env.trustProxy : undefined;
  const cached = env ? policies.get(env) : undefined;
  if (cached && cached.value === value) return cached.trust;
  const trust = compileTrust(value);
  if (env) policies.set(env, { value, trust });
  return trust;
}

// Compiled when the consumer is created, as createClientIP does, so an
// invalid TRUST_PROXY still fails at boot rather than on the first request.
function clientIPFor (env) {
  const trust = trustFor(env);
  return req => getClientIP(req, trust);
}

module.exports = { compileTrust, getClientIP, createClientIP, trustFor, clientIPFor };
