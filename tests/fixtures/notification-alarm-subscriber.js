'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { io } = require('socket.io-client');

module.exports = async function openAlarmSubscriber (tenant) {
  const admission = { resolve: async () => tenant };
  const protocol = require('../../lib/server/realtime/protocol').create({ admission,
    readCurrent: async id => id === tenant ? { tenant, identity: 'after' } : null,
    api: { authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: [] }),
      executeSocketMutation: async () => ({}) },
    runtime: () => ({}), domains: ['entries'] });
  const server = http.createServer();
  const sockets = require('../../lib/server/realtime/socket-server').attach(server, { protocol, admission, maxMessageBytes: 65536 });
  let subscriber;
  async function close () {
    subscriber?.close();
    protocol.close();
    await sockets.close();
  }
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    subscriber = io('http://127.0.0.1:' + server.address().port + '/alarm',
      { transports: ['polling'], reconnection: false, autoConnect: false });
    const connected = once(subscriber, 'connect', { signal: AbortSignal.timeout(4000) });
    subscriber.connect();
    await connected;
    const subscription = await subscriber.timeout(2000).emitWithAck('subscribe', { accessToken: 'synthetic' });
    assert.equal(subscription.success, true);
    return { subscriber, deliver: protocol.alarm, close };
  } catch (error) {
    await close();
    throw error;
  }
};
