'use strict';
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const make = require('../lib/notifications');
const levels = require('../lib/levels');

describe('private bounded shipping notification state', function () {
  let now, owned;
  beforeEach(function () { now = Date.UTC(2026, 10, 6, 12); owned = []; });
  afterEach(function () { owned.forEach(value => value.bus.emit('teardown')); });
  function service (state) {
    const bus = new EventEmitter(), emitted = [], ddata = {lastUpdated: now};
    bus.on('notification', row => emitted.push(structuredClone(row)));
    const value = {bus, emitted, ddata, ...make.privateState({}, {bus, levels, ddata}, {
      clock: () => now, state, maxRows: 20, maxBytes: 10000
    })};
    owned.push(value); return value;
  }
  function notify (value, snooze = false) {
    value.ddata.lastUpdated = now; value.notifications.initRequests();
    value.notifications.requestNotify({level: 1, group: 'default', title: 'Synthetic alarm', message: 'Synthetic', plugin: {name: 'synthetic'}});
    if (snooze) value.notifications.requestSnooze({level: 1, title: 'Synthetic snooze', message: 'Synthetic', lengthMills: 1000});
    value.notifications.process();
  }
  it('restores actual producer provenance and emits exactly the legacy normal-condition clear', function () {
    const first = service(); notify(first); assert.equal(first.emitted.length, 1);
    const restarted = service(first.snapshot()); now++;
    restarted.notifications.initRequests(); restarted.notifications.process();
    assert.deepEqual(restarted.emitted, [{clear: true, title: 'All Clear', message: "Auto ack'd alarm(s)", group: 'default'}]);
    const afterClear = service(restarted.snapshot()); now++;
    afterClear.notifications.initRequests(); afterClear.notifications.process();
    assert.deepEqual(afterClear.emitted, [], 'NOTIFICATION_PRIVATE_CLEAR_ONCE');
  });
  it('retains original plugin snooze expiry across cycles and recreation and ignores an active-window human ACK', function () {
    const first = service(); notify(first, true);
    const initial = first.snapshot().find(row => row.level === 1); assert.equal(initial.lastAckTime, now); assert.equal(initial.silenceTime, 1000);
    now += 100; const restored = service(first.snapshot()); notify(restored, true);
    assert.equal(restored.ackAt(1, 'default', 1800000, true, now), false);
    assert.deepEqual(restored.snapshot().find(row => row.level === 1), initial, 'NOTIFICATION_PRIVATE_ORIGINAL_EXPIRY');
    assert.deepEqual(restored.emitted, [], 'NOTIFICATION_PRIVATE_ACTIVE_ACK_IGNORED');
    now = initial.lastAckTime + initial.silenceTime; notify(restored);
    assert.equal(restored.emitted.length, 0, 'legacy emission equality remains suppressed');
    now++; notify(restored); assert.equal(restored.emitted.length, 1);
  });
  it('applies a persisted ACK at its original time without generating a clinical alarm and preserves default urgent cascade', function () {
    const first = service(); const at = now; now += 100;
    assert.equal(first.ackAt(2, 'default', 1000, true, at), true);
    const state = first.snapshot(); assert.equal(state.length, 2);
    assert.ok(state.every(row => row.lastAckTime === at && row.silenceTime === 1000));
    assert.deepEqual(first.emitted, [{clear: true, title: 'All Clear', message: "default - Urgent was ack'd", group: 'default'}]);
    assert.equal(first.ackAt(2, 'default', 2000, true, at + 1), false); assert.equal(first.emitted.length, 1);
  });
  it('refuses malformed unbounded private state and fences snapshot publication after teardown', function () {
    assert.throws(() => service([{level: 2, group: 'default', lastAckTime: 1, silenceTime: -1}]), /state time/);
    assert.throws(() => service(Array.from({length: 21}, () => ({}))), /STATE_BOUND/);
    assert.throws(() => service([{level: 2, group: 'default', lastAckTime: 1, silenceTime: 1, injected: true}]), /state row/);
    const first = service(); first.bus.emit('teardown'); assert.throws(() => first.snapshot(), /STATE_CLOSED/);
  });
});
