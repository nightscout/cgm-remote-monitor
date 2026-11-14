'use strict';
const assert=require('node:assert/strict');
const {create}=require('../lib/pgstream/checkpoint');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',identity='a'.repeat(64);
const copy=value=>JSON.parse(JSON.stringify(value));
// Source protocol: the actual checkpoint/owner composition with a transactional
// SQL port. Native SQL row locking/JSONB behavior belongs to integration tests.
function fixture(maxBytes=1024*1024){
 let state={kind:'evaluator-work-v1',observed:{clock:'1'},completed:{},observedAt:{clock:1},pendingAt:1,enabled:true,output:null},fallbacks=0,patches=[],fail=false;
 const connection={async holdAdvisoryLock(){return {available:true,close:async()=>{},async withTenant(tenant,fn){assert.equal(tenant,A);const before=copy(state);try{const value=await fn();if(fail)throw Error('COMMIT_LOST');return value;}catch(error){state=before;throw error;}}};},
  async query(text,values){
   assert.equal(values[0],A);
   if(text.startsWith('SELECT jsonb_build_array')){const projection=copy(state);delete projection.output;const summary=copy(state.output);if(summary){delete summary.rows;delete summary.frame;}return {rows:[{projection:[projection],output_summary:summary,frame_at:state.output?.frame?.lastUpdated??null,contract_digest:store.digest}]};}
   if(text.startsWith("SELECT projection->0->'output'")){fallbacks++;return {rows:[{output:copy(state.output)}]};}
   if(text.startsWith('UPDATE')){assert.match(text,/jsonb_build_array\(\(projection->0\)\|\|\$4::jsonb\)/);const patch=JSON.parse(values[3]);patches.push(patch);state={...state,...patch};return {rowCount:1};}
   throw Error('UNEXPECTED_SQL');
  }};
 const store=create({connection,namespace:'synthetic',consumer:'evaluator-test',maxBytes,timeIntervalMs:60,now:()=>50});
 const result=()=>({checkpoint:1,trigger:'acquisition',properties:{bgnow:123},emitted:[],requested:[],encodedRows:[{synthetic:'x'.repeat(32768)}],frame:{sgvs:[{mgdl:123}],lastUpdated:10},due:{dueAt:100,slow:[]}});
 return {store,result,state:()=>copy(state),patches,fallbacks:()=>fallbacks,observe(){state.observed.clock='2';state.pendingAt=20;},fail(){fail=true;}};
}
describe('completed checkpoint retained-output transfer contract',function(){
 async function seed(f){await f.store.own(()=>{});return f.store.complete(A,{observed:{clock:'1'},identity,result:f.result()});}
 it('patches only metadata for unchanged TIME content while preserving current due and completed versions',async()=>{
  const f=fixture(),first=await seed(f);f.observe();const result=f.result();result.frame.lastUpdated=50;result.due.dueAt=200;
  const next=await f.store.complete(A,{observed:{clock:'2'},identity,result,retainedOutput:{...first.output,runtimeId:'same-runtime'}});
  assert.equal(f.fallbacks(),0,'MATCHED_RETAINED_OUTPUT_MUST_AVOID_FULL_TRANSFER');assert.equal(next.changed,false);assert.deepEqual(next.output,first.output);
  assert(!Object.hasOwn(f.patches[1],'output'),'UNCHANGED_OUTPUT_MUST_NOT_BE_SENT');assert(Buffer.byteLength(JSON.stringify(f.patches[1]))<1024);
  assert.equal(f.state().nextDueAt,200);assert.deepEqual(f.state().completed,{clock:'2'});assert.equal(f.state().pendingAt,null);assert.equal(f.state().output.outputRevision,1);
 });
 for(const [name,mutate] of Object.entries({missing:()=>undefined,tenant:o=>({...o,tenant:B}),identity:o=>({...o,identity:'b'.repeat(64)}),restore:o=>({...o,restoreGeneration:99}),revision:o=>({...o,outputRevision:99}),digest:o=>({...o,contentDigest:'bad'}),frame:o=>({...o,frame:{...o.frame,sgvs:[]}}),rows:o=>({...o,rows:[]}),result:o=>({...o,result:{...o.result,properties:{bad:true}}}),time:o=>({...o,frame:{...o.frame,lastUpdated:99}})}))it('recovers physical output for '+name+' retained hint',async()=>{
  const f=fixture(),first=await seed(f),retainedOutput=mutate(copy(first.output));const next=await f.store.complete(A,{observed:{clock:'1'},identity,result:f.result(),retainedOutput});
  assert.equal(f.fallbacks(),1,'INVALID_RETAINED_OUTPUT_MUST_READ_PHYSICAL');assert.deepEqual(next.output,first.output);assert.equal(next.changed,false);
 });
 it('publishes changed content and restore epoch together with completion',async()=>{const f=fixture(),first=await seed(f),result=f.result();result.properties.bgnow=124;
  const next=await f.store.complete(A,{observed:{clock:'1'},identity,result,restoreGeneration:7,retainedOutput:first.output});assert(next.changed);assert.equal(next.output.outputRevision,2);assert.equal(f.state().output.restoreGeneration,7);assert.deepEqual(f.state().completed,{clock:'1'});assert(Object.hasOwn(f.patches[1],'output'));});
 it('refuses rollback, byte overflow and failed COMMIT without advancing retained or persisted output',async()=>{const f=fixture(),first=await seed(f),before=f.state();
  await assert.rejects(f.store.complete(A,{observed:{clock:'0'},identity,result:f.result(),retainedOutput:first.output}),/VERSION_REFUSED/);
  const huge=f.result();huge.frame.sgvs=[{synthetic:'x'.repeat(1024*1024)}];await assert.rejects(f.store.complete(A,{observed:{clock:'1'},identity,result:huge,retainedOutput:first.output}),/BYTE_BOUND/);
  f.fail();await assert.rejects(f.store.complete(A,{observed:{clock:'1'},identity,result:f.result(),retainedOutput:first.output}),/COMMIT_LOST/);assert.deepEqual(f.state(),before);assert.deepEqual(first.output,before.output);
 });
});
