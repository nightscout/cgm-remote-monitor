'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const {mock} = require('node:test');
const makeBus = require('../lib/bus');

describe('Event bus contracts', function () {
  let bus;
  beforeEach(function () {
    mock.timers.enable({apis: ['setInterval', 'Date'], now: Date.UTC(2026, 0, 1)});
    bus = makeBus({heartbeat: 1});
  });
  afterEach(function () {
    bus.teardown();
    mock.timers.reset();
  });

  it('preserves ordered heartbeat payloads from uptime and scheduled ticks', function () {
    assert.ok(bus instanceof EventEmitter);
    const ticks = [];
    bus.on('tick', tick => ticks.push(tick));
    bus.uptime();
    mock.timers.tick(1000);
    mock.timers.tick(1000);
    assert.deepEqual(ticks.map(tick => ({...tick, now: tick.now.toISOString(), started: tick.started.toISOString()})), [0, 1, 2].map(beat => ({
      now: '2026-01-01T00:00:0' + beat + '.000Z', type: 'heartbeat', sig: 'internal://heartbeat/' + beat,
      beat, interval: 1000, started: '2026-01-01T00:00:00.000Z'
    })));
    assert.equal(ticks[0].started, ticks[2].started);
  });

  it('preserves listener order, once listeners and removal across repeated emissions', function () {
    const calls = [];
    function first(value) {calls.push(['first', value, this === bus]);}
    function second(value) {calls.push(['second', value, this === bus]);}
    bus.on('message', first);
    bus.once('message', second);
    bus.emit('message', 1);
    bus.emit('message', 2);
    bus.removeListener('message', first);
    assert.equal(bus.emit('message', 3), false);
    assert.deepEqual(calls, [['first', 1, true], ['second', 1, true], ['first', 2, true]]);
    bus.on('message', first);
    bus.removeAllListeners('message');
    assert.equal(bus.listenerCount('message'), 0);
  });

  it('preserves handled and unhandled error events', function () {
    const error = new Error('bus error');
    assert.throws(() => bus.emit('error', error), caught => caught === error);
    let received;
    bus.once('error', value => {received = value;});
    assert.equal(bus.emit('error', error), true);
    assert.equal(received, error);
    assert.throws(() => bus.emit('error', error), caught => caught === error);
  });

  it('stops old heartbeats across two teardown and replacement cycles', function () {
    let ticks = 0, teardowns = 0;
    for (let cycle = 0; cycle < 2; cycle++) {
      bus.on('tick', () => ticks++);
      bus.on('teardown', () => teardowns++);
      mock.timers.tick(1000);
      assert.equal(ticks, cycle + 1);
      bus.teardown();
      bus.teardown();
      mock.timers.tick(5000);
      assert.equal(ticks, cycle + 1);
      assert.equal(teardowns, (cycle + 1) * 2);
      if (cycle === 0) bus = makeBus({heartbeat: 1});
    }
  });
});
