'use strict';
const assert=require('node:assert/strict');
const completed=require('../lib/pgstream/realtime-output');
const runtime=require('../lib/server/realtime/runtime');
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
function fixture(ids){
 const counts={scanned:0,identities:0,revisions:0,acquired:0};
 const states=new Map(ids.map(tenant=>[tenant,{enabled:true,active:true,identity:tenant,revision:1}]));
 const invalidated=[];
 const detector=completed.detector({config:{completedOutput:{namespace:'test_completed',consumer:'evaluator-test'}},
   connection:{readOnly:async(text,args)=>{
     counts.revisions+=args[1].length;
     return {rows:args[1].map(tenant=>{
       const state=states.get(tenant);
       return {tenant,revision:String(state.revision),work_enabled:state.enabled,work_observed:state.observed,work_completed:state.completed};
     })};
   }},
   trusted:{scan:async tenants=>{counts.scanned+=tenants.length;return new Map(tenants.map(tenant=>[tenant,{activity:{state:states.get(tenant).active?'active':'paused'}}]));}},
   readAll:async tenants=>{counts.identities+=tenants.length;return new Map(tenants.map(tenant=>[tenant,{identity:states.get(tenant).identity}]));},
   owner:()=>{},onIneligible:tenant=>invalidated.push(tenant)});
 return {counts,states,invalidated,detector};
}
describe('addressed realtime output demand',function(){
 it('reads and reuses a native typed frame in a repeatable snapshot and refuses a stale restore generation',async()=>{
   const {createHash}=require('node:crypto');
   const {canonical}=require('../lib/server/serve/evaluator-runtime');
   const scope=require('../lib/storage/tenant-scope');
   const tenant=id(1),namespace='test_completed',consumer='evaluator-test',identity='current';
   const digest=createHash('sha256').update(canonical(['evaluator-work-v2',namespace,consumer])).digest('hex');
   const frame={sgvs:[],lastUpdated:100},summary={tenant,inputCheckpoint:2,checkpoint:2,trigger:'input'};
   const row={tenant,contract_digest:digest,work_version:2,work_enabled:true,
     output_identity:identity,output_digest:'a'.repeat(64),output_revision:'4',
     output_restore_generation:'7',output_summary:summary,frame_at:100};
   let generation='7',isolation='repeatable read',physical=0,snapshots=0,entered=false;
   const connection={
     async readOnlyTransaction(fn){
       snapshots++;entered=true;
       try{return await fn();}finally{entered=false;}
     },
     async query(sql,args){
       assert.equal(entered,true,'NATIVE_FRAME_REQUIRES_SNAPSHOT');
       assert.equal(scope.currentTenant(),tenant);
       assert.deepEqual(args,[tenant,consumer+'-completed']);
       if(sql.includes(' AS output_summary')){assert(sql.includes("current_setting('transaction_isolation') AS output_read_isolation"),'NATIVE_FRAME_REQUIRES_ISOLATION_OBSERVATION');return {rows:[{...row,output_read_isolation:isolation}]};}
       assert.match(sql,/^SELECT /);
       physical++;
       return {rows:[{output:{...summary,frame}}]};
     }
   };
   const previous=scope.getTenancyMode();
   scope.setTenancyMode('multi');
   try{
     const reader=completed.projection({config:{completedOutput:{namespace,consumer},maxBytes:100000},
       connection,current:{tenant,identity},operationWindow:{currentGeneration:()=>generation}});
     const current=await reader.acquire();
     assert.deepEqual(current.frame,frame);
     assert.equal(current.checkpoint,4);
     assert.equal(await reader.acquire(),current);
     assert.equal(physical,1);
     assert.equal(snapshots,2);
     generation='8';
     await assert.rejects(reader.acquire(),/REALTIME_COMPLETED_OUTPUT_RESTORE_GENERATION/);
     generation='7';
     assert.equal(await reader.acquire(),current);
     isolation='read committed';await assert.rejects(reader.acquire(),/EVALUATOR_OUTPUT_REPEATABLE_READ_REQUIRED/);assert.equal(physical,1,'WEAK_OUTER_TRANSACTION_MUST_NOT_FETCH_OR_REUSE_FRAME');
     isolation='serializable';assert.equal(await reader.acquire(),current);
     const readOnly=connection.readOnlyTransaction;connection.readOnlyTransaction=async fn=>fn();
     try{await assert.rejects(reader.acquire(),/NATIVE_FRAME_REQUIRES_SNAPSHOT/);}finally{connection.readOnlyTransaction=readOnly;}
     assert.equal(await reader.acquire(),current);
   }finally{scope.setTenancyMode(previous);}
 });
 for(const size of [8,64,256])for(const viewers of [0,1,4])it('reads identities only for '+viewers+' watched tenants of '+size+' addressed tenants',async()=>{
   const ids=Array.from({length:size},(_,i)=>id(i+1)),f=fixture(ids),watched=new Set(ids.slice(0,viewers));
   const service=await runtime({tenants:ids,isWatched:tenant=>watched.has(tenant),detect:f.detector,
     readCurrent:async tenant=>({tenant,identity:f.states.get(tenant).identity}),
     create:current=>({acquire:async()=>{f.counts.acquired++;return {tenant:current.tenant,checkpoint:f.states.get(current.tenant).revision,rows:[],frame:{}};}}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   try{
     const baseline=f.counts.acquired;
     for(const state of f.states.values())state.revision++;
     const outcomes=await service.check(ids);
     assert.equal(f.counts.scanned,size,'ALL_ADDRESSED_CONTROL_METADATA');assert.equal(f.counts.revisions,size,'ALL_ADDRESSED_OUTPUT_CONTROLS');
     assert.equal(f.counts.identities,viewers,'IDENTITY_WORK_FOLLOWS_WATCHERS');assert.equal(f.counts.acquired-baseline,viewers,'OUTPUT_ACQUISITION_FOLLOWS_WATCHERS');
     assert.ok([...outcomes.values()].every(Boolean));
     const before={...f.counts};await service.tick();assert.deepEqual(f.counts,before,'NO_IDLE_DISCOVERY');
   }finally{await service.close();}
 });
 it('invalidates unwatched lifecycle and activity refusals without loading their settings',async()=>{
   const ids=[id(1),id(2),id(3)],f=fixture(ids);
   f.states.get(ids[0]).enabled=false;f.states.get(ids[1]).active=false;
   const seen=await f.detector(ids,{interested:[]});
   assert.deepEqual(f.invalidated,ids.slice(0,2));assert.equal(f.counts.identities,0,'NO_INELIGIBLE_OR_UNWATCHED_SETTINGS');
   for(const tenant of ids.slice(0,2))assert.deepEqual(seen.get(tenant),{identity:null,stamp:null});
   assert.equal(seen.get(ids[2]).deferred,true);
 });
 it('loads settings only for completed interested output and checks control for every tenant', async function () {
   const [ready, first, behind, deferred, disabled] = Array.from({ length: 5 }, (_, i) => id(i + 1));
   const tenants = [ready, first, behind, deferred, disabled];
   const f = fixture(tenants);
   f.states.get(first).revision = 0;
   Object.assign(f.states.get(behind), { observed: ['9007199254740993'], completed: ['9007199254740992'] });
   f.states.get(disabled).enabled = false;
   const seen = await f.detector(tenants, { interested: [first, disabled, ready, behind] });
   assert.equal(f.counts.identities, 2, 'settings are read for the two completed interested tenants');
   assert.equal(f.counts.scanned, tenants.length);
   assert.equal(f.counts.revisions, tenants.length);
   assert.deepEqual(f.invalidated, [disabled]);
   assert.deepEqual(seen.get(ready), { identity: ready, stamp: '1' });
   assert.deepEqual(seen.get(first), { pending: true });
   assert.deepEqual(seen.get(behind), { identity: behind, stamp: '1' }, 'a completed revision is publishable while later input is pending');
   assert.deepEqual(seen.get(deferred), { deferred: true });
   assert.deepEqual(seen.get(disabled), { identity: null, stamp: null });
   await f.detector([first]);
   assert.equal(f.counts.identities, 2, 'a tenant with no completed output requires no settings');
   assert.equal(f.counts.identities, 2);
 });
 it('propagates checkpoint and completed settings failures while pending readers need no settings', async function () {
   const tenant = id(1);
   const settingsError = new Error('unavailable settings'), controlError = new Error('unavailable checkpoint');
   let revision = '0', failControl = false;
   const detect = completed.detector({
     config: { completedOutput: { namespace: 'test_completed', consumer: 'evaluator-test' } },
     trusted: { scan: async () => new Map([[tenant, { activity: { state: 'active' } }]]) },
     connection: { readOnly: async () => {
       if (failControl) throw controlError;
       return { rows: [{ tenant, revision, work_enabled: true }] };
     } },
     readAll: async () => { throw settingsError; }, owner() {}, onIneligible() {}
   });
   assert.deepEqual((await detect([tenant])).get(tenant), { pending: true });
   failControl = true;
   await assert.rejects(detect([tenant]), error => error === controlError);
   failControl = false;
   revision = '7';
   await assert.rejects(detect([tenant]), error => error === settingsError);
   assert.deepEqual(detect.stats(), { polls: 3, failures: 2 });
 });
 it('keeps direct detector callers eager and never reads ineligible settings',async()=>{
   const ids=[id(1),id(2)],f=fixture(ids);f.states.get(ids[0]).enabled=false;
   const seen=await f.detector(ids);assert.equal(f.counts.identities,1);assert.equal(seen.get(ids[1]).identity,ids[1]);
 });
 for(const indexed of [true,false])it('fresh viewer demand reads the current config after an unwatched settings change (indexed='+indexed+')',async()=>{
   const tenant=id(1),f=fixture([tenant]);let watched=false,identity=tenant;
   const service=await runtime({tenants:[tenant],isWatched:()=>watched,detect:f.detector,
     readCurrent:async()=>({tenant,identity}),create:current=>({acquire:async()=>({tenant,checkpoint:f.states.get(tenant).revision,frame:{title:current.identity},rows:[]})}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   try{
     identity='new-settings';Object.assign(f.states.get(tenant),{identity,revision:2});
     await service.check([tenant]);assert.equal(f.counts.identities,0);assert.equal(service.last(tenant).frame.title,tenant);
     watched=indexed;const demand=service.fresh(tenant);demand.catch(()=>{});await service.tick();
     assert.equal(f.counts.identities,1,'EXPLICIT_FRESH_DEMAND_REQUIRES_IDENTITY');const fresh=await demand;assert.equal(fresh.frame.title,identity);
   }finally{await service.close();}
 });
 it('retires a held fanout before restore completes and admits the next projection', async function () {
   const tenant = id(1), published = [];
   let begin, resume, revision = 1;
   const entered = new Promise(resolve => { begin = resolve; });
   const held = new Promise(resolve => { resume = resolve; });
   const service = await runtime({
     tenants: [tenant], readCurrent: async () => ({ tenant, identity: tenant }),
     create: () => ({ acquire: async () => ({ tenant, checkpoint: revision, rows: [], frame: {} }) }),
     async fanout ({ next, assertCurrent }) {
       if (next.checkpoint === 2) { begin(); await held; }
       assertCurrent();
       published.push(next.checkpoint);
     },
     schedule: () => 1, cancel () {}
   });
   let old;
   try {
     revision = 2; old = service.refresh(tenant);
     old.catch(() => {});
     await entered;
     let invalidated = false;
     const invalidating = service.invalidateTenant(tenant, { restoring: true }).then(() => { invalidated = true; });
     await new Promise(resolve => setImmediate(resolve));
     assert.equal(invalidated, true, 'RESTORE_MUST_NOT_DRAIN_HELD_FANOUT');
     assert.equal(service.last(tenant), null);
     revision = 3; await service.refresh(tenant);
     assert.equal(service.last(tenant).checkpoint, 3);
     resume(); await assert.rejects(old, /REALTIME_CYCLE_CHANGED/); await invalidating;
     assert.deepEqual(published, [1, 3], 'STALE_FRAME_MUST_NOT_BE_SENT');
     assert.equal(service.last(tenant).checkpoint, 3);
   } finally { resume(); await old?.catch(() => {}); await service.close(); }
 });
 it('retains viewer demand arriving while an unwatched control read is held',async()=>{
   const tenant=id(1),f=fixture([tenant]);let watched=false,entered,release,hold=true;
   const blocked=new Promise(resolve=>{entered=resolve;});
   const detect=async(tenants,options)=>{if(hold){hold=false;entered();await new Promise(resolve=>{release=resolve;});}return f.detector(tenants,options);};
   const service=await runtime({tenants:[tenant],isWatched:()=>watched,detect,
     readCurrent:async()=>({tenant,identity:f.states.get(tenant).identity}),
     create:()=>({acquire:async()=>({tenant,checkpoint:f.states.get(tenant).revision,frame:{},rows:[]})}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   try{
     f.states.get(tenant).revision=2;const check=service.check([tenant]);await blocked;
     watched=true;const fresh=service.fresh(tenant);release();await check;
     assert.equal((await fresh).checkpoint,2,'ARRIVING_VIEWER_MUST_GET_NEW_GENERATION');
     assert.equal(f.counts.identities,1,'DEFERRED_BATCH_MUST_NOT_CONSUME_NEW_VIEWER_DEMAND');
   }finally{await service.close();}
 });
 it('keeps known cold retries eligible for identity reads with no viewers',async()=>{
   const tenant=id(1),f=fixture([tenant]);let at=0,fail=true,attempts=0;
   const service=await runtime({tenants:[tenant],readiness:'serve',now:()=>at,failureRetryMs:100,
     isWatched:()=>false,detect:f.detector,readCurrent:async()=>({tenant,identity:tenant}),
     create:()=>({acquire:async()=>{attempts++;if(fail)throw Error('OUTPUT_UNAVAILABLE');return {tenant,checkpoint:1,frame:{},rows:[]};}}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   try{
     await service.tick();assert.equal(attempts,1);at=99;await service.tick();assert.equal(attempts,1,'NOT_DUE_MUST_NOT_RETRY');
     at=100;fail=false;await service.check([tenant]);assert.equal(f.counts.identities,1,'KNOWN_COLD_DEMAND_RETAINS_CONFIG');assert.equal(service.warm(tenant),true);
   }finally{await service.close();}
 });
 it('refuses a config generation changed while fresh output acquisition is held',async()=>{
   const tenant=id(1),f=fixture([tenant]);let identity=tenant,hold=false,entered,release,sends=0;
   const blocked=new Promise(resolve=>{entered=resolve;});
   const service=await runtime({tenants:[tenant],isWatched:()=>false,detect:f.detector,
     readCurrent:async()=>({tenant,identity}),create:()=>({acquire:async()=>{if(hold){entered();await new Promise(resolve=>{release=resolve;});}return {tenant,checkpoint:1,frame:{},rows:[]};}}),
     fanout:async()=>{sends++;},schedule:()=>1,cancel(){}});
   try{
     hold=true;const fresh=service.fresh(tenant),refused=assert.rejects(fresh,/REALTIME_CYCLE_CHANGED/);await blocked;
     identity='changed-generation';release();await refused;assert.equal(sends,1,'STALE_GENERATION_MUST_NOT_FANOUT');assert.equal(service.last(tenant),null);
   }finally{await service.close();}
 });
 it('recovers pending output without a hint after consumer startup',async()=>{
   const tenant=id(1),f=fixture([tenant]);
   const service=await runtime({tenants:[tenant],isWatched:()=>true,detect:f.detector,
     readCurrent:async()=>({tenant,identity:tenant}),create:()=>({acquire:async()=>({tenant,checkpoint:f.states.get(tenant).revision,frame:{},rows:[]})}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   const timers=[];let rows=[{tenant,received:'2'}],completed=0;
   f.states.get(tenant).revision=2;
   // Startup reconciliation reads the committed obligation; no hint is needed.
   const drain=require('../lib/pgstream/realtime-receipt').start({jobContext:require('../lib/server/serve/evaluator-job-context').create('delivery'),
     store:{pending:async()=>rows.map(row=>row.tenant),work:async ids=>{assert.deepEqual(ids,[tenant]);return rows;},finish:async(page,outcomes)=>{assert.deepEqual(page,[{tenant,received:'2'}]);assert.equal(outcomes.get(tenant),true,'RECOVERED_OUTPUT_MUST_NOT_RETRY');completed++;rows=[];}},
     check:tenants=>service.check(tenants),setTimer:(fn,ms)=>{timers.push({fn,ms});return 1;},clearTimer(){}});
   try{
     assert.deepEqual(timers.map(timer=>timer.ms),[0,30000],'STARTUP_RECONCILIATION_AND_BOUNDED_RECOVERY');await timers.shift().fn();await new Promise(resolve=>setImmediate(resolve));
     assert.equal(service.last(tenant).checkpoint,2,'STARTUP_RECOVERS_WITHOUT_RECEIVE_HINT');assert.equal(completed,1);assert.deepEqual(timers.map(timer=>timer.ms),[30000],'ONLY_THE_BOUNDED_RECOVERY_TIMER');
   }finally{await drain.close();await service.close();}
 });
 it('rejects foreign interest before any metadata or output read',async()=>{
   const f=fixture([id(1)]);await assert.rejects(f.detector([id(1)],{interested:[id(2)]}),/interest/i);assert.equal(f.counts.scanned,0);assert.equal(f.counts.revisions,0);
 });
});

// Completed-output mode has one retry owner: durable receipts. The runtime
// handles addressed connection demand, but never duplicates the receipt timer.
describe('durable output retry ownership and upstream pending',()=>{
 it('keeps upstream pending distinct from failed delivery and wakes only on completed output or demand',async()=>{
  const tenant=id(1),timers=[];let pending=true,acquired=0;
  const service=await runtime({tenants:[tenant],durableOutput:true,readiness:'serve',isWatched:()=>true,
   detect:async()=>new Map([[tenant,pending?{pending:true}:{identity:'current',stamp:'1'}]]),readCurrent:async()=>({tenant,identity:'current'}),
   create:()=>({acquire:async()=>{acquired++;return {tenant,checkpoint:1,frame:{},rows:[]};}}),fanout:async()=>{},schedule:fn=>{timers.push(fn);return 1;},cancel(){}});
  try{
   const first=await service.check([tenant]);assert.equal(first.get(tenant),true,'PENDING_WAITS_FOR_NEW_DURABLE_OUTPUT');
   assert.equal(service.health().upstreamPending,1);assert.equal(service.health().failed,0);assert.equal(acquired,0);assert.equal(timers.length,0,'NO_DUPLICATE_PENDING_RETRY');
   pending=false;const next=await service.check([tenant]);assert.equal(next.get(tenant),true);assert.equal(acquired,1);assert.equal(service.warm(tenant),true);assert.equal(timers.length,0);
  }finally{await service.close();}
 });
 it('keeps actual failed delivery owed to durable retry without a second runtime retry timer',async()=>{
  const tenant=id(1),timers=[];let refuse=true,deliveries=0;
  const service=await runtime({tenants:[tenant],durableOutput:true,readiness:'serve',isWatched:()=>true,
   detect:async()=>new Map([[tenant,{identity:'current',stamp:'1'}]]),readCurrent:async()=>({tenant,identity:'current'}),create:()=>({acquire:async()=>({tenant,checkpoint:1,frame:{},rows:[]})}),
   fanout:async()=>{deliveries++;if(refuse)throw Error('SYNTHETIC_DELIVERY_FAILURE');},schedule:fn=>{timers.push(fn);return 1;},cancel(){}});
  try{
   assert.equal((await service.check([tenant])).get(tenant),false,'FAILED_DELIVERY_STAYS_OWED');assert.equal(service.health().failed,1);assert.equal(timers.length,0,'ONE_RETRY_OWNER');
   refuse=false;assert.equal((await service.check([tenant])).get(tenant),true);assert.equal(deliveries,2);
  }finally{await service.close();}
 });
});
