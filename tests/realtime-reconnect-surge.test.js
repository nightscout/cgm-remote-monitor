'use strict';

// Decision realtime-no-socket-cap: the reconnect surge after an edge restart.
// Run b3 (reports/tenancy/realtime-restart-disconnect-2026-11-11) lost 499 of
// 2,000 stock clients to `io server disconnect`: the edge cut every client,
// the old engine sessions stayed open in realtime (ghosts, up to pingInterval
// + pingTimeout, about 45 s) and the replacement sessions met a process-wide
// cap of 2N. This lab reproduces that with the actual socket server and
// protocol, stock socket.io-client over polling (as lib/client opens it), and
// a TCP edge whose restart destroys the client side of every connection while
// keeping the upstream side open, so realtime keeps each old session as a
// ghost. Synthetic data; no PG, Vault or api.
//
// RT_SURGE_TENANTS (default 10) sets N; two stock clients per tenant. The
// 1,000-tenant check runs this file with RT_SURGE_TENANTS=1000.
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { io: client } = require('socket.io-client');
const scope = require('../lib/storage/tenant-scope');
const protocolFactory = require('../lib/server/realtime/protocol');
const socketServer = require('../lib/server/realtime/socket-server');
const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until (predicate, timeoutMs) { const t0 = Date.now(); while (!predicate()) { if (Date.now() - t0 > timeoutMs) return false; await sleep(50); } return true; }
const tenantId = i => '66666666-6666-4666-8666-' + String(i).padStart(12, '0');
function realtime (tenants) {
  const server = http.createServer();
  // The lab's admission double selects the tenant from a query field: Node's
  // polling transport does not let a client set Host. The actual admission
  // resolves the Host alias (lib/server/realtime/admission.js).
  const known = new Set(tenants);
  const admission = { resolve: async request => { const tenant = new URL(request.url, 'http://lab').searchParams.get('lab'); if (!known.has(tenant)) throw Object.assign(new Error('SOCKET_ADMISSION_REFUSED'), { code: 'SOCKET_ADMISSION_REFUSED' }); return tenant; } };
  const frame = { identity: 'same', checkpoint: 1, rows: [], frame: { delta: false, lastUpdated: 1, sgvs: [] } };
  const runtime = { warm: () => true, wake () {}, last: () => frame, fresh: async () => frame, refresh: async () => frame };
  const protocol = protocolFactory.create({ admission, readCurrent: async () => ({ identity: 'same', env }),
    api: { executeSocketMutation: async () => ({ replyArgs: [] }),
      authorizeSocket: async () => ({ permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: [] }) },
    runtime: () => runtime, domains: ['entries'] });
  const sockets = socketServer.attach(server, { protocol, admission, maxMessageBytes: 100000 });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, protocol, sockets,
    async stop () { protocol.close(); await sockets.close(); await new Promise(done => server.close(() => done())); } })));
}
// The edge. restart(): every client connection is destroyed; its upstream
// connection is left open and drained, so realtime sees no close.
function edge (upstreamPort) {
  const live = new Set(), ghosts = new Set();
  const server = net.createServer(downstream => {
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    const pair = { downstream, upstream }; live.add(pair);
    downstream.on('error', () => {}); upstream.on('error', () => {});
    downstream.pipe(upstream); upstream.pipe(downstream);
    downstream.on('close', () => { live.delete(pair); if (!pair.cut) upstream.destroy(); });
    upstream.on('close', () => { live.delete(pair); ghosts.delete(upstream); downstream.destroy(); });
  });
  // The edge is down for downMs (new connections refused, as while nginx
  // restarts), so a client's retry of its cut poll fails and it reconnects
  // with a new session instead of resuming the old one.
  let port;
  const listen = () => new Promise(resolve => server.listen(port || 0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
  return listen().then(() => ({ port,
    async restart (downMs) {
      if (process.env.RT_SURGE_DEBUG) console.log('edge restart: live connections', live.size);
      const stopped = new Promise(done => server.close(() => done()));
      for (const pair of [...live]) {
        pair.cut = true; live.delete(pair);
        pair.upstream.unpipe(pair.downstream); pair.downstream.unpipe(pair.upstream);
        pair.upstream.on('data', () => {}); ghosts.add(pair.upstream);
        pair.downstream.destroy();
      }
      await stopped; await sleep(downMs); await listen();
    },
    close () { for (const pair of live) { pair.downstream.destroy(); pair.upstream.destroy(); } for (const g of ghosts) g.destroy(); return new Promise(done => server.close(() => done())); } }));
}
describe('realtime reconnect surge after an edge restart (no socket cap)', function () {
  const N = Number(process.env.RT_SURGE_TENANTS || 10);
  this.timeout(Math.max(60000, N * 200));
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('RT_SURGE_RECOVER: every stock client recovers on its own with zero server disconnects while ghost sessions hold realtime above 2N', async function () {
    const tenants = Array.from({ length: N }, (_, i) => tenantId(i));
    const rt = await realtime(tenants), front = await edge(rt.server.address().port);
    const reasons = {}, clients = [], agents = [], peak = { sockets: 0 };
    const sampler = setInterval(() => { peak.sockets = Math.max(peak.sockets, rt.protocol.stats().sockets); }, 20);
    try {
      for (const tenant of tenants) {
        for (let k = 0; k < 2; k++) {
          // As lib/client/index.js: polling, default reconnection; authorize on every connect.
          // One agent per client, as each browser tab has its own connections.
          const agent = new http.Agent({ keepAlive: true }); agents.push(agent);
          const c = client('http://127.0.0.1:' + front.port, { transports: ['polling'], query: { lab: tenant }, agent,
            reconnectionDelay: 200, reconnectionDelayMax: 2000 });
          c.frames = 0; c.on('connect', () => c.emit('authorize', { secret: 'synthetic' }));
          c.on('dataUpdate', () => { c.frames++; }); c.on('disconnect', reason => { reasons[reason] = (reasons[reason] || 0) + 1; });
          clients.push(c);
        }
      }
      assert.ok(await until(() => clients.every(c => c.frames >= 1), Math.max(20000, N * 60)), 'all primed before the edge restart: ' +
        clients.filter(c => c.frames >= 1).length + '/' + clients.length);
      const before = clients.map(c => c.frames);
      await front.restart(1000);
      const recovered = await until(() => clients.every((c, i) => c.frames > before[i]), Math.max(30000, N * 100));
      const count = clients.filter((c, i) => c.frames > before[i]).length;
      await sleep(500);
      const stats = rt.protocol.stats();
      if (process.env.RT_SURGE_DEBUG) console.log(JSON.stringify({ peak, reasons, count, stats }));
      assert.ok(peak.sockets > 2 * N, 'RT_SURGE_GHOSTS the surge was reproduced: realtime held ' + peak.sockets + ' sockets, above 2N = ' + 2 * N);
      assert.equal(reasons['io server disconnect'], undefined, 'RT_SURGE_RECOVER no client was told the server disconnected it: ' + JSON.stringify(reasons) +
        ' server causes ' + JSON.stringify(stats.disconnects));
      assert.ok(recovered, 'RT_SURGE_RECOVER ' + count + '/' + clients.length + ' stock clients received a frame after the edge restart');
      assert.deepEqual(stats.disconnects, {}, 'RT_SURGE_RECOVER zero server-side disconnects by cause');
      if (process.env.RT_SURGE_REPORT) {
        require('node:fs').writeFileSync(process.env.RT_SURGE_REPORT, JSON.stringify({ tenants: N, clients: clients.length, recovered: count,
          peakSockets: peak.sockets, reasons, disconnects: stats.disconnects, handshakeRefusals: stats.handshakeRefusals }, null, 2) + '\n');
      }
    } finally {
      clearInterval(sampler);
      for (const c of clients) c.close();
      for (const agent of agents) agent.destroy();
      await front.close(); await rt.stop();
    }
  });
});
