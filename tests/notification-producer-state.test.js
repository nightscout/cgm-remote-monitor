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
const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');

describe('durable producer reuses actual shipping notification semantics', function () {
  let now, originalNow, bus, legacy, legacyEvents, state, revision, output;
  beforeEach(function () {
    now = Date.UTC(2026, 10, 6, 12); originalNow = Date.now; Date.now = () => now;
    bus = new EventEmitter(); legacyEvents = []; bus.on('notification', row => legacyEvents.push(row));
    legacy = notifications({}, {bus, levels, ddata: {get lastUpdated () {return now;}}}); state = null; revision = 0; output = 0;
  });
  afterEach(function () {bus.emit('teardown'); Date.now = originalNow;});
  function consume (requested, acks = [], eligible = true) {
    // Each call is a distinct evaluator output (its content digest differs).
    const cycle = {identity: 'synthetic-config', runtimeId: 'runtime', outputRevision: ++output, inputCheckpoint: 0,
      contentDigest: digest(JSON.stringify([requested, output])), eligible, result: {now, requested}};
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

// Content-derived freshness and origins (lane EP, 2026-11-10): the evaluator
// process that computed an output is not part of its identity.
describe('durable producer identifies evaluator output by content', function () {
  const at0 = Date.UTC(2026, 10, 10, 12);
  const urgent = {kind: 'notify', level: 2, title: 'Urgent HIGH', message: 'Synthetic', plugin: {name: 'synthetic'}, group: 'default'};
  const content = tag => digest(JSON.stringify(['synthetic-content', tag]));
  function run (steps, repeatMs = 60000) {
    let state = null, revision = 0; const origins = [];
    for (const step of steps) {
      const cycle = step.eligible === false ? {identity: 'synthetic-config', eligible: false} : {identity: 'synthetic-config',
        runtimeId: step.runtime, outputRevision: step.outputRevision || 1, inputCheckpoint: step.checkpoint || 0,
        contentDigest: content(step.content), eligible: true, result: {now: step.at, requested: step.requested || [urgent]}};
      const before = new Set((state?.effects || []).map(row => row.origin));
      state = producer.reduce({...bounds, previous: state, cycle, acks: step.acks || [], at: step.at, revision: ++revision, repeatMs}).state;
      origins.push(...state.effects.filter(row => !before.has(row.origin)).map(row => ({origin: row.origin, clear: !!row.payload.clear})));
    }
    return {state, origins};
  }
  it('two evaluator runtimes with identical output produce one effect, not one per pass', function () {
    const steps = Array.from({length: 10}, (_, i) => ({runtime: i % 2 ? 'B' : 'A', outputRevision: i % 2 ? 7 : 1, content: 'x', at: at0 + i * 1000}));
    assert.equal(run(steps).origins.length, 1, 'PRODUCER_RUNTIME_NOT_IDENTITY');
  });
  it('a hand-over with identical output waits for the repeat clock instead of re-sending', function () {
    const steps = [0, 1000, 2000].map(t => ({runtime: 'A', content: 'x', at: at0 + t}))
      .concat([3000, 30000, 59999, 60000].map(t => ({runtime: 'B', content: 'x', at: at0 + t})));
    const {origins} = run(steps);
    assert.equal(origins.length, 2, 'PRODUCER_HANDOVER_ON_REPEAT_CLOCK');
  });
  it('the same step derives the same origin in any evaluator; different steps never share one', function () {
    const a = run([{runtime: 'A', content: 'x', at: at0}]).origins, b = run([{runtime: 'B', content: 'x', at: at0 + 5}]).origins;
    assert.deepEqual(a, b, 'PRODUCER_ORIGIN_FROM_CONTENT');
    // A -> B -> A on unchanged input: the return to A is a new transition (new origin).
    const flip = run([{runtime: 'A', content: 'x', at: at0}, {runtime: 'A', content: 'y', requested: [], at: at0 + 1000},
      {runtime: 'A', content: 'x', at: at0 + 2000}]).origins.filter(row => !row.clear);
    assert.equal(flip.length, 2); assert.notEqual(flip[0].origin, flip[1].origin, 'PRODUCER_REALARM_NEW_ORIGIN');
    // Two repeats of one output are two steps.
    const repeats = run([{runtime: 'A', content: 'x', at: at0}, {runtime: 'A', content: 'x', at: at0 + 60000},
      {runtime: 'B', content: 'x', at: at0 + 120000}]).origins;
    assert.equal(new Set(repeats.map(row => row.origin)).size, 3, 'PRODUCER_REPEAT_SLOTS_DISTINCT');
  });
  it('acknowledgement clears of one output get distinct origins per acknowledgement', function () {
    const ack = (t, len) => ({group: 'default', level: 2, ackedAt: t, expiresAt: t + len});
    const {origins} = run([{runtime: 'A', content: 'x', at: at0},
      {runtime: 'A', content: 'x', at: at0 + 1000, acks: [ack(at0 + 1000, 30000)]},
      {runtime: 'B', content: 'x', at: at0 + 61000},
      {runtime: 'B', content: 'x', at: at0 + 62000, acks: [ack(at0 + 62000, 30000)]}]);
    const clears = origins.filter(row => row.clear);
    assert.equal(clears.length, 2, 'two acknowledgements, two clears');
    assert.notEqual(clears[0].origin, clears[1].origin, 'PRODUCER_ACK_CLEAR_ORIGINS_DISTINCT');
  });
  it('refuses an eligible output without a content digest', function () {
    assert.throws(() => producer.reduce({...bounds, previous: null, at: at0, revision: 1, acks: [],
      cycle: {identity: 'c', runtimeId: 'A', outputRevision: 1, inputCheckpoint: 0, eligible: true, result: {now: at0, requested: []}}}),
    /NOTIFICATION_PRODUCER_CONTENT_REQUIRED/);
  });
});
