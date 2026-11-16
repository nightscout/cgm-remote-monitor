'use strict';
const assert=require('node:assert/strict'),scope=require('../lib/storage/tenant-scope');
const source=require('../lib/pgstream/storage-events'),journal=require('../lib/storage/storage-event-journal');
const A='11111111-1111-4111-8111-111111111111';
describe('addressed raw journal reader and current-worker fence',()=>{
 let mode;before(()=>{mode=scope.getTenancyMode();scope.setTenancyMode('multi');});after(()=>scope.setTenancyMode(mode));
 function fixture(module=source){let worker={available:true,generation:1},owns=true;const queries=[];
  const reader=module.create({config:{completedOutput:{namespace:'synthetic',consumer:'evaluator-synthetic'},maxRows:3,maxBytes:10000},workerState:()=>worker,assertOwner:()=>{if(!owns)throw new Error('OWNER_LOST');},connection:{query:async(text,values)=>{queries.push({text,values});return {rows:[{storage:journal.empty(),work_enabled:true}]};}}});
  return {reader,queries,worker:next=>{worker=next;},disown:()=>{owns=false;}};
 }
 it('reads only addressed input-tail plus control metadata and refuses stale-worker/owner publication',async()=>{
  const f=fixture(),tail=await scope.withTenant(A,()=>f.reader.read(A));f.reader.assert(tail);
  assert.match(f.queries[0].text,/input.projection->1/);assert(!f.queries[0].text.includes("'output'"));assert.deepEqual(f.queries[0].values,[A,'evaluator-synthetic']);
  f.worker({available:true,generation:2});assert.throws(()=>f.reader.assert(tail),/TRUSTED_WORKER/);
  const fresh=await scope.withTenant(A,()=>f.reader.read(A));f.disown();assert.throws(()=>f.reader.assert(fresh),/OWNER_LOST/);
 });
 it('RED/restored control fails when captured worker generation stops fencing publication',async()=>{
  const broken=require('./lib/clinical-working-set/control')('../lib/pgstream/storage-events','worker.generation!==workerState().generation','false');
  const check=async module=>{const f=fixture(module),tail=await scope.withTenant(A,()=>f.reader.read(A));f.worker({available:true,generation:2});assert.throws(()=>f.reader.assert(tail),/TRUSTED_WORKER/);};
  await assert.rejects(check(broken),/Missing expected exception/);await check(source);
 });
 it('default receipt check refreshes controls once, delivers raw events with clinical work pending, and isolates raw failures',async()=>{
  const f=fixture(),B='22222222-2222-4222-8222-222222222222',delivered=[];let checks=0;
  const runtime={check:async tenants=>{checks++;return new Map(tenants.map(t=>[t,true]));}};
  const protocol={storageWatched:()=>true,storage:async({tenant,tail})=>{if(tenant===A)throw new Error('A raw output unavailable');f.reader.assert(tail);delivered.push(tenant);}};
  const outcomes=await f.reader.check([A,B],{runtime,protocol,concurrency:2});
  assert.equal(checks,1,'ONE_ADDRESSED_CONTROL_CHECK');assert.equal(outcomes.get(A),false);assert.equal(outcomes.get(B),true);assert.deepEqual(delivered,[B]);
  const before=f.queries.length;protocol.storageWatched=()=>false;await f.reader.check([A,B],{runtime,protocol,concurrency:2});assert.equal(f.queries.length,before,'NO_UNWATCHED_RAW_TAIL_READ');
 });
 it('default boot uses the same receipt drain for source-tail and completed-frame delivery',()=>{
  const text=require('node:fs').readFileSync(require.resolve('../lib/server/serve/preview-realtime'),'utf8');
  assert.match(text,/check:tenants=>storageEvents.check\(tenants,\{runtime,protocol,concurrency:REFRESH_CONCURRENCY\}\)/,'DEFAULT_MUST_DRAIN_RAW_EVENTS');
  const evaluate=require('node:fs').readFileSync(require.resolve('../lib/server/serve/evaluator-preview'),'utf8');
  assert.match(evaluate,/receipt\?\.rawDeliveryPending\)workScheduler\?\.wakeDelivery\(\)/,'ACK_COMMIT_MUST_WAKE_EXISTING_DELIVERY');
 });

 it('retained tails cannot cross an operation-window restore generation',async()=>{
  let generation=1;const reader=source.create({config:{completedOutput:{namespace:'synthetic',consumer:'evaluator-synthetic'},maxRows:3,maxBytes:10000},operationWindow:{run:async(tenant,fn)=>fn(),currentGeneration:()=>generation},connection:{query:async()=>({rows:[{storage:journal.empty(),work_enabled:true}]})}});
  const tail=await reader.read(A);reader.assert(tail);generation=2;assert.throws(()=>reader.assert(tail),/RESTORE_CHANGED/);
 });

});
