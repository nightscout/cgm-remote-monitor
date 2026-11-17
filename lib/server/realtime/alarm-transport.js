'use strict';

const c = require('./contract');
const clients = require('../internal-api/clients');
function operations ({ token, deliver, ownership, admit = () => {} }) {
  if (typeof token !== 'symbol' || typeof deliver !== 'function') throw new TypeError('Alarm sink requires owned transport and actual realtime fanout');
  return { async deliverAlarm (request, body) {
    if (request.transport !== token || !c.exact(body, ['tenant', 'id', 'attempt', 'notification', 'receipts'], ['slice']) ||
        !c.uuid(body.tenant) || !c.uuid(body.id) || !c.integer(body.attempt) || !c.object(body.notification) || !Array.isArray(body.receipts)) c.fail('REALTIME_ALARM_REQUEST_REFUSED');
    if (Object.hasOwn(body.notification, 'originGeneration')) require('../../tenant-notifications/contract').generation(body.notification.originGeneration);
    await admit(body.tenant);
    if (ownership) {
      if (!c.exact(body.slice, ['count', 'ordinal'])) c.fail('REALTIME_ALARM_SLICE_REFUSED');
      ownership.assert(body.tenant, body.slice);
    } else if (body.slice !== undefined) c.fail('REALTIME_ALARM_SLICE_REFUSED');
    await deliver({ tenant: body.tenant, notification: body.notification });
    // Acceptance is the realtime handoff, not a device's acknowledgement. A lost
    // response can repeat this unchanged request after restart; no exactly-once.
    return { accepted: true, receipt: null, clearedRequestIds: [] };
  } };
}
function createAdapter (options, client = clients.alarmDelivery(options)) {
  return Object.freeze({ id: 'realtime-preview',
    send ({ tenant, id, attempt, notification, receipts = [], signal }, callback) {
      client.deliverAlarm({ tenant, id, attempt, notification, receipts }, signal).then(value => callback(null, value),
        () => callback(new Error('REALTIME_HANDOFF_UNAVAILABLE')));
    }
  });
}
function createSliceAdapter ({ peers, clientFor = clients.alarmDelivery }) {
  if (!peers || typeof peers.route !== 'function') throw new TypeError('Validated realtime slice peers required');
  return Object.freeze({ id: 'realtime-preview',
    send ({tenant, id, attempt, notification, receipts = [], signal}, callback) {
      let route;
      try { route = peers.route(tenant); } catch { callback(new Error('REALTIME_HANDOFF_UNAVAILABLE')); return; }
      const {count, ordinal, endpoint} = route;
      Promise.resolve().then(() => clientFor(endpoint).deliverAlarm({tenant, id, attempt, notification, receipts, slice: {count, ordinal}}, signal))
        .then(value => callback(null, value), () => callback(new Error('REALTIME_HANDOFF_UNAVAILABLE')));
    }
  });
}
module.exports = {operations, createAdapter, createSliceAdapter};
