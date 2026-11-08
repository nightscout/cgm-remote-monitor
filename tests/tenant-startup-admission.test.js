'use strict';

// Actual gate and runtime/boot composition, recording dependencies only: no PG,
// listeners, Docker or cross-process acceptance is implied.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const startup = require('../lib/server/serve/tenant-startup');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const realtime = require('../lib/server/realtime/runtime');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function load (relative, overrides) {
  const filename = path.resolve(__dirname, '..', relative), local = createRequire(filename);
  const sandbox = { module: { exports: {} }, setInterval: () => { throw new Error('SOURCE_TEST_TIMER_FORBIDDEN'); }, clearInterval: () => {}, console: {log () {}}, require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, {filename}); return sandbox.module.exports;
}

describe('independent tenant startup admission (source protocol)', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
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
    for (const options of [{key:'99'}, {superuser:true}, {phase:'suspended',unlock:false}]) {
      const f=fixture(options); try { await assert.rejects(startup.attempt(f.window,A,async()=>{})); } finally { await f.window.close(); }
    }
    const options={}, f=fixture(options); await f.window.ready(); options.datastore={database_oid:'999'};
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
  it('actual API boot defers roots/dates and exposes lazy initializer to both HTTP and private socket composition', async function () {
    const options={phases:{[A]:'suspended'}},f=fixture(options),reads=[],calls={},resources=[];
    const resource=extra=>{const r={end:async()=>{},...extra};resources.push(r);return r;};
    const authority=resource({authorize:async({tenant})=>{reads.push(['authority',tenant]);}});
    const boot=load('lib/server/serve/preview-api.js',{
      '../../storage/postgres-connection':async()=>resource(),
      '../../secrets/legacy-postgres':async()=>resource({read:async tenant=>{reads.push(['root',tenant]);return {reference:{id:'synthetic'}};}}),
      '../../tenant-authorization/postgres':async()=>authority,
      '../../secrets/postgres':{createPostgresSecrets:async()=>resource({store:{get:async()=>({})}})},
      '../../secrets/component':{createSecrets:()=>({})},
      './postgres-domains':{readiness:async()=>{},assertServing:async()=>({ensure:async tenant=>reads.push(['floor',tenant]),invalidateTenant:()=>{}})},
      './preview-domains':async()=>({initializeTenant:async tenant=>reads.push(['dates',tenant]),data:()=>{},safeRoutes:{}}),
      '../tenant-app/exchange':()=>()=>{},'../tenant-app/data-access':()=>()=>{},
      '../tenant-app':{createTenantApp:input=>{calls.http=input.prepareTenant;return (req,res,next)=>next();}},
      '../realtime/private-api':{boot:async input=>{calls.socket=input.prepareTenant;return {close:async()=>{}};}}
    });
    let role;try{
      role=await boot.boot({bindings:new Map([[A,{}],[B,{}]]),providers:new Map(),namespaces:{},socketForwarding:true},{operationWindow:f.window});
      assert.deepEqual(reads.map(row=>row[1]),[B,B,B,B],'API_A_NO_ROOT_FLOOR_DATE_READS');
      options.phases[A]='active';await f.window.run(A,()=>calls.http(A));await f.window.run(A,()=>calls.socket(A));
      assert.equal(reads.filter(row=>row[1]===A).length,4);
      await role.invalidateTenant(A);await f.window.run(A,()=>calls.socket(A));assert.equal(reads.filter(row=>row[1]===A).length,8);
    }finally{if(role)await role.close();await f.window.close();}
  });
  it('actual evaluator boot preserves shared failures, initializes B and checks deferred A before resumed component creation', async function () {
    const options={phases:{[A]:'suspended'}},f=fixture(options),reads=[],provisioned=[];
    const evaluator=()=>({evaluate:async()=>({checkpoint:1}),evaluateTime:async()=>({checkpoint:1}),close:()=>{}});evaluator.domains=[];
    const readiness=Object.assign(async()=>{}, {provisionTenant:async(connection,config,tenant)=>{f.window.assertCurrent(tenant);provisioned.push(tenant);}});
    const boot=load('lib/server/serve/evaluator-preview.js',{
      '../../storage/postgres-connection':async()=>({end:async()=>{}}), './evaluator-readiness':readiness,
      '../../storage/postgres-durable-replay':()=>({}), '../../data/tenant-projection-evaluator':evaluator,
      './evaluator-consumers':{prepare:async()=>null}
    });
    const config={tenants:new Map([[A,true],[B,true]]),namespaces:{},recoveryIntervalMs:100,timeIntervalMs:100,
      schedule:()=>1,cancel:()=>{},readCurrent:async tenant=>{reads.push(tenant);return {tenant,identity:'a'.repeat(64),env:{settings:{language:'en'}}};}};
    let role;try{
      role=await boot.boot(config,{operationWindow:f.window});
      assert.deepEqual(provisioned,[B]);assert.equal(reads.includes(A),false,'EVALUATOR_A_NO_INITIAL_CONFIG_OR_DATA');
      assert.equal(role.health().tenants.find(row=>row.tenant===B).ready,true);
      options.phases[A]='active';await role.acquire(A);assert.deepEqual(provisioned,[B,A]);
      assert.equal(await f.window.run(A,()=>role.last(A).eligible),true);
      await role.close();role=null;options.phases[A]='suspended';options.phases[B]='suspended';
      readiness.provisionTenant=async()=>{throw new Error('should not enter paused tenant');};
      role=await boot.boot(config,{operationWindow:f.window});assert.equal(role.health().tenants.some(row=>row.ready),false);
      await role.close();role=null;
    }finally{if(role)await role.close();await f.window.close();}
    const failed=load('lib/server/serve/evaluator-preview.js',{'./evaluator-readiness':async()=>{throw new Error('bad shared metadata');}});
    await assert.rejects(failed.boot(config),/readiness or initialization refused/);
  });
  it('actual consumer prepare uses metadata-only sameDB challenge and screens shared ACL even with every tenant paused', async function () {
    for (const fault of [null,'outbox','suppression','datastore']) {
      const f=fixture({phase:'suspended'}),zero='00000000-0000-0000-0000-000000000000',events=[];
      let held=null;
      const connection=owner=>({end:async()=>{},transaction:async fn=>fn(),snapshotTransaction:async fn=>fn(),query:async text=>{
        assert.equal(scope.requireTenant('challenge'),zero,'DATASTORE_CHALLENGE_NOT_FIRST_TENANT');
        if(text.includes('datastore-owner')){held=true;events.push('challenge');return {rows:[]};}
        if(text.includes('datastore-challenge'))return {rows:[{acquired:fault==='datastore'||!held}]};
        throw new Error('unexpected query '+owner);
      }});
      const clinical=connection('clinical'),outbox=connection('outbox'),suppression=connection('suppression');let opened=0;
      const guards={...require('../lib/server/serve/evaluator-consumer-readiness'),suppression:async()=>{events.push('suppression');if(fault==='suppression')throw new Error('bad suppression ACL');}};
      const prepare=load('lib/server/serve/evaluator-consumers.js',{
        '../../storage/postgres-connection':async()=>opened++?suppression:outbox,
        '../../tenant-notifications/readiness':async()=>{events.push('outbox');if(fault==='outbox')throw new Error('bad outbox schema');},
        './evaluator-consumer-readiness':guards,
        '../../tenant-notifications/postgres':()=>({ready:async()=>{throw new Error('PAUSED_TENANT_STORE_ENTERED');}}),
        '../../tenant-alarms/postgres':{createReader:()=>({read:async()=>{throw new Error('PAUSED_TENANT_READER_ENTERED');}})},
        '../../tenant-notifications/producer':()=>({select:async()=>{},close:()=>{}}),
        '../../tenant-notifications/component':()=>({retry:async()=>({results:[]}),close:async()=>{}}),
        '../realtime/alarm-transport':{createAdapter:()=>({send:()=>{}})}
      });
      const selected={outbox:{namespace:'synthetic_outbox'},suppression:{namespace:'synthetic_suppression'},route:{id:'synthetic'},pollIntervalMs:100,retryIntervalMs:100};
      let consumer;try{
        const promise=prepare.prepare({config:{consumers:{realtime:selected},tenants:new Map([[A,true],[B,true]]),readCurrent:async()=>null},clinicalConnection:clinical,
          current:()=>null,isCurrent:async()=>false,operationWindow:f.window});
        if(fault)await assert.rejects(promise,/bad outbox schema|bad suppression ACL|READINESS_REFUSED/);
        else {consumer=await promise;assert.deepEqual(events,['outbox','suppression','challenge']);}
      }finally{if(consumer)await consumer.close();await f.window.close();}
    }
  });

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
