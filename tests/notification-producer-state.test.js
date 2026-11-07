'use strict';
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const notifications = require('../lib/notifications');
const producer = require('../lib/tenant-notifications/producer-state');
const levels = require('../lib/levels');
const makeEnv = require('../lib/server/tenant-app/environment');
const env = makeEnv({settings: {enable: ['simplealarms']}});
const view = require('../lib/data/views')(env, {language: require('../lib/language')(), levels, moment: require('moment-timezone')});
const notice = {kind: 'notify', level: 1, title: 'Synthetic', message: 'Synthetic', plugin: {name: 'synthetic'}, group: 'default'};
const snooze = {kind: 'snooze', level: 1, title: 'Synthetic', message: 'Synthetic', lengthMills: 1000, group: 'default'};
const bounds = {maxRows: 100, maxBytes: 100000, maxPayloadBytes: 10000};

describe('durable producer reuses actual shipping notification semantics', function () {
  let now, originalNow, bus, legacy, legacyEvents, state, revision, output;
  beforeEach(function () {
    now = Date.UTC(2026, 10, 6, 12); originalNow = Date.now; Date.now = () => now;
    bus = new EventEmitter(); legacyEvents = []; bus.on('notification', row => legacyEvents.push(row));
    legacy = notifications({}, {bus, levels, ddata: {get lastUpdated () {return now;}}}); state = null; revision = 0; output = 0;
  });
  afterEach(function () {bus.emit('teardown'); Date.now = originalNow;});
  function consume (requested, acks = [], eligible = true) {
    const cycle = {identity: 'synthetic-config', runtimeId: 'runtime', outputRevision: ++output, inputCheckpoint: 0,
      eligible, result: {now, requested}};
    const reduced = producer.reduce({...bounds, previous: state, cycle, acks, at: now, revision: ++revision});
    state = reduced.state; return state.effects;
  }
  function feed (requested) {
    legacy.initRequests();
    requested.forEach(row => row.kind === 'notify' ? legacy.requestNotify({...row}) : legacy.requestSnooze({...row}));
    legacy.process();
  }
  function actual (mgdl) {
    const ddata = require('../lib/data/ddata')(); ddata.lastUpdated = now;
    ddata.sgvs = [{_id: 'synthetic', mgdl, mills: now - 1000, type: 'sgv', direction: 'Flat'}];
    return view.evaluateCycle({now, ddata}).requested;
  }
  it('matches actual simplealarms low→normal clear payload and retains one stable clear origin across empty polls', function () {
    const low = actual(50); feed(low); consume(low); now++;
    const normal = actual(111); feed(normal); const effects = consume(normal);
    assert.deepEqual(effects.map(row => row.payload), legacyEvents.filter(row => row.clear), 'PRODUCER_ACTUAL_NORMAL_CLEAR');
    const origin = effects[0].origin; now++; consume(normal);
    assert.equal(state.effects[0].origin, origin, 'PRODUCER_STABLE_CLEAR_ORIGIN');
  });
  it('matches retained plugin snooze clear and original expiry and never replays an ignored active human ACK', function () {
    feed([notice, snooze]); consume([notice, snooze]); const initial = structuredClone(state); now += 100;
    feed([notice, snooze]); consume([notice, snooze]);
    legacy.ack(1, 'default', 1800000, true);
    consume([], [{group:'default', level:1, ackedAt:now, expiresAt:now+1800000}], false);
    assert.deepEqual(state.alarms, initial.alarms, 'PRODUCER_PLUGIN_EXPIRY');
    assert.deepEqual(state.effects.map(row => row.payload), legacyEvents, 'PRODUCER_PLUGIN_ACK_SOURCE_COMPARISON');
    assert.equal(state.effects[0].origin, initial.effects[0].origin);
  });
  it('consumes committed control ACK during failed clinical acquisition without plugin evaluation or normal-state auto-clear', function () {
    feed([notice]); consume([notice]); now++;
    const before = state.effects[0].origin; consume([], [], false); assert.equal(state.effects[0].origin, before);
    legacy.ack(2, 'default', 1000, true);
    const effects = consume([], [{group:'default', level:2, ackedAt:now, expiresAt:now+1000}, {group:'default', level:1, ackedAt:now, expiresAt:now+1000}], false);
    assert.deepEqual(effects.map(row => row.payload), legacyEvents.filter(row => row.clear), 'PRODUCER_CONTROL_CLEAR_WITH_FAILED_CLINICAL');
    assert.ok(effects.every(row => row.payload.clear));
  });
  it('retires old clear provenance when a newer alarm is emitted and never creates late historical ACK clear after expiry', function () {
    consume([notice]); now++; consume([]); const clearOrigin = state.effects[0].origin;
    now += 2; consume([notice]);
    assert.ok(state.effects.every(row => !row.payload.clear && row.origin !== clearOrigin), 'PRODUCER_NEW_ALARM_FENCES_CLEAR');
    const currentOrigin = state.effects[0].origin; now += 2000;
    // Active-only reader supplies no expired ACK; a failed cycle cannot invent a clear.
    consume([], [], false); assert.equal(state.effects[0].origin, currentOrigin);
  });
});
