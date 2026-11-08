'use strict';

const assert = require('node:assert/strict');
const { closeOwned, closeBrowser, assertPort } = require('./human-session-http-native');

describe('bounded human HTTPS instrument (no listeners)', function () {
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
