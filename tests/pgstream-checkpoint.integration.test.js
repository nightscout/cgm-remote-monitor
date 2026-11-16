'use strict';
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {optInSuite}=require('./support/opt-in');
const scope=require('../lib/storage/tenant-scope');
const {create}=require('../lib/pgstream/checkpoint');
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('pgstream observed and completed checkpoints on actual PostgreSQL',function(){
 this.timeout(30000);const lab=require('./fixtures/tenant-projection-evaluator')();let store;
 before(async()=>{await lab.open();for(const namespace of new Set(Object.values(lab.tables).map(table=>table.split('.')[0]))){if((await lab.admin.query('SELECT to_regclass($1) AS counter',[namespace+'.tenant_insertion_ordinal'])).rows[0].counter)await lab.admin.query(`GRANT SELECT ON "${namespace}".tenant_insertion_ordinal TO "${lab.readerRole}"`);}await lab.admin.query(`CREATE POLICY pgstream_completed_metadata ON "${lab.replayNamespace}".tenant_consumer_checkpoint TO "${lab.readerRole}" USING (consumer='evaluator-roles-completed') WITH CHECK (consumer='evaluator-roles-completed')`);});
 beforeEach(async()=>{await lab.reset();store=create({connection:lab.reader,namespace:lab.replayNamespace,consumer:'evaluator-roles',maxBytes:4*1024*1024,timeIntervalMs:60000});for(const tenant of [lab.A,lab.B]){await lab.provisionView(tenant);await lab.provision(store.consumer,tenant,null,0,store.digest);}await store.own(()=>{});});
 afterEach(async()=>{await store?.close();});after(()=>lab.close());
 const result=()=>({checkpoint:1,signature:{stamp:1,deleted:0},properties:{},emitted:[],requested:[],frame:{delta:false,sgvs:[],lastUpdated:Date.now()},rows:[],due:{dueAt:Date.now()+10000,slow:[]},trigger:'acquisition'});
 const output=async tenant=>(await lab.checkpoint(store.consumer,tenant)).projection?.[0];
 it('admits the actual role checkpoint metadata grant and detects a removed bookkeeping grant',async()=>{await lab.admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');const config={namespaces:{...Object.fromEntries(Object.entries(lab.tables).map(([name,table])=>[name,table.split('.')[0]])),clock:lab.namespaces.clock,checkpoint:lab.replayNamespace},socketOrderDomains:[]};const screen=()=>lab.reader.withTenant(lab.A,()=>require('../lib/server/serve/evaluator-readiness').screen(lab.reader,config));await screen();await lab.admin.query(`REVOKE UPDATE(contract_digest) ON "${lab.replayNamespace}".tenant_consumer_checkpoint FROM "${lab.readerRole}"`);try{await assert.rejects(screen(),/unsafe evaluator table privileges/);}finally{await lab.admin.query(`GRANT UPDATE(contract_digest) ON "${lab.replayNamespace}".tenant_consumer_checkpoint TO "${lab.readerRole}"`);}await screen();});
 it('coalesces monotone committed versions before completion, including paused receipt',async()=>{
   await store.observe(lab.A,'clock','3');await store.observe(lab.A,'clock','2');await store.observe(lab.B,'activity','1',false);
   assert.deepEqual((await output(lab.A)).observed,{clock:'3'});assert.deepEqual((await output(lab.A)).completed,{});
   assert.equal((await output(lab.A)).output,null);assert.deepEqual((await store.work()).map(row=>row.tenant),[lab.A]);
   await store.observe(lab.B,'activity','2',true);assert.equal((await store.work()).length,2);
 });
 it('keeps a newer observed version pending when an older cycle completes; refuses rollback',async()=>{
   await store.observe(lab.A,'clock','1');const observed=await scope.withTenant(lab.A,()=>store.begin(lab.A));
   await store.observe(lab.A,'clock','2');const first=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:result()}));
   assert.equal(first.output.outputRevision,1);assert.deepEqual((await output(lab.A)).completed,{clock:'1'});assert.equal((await store.work()).length,1);
   const next=await scope.withTenant(lab.A,()=>store.begin(lab.A));await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:next,identity:'a'.repeat(64),result:result()}));
   assert.equal((await output(lab.A)).pendingAt,null);
   await assert.rejects(scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:result()})),/COMPLETION_VERSION_REFUSED/);
 });
 it('moves pending age to newer remaining work only after a real completion',async()=>{await store.observe(lab.A,'clock','1');const observed=await store.begin(lab.A),first=(await output(lab.A)).pendingAt;await new Promise(resolve=>setTimeout(resolve,20));const arrival=Date.now();await store.observe(lab.A,'clock','2');assert.equal((await output(lab.A)).pendingAt,first,'new writes cannot hide stalled completion');await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:result()}));assert((await output(lab.A)).pendingAt>=arrival,'completed old work must not age newer pending work');});
 it('persists output, completed versions and next due together; unchanged content retains revision',async()=>{
   await store.observe(lab.A,'clock','1');const observed=await scope.withTenant(lab.A,()=>store.begin(lab.A)),cycle=result();
   await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:cycle}));
   const changed={...cycle,frame:{...cycle.frame,lastUpdated:cycle.frame.lastUpdated+1000}};
   const second=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:changed}));assert.equal(second.changed,false);assert.equal(second.output.outputRevision,1);
   assert.equal((await output(lab.A)).nextDueAt,cycle.due.dueAt);assert.deepEqual((await output(lab.A)).completed,{clock:'1'});
   await store.close();const restored=create({connection:lab.reader,namespace:lab.replayNamespace,consumer:'evaluator-roles',maxBytes:4*1024*1024,timeIntervalMs:60000,now:()=>cycle.due.dueAt+1});
   assert.equal((await restored.work()).length,1);assert.equal((await restored.work())[0].tenant,lab.A);
 });
 it('refuses persisted output across pause and unpause until current control versions complete',async()=>{await store.observe(lab.A,'clock','1');await store.observe(lab.A,'activity','1',true);let observed=await store.begin(lab.A);await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:result()}));assert(await store.output(lab.A,'a'.repeat(64)));await store.observe(lab.A,'activity','2',false);await assert.rejects(store.output(lab.A,'a'.repeat(64)),/CONTROL_PENDING/);await store.observe(lab.A,'activity','3',true);await assert.rejects(store.output(lab.A,'a'.repeat(64)),/CONTROL_PENDING/);observed=await store.begin(lab.A);await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:result()}));assert(await store.output(lab.A,'a'.repeat(64)));});
 it('reads pending and begin metadata without transferring the persisted clinical output',async()=>{
   await store.observe(lab.A,'clock','1');const observed=await store.begin(lab.A),cycle=result();
   cycle.frame.sgvs=[{synthetic:'x'.repeat(32768)}];
   await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:cycle}));
   await store.observe(lab.A,'clock','2');
   const received=[];const bounded=create({connection:{...lab.reader,
     query:async(...args)=>{const value=await lab.reader.query(...args);received.push(Buffer.byteLength(JSON.stringify(value.rows)));return value;},
     readOnly:async(...args)=>{const value=await lab.reader.readOnly(...args);received.push(Buffer.byteLength(JSON.stringify(value.rows)));return value;}
   },namespace:lab.replayNamespace,consumer:'evaluator-roles',maxBytes:4*1024*1024,timeIntervalMs:60000});
   assert.deepEqual((await bounded.work()).map(row=>({tenant:row.tenant,pending:row.pendingAt!==null})),[{tenant:lab.A,pending:true}]);
   const snapshot=await bounded.begin(lab.A);assert.deepEqual(snapshot,{clock:'2'});snapshot.clock='999';
   assert(received.every(bytes=>bytes<2048),'CHECKPOINT_METADATA_MUST_NOT_TRANSFER_CLINICAL_OUTPUT');
   const persisted=await output(lab.A);assert.equal(persisted.observed.clock,'2');assert.equal(persisted.completed.clock,'1');
   assert.equal(persisted.output.frame.sgvs[0].synthetic.length,32768);
 });
 it('reuses matched completed output without transferring frame/rows and atomically patches TIME due metadata',async()=>{
   await store.observe(lab.A,'clock','1');const observed=await store.begin(lab.A),cycle=result();cycle.frame.sgvs=[{synthetic:'x'.repeat(32768)}];
   const first=await store.complete(lab.A,{observed,identity:'a'.repeat(64),result:cycle});
   const received=[],sent=[];
   const bounded=create({connection:{...lab.reader,async query(...args){const value=await lab.reader.query(...args);received.push(Buffer.byteLength(JSON.stringify(value.rows)));if(args[0].startsWith('UPDATE'))sent.push(args[1][3]);return value;}},namespace:lab.replayNamespace,consumer:'evaluator-roles',maxBytes:4*1024*1024,timeIntervalMs:60000});
   await store.close();await bounded.own(()=>{});
   try{
     const next=await bounded.complete(lab.A,{observed,identity:'a'.repeat(64),result:{...cycle,frame:{...cycle.frame,lastUpdated:cycle.frame.lastUpdated+1000},due:{dueAt:cycle.due.dueAt+1000,slow:[]}},retainedOutput:{...first.output,runtimeId:'existing-runtime'}});
     assert.equal(next.changed,false);assert.equal(next.output.outputRevision,1);
     assert(received.every(bytes=>bytes<4096),'MATCHED_COMPLETION_MUST_NOT_TRANSFER_CLINICAL_FRAME');
     assert.equal(sent.length,1);assert(!Object.hasOwn(JSON.parse(sent[0]),'output'),'UNCHANGED_OUTPUT_MUST_NOT_BE_SENT');
     const persisted=await output(lab.A);assert.deepEqual(persisted.output,JSON.parse(JSON.stringify(first.output)));assert.deepEqual(persisted.completed,observed);assert.equal(persisted.nextDueAt,cycle.due.dueAt+1000);
   }finally{await bounded.close();}
 });
 it('aborts completion after actual ownership-backend death while the row update is held',async()=>{
   await store.observe(lab.A,'clock','1');const observed=await scope.withTenant(lab.A,()=>store.begin(lab.A));
   const control=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI});await control.connect();
   await lab.admin.query('BEGIN');await lab.admin.query(`SELECT 1 FROM "${lab.replayNamespace}".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE`,[lab.A,store.consumer]);
   const completion=scope.withTenant(lab.A,()=>store.complete(lab.A,{observed,identity:'a'.repeat(64),result:result()}));completion.catch(()=>{});
   try{let pid;const end=Date.now()+5000;while(!pid&&Date.now()<end){pid=(await control.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",[lab.readerRole])).rows[0]?.pid;if(!pid)await new Promise(r=>setTimeout(r,10));}
     assert(pid,'completion must reach an actual row-lock wait on the owner backend');await control.query('SELECT pg_terminate_backend($1)',[pid]);await assert.rejects(completion);
   }finally{await lab.admin.query('ROLLBACK');await control.end();}
   assert.equal((await output(lab.A)).output,null);assert.deepEqual((await output(lab.A)).completed,{});assert.equal(store.available,false);
 });
 it('reconstructs retained overdue work before serve boot without a clinical write or duplicate revision',async()=>{
   const at=Date.now(),env=require('../lib/server/tenant-app/environment')({settings:{enable:['bgnow']}});
   await lab.persistDomains({entries:[{_id:'retained-overdue',type:'sgv',sgv:123,date:at-60000,dateString:new Date(at-60000).toISOString()}]},lab.B);
   await store.observe(lab.A,'clock','1');await store.observe(lab.B,'clock',String((await lab.clock(lab.B)).stamp));
   const seed=lab.evaluator(lab.B,{env,includeFrame:true});
   const seeded=await scope.withTenant(lab.B,()=>seed.evaluate({at}));seed.close();
   await store.complete(lab.B,{observed:await store.begin(lab.B),identity:'a'.repeat(64),result:seeded});
   await lab.admin.query(`UPDATE "${lab.replayNamespace}".tenant_consumer_checkpoint SET projection=jsonb_set(projection,'{0,nextDueAt}',$3::jsonb) WHERE tenant_id=$1 AND consumer=$2`,[lab.B,store.consumer,String(at-1)]);
   const before=await output(lab.B),clock=await lab.clock(lab.B),work=await store.work();
   const due=work.find(row=>row.tenant===lab.B);assert(due);assert.equal(due.pendingAt,null);
   let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
   const window=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true});await window.window.ready();
   const jobs=require('../lib/server/serve/evaluator-job-context').create('clinical');
   const service=await require('../lib/server/serve/evaluator-runtime')({tenants:[lab.A,lab.B],operationWindow:window.window,jobContext:jobs,
     boot:'serve',bootConcurrency:1,workerState:()=>({available:true,generation:1}),externalRecovery:true,now:()=>at,
     readCurrent:async tenant=>({tenant,identity:'a'.repeat(64)}),
     create:async current=>{const component=lab.evaluator(current.tenant,{env,includeFrame:true});return current.tenant===lab.A?{...component,evaluate:async args=>{entered();await gate;return component.evaluate(args);}}:component;},
     durable:{begin:store.begin,complete:store.complete},recoveryIntervalMs:1000,timeIntervalMs:60000,schedule:()=>1,cancel(){},setTimer:()=>1,clearTimer(){}});
   // The common scheduler owns startup; this runtime primitive is addressed explicitly.
   const acquisition=service.acquire(lab.A);
   try{
     await started;await service[due.pendingAt!==null?'acquire':'tick'](due.tenant);
     const current=await output(lab.B),progress=service.health([lab.B]).tenants[0].progress;
     assert.equal(progress.failedCompletions,0,'NATIVE_COLD_DUE_MUST_ACQUIRE');assert.equal(progress.completedAcquisitions,1);
     assert.equal(current.output.frame.sgvs[0].mgdl,123);assert.equal(current.output.outputRevision,before.output.outputRevision,'RETAINED_CONTENT_REVISION_MUST_NOT_DUPLICATE');
     assert.deepEqual(current.completed,current.observed);
     assert.equal(seeded.due.dueAt,null);assert.deepEqual(seeded.due.slow,[]);
     assert.equal(current.nextDueAt,seeded.due.dueAt);assert.deepEqual(current.output.result.due,seeded.due);
     assert.deepEqual(await lab.clock(lab.B),clock,'NO_CLINICAL_WRITE_FOR_RECOVERY');
     console.log('PGSTREAM_RETAINED_DUE '+JSON.stringify({computed:seeded.due,persisted:current.nextDueAt}));
   }finally{release();await acquisition;await service.close();await window.window.close();}
 });

});
