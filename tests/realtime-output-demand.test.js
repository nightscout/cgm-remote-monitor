'use strict';
const assert=require('node:assert/strict');
const completed=require('../lib/pgstream/realtime-output');
const runtime=require('../lib/server/realtime/runtime');
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
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
});

