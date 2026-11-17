'use strict';
const assert=require('node:assert/strict');
const scope=require('../lib/storage/tenant-scope'),replay=require('../lib/storage/postgres-durable-replay'),stream=require('../lib/storage/clinical-stream-state');
const A='11111111-1111-4111-8111-111111111111',limits={maxRows:10,maxBytes:100000};
const snapshot={stream:require('./lib/clinical-stream-native').boundary,checkpoint:10,signature:{stamp:10,deleted:0},rows:[{domain:'entries',document:{_id:'a',sgv:123,date:1},ordinal:1,storageBytes:80}]};
function fixture(factory=replay){
 const queries=[],state=stream.bootstrap(null,snapshot,limits);
 let handle;
 const connection={snapshotTransaction:fn=>fn(),query:async(text)=>{queries.push(text);if(text.includes('FROM "synthetic_work"."tenant_consumer_checkpoint"'))return {rows:[{checkpoint:10,projection:[JSON.parse(JSON.stringify(state))],contract_digest:handle.snapshotDigest}]};throw new Error('WARM_CLINICAL_SOURCE_READ:'+text);}};
 handle=factory({connection,checkpointTable:'synthetic_work.tenant_consumer_checkpoint',clockTable:'synthetic_clock.tenant_write_clock',domains:{entries:'synthetic_entries.entries'},consumer:'evaluator-synthetic',projectionVersion:'clinical-current-rows-v1',pageSize:3,maxRows:10,stream:true});
 handle.configureStream({expectedSource:require('./lib/clinical-stream-native').source,generation:()=> '1',assertFence:async()=> '1',lockKey:'123',maxBytes:limits.maxBytes,recovery:{withSnapshot:({fn})=>fn(require('./lib/clinical-stream-native').boundary)}});
 return {handle,queries};
}
describe('streamed clinical input recovery through actual replay module',()=>{
 let previous;
 before(()=>{previous=scope.getTenancyMode();scope.setTenancyMode('multi');});
 after(()=>scope.setTenancyMode(previous));
 it('recovers committed working rows/stats after handle loss without clinical source query or routine catalogue lookup',async()=>{
  for(let process=0;process<2;process++){
   const f=fixture();const result=await scope.withTenant(A,()=>f.handle.reconcile({...limits,signature:true}));
   assert.equal(result.checkpoint,10);assert.equal(result.rows[0].document.sgv,123);assert.equal(result.stats.dataSize,80);
   assert.equal(f.queries.length,1);assert(!f.queries[0].includes('information_schema'));assert(!f.queries[0].includes('FOR UPDATE'),'WARM_ACCEPTED_STATE_MUST_NOT_LOCK_RECEIPT');
  }
 });
 it('control: restoring snapshot acquisition on warm events fails with source-read symptom, then restored source passes',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../lib/storage/postgres-durable-replay'),source=fs.readFileSync(file,'utf8');
  const needle='if (stream && streamState?.ready && saved.contract_digest === snapshotDigest &&';assert(source.includes(needle));
  const broken={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'if (false &&')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
  const f=fixture(broken.exports);await assert.rejects(scope.withTenant(A,()=>f.handle.reconcile({...limits,signature:true})),/WARM_CLINICAL_SOURCE_READ/);
  const restored=fixture();await scope.withTenant(A,()=>restored.handle.reconcile({...limits,signature:true}));
 });
});

// Recording SQL boundary for counter/control cases. Native exported snapshots,
// real typed completion and transport are exercised by the retained discriminator.
function recoveryFixture({factory=replay,floor=4,observed='4',completed='4',cold=false,sameGeneration=false,rebuild=false,sourceRows=1,badDigest=false,serializationOnce=false,uncertainOnce=false}={}){
 if(completed===null)completed=undefined;
 const native=require('./lib/clinical-stream-native'),work=require('../lib/pgstream/work-state'),journal=require('../lib/storage/storage-event-journal'),digest='b'.repeat(64),consumer='evaluator-synthetic',outputConsumer=consumer+'-completed';
 const boundary={...native.boundary,generation:sameGeneration?'epoch:1':'epoch:2',snapshot_position:'0/80'};
 const initial=cold?stream.empty():stream.bootstrap(null,{checkpoint:floor,signature:{stamp:floor,deleted:0},stream:{...native.boundary,generation:'epoch:1'},rows:[]},limits);
 if(rebuild){initial.ready=false;initial.rows=[];initial.gap='history';}
 const descriptor={consumer:outputConsumer,digest};let handle,active=null,recoveries=0;
 let durable={input:{checkpoint:floor,projection:[initial,journal.empty()]},output:{tenant:A,contract_digest:badDigest?'c'.repeat(64):digest,work_version:2,work_observed:work.array(observed===undefined?{}:{bootstrap:observed}),work_completed:work.array(completed===undefined?{}:{bootstrap:completed}),work_observed_at:work.array(observed===undefined?{}:{bootstrap:'1'}),work_pending_at:observed!==undefined&&(completed===undefined||BigInt(observed)>BigInt(completed))?1:null,work_due_at:null,work_completed_at:null,work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0',output_identity:null,output_digest:null,output_revision:'0',output_restore_generation:null,projection:[{kind:'evaluator-work-v2',output:null}]}};
 const queries=[];
 const connection={async query(text,args=[]){
  queries.push(text);const current=active||durable;
  if(text.startsWith('SELECT checkpoint,'))return {rows:[{...structuredClone(current.input),contract_digest:handle.snapshotDigest}]};
  if(text.startsWith('SELECT contract_digest,work_version,')){
   if(serializationOnce){serializationOnce=false;throw Object.assign(new Error('SERIALIZATION_REFUSED'),{code:'40001'});}return {rows:[structuredClone(current.output)]};
  }
  if(text.startsWith('SELECT tenant_id::text AS tenant'))return {rows:[structuredClone(current.output)]};
  if(text.startsWith('SELECT count(*)::text'))return {rows:[{row_count:String(sourceRows),document_bytes:String(sourceRows*80)}]};
  if(text.includes('information_schema.columns'))return {rows:[{name:'synthetic_entries.entries'}]};
  if(text.startsWith('SELECT domain,id_kind,doc,stamp'))return {rows:args.length>1?[]:Array.from({length:sourceRows},(_,i)=>({domain:'entries',id_kind:'string',doc:{_id:'snapshot-'+i,date:1,sgv:123},stamp:null,ordinal:i+1,storage_bytes:80}))};
  if(text.startsWith('WITH input')){const patch=JSON.parse(args[1])[0];Object.assign(current.output,{work_observed:patch.observed,work_observed_at:patch.observed_at,work_pending_at:patch.pending_at});return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET checkpoint=$3, projection=')){current.input={checkpoint:args[2],projection:[JSON.parse(args[3])[0],args[5]?JSON.parse(args[5]):current.input.projection[1]]};return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET delivery_revision=')){current.output.delivery_revision=String(BigInt(current.output.delivery_revision)+1n);return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET checkpoint=$3,work_completed=')){Object.assign(current.output,{work_completed:args[3],work_due_at:args[4],work_pending_at:args[5],work_completed_at:args[6],output_identity:args[7],output_digest:args[8],output_revision:String(args[9]),output_restore_generation:args[10]});if(args[12])current.output.projection=JSON.parse(args[12]);return {rowCount:1};}
  throw new Error('UNEXPECTED_RECOVERY_PROTOCOL_SQL:'+text);
 },async snapshotTransaction(fn){assert.equal(active,null);active=structuredClone(durable);try{const value=await fn();durable=active;active=null;return value;}catch(error){active=null;throw error;}},async holdAdvisoryLock(){return {available:true,withTenant:(tenant,fn)=>connection.snapshotTransaction(fn),close:async()=>{}};}};
 handle=factory({connection,checkpointTable:'synthetic_work.tenant_consumer_checkpoint',clockTable:'unused_clock.tenant_write_clock',domains:{entries:'synthetic_entries.entries'},consumer,projectionVersion:'clinical-current-rows-v1',pageSize:3,maxRows:10,stream:true});
 handle.configureStream({expectedSource:native.source,generation:()=>boundary.generation,assertFence:async()=>boundary.generation,lockKey:'123',maxBytes:limits.maxBytes,completed:()=>descriptor,recovery:{async withSnapshot({fn}){recoveries++;const result=await connection.snapshotTransaction(()=>fn(boundary));if(uncertainOnce){uncertainOnce=false;throw new Error('RECOVERY_COMMIT_REPLY_LOST');}return result;}}});
 const reconcile=extra=>scope.withTenant(A,()=>handle.reconcile({...limits,signature:true,...extra}));
 return {queries,connection,descriptor,reconcile,get recoveries(){return recoveries;},snapshot:()=>structuredClone(durable),async acceptLater(){return connection.snapshotTransaction(async()=>{active.input.projection[0]=stream.applyTransaction(active.input.projection[0],[stream.eventOf('entries',native.row('later',140))],{source_identity:native.source,generation:boundary.generation,position:'0/90'},limits);active.input.checkpoint=active.input.projection[0].floor;await work.observeInTransaction({client:connection,table:'synthetic_work.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:descriptor.digest,observations:[{tenant:A,observed:{bootstrap:String(active.input.checkpoint)}}]});});},useActualStore(){const store=require('../lib/pgstream/typed-checkpoint').create({connection,namespace:'synthetic_work',consumer,maxBytes:100000,timeIntervalMs:60000});descriptor.digest=store.digest;durable.output.contract_digest=store.digest;return store;}};
}
describe('durable generation recovery bootstrap obligation',()=>{
 let prior;before(()=>{prior=scope.getTenancyMode();scope.setTenancyMode('multi');});after(()=>scope.setTenancyMode(prior));
 it('mints owed work for a drained generation and commits it with input before returning',async()=>{
  const f=recoveryFixture();const result=await f.reconcile(),saved=f.snapshot();assert.equal(result.checkpoint,5);assert.equal(saved.input.checkpoint,5);assert.equal(saved.output.work_observed[5],'5');assert.equal(saved.output.work_completed[5],'4');assert.notEqual(saved.output.work_pending_at,null);assert.equal(saved.input.projection[0].stream.generation,'epoch:2');
 });
 it('reuses a genuinely pending covering token on cold startup and new generation',async()=>{
  for(const options of [{cold:true,floor:0,observed:'0',completed:null},{observed:'4',completed:'3'}]){
   const f=recoveryFixture(options);const result=await f.reconcile();assert.equal(result.checkpoint,options.floor??4);assert.equal(f.snapshot().output.work_observed[5],options.observed);assert.notEqual(f.snapshot().output.work_pending_at,null);
  }
 });
 it('keeps a drained same-source required-history rebuild durably owed',async()=>{
  const f=recoveryFixture({sameGeneration:true,rebuild:true});const result=await f.reconcile();assert.equal(result.checkpoint,5);assert.equal(f.snapshot().output.work_observed[5],'5');assert.equal(f.snapshot().output.work_completed[5],'4');assert.notEqual(f.snapshot().output.work_pending_at,null);assert.equal(f.snapshot().input.projection[0].stream.generation,'epoch:1');
 });
 it('does no new work or history query for compatible same-generation warm state',async()=>{
  const f=recoveryFixture({sameGeneration:true});await f.reconcile();assert.equal(f.recoveries,0);assert.equal(f.queries.length,1);assert.equal(f.snapshot().output.work_observed[5],'4');assert.equal(f.snapshot().output.work_pending_at,null);
 });
 it('refuses counter exhaustion, wrong completed digest and source overflow atomically',async()=>{
  for(const [options,extra,symptom]of [[{floor:8639999999999999,observed:'8639999999999999',completed:'8639999999999999'},undefined,/INVALID_STAMP/],[{badDigest:true},undefined,/COMPLETED_CONTRACT/],[{sourceRows:2},{maxRows:1},/ROW_BOUND/]]){
   const f=recoveryFixture(options),before=f.snapshot();await assert.rejects(f.reconcile(extra),symptom);assert.deepEqual(f.snapshot(),before,'REFUSED_RECOVERY_MUST_NOT_PARTIALLY_ACCEPT');
  }
 });
 it('retries RR serialization and uncertain committed replies without duplicate tokens',async()=>{
  const serial=recoveryFixture({serializationOnce:true});await assert.rejects(serial.reconcile(),error=>error.code==='40001');await serial.reconcile();assert.equal(serial.snapshot().output.work_observed[5],'5');
  const lost=recoveryFixture({uncertainOnce:true});await assert.rejects(lost.reconcile(),/RECOVERY_COMMIT_REPLY_LOST/);const committed=lost.snapshot();await lost.reconcile();assert.deepEqual(lost.snapshot(),committed);assert.equal(lost.recoveries,1);
 });
 it('actual typed completion never covers the freshly minted token or a later receipt using earlier captured work',async()=>{
  const f=recoveryFixture(),store=f.useActualStore();await store.own();const captured=await store.begin(A),recovered=await f.reconcile();assert.deepEqual(captured,{bootstrap:'4'});
  await f.acceptLater();const result={checkpoint:recovered.checkpoint,properties:{},emitted:[],requested:[],rows:[],frame:{lastUpdated:1},due:{dueAt:null,slow:[]}};
  const old=await scope.withTenant(A,()=>store.complete(A,{observed:captured,identity:'a'.repeat(64),result}));assert.notEqual(old.pendingAt,null);assert.equal(f.snapshot().output.work_completed[5],'4');assert.equal(f.snapshot().output.work_observed[5],'6');
  const before=f.queries.filter(q=>q.includes('snapshot_source')||q.includes('information_schema')).length,latest=await store.begin(A),warm=await f.reconcile();
  await scope.withTenant(A,()=>store.complete(A,{observed:latest,identity:'a'.repeat(64),result:{...result,checkpoint:warm.checkpoint}}));assert.equal(f.snapshot().output.work_pending_at,null);assert.equal(f.snapshot().output.work_completed[5],'6');assert.equal(f.queries.filter(q=>q.includes('snapshot_source')||q.includes('information_schema')).length,before,'FOLLOWUP_MUST_USE_WARM_INPUT');await store.close();
 });
 it('control: omitting recovery observation strands the token, restored atomic observation passes',async()=>{
  const control=require('./lib/clinical-working-set/control');const needle="if(recoveryWork)await require('../pgstream/work-state').observeInTransaction";
  const broken=control('../lib/storage/postgres-durable-replay',needle,"if(false)await require('../pgstream/work-state').observeInTransaction");
  const criterion=async factory=>{const f=recoveryFixture({factory});await f.reconcile();const row=f.snapshot().output;assert.notEqual(row.work_pending_at,null,'RECOVERY_WORK_MUST_REMAIN_DURABLE');};
  await assert.rejects(criterion(broken),/RECOVERY_WORK_MUST_REMAIN_DURABLE/);await criterion(replay);
 });
});
