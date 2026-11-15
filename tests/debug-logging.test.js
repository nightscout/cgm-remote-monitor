'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const configure = require('../lib/server/env');
const boot = require('../lib/server/bootevent');
const compat = require('../lib/server/bridge-connect-compat');

describe('debug logging configuration', function () {
  let saved;
  const names = ['DEBUG_LOGGING', 'debug_logging', 'CUSTOMCONNSTR_DEBUG_LOGGING', 'CUSTOMCONNSTR_debug_logging',
    'CONNECT_DEBUG', 'connect_debug', 'CUSTOMCONNSTR_CONNECT_DEBUG', 'CUSTOMCONNSTR_connect_debug',
    'ENABLE', 'BRIDGE_USER_NAME', 'BRIDGE_PASSWORD', 'CONNECT_SOURCE', 'CONNECT_SHARE_ACCOUNT_NAME', 'CONNECT_SHARE_PASSWORD'];
  beforeEach(function () {
    saved = {};
    names.forEach(name => { saved[name] = process.env[name]; delete process.env[name]; });
  });
  afterEach(function () {
    names.forEach(name => {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });
  });

  it('defaults to quiet logging without changing minification', function () {
    const env = configure();
    assert.equal(env.debug.logging, false);
    assert.equal(env.debug.minify, true);
  });
  ['DEBUG_LOGGING', 'debug_logging', 'CUSTOMCONNSTR_DEBUG_LOGGING', 'CUSTOMCONNSTR_debug_logging'].forEach(name => {
    it('accepts a trimmed true/on value through ' + name, function () {
      process.env[name] = ' ON ';
      assert.equal(configure().debug.logging, true);
    });
  });
  ['false', 'OFF', '', 'invalid', '1'].forEach(value => {
    it('keeps diagnostics disabled for ' + JSON.stringify(value), function () {
      process.env.DEBUG_LOGGING = value;
      assert.equal(configure().debug.logging, false);
    });
  });
  [undefined, 'true', 'false', 'invalid'].forEach(value => {
    it('preserves connector debug override through legacy bridge migration: ' + value, function () {
      process.env.ENABLE = 'bridge';
      process.env.BRIDGE_USER_NAME = 'fixture-user';
      process.env.BRIDGE_PASSWORD = 'fixture-password';
      if (value !== undefined) process.env.CONNECT_DEBUG = value;
      const env = configure();
      compat.applyBridgeToConnectCompatibility(env);
      assert.equal(env.extendedSettings.connect.source, 'dexcomshare');
      assert.equal(env.extendedSettings.connect.debug, value === undefined ? undefined : value === 'true');
    });
  });

  [
    [undefined, undefined, false], ['true', undefined, true],
    ['false', 'true', true], ['true', 'false', false], ['true', 'invalid', false]
  ].forEach(function ([globalDebug, connectorDebug, expected]) {
    it(`installed connector honors DEBUG_LOGGING=${globalDebug}, CONNECT_DEBUG=${connectorDebug}`, async function () {
      process.env.ENABLE = 'connect';
      process.env.CONNECT_SOURCE = 'dexcomshare';
      process.env.CONNECT_SHARE_ACCOUNT_NAME = 'fixture-user';
      process.env.CONNECT_SHARE_PASSWORD = 'fixture-password';
      if (globalDebug !== undefined) process.env.DEBUG_LOGGING = globalDebug;
      if (connectorDebug !== undefined) process.env.CONNECT_DEBUG = connectorDebug;
      const env = configure();
      const ctx = { bus: new EventEmitter(), bootErrors: [] };
      const original = {};
      const logs = [];
      let handle;
      try {
        ['log', 'info', 'debug', 'warn', 'error'].forEach(method => {
          original[method] = console[method];
          console[method] = (...args) => logs.push(args);
        });
        handle = require('nightscout-connect')(env, ctx);
        // Exercise the real internal output without starting vendor requests.
        ctx.bus.removeListener('data-processed', handle.run);
        const sg = { mills: Date.now(), sgv: 123 };
        const sbx = { data: { sgvs: [sg], treatments: [], devicestatus: [], profile: [] }, lastEntry: items => items[items.length - 1] };
        logs.length = 0;
        ctx.bus.emit('tick', { now: sg.mills });
        ctx.bus.emit('data-processed', sbx);
        assert.equal(logs.length, expected ? 1 : 0);
        if (expected) assert.equal(logs[0][0], 'DEBUG nightscout-connect: data-loaded');
      } finally {
        if (handle) await handle.stop();
        ctx.bus.removeAllListeners();
        Object.assign(console, original);
      }
    });
  });

});

describe('boot event diagnostics', function () {
  [false, true].forEach(logging => {
    ['tick', 'data-received'].forEach(event => {
      it(`processes ${event} and notifications with logging=${logging}`, function () {
        const steps = [];
        const bootId = require.resolve('bootevent');
        const sandboxId = require.resolve('../lib/sandbox');
        require(bootId);
        require(sandboxId);
        const originalBoot = require.cache[bootId].exports;
        const originalSandbox = require.cache[sandboxId].exports;
        const savedConsole = { log: console.log, info: console.info, debug: console.debug };
        const logs = [];
        const bus = new EventEmitter();
        let loads = 0;
        let notifications = 0;
        let processed = 0;
        const sbx = {};
        try {
          require.cache[bootId].exports = () => ({ acquire(fn) { steps.push(fn); return this; } });
          require.cache[sandboxId].exports = () => ({ serverInit: () => sbx });
          for (const method of Object.keys(savedConsole)) console[method] = (...args) => logs.push(args);
          boot({ debug: { logging } }, {});
          const ctx = {
            bus, ddata: {}, bootErrors: [],
            dataloader: { update(data, done) { loads++; done(); } },
            plugins: { setProperties() {}, checkNotifications() {} },
            notifications: { initRequests() {}, process() { notifications++; } },
            pushnotify: { emitNotification() {} }
          };
          steps.find(fn => fn.name === 'setupListeners')(ctx, () => {});
          logs.length = 0;
          bus.on('data-processed', () => processed++);
          bus.emit(event, { now: 1234 });
          assert.equal(loads, 1);
          assert.equal(notifications, 1);
          assert.equal(processed, 1);
          assert.equal(ctx.runtimeState, 'loaded');
          assert.equal(logs.length, logging ? 2 : 0);
        } finally {
          require.cache[bootId].exports = originalBoot;
          require.cache[sandboxId].exports = originalSandbox;
          Object.assign(console, savedConsole);
          bus.removeAllListeners();
        }
      });
    });
  });
});
