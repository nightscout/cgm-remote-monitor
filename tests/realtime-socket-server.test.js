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
    runtime: () => ({ last: () => frame, wake () {}, refresh: async () => frame }), domains: ['entries'] });
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

describe('realtime handshake refusal observations with native polling clients', function () {
  this.timeout(15000);
  const { logDisconnects } = require('../lib/server/serve/preview-realtime');
  const summary = require('../lib/diagnostics/realtime-handshake');
  const fail = code => { throw Object.assign(Error(code), { code }); };
  it('retains fixed refusal categories and cumulative counts without arbitrary codes or duplicate intervals', function () {
    let raw = { REALTIME_OWNER_UNAVAILABLE: 2, 'REALTIME_HANDSHAKE_REFUSED:synthetic-private-detail': 3, 'synthetic-private-code': 4, REALTIME_WRONG_OWNER: -1 };
    const lines = [], timer = logDisconnects({ stats: () => ({ handshakeRefusals: raw }) }, 60000, line => lines.push(line));
    try {
      timer.flush(); timer.flush();
      assert.equal(lines.length, 1);
      const value = JSON.parse(lines[0].split('realtime handshake refusals: ')[1]);
      assert.deepEqual(value.refusals, { REALTIME_OWNER_UNAVAILABLE: 2, REALTIME_HANDSHAKE_REFUSED: 3, UNCLASSIFIED: 4 });
      assert.deepEqual(value.totals, value.refusals);
      assert(!lines[0].includes('synthetic-private'));
      raw = { ...raw, REALTIME_OWNER_UNAVAILABLE: 5 };
      timer.flush();
      assert.deepEqual(JSON.parse(lines[1].split('realtime handshake refusals: ')[1]).refusals, { REALTIME_OWNER_UNAVAILABLE: 3 });
      assert.equal(JSON.parse(lines[1].split('realtime handshake refusals: ')[1]).totals.REALTIME_OWNER_UNAVAILABLE, 5);
      assert.deepEqual(summary.counts({ REALTIME_OWNER_UNAVAILABLE: NaN, arbitrary: Infinity }), {});
    } finally { clearInterval(timer); }
  });
  it('distinguishes identical public 403s, accepts a handshake for a tenant with no output without reading it, and reads the output once it completes', async function () {
    const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const ownership = require('../lib/realtime-ownership').create({ count: 1, ordinal: 0 });
    const bucket = require('../lib/pool-membership/slice').bucket(A, 2);
    const foreign = require('../lib/realtime-ownership').create({ count: 2, ordinal: 1 - bucket });
    const token = {}, lines = [], sockets = [];
    let mode = 'normal', pending = true, acquired = 0, initialized = 0, protocol, rt;
    const startup = require('../lib/server/serve/tenant-startup').create([A], undefined, async () => { initialized++; },
      { readiness: 'serve', warmOnStart: false, coldAlertMs: null });
    const current = tenant => ({ tenant, identity: 'synthetic-current', env });
    const detector = require('../lib/pgstream/realtime-output').revisions({
      config: { completedOutput: { namespace: 'synthetic_completed', consumer: 'evaluator-test' } },
      connection: { async readOnly () { return { rows: [{ tenant: A, revision: pending ? '0' : '1', work_enabled: true }] }; } },
      trusted: { scan: async () => new Map([[A, { activity: { state: 'active' } }]]) }, owner: () => {}
    });
    const base = require('../lib/server/realtime/registry-admission').create({
      resolver: { resolve: async request => request.headers.host?.split(':')[0] === 'a.synthetic.test' ? A : fail('TENANT_HOST_UNKNOWN') },
      active: async () => true, enabled: () => [A]
    });
    // The same guard order as preview-realtime: the handshake reads nothing
    // about the tenant's output. The controlled collaborators exercise the
    // native source and transport, without claiming a PostgreSQL or
    // Kubernetes workload measurement.
    const admission = { ...base, async resolve (request) {
      const tenant = await base.resolve(request);
      if (mode === 'platform') fail('PLATFORM_VERIFICATION_REQUIRED');
      if (mode === 'owner') fail('REALTIME_OWNER_UNAVAILABLE');
      (mode === 'foreign' ? foreign : ownership).assert(tenant);
      return tenant;
    } };
    const server = http.createServer(), agent = new http.Agent({ lookup: (host, options, done) => options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4) });
    let attached, logger;
    const connect = async (headers = {}) => {
      const socket = client('http://' + (headers.Host || 'a.synthetic.test') + ':' + server.address().port, {
        transports: ['polling'], agent, reconnection: false, forceNew: true, timeout: 2000,
        ...(headers.Origin ? { extraHeaders: { Origin: headers.Origin } } : {})
      });
      sockets.push(socket);
      return new Promise(resolve => {
        socket.once('connect', () => resolve({ socket, connected: true }));
        socket.once('connect_error', error => { socket.close(); resolve({ connected: false, status: error.description }); });
      });
    };
    try {
      rt = await require('../lib/server/realtime/runtime')({ readRevisions: detector, levelMs: 60000,
        watched: () => protocol.watchedTenants(), isWatched: tenant => protocol.watched(tenant), lagging: () => protocol.lagging(),
        readCurrent: async tenant => current(tenant), prepareTenant: startup.ensure,
        create: () => ({ acquire: async () => { acquired++; return { tenant: A, identity: 'synthetic-current', checkpoint: 1, rows: [], frame: { sgvs: [], lastUpdated: 1 } }; } }),
        fanout: async operation => protocol.fanout(operation), concurrency: 2 });
      protocol = protocolFactory.create({ admission, readCurrent: async tenant => current(tenant),
        api: { authorizeSocket: async body => Object.keys(body.credential).length ? { denied: true } : { permissions: { read: false, write: false, write_treatment: false, ack: false }, collections: [] }, executeSocketMutation: async () => fail('UNEXPECTED_MUTATION') },
        runtime: () => rt, domains: ['entries'] });
      attached = socketServer.attach(server, { protocol, admission, maxMessageBytes: 100000 });
      logger = logDisconnects(protocol, 60000, line => lines.push(line));
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const inspect = require('../lib/server/serve/realtime-inspection')({ processIncarnation: A, ownership,
        owner: () => mode !== 'owner', quiescing: () => false, startup, modelWarm: tenant => rt.warm(tenant),
        runtimeStats: () => rt.stats(), detectorStats: () => detector.stats(), watchedCount: () => 0 })(token);
      const snapshot = () => inspect.inspectRealtimeTenants({ transport: token }, { tenants: [A] });
      const refusal = async (code, headers) => {
        const before = protocol.stats().handshakeRefusals[code] || 0;
        const result = await connect(headers);
        assert.equal(result.connected, false); assert.equal(result.status, 403);
        assert.equal(protocol.stats().handshakeRefusals[code], before + 1, JSON.stringify(protocol.stats().handshakeRefusals));
      };
      await refusal('REALTIME_ORIGIN_REFUSED', { Origin: 'http://foreign.synthetic.test' });
      await refusal('SOCKET_ADMISSION_REFUSED', { Host: 'unknown.synthetic.test' });
      mode = 'platform'; await refusal('PLATFORM_VERIFICATION_REQUIRED');
      mode = 'owner'; await refusal('REALTIME_OWNER_UNAVAILABLE');
      mode = 'foreign'; await refusal('REALTIME_WRONG_OWNER'); mode = 'normal';
      // A tenant with no completed output: the handshake is accepted, the
      // socket connects, and nothing about the tenant's output is read for it.
      const early = await connect(); assert.equal(early.connected, true, 'COLD_HANDSHAKE_ACCEPTED');
      assert(await until(() => protocol.watched(A), 2000));
      await rt.tick();
      const waiting = await snapshot(), beforeRead = rt.stats();
      assert.equal(waiting.tenants[0].owned, true); assert.equal(waiting.ownerAvailable, true);
      assert.equal(waiting.tenants[0].startupComplete, false); assert.equal(waiting.tenants[0].modelAvailable, false);
      for (let i = 0; i < 3; i++) await snapshot();
      assert.deepEqual(rt.stats(), beforeRead, 'PRIVATE_INSPECTION_MUST_NOT_CREATE_DEMAND');
      await assert.rejects(inspect.inspectRealtimeTenants({ transport: {} }, { tenants: [A] }), /REALTIME_INSPECTION_REFUSED/);
      assert.equal(initialized, 0); assert.equal(acquired, 0);
      assert(beforeRead.detected > 0, 'THE_LEVEL_READ_COVERS_A_WATCHED_TENANT_WITH_NO_OUTPUT');
      pending = false; await rt.tick();
      assert(await until(() => rt.warm(A), 2000));
      const ready = await snapshot(); assert.equal(ready.tenants[0].ready, true);
      assert.equal(initialized, 1); assert.equal(acquired, 1);
      const connected = await connect(); assert.equal(connected.connected, true);
      let frames = 0; connected.socket.on('dataUpdate', () => { frames++; });
      let disconnectReason; connected.socket.once('disconnect', reason => { disconnectReason = reason; });
      connected.socket.emit('authorize', { token: 'synthetic-invalid-credential' });
      assert(await until(() => disconnectReason, 2000), 'INVALID_CREDENTIAL_MUST_CLOSE');
      assert.equal(disconnectReason, 'io server disconnect'); assert.equal(frames, 0);
      logger.flush();
      const captured = JSON.parse(lines.find(line => line.startsWith('realtime handshake refusals: ')).split('realtime handshake refusals: ')[1]);
      assert.equal('TENANT_WARMING' in captured.totals, false, 'a handshake is never refused for a tenant without a frame');
      for (const code of ['REALTIME_ORIGIN_REFUSED', 'SOCKET_ADMISSION_REFUSED', 'PLATFORM_VERIFICATION_REQUIRED', 'REALTIME_OWNER_UNAVAILABLE', 'REALTIME_WRONG_OWNER']) assert.equal(captured.totals[code], 1);
      assert(!JSON.stringify(captured).includes(A)); assert(!JSON.stringify(captured).includes('synthetic-invalid'));
    } finally {
      for (const socket of sockets) socket.close();
      if (logger) clearInterval(logger); protocol?.close(); await attached?.close();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await rt?.close(); await startup.close(); scope.setTenancyMode(previous);
      agent.destroy();
    }
  });
});
