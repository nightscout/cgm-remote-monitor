'use strict';

const c = require('./contract');
const clients = require('../internal-api/clients');
function operations ({ token, deliver, placement, admit = () => {} }) {
  if (typeof token !== 'symbol' || typeof deliver !== 'function') throw new TypeError('Alarm sink requires owned transport and actual realtime fanout');
  return { async deliverAlarm (request, body) {
    if (request.transport !== token || !c.exact(body, ['tenant', 'id', 'attempt', 'notification', 'receipts'], ['placement']) ||
        !c.uuid(body.tenant) || !c.uuid(body.id) || !c.integer(body.attempt) || !c.object(body.notification) || !Array.isArray(body.receipts)) c.fail('REALTIME_ALARM_REQUEST_REFUSED');
    await admit(body.tenant);
    if (placement) {
      if (!c.exact(body.placement, ['generation', 'shard', 'worker', 'incarnation'])) c.fail('REALTIME_ALARM_PLACEMENT_REFUSED');
      placement.assert(body.tenant, body.placement);
    } else if (body.placement !== undefined) c.fail('REALTIME_ALARM_PLACEMENT_REFUSED');
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
function createPlacementAdapter ({ placement, clientFor = clients.alarmDelivery }) {
  if (!placement || typeof placement.route !== 'function') throw new TypeError('Admitted realtime placement required');
  return Object.freeze({ id: 'realtime-preview',
    send ({ tenant, id, attempt, notification, receipts = [], signal }, callback) {
      let route;
      try { route = placement.route(tenant); } catch { callback(new Error('REALTIME_HANDOFF_UNAVAILABLE')); return; }
      const { generation, shard, worker, incarnation, endpoint } = route;
      // Resolve again only for a later permitted durable attempt. A transport
      // failure remains uncertain; neither route movement nor refusal fabricates
      // a receipt, changes attempt identity or permits an immediate retry.
      clientFor(endpoint).deliverAlarm({ tenant, id, attempt, notification, receipts,
        placement: { generation, shard, worker, incarnation } }, signal).then(value => callback(null, value),
        () => callback(new Error('REALTIME_HANDOFF_UNAVAILABLE')));
    }
  });
}
module.exports = { operations, createAdapter, createPlacementAdapter };
