'use strict';

// Explicit trusted composition, not a network listener or enabled role.
const { createApiReceiver } = require('../server/tenant-socket-forwarding');
const { createWriter, createReader } = require('./postgres');
const executor = require('./ack-executor');
const cycle = require('./cycle');

function createReceiver ({ connection, namespace, authenticateTransport, resolveTenant,
  authorizeSocket, authorizeAckInTransaction, admitAckInTransaction, executeWrite } = {}) {
  if (typeof authorizeSocket !== 'function' || typeof authorizeAckInTransaction !== 'function') throw new TypeError('Alarm composition requires current socket and transaction authority adapters');
  const credentials = new WeakMap();
  const writer = createWriter({ connection, namespace, admitAckInTransaction, async authorizeInTransaction ({ connection: db, operation }) {
    const original = credentials.get(operation.actor);
    if (!original) return false;
    return authorizeAckInTransaction({ ...original, actor: operation.actor, connection: db });
  } });
  const persist = executor({ writer });
  return createApiReceiver({ authenticateTransport, resolveTenant, executeWrite,
    async authorizeSocket (operation) {
      const admitted = await authorizeSocket(operation);
      if (!admitted || admitted.tenant !== operation.tenant) return null;
      const actor = Object.freeze({ ...admitted });
      credentials.set(actor, operation);
      return actor;
    },
    async persistAlarmAck (operation) {
      try { return await persist(operation); }
      finally { credentials.delete(operation.actor); }
    }
  });
}
function createCycle ({ connection, namespace, maxRows, maxBytes, current, isCurrent } = {}) {
  return cycle({ reader: createReader({ connection, namespace, maxRows, maxBytes }), current, isCurrent });
}
module.exports = { createReceiver, createCycle };
