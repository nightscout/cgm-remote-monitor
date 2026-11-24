'use strict';
const assert = require('node:assert/strict');
const ownership = require('../lib/realtime-ownership');
const slice = require('../lib/pool-membership/slice');
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000003';
const peers = () => ownership.peers({NS_REALTIME_SLICE_PEERS:JSON.stringify([{socket:'/synthetic/a.sock'},{socket:'/synthetic/b.sock'}])}, undefined, {maxBytes:10000,timeoutMs:100});

describe('registry static slice selection', function () {
  it('SHARD_ROSTER: warms only assigned tenants, admits live additions without restart and leaves unchanged polling constant', async function () {
    let revision='1',enumerations=0,predicates=0;
    const ids=[A,B],built=[],activated=[],removed=[],selected=ownership.create({count:2,ordinal:0});
    let C; for(let i=4;!C;i++){const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0');if(selected.owns(id))C=id;}
    const registry=require('../lib/server/serve/registry-tenant-set').create({
      store:{revision:async()=>revision,enumerate:async()=>{enumerations++;return{revision,tenants:[...ids]};},page:async(after,limit)=>({tenants:ids.filter(id=>after===null||id>after).slice(0,limit)})},
      first:{revision,tenants:[...ids]},settings:{namespace:'synthetic_registry',refreshMs:100},maxTenants:10,
      build:tenant=>{built.push(tenant);return{tenant};},accept:tenant=>{predicates++;return selected.owns(tenant);},selectionKey:()=>selected.identity,schedule:()=>null,cancel(){},alert(){}});
    try{
      assert.deepEqual(built,[A]);await registry.follow({prepare:async()=>()=>{},activate:tenant=>activated.push(tenant),remove:async tenant=>removed.push(tenant)});
      const before={enumerations,predicates};await registry.poll();await registry.poll();assert.deepEqual({enumerations,predicates},before);
      ids.push(C);ids.sort();revision='2';await registry.poll();await registry.drained();assert.equal(registry.isActive(C),true);assert.deepEqual(activated,[C]);assert(!built.includes(B));
      ids.splice(ids.indexOf(A),1);revision='3';await registry.poll();await registry.drained();assert.equal(registry.isActive(A),false);assert.deepEqual(removed,[A]);
    }finally{await registry.close();}
  });
});

describe('static alarm and completed-output routing',function(){
  it('SHARD_ALARM: unchanged request and origin reach only the owner; wrong slice and uncertain transport never accept',async function(){
    const alarms=require('../lib/server/realtime/alarm-transport'),token=Symbol('transport'),routes=peers(),seen=[],effects=[];
    const sinks=[0,1].map(ordinal=>alarms.operations({token,ownership:ownership.create({count:2,ordinal}),deliver:async value=>effects.push(value)}));
    let lost=false;const adapter=alarms.createSliceAdapter({peers:routes,clientFor:endpoint=>({deliverAlarm:async(body,signal)=>{seen.push({endpoint,body,signal});if(lost)throw Error('missing peer');return sinks[endpoint.socketPath.endsWith('a.sock')?0:1].deliverAlarm({transport:token},body);}})});
    const input={tenant:A,id:B,attempt:3,notification:{title:'synthetic',originGeneration:'7'},receipts:[],signal:new AbortController().signal};
    const send=()=>new Promise((resolve,reject)=>adapter.send(input,(error,value)=>error?reject(error):resolve(value)));
    assert.deepEqual(await send(),{accepted:true,receipt:null,clearedRequestIds:[]});assert.equal(effects.length,1);assert.equal(seen[0].endpoint.socketPath,'/synthetic/a.sock');assert.equal(seen[0].signal,input.signal);
    assert.deepEqual(seen[0].body,{tenant:A,id:B,attempt:3,notification:input.notification,receipts:[],slice:{count:2,ordinal:0}});
    await assert.rejects(sinks[1].deliverAlarm({transport:token},seen[0].body),{code:'REALTIME_WRONG_OWNER'});
    await assert.rejects(sinks[0].deliverAlarm({transport:token},{...seen[0].body,slice:{count:3,ordinal:0}}),{code:'REALTIME_WRONG_OWNER'});
    await assert.rejects(sinks[0].deliverAlarm({transport:Symbol('wrong')},seen[0].body),{code:'REALTIME_ALARM_REQUEST_REFUSED'});
    lost=true;await assert.rejects(send(),/REALTIME_HANDOFF_UNAVAILABLE/);assert.equal(seen.length,2,'no transparent retry');assert.deepEqual(seen[1].body,seen[0].body);assert.equal(effects.length,1);
  });
  it('SHARD_HINT: every addressed group is attempted despite a missing peer, without inventing acceptance',async function(){
    const routes=peers(),seen=[];
    await assert.rejects(routes.hint({tenants:[A,B]},endpoint=>({hintCompletedOutput:async body=>{seen.push({endpoint,body});if(endpoint.socketPath.endsWith('a.sock'))throw Error('down');return{accepted:true};}})),{code:'REALTIME_OUTPUT_HINT_UNAVAILABLE'});
    assert.equal(seen.length,2);assert.deepEqual(seen.find(row=>row.endpoint.socketPath.endsWith('a.sock')).body,{tenants:[A]});assert.deepEqual(seen.find(row=>row.endpoint.socketPath.endsWith('b.sock')).body,{tenants:[B]});
    const sync=[];await assert.rejects(routes.hint({tenants:[A,B]},endpoint=>{if(endpoint.socketPath.endsWith('a.sock'))throw Error('synchronous client construction failure');return{hintCompletedOutput:async body=>{sync.push(body);return{accepted:true};}};}),{code:'REALTIME_OUTPUT_HINT_UNAVAILABLE'});assert.deepEqual(sync,[{tenants:[B]}],'synchronous private-client refusal never prevents healthy peer attempt');
  });
});

describe('bounded private realtime readiness observations',function(){
  it('uses O(1) startup cells and immutable ownership; replacement, invalidation, unowned and deferred tenants never imply warm',async function(){
    const startupFactory=require('../lib/server/serve/tenant-startup'),inspection=require('../lib/server/serve/realtime-inspection');
    const C='00000000-0000-4000-8000-000000000004',D='00000000-0000-4000-8000-000000000005';let checks=0,initializations=0,closing=false,available=true;
    const selected=ownership.create({count:2,ordinal:0}),models=new Map(),startup=startupFactory.create([A,B,C],undefined,async t=>{initializations++;models.set(t,true);},{readiness:'all',dynamic:true,eligible:async t=>t!==C});
    const fresh=startupFactory.create([A],undefined,async()=>{throw Error('OBSERVATION_MUST_NOT_WARM');},{readiness:'all'});
    try{
      await startup.warm();const token={},make=(s,id)=>inspection({processIncarnation:id,ownership:selected,owner:()=>available,quiescing:()=>closing,startup:{isReady(t){checks++;return s.isReady(t);},health(){throw Error('NO_FULL_STARTUP_SCAN');},tenants(){throw Error('NO_TENANT_ENUMERATION');}},modelWarm:t=>models.get(t)===true})(token),ops=make(startup,A),before=initializations;
      let out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A,B,C,D]});assert.equal(out.tenants[0].ready,true);assert.equal(out.tenants[1].startupComplete,true);assert.equal(out.tenants[1].owned,false);assert.equal(out.tenants[1].ready,false);assert.equal(out.tenants[2].startupComplete,false);assert.equal(out.tenants[2].ready,false);assert.equal(out.tenants[3].startupComplete,false);assert.equal(checks,4);assert.equal(initializations,before);
      models.set(A,false);out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.tenants[0].startupComplete,true);assert.equal(out.tenants[0].modelAvailable,false);assert.equal(out.tenants[0].ready,false);models.set(A,true);
      startup.invalidateTenant(A,{warm:false});out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.tenants[0].startupComplete,false);assert.equal(out.tenants[0].ready,false);await startup.removeTenant(B);assert.equal((await ops.inspectRealtimeTenants({transport:token},{tenants:[B]})).tenants[0].startupComplete,false);
      const replacement=await make(fresh,B).inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(replacement.processIncarnation,B);assert.deepEqual(replacement.ownership,selected.cached());assert.equal(replacement.tenants[0].ready,false);
      closing=true;out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.ownerAvailable,false);assert.equal(out.phase,'quiescing');closing=false;available=false;assert.equal((await ops.inspectRealtimeTenants({transport:token},{tenants:[A]})).tenants[0].ready,false);assert.equal(initializations,before);
    }finally{startup.close();fresh.close();}
  });
  it('refuses wrong transport and malformed selectors before observation; missing components remain unavailable',async function(){
    let reads=0,cells=0;const token={},ops=require('../lib/server/serve/realtime-inspection')({processIncarnation:A,ownership:{cached(){reads++;return null;}},owner:()=>true,quiescing:()=>false,startup:{isReady(){cells++;return true;}}})(token);
    await assert.rejects(ops.inspectRealtimeTenants({transport:{}},{tenants:[A]}));for(const body of [{},{tenants:[A],extra:true},{tenants:[A,A]},{tenants:['00000000-0000-0000-0000-000000000000']},{tenants:[[A]]},{tenants:Array.from({length:129},(_,i)=>'00000000-0000-4000-8000-'+String(i).padStart(12,'0'))},{tenants:['INVALID']}])await assert.rejects(ops.inspectRealtimeTenants({transport:token},body));assert.equal(reads+cells,0);
    const out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.tenants[0].modelAvailable,null);assert.equal(out.tenants[0].owned,false);assert.equal(out.tenants[0].ready,false);
  });
  it('performs one startup Map.get per selector and no whole-map iteration at 10000 tenants',async function(){
    const RealMap=global.Map,ids=Array.from({length:10000},(_,i)=>'00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'));let guarded=false,gets=0,iterations=0;
    class CountedMap extends RealMap{get(k){if(guarded&&this.size>=10000)gets++;return super.get(k);}keys(){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super.keys();}values(){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super.values();}entries(){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super.entries();}[Symbol.iterator](){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super[Symbol.iterator]();}}
    let startup;try{global.Map=CountedMap;startup=require('../lib/server/serve/tenant-startup').create(ids,undefined,async()=>assert.fail('no warm from inspection'),{readiness:'all',dynamic:true});}finally{global.Map=RealMap;}
    try{guarded=true;const token={},ops=require('../lib/server/serve/realtime-inspection')({processIncarnation:A,ownership:ownership.create({count:2,ordinal:0}),owner:()=>true,quiescing:()=>false,startup,modelWarm:()=>false})(token);await ops.inspectRealtime({transport:token});await ops.inspectRealtimeTenants({transport:token},{tenants:[]});assert.equal(gets+iterations,0);assert.equal((await ops.inspectRealtimeTenants({transport:token},{tenants:ids.slice(0,128)})).tenants.length,128);assert.equal(gets,128);assert.equal(iterations,0);assert.throws(()=>startup.health(),/WHOLE_STARTUP_MAP/);assert.throws(()=>startup.tenants(),/WHOLE_STARTUP_MAP/);assert.equal(iterations,2);}finally{guarded=false;startup.close();global.Map=RealMap;}
  });
});

describe('quiet target startup admission', function () {
  it('SHARD_PAUSED_WARM: skips protected initialization for paused/suspended targets, inspects idle state and returns to eligible without a fake successful warm', async function () {
    const initialized = [], alerts = [], eligible = new Set([B]); let at = 0;
    const startup = require('../lib/server/serve/tenant-startup').create([A, B], undefined, async tenant => initialized.push(tenant),
      { readiness: 'all', eligible: async tenant => eligible.has(tenant), now: () => at, coldAlertMs: 100, alert: (...args) => alerts.push(args) });
    try {
      assert.deepEqual(await startup.warm(), [false, true]); assert.deepEqual(initialized, [B], 'SHARD_PAUSED_WARM no paused initialization');
      assert.equal(startup.isReady(A), false); assert.equal(startup.health().deferred, 1); assert.equal(startup.isReady(B), true);
      at = 1000; await new Promise(resolve => setTimeout(resolve, 300)); assert.deepEqual(alerts, []);
      eligible.add(A); await startup.ensure(A); assert.equal(startup.isReady(A), true); assert.deepEqual(initialized, [B, A]);
    } finally { startup.close(); }
  });
  it('SHARD_DEFER_BRAND: application errors with a matching code still fail initialization', async function () {
    const startup = require('../lib/server/serve/tenant-startup').create([A], undefined,
      async () => { throw Object.assign(new Error('synthetic application failure'), { code: 'TENANT_ACTIVITY_DEFERRED' }); }, { eligible: async () => true });
    try { await assert.rejects(startup.warm(), /synthetic application failure/); } finally { startup.close(); }
  });
});


describe('actual static realtime boot observations', function () {
  it('carries reconciliation pages through both private schemas with a real boot-port normal/red/restored control', async function () {
    const fs = require('node:fs'), vm = require('node:vm'), {createRequire} = require('node:module');
    const scope = require('../lib/storage/tenant-scope'), previous = scope.getTenancyMode();
    const filename = require.resolve('../lib/server/serve/preview-realtime'), local = createRequire(filename);
    const source = fs.readFileSync(filename, 'utf8'), roles = [], counterPort = 'reconciliationPages:outputDrain.stats().reconciliationPages';
    const inspection = require('../lib/server/internal-api/contracts').realtimeInspection.operations;
    const validate = require('../lib/server/internal-api/schema').validate, token = Symbol('private-inspection');
    async function boot (transform = value => value) {
      const noop = async () => {};
      const overrides = {
        './role-readiness': require('./fixtures/role-readiness')(), './evaluator-readiness': noop,
        '../../storage/postgres-connection': async () => ({end: noop}),
        '../../realtime-ownership/owner': {hold: ({shape}) => {
          assert.equal(shape.count, 2); assert.equal(shape.ordinal, 0);
          return {available: true, start: noop, close: noop};
        }},
        '../internal-api/clients': {socketAuthority: () => ({})},
        '../realtime/api-client': {create: () => ({})},
        './tenant-startup': {notReadyRetry: () => ({}), create: () => ({warm: noop, close: noop, isReady: tenant => tenant === A})},
        '../realtime/protocol': {create: () => ({close () {}, stats: () => ({}), fanout () {}, watched: () => false, watchedCount: () => 0})},
        './registry-tenant-set': {openDemand: async () => ({tenants: new Map(), resolver:{resolve: noop}, onRemove () {}, isActive: () => false, close: noop, stats: () => ({})})},
        '../../tenant-registry/resolver': {createRegistryResolver: () => ({start: noop, resolve: noop, close () {}})},
        '../../tenant-registry/postgres': {create: () => ({})},
        '../../trusted-worker/postgres': {create: () => ({scan: async () => new Map(), read: noop, current: () => null,
          state: () => ({available: true, generation: 1}), close: noop})},
        '../../trusted-worker/lifecycle': async () => ({close: noop, verify: noop}),
        '../../pgstream/realtime-output': {detector: () => Object.assign(noop, {stats: () => ({polls: 0, failures: 0})}), projection: () => ({})},
        '../../pgstream/realtime-receipt': {
          create: () => ({verify: noop, recover: noop, stats: () => ({received: 0, completed: 0, retries: 0,
            workQueries: 7, metadataUpdates: 0, metadataRows: 0, maxMetadataBatch: 0})}),
          start: () => ({close: noop, wake () {}, reconcile () {}, stats: () => ({reconciliationPages: 5})})
        },
        '../realtime/runtime': async () => ({probe: () => ({live:true, readiness:'serve', ready:true, configured:2}), health () { throw Error('WHOLE_TENANT_HEALTH_SCAN'); },
          stats: () => ({ticks: 0, refreshes: 0, detected: 0, detectFailures: 0}), warm: tenant => tenant === A, close: noop})
      };
      const sandbox = {module: {exports: {}}, process, console, setInterval: () => ({unref () {}}), clearInterval () {},
        require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name)};
      vm.runInNewContext(transform(source), sandbox, {filename});
      const role = await sandbox.module.exports.boot({registry: {namespace: 'rt_registry', maxTenants: 10, refreshMs: 500},
        completedOutput: {namespace: 'ev_checkpoint', consumer: 'evaluator-test'}, trustedWorker: {},
        tenants: new Map(), operationTimeoutMs: 100, ownership: ownership.create({count: 2, ordinal: 0}),
        consumer: 'realtime-static-observation', api: {}, admission: {}, namespaces: {}});
      roles.push(role); return role;
    }
    async function views (role) {
      const operations = role.internal['realtime-inspection'].create(token);
      const process = await operations.inspectRealtime({transport: token});
      const tenants = await operations.inspectRealtimeTenants({transport: token}, {tenants: [A, B]});
      validate(inspection.inspectRealtime.response, process);
      validate(inspection.inspectRealtimeTenants.response, tenants);
      return {process, tenants};
    }
    function verifyReconciliationPages (view) {
      assert.equal(view.stats.delivery.reconciliationPages, 5, 'REALTIME_RECONCILIATION_PAGES_MISSING');
    }
    try {
      const one = await boot(), two = await boot(), normal = await views(one), replacement = await views(two);
      const health = one.health(); assert.equal(health.ready, true); assert.equal(health.configured, 2); assert.equal('tenants' in health, false);
      assert.notEqual(normal.process.processIncarnation, replacement.process.processIncarnation);
      assert.equal(normal.process.ownerAvailable, true);
      assert.equal(normal.tenants.tenants[0].ready, true); assert.equal(normal.tenants.tenants[1].owned, false);
      for (const view of [normal.process, normal.tenants, replacement.process, replacement.tenants]) verifyReconciliationPages(view);
      assert.equal(source.split(counterPort).length, 2, 'counter ablation must land on the actual boot source');
      const missing = await boot(value => value.replace(', ' + counterPort, '')), red = await views(missing);
      for (const view of [red.process, red.tenants]) assert.throws(() => verifyReconciliationPages(view), /REALTIME_RECONCILIATION_PAGES_MISSING/);
      const restored = await views(await boot());
      verifyReconciliationPages(restored.process); verifyReconciliationPages(restored.tenants);
      await one.quiesce(); const closed = await views(one);
      assert.equal(closed.process.ownerAvailable, false); assert.equal(closed.process.phase, 'quiescing');
      assert.equal(closed.tenants.tenants[0].ready, false); assert.equal((await views(two)).process.ownerAvailable, true);
    } finally {
      for (const role of roles) await role.close();
      scope.setTenancyMode(previous);
    }
  });
});

describe('realtime demand warm metadata boundary', function () {
  it('keeps an in-flight output check from invalidating a replacement tenant cell', async function () {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const runtime = await require('../lib/server/realtime/runtime')({ tenants: [], dynamic: true, durableOutput: true,
      readiness: 'serve', readCurrent: async () => ({ tenant: B, identity: 'current' }),
      create: () => ({ acquire: async () => ({ tenant: B, frame: {} }) }), fanout: async () => {},
      detect: async () => { entered.resolve(); await release.promise; return new Map([[B, { identity: null }]]); } });
    try {
      runtime.addTenant(B);
      const oldCheck = runtime.check([B]);
      await entered.promise;
      await runtime.removeTenant(B);
      runtime.addTenant(B);
      await runtime.refresh(B);
      release.resolve();
      assert.equal((await oldCheck).get(B), false);
      assert.equal(runtime.warm(B), true);
    } finally { release.resolve(); await runtime.close(); }
  });

  it('rechecks committed presentation and worker authority after a held first projection', async function () {
    for (const change of ['pause', 'settings', 'worker', 'unchanged']) {
      let enter, release, committed = {tenant:B,identity:'initial'}, observed = committed, generation=1, frames=0;
      const started = new Promise(resolve => { enter=resolve; }), held = new Promise(resolve => {release=resolve;});
      const runtime = await require('../lib/server/realtime/runtime')({tenants:[], dynamic:true, durableOutput:true,
        readiness:'serve', readCurrent:async()=>observed, confirmCold:async()=>{observed=committed;return observed;},
        workerState:()=>({available:true,generation}), create:()=>({async acquire(){enter();await held;return {tenant:B,frame:{}};}}),
        fanout:async()=>{frames++;}});
      try {
        runtime.addTenant(B);
        const warm=runtime.refresh(B);await started;
        if(change==='pause')committed=null;
        if(change==='settings')committed={tenant:B,identity:'changed'};
        if(change==='worker')generation++;
        release();
        if(change==='unchanged'){await warm;assert.equal(frames,1);assert.equal(runtime.warm(B),true);}
        else{await assert.rejects(warm,/REALTIME_CYCLE_CHANGED|TRUSTED_WORKER_UNAVAILABLE/);assert.equal(frames,0);assert.equal(runtime.warm(B),false);}
      } finally {release(); await runtime.close();}
    }
  });
});
