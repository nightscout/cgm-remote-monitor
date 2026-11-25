'use strict';

// Realtime's client for the api's socket-authority contract, called on the api
// service address (NS_API_INTERNAL_URL), which may route each new connection to
// any equal api replica. A replica that is draining refuses new connections
// before it leaves the service destination; such a not-ready answer
// (lib/server/internal-api/transport.js `notReady`) is retried for
// authorizeSocket only: at most ATTEMPTS attempts in all, each a new connection
// (the client keeps none), with no delay, inside the caller's own concurrency
// slot. authorizeSocket reads current authority and changes nothing, so a
// repeat is safe. executeSocketMutation is never retried: a reset after the
// request was sent is an uncertain outcome, and the caller reports it as such.
const { isNotReady } = require('../serve/tenant-startup');
const ATTEMPTS = 2;

function create (api) {
  if (!api || typeof api.authorizeSocket !== 'function' || typeof api.executeSocketMutation !== 'function') {
    throw new TypeError('Realtime api client requires the socket-authority operations');
  }
  const counters = { authorizeRetries: 0 };
  const operations = {
    async authorizeSocket (body, signal) {
      for (let attempt = 1; ; attempt++) {
        try { return await api.authorizeSocket(body, signal); } catch (error) {
          if (attempt >= ATTEMPTS || !isNotReady(error)) throw error;
          counters.authorizeRetries++;
        }
      }
    },
    executeSocketMutation: (body, signal) => api.executeSocketMutation(body, signal),
    counters: () => ({ ...counters })
  };
  operations.authorizeSocket = require('../../diagnostics/m7').wrapAsync(operations.authorizeSocket, 'realtime.authorize_rpc');
  return Object.freeze(operations);
}

module.exports = { create, ATTEMPTS };
