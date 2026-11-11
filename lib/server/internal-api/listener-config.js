'use strict';

// serve.internal: the one private listener of a multitenant role process
// (decision internal-listener-ory-pattern; prior art Ory Kratos/Hydra
// serve.public/serve.admin). It is configured as {host, port} or {socket}; each
// key can be overridden from the environment:
//
//   NS_SERVE_INTERNAL_HOST, NS_SERVE_INTERNAL_PORT   network listener (both required)
//   NS_SERVE_INTERNAL_SOCKET                         unix socket path
//   NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS            in-flight drain deadline on shutdown
//
// With neither, the listener is a unix socket under the runtime directory
// ($XDG_RUNTIME_DIR/nightscout, else /run/nightscout), named for the roles the
// process serves (`api.sock`, `api+realtime.sock`). Network exposure always
// needs an explicit host and port: the listener trusts its network
// (trust:'network') and has no authentication of its own.
//
// Which contracts the listener serves is decided by the roles' code
// (lib/server/serve/internal-listener.js), never by this configuration.
// Callers reach a peer role by its address: NS_<ROLE>_INTERNAL_URL or
// NS_<ROLE>_INTERNAL_SOCKET, else the peer's default socket
// <runtime>/<role>.sock. A role served by this process is reached on this
// process's own listener; a peer address that names another socket, another
// kind of address or another port for it refuses.
const path = require('node:path');
const transport = require('./transport');

const ROLES = Object.freeze(['api', 'evaluator', 'realtime', 'tenant-admin', 'vcpool']);
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const MAX_SHUTDOWN_TIMEOUT_MS = 60000;
const KEYS = Object.freeze({ host: 'NS_SERVE_INTERNAL_HOST', port: 'NS_SERVE_INTERNAL_PORT', socket: 'NS_SERVE_INTERNAL_SOCKET',
  shutdownTimeoutMs: 'NS_SERVE_INTERNAL_SHUTDOWN_TIMEOUT_MS' });
const PROBE = { maxBytes: 1, timeoutMs: 1 };

class InternalListenerConfigError extends Error {
  constructor (message) { super(message); this.code = 'INTERNAL_LISTENER_CONFIG_REFUSED'; }
}
const refuse = message => { throw new InternalListenerConfigError('serve.internal: ' + message); };
const envName = role => 'NS_' + role.toUpperCase().replace(/-/g, '_') + '_INTERNAL_';

function read (source, name) {
  if (!source || !Object.hasOwn(source, name)) return undefined;
  const value = String(source[name]).trim();
  return value === '' ? undefined : value;
}
function runtimeDirectory (source) {
  const xdg = read(source, 'XDG_RUNTIME_DIR');
  return xdg && path.isAbsolute(xdg) ? path.join(xdg, 'nightscout') : '/run/nightscout';
}
function bracket (host) { return host.includes(':') ? '[' + host + ']' : host; }
function bare (host) { return host.replace(/^\[(.*)\]$/, '$1'); }
function wildcard (host) { return ['0.0.0.0', '::', '0:0:0:0:0:0:0:0'].includes(bare(host)); }
function contradicts (given, listen) {
  if (!!given.socketPath !== !!listen.socketPath) return true;
  if (given.socketPath) return given.socketPath !== listen.socketPath;
  return new URL(given.url).port !== new URL(listen.url).port;
}
function key (address) { return address.socketPath ? 'unix:' + address.socketPath : 'http:' + new URL(address.url).origin; }

function socketAddress (socketPath, label) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.normalize(socketPath) !== socketPath) refuse(label + ' must be an absolute, normalized socket path');
  try { transport.options({ socketPath, ...PROBE }); } catch { refuse(label + ' is not a usable socket path (at most 100 bytes)'); }
  return Object.freeze({ socketPath });
}
function urlAddress (text, label) {
  try { transport.options({ url: text, trust: 'network', ...PROBE }); } catch { refuse(label + ' must be an http://host:port URL with no path, credentials or query'); }
  const url = new URL(text);
  if (!url.port) refuse(label + ' needs an explicit port');
  return Object.freeze({ url: url.origin + '/', trust: 'network' });
}

// The process's own listener address, from config keys overridden by environment.
function own (names, source, config) {
  const allowed = ['host', 'port', 'socket', 'shutdownTimeoutMs'];
  if (config === null || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(name => !allowed.includes(name))) {
    refuse('accepts only host, port, socket and shutdownTimeoutMs');
  }
  const value = {};
  for (const name of allowed) {
    const env = read(source, KEYS[name]);
    const chosen = env !== undefined ? env : config[name];
    if (chosen !== undefined && chosen !== null && chosen !== '') value[name] = chosen;
  }
  let shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (Object.hasOwn(value, 'shutdownTimeoutMs')) {
    shutdownTimeoutMs = Number(value.shutdownTimeoutMs);
    if (!/^[0-9]+$/.test(String(value.shutdownTimeoutMs)) || !Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs > MAX_SHUTDOWN_TIMEOUT_MS) {
      refuse(KEYS.shutdownTimeoutMs + ' must be a whole number of milliseconds, at most ' + MAX_SHUTDOWN_TIMEOUT_MS);
    }
  }
  const network = Object.hasOwn(value, 'host') || Object.hasOwn(value, 'port');
  if (network && Object.hasOwn(value, 'socket')) refuse('is either host/port or socket, not both');
  if (network) {
    if (!Object.hasOwn(value, 'host') || !Object.hasOwn(value, 'port')) refuse('a network listener needs both ' + KEYS.host + ' and ' + KEYS.port);
    const host = bare(String(value.host)), port = String(value.port);
    if (!host || /[\s/[\]@?#]/.test(host)) refuse(KEYS.host + ' must be a host name or address');
    if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) refuse(KEYS.port + ' must be a port number from 1 to 65535');
    const bind = urlAddress('http://' + bracket(host) + ':' + Number(port), KEYS.host + '/' + KEYS.port);
    // A co-resident caller dials loopback when the listener binds every interface.
    const dial = wildcard(host) ? urlAddress('http://' + (host.includes(':') ? '[::1]' : '127.0.0.1') + ':' + Number(port), 'loopback') : bind;
    return { listen: Object.freeze({ ...bind, bindHost: host }), dial, shutdownTimeoutMs, created: false };
  }
  if (Object.hasOwn(value, 'socket')) return { listen: socketAddress(String(value.socket), KEYS.socket), dial: null, shutdownTimeoutMs, created: false };
  const socketPath = path.join(runtimeDirectory(source), [...names].sort().join('+') + '.sock');
  return { listen: socketAddress(socketPath, 'the default socket'), dial: null, shutdownTimeoutMs, created: true };
}

// resolve(names, source[, config]) -> the process's serve.internal settings and
// the addresses of every role it may call.
function resolve (names, source = process.env, config = {}) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length || names.some(name => !ROLES.includes(name))) {
    refuse('requires the explicit role list of this process');
  }
  const self = own(names, source, config);
  const dial = self.dial || self.listen;
  const peers = {};
  for (const role of ROLES) {
    const urlName = envName(role) + 'URL', socketName = envName(role) + 'SOCKET';
    const url = read(source, urlName), socket = read(source, socketName);
    if (url !== undefined && socket !== undefined) refuse(urlName + ' and ' + socketName + ' are exclusive');
    const given = url !== undefined ? urlAddress(url, urlName) : socket !== undefined ? socketAddress(socket, socketName) : null;
    if (names.includes(role)) {
      // The role's contracts are served by this process; configuration cannot
      // move them. A shared peer list may name this process by a service name
      // (http://api:7001); an address that cannot be this listener refuses.
      if (given && contradicts(given, self.listen)) {
        refuse((url !== undefined ? urlName : socketName) + ' names ' + role + ', which this process serves on its own serve.internal (' + key(dial) + ')');
      }
      peers[role] = dial;
    } else {
      peers[role] = given || socketAddress(path.join(runtimeDirectory(source), role + '.sock'), 'the default ' + role + ' socket');
    }
  }
  const limits = value => {
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.maxBytes) || !Number.isSafeInteger(value.timeoutMs)) refuse('peer limits required');
    return { maxBytes: value.maxBytes, timeoutMs: value.timeoutMs };
  };
  return Object.freeze({
    names: Object.freeze([...names]),
    listen: self.listen,
    dial,
    defaultSocket: self.created,
    shutdownTimeoutMs: self.shutdownTimeoutMs,
    // Transport options for calling a role (own listener when co-resident).
    peer (role, bounds) {
      if (!Object.hasOwn(peers, role)) refuse('unknown role ' + role);
      return transport.options({ ...peers[role], ...limits(bounds) });
    },
    // A participant's address: every role it names must share one address.
    participant (roles, bounds) {
      if (!Array.isArray(roles) || !roles.length || roles.some(role => !Object.hasOwn(peers, role))) refuse('participant roles required');
      const addresses = new Set(roles.map(role => key(peers[role])));
      if (addresses.size !== 1) refuse('participant roles ' + roles.join(',') + ' resolve to different addresses');
      return transport.options({ ...peers[roles[0]], ...limits(bounds) });
    }
  });
}

module.exports = { resolve, key, ROLES, KEYS, DEFAULT_SHUTDOWN_TIMEOUT_MS, MAX_SHUTDOWN_TIMEOUT_MS, InternalListenerConfigError, envName };
