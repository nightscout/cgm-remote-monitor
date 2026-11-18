'use strict';

// Component-private listener composition over actual UDS and loopback HTTP
// listeners: a fixed (method, path) route table of several service modules,
// per-operation media/byte/deadline bounds, and per-module lifetime policy.
// The operation window is the actual module over the recording PostgreSQL
// protocol fixture; this is not native PostgreSQL, process or network evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const Module = require('node:module');
const transport = require('../lib/server/internal-api/transport');
const contracts = require('../lib/server/internal-api/contracts');
const windowFixture = require('./fixtures/operation-window-runtime-protocol');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REQUEST = '00000000-0000-4000-8000-000000000001';
const TRANSPORT_FILE = require.resolve('../lib/server/internal-api/transport');
const HEALTH_WIRE_VERSION = String(contracts.roleHealth.version);

function mutated (mutate) {
  const source = fs.readFileSync(TRANSPORT_FILE, 'utf8'), changed = mutate(source);
  assert.notEqual(changed, source, 'Mutation marker must match actual transport source');
  const output = { exports: {} };
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: TRANSPORT_FILE })(
    Module.createRequire(TRANSPORT_FILE), output, output.exports);
  return output.exports;
}
async function unusedPort () {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function endpoint (kind, limits = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-compose-'));
  fs.chmodSync(directory, 0o700);
  const base = kind === 'uds' ? { socketPath: path.join(directory, 'component.sock') } : { url: 'http://127.0.0.1:' + await unusedPort(), trust: 'network' };
  return { options: { ...base, maxBytes: 4096, timeoutMs: 1000, ...limits }, directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function raw (options, requestPath, body, { service, version = '1', method = 'POST', contentType = 'application/json' } = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const target = options.socketPath ? { socketPath: options.socketPath } : { hostname: '127.0.0.1', port: new URL(options.url).port };
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, path: requestPath, method, headers: { 'content-type': contentType,
      'x-nightscout-internal-service': service, 'x-nightscout-internal-version': version } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(bytes);
  });
}
function refused (reply, label) {
  assert.equal(reply.status, 503, label);
  assert.deepEqual(JSON.parse(reply.body), { error: 'SOCKET_IPC_UNAVAILABLE' }, label);
}
// Recording application/lifecycle handlers against the actual checked-in contracts.
function recordingModules (calls) {
  return [
    { service: contracts.socketAuthority, create: () => ({
      async authorizeSocket (ctx, body) { calls.push(['authorize', body.tenant]); return { denied: true }; },
      async executeSocketMutation (ctx, body) { calls.push(['mutate', body.envelope.tenant]); return { replyArgs: [] }; } }) },
    { service: contracts.roleHealth, create: () => ({
      async getStatus (ctx, body) {
        calls.push(['status']);
        return { participant: 'api_1', roles: ['api'], ready: true, request: body.request };
      } }) }
  ];
}
const authorizeBody = tenant => ({ host: 'synthetic.example.test', tenant, namespace: '/', credential: {} });

for (const kind of ['uds', 'http']) describe('Composed component-private listener over ' + kind, function () {
  this.timeout(10000);
  it('serves two contracts from one explicit route table through their named clients', async function () {
    const e = await endpoint(kind); const calls = []; let listener;
    try {
      listener = await transport.compose(e.options, recordingModules(calls));
      assert.deepEqual(listener.routes, ['POST /authorize', 'POST /mutate', 'POST /role/health']);
      const authority = transport.client(e.options, contracts.socketAuthority);
      const lifecycle = transport.client(e.options, contracts.roleHealth);
      assert.deepEqual(await authority.authorizeSocket(authorizeBody(A)), { denied: true });
      assert.equal((await lifecycle.getStatus({ request: REQUEST })).request, REQUEST);
      assert.deepEqual(calls, [['authorize', A], ['status']]);
    } finally { if (listener) await listener.close(); e.cleanup(); }
  });
  it('refuses a request naming a foreign or unregistered service before dispatch', async function () {
    const e = await endpoint(kind); const calls = []; let listener;
    try {
      listener = await transport.compose(e.options, recordingModules(calls));
      // Registered elsewhere on this listener, but not the owner of the route.
      // Match the owning route's wire version so only the service fence refuses.
      refused(await raw(e.options, '/role/health', { request: REQUEST }, { service: 'socket-authority', version: HEALTH_WIRE_VERSION }), 'foreign co-resident service');
      refused(await raw(e.options, '/authorize', authorizeBody(A), { service: 'role-health' }), 'foreign co-resident service');
      // A real contract not composed here.
      refused(await raw(e.options, '/alarm', { request: REQUEST }, { service: 'alarm-delivery' }), 'unregistered service');
      refused(await raw(e.options, '/role/health', { request: REQUEST }, { service: 'alarm-delivery', version: HEALTH_WIRE_VERSION }), 'unregistered service');
      await assert.rejects(transport.client(e.options, contracts.alarmDelivery).deliverAlarm({ tenant: A, id: REQUEST, attempt: 1, notification: {}, receipts: [] }));
      refused(await raw(e.options, '/role/health', { request: REQUEST }, { service: 'role-health', version: HEALTH_WIRE_VERSION, method: 'GET' }), 'unregistered method');
      refused(await raw(e.options, '/role/health', { request: REQUEST }, { service: 'role-health', version: '0' }), 'old health wire version');
      assert.deepEqual(calls, [], 'No foreign or unregistered service may invoke a composed handler');
      assert.equal((await raw(e.options, '/role/health', { request: REQUEST }, { service: 'role-health', version: HEALTH_WIRE_VERSION })).status, 200);
      assert.deepEqual(calls, [['status']], 'Positive control reaches the route owner');
    } finally { if (listener) await listener.close(); e.cleanup(); }
  });
  it('refuses a duplicate method/path or duplicate service registration before binding', async function () {
    const e = await endpoint(kind);
    const colliding = { id: 'synthetic-colliding', version: 1, operations: {
      shadow: { path: '/role/health', request: { type: 'object' }, response: { type: 'object' } } } };
    try {
      for (const [modules, code] of [
        [[...recordingModules([]), { service: colliding, create: () => ({ async shadow () { return {}; } }) }], 'INTERNAL_API_ROUTE_DUPLICATE'],
        [[...recordingModules([]), recordingModules([])[1]], 'INTERNAL_API_SERVICE_DUPLICATE']
      ]) {
        let leaked;
        try {
          await assert.rejects(async () => { leaked = await transport.compose(e.options, modules); }, error => {
            assert.equal(error.code, code); assert(error instanceof TypeError); return true;
          });
        } finally { if (leaked) await leaked.close(); }
        if (kind === 'uds') assert.equal(fs.existsSync(e.options.socketPath), false, 'A refused composition must not publish an endpoint');
        else await assert.rejects(raw(e.options, '/role/health', { request: REQUEST }, { service: 'role-health', version: HEALTH_WIRE_VERSION }), { code: 'ECONNREFUSED' });
      }
    } finally { e.cleanup(); }
  });
});

describe('Composition registration rules', function () {
  it('refuses duplicate routes within one service and partial or foreign lifetime policies', function () {
    const op = { request: { type: 'object' }, response: { type: 'object' } };
    const base = { maxBytes: 1024, timeoutMs: 1000, admitted: () => true };
    assert.throws(() => transport.handler({ ...base, modules: [{ token: Symbol(), service: { id: 'synthetic-one', version: 1, operations: { a: { path: '/same', ...op }, b: { path: '/same', ...op } } },
      operations: { a: async () => ({}), b: async () => ({}) } }] }), { code: 'INTERNAL_API_ROUTE_DUPLICATE' });
    const service = { id: 'synthetic-one', version: 1, operations: { a: { path: '/a', ...op } } };
    for (const lifetime of [{ operationWindow: { run: async () => {} } }, { resolveTenant: async () => A }, { operationWindow: {}, resolveTenant: async () => A }, { operationWindow: { run () {} }, resolveTenant () {}, extra: true }]) {
      assert.throws(() => transport.handler({ ...base, modules: [{ token: Symbol(), service, operations: { a: async () => ({}) }, lifetime }] }), /lifetime requires tenant resolution/);
    }
    assert.throws(() => transport.handler({ ...base, service, operations: { a: async () => ({}) }, token: Symbol(), modules: [] }), { code: 'INTERNAL_API_COMPOSITION_INVALID' });
    assert.throws(() => transport.handler({ ...base, modules: [] }), { code: 'INTERNAL_API_COMPOSITION_INVALID' });
  });
  it('refuses unsupported per-operation methods, media types and bounds at registration', function () {
    const make = extra => ({ id: 'synthetic-one', version: 1, operations: { a: { path: '/a', request: { type: 'object' }, response: { type: 'object' }, ...extra } } });
    for (const extra of [{ method: 'GET' }, { method: 'post' }, { contentType: 'text/plain' }, { contentType: 'application/json; charset=utf-8' }, { maxBytes: 0 }, { timeoutMs: 1.5 }, { unknown: true }]) {
      assert.throws(() => transport.client({ socketPath: '/synthetic/a.sock', maxBytes: 1024, timeoutMs: 1000 }, make(extra)), /Invalid internal service operation/, JSON.stringify(extra));
    }
    assert.equal(typeof transport.client({ socketPath: '/synthetic/a.sock', maxBytes: 1024, timeoutMs: 1000 }, make({ method: 'POST', contentType: 'application/json', maxBytes: 10, timeoutMs: 10 })).a, 'function');
  });
  it('control: duplicate-route refusal goes red when the collision check is removed', async function () {
    const broken = mutated(source => source.replace(
      "      if (table.has(route)) registration('INTERNAL_API_ROUTE_DUPLICATE', route + ' (' + table.get(route).service.id + ', ' + service.id + ')');\n", ''));
    const colliding = { id: 'synthetic-colliding', version: 1, operations: { shadow: { path: '/role/health', request: { type: 'object' }, response: { type: 'object' } } } };
    async function check (implementation) {
      const e = await endpoint('uds'); let listener;
      try {
        await assert.rejects(async () => {
          listener = await implementation.compose(e.options, [...recordingModules([]), { service: colliding, create: () => ({ async shadow () { return {}; } }) }]);
        }, { code: 'INTERNAL_API_ROUTE_DUPLICATE' });
      } finally { if (listener) await listener.close(); e.cleanup(); }
    }
    await assert.rejects(check(broken), error => error.code === 'ERR_ASSERTION' && error.message === 'Missing expected rejection.');
    await check(transport);
  });
  it('control: co-resident foreign-service refusal goes red when the route owner fence is removed', async function () {
    const broken = mutated(source => source.replace("req.headers['x-nightscout-internal-service'] !== route.service.id || ", ''));
    async function check (implementation) {
      const e = await endpoint('uds'); const calls = []; let listener;
      try {
        listener = await implementation.compose(e.options, recordingModules(calls));
        refused(await raw(e.options, '/role/health', { request: REQUEST }, { service: 'socket-authority', version: HEALTH_WIRE_VERSION }), 'foreign co-resident service');
        assert.deepEqual(calls, []);
      } finally { if (listener) await listener.close(); e.cleanup(); }
    }
    await assert.rejects(check(broken), error => error.code === 'ERR_ASSERTION' && error.actual === 200 && error.expected === 503);
    await check(transport);
  });
});

describe('Per-operation media, byte and deadline bounds', function () {
  this.timeout(10000);
  const small = { type: 'object', additionalProperties: false, properties: { pad: { type: 'string' }, waitMs: { type: 'integer', minimum: 0, maximum: 5000 }, respondBytes: { type: 'integer', minimum: 0, maximum: 5000 } } };
  const reply = { type: 'object', additionalProperties: false, properties: { pad: { type: 'string' } } };
  const service = { id: 'synthetic-bounded', version: 1, operations: {
    tight: { path: '/tight', method: 'POST', contentType: 'application/json', maxBytes: 64, timeoutMs: 80, request: small, response: reply },
    loose: { path: '/loose', request: small, response: reply } } };
  function operations (calls) {
    const run = name => async (ctx, body) => {
      calls.push(name);
      if (body.waitMs) await new Promise(resolve => setTimeout(resolve, body.waitMs));
      return body.respondBytes ? { pad: 'x'.repeat(body.respondBytes) } : {};
    };
    return { tight: run('tight'), loose: run('loose') };
  }
  async function bounded (implementation, fn) {
    const e = await endpoint('http', { maxBytes: 1024, timeoutMs: 600 }); const calls = []; let listener;
    try {
      listener = await implementation.compose(e.options, [{ service, create: () => operations(calls) }]);
      await fn(e, calls, implementation.client(e.options, service));
    } finally { if (listener) await listener.close(); e.cleanup(); }
  }
  const pad = n => ({ pad: 'x'.repeat(n) });
  async function oversize (e, calls, client) {
    refused(await raw(e.options, '/tight', pad(100), { service: service.id }), 'request above operation bound');
    assert.deepEqual(calls, [], 'Oversized request must not reach the handler');
    assert.equal((await raw(e.options, '/loose', pad(100), { service: service.id })).status, 200, 'same bytes within listener bound on another operation');
    refused(await raw(e.options, '/tight', { respondBytes: 100 }, { service: service.id }), 'response above operation bound');
    await assert.rejects(client.tight(pad(100)));
    assert.deepEqual(calls, ['loose', 'tight'], 'Client must refuse an oversized request before sending');
    assert.deepEqual(await client.loose(pad(100)), {});
  }
  it('applies the operation byte bound to requests and responses at both ends', () => bounded(transport, oversize));
  it('applies the operation deadline independently of a longer listener deadline', () => bounded(transport, async (e, calls, client) => {
    const started = Date.now();
    await assert.rejects(client.tight({ waitMs: 300 }));
    assert(Date.now() - started < 250, 'operation deadline must be shorter than the handler delay');
    assert.deepEqual(await client.loose({ waitMs: 300 }), {}, 'listener deadline still admits a slower operation');
  }));
  it('requires the operation media type on requests and responses', () => bounded(transport, async (e, calls) => {
    for (const contentType of ['text/plain', 'application/json-seq', 'application/json; charset=latin1', 'application/json; charset=utf-8; extra=1', '']) {
      refused(await raw(e.options, '/tight', {}, { service: service.id, contentType }), contentType);
    }
    assert.deepEqual(calls, []);
    const ok = await raw(e.options, '/tight', {}, { service: service.id, contentType: 'application/json; charset=utf-8' });
    assert.equal(ok.status, 200); assert.equal(ok.type, 'application/json');
  }));
  it('client refuses a response whose media type differs from the operation type', async function () {
    const e = await endpoint('http');
    const server = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json-seq' }); res.end('{}'); });
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(new URL(e.options.url).port), '127.0.0.1', resolve); });
      await assert.rejects(transport.client(e.options, service).loose({}));
    } finally { await new Promise(resolve => server.close(resolve)); e.cleanup(); }
  });
  it('control: byte bound test goes red when operation bounds are replaced by the listener bound', async function () {
    const broken = mutated(source => source.replace(
      'return { maxBytes: Math.min(opts.maxBytes, operation.maxBytes || Infinity), timeoutMs: Math.min(opts.timeoutMs, operation.timeoutMs || Infinity) };',
      'return { maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs };'));
    await assert.rejects(bounded(broken, oversize), error => error.code === 'ERR_ASSERTION' && error.actual === 200 && error.expected === 503);
    await bounded(transport, oversize);
  });
});

async function lifecycleLab (implementation, kind = 'uds') {
  // The fixture reads options.phases on every lifecycle-window query.
  const options = { phases: {} }, f = windowFixture(options);

  const e = await endpoint(kind);
  const app = [], held = new Map();
  const listener = await implementation.compose(e.options, [
    { service: contracts.socketAuthority, lifetime: { operationWindow: f.window, resolveTenant: async body => body.tenant || body.envelope.tenant }, create: () => ({
      async authorizeSocket (ctx, body) {
        f.window.assertCurrent(body.tenant); app.push(['authorize', body.tenant]);
        if (held.has(body.tenant)) await held.get(body.tenant).promise;
        return { denied: true };
      },
      async executeSocketMutation () { return { replyArgs: [] }; } }) },
    recordingModules([])[1]
  ]);
  const hold = tenant => { let release; const promise = new Promise(resolve => { release = resolve; }); held.set(tenant, { promise }); return () => { held.delete(tenant); release(); }; };
  return { f, e, app, hold,
    authority: transport.client(e.options, contracts.socketAuthority),
    lifecycle: transport.client(e.options, contracts.roleHealth),
    suspend: tenant => { options.phases[tenant] = 'suspended'; },
    async close () { try { await listener.close(); await f.window.close(); } finally { e.cleanup(); } } };
}

describe('Per-module generation scope on a composed listener', function () {
  this.timeout(10000);
  for (const kind of ['uds', 'http']) {
    it('keeps role health and B callable while suspended A refuses over ' + kind, async function () {
      const lab = await lifecycleLab(transport, kind);
      try {
        assert.deepEqual(await lab.authority.authorizeSocket(authorizeBody(A)), { denied: true });
        lab.suspend(A);
        await assert.rejects(lab.authority.authorizeSocket(authorizeBody(A)), /SOCKET_IPC_UNAVAILABLE/);
        assert.deepEqual(await lab.authority.authorizeSocket(authorizeBody(B)), { denied: true });
        assert.equal((await lab.lifecycle.getStatus({ request: REQUEST })).request, REQUEST);
        assert.deepEqual(lab.app, [['authorize', A], ['authorize', B]]);
      } finally { await lab.close(); }
    });
  }
  it('serves role health during a held tenant response', async function () {
    const lab = await lifecycleLab(transport);
    const release = lab.hold(A);
    try {
      const pending = lab.authority.authorizeSocket(authorizeBody(A));
      while (!lab.app.length) await new Promise(resolve => setImmediate(resolve));
      assert.equal((await lab.lifecycle.getStatus({ request: REQUEST })).ready, true);
      release();
      assert.deepEqual(await pending, { denied: true });
    } finally { release(); await lab.close(); }
  });
});

for (const kind of ['uds','http']) describe('Bounded realtime inspection over '+kind, function () {
  it('uses existing role ownership and transport trust, and refuses wrong service/version/body before observation', async function () {
    const e=await endpoint(kind),internal=require('../lib/server/serve/internal-listener');let opened,reads=0,alarmCalls=0,available=false,mismatch=false,retired=false;
    const ownership={cached(){reads++;return {count:1,ordinal:0,rule:require('../lib/pool-membership/slice').RULE};}};
    const make=require('../lib/server/serve/realtime-inspection')({processIncarnation:B,ownership,owner:()=>available,quiescing:()=>false,startup:{isReady:t=>t===A},modelWarm:t=>t===A});
    const binding={create(token){const ops=make(token);return{...ops,async inspectRealtime(request){const result=await ops.inspectRealtime(request);return retired?{...result,placement:{assignmentIncarnation:A}}:result;},async inspectRealtimeTenants(request,body){const result=await ops.inspectRealtimeTenants(request,body);if(mismatch)result.tenants.reverse();return result;}};}};
    try {
      const rows=internal.plan(['realtime'],{realtimePreview:{maxMessageBytes:4096,operationTimeoutMs:1000,ownership:{},completedOutput:{}}});
      assert.equal(contracts.realtimeInspection.version,5);assert.deepEqual(rows.map(row=>row.id),['alarm-delivery','completed-output','realtime-inspection']);
      opened=await internal.open({listen:e.options,shutdownTimeoutMs:1000},rows);
      assert.throws(()=>opened.bind('evaluator',{'realtime-inspection':binding}),{code:'INTERNAL_API_CONTRACT_UNOWNED'});
      opened.bind('realtime',{'completed-output':{create:()=>({hintCompletedOutput:async()=>({accepted:true})})},'alarm-delivery':{create:()=>({deliverAlarm:async()=>{alarmCalls++;return {accepted:true,receipt:null,clearedRequestIds:[]};}})},'realtime-inspection':binding});opened.assertBound();
      for(const value of [await raw(e.options,'/realtime/inspect',{}, {service:'alarm-delivery'}),await raw(e.options,'/realtime/inspect',{}, {service:'realtime-inspection',version:'1'}),await raw(e.options,'/realtime/inspect',{}, {service:'realtime-inspection',version:'2'}),await raw(e.options,'/realtime/inspect',{}, {service:'realtime-inspection',version:'4'}),await raw(e.options,'/realtime/inspect',{tenant:A}, {service:'realtime-inspection',version:'3'})])refused(value,'fixed private RT observation');
      assert.equal(reads,0,'rejected requests never observe cached state');
      const alarm={tenant:A,id:REQUEST,attempt:1,notification:{},receipts:[]};refused(await raw(e.options,'/alarm',alarm,{service:'alarm-delivery',version:'2'}),'legacy alarm wire');assert.equal(alarmCalls,0);await require('../lib/server/internal-api/clients').alarmDelivery(e.options).deliverAlarm(alarm);assert.equal(alarmCalls,1);
      const client=require('../lib/server/internal-api/clients').realtimeInspection(e.options),reply=await client.inspectRealtime({});
      assert.equal(reply.processIncarnation,B);assert.deepEqual(reply.ownership,{count:1,ordinal:0,rule:require('../lib/pool-membership/slice').RULE});assert.equal(Object.hasOwn(reply,'placement'),false);assert.equal(reply.ownerAvailable,false);assert.equal(reply.observation,'cached-not-lock-proof');assert.equal(reads,1);
      // An actual old placement field in a response must fail the closed
      // current wire; restoring the static ownership response must pass.
      retired=true;await assert.rejects(client.inspectRealtime({}),{message:'SOCKET_IPC_UNAVAILABLE'});retired=false;assert.deepEqual((await client.inspectRealtime({})).ownership,reply.ownership);
      const before=reads;for(const body of [{tenants:[A,A]},{tenants:[A],unknown:true},{tenants:['00000000-0000-0000-0000-000000000000']}])refused(await raw(e.options,'/realtime/inspect-tenants',body,{service:'realtime-inspection',version:String(contracts.realtimeInspection.version)}),'bounded readiness selector');refused(await raw(e.options,'/realtime/inspect-tenants',{tenants:[A]},{service:'realtime-inspection',version:'2'}),'old readiness wire');assert.equal(reads,before);
      available=true;const selected=await client.inspectRealtimeTenants({tenants:[A,B]});assert.deepEqual(selected.tenants.map(row=>[row.tenant,row.ready]),[[A,true],[B,false]]);assert.equal(selected.observation,'cached-readiness-not-lock-or-data-freshness-proof');mismatch=true;await assert.rejects(client.inspectRealtimeTenants({tenants:[A,B]}),{code:'REALTIME_INSPECTION_SELECTION_MISMATCH'});
    }finally{await opened?.close();e.cleanup();}
  });
});
