'use strict';
// Spike S2: APIv3 `/storage` live events from the api's post-commit hint, with
// no storage-event journal. Synthetic tenants and documents only.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const factory = require('../lib/server/realtime/protocol');
const hints = require('../lib/server/realtime/storage-hint');
const control = require('./lib/clinical-working-set/control');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';

class Socket extends EventEmitter {
  constructor (host = 'a.test') { super(); this.id = host + Math.random(); this.rooms = new Set([this.id]); this.request = { headers: { host }, socket: {} }; this.sent = []; }
  emit (event, value) { this.sent.push({ event, value }); return true; }
  join (room) { this.rooms.add(room); } leave (room) { this.rooms.delete(room); }
  disconnect () { this.disconnected = true; super.emit('disconnect'); }
  async receive (event, ...args) { await Promise.all(this.listeners(event).map(fn => fn(...args))); }
}
// The restore generation per tenant, read inside an operation as the lifecycle
// window does (lib/tenant-lifecycle/generation-scope.js currentGeneration).
function windowFor (generations) {
  const store = new AsyncLocalStorage();
  return { generations, run: (tenant, fn) => store.run({ tenant, generation: generations.get(tenant) }, fn),
    currentGeneration (tenant) { const s = store.getStore(); if (!s || s.tenant !== tenant) throw new Error('LIFECYCLE_WINDOW_REQUIRED'); return String(s.generation); } };
}
function realtime ({ module = factory, operationWindow } = {}) {
  let held = false;
  const protocol = module.create({ operationWindow, admission: { resolve: async req => req.headers.host === 'b.test' ? B : A },
    api: { authorizeSocket: async () => { if (held) throw new Error('temporarily unavailable'); return { permissions: { read: true, write: false, write_treatment: false, ack: false }, collections: ['food', 'entries'] }; }, executeSocketMutation: async () => {} },
    readCurrent: async () => ({ identity: 'same' }), runtime: () => ({}), domains: ['food', 'entries'], retry: { minMs: 5, maxMs: 20 } });
  return { protocol, set held (v) { held = v; },
    async socket (host = 'a.test', collections) { const socket = new Socket(host); await protocol.prepare(socket); protocol.bind(socket, '/storage'); let answer; await socket.receive('subscribe', collections ? { collections } : {}, v => { answer = v; }); assert.equal(answer.success, true); return socket; } };
}
const hint = (tenant, generation, events) => ({ kind: hints.KIND, tenant, generation, events });

describe('spike S2: /storage from the api post-commit hint (realtime side)', function () {
  it('delivers create/update/delete in the single-tenant wire shape, by collection, tenant-isolated, live from subscribe', async function () {
    const w = windowFor(new Map([[A, 1], [B, 1]])), r = realtime({ operationWindow: w });
    try {
      // Nothing before subscribe is replayed (single tenant: storageSocket.js:114-138).
      await r.protocol.storageHint(hint(A, '1', [{ event: 'create', colName: 'food', doc: { identifier: 'before' } }]));
      const a = await r.socket('a.test'), onlyEntries = await r.socket('a.test', ['entries']), b = await r.socket('b.test');
      await r.protocol.storageHint(hint(A, '1', [{ event: 'create', colName: 'food', doc: { identifier: 'x', name: 'synthetic' } },
        { event: 'update', colName: 'food', doc: { identifier: 'x', name: 'renamed' } }, { event: 'delete', colName: 'food', identifier: 'x' }]));
      assert.deepEqual(a.sent, [{ event: 'create', value: { colName: 'food', doc: { identifier: 'x', name: 'synthetic' } } },
        { event: 'update', value: { colName: 'food', doc: { identifier: 'x', name: 'renamed' } } }, { event: 'delete', value: { colName: 'food', identifier: 'x' } }]);
      assert.deepEqual(onlyEntries.sent, [], 'COLLECTION_FILTER');
      assert.deepEqual(b.sent, [], 'TENANT_ISOLATION');
    } finally { r.protocol.close(); }
  });
  function staleCheck (module) {
    return async () => {
      const w = windowFor(new Map([[A, 1]])), r = realtime({ module, operationWindow: w });
      try {
        const a = await r.socket();
        w.generations.set(A, 2); // restore completed between the api's commit and delivery
        await r.protocol.storageHint(hint(A, '1', [{ event: 'create', colName: 'food', doc: { identifier: 'pre-restore' } }]));
        assert.deepEqual(a.sent, [], 'STALE_GENERATION_HINT_MUST_NOT_BE_DELIVERED');
        await r.protocol.storageHint(hint(A, '2', [{ event: 'create', colName: 'food', doc: { identifier: 'post-restore' } }]));
        assert.equal(a.sent.length, 1);
      } finally { r.protocol.close(); }
    };
  }
  it('drops a pre-restore waiting document and opens the local receiver outside the writer operation', async () => {
    const w=windowFor(new Map([[A,1]])), r=realtime({operationWindow:w}), writerContext=new AsyncLocalStorage();
    let release, count=0;
    const first=new Promise(resolve=>{release=resolve;});
    const route=hints.transport({}, {local:async(tenant, fields)=>{
      assert.equal(writerContext.getStore(), undefined);
      if (++count===1) await first;
      return hints.receive(tenant,fields,r.protocol.storageHint);
    }});
    try {
      const socket=await r.socket();
      const send=(generation,id)=>writerContext.run(A,()=>route.deliver(hint(A,generation,[{event:'create',colName:'food',doc:{identifier:id}}])));
      send('1','inflight-old'); send('1','queued-old');
      w.generations.set(A,2); send('2','current');
      release();
      for(let i=0;i<30&&!socket.sent.length;i++) await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(socket.sent.map(x=>x.value.doc.identifier),['current']);
      assert.equal(route.stats().merged,1);
    } finally { release(); await route.close(); r.protocol.close(); }
  });
  it('recovers an over-bound batch on the subscribed collection only and ignores an unbound generation', async () => {
    const w = windowFor(new Map([[A, 1], [B, 1]])), r = realtime({operationWindow: w});
    const owner = (tenant, fields) => hints.receive(tenant, fields, r.protocol.storageHint);
    const transport = hints.transport({}, {local: owner});
    try {
      const subscribed = await r.socket(), elsewhere = await r.socket('b.test'), unselected = await r.socket('a.test', ['entries']);
      const change = {event: 'create', colName: 'food', doc: {identifier:'test', pad:'x'.repeat(262144)}};
      transport.deliver({tenant:A, generation:'1', events:[change]});
      await new Promise(resolve => setImmediate(resolve));
      await transport.close();
      assert(subscribed.disconnected, 'overflow did not retire subscribed client');
      assert(!elsewhere.disconnected && !unselected.disconnected);
      assert.deepEqual(subscribed.sent, []);
      await owner(A, {events:[{op:'create', collection:'entries', doc:{identifier:'unbound'}}]});
      assert.deepEqual(unselected.sent, []);
    } finally { await transport.close(); r.protocol.close(); }
  });
  it('RED/restored control: a hint with a stale restore generation is not delivered', async function () {
    const broken = control('../lib/server/realtime/protocol', 'if (operationWindow?.currentGeneration && String(operationWindow.currentGeneration(tenant)) !== String(generation))', 'if (false)');
    await assert.rejects(staleCheck(broken)(), /STALE_GENERATION_HINT_MUST_NOT_BE_DELIVERED/);
    await staleCheck(factory)();
  });
  it('a socket held while its authority is uncertain is disconnected (re-sync over REST), not silently skipped', async function () {
    const w = windowFor(new Map([[A, 1]])), r = realtime({ operationWindow: w });
    try {
      const a = await r.socket(); r.held = true; await r.protocol.recheckTenant(A);
      await r.protocol.storageHint(hint(A, '1', [{ event: 'create', colName: 'food', doc: { identifier: 'missed' } }]));
      assert(a.disconnected, 'HELD_SOCKET_MUST_DISCONNECT');
      assert.equal(r.protocol.stats?.().disconnects?.REALTIME_STORAGE_CONTINUITY_LOST ?? 1, 1);
    } finally { r.protocol.close(); }
  });
  it('refuses a malformed hint', async function () {
    const r = realtime({ operationWindow: windowFor(new Map([[A, 1]])) });
    try { await assert.rejects(r.protocol.storageHint({ tenant: A, events: [] }), /REALTIME_STORAGE_HINT_CONTRACT/); } finally { r.protocol.close(); }
  });
});

// End to end in one process: actual APIv1/APIv3 handlers and PostgreSQL writes
// through lib/server/serve/preview-domains, the hint, and the realtime protocol.
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
optInSuite(process.env.NS_S2_STORAGE_HINT_PG_TEST === '1' && !!uri, 'NS_S2_STORAGE_HINT_PG_TEST=1 with a disposable NS_TEST_POSTGRES_ADMIN_URI')('spike S2: api write paths to /storage (PostgreSQL)', function () {
  this.timeout(60000);
  const express = require('express'), shiro = require('shiro-trie'), { Client } = require('pg');
  const authentication = require('../lib/api3/tenant-authentication'), environment = require('../lib/server/tenant-app/environment');
  const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'], ns = 's2_' + process.pid;
  let admin, connection, mode;
  before(async function () {
    mode = scope.getTenancyMode(); scope.setTenancyMode('multi');
    const { run } = require('../lib/migrations/postgres');
    for (const d of domains) await run('up', { direct: true, connectionString: uri, namespace: ns + '_' + d, catalogue: require('../migrations/candidates/postgres-' + d + '-v1.json') });
    await run('up', { direct: true, connectionString: uri, namespace: ns + '_clock', catalogue: require('../migrations/candidates/postgres-write-clock-v1.json') });
    admin = new Client({ connectionString: uri }); await admin.connect();
    for (const t of [A, B]) await admin.query('INSERT INTO "' + ns + '_clock".tenant_write_clock (tenant_id,last_stamp) VALUES ($1,$2)', [t, Date.now()]);
    const role = ns + '_app', password = require('node:crypto').randomBytes(16).toString('hex');
    await admin.query('DROP ROLE IF EXISTS "' + role + '"');
    await admin.query('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD \'' + password + '\'');
    for (const d of domains) { await admin.query('GRANT USAGE ON SCHEMA "' + ns + '_' + d + '" TO "' + role + '"'); await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "' + ns + '_' + d + '" TO "' + role + '"'); }
    await admin.query('GRANT USAGE ON SCHEMA "' + ns + '_clock" TO "' + role + '"'); await admin.query('GRANT SELECT, UPDATE(last_stamp, last_delete_stamp) ON "' + ns + '_clock".tenant_write_clock TO "' + role + '"');
    const url = new URL(uri); url.username = role; url.password = password;
    connection = await require('../lib/storage/postgres-connection')({ connectionString: url.toString(), max: 4 });
  });
  after(async function () {
    for (const d of [...domains, 'clock']) await admin?.query('DROP SCHEMA IF EXISTS "' + ns + '_' + d + '" CASCADE');
    await connection?.close?.(); await admin?.query('DROP ROLE IF EXISTS "' + ns + '_app"'); await admin?.end(); scope.setTenancyMode(mode);
  });
  async function stack ({ previewModule = require('../lib/server/serve/preview-domains'), deliver } = {}) {
    const w = windowFor(new Map([[A, 1], [B, 1]])), r = realtime({ operationWindow: w });
    const delivered = [];
    const sender = hints.sender({ currentGeneration: t => w.currentGeneration(t), deliver: async h => {
      // Post-commit: the written row is visible to another session when the hint leaves.
      const visible = h.events[0].event === 'delete' ? null : (await admin.query('SELECT count(*)::int AS n FROM "' + ns + '_' + h.events[0].colName + '".' + h.events[0].colName + " WHERE tenant_id=$1 AND doc->>'identifier'=$2", [h.tenant, h.events[0].doc.identifier])).rows[0].n;
      delivered.push({ hint: h, visible });
      return deliver ? deliver(h, r) : r.protocol.storageHint(h);
    } });
    const graph = await previewModule({ config: { domains, legacyEnabled: true, namespaces: Object.fromEntries(domains.map(d => [d, ns + '_' + d])),
      bindings: new Map([[A, {}], [B, {}]]), environments: new Map([[A, environment()], [B, environment()]]) },
    connection: require('../lib/storage/postgres-write-clock')(connection, ns + '_clock'), exchange: async () => null, storageHint: sender });
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { const tenant = req.headers['x-test-tenant']; req.tenantContext = { tenant }; const rights = shiro.new(); rights.add('*'); authentication.bind(req, { shiros: [rights] }); req.tenantAuthenticate = async () => authentication.bind(req, { shiros: [rights] }); scope.withTenant(tenant, () => w.run(tenant, next)); });
    app.use('/api/v3', graph.data); app.use('/api/v1', graph.legacyRouter);
    const call = (tenant, method, url, body) => new Promise((resolve, reject) => {
      const req = new http.IncomingMessage(new PassThrough()), text = body === undefined ? '' : JSON.stringify(body);
      req.method = method; req.url = url; req.headers = { accept: 'application/json', 'x-test-tenant': tenant, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) };
      const res = new http.ServerResponse(req);
      res.end = function (v) { this.finished = true; this.emit('finish'); resolve({ status: this.statusCode, body: v && String(v) }); };
      app(req, res, e => e ? reject(e) : resolve({ status: 404 }));
      setImmediate(() => { if (text) req.push(text); req.push(null); });
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));
    return { r, w, call, settle, delivered, sender };
  }
  const food = (identifier, name) => ({ identifier, date: 1793664000000, utcOffset: 0, app: 'synthetic-s2', name, carbs: 10 });
  let run = 0;
  async function v3Lifecycle (s) {
    const id = 's2-food-' + (++run), hard = 's2-hard-' + run;
    const a = await s.r.socket('a.test'), b = await s.r.socket('b.test');
    assert.equal((await s.call(A, 'POST', '/api/v3/food', food(id, 'apple'))).status, 201); await s.settle();
    assert.equal((await s.call(A, 'PUT', '/api/v3/food/' + id, food(id, 'pear'))).status, 200); await s.settle();
    assert.equal((await s.call(A, 'PATCH', '/api/v3/food/' + id, { carbs: 12 })).status, 200); await s.settle();
    assert.equal((await s.call(A, 'POST', '/api/v3/food', food(id, 'pear'))).status, 200, 'deduplicated POST answers 200'); await s.settle();
    assert.equal((await s.call(A, 'DELETE', '/api/v3/food/' + id)).status, 200); await s.settle(); // soft delete: isValid false
    assert.equal((await s.call(A, 'POST', '/api/v3/food', food(hard, 'plum'))).status, 201); await s.settle();
    assert.equal((await s.call(A, 'DELETE', '/api/v3/food/' + hard + '?permanent=true')).status, 200); await s.settle();
    return { a, b };
  }
  it('APIv3 create, replace, patch, deduplicated POST, soft and permanent delete reach a /storage subscriber after commit', async function () {
    const s = await stack(), { a, b } = await v3Lifecycle(s);
    assert.deepEqual(a.sent.map(e => e.event + ':' + (e.value.doc?.identifier ?? e.value.identifier)),
      ['create:s2-food-1', 'update:s2-food-1', 'update:s2-food-1', 'update:s2-food-1', 'delete:s2-food-1', 'create:s2-hard-1', 'delete:s2-hard-1'], 'V3_STORAGE_EVENTS_REQUIRED');
    assert.equal(a.sent[1].value.doc.name, 'pear'); assert.equal(a.sent[2].value.doc.carbs, 12);
    assert.deepEqual(b.sent, [], 'TENANT_ISOLATION');
    assert(s.delivered.filter(d => d.visible !== null).every(d => d.visible === 1), 'HINT_AFTER_COMMIT');
    assert(s.delivered.every(d => d.hint.generation === '1'));
    require('node:fs').writeFileSync(process.env.NS_S2_EVIDENCE || '/dev/null', JSON.stringify({ wire: a.sent, hints: s.delivered.length }, null, 1));
  });
  for (const mode of ['local', 'private HTTP']) it('serves APIv3 writes and stock socket recovery over ' + mode, async function () {
    const fs = require('node:fs'), tmp = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 's4-storage-'));
    const socketPath = require('node:path').join(tmp, 'private.sock');
    const server = http.createServer();
    let route, listener, attached, client, receive;
    try {
      const s = await stack({deliver: h => route.deliver(h)});
      receive = (tenant, fields) => hints.receive(tenant, fields, s.r.protocol.storageHint);
      if (mode === 'private HTTP') {
        const internal = require('../lib/server/serve/internal-listener');
        listener = await internal.open({listen:{socketPath}, shutdownTimeoutMs:2500},
          internal.plan(['realtime'], {realtimePreview:{maxMessageBytes:4096,operationTimeoutMs:1000}}), {operationWindow:s.w});
        listener.bind('realtime', {
          'alarm-delivery':{resolveTenant:body=>body.tenant,create:()=>({deliverAlarm:async()=>({accepted:true})})},
          'storage-events':{owns:t=>t===A, receive}
        });
        listener.assertBound();
      }
      route = hints.transport({NS_REALTIME_INTERNAL_SOCKET:socketPath}, mode==='local'?{local:receive}:{});
      attached = require('../lib/server/realtime/socket-server').attach(server, {protocol:s.r.protocol,
        admission:{resolve:async()=>A}, maxMessageBytes:1048576});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      client = require('socket.io-client').io('http://127.0.0.1:'+server.address().port+'/storage',
        {autoConnect:false, transports:['websocket'], reconnectionDelay:10, randomizationFactor:0});
      const once = event => new Promise(resolve=>client.once(event,resolve));
      const subscribed = () => new Promise((resolve,reject)=>client.emit('subscribe',{collections:['food']},
        value=>value?.success?resolve():reject(Error('storage subscribe failed'))));
      const connected = once('connect'); client.connect(); await connected; await subscribed();
      const wire = [];
      for(const event of ['create','update','delete'])client.on(event,value=>wire.push({event,value}));
      const {a} = await v3Lifecycle(s);
      assert.equal(wire.length,7);
      assert.deepEqual(wire,a.sent);
      for(const {event,value} of wire) assert.deepEqual(Object.keys(value).sort(),
        event==='delete'?['colName','identifier']:['colName','doc']);
      assert.equal(wire[6].value.identifier,wire[5].value.doc.identifier);
      assert.match(wire[6].value.identifier,/^s2-hard-/);
      assert.equal(route.stats().accepted,7);
      assert(s.delivered.every(d=>d.visible===null||d.visible===1));
      const lost=once('disconnect'), reconnected=once('connect');
      route.deliver({tenant:A,generation:'1',events:[{event:'update',colName:'food',doc:{pad:'x'.repeat(262144)}}]});
      assert.notEqual(await lost,'io server disconnect', 'stock auto-reconnect disabled');
      await reconnected; await subscribed();
      assert.equal(wire.length,7, 'overflow sent a malformed public event');
      const after=once('create');
      const fresh='s4-reconnect-'+run;
      await s.call(A,'POST','/api/v3/food',food(fresh,'new'));
      assert.equal((await after).doc.identifier,fresh);
    } finally {
      client?.close(); await route?.close(); await attached?.close(); await listener?.close();
      fs.rmSync(tmp,{recursive:true,force:true});
    }
  });
  it('RED/restored control: with the api hint removed, a /storage subscriber receives nothing', async function () {
    const broken = control('../lib/server/serve/preview-domains', 'if (storageHint) storageHint.attach(bus, tenant);', '');
    await assert.rejects((async () => { const s = await stack({ previewModule: broken }), { a } = await v3Lifecycle(s); assert.equal(a.sent.length, 7, 'V3_STORAGE_EVENTS_REQUIRED'); })(), /V3_STORAGE_EVENTS_REQUIRED/);
    const s = await stack(), { a } = await v3Lifecycle(s); assert.equal(a.sent.length, 7);
  });
  it('a hint written before a restore is not delivered after it (stale generation, end to end)', async function () {
    const queued = [], s = await stack({ deliver: h => { queued.push(h); } });
    const a = await s.r.socket('a.test');
    assert.equal((await s.call(A, 'POST', '/api/v3/food', food('s2-stale', 'fig'))).status, 201); await s.settle();
    assert.equal(queued.length, 1); assert.equal(queued[0].generation, '1');
    s.w.generations.set(A, 2);
    assert.deepEqual(await s.r.protocol.storageHint(queued[0]), { accepted: false, stale: true });
    assert.deepEqual(a.sent, []);
  });
  it('parity: APIv1 writes emit no /storage event, as in single tenant', async function () {
    const s = await stack(), a = await s.r.socket('a.test');
    const v1 = await s.call(A, 'POST', '/api/v1/food', [{ name: 's2-v1', carbs: 3, created_at: '2026-11-20T00:00:00.000Z' }]); await s.settle();
    assert.equal(v1.status, 200, v1.body);
    const entry = await s.call(A, 'POST', '/api/v1/entries', [{ type: 'sgv', sgv: 123, date: 1793664000000, dateString: '2026-11-03T00:00:00.000Z' }]); await s.settle();
    assert.equal(entry.status, 200, entry.body);
    assert.deepEqual(a.sent, [], 'V1_EMITS_NO_STORAGE_EVENT');
    assert.equal(s.delivered.length, 0);
  });
});
