'use strict';

const c = require('./contract');
module.exports = function ackExecutor ({ writer } = {}) {
  if (typeof writer?.ack !== 'function') throw new TypeError('Alarm executor requires durable writer');
  return async function persistAlarmAck (operation) {
    if (operation?.source !== 'socket' || operation?.event !== 'ack' || !['/', '/alarm'].includes(operation?.namespace) ||
        !operation.actor || operation.actor.tenant !== operation.tenant) c.fail('ALARM_OPERATION_REFUSED');
    c.args(operation.args);
    await writer.ack(operation);
    // Legacy /alarm ack has no result vector. If a callback is present, its
    // empty vector is relayed only after durable confirmation, never on failure.
    return [];
  };
};
