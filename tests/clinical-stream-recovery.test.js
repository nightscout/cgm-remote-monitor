'use strict';
const assert=require('node:assert/strict');
const scope=require('../lib/storage/tenant-scope'),replay=require('../lib/storage/postgres-durable-replay'),stream=require('../lib/storage/clinical-stream-state');
const A='11111111-1111-4111-8111-111111111111',limits={maxRows:10,maxBytes:100000};
// PostgreSQL jsonb does not preserve JavaScript property insertion order.
const jsonb=value=>JSON.parse(JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item));
const sourceAccess = f => f.queries.filter(q=>q.includes('snapshot_source')||q.includes('information_schema')).length;
describe('RAM clinical input recovery through actual replay module',()=>{
 let previous;
 before(()=>{previous=scope.getTenancyMode();scope.setTenancyMode('multi');});
 after(()=>scope.setTenancyMode(previous));
 it('rebuilds cold process input once and uses RAM for unchanged warm input without source access',async()=>{
  const f=recoveryFixture({sameGeneration:true});
  const first=await f.reconcile();assert.equal(first.rows[0].document.sgv,123);assert.equal(first.stats.dataSize,80);
  assert.equal(f.recoveries,1);assert(sourceAccess(f)>0);assert.equal(f.snapshot().input.projection[0].rows,undefined,'DURABLE_INPUT_MUST_BE_COMPACT');
  const before=sourceAccess(f),queries=f.queries.length;
  const warm=await f.reconcile();assert.deepEqual(warm,first);assert.equal(sourceAccess(f),before,'WARM_SOURCE_REACQUISITION');
  assert(f.queries.slice(queries).every(q=>!q.includes('FOR UPDATE')),'WARM_ACCEPTED_STATE_MUST_NOT_LOCK_RECEIPT');
  f.restart();await f.reconcile();assert.equal(f.recoveries,2);assert(sourceAccess(f)>before,'COLD_CACHE_MUST_REBUILD');
 });
 it('control: forced warm snapshot acquisition turns actual source-access witness red; restored source passes',async()=>{
  const control=require('./lib/clinical-working-set/control');
  const needle='if (stream && cached && streamState?.ready && saved.contract_digest === snapshotDigest &&';
  const broken=control('../lib/storage/postgres-durable-replay',needle,'if (false &&');
  const criterion=async factory=>{const f=recoveryFixture({factory,sameGeneration:true});await f.reconcile();const before=sourceAccess(f);await f.reconcile();assert.equal(sourceAccess(f),before,'WARM_SOURCE_REACQUISITION');};
  await assert.rejects(criterion(broken),/WARM_SOURCE_REACQUISITION/);await criterion(replay);
 });
});

// Recording SQL boundary for counter/control cases. Native exported snapshots,
// real typed completion and transport are exercised by the retained discriminator.
function recoveryFixture({factory=replay,floor=4,observed='4',completed='4',cold=false,sameGeneration=false,rebuild=false,sourceRows=1,badDigest=false,serializationOnce=false,uncertainOnce=false,dueAt=null}={}){
 if(completed===null)completed=undefined;
 const native=require('./lib/clinical-stream-native'),work=require('../lib/pgstream/work-state'),journal=require('../lib/storage/storage-event-journal'),digest='b'.repeat(64),consumer='evaluator-synthetic',outputConsumer=consumer+'-completed';
 const boundary={...native.boundary,generation:sameGeneration?'epoch:1':'epoch:2',snapshot_position:'0/80'};
 const initial=cold?stream.empty():stream.bootstrap(null,{checkpoint:floor,signature:{stamp:floor,deleted:0},stream:{...native.boundary,generation:'epoch:1'},rows:[]},limits);
 if(rebuild){initial.ready=false;initial.rows=[];initial.gap='history';}
 const descriptor={consumer:outputConsumer,digest};let handle,active=null,recoveries=0;
 let durable={input:{checkpoint:floor,projection:[stream.compact(initial),journal.empty()]},output:{tenant:A,contract_digest:badDigest?'c'.repeat(64):digest,work_version:2,work_observed:work.array(observed===undefined?{}:{bootstrap:observed}),work_completed:work.array(completed===undefined?{}:{bootstrap:completed}),work_observed_at:work.array(observed===undefined?{}:{bootstrap:'1'}),work_pending_at:observed!==undefined&&(completed===undefined||BigInt(observed)>BigInt(completed))?1:null,work_due_at:dueAt,work_completed_at:null,work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0',output_identity:null,output_digest:null,output_revision:'0',output_restore_generation:null,projection:[{kind:'evaluator-work-v2',output:null}]}};
 const queries=[];
 let canonicalRows=Array.from({length:sourceRows},(_,i)=>({domain:'entries',id_kind:'string',doc:{_id:'snapshot-'+i,date:1,sgv:123},stamp:null,ordinal:i+1,storage_bytes:80}));
 const connection={async query(text,args=[]){
  queries.push(text);
  if(text==='BEGIN' || text==='BEGIN ISOLATION LEVEL READ COMMITTED'){assert.equal(active,null);active=structuredClone(durable);return {};}
  if(text==='ROLLBACK'){active=null;return {};}
  if(text==='COMMIT'){durable=active;active=null;return {command:'COMMIT'};}
  if(text.includes('pg_advisory_xact_lock_shared'))return {rows:[{}]};
  const current=active||durable;
  if(text.startsWith('SELECT c.tenant_id'))return {rows:[{tenant:A,...jsonb(current.input),contract_digest:handle.snapshotDigest}]};
  if(text.startsWith("SELECT projection->0->'output' AS output"))return {rows:[{output:structuredClone(current.output.projection[0].output)}]};
  if(text.startsWith('SELECT checkpoint,'))return {rows:[{...jsonb(current.input),contract_digest:handle.snapshotDigest}]};
  if(text.startsWith('SELECT contract_digest,work_version,')){
   if(serializationOnce){serializationOnce=false;throw Object.assign(new Error('SERIALIZATION_REFUSED'),{code:'40001'});}return {rows:[structuredClone(current.output)]};
  }
  if(text.startsWith('SELECT tenant_id::text AS tenant'))return {rows:[{...structuredClone(current.output),previous_output:current.output.projection[0].output}]};
  if(text.startsWith('SELECT count(*)::text'))return {rows:[{row_count:String(canonicalRows.length),document_bytes:String(canonicalRows.length*80)}]};
  if(text.includes('information_schema.columns'))return {rows:[{name:'synthetic_entries.entries'}]};
  if(text.startsWith('SELECT domain,id_kind,doc,stamp'))return {rows:args.length>1?[]:structuredClone(canonicalRows)};
  if(text.startsWith('WITH input')){const patch=JSON.parse(args[1])[0];Object.assign(current.output,{work_observed:patch.observed,work_observed_at:patch.observed_at,work_pending_at:patch.pending_at,delivery_revision:String(BigInt(current.output.delivery_revision)+BigInt(patch.delivery_delta))});return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET projection=p.projection')){const [patch]=JSON.parse(args[2]);current.input={checkpoint:patch.checkpoint,projection:patch.projection};return {rowCount:1,rows:[]};}
  if(text.startsWith('UPDATE ')&&text.includes('SET projection=')){current.input={checkpoint:args[4],projection:JSON.parse(args[2])};return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET checkpoint=$3, projection=')){current.input={checkpoint:args[2],projection:[JSON.parse(args[3])[0],args[5]?JSON.parse(args[5]):current.input.projection[1]]};return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET delivery_revision=')){current.output.delivery_revision=String(BigInt(current.output.delivery_revision)+1n);return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET checkpoint=$3,work_completed=')){Object.assign(current.output,{work_completed:args[3],work_due_at:args[4],work_pending_at:args[5],work_completed_at:args[6],output_identity:args[7],output_digest:args[8],output_revision:String(args[9]),output_restore_generation:args[10]});if(args[12])current.output.projection=JSON.parse(args[12]);return {rowCount:1};}
  throw new Error('UNEXPECTED_RECOVERY_PROTOCOL_SQL:'+text);
 },async readOnly(text,args){return connection.query(text,args);},async acceptClinicalTransaction(options){return require('../lib/storage/clinical-stream-sql').acceptTransaction({...options,pool:{connect:async()=>({...connection,release(){}})},observeBackend:async()=>{}});},async snapshotTransaction(fn){assert.equal(active,null);active=structuredClone(durable);try{const value=await fn();durable=active;active=null;return value;}catch(error){active=null;throw error;}},async holdAdvisoryLock(){return {available:true,withTenant:(tenant,fn)=>connection.snapshotTransaction(fn),close:async()=>{}};}};
 function restart(){handle=factory({connection,checkpointTable:'synthetic_work.tenant_consumer_checkpoint',clockTable:'unused_clock.tenant_write_clock',domains:{entries:'synthetic_entries.entries'},consumer,projectionVersion:'clinical-current-rows-v1',pageSize:3,maxRows:10,stream:true});
 handle.configureStream({expectedSource:native.source,generation:()=>boundary.generation,assertFence:async()=>boundary.generation,lockKey:'123',maxBytes:limits.maxBytes,completed:()=>descriptor,recovery:{async withSnapshot({fn}){recoveries++;const result=await connection.snapshotTransaction(()=>fn(boundary));if(uncertainOnce){uncertainOnce=false;throw new Error('RECOVERY_COMMIT_REPLY_LOST');}return result;}}});}
 restart();
 const reconcile=extra=>scope.withTenant(A,()=>handle.reconcile({...limits,signature:true,...extra}));
 return {queries,connection,descriptor,reconcile,restart,get recoveries(){return recoveries;},snapshot:()=>structuredClone(durable),replaceSource(rows){canonicalRows=structuredClone(rows);},async acceptLater(){
  canonicalRows.push({domain:'entries',id_kind:'string',doc:{_id:'later',sgv:140,date:1},stamp:null,ordinal:2,storage_bytes:80});
  return handle.acceptTransaction(native.envelope([native.row('later',140)],'0/90'),{routes:[{schema:'synthetic_entries',table:'entries',domain:'entries'}],store:descriptor,maxTransactionRows:10,maxTransactionBytes:100000});
 },useActualStore(){const store=require('../lib/pgstream/typed-checkpoint').create({connection,namespace:'synthetic_work',consumer,maxBytes:100000,timeIntervalMs:60000});descriptor.digest=store.digest;durable.output.contract_digest=store.digest;return store;}};
}
describe('durable generation recovery bootstrap obligation',()=>{
 let prior;before(()=>{prior=scope.getTenancyMode();scope.setTenancyMode('multi');});after(()=>scope.setTenancyMode(prior));
 it('mints owed work for a drained generation and commits it with input before returning',async()=>{
  const f=recoveryFixture();const result=await f.reconcile(),saved=f.snapshot();assert.equal(result.checkpoint,5);assert.equal(saved.input.checkpoint,5);assert.equal(saved.output.work_observed[5],'5');assert.equal(saved.output.work_completed[5],'4');assert.notEqual(saved.output.work_pending_at,null);assert.equal(saved.input.projection[0].stream.generation,'epoch:2');assert.equal(saved.output.delivery_revision,'1');
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
  const f=recoveryFixture({sameGeneration:true});await f.reconcile();const before=f.snapshot(),reads=sourceAccess(f);await f.reconcile();assert.equal(f.recoveries,1);assert.equal(sourceAccess(f),reads);assert.deepEqual(f.snapshot(),before);
 });
 it('control: whole-projection warm read fails the metadata-only query criterion',async()=>{
  const control=require('./lib/clinical-working-set/control');
  const broad=control('../lib/storage/postgres-durable-replay','stream && !boundary ? guardedWarm',"stream && !boundary ? 'jsonb_build_array(projection->0) AS projection'");
  const check=async factory=>{
   const f=recoveryFixture({factory,sameGeneration:true}),warm=await f.reconcile(),offset=f.queries.length;
   assert.deepEqual(await f.reconcile(),warm);
   const reads=f.queries.slice(offset).filter(text=>text.startsWith('SELECT checkpoint, contract_digest, '));
   assert.equal(reads.length,1);
   assert.match(reads[0],/jsonb_build_object\('kind',projection->0->'kind','floor',projection->0->'floor','deleted',projection->0->'deleted','stream',projection->0->'stream'\)/,'WARM_READ_RETURNED_FULL_PROJECTION');
  };
  await check(replay);
  await assert.rejects(check(broad),/WARM_READ_RETURNED_FULL_PROJECTION/);
  await check(replay);
 });
 it('refuses counter exhaustion, wrong completed digest and source overflow atomically',async()=>{
  for(const [options,extra,symptom]of [[{floor:8639999999999999,observed:'8639999999999999',completed:'8639999999999999'},undefined,/INVALID_STAMP/],[{badDigest:true},undefined,/COMPLETED_CONTRACT/],[{sourceRows:2},{maxRows:1},/ROW_BOUND/]]){
   const f=recoveryFixture(options),before=f.snapshot();await assert.rejects(f.reconcile(extra),symptom);assert.deepEqual(f.snapshot(),before,'REFUSED_RECOVERY_MUST_NOT_PARTIALLY_ACCEPT');
  }
 });
 it('retries RR serialization and uncertain committed replies without duplicate tokens',async()=>{
  const serial=recoveryFixture({serializationOnce:true});await assert.rejects(serial.reconcile(),error=>error.code==='40001');await serial.reconcile();assert.equal(serial.snapshot().output.work_observed[5],'5');
  const lost=recoveryFixture({uncertainOnce:true});await assert.rejects(lost.reconcile(),/RECOVERY_COMMIT_REPLY_LOST/);const committed=lost.snapshot();await lost.reconcile();assert.deepEqual(lost.snapshot(),committed);assert.equal(lost.recoveries,2);
 });
 it('actual typed completion never covers the freshly minted token or a later receipt using earlier captured work',async()=>{
  const f=recoveryFixture(),store=f.useActualStore();await store.own();const captured=await store.begin(A),recovered=await f.reconcile();assert.deepEqual(captured,{bootstrap:'4'});
  await f.acceptLater();const result={checkpoint:recovered.checkpoint,properties:{},emitted:[],requested:[],rows:[],frame:{lastUpdated:1},due:{dueAt:null,slow:[]}};
  const old=await scope.withTenant(A,()=>store.complete(A,{observed:captured,identity:'a'.repeat(64),result}));assert.notEqual(old.pendingAt,null);assert.equal(f.snapshot().output.work_completed[5],'4');assert.equal(f.snapshot().output.work_observed[5],'6');
  const before=f.queries.filter(q=>q.includes('snapshot_source')||q.includes('information_schema')).length,latest=await store.begin(A),warm=await f.reconcile();
  await scope.withTenant(A,()=>store.complete(A,{observed:latest,identity:'a'.repeat(64),result:{...result,checkpoint:warm.checkpoint}}));assert.equal(f.snapshot().output.work_pending_at,null);assert.equal(f.snapshot().output.work_completed[5],'6');assert.equal(f.queries.filter(q=>q.includes('snapshot_source')||q.includes('information_schema')).length,before,'FOLLOWUP_MUST_USE_WARM_INPUT');await store.close();
 });
 it('after accepted input and process loss rebuilds from advanced/deleted current source without stranding accepted work',async()=>{
  const f=recoveryFixture();await f.reconcile();await f.acceptLater();
  const accepted=f.snapshot();assert.equal(accepted.input.projection[0].rows,undefined);assert.equal(accepted.output.work_observed[5],'6');
  // Source deletion committed after acceptance. Recovery must not resurrect the accepted payload.
  f.replaceSource([]);f.restart();const recovered=await f.reconcile();
  assert.deepEqual(recovered.rows,[]);assert.equal(recovered.checkpoint,6);assert.equal(f.snapshot().output.work_observed[5],'6');assert.notEqual(f.snapshot().output.work_pending_at,null);
 });
 it('recovers actual due-only work on cold restart without a later source write',async()=>{
  const f=recoveryFixture({sameGeneration:true,dueAt:1}),store=f.useActualStore();await store.own();
  const work=await store.work();assert.equal(work[0].nextDueAt,1);assert.equal(work[0].pendingAt,null);
  const recovered=await f.reconcile(),observed=await store.begin(A);
  assert.equal(recovered.checkpoint,5);assert.notEqual(f.snapshot().output.work_pending_at,null,'DUE_RECOVERY_MUST_BE_DURABLE');
  const result={checkpoint:recovered.checkpoint,properties:{},emitted:[],requested:[],rows:recovered.rows,frame:{lastUpdated:1},due:{dueAt:Date.now()+60000,slow:[]}};
  await scope.withTenant(A,()=>store.complete(A,{observed,identity:'a'.repeat(64),result}));
  assert.equal(f.snapshot().output.work_pending_at,null);assert.equal(f.snapshot().output.work_completed[5],'5');assert.equal(f.snapshot().output.work_due_at,result.due.dueAt);await store.close();
 });
 it('control: omitting recovery observation strands the token, restored atomic observation passes',async()=>{
  const control=require('./lib/clinical-working-set/control');const needle="if(recoveryWork)await require('../pgstream/work-state').observeInTransaction";
  const broken=control('../lib/storage/postgres-durable-replay',needle,"if(false)await require('../pgstream/work-state').observeInTransaction");
  const criterion=async factory=>{const f=recoveryFixture({factory});await f.reconcile();const row=f.snapshot().output;assert.notEqual(row.work_pending_at,null,'RECOVERY_WORK_MUST_REMAIN_DURABLE');};
  await assert.rejects(criterion(broken),/RECOVERY_WORK_MUST_REMAIN_DURABLE/);await criterion(replay);
 });
});
