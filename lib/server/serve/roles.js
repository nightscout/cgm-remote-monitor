'use strict';

// The multitenant roles `nightscout multitenant` knows (D5, D16, D21), in the order
// the command lists them. A role that serves HTTP has a listener: `prefix` names
// its settings (<PREFIX>_PORT, <PREFIX>_HOSTNAME, and for an internal-plane
// role <PREFIX>_INSECURE_BIND_ACKNOWLEDGED), and `plane` says whose interface
// it belongs on:
//
//   consumer  the data path that devices, apps and browsers reach (api,
//             realtime; tenant-admin until D16's third listener is designed)
//   internal  the platform operator's plane (admin, D7): never every
//             interface, never the consumer listener's port on its address,
//             loopback unless acknowledged
//
// `start` is present for a role whose code exists; `multitenant: true` marks
// a role `nightscout multitenant` may run. api, evaluator, vcpool, headless tenant-admin and admin
// require their separate explicit preview configurations. `start` retains the separate single-tenant
// headless test profile; serve selects preview-api for the multitenant command.
//
// Each role's inputs and outputs are fields, not prose, so a composed process
// can be checked against them with describeComposition (D23, entry condition
// 4). Every role carries all four; the fifth belongs to realtime alone:
//
//   listener          true when the role opens an HTTP listener (`plane` and
//                     `prefix` then say where); evaluator and vcpool are false
//   storage           'write' for a role that commits rows through the write
//                     step, 'read' for a reader, 'none' for a role without
//                     storage. On the data path api is the only writer (D23);
//                     realtime, evaluator and vcpool are readers (vcpool
//                     writes through the api role's HTTP API)
//   feed              true when the role consumes the change feed (D6):
//                     evaluator and realtime
//   egress            true when the role sends traffic out of its own:
//                     evaluator (notifications) and vcpool (connector actors)
//   forwardsWritesTo  realtime only: the role that every socket write message
//                     and the alarm ack are forwarded to, unchanged and with
//                     the socket's own authorization (D23)

const STORAGE = ['write', 'read', 'none'];

const FIELDS = {
  listener: value => typeof value === 'boolean'
  , storage: value => STORAGE.includes(value)
  , feed: value => typeof value === 'boolean'
  , egress: value => typeof value === 'boolean'
};

const ROLES = {
  api: {
    summary: 'API v3 and the authorization endpoints; no in-memory data, no websocket'
    , plane: 'consumer'
    , prefix: 'API'
    , consumerDefault: true
    , multitenant: true
    , listener: true
    , storage: 'write'
    , feed: false
    , egress: false
    , start: () => require('./api')
  }
  , evaluator: {
    summary: 'explicit bounded evaluator preview; no listener or provider delivery'
    , multitenant: true
    , start: () => require('./evaluator-preview')
    , listener: false
    , storage: 'read'
    , feed: true
    , egress: true
  }
  , realtime: {
    summary: 'explicit reader-only realtime preview with private API forwarding'
    , start: () => require('./preview-realtime')
    , multitenant: true
    , defaultHost: '127.0.0.1'
    , plane: 'consumer'
    , prefix: 'REALTIME'
    , listener: true
    , storage: 'read'
    , feed: true
    , egress: false
    , forwardsWritesTo: 'api'
  }
  , vcpool: {
    // Writes go through the tenant's own API as a tenant-bound subject (decision
    // first-preview-no-push-provider), so the role reads storage (activity,
    // tenant secrets, pool membership) and commits no data rows itself (D23).
    summary: 'explicit tenant-side Nightscout connector preview; writes through the tenant API'
    , multitenant: true
    , start: () => require('./vcpool-preview')
    , listener: false
    , storage: 'read'
    , feed: false
    , egress: true
  }
  , 'tenant-admin': {
    summary: 'explicit headless tenant owner preview; operator-provisioned management credentials'
    , plane: 'consumer'
    , prefix: 'TENANT_ADMIN'
    , multitenant: true
    , start: () => require('./owner-preview')
    , listener: true
    , storage: 'write'
    , feed: false
    , egress: false
  }
  , admin: {
    summary: 'explicit private operator preview: ownership operations on the operator\'s own interface'
    , plane: 'internal'
    , prefix: 'ADMIN'
    , multitenant: true
    , start: () => require('./admin-preview')
    , defaultHost: '127.0.0.1'
    , defaultPort: 1338
    , listener: true
    , storage: 'write'
    , feed: false
    , egress: false
  }
};

class RoleTableError extends Error {}

function hasOwn (object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// What a process composed of these roles is, read from the fields: which
// roles write storage, which read it, which open a listener, which consume
// the feed and which send egress. Throws RoleTableError, naming the role,
// when a role is unknown, lacks a typed field, carries a value outside the
// allowed set, declares a listener without a plane and prefix (or the
// reverse), or forwards writes to a role that is not a writer.
function describeComposition (names, roles) {
  roles = roles || ROLES;
  const composition = { writers: [], readers: [], listeners: [], feedConsumers: [], egress: [] };
  for (const name of names) {
    if (!hasOwn(roles, name)) throw new RoleTableError('unknown role: ' + name);
    const role = roles[name];
    for (const [field, allowed] of Object.entries(FIELDS)) {
      if (!hasOwn(role, field)) throw new RoleTableError('role ' + name + ' lacks the ' + field + ' field');
      if (!allowed(role[field])) {
        throw new RoleTableError('role ' + name + ' has ' + field + ' ' + JSON.stringify(role[field])
          + (field === 'storage' ? ', not one of ' + STORAGE.join(', ') : ', not a boolean'));
      }
    }
    if (role.listener !== (typeof role.plane === 'string' && typeof role.prefix === 'string')) {
      throw new RoleTableError('role ' + name + (role.listener ? ' declares a listener without a plane and prefix' : ' names a plane or prefix without a listener'));
    }
    if (hasOwn(role, 'forwardsWritesTo')) {
      const target = roles[role.forwardsWritesTo];
      if (!target || target.storage !== 'write') {
        throw new RoleTableError('role ' + name + ' forwards writes to ' + role.forwardsWritesTo + ', which is not a writer');
      }
    }
    if (role.storage === 'write') composition.writers.push(name);
    if (role.storage === 'read') composition.readers.push(name);
    if (role.listener) composition.listeners.push(name);
    if (role.feed) composition.feedConsumers.push(name);
    if (role.egress) composition.egress.push(name);
  }
  return composition;
}

module.exports = { ROLES, FIELDS, STORAGE, describeComposition, RoleTableError };
