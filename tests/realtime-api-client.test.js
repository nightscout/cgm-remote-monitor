'use strict';

// covers: lib/server/realtime/api-client.js, lib/server/internal-api/transport.js
// Realtime's api client behind a service address of equal replicas: authorizeSocket
// retries a not-ready answer once on a new connection; executeSocketMutation is
// attempted exactly once, even when the connection resets after the request was sent.
const assert = require('node:assert/strict');
const http = require('node:http');
const apiClient = require('../lib/server/realtime/api-client');
const clients = require('../lib/server/internal-api/clients');
const TENANT = '11111111-1111-4111-8111-111111111111';
const AUTHORIZE = { host: 'one.example.test', tenant: TENANT, namespace: '/', credential: {} };
const MUTATION = { host: 'one.example.test', envelope: { tenant: TENANT, credential: { token: 'synthetic' }, namespace: '/', event: 'dbAdd',
  args: [{ collection: 'treatments', data: { eventType: 'Note', notes: 'synthetic' } }] } };
const notReady = () => Object.assign(new Error('SOCKET_IPC_UNAVAILABLE'), { notReady: true });
const PERMITTED = { permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: [] };

function stub (results) {
  const calls = { authorizeSocket: 0, executeSocketMutation: 0 };
  const next = name => async () => { calls[name]++; const value = results[name].shift(); if (value instanceof Error) throw value; return value; };
  return { calls, api: { authorizeSocket: next('authorizeSocket'), executeSocketMutation: next('executeSocketMutation') } };
}

describe('Realtime api client over a replica service address', function () {
  it('retries authorizeSocket once on not ready, and gives up after the second attempt', async function () {
    let s = stub({ authorizeSocket: [notReady(), PERMITTED] });
    const client = apiClient.create(s.api);
    assert.deepEqual(await client.authorizeSocket(AUTHORIZE), PERMITTED);
    assert.equal(s.calls.authorizeSocket, 2);
    assert.equal(client.counters().authorizeRetries, 1);
    s = stub({ authorizeSocket: [notReady(), notReady(), PERMITTED] });
    await assert.rejects(apiClient.create(s.api).authorizeSocket(AUTHORIZE), { notReady: true });
    assert.equal(s.calls.authorizeSocket, apiClient.ATTEMPTS, 'at most two attempts');
  });

  it('never retries a refusal or a denial', async function () {
    const s = stub({ authorizeSocket: [Object.assign(new Error('SOCKET_IPC_UNAVAILABLE')), PERMITTED] });
    await assert.rejects(apiClient.create(s.api).authorizeSocket(AUTHORIZE), /SOCKET_IPC_UNAVAILABLE/);
    assert.equal(s.calls.authorizeSocket, 1);
    const denied = stub({ authorizeSocket: [{ denied: true }] });
    assert.deepEqual(await apiClient.create(denied.api).authorizeSocket(AUTHORIZE), { denied: true });
    assert.equal(denied.calls.authorizeSocket, 1);
  });

  it('never retries executeSocketMutation, even on a not-ready error', async function () {
    const s = stub({ executeSocketMutation: [notReady(), { replyArgs: [null] }] });
    await assert.rejects(apiClient.create(s.api).executeSocketMutation(MUTATION), { notReady: true });
    assert.equal(s.calls.executeSocketMutation, 1);
  });

  describe('over the real transport', function () {
    let server, url, received;
    const reset = { '/authorize': 0, '/mutate': 0 };
    before(async function () {
      received = { '/authorize': 0, '/mutate': 0 };
      // Reads the whole request, then resets the connection without answering (a
      // replica force-closed mid-call): the request was delivered, the outcome is unknown.
      server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          received[req.url]++;
          if (reset[req.url] > 0) { reset[req.url]--; req.socket.destroy(); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.url === '/authorize' ? PERMITTED : { replyArgs: [null] }));
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      url = 'http://127.0.0.1:' + server.address().port + '/';
    });
    after(() => new Promise(resolve => server.close(resolve)));
    const client = () => apiClient.create(clients.socketAuthority({ url, trust: 'network', maxBytes: 65536, timeoutMs: 2000 }));

    it('attempts a mutation exactly once when the connection resets after the request was sent', async function () {
      reset['/mutate'] = 1;
      await assert.rejects(client().executeSocketMutation(MUTATION), /SOCKET_IPC_UNAVAILABLE/);
      assert.equal(received['/mutate'], 1, 'the api received the mutation once; it was not sent again');
    });

    it('repeats authorizeSocket on a new connection after a reset, and answers', async function () {
      reset['/authorize'] = 1; received['/authorize'] = 0;
      const c = client();
      assert.deepEqual(await c.authorizeSocket(AUTHORIZE), PERMITTED);
      assert.equal(received['/authorize'], 2);
      assert.equal(c.counters().authorizeRetries, 1);
    });
  });
});
