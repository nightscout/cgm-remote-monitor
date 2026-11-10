'use strict';
// Source protocol controls; recording SQL/role constructors are not native evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const roles = ['api', 'evaluator', 'realtime', 'tenant-admin'];
function load (relative, overrides, mutate = s => s) {
  const file = path.resolve(__dirname, relative), output = {exports:{}};
  const original = require('node:module').createRequire(file);
  vm.runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(file, 'utf8')) + '\n})', {filename:file})(
    name => Object.hasOwn(overrides, name) ? overrides[name] : original(name), output, output.exports);
  return output.exports;
}
async function setup ({ mutate, boot } = {}) {
  const f = fixture(), invalidations = [], observed = [{pid:123,role:'synthetic_worker',birth:'1700000000.000001'}];
  let released = false;
  const lower = {...require('../lib/storage/postgres-connection'),installOperationWindow: () => () => { released = true; }, cohortBackends: () => observed,cohortDatastore:() => f.window.datastore};
  const module = load('../lib/server/serve/operation-cohort.js', {
    '../../storage/postgres-connection':lower,
    pg:{Client:class { constructor () { assert.fail('Census must use the passed operator client'); } },Pool:class { constructor () { assert.fail('Census must not create a pool'); } }},
    ...Object.fromEntries(['preview-api','evaluator-preview','preview-realtime','owner-preview'].map((name,i) => ['./' + name, {
      boot: boot || (async () => ({close:async () => {},invalidateTenant:async tenant => invalidations.push([roles[i],tenant])}))
    }]))
  }, mutate);
  const cohort = await module.create({window:f.window,names:roles,tenants:[A,B],namespaces:['clinical','outbox','suppression']});
  return {f,module,cohort,invalidations,observed,get released () { return released; }, async complete () {
    for (const role of roles) await cohort.boot(role,{tenantIds:[A,B]}); cohort.complete();
  }};
}
describe('Actual operation cohort composition source protocol', function () {
  it('requires actual complete constructors, matching tenants and unique pending role boots', async function () {
    let finish; const wait = new Promise(resolve => { finish = resolve; });
    const s = await setup({boot:async () => { await wait; return {close:async () => {},invalidateTenant:async () => {}}; }});
    try {
      assert.throws(() => s.cohort.complete(), {code:'RESTORE_COHORT_INCOMPLETE'});
      await assert.rejects(s.cohort.boot('api',{tenantIds:[A]}),{code:'RESTORE_COHORT_TENANT_MISMATCH'});
      await assert.rejects(s.cohort.boot('api',{tenantIds:[A,B],consumers:{outbox:{namespace:'unobserved'}}}),{code:'RESTORE_COHORT_NAMESPACE_MISMATCH'});
      assert.deepEqual(s.module.protectedNamespaces({namespaces:{entries:'clinical'},consumers:{outbox:{namespace:'outbox'},suppression:{namespace:'suppression'}}}),['clinical','outbox','suppression']);
      const pending = s.cohort.boot('api',{tenantIds:[A,B]});
      await assert.rejects(s.cohort.boot('api',{tenantIds:[A,B]}),{code:'RESTORE_COHORT_CONFIGURATION'});
      finish(); await pending;
    } finally { finish(); await s.cohort.close(); }
  });
  async function censusCheck (mutate) {
    const s = await setup({mutate}); await s.complete();
    const actors = [{...s.observed[0],application_name:'unrelated-label'}];
    const client = {async query (sql, values) {
      if (sql === 'SELECT ' + require('../lib/storage/postgres-connection').datastoreSQL) return {rows:[s.f.window.datastore]};
      if (sql === 'SELECT pg_catalog.pg_stat_clear_snapshot()') return {rows:[{}]};
      assert(sql.includes('restore-cohort-actors'),'Unexpected census SQL');
      assert.deepEqual(values,[['clinical','outbox','suppression']]); return {rows:actors};
    }};
    try {
      assert.equal((await s.module.assertComplete(s.cohort,A,{client})).backends,1);
      for (const change of [{pid:124},{birth:'1700000000.000002'},{role:'other_worker'},{birth:null}]) {
        actors[0] = {...s.observed[0],application_name:'nightscout-evaluator-preview',...change};
        await assert.rejects(s.module.assertComplete(s.cohort,A,{client}),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});
      }
      await s.module.invalidate(s.cohort,A);
      assert.deepEqual(s.invalidations,roles.map(role => [role,A]));
      assert.equal(s.invalidations.some(row => row[1] === B),false);
    } finally { await s.cohort.close(); assert.equal(s.released,true); }
  }
  async function cachedActivityCheck (mutate) {
    const s=await setup({mutate});await s.complete();
    const copy=rows=>structuredClone(rows),trace=[],pending=[];
    let current=copy(s.observed),cached=null;
    const client={async query(sql,values){
      assert.equal(this,client,'SAME_PASSED_OPERATOR_CLIENT');
      if(sql==='SELECT '+require('../lib/storage/postgres-connection').datastoreSQL)return {rows:[s.f.window.datastore]};
      if(sql==='SELECT pg_catalog.pg_stat_clear_snapshot()'){
        const record={kind:'refresh',settled:false};trace.push(record);
        const done=new Promise(resolve=>setImmediate(()=>{cached=null;record.settled=true;resolve({rows:[{}]});}));pending.push(done);return done;
      }
      assert(sql.includes('restore-cohort-actors'),'No transaction/connection/clinical SQL is permitted in the census');
      assert.deepEqual(values,[['clinical','outbox','suppression']]);trace.push({kind:'actors'});
      if(cached===null)cached=copy(current);return {rows:copy(cached)};
    }};
    try{
      assert.equal((await s.module.assertComplete(s.cohort,A,{client})).backends,1);
      // A genuine registered actor retired: current database and peer map agree
      // on absence, but this transaction's earlier activity snapshot retains it.
      current=[];s.observed.length=0;
      assert.equal((await s.module.assertComplete(s.cohort,A,{client})).backends,0);
      // A newly unregistered actor cannot hide in the previously empty cache.
      current=[{pid:999,role:'unregistered_worker',birth:'1700000001.000001'}];
      await assert.rejects(s.module.assertComplete(s.cohort,A,{client}),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});
      current=[];assert.equal((await s.module.assertComplete(s.cohort,A,{client})).backends,0);
      assert.equal(trace.length,8);
      for(let i=0;i<trace.length;i+=2){assert.deepEqual(trace[i],{kind:'refresh',settled:true});assert.deepEqual(trace[i+1],{kind:'actors'});}
    }finally{await Promise.all(pending);await s.cohort.close();}
  }
  it('refreshes cached retired/new actors on the same operator before each strict comparison',()=>cachedActivityCheck());
  it('detects omitted refresh and passes fresh restored source',async function(){
    await assert.rejects(cachedActivityCheck(s=>s.replace("await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');",'')),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});
    await cachedActivityCheck();
  });
  it('awaits refresh completion; a started but unawaited clear remains red',async function(){
    await assert.rejects(cachedActivityCheck(s=>s.replace("await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');","void client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');")),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});
    await cachedActivityCheck();
  });
  it('propagates same-client refresh refusal before any actor query',async function(){
    const s=await setup();await s.complete();const refusal=new Error('synthetic statistics refresh refusal');let actorQueries=0;
    const client={async query(sql){assert.equal(this,client);if(sql==='SELECT '+require('../lib/storage/postgres-connection').datastoreSQL)return {rows:[s.f.window.datastore]};if(sql==='SELECT pg_catalog.pg_stat_clear_snapshot()')throw refusal;actorQueries++;assert.fail('Actor query must not follow failed refresh');}};
    try{await assert.rejects(s.module.assertComplete(s.cohort,A,{client}),error=>error===refusal);assert.equal(actorQueries,0);}finally{await s.cohort.close();}
  });
  it('matches PID, birth and database role, never an application label; invalidates A only', () => censusCheck());
  it('detects a broken census comparison and passes the restored source', async function () {
    await assert.rejects(censusCheck(s => s.replace("if (!row || !actor.birth || row.birth !== actor.birth || row.role !== actor.role)", 'if (false)')), /Missing expected rejection/);
    await censusCheck();
  });
});
describe('Explicit operation cohort configuration', function () {
  it('defaults off and rejects duplicate locks, unsafe namespaces and absent environment references', function () {
    const config = require('../lib/server/serve/operation-cohort-config');
    assert.equal(config.load({}),null);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'cohort-config-')), file = path.join(dir,'config.json');
    const original = {version:1,namespace:'synthetic_window',connectionEnv:'SYNTHETIC_PG',locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}]};
    const source = {MULTITENANT_OPERATION_CONFIG:file,SYNTHETIC_PG:'postgresql://synthetic:synthetic@127.0.0.1/disposable_test'};
    try {
      fs.writeFileSync(file,JSON.stringify(original)); const selected = config.load(source);
      assert.equal(Object.isFrozen(selected.locks[0]),true); assert.equal(selected.poolOptions.max,8);
      for (const change of [v => { v.locks[1].key='17'; },v => { v.namespace='public'; },v => { v.namespace='pg_shadow'; },v => { v.connectionEnv='ABSENT'; },v => { v.extra=true; }]) {
        const value = structuredClone(original); change(value); fs.writeFileSync(file,JSON.stringify(value)); assert.throws(() => config.load(source), /invalid explicit/);
      }
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
});

describe('Selected evaluator control-table read admission', function () {
  it('allows only a branded physically admitted window and retains unrelated-write refusal', async function () {
    const f = fixture();
    const {screen} = load('../lib/server/serve/evaluator-readiness.js', {
      '../../storage/postgres-insertion-readiness':{isOrderedCatalogue:() => false}
    });
    const domains = require('../lib/data/tenant-projection-evaluator').domains;
    const config = {namespaces:Object.fromEntries([...domains,'clock','checkpoint'].map(d => [d,'clinical_'+d]))};
    let forbiddenWrite = false;
    const client = {async query (sql, values) {
      if (sql.includes('operation-window-')) return f.client.query(sql,values);
      if (sql.includes('rolsuper,rolbypassrls,rolcreaterole')) return {rows:[{rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,operator:false}]};
      if (sql.includes('WITH identities')) return {rows:[{creates:false,unrelated:forbiddenWrite || !values[1].includes('synthetic_window.tenant_lifecycle_windows')}]};
      return {rows:[{secured:true,reads:true,forbidden:false,updates:values[0].endsWith('checkpoint'),bookkeeping:true,extra:false}]};
    }};
    try {
      await assert.rejects(screen(client,config),/unsafe evaluator scope/);
      await assert.rejects(screen(client,config,{operationWindow:{namespace:'synthetic_window'}}),/actual operation window/);
      await screen(client,config,{operationWindow:f.window});
      forbiddenWrite=true; await assert.rejects(screen(client,config,{operationWindow:f.window}),/unsafe evaluator scope/);
      forbiddenWrite=false; await screen(client,config,{operationWindow:f.window});
    } finally { await f.window.close(); }
  });
});

describe('Private IPC lifetime extends through actual response completion', function () {
  async function responseCheck (mutate) {
    const {Readable} = require('node:stream'), {EventEmitter} = require('node:events');
    const f = fixture(), ipc = load('../lib/server/internal-api/transport.js',{},mutate);
    const req = Readable.from([Buffer.from(JSON.stringify({tenant:A}))]);
    const service = { ...require('./fixtures/internal-api-contract').service, operations:{echo:{path:'/synthetic',request:{type:'object'},response:{type:'object'}}} };
    req.method='POST'; req.url='/synthetic'; req.headers=require('./fixtures/internal-api-contract').headers(service);
    const res = new EventEmitter(); let wrote; const written = new Promise(resolve => { wrote=resolve; });
    res.writeHead = status => { res.status=status; res.headersSent=true; };
    res.end = () => { wrote(); }; res.destroy = () => { res.destroyed=true; res.emit('close'); };
    const token = Symbol('owned-synthetic');
    const job = ipc.handler({service,operations:{echo:async () => { f.window.assertCurrent(A); return {ok:true}; }},
      maxBytes:1000,timeoutMs:5000,admitted:() => true,token,operationWindow:f.window,resolveTenant:body => body.tenant})(req,res);
    try {
      await written; await new Promise(resolve => setImmediate(resolve));
      assert.equal(res.status,200); assert.deepEqual([...f.pending.values()],[false]);
      res.emit('finish'); await job; assert.deepEqual([...f.pending.values()],[true]);
    } finally { res.emit('finish'); await job; await f.window.close(); }
  }
  it('keeps durable unfinished operation until response finish', () => responseCheck());
  it('detects prematurely released IPC lifetime and passes restored source', async function () {
    await assert.rejects(responseCheck(s => s.replace('await finished;','void finished;')),assert.AssertionError);
    await responseCheck();
  });
});

describe('Actual serving and CLI selection composition (source protocol)', function () {
  it('collects every selected store, boots API before realtime and drains contexts before releasing control', async function () {
    const events=[], captured=[];
    const cohort = {async boot (role) { events.push('boot:'+role); return {quiesce:async () => events.push('quiesce:'+role),close:async () => events.push('close:'+role)}; },
      complete:() => events.push('complete'),close:async () => events.push('control-close')};
    const cohortModule = require('../lib/server/serve/operation-cohort');
    const serve=load('../lib/server/serve/index.js',{
      './listeners':{resolve:() => [],close:async () => {}},
      pg:{Pool:class {async end () { events.push('pool-end'); }}},
      '../../tenant-lifecycle/operation-window':{create:() => ({})},
      './operation-cohort':{protectedNamespaces:cohortModule.protectedNamespaces,create:async input => { captured.push(input); return cohort; }},
      ...Object.fromEntries(['preview-api','evaluator-preview','preview-realtime','owner-preview'].map(name => ['./'+name,{}]))
    });
    const cfg = key => ({namespaces:{checkpoint:key}});
    const evaluator=cfg('eval_checkpoint'); evaluator.consumers={outbox:{namespace:'outbox'},suppression:{namespace:'suppression'}};
    const running=await serve.start(['realtime','evaluator','api','tenant-admin'],{},null,{}, {
      operationConfig:{namespace:'control',poolOptions:{},locks:[{tenant:A,key:'17'}]},
      preview:cfg('api'),ownerPreview:cfg('owner'),evaluatorPreview:evaluator,realtimePreview:cfg('rt_checkpoint')
    });
    assert.ok(events.indexOf('boot:api')<events.indexOf('boot:realtime'));
    assert.deepEqual(captured[0].namespaces.sort(),['api','owner','eval_checkpoint','rt_checkpoint','outbox','suppression'].sort());
    await running.stop();
    assert.ok(events.filter(x => x.startsWith('close:')).every(x => events.indexOf(x)<events.indexOf('control-close')));
    assert.equal(events.at(-1),'pool-end');
  });
  it('loads the private cohort only for multitenant commands and passes selection to serving', async function () {
    let loads=0; const captures=[];
    const stop = new Error('synthetic stop before listeners');
    const noopConfig={load:() => ({})};
    const cli=load('../lib/cli/commands/multitenant.js',{
      '../../server/serve':{start:async (...args) => { captures.push(args.at(-1)); throw stop; }},
      '../../server/serve/operation-cohort-config':{load:() => { loads++; return {synthetic:true}; }},
      '../../server/serve/preview-config':{...noopConfig,PreviewConfigError:class extends Error {}},
      '../../server/realtime/config':noopConfig,'../../server/serve/evaluator-config':noopConfig,'../../server/serve/owner-preview-config':noopConfig,
      '../../server/runtime-policy':() => {},'../../server/env':() => ({settings:{language:'en'}}),'../../language':() => ({set(){},loadLocalization(){}})
    });
    const io={env:{MULTITENANT_OPERATION_CONFIG:'/synthetic/selected'},stderr:{write(){}}};
    assert.equal(await cli.runRoles(['api'],io,'synthetic',true),1); assert.equal(loads,1); assert.deepEqual(captures[0].operationConfig,{synthetic:true});
    assert.equal(await cli.runRoles(['api'],io,'synthetic',false),1); assert.equal(loads,1); assert.equal(captures[1].operationConfig,undefined);
  });
});
