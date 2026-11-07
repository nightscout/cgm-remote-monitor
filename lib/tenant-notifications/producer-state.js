'use strict';

const {EventEmitter} = require('node:events');
const makeNotifications = require('../notifications').privateState;
const levels = require('../levels');
const c = require('./contract');

// One cross-process lock namespace, shared by producer consumption, attempts and
// selected ACK admission. Hash collisions only serialize unrelated tenants.
async function lock (connection, tenant, consumer) {
  c.tenant(tenant);
  if (typeof consumer !== 'string' || !c.NAME.test(consumer)) throw new TypeError('Explicit producer consumer required');
  await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0)) /* notification-producer-lock */',
    [JSON.stringify(['notification-producer-v1', tenant, consumer])]);
}
function service (state, at, limits, emitted) {
  const bus = new EventEmitter(); bus.on('notification', row => emitted.push(c.notification(row, limits.maxPayloadBytes)));
  const value = makeNotifications({}, {bus, levels, ddata: {lastUpdated: at}}, {
    clock: () => at, state, maxRows: limits.maxRows, maxBytes: limits.maxBytes
  });
  return { ...value, close: () => bus.emit('teardown') };
}
function bounded (value, limits) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.alarms) || !Array.isArray(value.effects) || !Array.isArray(value.acks) ||
      value.effects.length > limits.maxRows || value.acks.length > limits.maxRows ||
      Buffer.byteLength(JSON.stringify(value)) > limits.maxBytes) throw new Error('NOTIFICATION_PRODUCER_BOUND');
  return value;
}
// Executes shipping notification rules. Caller owns the STATE lock and atomically
// commits returned private state with every returned immutable request intent.
function reduce ({previous, cycle, acks, at, revision, reset = false, ...limits}) {
  c.instant(at); c.integer(revision, 'producer revision');
  if (!Array.isArray(acks) || acks.length > limits.maxRows) throw new Error('NOTIFICATION_PRODUCER_ACK_BOUND');
  const prior = previous || {alarms: [], effects: [], acks: [], output: null};
  bounded(prior, limits);
  const emitted = [];
  let instance = service(prior.alarms, cycle?.eligible === true ? c.instant(cycle.result.now) : at, limits, emitted);
  try {
    if (reset) {
      if (cycle?.eligible !== true) throw new Error('NOTIFICATION_PRODUCER_RESET_UNAVAILABLE');
      // Retire the old service through its actual normal-state processing, then
      // create fresh per-config/plugin state. No fabricated group-wide clear.
      instance.notifications.initRequests(); instance.notifications.process(); instance.close();
      instance = service([], c.instant(cycle.result.now), limits, emitted);
    }
    const seen = new Set(reset ? [] : prior.acks);
    // Urgent ACK recursively covers WARN; apply it first when DB times tie.
    const ordered = [...acks].sort((a, b) => a.ackedAt - b.ackedAt || b.level - a.level);
    for (const ack of ordered) {
      const key = JSON.stringify([ack.group, ack.level, ack.ackedAt, ack.expiresAt]);
      if (!seen.has(key)) {
        instance.ackAt(ack.level, ack.group, ack.expiresAt - ack.ackedAt, true, ack.ackedAt);
        seen.add(key);
      }
    }
    let output = prior.output;
    const next = cycle?.eligible === true ? [cycle.identity, cycle.runtimeId, cycle.outputRevision, cycle.inputCheckpoint] : null;
    const fresh = next && JSON.stringify(next) !== JSON.stringify(output);
    if (fresh) {
      if (!Array.isArray(cycle.result?.requested) || cycle.result.requested.length > limits.maxRows) throw new Error('NOTIFICATION_PRODUCER_REQUEST_BOUND');
      instance.notifications.initRequests();
      for (const row of cycle.result.requested) {
        if (row.kind === 'notify') instance.notifications.requestNotify({...row});
        else if (row.kind === 'snooze') instance.notifications.requestSnooze({...row});
        else throw new Error('NOTIFICATION_PRODUCER_REQUEST_INVALID');
      }
      instance.notifications.process(); output = next;
    }
    // Current successful output replaces earlier normal effects. A control-only
    // ACK never evaluates plugins or invents clinical normality.
    let effects = prior.effects.filter(effect => effect.payload.clear || !fresh);
    for (let i = 0; i < emitted.length; i++) {
      const payload = emitted[i], group = payload.group || 'default';
      effects = effects.filter(effect => (effect.payload.group || 'default') !== group || (!payload.clear && !effect.payload.clear));
      effects.push({origin: c.digest(JSON.stringify(['producer-transition-v1', revision, i])), payload});
    }
    // An applied ACK also removes a previous normal pending effect when legacy
    // ack emitted a clear. Clear provenance survives subsequent empty polls.
    const activeAckKeys = new Set(ordered.map(ack => JSON.stringify([ack.group, ack.level, ack.ackedAt, ack.expiresAt])));
    const state = bounded({alarms: instance.snapshot(), effects, output,
      acks: [...seen].filter(key => activeAckKeys.has(key)), clinicalIdentity: cycle?.eligible === true ? cycle.identity : prior.clinicalIdentity || null}, limits);
    return {state, changed: JSON.stringify(state) !== JSON.stringify(prior)};
  } finally { instance.close(); }
}
module.exports = {lock, reduce, service, bounded};
