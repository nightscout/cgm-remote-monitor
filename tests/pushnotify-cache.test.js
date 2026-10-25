'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {createRequire} = require('module');
const NodeCache = require('node-cache');
const levels = require('../lib/levels');

function initialize(env, ctx, caches) {
  const filename = path.resolve(__dirname, '../lib/server/pushnotify.js');
  const localRequire = createRequire(filename);
  const sandbox = {module: {exports: {}}, console: {info() {}, warn() {}, error() {}}, require(name) {
    if (name !== 'node-cache') return localRequire(name);
    return function (options) {
      const cache = new NodeCache(options);
      caches.push(cache);
      return cache;
    };
  }};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
  return sandbox.module.exports(env, ctx);
}

function notification() {
  return {notifyhash: 'fixture-key', title: 'Fixture', message: 'Fixture message', plugin: {name: 'fixture'},
    level: levels.WARN, group: 'fixture-group', eventName: 'fixture-event'};
}

describe('push notification deduplication cache', function () {
  let caches, now, originalNow, env, ctx, sent, acknowledgements;
  beforeEach(function () {
    caches = []; now = 1700000000000; originalNow = Date.now;
    Date.now = () => now;
    sent = []; acknowledgements = [];
    env = {settings: {isAlarmEventEnabled: () => true, snoozeFirstMinsForAlarmEvent: notify => {
      assert.strictEqual(notify.eventName, 'fixture-event'); return 7;
    }}};
    ctx = {levels, notifications: {ack(...args) { acknowledgements.push(args); }}, pushover: {
      send(notify, callback) { sent.push(notify); callback(null, JSON.stringify({receipt: 'fixture-receipt'})); }
    }};
  });
  afterEach(function () { Date.now = originalNow; caches.forEach(cache => cache.close()); });

  it('retains a presence marker but preserves receipt fields and acknowledgement semantics', function () {
    const push = initialize(env, ctx, caches);
    const payload = notification();
    payload.large = Array.from({length: 1000}, (_,i) => ({index: i, details: 'unused cache payload'}));
    push.emitNotification(payload);
    assert.strictEqual(caches[1].get(payload.key), true);
    const receipt = caches[0].get('fixture-receipt');
    assert.strictEqual(receipt.level, payload.level);
    assert.strictEqual(receipt.group, payload.group);
    assert.strictEqual(receipt.eventName, payload.eventName);
    push.emitNotification(notification());
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(push.pushoverAck({receipt: 'fixture-receipt'}), true);
    assert.deepStrictEqual(acknowledgements, [[levels.WARN, 'fixture-group', 420000, true]]);
    assert.strictEqual(push.pushoverAck({receipt: 'fixture-receipt'}), false);
    assert.strictEqual(push.pushoverAck({}), false);
  });

  it('extends successful sends to 15 minutes and expires repeatedly', function () {
    const push = initialize(env, ctx, caches);
    for (let cycle = 1; cycle <= 2; cycle++) {
      push.emitNotification(notification());
      assert.strictEqual(sent.length, cycle);
      now += 31000;
      push.emitNotification(notification());
      assert.strictEqual(sent.length, cycle);
      now += 870001;
    }
    push.emitNotification(notification());
    assert.strictEqual(sent.length, 3);
  });

  it('retries failures only after the original short suppression interval', function () {
    ctx.pushover.send = (notify, callback) => { sent.push(notify); callback(new Error('fixture failure')); };
    const push = initialize(env, ctx, caches);
    push.emitNotification(notification());
    now += 29999;
    push.emitNotification(notification());
    assert.strictEqual(sent.length, 1);
    now += 2;
    push.emitNotification(notification());
    assert.strictEqual(sent.length, 2);
  });

  it('preserves Maker success TTL and does not cache disabled events', function () {
    delete ctx.pushover;
    ctx.maker = {sendEvent(event, callback) { sent.push(event); callback(); }};
    env.settings.isAlarmEventEnabled = () => false;
    const push = initialize(env, ctx, caches);
    push.emitNotification(notification());
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(caches[1].keys().length, 0);
    env.settings.isAlarmEventEnabled = () => true;
    push.emitNotification(notification());
    now += 31000;
    push.emitNotification(notification());
    assert.strictEqual(sent.length, 1);
    now += 870001;
    push.emitNotification(notification());
    assert.strictEqual(sent.length, 2);
  });
  it('keeps failed cancellations retryable and removes successful receipts over two cycles', function () {
    let cancellations = 0, fail = true;
    ctx.pushover.cancelWithReceipt = (receipt, callback) => {
      assert.strictEqual(receipt, 'fixture-receipt');
      cancellations++;
      callback(fail ? new Error('fixture cancel failure') : null);
    };
    const push = initialize(env, ctx, caches);
    for (let cycle = 1; cycle <= 2; cycle++) {
      push.emitNotification(notification());
      fail = true;
      push.emitNotification({clear: true});
      assert.strictEqual(caches[0].keys().length, 1);
      fail = false;
      push.emitNotification({clear: true});
      assert.strictEqual(caches[0].keys().length, 0);
      push.emitNotification({clear: true});
      assert.strictEqual(cancellations, cycle * 2);
      now += 900001;
    }
  });

});
