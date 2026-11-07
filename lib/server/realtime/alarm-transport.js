'use strict';

const c = require('./contract');
const ipc = require('./ipc');
function operations ({ token, deliver }) {
  if (typeof token !== 'symbol' || typeof deliver !== 'function') throw new TypeError('Alarm sink requires owned transport and actual realtime fanout');
  return { async '/alarm' (request, body) {
    if (request.transport !== token || !c.exact(body, ['tenant', 'id', 'attempt', 'notification', 'receipts']) ||
        !c.uuid(body.tenant) || !c.uuid(body.id) || !c.integer(body.attempt) || !c.object(body.notification) || !Array.isArray(body.receipts)) c.fail('REALTIME_ALARM_REQUEST_REFUSED');
    await deliver({ tenant: body.tenant, notification: body.notification });
    // Acceptance is the realtime handoff, not a device's acknowledgement. A lost
    // response can repeat this unchanged request after restart; no exactly-once.
    return { accepted: true, receipt: { kind: 'realtime', id: body.id },
      ...(body.notification.clear ? { clearedRequestIds: body.receipts.filter(row => c.object(row) && c.uuid(row.request_id) &&
        c.object(row.receipt) && row.receipt.kind === 'realtime' && row.receipt.id === row.request_id).map(row => row.request_id) } : {}) };
  } };
}
function createAdapter (options, invoke = ipc.client(options)) {
  return Object.freeze({ id: 'realtime-preview',
    send ({ tenant, id, attempt, notification, receipts = [], signal }, callback) {
      invoke('/alarm', { tenant, id, attempt, notification, receipts }, signal).then(value => callback(null, value),
        () => callback(new Error('REALTIME_HANDOFF_UNAVAILABLE')));
    }
  });
}
module.exports = { operations, createAdapter };
