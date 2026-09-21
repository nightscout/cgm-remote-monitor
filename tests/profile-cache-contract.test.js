'use strict';
const assert = require('node:assert/strict');
const Cache = require('../lib/utils/reference-cache');

// Model delayed timer dispatch independently of the cache implementation.
function withClock(run) {
  const original = {now: Date.now, set: global.setTimeout, clear: global.clearTimeout, performance: Object.getOwnPropertyDescriptor(global, 'performance')};
  let now = 100000, elapsed = 0, id = 0;
  const timers = new Map();
  Date.now = () => now;
  Object.defineProperty(global, 'performance', {configurable: true, value: {now: () => elapsed}});
  global.setTimeout = (callback, delay) => {
    const timer = {id: ++id, unref() {return this;}};
    timers.set(timer, {callback, at: elapsed + delay});
    return timer;
  };
  global.clearTimeout = timer => timers.delete(timer);
  const clock = {
    advance(ms, dispatch = true) {
      now += ms;
      elapsed += ms;
      if (dispatch) {
        for (const [timer, task] of [...timers]) {
          if (task.at <= elapsed) {timers.delete(timer); task.callback();}
        }
      }
    },
    shiftWall(ms) {now += ms;},
    timers
  };
  try {run(clock);} finally {
    Date.now = original.now;
    Object.defineProperty(global, 'performance', original.performance);
    global.setTimeout = original.set;
    global.clearTimeout = original.clear;
  }
}

describe('Profile cache application contracts', function () {
  it('returns null for misses and preserves zero, false and null values', function () {
    withClock(() => {
      const cache = new Cache();
      assert.equal(cache.get('missing'), null);
      for (const value of [0, false, null]) {
        assert.equal(cache.put('value', value, 5000), value);
        assert.equal(cache.get('value'), value);
      }
      cache.clear();
    });
  });
  it('retains references and caller mutations instead of cloning profile values', function () {
    withClock(() => {
      const cache = new Cache(), value = {rates: [1]};
      cache.put('profile', value, 5000);
      assert.equal(cache.get('profile'), value);
      value.rates.push(2);
      assert.deepEqual(cache.get('profile').rates, [1, 2]);
      cache.clear();
    });
  });
  it('expires at five seconds when timers run', function () {
    withClock(clock => {
      const cache = new Cache();
      cache.put('profile', 7, 5000);
      clock.advance(4999); assert.equal(cache.get('profile'), 7);
      clock.advance(1); assert.equal(cache.get('profile'), null);
      cache.clear();
    });
  });
  it('checks wall-clock expiry when timer dispatch is delayed', function () {
    withClock(clock => {
      const cache = new Cache();
      cache.put('profile', 7, 5000);
      clock.advance(5000, false); assert.equal(cache.get('profile'), 7);
      clock.advance(1, false); assert.equal(cache.get('profile'), null);
      cache.clear();
    });
  });
  it('extends expiry on replacement and never expires the replacement with an old timer', function () {
    withClock(clock => {
      const cache = new Cache();
      cache.put('profile', 'first', 5000);
      clock.advance(4000); cache.put('profile', 'second', 5000);
      clock.advance(1001); assert.equal(cache.get('profile'), 'second');
      clock.advance(3999); assert.equal(cache.get('profile'), null);
      cache.clear();
    });
  });
  it('clears entries and timers across two reset/reload cycles', function () {
    withClock(clock => {
      const cache = new Cache();
      for (let cycle = 0; cycle < 2; cycle++) {
        cache.put('profile', {cycle}, 5000);
        cache.clear();
        assert.equal(cache.get('profile'), null);
        assert.equal(clock.timers.size, 0);
        clock.advance(6000);
      }
    });
  });
  it('expires on elapsed time even when the system clock moves backward', function () {
    withClock(clock => {
      const cache = new Cache();
      cache.put('first', 1, 5000);
      clock.advance(1000);
      clock.shiftWall(-60000);
      cache.put('second', 2, 5000);
      clock.advance(4000);
      assert.equal(cache.get('first'), null);
      assert.equal(cache.get('second'), 2);
      clock.advance(1000);
      assert.equal(cache.get('second'), null);
      cache.clear();
    });
  });
  it('still rejects wall-clock-expired reads before timers dispatch after a forward jump', function () {
    withClock(clock => {
      const cache = new Cache();
      cache.put('profile', 1, 5000);
      clock.shiftWall(60000);
      assert.equal(cache.get('profile'), null);
      cache.clear();
    });
  });
  it('bounds entries and pending timers while retaining the newest replacement', function () {
    withClock(clock => {
      const cache = new Cache(3);
      for (let i = 0; i < 100; i++) cache.put(String(i), i, 5000);
      assert.equal(clock.timers.size, 1);
      assert.equal(cache.get('96'), null);
      assert.equal(cache.get('97'), 97);
      assert.equal(cache.get('99'), 99);
      cache.put('97', 'updated', 5000);
      cache.put('100', 100, 5000);
      assert.equal(cache.get('98'), null);
      assert.equal(cache.get('97'), 'updated');
      clock.advance(5000);
      assert.equal(cache.get('100'), null);
      assert.equal(clock.timers.size, 0);
    });
  });
  it('isolates profile instances and prototype-like string keys', function () {
    withClock(() => {
      const first = new Cache(), second = new Cache();
      for (const key of ['__proto__', 'constructor', 'toString']) {
        first.put(key, 123, 5000);
        assert.equal(first.get(key), 123);
        assert.equal(second.get(key), null);
      }
      first.clear(); second.clear();
    });
  });
});
