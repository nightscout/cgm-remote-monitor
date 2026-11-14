'use strict';
const assert = require('node:assert/strict');
const { A, B, I, placement, config, parse, move } = require('./fixtures/realtime-placement-map');
describe('registry placement subset selection', function () {
  it('SHARD_ROSTER: warms only assigned tenants, changes subset without a data/registry write, and leaves unchanged polling constant', async function () {
    const C = '33333333-3333-4333-8333-333333333333';
    let revision = '1', selected = new Set([A]), generation = 1, enumerations = 0, predicates = 0;
    const ids = [A, B], built = [], activated = [], removed = [];
    const registry = require('../lib/server/serve/registry-tenant-set').create({
      store: { revision: async () => revision, enumerate: async () => { enumerations++; return { revision, tenants: [...ids] }; },
        page: async (after, limit) => ({ tenants: ids.filter(id => after === null || id > after).slice(0, limit) }) },
      first: { revision, tenants: [...ids] }, settings: { namespace: 'synthetic_registry', refreshMs: 100 }, maxTenants: 10,
      build: tenant => { built.push(tenant); return { tenant }; }, accept: tenant => { predicates++; return selected.has(tenant); },
      selectionKey: () => generation, schedule: () => null, cancel () {}, alert () {} });
    try {
      assert.deepEqual(built, [A], 'SHARD_ROSTER unowned B has no initial build');
      await registry.follow({ prepare: async () => () => {}, activate: tenant => activated.push(tenant), remove: async tenant => removed.push(tenant) });
      const before = { enumerations, predicates };
      await registry.poll(); await registry.poll();
      assert.deepEqual({ enumerations, predicates }, before, 'SHARD_ROSTER unchanged ticks do not expand/select roster');
      selected = new Set([B]); generation++;
      await registry.poll(); await registry.drained();
      assert.equal(registry.isActive(A), false); assert.equal(registry.isActive(B), true);
      assert.deepEqual(activated, [B]); assert.deepEqual(removed, [A]); assert.equal(enumerations, before.enumerations, 'placement-only revision reuses bounded known roster');
      ids.push(C); revision = '2'; await registry.poll(); await registry.drained();
      assert.equal(registry.isActive(C), false); assert.ok(!built.includes(C), 'SHARD_ROSTER unowned live-add never builds');
    } finally { await registry.close(); }
  });
});

describe('alarm routing across controlled placement', function () {
  it('SHARD_ALARM: same epoch routes to current owner, stale routing refuses before effect, and uncertainty retains request/attempt without transparent retry', async function () {
    const alarms = require('../lib/server/realtime/alarm-transport'), token = Symbol('transport');
    let map = parse(config()), effects = 0;
    const reader = placement.create({ read: () => map, self: { worker: 'a', incarnation: I } });
    const sink = alarms.operations({ token, placement: reader, deliver: async () => { effects++; } });
    const routes = [], bodies = []; let lost = false;
    const adapter = alarms.createPlacementAdapter({ placement: reader, clientFor: endpoint => ({ deliverAlarm: async body => {
      routes.push(endpoint); bodies.push(body);
      if (lost) throw new Error('response lost');
      return sink.deliverAlarm({ transport: token }, body);
    } }) });
    const input = { tenant: A, id: B, attempt: 3, notification: { title: 'synthetic' }, receipts: [] };
    const send = () => new Promise((resolve, reject) => adapter.send(input, (error, value) => error ? reject(error) : resolve(value)));
    assert.deepEqual(await send(), { accepted: true, receipt: null, clearedRequestIds: [] }); assert.equal(effects, 1);
    const old = structuredClone(bodies[0]);
    map = parse(move(config(), 'b'));
    await assert.rejects(sink.deliverAlarm({ transport: token }, old), { code: 'REALTIME_PLACEMENT_WRONG_OWNER' }); assert.equal(effects, 1);
    lost = true; await assert.rejects(send(), /REALTIME_HANDOFF_UNAVAILABLE/);
    assert.equal(bodies.length, 2, 'SHARD_ALARM no transparent retry on uncertainty');
    assert.equal(bodies[1].id, input.id); assert.equal(bodies[1].attempt, input.attempt); assert.deepEqual(bodies[1].notification, input.notification);
    assert.equal(routes[1].socketPath, '/tmp/shard-b.sock'); assert.equal(bodies[1].placement.generation, 2);
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

describe('sharded alarm envelope bound', function () {
  it('reserves the maximum placement tuple only for the selected sharded transport', function () {
    const metadata = require('../lib/server/serve/evaluator-consumer-config').metadata;
    const value = { realtime: { outbox: { connectionEnv: 'OUTBOX', namespace: 'synthetic_outbox', maxRows: 1, maxBytes: 10000, maxConnections: 1 }, suppression: { connectionEnv: 'ALARM', namespace: 'synthetic_alarm', maxRows: 1, maxBytes: 10000, maxConnections: 1 }, route: { id: 'synthetic', maxMessageBytes: 1200, operationTimeoutMs: 100 }, maxPayloadBytes: 1000, maxInflight: 1, attemptTimeoutMs: 100, retryDelayMs: 100, pollIntervalMs: 100, retryIntervalMs: 100 } };
    assert.doesNotThrow(() => metadata(value, {}));
    assert.throws(() => metadata(value, {}, { placement: true }), /invalid/);
    value.realtime.route.maxMessageBytes = 1500;
    assert.doesNotThrow(() => metadata(value, {}, { placement: true }));
    const envelope={tenant:'0'.repeat(36),id:'0'.repeat(36),attempt:2147483647,notification:{},receipts:[],placement:{generation:Number.MAX_SAFE_INTEGER,shard:65535,worker:'w'.repeat(63),incarnation:'0'.repeat(36)}};
    value.realtime.route.maxMessageBytes=1000+Buffer.byteLength(JSON.stringify(envelope))-2;
    assert.doesNotThrow(()=>metadata(value,{}, {placement:true}));
    assert.throws(()=>metadata(value,{}, {placement:true,ownershipVersion:2}), /invalid/);
    envelope.placement.ownershipVersion=2;value.realtime.route.maxMessageBytes=1000+Buffer.byteLength(JSON.stringify(envelope))-2;
    assert.doesNotThrow(()=>metadata(value,{}, {placement:true,ownershipVersion:2}));
  });
});

describe('bounded recovery source primitives', function () {
  it('uses exactly the existing owner key and keeps cached health independent of filesystem and tenant work', async function () {
    const owner = require('../lib/realtime-placement/owner'); let key;
    await owner.acquire({worker: 'a', consumer: 'realtime-stable', connection: {holdAdvisoryLock: async value => {key=value;}}});
    assert.equal(key, owner.key({worker:'a',consumer:'realtime-stable'}));
    assert.notEqual(key, owner.key({worker:'b',consumer:'realtime-stable'}));
    assert.notEqual(key, owner.key({worker:'a',consumer:'realtime-other'}));
    let reads=0, current=parse(config());
    const reader=placement.create({read:()=>{reads++;return current;},self:{worker:'a',incarnation:I}});
    assert.equal(reader.cached(),null);reader.current();const before=reads;
    assert.deepEqual(reader.cached().shards,[0,1,2,3,4,5,6,7]);
    current=parse(move(config(),'b'));
    assert.equal(reader.cached().assignmentIncarnation,I,'cached metadata does not invent a current map read');
    assert.equal(reads,before);reader.current();assert.deepEqual(reader.cached().shards,[]);
    reader.close();
  });
  it('private cached health preserves process versus assignment identity, unknown fields and transport trust', async function () {
    const contracts=require('../lib/server/internal-api/contracts'),{validate}=require('../lib/server/internal-api/schema');
    const module=require('../lib/server/serve/realtime-inspection');let reads=0,quiescing=false;
    const reader=placement.create({read:()=>{reads++;return parse(config());},self:{worker:'a',incarnation:I}});reader.current();
    const token={},create=module({processIncarnation:B,placement:reader,owner:()=>!quiescing,quiescing:()=>quiescing}),api=create(token);
    await assert.rejects(api.inspectRealtime({transport:{}}),{code:'REALTIME_INSPECTION_REFUSED'});
    const before=reads,value=await api.inspectRealtime({transport:token});validate(contracts.realtimeInspection.operations.inspectRealtime.response,value);
    assert.equal(value.processIncarnation,B);assert.equal(value.placement.assignmentIncarnation,I);assert.equal(value.observation,'cached-not-lock-proof');assert.equal(reads,before);
    quiescing=true;assert.equal((await api.inspectRealtime({transport:token})).ownerAvailable,false);
    assert.throws(()=>validate(contracts.realtimeInspection.operations.inspectRealtime.request,{tenant:A}),{code:'INTERNAL_API_SCHEMA_REFUSED'});
    assert.throws(()=>validate(contracts.realtimeInspection.operations.inspectRealtime.response,{...value,secret:'forbidden'}),{code:'INTERNAL_API_SCHEMA_REFUSED'});
  });
  it('recovery publication requires exact old process exclusion AND the old owner lock on the publication client', async function () {
    const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
    const {publishRecovery}=require('../lib/realtime-placement/publish'),owner=require('../lib/realtime-placement/owner');
    const {internal}=require('./fixtures/realtime-placement-map'),protocol=require('./fixtures/operation-window-admission-protocol');
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rt-recovery-publication-')),file=path.join(directory,'map.json');
    try {
      for (const mode of ['reuse','alive','locked','ready']) {
        const original=config(),candidate=move(original,'b'),trace=[],metadata=protocol();let locks=0;
        if(mode!=='reuse')candidate.workers=candidate.workers.filter(worker=>worker.id!=='a');
        await fs.writeFile(file,JSON.stringify(original));
        const client={async query(sql,values){trace.push(sql);if(sql==='BEGIN READ ONLY'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[]};
          if(sql==='SELECT pg_try_advisory_xact_lock($1::bigint) AS held'){locks++;if(locks===2){assert.equal(values[0],owner.key({worker:'a',consumer:'realtime-stable'}));return {rows:[{held:mode!=='locked'}]};}return {rows:[{held:true}]};}
          const response=metadata(sql,values);if(response)return response;throw Error('unexpected SQL '+sql);}};
        const options={file,candidate,internal,client,consumer:'realtime-stable',controlNamespace:'synthetic_window',registry:{revision:async()=> '1',page:async()=>({revision:'1',tenants:[]})},confirmStopped:async()=>mode!=='alive',
          afterAssignment:async()=>{assert.equal(locks,2,'actual old owner lock acquired before warming/routes');assert(!trace.includes('COMMIT'));assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),candidate);trace.push('routes-ready');}};
        if(mode==='ready'){await publishRecovery(options);assert(trace.indexOf('routes-ready')<trace.indexOf('COMMIT'));}
        else {await assert.rejects(publishRecovery(options),{code:mode==='reuse'?'REALTIME_RECOVERY_WORKER_REUSE_UNSUPPORTED':mode==='alive'?'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED':'REALTIME_RECOVERY_OWNER_LOCK_HELD'});assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),original);assert(!trace.includes('routes-ready'));if(mode==='reuse')assert.deepEqual(trace,[],'same-ID reuse refuses before any SQL or publication effect');}
      }
    }finally{await fs.rm(directory,{recursive:true});}
  });
});

describe('actual realtime boot observation wiring', function () {
  const scope = require('../lib/storage/tenant-scope');
  let previousMode;
  // Actual role boot sets process mode. Restore this suite's caller even when
  // boot or a later assertion rejects before the test's resource cleanup.
  beforeEach(function () { previousMode = scope.getTenancyMode(); });
  afterEach(function () { scope.setTenancyMode(previousMode); });
  it('binds private cached health without touching full runtime health and uses a fresh process identity per restart', async function () {
    const fs=require('node:fs'),vm=require('node:vm'),Module=require('node:module');
    const filename=require.resolve('../lib/server/serve/preview-realtime'),local=Module.createRequire(filename),source=fs.readFileSync(filename,'utf8'),keys=[];
    async function boot(transform=s=>s,version=1){
      const selected=placement.create({read:()=>placement.parse({...config(),version},{internal:require('./fixtures/realtime-placement-map').internal,ownershipVersion:version}),self:{worker:'a',incarnation:I}});selected.current();
      const noop=async()=>{},overrides={
        '../../storage/connection-admission':{coldAdmission:()=>null},'./evaluator-readiness':noop,
        '../../storage/postgres-connection':async()=>({end:noop,holdAdvisoryLock:async key=>{keys.push(key);return {available:true,check:noop,close:noop};}}),
        '../internal-api/clients':{socketAuthority:()=>({})},'../realtime/api-client':{create:()=>({})},
        './tenant-startup':{notReadyRetry:()=>({}),create:()=>({warm:noop,close:noop,isReady:tenant=>tenant===A})},
        '../realtime/protocol':{create:()=>({close(){},stats:()=>({}),fanout(){},watchedTenants:()=>[],watchedCount:()=>0})},
        './registry-tenant-set':{open:async()=>({tenants:new Map(),isActive:()=>false,follow:noop,close:noop,stats:()=>({})})},
        '../../tenant-registry/resolver':{createRegistryResolver:()=>({start:noop,resolve:noop,close(){}})},'../../tenant-registry/postgres':{create:()=>({})},
        '../../trusted-worker/postgres':{create:()=>({scan:async()=>new Map(),read:noop,current:()=>null,state:()=>({available:true,generation:1}),close:noop})},
        '../../trusted-worker/lifecycle':async()=>({close:noop,verify:noop}),
        '../../pgstream/realtime-output':{detector:()=>Object.assign(noop,{stats:()=>({polls:0,failures:0})}),projection:()=>({})},
        '../../pgstream/realtime-receipt':{create:()=>({verify:noop,recover:noop,stats:()=>({})}),start:()=>({close:noop})},
        '../realtime/runtime':async()=>({health(){throw Error('WHOLE_TENANT_HEALTH_SCAN');},warm:tenant=>tenant===A,close:noop})};
      const sandbox={module:{exports:{}},process,console,setInterval:()=>({unref(){}}),clearInterval(){},require:name=>Object.hasOwn(overrides,name)?overrides[name]:local(name)};
      vm.runInNewContext(transform(source),sandbox,{filename});
      return sandbox.module.exports.boot({registry:{namespace:'rt_registry',maxTenants:10,refreshMs:500},completedOutput:{namespace:'ev_checkpoint',consumer:'evaluator-test'},trustedWorker:{},tenants:new Map(),operationTimeoutMs:100,placement:selected,consumer:'realtime-stable',api:{},admission:{},namespaces:{}});
    }
    const one=await boot(),two=await boot();
    try {
      const token={},a=await one.internal['realtime-inspection'].create(token).inspectRealtime({transport:token}),b=await two.internal['realtime-inspection'].create(token).inspectRealtime({transport:token});
      assert.notEqual(a.processIncarnation,b.processIncarnation);assert.equal(a.placement.assignmentIncarnation,I);assert.equal(b.placement.assignmentIncarnation,I);assert.equal(a.ownerAvailable,true);
      const selected=await one.internal['realtime-inspection'].create(token).inspectRealtimeTenants({transport:token},{tenants:[A,B]});assert.equal(selected.tenants[0].startupComplete,true);assert.equal(selected.tenants[0].modelAvailable,true);assert.equal(selected.tenants[0].ready,true);assert.equal(selected.tenants[1].ready,false);
      const version2=await boot(undefined,2);try{const observed=await version2.internal['realtime-inspection'].create(token).inspectRealtime({transport:token});assert.equal(observed.placement.ownershipVersion,2);assert.equal(keys.at(-1),require('../lib/realtime-placement/owner').key({worker:'a',consumer:'realtime-stable',ownershipVersion:2,assignmentIncarnation:I}));}finally{await version2.close();}
      await one.quiesce();assert.equal((await one.internal['realtime-inspection'].create(token).inspectRealtime({transport:token})).ownerAvailable,false);
      const needle="'realtime-inspection': Object.freeze({create: require('./realtime-inspection')";assert(source.includes(needle));
      const mutant=await boot(s=>s.replace(needle,"'omitted-realtime-inspection': Object.freeze({create: require('./realtime-inspection')"));
      try{assert.throws(()=>assert(mutant.internal['realtime-inspection'],'REALTIME_BOOT_INSPECTION_MISSING'),/REALTIME_BOOT_INSPECTION_MISSING/);}finally{await mutant.close();}
    }finally{await one.close();await two.close();}
  });
});

describe('assignment-scoped ownership contract2', function () {
  const owner=require('../lib/realtime-placement/owner'),{internal}=require('./fixtures/realtime-placement-map');
  const assignment='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  it('keeps legacy vectors, separates new assignment keys, rejects mixed profiles and never changes key mode in a reader', function () {
    const legacy=owner.key({worker:'a',consumer:'realtime-stable'}),key=inc=>owner.key({worker:'a',consumer:'realtime-stable',ownershipVersion:2,assignmentIncarnation:inc});
    assert.equal(legacy,'-5073554805065011920');assert.equal(key(I),'4173473733355573165');assert.equal(key(assignment),'-7243865036506391614');
    assert.notEqual(legacy,key(I));assert.equal(key(I),key(I));assert.notEqual(key(I),key(assignment));
    assert.throws(()=>owner.key({worker:'a',consumer:'realtime-stable',ownershipVersion:2}));
    assert.throws(()=>owner.key({worker:'a',consumer:'realtime-stable',assignmentIncarnation:I}));
    const original=config(),next={...original,version:2};
    assert.throws(()=>placement.parse(next,{internal}),{code:'REALTIME_PLACEMENT_REFUSED'});
    assert.throws(()=>placement.parse(original,{internal,ownershipVersion:2}),{code:'REALTIME_PLACEMENT_REFUSED'});
    for(const selected of ['', '2','legacy-v1',true])assert.throws(()=>placement.ownershipVersion({NS_REALTIME_OWNERSHIP_CONTRACT:selected}),{code:'REALTIME_OWNERSHIP_CONTRACT_REFUSED'});
    let map=parse(original);const reader=placement.create({read:()=>map,self:{worker:'a',incarnation:I}});reader.current();
    map=placement.parse({...next,generation:2,transition:{previousGeneration:1,previousOwners:original.owners.map(worker=>({worker,incarnation:original.workers.find(row=>row.id===worker).incarnation})),stopped:[]}},{internal,ownershipVersion:2});assert.throws(()=>reader.current(),{code:'REALTIME_PLACEMENT_REVISION_REFUSED'});
    const current=placement.create({read:()=>map,self:{worker:'a',incarnation:I}}),route=current.route(A);
    assert.equal(route.ownershipVersion,2);assert.throws(()=>current.assert(A,{...route,ownershipVersion:undefined}),{code:'REALTIME_PLACEMENT_WRONG_OWNER'});
  });
  it('warms same worker/new assignment while holding actual OLD assignment key; separately bounds retained work', async function () {
    const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),protocol=require('./fixtures/operation-window-admission-protocol');
    const {publish,publishRecovery}=require('../lib/realtime-placement/publish'),rules=require('../lib/tenant-registry/rules');
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rt-assignment-publication-')),file=path.join(directory,'map.json');
    const tenants=[];for(let n=1;tenants.length<2&&n<1000;n++){const id='00000000-0000-4000-8000-'+String(n).padStart(12,'0'),zero=placement.shard(id,8)===0;if(!tenants.some(t=>(placement.shard(t,8)===0)===zero))tenants.push(id);}tenants.sort();assert.equal(tenants.length,2);
    try{
      for(const mode of ['ready','old-live','old-lock','logical-bound','assignment-bound','tenant-bound','legacy-entry','no-readiness']){
        const original={...config(),version:2},candidate={...move(original,'a'),version:2};candidate.owners[0]='b';if(mode==='logical-bound')candidate.owners[1]='b';
        const held=new Set(),trace=[],metadata=protocol();let locks=0,warmed=false,stops=0;
        await fs.writeFile(file,JSON.stringify(original));
        const client={async query(sql,values){trace.push(sql);if(['BEGIN READ ONLY','COMMIT','ROLLBACK'].includes(sql)){if(sql!=='BEGIN READ ONLY')held.clear();return {rows:[]};}
          if(sql==='SELECT pg_try_advisory_xact_lock($1::bigint) AS held'){locks++;if(locks===2){assert.equal(values[0],owner.key({worker:'a',consumer:'realtime-stable',ownershipVersion:2,assignmentIncarnation:I}));if(mode==='old-lock')return {rows:[{held:false}]};held.add(values[0]);}return {rows:[{held:true}]};}
          if(sql.startsWith("SELECT set_config('app.current_tenant_id'"))return {rows:[]};
          if(sql.startsWith('SELECT phase,lock_key'))return {rows:[{phase:'active',lock_key:rules.lockKey(values[0])}]};
          const response=metadata(sql,values);if(response)return response;throw Error('unexpected SQL '+sql);}};
        const options={file,candidate,internal,client,consumer:'realtime-stable',source:{NS_REALTIME_OWNERSHIP_CONTRACT:'assignment-v2'},controlNamespace:'synthetic_window',registry:{revision:async()=> '1',page:async()=>({revision:'1',tenants})},confirmStopped:async()=>{stops++;return mode!=='old-live';},
          recoveryLimits:{maxLogicalMoves:1,maxAssignmentChanges:mode==='assignment-bound'?1:8,maxAffectedTenants:mode==='tenant-bound'?1:2},
          afterAssignment:async result=>{assert.equal(held.size,1);assert.equal(result.logicalMoves,1);assert.equal(result.assignmentChanges,8);assert.equal(result.retainedWarmTenantUpperBound,1);assert.equal(result.logicalMovedTenants,1);
            const resource=await owner.acquire({worker:'a',consumer:'realtime-stable',ownershipVersion:2,assignmentIncarnation:assignment,connection:{async holdAdvisoryLock(key){assert(!held.has(key),'NEW_ASSIGNMENT_MUST_NOT_WAIT_ON_OLD_KEY');return {available:true};}}});assert(resource.available);assert(!trace.includes('COMMIT'));warmed=true;}};
        if(mode==='no-readiness')delete options.afterAssignment;
        if(mode==='ready'){const result=await publishRecovery(options);assert(warmed);assert.equal(result.affectedTenants,2);assert(trace.includes('COMMIT'));}
        else {const code=mode==='old-live'?'REALTIME_PLACEMENT_OLD_OWNER_UNCONFIRMED':mode==='old-lock'?'REALTIME_RECOVERY_OWNER_LOCK_HELD':mode==='legacy-entry'?'REALTIME_ASSIGNMENT_PUBLISH_REQUIRES_RECOVERY':mode==='no-readiness'?'REALTIME_RECOVERY_READINESS_REQUIRED':'REALTIME_RECOVERY_WORK_OVER_BOUND';await assert.rejects(mode==='legacy-entry'?publish(options):publishRecovery(options),{code});assert(!warmed);assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),original);if(mode.endsWith('bound')||mode==='legacy-entry'||mode==='no-readiness')assert.equal(stops,0);}
      }
    }finally{await fs.rm(directory,{recursive:true});}
  });
});

describe('assignment-key alarm handoff', function () {
  it('carries the exact key contract without changing request/attempt and rejects legacy/mixed targets before effect', async function () {
    const alarms=require('../lib/server/realtime/alarm-transport'),token=Symbol('private'),internal=require('./fixtures/realtime-placement-map').internal;
    const map=placement.parse({...config(),version:2},{internal,ownershipVersion:2}),reader=placement.create({read:()=>map,self:{worker:'a',incarnation:I}});let effects=0,observed;
    const sink=alarms.operations({token,placement:reader,deliver:async()=>{effects++;}}),adapter=alarms.createPlacementAdapter({placement:reader,clientFor:()=>({deliverAlarm:async body=>{observed=body;return sink.deliverAlarm({transport:token},body);}})});
    await new Promise((resolve,reject)=>adapter.send({tenant:A,id:B,attempt:7,notification:{level:1}},error=>error?reject(error):resolve()));
    assert.equal(effects,1);assert.equal(observed.id,B);assert.equal(observed.attempt,7);assert.equal(observed.placement.ownershipVersion,2);
    const legacy={...observed,placement:{...observed.placement}};delete legacy.placement.ownershipVersion;
    await assert.rejects(sink.deliverAlarm({transport:token},legacy),{code:'REALTIME_ALARM_PLACEMENT_REFUSED'});
    await assert.rejects(sink.deliverAlarm({transport:token},{...observed,placement:{...observed.placement,ownershipVersion:1}}),{code:'REALTIME_PLACEMENT_WRONG_OWNER'});
    const oldReader=placement.create({read:()=>parse(config()),self:{worker:'a',incarnation:I}}),oldSink=alarms.operations({token,placement:oldReader,deliver:async()=>{effects++;}});
    await assert.rejects(oldSink.deliverAlarm({transport:token},observed),{code:'REALTIME_ALARM_PLACEMENT_REFUSED'});assert.equal(effects,1);
  });
});

describe('bounded private realtime tenant readiness observations',function(){
  it('uses actual O(1) startup cells and cached model/assignment; new, invalidated, removed, unowned and deferred never imply warm',async function(){
    const {internal}=require('./fixtures/realtime-placement-map'),startupFactory=require('../lib/server/serve/tenant-startup'),inspection=require('../lib/server/serve/realtime-inspection');
    const C='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444';let reads=0,checks=0,initializations=0,closing=false,available=true;
    const map={...config(),version:2};map.owners[placement.shard(B,map.shardCount)]='b';
    const p=placement.create({read:()=>{reads++;return placement.parse(map,{internal,ownershipVersion:2});},self:{worker:'a',incarnation:I}});p.current();
    const models=new Map(),startup=startupFactory.create([A,B,C],undefined,async t=>{initializations++;models.set(t,true);},{readiness:'all',dynamic:true,eligible:async t=>t!==C});
    const fresh=startupFactory.create([A],undefined,async()=>{throw Error('OBSERVATION_MUST_NOT_WARM');},{readiness:'all'});
    try{
      await startup.warm();const token={},make=(s,id)=>inspection({processIncarnation:id,placement:p,owner:()=>available,quiescing:()=>closing,startup:{isReady(t){checks++;return s.isReady(t);},health(){throw Error('NO_FULL_STARTUP_SCAN');},tenants(){throw Error('NO_TENANT_ENUMERATION');}},modelWarm:t=>models.get(t)===true})(token),ops=make(startup,A),before={reads,initializations};
      let out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A,B,C,D]});assert.deepEqual(out.tenants.map(r=>r.tenant),[A,B,C,D]);assert.equal(out.tenants[0].ready,true);assert.equal(out.tenants[1].startupComplete,true);assert.equal(out.tenants[1].owned,false);assert.equal(out.tenants[1].ready,false);assert.equal(out.tenants[2].startupComplete,false);assert.equal(out.tenants[2].ready,false);assert.equal(out.tenants[3].startupComplete,false);assert.equal(checks,4);assert.deepEqual({reads,initializations},before);
      models.set(A,false);out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.tenants[0].startupComplete,true);assert.equal(out.tenants[0].modelAvailable,false);assert.equal(out.tenants[0].ready,false,'historical initialization alone is not current cached model availability');models.set(A,true);
      startup.invalidateTenant(A,{warm:false});out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.tenants[0].startupComplete,false);assert.equal(out.tenants[0].ready,false);await startup.removeTenant(B);out=await ops.inspectRealtimeTenants({transport:token},{tenants:[B]});assert.equal(out.tenants[0].startupComplete,false);
      const replacement=await make(fresh,B).inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(replacement.processIncarnation,B);assert.equal(replacement.placement.assignmentIncarnation,I);assert.equal(replacement.tenants[0].ready,false);assert.equal(replacement.tenants[0].startupComplete,false);
      closing=true;out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.ownerAvailable,false);assert.equal(out.tenants[0].ready,false);assert.equal(out.phase,'quiescing');closing=false;available=false;assert.equal((await ops.inspectRealtimeTenants({transport:token},{tenants:[A]})).tenants[0].ready,false);
      assert.equal(reads,before.reads);assert.equal(initializations,before.initializations);
    }finally{startup.close();fresh.close();}
  });
  it('refuses wrong authority and malformed selectors before observation; missing components remain explicitly unavailable',async function(){
    let reads=0,cells=0;const token={},factory=require('../lib/server/serve/realtime-inspection'),ops=factory({processIncarnation:A,placement:{cached(){reads++;return null;}},owner:()=>true,quiescing:()=>false,startup:{isReady(){cells++;return true;}}})(token);
    await assert.rejects(ops.inspectRealtimeTenants({transport:{}},{tenants:[A]}));
    for(const body of [{},{tenants:[A],extra:true},{tenants:[A,A]},{tenants:['00000000-0000-0000-0000-000000000000']},{tenants:[[A]]},{tenants:Array.from({length:129},(_,i)=>'00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'))},{tenants:['INVALID']}])await assert.rejects(ops.inspectRealtimeTenants({transport:token},body));assert.equal(reads+cells,0);
    const out=await ops.inspectRealtimeTenants({transport:token},{tenants:[A]});assert.equal(out.tenants[0].modelAvailable,null);assert.equal(out.tenants[0].owned,false);assert.equal(out.tenants[0].ready,false);
  });
});

  describe('selected private RT readiness cost bound',function(){
    it('performs one actual startup Map.get per selector and no whole-map iteration at a large roster',async function(){
      const RealMap=global.Map,ids=Array.from({length:10000},(_,i)=>'00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0'));let guarded=false,gets=0,iterations=0;
      class CountedMap extends RealMap{
        get(k){if(guarded&&this.size>=10000)gets++;return super.get(k);}
        keys(){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super.keys();}
        values(){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super.values();}
        entries(){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super.entries();}
        [Symbol.iterator](){if(guarded&&this.size>=10000){iterations++;throw Error('WHOLE_STARTUP_MAP');}return super[Symbol.iterator]();}
      }
      let startup;try{global.Map=CountedMap;startup=require('../lib/server/serve/tenant-startup').create(ids,undefined,async()=>assert.fail('no initializer from inspection'),{readiness:'all',dynamic:true});}finally{global.Map=RealMap;}
      try{
        guarded=true;let reads=0;const {internal}=require('./fixtures/realtime-placement-map'),p=placement.create({read:()=>{reads++;return placement.parse({...config(),version:2},{internal,ownershipVersion:2});},self:{worker:'a',incarnation:I}});p.current();const token={},ops=require('../lib/server/serve/realtime-inspection')({processIncarnation:A,placement:p,owner:()=>true,quiescing:()=>false,startup,modelWarm:()=>false})(token);
        await ops.inspectRealtime({transport:token});await ops.inspectRealtimeTenants({transport:token},{tenants:[]});assert.equal(gets+iterations,0);const out=await ops.inspectRealtimeTenants({transport:token},{tenants:ids.slice(0,128)});assert.equal(out.tenants.length,128);assert.equal(gets,128);assert.equal(iterations,0);assert.equal(reads,1);
        assert.throws(()=>startup.health(),/WHOLE_STARTUP_MAP/);assert.throws(()=>startup.tenants(),/WHOLE_STARTUP_MAP/);assert.equal(iterations,2,'negative full-view controls trip the actual guarded map');
      }finally{guarded=false;startup.close();global.Map=RealMap;}
    });
  });
