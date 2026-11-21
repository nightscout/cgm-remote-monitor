'use strict';

const { createHandlers } = require('./socket-write-handlers');
const scope = require('../storage/tenant-scope');
const { SocketForwardError } = require('./tenant-socket-forwarding');
const DATA = Object.freeze(['dbAdd', 'dbUpdate', 'dbUpdateUnset', 'dbRemove']);

// Dormant trusted composition. The API receiver has already authenticated the
// transport, resolved the tenant and authorized the socket credential for this
// operation. Context construction must use that current actor, not a realtime
// role credential. This module selects no deployment, provider or permission.
function createExecutor ({ contextForOperation } = {}) {
  if (typeof contextForOperation !== 'function') throw new TypeError('Socket executor requires trusted API context construction');
  return async function execute (operation) {
    if (!operation || operation.source !== 'socket' || operation.namespace !== '/' ||
        !DATA.includes(operation.event) || !Array.isArray(operation.args) || operation.args.length !== 1 ||
        !operation.actor || operation.actor.tenant !== operation.tenant) {
      throw new SocketForwardError('SOCKET_FORWARD_MESSAGE_REFUSED');
    }
    return scope.withTenant(operation.tenant, async () => {
      const context = await contextForOperation(operation);
      // The same handlers, purifier, write intent and write step as the single
      // socket listener. Completion is the canonical handler's callback, after
      // its existing storage/visibility work, with its unchanged argument shape.
      const handlers = createHandlers(context);
      return new Promise((resolve, reject) => {
        try { handlers[operation.event](operation.args[0], (...replyArgs) => resolve(replyArgs)); }
        catch (error) { reject(error); }
      });
    });
  };
}
module.exports = { createExecutor, DATA };
