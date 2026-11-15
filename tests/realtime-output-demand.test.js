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
   connection:{readOnly:async(text,args)=>{counts.revisions+=args[1].length;return {rows:args[1].map(tenant=>({tenant,revision:String(states.get(tenant).revision),work_enabled:states.get(tenant).enabled}))};}},
   trusted:{scan:async tenants=>{counts.scanned+=tenants.length;return new Map(tenants.map(tenant=>[tenant,{activity:{state:states.get(tenant).active?'active':'paused'}}]));}},
   readAll:async tenants=>{counts.identities+=tenants.length;return new Map(tenants.map(tenant=>[tenant,{identity:states.get(tenant).identity}]));},
   owner:()=>{},onIneligible:tenant=>invalidated.push(tenant)});
 return {counts,states,invalidated,detector};
}
describe('addressed realtime output demand',function(){
 for(const size of [8,64,256])for(const viewers of [0,1,4])it('reads identities only for '+viewers+' watched tenants of '+size+' addressed tenants',async()=>{
   const ids=Array.from({length:size},(_,i)=>id(i+1)),f=fixture(ids),watched=ids.slice(0,viewers);
   const service=await runtime({tenants:ids,watchedTenants:()=>watched,detect:f.detector,
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
 it('keeps direct detector callers eager and never reads ineligible settings',async()=>{
   const ids=[id(1),id(2)],f=fixture(ids);f.states.get(ids[0]).enabled=false;
   const seen=await f.detector(ids);assert.equal(f.counts.identities,1);assert.equal(seen.get(ids[1]).identity,ids[1]);
 });
 for(const indexed of [true,false])it('fresh viewer demand reads the current config after an unwatched settings change (indexed='+indexed+')',async()=>{
   const tenant=id(1),f=fixture([tenant]);let watched=[],identity=tenant;
   const service=await runtime({tenants:[tenant],watchedTenants:()=>watched,detect:f.detector,
     readCurrent:async()=>({tenant,identity}),create:current=>({acquire:async()=>({tenant,checkpoint:f.states.get(tenant).revision,frame:{title:current.identity},rows:[]})}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   try{
     identity='new-settings';Object.assign(f.states.get(tenant),{identity,revision:2});
     await service.check([tenant]);assert.equal(f.counts.identities,0);assert.equal(service.last(tenant).frame.title,tenant);
     watched=indexed?[tenant]:[];const demand=service.fresh(tenant);demand.catch(()=>{});await service.tick();
     assert.equal(f.counts.identities,1,'EXPLICIT_FRESH_DEMAND_REQUIRES_IDENTITY');const fresh=await demand;assert.equal(fresh.frame.title,identity);
   }finally{await service.close();}
 });
 it('retains viewer demand arriving while an unwatched control read is held',async()=>{
   const tenant=id(1),f=fixture([tenant]);let watched=[],entered,release,hold=true;
   const blocked=new Promise(resolve=>{entered=resolve;});
   const detect=async(tenants,options)=>{if(hold){hold=false;entered();await new Promise(resolve=>{release=resolve;});}return f.detector(tenants,options);};
   const service=await runtime({tenants:[tenant],watchedTenants:()=>watched,detect,
     readCurrent:async()=>({tenant,identity:f.states.get(tenant).identity}),
     create:()=>({acquire:async()=>({tenant,checkpoint:f.states.get(tenant).revision,frame:{},rows:[]})}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   try{
     f.states.get(tenant).revision=2;const check=service.check([tenant]);await blocked;
     watched=[tenant];const fresh=service.fresh(tenant);release();await check;
     assert.equal((await fresh).checkpoint,2,'ARRIVING_VIEWER_MUST_GET_NEW_GENERATION');
     assert.equal(f.counts.identities,1,'DEFERRED_BATCH_MUST_NOT_CONSUME_NEW_VIEWER_DEMAND');
   }finally{await service.close();}
 });
 it('keeps known cold retries eligible for identity reads with no viewers',async()=>{
   const tenant=id(1),f=fixture([tenant]);let at=0,fail=true,attempts=0;
   const service=await runtime({tenants:[tenant],readiness:'serve',now:()=>at,failureRetryMs:100,
     watchedTenants:()=>[],detect:f.detector,readCurrent:async()=>({tenant,identity:tenant}),
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
   const service=await runtime({tenants:[tenant],watchedTenants:()=>[],detect:f.detector,
     readCurrent:async()=>({tenant,identity}),create:()=>({acquire:async()=>{if(hold){entered();await new Promise(resolve=>{release=resolve;});}return {tenant,checkpoint:1,frame:{},rows:[]};}}),
     fanout:async()=>{sends++;},schedule:()=>1,cancel(){}});
   try{
     hold=true;const fresh=service.fresh(tenant),refused=assert.rejects(fresh,/REALTIME_CYCLE_CHANGED/);await blocked;
     identity='changed-generation';release();await refused;assert.equal(sends,1,'STALE_GENERATION_MUST_NOT_FANOUT');assert.equal(service.last(tenant),null);
   }finally{await service.close();}
 });
 it('recovers pending output without a hint after consumer startup',async()=>{
   const tenant=id(1),f=fixture([tenant]);
   const service=await runtime({tenants:[tenant],watchedTenants:()=>[tenant],detect:f.detector,
     readCurrent:async()=>({tenant,identity:tenant}),create:()=>({acquire:async()=>({tenant,checkpoint:f.states.get(tenant).revision,frame:{},rows:[]})}),
     fanout:async()=>{},schedule:()=>1,cancel(){}});
   const timers=[];let rows=[{tenant,received:'2'}],completed=0;
   f.states.get(tenant).revision=2;
   const drain=require('../lib/pgstream/realtime-receipt').start({jobContext:require('../lib/server/serve/evaluator-job-context').create('delivery'),
     store:{work:async()=>rows,nextDue:async()=>null,complete:async(t,revision)=>{assert.equal(t,tenant);assert.equal(revision,'2');completed++;rows=[];},retry:async()=>assert.fail('RECOVERED_OUTPUT_MUST_NOT_RETRY')},
     check:tenants=>service.check(tenants),setTimer:fn=>{timers.push(fn);return 1;},clearTimer(){}});
   try{
     assert.equal(timers.length,1);await timers.shift()();await new Promise(resolve=>setImmediate(resolve));
     assert.equal(service.last(tenant).checkpoint,2,'STARTUP_RECOVERS_WITHOUT_RECEIVE_HINT');assert.equal(completed,1);assert.equal(timers.length,0);
   }finally{await drain.close();await service.close();}
 });
 it('rejects foreign interest before any metadata or output read',async()=>{
   const f=fixture([id(1)]);await assert.rejects(f.detector([id(1)],{interested:[id(2)]}),/interest/i);assert.equal(f.counts.scanned,0);assert.equal(f.counts.revisions,0);
 });
});
