'use strict';

// Listeners for `nightscout serve` (D21 rule 2, D7, D16): every role that
// serves HTTP gets its own listener with its own bind address and port, read
// from <PREFIX>_HOSTNAME and <PREFIX>_PORT (lib/server/serve/roles.js names
// the prefixes). Several roles may share a process, never a listener.
//
// The consumer listener is the api role's: API_HOSTNAME / API_PORT, falling
// back to the HOSTNAME / PORT that `single` listens on. It is worked out even
// when api is not one of the roles served, so an internal-plane role can be
// kept off it.
//
// The plane rule, for a role whose plane is 'internal' (admin, D7, §2.3):
//   - it may not bind every interface (that includes the consumer's);
//   - it may not bind the consumer listener's address, on any port;
//   - it may not bind a non-loopback address unless
//     <PREFIX>_INSECURE_BIND_ACKNOWLEDGED=true (ADMIN_INSECURE_BIND_ACKNOWLEDGED).

const net = require('net');
const { ROLES } = require('./roles');

class ListenerError extends Error {}

// lib/server/env.js readENVRaw: Azure's CUSTOMCONNSTR_ prefix and lowercase
// aliases count, and present-but-empty counts as set.
function readRaw (source, name) {
  for (const key of ['CUSTOMCONNSTR_' + name, 'CUSTOMCONNSTR_' + name.toLowerCase(), name, name.toLowerCase()]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return String(source[key]).trim();
  }
  return undefined;
}

function bare (host) {
  return String(host).trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

// An unset or empty host is what listen(port, null) binds: every interface.
function isWildcard (host) {
  return !host || ['0.0.0.0', '::', '0:0:0:0:0:0:0:0'].includes(bare(host));
}

function isLoopback (host) {
  if (isWildcard(host)) return false;
  const h = bare(host);
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('::ffff:')) return isLoopback(h.slice(7));
  return net.isIPv4(h) && h.split('.')[0] === '127';
}

function sameAddress (a, b) {
  const norm = h => (bare(h) === 'localhost' ? '127.0.0.1' : bare(h));
  return norm(a) === norm(b);
}

function parsePort (value, name) {
  if (!/^[0-9]+$/.test(String(value)) || Number(value) > 65535) {
    throw new ListenerError(name + ' must be a port number, not "' + value + '"');
  }
  return Number(value);
}

// The address a role listens on. `fallback` is the consumer address `single`
// would use ({ host, port }, from lib/server/env.js's HOSTNAME and PORT).
function listenerFor (name, source, fallback, roles) {
  const role = (roles || ROLES)[name];
  if (!role || !role.prefix) return null;
  const hostName = role.prefix + '_HOSTNAME';
  const portName = role.prefix + '_PORT';
  let host = readRaw(source, hostName);
  if (host === undefined) host = role.consumerDefault ? fallback.host : role.defaultHost;
  let port = readRaw(source, portName);
  if (port === undefined || port === '') port = role.consumerDefault ? fallback.port : role.defaultPort;
  if (port === undefined || port === null || port === '') {
    throw new ListenerError(name + ' needs a port: set ' + portName);
  }
  return {
    role: name
    , plane: role.plane
    , host: host || null
    , port: parsePort(port, portName)
    , hostName
    , portName
    , acknowledgeName: role.prefix + '_INSECURE_BIND_ACKNOWLEDGED'
  };
}

function describe (spec) {
  return spec.role + ' (' + (spec.host || 'every interface') + ':' + spec.port + ')';
}

function checkPlane (spec, consumer, source) {
  if (spec.plane !== 'internal') return;
  if (isWildcard(spec.host)) {
    throw new ListenerError(describe(spec) + ' would bind every interface, including the consumer listener\'s; set '
      + spec.hostName + ' to an address of its own');
  }
  if (consumer && !isWildcard(consumer.host) && sameAddress(spec.host, consumer.host)) {
    throw new ListenerError(describe(spec) + ' is on the consumer listener\'s address ' + consumer.host
      + '; an internal-plane role needs an address of its own');
  }
  if (!isLoopback(spec.host) && String(readRaw(source, spec.acknowledgeName)).toLowerCase() !== 'true') {
    throw new ListenerError(describe(spec) + ' is not a loopback address; the ' + spec.role
      + ' listener has no credential of its own, so set ' + spec.acknowledgeName
      + '=true only if this address is unreachable from the internet');
  }
}

function overlaps (a, b) {
  if (a.port !== b.port || a.port === 0) return false;
  return isWildcard(a.host) || isWildcard(b.host) || sameAddress(a.host, b.host);
}

// The listeners for these roles, checked. Throws ListenerError on a role
// list that would share a listener or break the plane rule.
function resolve (names, source, fallback, roles) {
  roles = roles || ROLES;
  const consumerRole = Object.keys(roles).find(name => roles[name].consumerDefault);
  const consumer = consumerRole ? listenerFor(consumerRole, source, fallback, roles) : null;
  const specs = names.map(name => listenerFor(name, source, fallback, roles)).filter(Boolean);
  specs.forEach(spec => checkPlane(spec, spec.role === (consumer && consumer.role) ? null : consumer, source));
  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      if (overlaps(specs[i], specs[j])) {
        throw new ListenerError(describe(specs[i]) + ' and ' + describe(specs[j])
          + ' would share a listener; give each role its own ' + specs[j].portName + ' or ' + specs[j].hostName);
      }
    }
  }
  return specs;
}

// Open one listener for an express app; resolves once it is listening.
function open (spec, app, ssl) {
  const server = ssl ? require('https').createServer(ssl, app) : require('http').createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(spec.port, spec.host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

// Stop accepting, drop idle and in-flight keep-alive sockets, and resolve
// when the server has closed.
function close (server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

module.exports = { resolve, listenerFor, checkPlane, open, close, isLoopback, isWildcard, readRaw, ListenerError };
