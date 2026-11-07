'use strict';

// Isolated real pushnotify workload. Providers are synchronous local fakes; no
// server, database or network is opened. Compare fresh processes, not summed
// historical savings. node --expose-gc SCRIPT WORKTREE [raw-cache-module]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {EventEmitter} = require('node:events');
const {execFileSync} = require('node:child_process');
const root = path.resolve(process.argv[2]);
const filename = path.join(root, 'lib/server/pushnotify.js');
const localRequire = createRequire(filename);
const caches = [], timers = new Set(), cycles = [];
const originalNow = Date.now, originalSet = global.setTimeout, originalClear = global.clearTimeout;
const originalInterval = global.setInterval, originalClearInterval = global.clearInterval;
let now = 1700000000000, sends = 0, acks = 0, cancels = 0;
const collect = () => {for (let i = 0; i < 3; i++) global.gc(); return process.memoryUsage();};
const beforeLoad = collect();
Date.now = () => now;
global.setTimeout = global.setInterval = () => {const timer = {unref() {return this;}}; timers.add(timer); return timer;};
global.clearTimeout = global.clearInterval = timer => timers.delete(timer);
try {
  const quiet = {info() {}, warn() {}, error() {}};
  const sandbox = {module: {exports: {}}, console: quiet, require(name) {
    if (!['node-cache', '../utils/notification-cache'].includes(name)) return localRequire(name);
    const Cache = process.argv[3] ? require(path.resolve(process.argv[3])) : localRequire(name);
    return function (options) {const cache = new Cache(options); caches.push(cache); return cache;};
  }};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename});
  const levels = localRequire('../levels');
  const ctx = {levels, bus: new EventEmitter(), notifications: {ack() {acks++;}}, pushover: {
    send(notify, callback) {sends++; callback(null, JSON.stringify({receipt: notify.notifyhash}));},
    cancelWithReceipt(receipt, callback) {cancels++; callback(null);}
  }};
  const env = {settings: {isAlarmEventEnabled: () => true, snoozeFirstMinsForAlarmEvent: () => 7}};
  const push = sandbox.module.exports(env, ctx);
  ctx.bus.on('notification', push.emitNotification);
  const loaded = collect();
  assert.equal(timers.size, 2);
  for (let cycle = 0; cycle < 5; cycle++) {
    const started = performance.now();
    for (let i = 0; i < 1000; i++) {
      push.emitNotification({notifyhash: 'fixture-' + i, level: levels.WARN,
        plugin: {name: 'fixture'}, group: 'fixture', eventName: 'high', title: 'Fixture',
        message: 'Fixture', large: Array.from({length: 100}, (_, n) => ({n, value: 'x'.repeat(128)}))});
    }
    for (let repeat = 0; repeat < 5; repeat++) {
      for (let i = 0; i < 1000; i++) push.emitNotification({notifyhash: 'fixture-' + i});
    }
    const workloadMs = performance.now() - started;
    assert.equal(sends, (cycle + 1) * 1000);
    assert.deepEqual(caches.map(cache => cache.keys().length), [1000, 1000]);
    const populated = collect();
    for (let i = 0; i < 500; i++) assert.equal(push.pushoverAck({receipt: 'fixture-' + i}), true);
    push.emitNotification({clear: true});
    assert.equal(caches[0].keys().length, 0);
    // Read expiry uses the same public path when housekeeping is delayed.
    now += 3600001;
    for (const cache of caches) for (const key of cache.keys()) assert.equal(cache.get(key), undefined);
    assert.deepEqual(caches.map(cache => cache.keys().length), [0, 0]);
    cycles.push({workloadMs, populated, released: collect(), timers: timers.size});
  }
  ctx.bus.emit('teardown'); ctx.bus.emit('teardown');
  assert.equal(timers.size, 0);
  assert.equal(ctx.bus.listenerCount('notification'), 0);
  assert.equal(ctx.bus.listenerCount('teardown'), 0);
  assert.equal(acks, 2500); assert.equal(cancels, 2500);
  console.log(JSON.stringify({scope: 'real pushnotify with mocked providers and clock; not whole-server memory',
    baseline: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    node: process.version, beforeLoad, loaded, cycles, closed: collect(), sends, acks, cancels,
    suppressed: 25000, modules: Object.keys(require.cache).length, timers: timers.size,
    sources: Object.fromEntries(['lib/server/pushnotify.js', 'lib/utils/notification-cache.js', 'package-lock.json']
      .filter(file => fs.existsSync(path.join(root, file)))
      .map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    sourceSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')}));
} finally {
  caches.forEach(cache => cache.close());
  Date.now = originalNow;
  global.setTimeout = originalSet; global.clearTimeout = originalClear;
  global.setInterval = originalInterval; global.clearInterval = originalClearInterval;
}
