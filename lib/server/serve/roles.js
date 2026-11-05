'use strict';

// The multitenant roles `nightscout multitenant` knows (D5, D16, D21), in the order
// the command lists them. A role that serves HTTP has a listener: `prefix` names
// its settings (<PREFIX>_PORT, <PREFIX>_HOSTNAME, and for an internal-plane
// role <PREFIX>_INSECURE_BIND_ACKNOWLEDGED), and `plane` says whose interface
// it belongs on:
//
//   consumer  the data path that devices, apps and browsers reach (api,
//             realtime; tenant-admin until D16's third listener is designed)
//   internal  the platform operator's plane (admin, D7): never on the
//             consumer listener's address, loopback unless acknowledged
//
// `start` is present for a role whose code exists; `multitenant: true` marks
// a role `nightscout multitenant` may run. Only api is enabled, and requires
// explicit preview configuration. `start` retains the separate single-tenant
// headless test profile; serve selects preview-api for the multitenant command.

const ROLES = {
  api: {
    summary: 'API v3 and the authorization endpoints; no in-memory data, no websocket'
    , plane: 'consumer'
    , prefix: 'API'
    , consumerDefault: true
    , multitenant: true
    , start: () => require('./api')
  }
  , evaluator: {
    summary: 'change feed, plugins and notifications; no listener'
  }
  , realtime: {
    summary: 'socket.io fan-out'
    , plane: 'consumer'
    , prefix: 'REALTIME'
  }
  , vcpool: {
    summary: 'connector actors and their egress'
  }
  , 'tenant-admin': {
    summary: 'the tenant owner\'s configuration listener'
    , plane: 'consumer'
    , prefix: 'TENANT_ADMIN'
  }
  , admin: {
    summary: 'the platform operator\'s listener, on its own interface'
    , plane: 'internal'
    , prefix: 'ADMIN'
    , defaultHost: '127.0.0.1'
    , defaultPort: 1338
  }
};

module.exports = { ROLES };
