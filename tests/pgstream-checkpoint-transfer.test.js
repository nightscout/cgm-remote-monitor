'use strict';
const assert=require('node:assert/strict');
const {create}=require('../lib/pgstream/checkpoint');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',identity='a'.repeat(64);
const copy=value=>JSON.parse(JSON.stringify(value));
// Source protocol: the actual checkpoint/owner composition with a transactional
// SQL port. Native SQL row locking/JSONB behavior belongs to integration tests.
function fixture(maxBytes=1024*1024,creator=create){
 let row,fallbacks=0,patches=[],fail=false;
 const connection={async holdAdvisoryLock(){return {available:true,close:async()=>{},async withTenant(tenant,fn){assert.equal(tenant,A);const before=copy(row);try{const value=await fn();if(fail)throw Error('COMMIT_LOST');return value;}catch(error){row=before;throw error;}}};},
  async query(text,values){
   assert.equal(values[0],A);
   if(text.startsWith("SELECT projection->0->'output'")){fallbacks++;return {rows:[{output:copy(row.projection[0].output)}]};}
   if(text.startsWith('SELECT')){assert.match(text,/CASE WHEN jsonb_typeof\(projection->0->'output'\)='object' THEN .* ELSE NULL END AS output_summary/,'COLD_NULL_OUTPUT_MUST_NOT_DELETE_JSONB_SCALAR');const summary=copy(row.projection[0].output);if(summary){delete summary.rows;delete summary.frame;}return {rows:[{...copy(row),output_summary:summary,frame_at:row.projection[0].output?.frame?.lastUpdated??null}]};}
   if(text.startsWith('UPDATE')){row.checkpoint=values[2];const patch={completed:values[3],due:values[4],pending:values[5]};if(values[12])patch.output=JSON.parse(values[12])[0].output;patches.push(patch);row.work_completed=values[3];row.work_due_at=values[4];row.work_pending_at=values[5];row.output_identity=values[7];row.output_digest=values[8];row.output_revision=String(values[9]);row.output_restore_generation=values[10];row.delivery_revision=String(BigInt(row.delivery_revision)+BigInt(values[11]));if(values[12])row.projection=JSON.parse(values[12]);return {rowCount:1};}
   throw Error('UNEXPECTED_SQL');
  }};
 const store=creator({typed:true,connection,namespace:'synthetic',consumer:'evaluator-test',maxBytes,timeIntervalMs:60,now:()=>50});
 row={tenant:A,contract_digest:store.digest,work_version:2,work_observed:['1',null,null,null,null,null],work_completed:[null,null,null,null,null,null],work_observed_at:['1',null,null,null,null,null],work_pending_at:1,work_due_at:null,work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0',output_identity:null,output_digest:null,output_revision:'0',output_restore_generation:null,projection:[{kind:'evaluator-work-v2',output:null}]};
 const current=()=>({...require('../lib/pgstream/work-state').state(row),output:row.projection[0].output?{...copy(row.projection[0].output),identity:row.output_identity,contentDigest:row.output_digest,outputRevision:Number(row.output_revision),restoreGeneration:row.output_restore_generation}:null});
 const result=()=>({checkpoint:1,trigger:'acquisition',properties:{bgnow:123},emitted:[],requested:[],encodedRows:[{synthetic:'x'.repeat(32768)}],frame:{sgvs:[{mgdl:123}],lastUpdated:10},due:{dueAt:100,slow:[]}});
 return {store,result,state:()=>({...copy(current()),checkpoint:row.checkpoint}),patches,fallbacks:()=>fallbacks,observe(){row.work_observed[0]='2';row.work_pending_at=20;},fail(){fail=true;}};
}
describe('completed checkpoint retained-output transfer contract',function(){
 it('refuses retired implicit/false checkpoint selection before opening a connection',()=>{for(const typed of [undefined,false])assert.throws(()=>create({typed,connection:new Proxy({},{get(){throw Error('retired selection touched connection');}})}),/EVALUATOR_CHECKPOINT_TYPED_REQUIRED/);});
 it('control: removing typed selection refusal admits a retired caller; the restored factory refuses it',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),file=require.resolve('../lib/pgstream/checkpoint'),source=fs.readFileSync(file,'utf8');
  const needle="if (options.typed !== true) throw new TypeError('EVALUATOR_CHECKPOINT_TYPED_REQUIRED');";assert(source.includes(needle));
  const broken={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'')+'\n})',{filename:file})(require('node:module').createRequire(file),broken,broken.exports);
  const options={connection:{},namespace:'synthetic',consumer:'evaluator-test',maxBytes:1024,timeIntervalMs:1000};
  const criterion=creator=>assert.throws(()=>creator(options),/EVALUATOR_CHECKPOINT_TYPED_REQUIRED/,'RETIRED_CALLER_MUST_REFUSE');
  assert.throws(()=>criterion(broken.exports.create),/RETIRED_CALLER_MUST_REFUSE/);criterion(create);
 });

 async function seed(f){await f.store.own(()=>{});return f.store.complete(A,{observed:{clock:'1'},identity,result:f.result()});}
 it('patches only metadata for unchanged TIME content while preserving current due and completed versions',async()=>{
  const f=fixture(),first=await seed(f);f.observe();const result=f.result();result.frame.lastUpdated=50;result.due.dueAt=200;
  const hint={...first.output,runtimeId:'same-runtime'},next=await f.store.complete(A,{observed:{clock:'2'},identity,result,retainedOutput:hint});
  assert.equal(f.fallbacks(),0,'MATCHED_RETAINED_OUTPUT_MUST_AVOID_FULL_TRANSFER');assert.equal(next.changed,false);assert.equal(next.output,hint);
  assert(!Object.hasOwn(f.patches[1],'output'),'UNCHANGED_OUTPUT_MUST_NOT_BE_SENT');assert(Buffer.byteLength(JSON.stringify(f.patches[1]))<1024);
  assert.equal(f.state().nextDueAt,200);assert.deepEqual(f.state().completed,{clock:'2'});assert.equal(f.state().pendingAt,null);assert.equal(f.state().output.outputRevision,1);
 });
 async function progressOnly(creator=create){
  const f=fixture(1024*1024,creator),first=await seed(f);f.observe();const result=f.result();result.checkpoint=2;
  const next=await f.store.complete(A,{observed:{clock:'2'},identity,result,retainedOutput:first.output});
  assert.equal(next.changed,false,'PROGRESS_ONLY_MUST_NOT_CHANGE_OUTPUT');assert.equal(next.output.outputRevision,1,'PROGRESS_ONLY_OUTPUT_REVISION');
  assert.equal(next.output,first.output,'PROGRESS_ONLY_RETAINS_CAPTURED_OUTPUT');assert.equal(next.output.inputCheckpoint,1,'OUTPUT_RETAINS_CAPTURED_COVERAGE');
  assert.equal(f.state().checkpoint,2,'COMPLETED_COVERAGE_ADVANCES');assert.deepEqual(f.state().completed,{clock:'2'});assert(!Object.hasOwn(f.patches[1],'output'),'PROGRESS_ONLY_MUST_NOT_REWRITE_PAYLOAD');assert.equal(f.fallbacks(),0);
 }
 it('advances clinical completion coverage without rewriting identical captured output',()=>progressOnly());
 it('control: hashing completion checkpoint as content makes progress-only output rewrite; restored digest passes',async()=>{
  const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../lib/pgstream/typed-checkpoint'),source=fs.readFileSync(file,'utf8');
  const first='identity:output.identity,properties:',second='hash({identity,properties:';assert(source.includes(first)&&source.includes(second));
  const altered=new Module(file,module);altered.filename=file;altered.paths=Module._nodeModulePaths(path.dirname(file));altered._compile(source.replace(first,'identity:output.identity,checkpoint:output.result.checkpoint,properties:').replace(second,'hash({identity,checkpoint:result.checkpoint,properties:'),file);
  await assert.rejects(progressOnly(altered.exports.create),/PROGRESS_ONLY_MUST_NOT_CHANGE_OUTPUT/);await progressOnly();
 });
 for(const [name,mutate] of Object.entries({missing:()=>undefined,tenant:o=>({...o,tenant:B}),identity:o=>({...o,identity:'b'.repeat(64)}),restore:o=>({...o,restoreGeneration:99}),revision:o=>({...o,outputRevision:99}),digest:o=>({...o,contentDigest:'bad'}),frame:o=>({...o,frame:{...o.frame,sgvs:[]}}),rows:o=>({...o,rows:[]}),result:o=>({...o,result:{...o.result,properties:{bad:true}}}),time:o=>({...o,frame:{...o.frame,lastUpdated:99}})}))it('recovers physical output for '+name+' retained hint',async()=>{
  const f=fixture(),first=await seed(f),retainedOutput=mutate(copy(first.output));const next=await f.store.complete(A,{observed:{clock:'1'},identity,result:f.result(),retainedOutput});
  assert.equal(f.fallbacks(),1,'INVALID_RETAINED_OUTPUT_MUST_READ_PHYSICAL');assert.deepEqual(next.output,first.output);assert.equal(next.changed,false);
 });
 it('publishes changed content and restore epoch together with completion',async()=>{const f=fixture(),first=await seed(f),result=f.result();result.properties.bgnow=124;
  const next=await f.store.complete(A,{observed:{clock:'1'},identity,result,restoreGeneration:7,retainedOutput:first.output});assert(next.changed);assert.equal(next.output.outputRevision,2);assert.equal(f.state().output.restoreGeneration,'7');assert.deepEqual(f.state().completed,{clock:'1'});assert(Object.hasOwn(f.patches[1],'output'));});
 it('refuses rollback, byte overflow and failed COMMIT without advancing retained or persisted output',async()=>{const f=fixture(),first=await seed(f),before=f.state();
  await assert.rejects(f.store.complete(A,{observed:{clock:'0'},identity,result:f.result(),retainedOutput:first.output}),/VERSION_REFUSED/);
  const huge=f.result();huge.frame.sgvs=[{synthetic:'x'.repeat(1024*1024)}];await assert.rejects(f.store.complete(A,{observed:{clock:'1'},identity,result:huge,retainedOutput:first.output}),/BYTE_BOUND/);
  f.fail();await assert.rejects(f.store.complete(A,{observed:{clock:'1'},identity,result:f.result(),retainedOutput:first.output}),/COMMIT_LOST/);assert.deepEqual(f.state(),before);assert.deepEqual(first.output,before.output);
 });
});
