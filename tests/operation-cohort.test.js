'use strict';
// Source protocol controls; recording SQL/role constructors are not native evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const roles = ['api', 'evaluator', 'realtime', 'tenant-admin'];
function load (relative, overrides, mutate = s => s) {
  const file = path.resolve(__dirname, relative), output = {exports:{}};
  const original = require('node:module').createRequire(file);
  vm.runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(file, 'utf8')) + '\n})', {filename:file})(
    name => Object.hasOwn(overrides, name) ? overrides[name] : original(name), output, output.exports);
  return output.exports;
}
describe('Explicit operation cohort configuration', function () {
  it('defaults off without the lifetime identity and refuses an unsafe prefix or connection', function () {
    const config = require('../lib/server/serve/operation-cohort-config');
    assert.equal(config.load({}),null);
    const url = 'postgresql://synthetic:synthetic@127.0.0.1/disposable_test', selected = config.load({NS_PG_PREFIX:'synthetic',NS_LIFETIME_PG:url});
    assert.equal(selected.namespace,'synthetic_control'); assert.equal(selected.locks,null); assert.equal(selected.poolOptions.max,8);
    for (const change of [{NS_PG_PREFIX:'pg_shadow'},{NS_PG_PREFIX:'Public'},{NS_LIFETIME_PG:'mysql://synthetic:synthetic@127.0.0.1/disposable_test'},{NS_LIFETIME_PG:'postgresql://synthetic@127.0.0.1/disposable_test'}]) {
      assert.throws(() => config.load({NS_PG_PREFIX:'synthetic',NS_LIFETIME_PG:url,...change}), /invalid explicit|NS_PG_PREFIX/, JSON.stringify(change));
    }
  });
});

describe('Selected evaluator control-table read admission', function () {
  it('allows only the verified control reads and retains unrelated-write refusal', async function () {
    const f = fixture();
    const {screen} = load('../lib/server/serve/evaluator-readiness.js', {
      '../../storage/postgres-insertion-readiness':{isOrderedCatalogue:() => false}
    });
    const domains = require('../lib/data/tenant-projection-evaluator').domains;
    const config = {namespaces:Object.fromEntries([...domains,'clock','checkpoint'].map(d => [d,'clinical_'+d]))};
    const lifecycle={controlReads:async()=>['synthetic_window.tenant_lifecycle_windows']};
    let forbiddenWrite = false;
    const client = {async query (sql, values) {
      if (sql.includes('operation-window-')) return f.client.query(sql,values);
      if (sql.includes('rolsuper,rolbypassrls,rolcreaterole')) return {rows:[{rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,operator:false}]};
      if (sql.includes('WITH identities')) return {rows:[{creates:false,unrelated:forbiddenWrite || !values[1].includes('synthetic_window.tenant_lifecycle_windows')}]};
      return {rows:[{secured:true,reads:true,forbidden:false,updates:values[0].endsWith('checkpoint'),bookkeeping:true,extra:false}]};
    }};
    try {
      await assert.rejects(screen(client,config),/unsafe evaluator scope/);
      await assert.rejects(screen(client,config,{lifecycle:{}}),/controlReads/);
      await screen(client,config,{lifecycle});
      forbiddenWrite=true; await assert.rejects(screen(client,config,{lifecycle}),/unsafe evaluator scope/);
      forbiddenWrite=false; await screen(client,config,{lifecycle});
    } finally { await f.window.close(); }
  });
});

describe('Private IPC lifetime extends through actual response completion', function () {
  async function responseCheck (mutate) {
    const {Readable} = require('node:stream'), {EventEmitter} = require('node:events');
    const options = {}, f = fixture(options), ipc = load('../lib/server/internal-api/transport.js',{},mutate);
    const req = Readable.from([Buffer.from(JSON.stringify({tenant:A}))]);
    const service = { ...require('./fixtures/internal-api-contract').service, operations:{echo:{path:'/synthetic',request:{type:'object'},response:{type:'object'}}} };
    req.method='POST'; req.url='/synthetic'; req.headers=require('./fixtures/internal-api-contract').headers(service);
    const res = new EventEmitter(); let wrote; const written = new Promise(resolve => { wrote=resolve; });
    res.writeHead = status => { res.status=status; res.headersSent=true; };
    res.end = () => { wrote(); }; res.destroy = () => { res.destroyed=true; res.emit('close'); };
    const token = Symbol('owned-synthetic');
    const job = ipc.handler({service,operations:{echo:async () => { f.window.assertCurrent(A); return {ok:true}; }},
      maxBytes:1000,timeoutMs:5000,admitted:() => true,token,operationWindow:f.window,resolveTenant:body => body.tenant})(req,res);
    let finished = false;
    job.then(() => { finished = true; });
    try {
      await written; await new Promise(resolve => setImmediate(resolve));
      assert.equal(res.status,200); assert.equal(f.pending.size, 0);
      options.phase = 'suspended';
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false, 'ACTUAL_RESPONSE_STILL_RUNNING');
      res.emit('finish'); await job;
      assert.equal(finished, true);
    } finally { res.emit('finish'); await job; await f.window.close(); }
  }
  it('keeps the transport callback open until response finish', () => responseCheck());
  it('detects prematurely released IPC lifetime and passes restored source', async function () {
    await assert.rejects(responseCheck(s => s.replace('await finished;','void finished;')),assert.AssertionError);
    await responseCheck();
  });
});

describe('Actual serving and CLI selection composition (source protocol)', function () {
  it('collects every selected store, boots API before realtime and drains contexts before releasing control', async function () {
    const events=[];
    const scope={ready:async()=>{},close:async()=>events.push('control-close')};
    const serve=load('../lib/server/serve/index.js',{
      './listeners':{resolve:() => [],close:async () => {}},
      './internal-listener':{plan:() => [],open:async () => null},
      pg:{Pool:class {on (event) { events.push('pool-listens:'+event); } async end () { events.push('pool-end'); }}},
      '../../tenant-lifecycle/generation-scope':{create:()=>scope},
      '../../storage/postgres-connection':{installOperationWindow:()=>()=>{}},
      ...Object.fromEntries(['preview-api','evaluator-preview','preview-realtime','owner-preview'].map((name,index)=>['./'+name,{
        boot:async()=>{const role=roles[index];events.push('boot:'+role);return {close:async()=>events.push('close:'+role)};}
      }]))
    });
    const cfg = key => ({tenantIds:[A],namespaces:{checkpoint:key}});
    const evaluator=cfg('eval_checkpoint'); evaluator.consumers={outbox:{namespace:'outbox'},suppression:{namespace:'suppression'}};
    const running=await serve.start(['realtime','evaluator','api','tenant-admin'],{},null,{}, {
      operationConfig:{namespace:'control',poolOptions:{},locks:[{tenant:A,key:'17'}]},
      datastoreProbe:{probe:async()=>{},readmit:async()=>({restarted:false}),adopt(){}},
      preview:{...cfg('api'),writeClock:true},ownerPreview:cfg('owner'),evaluatorPreview:evaluator,realtimePreview:{...cfg('rt_checkpoint'),ownership:{count:1,ordinal:0}}
    });
    assert.ok(events.indexOf('boot:api')<events.indexOf('boot:realtime'));
    assert.ok(events.includes('pool-listens:error'),'an idle operation-pool backend loss has a listener');
    assert.equal(running.datastoreRecovery.state().state,'serving');
    assert.deepEqual([...new Set([cfg('api'),cfg('owner'),evaluator,cfg('rt_checkpoint')].flatMap(require('../lib/server/serve/role-topology').protectedNamespaces))].sort(),['api','owner','eval_checkpoint','rt_checkpoint','outbox','suppression'].sort());
    await running.stop();
    assert.ok(events.filter(x => x.startsWith('close:')).every(x => events.indexOf(x)<events.indexOf('control-close')));
    assert.equal(events.at(-1),'pool-end');
  });
  it('loads the private cohort only for multitenant commands and passes selection to serving', async function () {
    let loads=0; const captures=[];
    const stop = new Error('synthetic stop before listeners');
    // The role configuration stub is registry-shaped.
    const noopConfig={load:() => ({registry:{namespace:'synthetic_registry'}})};
    const cli=load('../lib/cli/commands/multitenant.js',{
      '../../server/serve':{...require('../lib/server/serve'),start:async (...args) => { captures.push(args.at(-1)); throw stop; }},
      '../../server/serve/operation-cohort-config':{load:() => { loads++; return {synthetic:true}; }},
      '../../server/serve/preview-config':{...noopConfig,PreviewConfigError:class extends Error {}},
      '../../server/realtime/config':noopConfig,'../../server/serve/evaluator-config':noopConfig,'../../server/serve/owner-preview-config':noopConfig,
      '../../server/runtime-policy':() => {},'../../server/env':() => ({settings:{language:'en'}}),'../../language':() => ({set(){},loadLocalization(){}})
    });
    const io={env:{NS_LIFETIME_PG:'postgres://synthetic:synthetic@127.0.0.1/synthetic'},stderr:{write(){}}};
    assert.equal(await cli.runRoles(['api'],io,'synthetic',true),1); assert.equal(loads,1); assert.deepEqual(captures[0].operationConfig,{synthetic:true});
    assert.equal(await cli.runRoles(['api'],io,'synthetic',false),1); assert.equal(loads,1); assert.equal(captures[1].operationConfig,undefined);
  });
});
