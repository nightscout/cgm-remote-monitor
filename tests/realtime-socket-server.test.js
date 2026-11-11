'use strict';

// BF-233 with actual Socket.IO: the realtime socket server and protocol over a
// real HTTP listener and stock socket.io-client (polling, as lib/client opens
// it, default reconnection). A restart is close + a new server on the same
// port. Synthetic data; no PG, Vault or api.
const assert = require('node:assert/strict');
const http = require('node:http');
const { io: client } = require('socket.io-client');
const scope = require('../lib/storage/tenant-scope');
const protocolFactory = require('../lib/server/realtime/protocol');
const socketServer = require('../lib/server/realtime/socket-server');
const A = '11111111-1111-4111-8111-111111111111';
const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until (predicate, timeoutMs) { const t0 = Date.now(); while (!predicate()) { if (Date.now() - t0 > timeoutMs) return false; await sleep(20); } return true; }
function realtime (port) {
  const server = http.createServer();
  const admission = { resolve: async () => A };
  const frame = { tenant: A, identity: 'same', checkpoint: 1, rows: [], frame: { delta: false, lastUpdated: 1, sgvs: [] } };
  const protocol = protocolFactory.create({ admission, readCurrent: async tenant => ({ tenant, identity: 'same', env }),
    api: { executeSocketMutation: async () => ({ replyArgs: [] }),
      authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: [] }) },
    runtime: () => ({ refresh: async () => frame }), maxSockets: 1000, domains: ['entries'] });
  const sockets = socketServer.attach(server, { protocol, admission, maxMessageBytes: 100000 });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, protocol, sockets,
    async stop () { const t0 = Date.now(); protocol.close(); await sockets.close(); await new Promise(done => server.close(() => done())); return Date.now() - t0; } })));
}
describe('BF-233 realtime restart with actual Socket.IO clients', function () {
  this.timeout(60000);
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('BF233_RECOVER: stock clients reconnect N/N after a restart and shutdown completes within its bound', async function () {
    const N = 50, agent = new http.Agent({ keepAlive: true });
    let rt = await realtime(0);
    const port = rt.server.address().port, reasons = {}, clients = [];
    for (let i = 0; i < N; i++) {
      // As lib/client/index.js:1165: polling, default reconnection; authorize on every connect.
      const c = client('http://127.0.0.1:' + port, { transports: ['polling'], agent, reconnectionDelay: 200, reconnectionDelayMax: 1000 });
      c.frames = 0; c.on('connect', () => c.emit('authorize', { secret: 'synthetic' }));
      c.on('dataUpdate', () => { c.frames++; }); c.on('disconnect', reason => { reasons[reason] = (reasons[reason] || 0) + 1; });
      clients.push(c);
    }
    try {
      assert.ok(await until(() => clients.every(c => c.frames >= 1), 15000), 'all primed before the restart');
      const stopMs = await rt.stop();
      assert.ok(stopMs < 2000, 'BF233_SHUTDOWN_BOUND shutdown took ' + stopMs + ' ms');
      const before = clients.map(c => c.frames);
      await sleep(300);
      rt = await realtime(port);
      const recovered = await until(() => clients.every((c, i) => c.frames > before[i]), 20000);
      const count = clients.filter((c, i) => c.frames > before[i]).length;
      assert.ok(recovered, 'BF233_RECOVER ' + count + '/' + N + ' stock clients received a frame after the restart; reasons ' + JSON.stringify(reasons));
      assert.equal(reasons['io server disconnect'], undefined, 'no client was told the server disconnected it: ' + JSON.stringify(reasons));
    } finally {
      for (const c of clients) c.close();
      await rt.stop(); agent.destroy();
    }
  });
});
