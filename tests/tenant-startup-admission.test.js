'use strict';

// Actual gate and runtime/boot composition, recording dependencies only: no PG,
// listeners, Docker or cross-process acceptance is implied.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const startup = require('../lib/server/serve/tenant-startup');
const nativeBoot = require('./fixtures/evaluator-native-recovery-protocol');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const realtime = require('../lib/server/realtime/runtime');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function load (relative, overrides, transform = source => source, timers = {}) {
  const filename = path.resolve(__dirname, '..', relative), local = createRequire(filename);
  const sandbox = { process: {env:process.env}, module: { exports: {} }, setInterval: timers.setInterval || (() => { throw new Error('SOURCE_TEST_TIMER_FORBIDDEN'); }), clearInterval: timers.clearInterval || (() => {}), console: {log () {}}, require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) };
  vm.runInNewContext(transform(fs.readFileSync(filename, 'utf8')), sandbox, {filename}); return sandbox.module.exports;
}

describe('independent tenant startup admission (source protocol)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  for (const keepParent of [false, true]) it(`gives queued default background warm its own window with ${keepParent ? 'active' : 'expired'} request parent`, async function () {
    const f = fixture(), calls = [];
    let enter, release, releaseRequest;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const requestHeld = new Promise(resolve => { releaseRequest = resolve; });
    const ready = startup.create([], f.window, async tenant => {
      f.window.assertCurrent(tenant); calls.push(tenant);
      if (tenant === A) { enter(); await held; f.window.assertCurrent(A); }
    }, {readiness:'serve', concurrency:1, accept:tenant => tenant === A || tenant === B, alert:()=>{}, drainedLog:()=>{}});
    let request;
    try {
      request = f.window.run(A, async () => {
        await assert.rejects(ready.admit(A), {code:'TENANT_WARMING'});
        await entered;
        if (keepParent) await requestHeld;
      });
      await entered;
      if (!keepParent) await request;
      await f.window.run(B, () => assert.rejects(ready.admit(B), {code:'TENANT_WARMING'}));
      release(); await ready.drained();
      assert.deepEqual(calls, [A,B], 'QUEUED_BACKGROUND_GETS_FRESH_TENANT_WINDOW');
      assert.equal(ready.health().failed, 0); assert.equal(ready.isReady(A), true); assert.equal(ready.isReady(B), true);
      await assert.rejects(ready.ensure(B), {code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});
      await assert.rejects(f.window.run(A, () => ready.ensure(B)), {code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});
    } finally { release(); releaseRequest(); await request; await ready.close(); await f.window.close(); }
  });
  it('closing default background startup drops queued work without ending the active tenant window', async function () {
    const f = fixture(), calls = [];
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
    const ready = startup.create([A,B], f.window, async tenant => {
      calls.push(tenant); enter(); await held; f.window.assertCurrent(tenant);
    }, {readiness:'serve', concurrency:1, alert:()=>{}, drainedLog:()=>{}});
    try {
      await ready.warm(); await entered;
      await ready.close(); await ready.close(); release(); await ready.drained();
      assert.deepEqual(calls, [A]); assert.equal(ready.isReady(A), true); assert.equal(ready.isReady(B), false);
      assert.equal(ready.health().failed, 0);
    } finally { release(); await ready.close(); await f.window.close(); }
  });
  it('refuses creating a background scheduler inside a request context', async function () {
    const f = fixture();
    try {
      await assert.rejects(f.window.run(A, async () => startup.create([], f.window, async()=>{})),
        error => ['COLD_START_AMBIENT_SCOPE','LIFECYCLE_WINDOW_AMBIENT_SCOPE'].includes(error.code));
    } finally { await f.window.close(); }
  });
  it('defers only genuine suspended A and initializes it on later actual admission, including invalidation', async function () {
    const options = { phases: {[A]: 'suspended'} }, f = fixture(options), calls = [];
    const ready = startup.create([A,B], f.window, async tenant => { f.window.assertCurrent(tenant); calls.push(tenant); });
    try {
      assert.deepEqual(await ready.warm(), [false,true]); assert.deepEqual(calls,[B], 'SUSPENDED_A_HAS_NO_WARMUP');
      await assert.rejects(ready.ensure(A), {code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});
      await assert.rejects(f.window.run(A, () => ready.ensure(A)), {code:'LIFECYCLE_WINDOW_SUSPENDED'});
      options.phases[A] = 'active'; // models explicit operator activation, not an implementation write
      await f.window.run(A, () => ready.ensure(A)); await f.window.run(A, () => ready.ensure(A));
      assert.deepEqual(calls,[B,A]); ready.invalidateTenant(A);
      await f.window.run(A, () => ready.ensure(A)); assert.deepEqual(calls,[B,A,A]);
      assert.equal(f.log.some(([sql]) => typeof sql === 'string' && /SET phase|SET generation|DELETE FROM/.test(sql)),false);
    } finally { await f.window.close(); }
  });
  it('hard refuses wrong binding, wrong datastore, metadata failure, fake window and application code lookalikes', async function () {
    // Session unlocks retired; genuine suspension is covered as a deferral above.
    for (const options of [{key:'99'}]) {
      const f=fixture(options); try { await assert.rejects(startup.attempt(f.window,A,async()=>{})); }
      finally { await f.window.close(); }
    }
    const options={}, f=fixture(options); await f.window.ready();
    // A connection cannot change databases in place. Model a new physical backend.
    options.datastore={database_oid:'999'}; f.client.processID=124; options.sqlPid=124;
    try { await assert.rejects(startup.attempt(f.window,A,async()=>{}),{code:'LIFECYCLE_WINDOW_DATASTORE_CHANGED'}); }
    finally { await f.window.close(); }
    await assert.rejects(startup.attempt({run:async()=>{}},A,async()=>{}),/Actual operation window/);
    const g=fixture(); try {
      await assert.rejects(startup.attempt(g.window,A,async()=>{throw Object.assign(new Error('application failure'),{code:'LIFECYCLE_WINDOW_SUSPENDED'});}),/application failure/);
      await assert.rejects(startup.attempt(g.window,A,async()=>{throw new Error('generic startup failure');}),/generic startup failure/);
    } finally { await g.window.close(); }
    await assert.rejects(startup.attempt(undefined,A,async()=>{throw new Error('strict single tenant');}),/strict single tenant/);
  });
  it('boots actual realtime with suspended A, keeps B progress and retries A on activation; all paused retains control liveness', async function () {
    for (const allPaused of [false,true]) {
      const options={phases:{[A]:'suspended',...(allPaused?{[B]:'suspended'}:{})}}, f=fixture(options), calls=[];
      let rt;
      try {
        rt=await realtime({tenants:[A,B],operationWindow:f.window,readCurrent:async tenant=>{calls.push(tenant);return {tenant,identity:'current'};},
          create:current=>({acquire:async()=>({tenant:current.tenant,checkpoint:1})}),fanout:async()=>{},recoveryIntervalMs:100,schedule:()=>1,cancel:()=>{}});
        assert.equal(calls.includes(A),false,'REALTIME_SUSPENDED_A_NO_CONFIG_OR_DATA');
        assert.equal(rt.health().live,true); assert.equal(rt.health().ready,false);
        assert.equal(rt.health().tenants.find(row=>row.tenant===B).ready,!allPaused);
        assert.equal(rt.last(A),null); assert.equal(await f.window.run(B,()=>rt.last(B)).catch(()=>null)!==null,!allPaused);
        options.phases[A]='active'; await rt.refresh(A);
        assert.equal(await f.window.run(A,()=>rt.last(A).checkpoint),1);
      } finally { if(rt)await rt.close(); await f.window.close(); }
    }
  });
  it('preserves actual realtime startup hard failure for ordinary acquisition errors with and without a window', async function () {
    const f=fixture(); try {
      for(const operationWindow of [undefined,f.window]) await assert.rejects(realtime({tenants:[A],operationWindow,
        readCurrent:async()=>{throw new Error('broken shared dependency');},create:()=>{},fanout:async()=>{},recoveryIntervalMs:100,schedule:()=>1,cancel:()=>{}}),/broken shared dependency/);
    } finally { await f.window.close(); }
  });
  it('actual API boot exposes inline preparation to HTTP and private sockets without warming the roster (NS_TENANT_READINESS=all)', async function () {
    const previous=process.env.NS_TENANT_READINESS;process.env.NS_TENANT_READINESS='all';
    try{await apiBootAll();}finally{if(previous===undefined)delete process.env.NS_TENANT_READINESS;else process.env.NS_TENANT_READINESS=previous;}
  });
  async function apiBootAll () {
    const options = { phases: { [A]: 'suspended' } }, f = fixture(options), reads = [], calls = {};
    const resource = extra => ({ end: async () => {}, ...extra });
    const boot = load('lib/server/serve/preview-api.js', {
      '../../storage/connection-admission': { coldAdmission: () => { throw Error('API_MUST_NOT_USE_COLD_SCHEDULER'); }, wrapClient: Client => Client },
      './tenant-startup': { create: () => { throw Error('API_MUST_NOT_BUILD_WARM_QUEUE'); } },
      '../../storage/postgres-connection': async () => resource(),
      '../../secrets/legacy-postgres': async () => resource({ read: async () => { throw Error('NO_WARM_ROOT_PROBE'); } }),
      '../../tenant-authorization/postgres': async () => resource({ authorize: async () => { throw Error('NO_WARM_AUTHORITY_PROBE'); } }),
      '../../secrets/postgres': { createPostgresSecrets: async () => resource({ store: { get: async () => ({}) } }) },
      '../../secrets/component': { createSecrets: () => ({}) },
      './platform-verification': require('./fixtures/platform-proof')(),
      './tenant-floor-verification': { createReader: () => async tenant => { reads.push(['verified-floor', tenant]); } },
      './preview-domains': async () => ({ prepareTenant: async tenant => reads.push(['build', tenant]), invalidateTenant: tenant => reads.push(['invalidate', tenant]), invalidateAll () {}, data: () => {}, safeRoutes: {} }),
      '../tenant-app/exchange': () => () => {}, '../tenant-app/data-access': () => () => {},
      '../tenant-app': { createTenantApp: input => { calls.http = input.prepareTenant; return (req, res, next) => next(); } },
      '../realtime/private-api': { boot: async input => { calls.socket = input.prepareTenant; return { close: async () => {} }; } }
    });
    let role;
    try {
      role = await boot.boot({ bindings: new Map([[A, {}], [B, {}]]), providers: new Map(), namespaces: { clock: 'synthetic_clock' }, socketForwarding: true }, { operationWindow: f.window });
      assert.deepEqual(reads, [], 'API_BOOT_MUST_NOT_SCAN_OR_WARM_TENANTS');
      await assert.rejects(f.window.run(A, () => calls.http(A)));
      assert.deepEqual(reads, [], 'SUSPENDED_TENANT_MUST_NOT_BUILD');
      options.phases[A] = 'active';
      await f.window.run(A, () => calls.http(A));
      await f.window.run(A, () => calls.socket(A));
      assert.deepEqual(reads.map(row => row[0]), ['verified-floor', 'build', 'verified-floor']);
      await role.invalidateTenant(A);
      await f.window.run(A, () => calls.socket(A));
      assert.deepEqual(reads.slice(-2).map(row => row[0]), ['invalidate', 'verified-floor']);
    } finally { if (role) await role.close(); await f.window.close(); }
  }
  it('evaluator ignores all-tenant warmup and admits only addressed work within its tenant window', async function () {
    const previous=process.env.NS_TENANT_READINESS;process.env.NS_TENANT_READINESS='all';
    try{await evaluatorBootAll();}finally{if(previous===undefined)delete process.env.NS_TENANT_READINESS;else process.env.NS_TENANT_READINESS=previous;}
  });
  async function evaluatorBootAll () {
    const options={phases:{[A]:'suspended'}},f=fixture(options),reads=[],provisioned=[],nativeEvents=[];
    const evaluator=()=>({evaluate:async()=>({checkpoint:1}),evaluateTime:async()=>({checkpoint:1}),close:()=>{}});evaluator.domains=[];
    const readiness=Object.assign(async()=>{}, {provisionTenant:async(connection,config,tenant)=>{f.window.assertCurrent(tenant);provisioned.push(tenant);}});
    const entries=new Map([A,B].map(tenant=>[tenant,{tenant,identity:'a'.repeat(64),env:{settings:{language:'en'}}}]));
    const metadata=new Map([A,B].map(tenant=>[tenant,{settings:1,policy:1,activity:{state:'active'},signature:{stamp:1,deleted:0}}]));
    const scan=async()=>metadata;scan.state=()=>({available:true,generation:1});
    const reader={scan,current:tenant=>metadata.get(tenant),state:scan.state,health:()=>({available:true}),close:async()=>{}};
    const registry={tenants:entries,lookup:async tenant=>entries.get(tenant),isActive:tenant=>entries.has(tenant),onRemove(){},close:async()=>{},revision:()=>1,stats:()=>({})};
    const store={admit:async()=>{},observeMany:async()=>{},work:async()=>[],nextDue:async()=>null,deliveries:async()=>[],begin:async()=>({clock:'1'}),complete:async(tenant,value)=>({output:{tenant,identity:value.identity,contentDigest:'d'.repeat(64),outputRevision:1,result:value.result},changed:true})};
    const boot=load('lib/server/serve/evaluator-preview.js',{
      ...nativeBoot.mocks({events:nativeEvents}),
      '../../storage/postgres-connection':async()=>({end:async()=>{}}), './platform-verification': require('./fixtures/platform-proof')(), './evaluator-readiness':readiness,
      '../../storage/postgres-durable-replay':()=>nativeBoot.replay({events:nativeEvents}), '../../data/tenant-projection-evaluator':evaluator,
      './registry-tenant-set':{openDemand:async()=>registry},
      './evaluator-config':{registryEntry:tenant=>entries.get(tenant),withSettings:async(base,entry,tenant)=>{reads.push(tenant);return entries.get(tenant);}},
      '../../pool-membership':{member:async()=>({configured:{mode:'standalone'},register:async()=>{},close:async()=>{}})},
      './evaluator-pool':{create:()=>({partitioned:false,start(){},refresh:async()=>{},admits:()=>true,addTenant(){},close(){}})},
      '../../trusted-worker/postgres':{create:()=>reader},'../../trusted-worker/lifecycle':async()=>({version:()=>1,activateRefresh(){},close:async()=>{}}),
      '../../pgstream/evaluator':{open:async()=>({store,ready:async()=>{},assertAvailable(){},close:async()=>{},health:()=>({})})},
      // Exercise the actual common scheduler; it now owns durable startup.
      '../../pgstream/activity-scheduler':require('../lib/pgstream/activity-scheduler'),
      '../internal-api/clients':{completedOutput:()=>({})},
      './evaluator-consumers':{prepare:async()=>null}
    });
    const config={registry:{namespace:'synthetic_registry'},trustedWorker:{activity:'synthetic_activity'},pgstream:nativeBoot.config({bounds:{recoveryMs:1000,pendingMs:1000},outputPeer:{}}),maxTenants:2,maxRows:10,maxBytes:10000,pageSize:1,
      namespaces:{clock:'synthetic_clock',checkpoint:'synthetic_checkpoint'},consumer:'evaluator-test',timeIntervalMs:100,
      schedule:()=>1,cancel:()=>{}};
    let role;try{
      role=await boot.boot(config,{operationWindow:f.window});
      assert.deepEqual(provisioned,[]);assert.deepEqual(reads,[]);
      await role.acquire(B);assert.deepEqual(provisioned,[B]);
      assert.equal(role.health().tenants.find(row=>row.tenant===B).ready,true);
      options.phases[A]='active';await role.acquire(A);assert.deepEqual(provisioned,[B,A]);
      assert.equal(await f.window.run(A,()=>role.last(A).eligible),true);
      await role.close();role=null;options.phases[A]='suspended';options.phases[B]='suspended';
      readiness.provisionTenant=async()=>{throw new Error('should not enter paused tenant');};
      role=await boot.boot(config,{operationWindow:f.window});assert.equal(role.health().tenants.some(row=>row.ready),false);
      await role.close();role=null;
      for(const event of ['identify-created','identify-closed','native-recovery-created','native-recovery-closed','native-configured'])assert.equal(nativeEvents.filter(value=>value===event).length,2,'BOTH_BOOT_GENERATIONS_CLOSE_NATIVE_PORTS:'+event);
    }finally{if(role)await role.close();await f.window.close();}
    const failed=load('lib/server/serve/evaluator-preview.js',{'./registry-tenant-set':{openDemand:async()=>registry},'./platform-verification': require('./fixtures/platform-proof')(), './evaluator-readiness':async()=>{throw new Error('bad shared metadata');}});
    const shared=fixture({phase:'suspended'});
    try{await assert.rejects(failed.boot(config,{operationWindow:shared.window}),/readiness or initialization refused/);}
    finally{await shared.window.close();}
  }

  it('actual HTTP window middleware waits for lazy initialization and refuses suspended A without entering routes', async function () {
    const {EventEmitter}=require('node:events'),create=require('../lib/server/tenant-app').createTenantApp;
    const f=fixture({phases:{[A]:'suspended'}}),events=[];
    const unsupported={read:async()=>{},replace:async()=>{},rollback:async()=>{}};
    const app=create({resolver:{resolve:async req=>req.headers.host==='a.test'?A:B},operationWindow:f.window,
      prepareTenant:async tenant=>{f.window.assertCurrent(tenant);events.push(['initialize',tenant]);},
      verifyCredential:async()=>null,authorizeRequest:async()=>false,tenantSettings:unsupported,subjectPolicy:unsupported,
      dataRouter:(req,res)=>{events.push(['data',req.tenantContext.tenant]);res.json({ok:true});},dataAccess:async({tenant})=>({tenant,principal:'synthetic',consumer:'source'})});
    async function request(host){
      const req=new EventEmitter();Object.assign(req,{method:'GET',url:'/api/v3/entries',headers:{host},rawHeaders:['Host',host],socket:{}});
      const res=new EventEmitter(),headers={};res.statusCode=200;res.setHeader=(key,value)=>{headers[key.toLowerCase()]=value;};res.getHeader=key=>headers[key.toLowerCase()];
      res.removeHeader=key=>delete headers[key.toLowerCase()];res.end=value=>{res.body=value;res.finished=true;res.emit('finish');};res.destroy=()=>{res.destroyed=true;res.emit('close');};
      await new Promise((resolve,reject)=>{res.once('finish',resolve);res.once('error',reject);app.handle(req,res,error=>error?reject(error):reject(new Error('unhandled route')));});
      return res;
    }
    try{
      assert.equal((await request('a.test')).statusCode,503);assert.deepEqual(events,[],'HTTP_PAUSED_A_NO_INIT_OR_DATA');
      assert.equal((await request('b.test')).statusCode,200);assert.deepEqual(events,[['initialize',B],['data',B]],'HTTP_INITIALIZE_BEFORE_DATA');
    }finally{await f.window.close();}
  });

  it('coalesces initializer work and rejects stale completion after invalidation without marking the next generation ready', async function () {
    const f=fixture();let enter,release,calls=0;
    const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
    const ready=startup.create([A],f.window,async()=>{calls++;if(calls===1){enter();await held;}});
    const pending=f.window.run(A,()=>Promise.all([ready.ensure(A),ready.ensure(A)]));
    try{
      await entered;assert.equal(calls,1);ready.invalidateTenant(A);release();
      await assert.rejects(pending,/startup invalidated/);
      await f.window.run(A,()=>ready.ensure(A));assert.equal(calls,2,'INVALIDATED_INITIALIZER_RERUN');
    }finally{release();await f.window.close();}
  });

  it('preserves actual resolver refusals before the API3 parser when lazy startup has no window', async function () {
    const {EventEmitter}=require('node:events'),{Readable}=require('node:stream');
    const create=require('../lib/server/tenant-app').createTenantApp,resolve=require('../lib/tenant-resolution');
    const direct=resolve({aliases:[{host:'a.test',tenant:A}]}),canonical=resolve({mode:'canonical-internal',
      aliases:[{host:'a.test',tenant:A}],internalNames:[{host:'tenant-0.internal.test',tenant:A}],
      trustedProxy:req=>req.socket.remoteAddress==='127.0.0.2'});
    const unsupported={read:async()=>{},replace:async()=>{},rollback:async()=>{}};
    async function request({resolver=direct,host='a.test',extra={},prepare=true,unavailable=false,json}={}) {
      const events=[];
      const app=create({resolver,prepareTenant:prepare?async tenant=>{events.push(['initialize',tenant]);if(unavailable)throw new Error('synthetic startup unavailable');}:undefined,
        verifyCredential:async()=>null,authorizeRequest:async()=>false,tenantSettings:unsupported,subjectPolicy:unsupported,
        dataAccess:async({tenant})=>({tenant,principal:'synthetic',consumer:'source'}),dataRouter:(req,res)=>{events.push(['data',req.tenantContext.tenant]);res.json({ok:true});}});
      const headers={host,...extra,...(json===undefined?{}:{'content-type':'application/json','content-length':String(Buffer.byteLength(json))})};
      const req=new Readable({autoDestroy:false,read(){this.push(json===undefined?null:json);this.push(null);}});
      Object.assign(req,{method:json===undefined?'GET':'POST',url:'/api/v3/entries',headers,
        rawHeaders:Object.entries(headers).flat(),socket:{remoteAddress:'127.0.0.1'}});
      const res=new EventEmitter(),recorded={};res.statusCode=200;res.setHeader=(key,value)=>{recorded[key.toLowerCase()]=value;};res.getHeader=key=>recorded[key.toLowerCase()];
      res.removeHeader=key=>delete recorded[key.toLowerCase()];res.end=value=>{res.body=JSON.parse(String(value));res.finished=true;res.emit('finish');};
      await new Promise((done,reject)=>{res.once('finish',done);res.once('error',reject);app.handle(req,res,error=>reject(error||new Error('unhandled route')));});
      return {status:res.statusCode,body:res.body,events};
    }
    for(const prepare of [false,true]) {
      const unknown=await request({host:'unknown.test',prepare});
      assert.deepEqual(unknown,{status:404,body:{error:'TENANT_REFUSED'},events:[]},'UNKNOWN_HOST_PRESERVES_404');
      for(const options of [{extra:{'x-forwarded-host':'a.test'}},{resolver:canonical,host:'tenant-0.internal.test',extra:{'x-forwarded-for':'127.0.0.2'}}]) {
        assert.deepEqual(await request({...options,prepare}),{status:400,body:{error:'TENANT_REFUSED'},events:[]},'UNTRUSTED_SELECTOR_PRESERVES_400');
      }
    }
    assert.deepEqual(await request({unavailable:true}),{status:503,body:{error:'AUTHORITY_UNAVAILABLE'},events:[['initialize',A]]});
    assert.deepEqual(await request(),{status:200,body:{ok:true},events:[['initialize',A],['data',A]]});
    // The existing API3 parser owns malformed JSON behavior. Lazy admission must
    // not change that downstream response or reinterpret its parser errors.
    const malformed=[];
    for(const prepare of [false,true]) {const response=await request({prepare,json:'{'});malformed.push({status:response.status,body:response.body});}
    assert.equal(malformed[0].status,500);assert.deepEqual(malformed[1],malformed[0]);
  });

});
