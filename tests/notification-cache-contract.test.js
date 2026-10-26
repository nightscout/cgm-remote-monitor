'use strict';

const assert = require('node:assert/strict');
const Cache = process.env.NOTIFICATION_CACHE_REFERENCE
  ? require(process.env.NOTIFICATION_CACHE_REFERENCE)
  : require('../lib/utils/notification-cache');

describe('Notification cache application contracts', function () {
  let now, originalNow, caches;
  function create(options = {}) {
    const cache = new Cache({stdTTL: 60, checkperiod: 0, ...options});
    caches.push(cache); return cache;
  }
  beforeEach(function () {now = 1700000000000; originalNow = Date.now; Date.now = () => now; caches = [];});
  afterEach(function () {for (const cache of caches) {cache.flushAll(); cache.close();} Date.now = originalNow;});

  it('distinguishes misses from null, undefined, false and zero values', function () {
    const cache = create();
    assert.equal(cache.get('missing'), undefined);
    for (const value of [null, undefined, false, 0]) {
      cache.set('value', value);
      assert.equal(cache.get('value'), value === undefined ? null : value);
      assert.ok(cache.keys().includes('value'));
    }
  });

  it('isolates source and retrieved receipt snapshots', function () {
    const cache = create();
    const value = {level: 0, group: 'original', eventName: undefined, nested: {values: [1]}};
    cache.set('receipt', value);
    value.group = 'changed'; value.nested.values.push(2);
    const read = cache.get('receipt');
    assert.deepEqual(read, {level: 0, group: 'original', eventName: undefined, nested: {values: [1]}});
    read.nested.values.push(3);
    assert.deepEqual(cache.get('receipt').nested.values, [1]);
  });

  it('retains reference behavior only when cloning is explicitly disabled', function () {
    const cache = create({useClones: false}), value = {level: 1};
    cache.set('reference', value); value.level = 2;
    assert.equal(cache.get('reference'), value);
    assert.equal(cache.get('reference').level, 2);
  });

  it('keeps the exact expiry boundary and expires on the next millisecond', function () {
    const cache = create(); cache.set('key', true, 1);
    now += 1000; assert.equal(cache.get('key'), true);
    now++; assert.equal(cache.get('key'), undefined);
  });

  it('never revives an expired unread key when a delayed send extends its TTL', function () {
    const cache = create(); cache.set('key', true, 30);
    now += 30001;
    assert.equal(cache.ttl('key', 900), false);
    assert.equal(cache.get('key'), undefined);
    assert.ok(!cache.keys().includes('key'));
  });

  it('extends a live key relative to completion and does not create a missing key', function () {
    const cache = create(); cache.set('key', true, 30);
    now += 20000; assert.equal(cache.ttl('key', 900), true);
    now += 880001; assert.equal(cache.get('key'), true);
    now += 20000; assert.equal(cache.get('key'), undefined);
    assert.equal(cache.ttl('missing', 900), false);
  });

  it('preserves the different zero lifetime contracts for set and ttl', function () {
    const cache = create(); cache.set('key', true, 0);
    now += 3600000; assert.equal(cache.get('key'), true);
    assert.equal(cache.ttl('key', 0), true);
    now += 60001; assert.equal(cache.get('key'), undefined);
  });

  it('removes negative-TTL extensions immediately, without waiting for a read', function () {
    const cache = create(); cache.set('key', true);
    assert.equal(cache.ttl('key', -1), true);
    assert.deepEqual(cache.keys(), []);
  });

  it('reclaims unread expired keys through housekeeping over two cycles', async function () {
    const cache = create({checkperiod: 0.01});
    for (let cycle = 0; cycle < 2; cycle++) {
      cache.set('unread', {level: cycle}, 1);
      now += 1001;
      // Leave the key unread: observing keys alone must not trigger read expiry.
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.deepEqual(cache.keys(), []);
    }
  });

  it('isolates instances, normalizes numeric keys and supports repeated clear cycles', function () {
    const first = create(), second = create();
    for (let cycle = 0; cycle < 2; cycle++) {
      first.set(123, {level: cycle}); second.set('123', {level: 9});
      assert.equal(first.get('123').level, cycle);
      first.flushAll(); assert.deepEqual(first.keys(), []);
      assert.equal(second.get(123).level, 9);
      second.flushAll();
    }
  });
});
