'use strict';

// The replay measures notification requests and the delivery handoff only.
// Replace the delivery boundary before boot, and deny non-loopback sockets.
// Always restore both process-global hooks when the suite finishes.
module.exports = function localOnly () {
  const net = require('node:net');
  const originalConnect = net.Socket.prototype.connect;
  const pushPath = require.resolve('../../../lib/server/pushnotify');
  require(pushPath);
  const originalPush = require.cache[pushPath].exports;
  const handoffs = [];
  let blocked = 0;
  net.Socket.prototype.connect = function connect (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = first && typeof first === 'object' ? first.host || 'localhost'
      : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
      blocked++;
      throw new Error('profile replay denies external socket');
    }
    return originalConnect.apply(this, args);
  };
  require.cache[pushPath].exports = function fakeDelivery (env, ctx) {
    const provider = { emitNotification: notification => handoffs.push(notification) };
    ctx.bus.once('teardown', () => ctx.bus.removeListener('notification', provider.emitNotification));
    return provider;
  };
  return {
    handoffs,
    blocked: () => blocked,
    restore () {
      net.Socket.prototype.connect = originalConnect;
      require.cache[pushPath].exports = originalPush;
    }
  };
};
