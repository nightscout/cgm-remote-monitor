'use strict';

const assert = require('node:assert/strict');
const { run, closeOwned, closeBrowser, assertPort, admitOwnerExtension, closeOwnerAndNative, fixtureOrigins } = require('./human-session-http-native');

describe('bounded human HTTPS instrument (no listeners)', function () {
  it('uses a real owner hostname accepted by the unchanged resolver while keeping provider cookies on a different host', async function () {
    const tenant = '11111111-1111-4111-8111-111111111111';
    const resolver = require('../lib/tenant-resolution')({ aliases: [{ host: 'localhost', tenant }] });
    const first = 'https://127.0.0.1:23456', second = 'https://127.0.0.1:23457';
    for (const browser of [false, true]) {
      const { site, issuer } = fixtureOrigins(first, second, { owner: true, browser });
      const host = new URL(site).host;
      assert.equal(await resolver.resolve({ rawHeaders: ['Host', host] }), tenant);
      assert.notEqual(new URL(site).hostname, new URL(issuer).hostname, 'cookie hosts must differ');
    }
    assert.deepEqual(fixtureOrigins(first, second), { site: first, issuer: second });
    const defaults = fixtureOrigins(first, second, { browser: true });
    assert.equal(defaults.site, first);
    assert.equal(new URL(defaults.issuer).hostname, 'localhost');
  });

  it('refuses owner extension setup before TLS or runtime acquisition without complete reserved native inputs', async function () {
    const source = { HUMAN_HTTPS_RESERVED: '1', HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_HTTP_STORE: 'postgres',
      HUMAN_HTTP_SIGNER_CONFIG: 'synthetic-config', HUMAN_SESSION_PG_ADMIN_URL: 'synthetic-admin', HUMAN_SESSION_PG_APP_URL: 'synthetic-app' };
    let calls = 0;
    const factory = Object.assign(() => { throw new Error('No factory acquisition in admission'); }, { admit () { calls++; } });
    for (const name of Object.keys(source)) {
      const missing = { ...source }; delete missing[name];
      assert.throws(() => admitOwnerExtension(factory, missing), /explicit reserved native/);
      assert.equal(calls, 0);
    }
    assert.throws(() => admitOwnerExtension(() => {}, source), /explicit reserved native/);
    admitOwnerExtension(factory, source); assert.equal(calls, 1);
    admitOwnerExtension(undefined, {});
    const saved = process.env.HUMAN_HTTPS_RESERVED;
    try {
      delete process.env.HUMAN_HTTPS_RESERVED;
      await assert.rejects(run({ createOwnerExtension: factory }), /one-run HTTPS reservation/);
      assert.equal(calls, 1, 'run refuses before invoking even pure extension admission');
    } finally {
      if (saved === undefined) delete process.env.HUMAN_HTTPS_RESERVED;
      else process.env.HUMAN_HTTPS_RESERVED = saved;
    }
  });

  it('keeps extension admission synchronous and propagates owned-config refusal', function () {
    const source = { HUMAN_HTTPS_RESERVED: '1', HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_HTTP_STORE: 'postgres',
      HUMAN_HTTP_SIGNER_CONFIG: 'synthetic-config', HUMAN_SESSION_PG_ADMIN_URL: 'synthetic-admin', HUMAN_SESSION_PG_APP_URL: 'synthetic-app' };
    assert.throws(() => admitOwnerExtension(Object.assign(() => {}, { admit: () => Promise.resolve() }), source), /must be synchronous/);
    assert.throws(() => admitOwnerExtension(Object.assign(() => {}, { admit () { throw new Error('owned-config-refused'); } }), source), /owned-config-refused/);
  });

  it('checks extension-owned admission before reading TLS materials in the actual runner', async function () {
    const selected = { HUMAN_HTTPS_RESERVED: '1', HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_HTTP_STORE: 'postgres',
      HUMAN_HTTP_SIGNER_CONFIG: 'synthetic-config', HUMAN_SESSION_PG_ADMIN_URL: 'synthetic-admin', HUMAN_SESSION_PG_APP_URL: 'synthetic-app' };
    const saved = new Map(Object.keys(selected).map(key => [key, process.env[key]]));
    const factory = Object.assign(() => { throw new Error('No owner factory acquisition'); }, {
      admit () { throw new Error('OWNED_ADMISSION_REFUSED_BEFORE_TLS'); }
    });
    try {
      Object.assign(process.env, selected);
      await assert.rejects(run({ createOwnerExtension: factory }), /OWNED_ADMISSION_REFUSED_BEFORE_TLS/);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('drains owner pools before native schemas and retains both cleanup failures', async function () {
    const events = [];
    const owner = { async close () { await Promise.resolve(); events.push('owner'); } };
    const native = { async close () { assert.deepEqual(events, ['owner']); events.push('native'); } };
    await closeOwnerAndNative(owner, native); assert.deepEqual(events, ['owner', 'native']);
    const fail = value => ({ async close () { events.push(value); throw new Error(value); } });
    await assert.rejects(closeOwnerAndNative(fail('owner-failed'), fail('native-failed')), error =>
      error instanceof globalThis.AggregateError && error.errors.map(item => item.message).join(',') === 'owner-failed,native-failed');
    assert.deepEqual(events.slice(-2), ['owner-failed', 'native-failed']);
  });

  it('refuses the reserved ports after ephemeral binding without retrying them', function () {
    for (const port of [18080, 18081, 18082]) assert.throws(() => assertPort(port), /reserved port/);
    assertPort(23456);
  });

  it('waits for actual socket close events and server callbacks before reporting closure', async function () {
    const sockets = new Set(), socketClosures = new Map();
    let serverClosed = false, socketClosed = false, resolveSocket;
    const socket = { destroy () { setTimeout(() => {
      socketClosed = true; sockets.delete(socket); resolveSocket();
    }, 15); } };
    sockets.add(socket); socketClosures.set(socket, new Promise(resolve => { resolveSocket = resolve; }));
    const server = { close (callback) { setTimeout(() => { serverClosed = true; callback(); }, 25); } };
    const closing = closeOwned({ servers: [server], sockets, socketClosures, timeoutMs: 200 });
    assert.equal(socketClosed, false); assert.equal(serverClosed, false);
    await closing; assert.equal(socketClosed, true); assert.equal(serverClosed, true);
  });

  it('goes red on an unobserved socket close and invokes its finite deadline refusal', async function () {
    const socket = { destroy () {} }, sockets = new Set([socket]);
    let refused = false;
    await assert.rejects(closeOwned({ servers: [{ close: callback => callback() }], sockets,
      socketClosures: new Map([[socket, new Promise(() => {})]]), timeoutMs: 20,
      onDeadline: () => { refused = true; } }), /cleanup exceeded/);
    assert.equal(refused, true);
  });

  it('refuses failed server close rather than turning cleanup into a pass', async function () {
    await assert.rejects(closeOwned({ servers: [{ close: callback => callback(new Error('synthetic close failed')) }],
      sockets: new Set(), socketClosures: new Map(), timeoutMs: 100 }), /synthetic close failed/);
  });

  it('observes every owned cleanup even after a different resource refuses', async function () {
    let drained = false;
    await assert.rejects(closeOwned({ servers: [], sockets: new Set(), socketClosures: new Map(), timeoutMs: 200,
      resources: [{ close: async () => { throw new Error('synthetic resource refused'); } },
        { close: () => new Promise(resolve => setTimeout(() => { drained = true; resolve(); }, 20)) }] }), /synthetic resource refused/);
    assert.equal(drained, true);
  });

  it('kills a browser on immediate graceful-close refusal and retains that failure after proving listener closure', async function () {
    const events = [];
    const server = { wsEndpoint: () => 'ws://127.0.0.1:23456/owned',
      close: async () => { throw new Error('synthetic graceful close failed'); }, kill: async () => { events.push('kill'); } };
    await assert.rejects(closeBrowser(server, { probe: async () => { events.push('listener-closed'); } }), /synthetic graceful close failed/);
    assert.deepEqual(events, ['kill', 'listener-closed']);
  });

  it('kills a hung graceful browser close within its bound and refuses a surviving listener', async function () {
    let killed = false;
    const server = { wsEndpoint: () => 'ws://127.0.0.1:23456/owned',
      close: () => new Promise(() => {}), kill: async () => { killed = true; } };
    await assert.rejects(closeBrowser(server, { graceMs: 10, probe: async () => {} }), /graceful cleanup deadline/);
    assert.equal(killed, true);
    await assert.rejects(closeBrowser({ ...server, close: async () => {} }, {
      probe: async () => { throw new Error('synthetic surviving listener'); }
    }), /surviving listener/);
  });
});
