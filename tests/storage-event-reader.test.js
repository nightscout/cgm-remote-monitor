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
 it('default boot uses the same receipt drain and wakes the accepted tenant after raw receipt commit',async()=>{
  const text=require('node:fs').readFileSync(require.resolve('../lib/server/serve/preview-realtime'),'utf8');
  assert.match(text,/check:tenants=>storageEvents.check\(tenants,\{runtime,protocol,concurrency:REFRESH_CONCURRENCY\}\)/,'DEFAULT_MUST_DRAIN_RAW_EVENTS');
  const evaluate=require('node:fs').readFileSync(require.resolve('../lib/server/serve/evaluator-preview'),'utf8');
  assert.match(evaluate,/receipt\?\.rawDeliveryPending\)workScheduler\?\.wakeDelivery\(tenant\)/,'ACK_COMMIT_MUST_WAKE_ADDRESSED_DELIVERY');
  // Execute the maintained callback, retaining the real await and addressed wake.
  // Its replay port resolves only after the durable receipt commits.
  const callback=evaluate.match(/accept:(async\(tenant,data,domain,store\)=>\{[\s\S]*?)\n        \}\},/);assert(callback,'MAINTAINED_CLINICAL_ACCEPT_CALLBACK_REQUIRED');
  async function criterion(body){
   let committed;const receipt={rawDeliveryPending:true},wakes=[];
   const replay={acceptClinical:async tenant=>{assert.equal(tenant,A);return new Promise(resolve=>{committed=resolve;});}};
   const accept=new Function('replay','workScheduler','config','return '+body+'}')(replay,{wakeDelivery:tenant=>wakes.push(tenant)},{maxBytes:10000});
   const accepting=accept(A,{synthetic:true},'entries',{consumer:'synthetic',digest:'synthetic'});
   assert.deepEqual(wakes,[],'RAW_DELIVERY_MUST_WAIT_FOR_COMMITTED_RECEIPT');committed(receipt);
   assert.equal(await accepting,receipt);assert.deepEqual(wakes,[A],'RAW_RECEIPT_MUST_WAKE_ITS_TENANT');
  }
  await assert.rejects(criterion(callback[1].replace('wakeDelivery(tenant)','wakeDelivery()')),/RAW_RECEIPT_MUST_WAKE_ITS_TENANT/);await criterion(callback[1]);
 });

 it('retained tails cannot cross an operation-window restore generation',async()=>{
  let generation=1;const reader=source.create({config:{completedOutput:{namespace:'synthetic',consumer:'evaluator-synthetic'},maxRows:3,maxBytes:10000},operationWindow:{run:async(tenant,fn)=>fn(),currentGeneration:()=>generation},connection:{query:async()=>({rows:[{storage:journal.empty(),work_enabled:true}]})}});
  const tail=await reader.read(A);reader.assert(tail);generation=2;assert.throws(()=>reader.assert(tail),/RESTORE_CHANGED/);
 });
 it('publishes a retained tail only inside an actual operation-window scope, with restored scope and generation controls',async()=>{
  const {EventEmitter}=require('node:events');
  const factory=require('../lib/server/realtime/protocol');
  const options={generation:'1'},f=require('./fixtures/operation-window-runtime-protocol')(options);
  let tail=journal.empty();
  const reader=source.create({config:{completedOutput:{namespace:'synthetic',consumer:'evaluator-synthetic'},maxRows:3,maxBytes:10000},operationWindow:f.window,
   connection:{query:async()=>({rows:[{storage:tail,work_enabled:true}]})}});
  class Socket extends EventEmitter{
   constructor(){super();this.id='synthetic-scope';this.rooms=new Set([this.id]);this.request={headers:{host:'a.test'},socket:{}};this.sent=[];}
   emit(event,value){this.sent.push({event,value});return true;}join(room){this.rooms.add(room);}leave(room){this.rooms.delete(room);}disconnect(){super.emit('disconnect');}
  }
  const criterion=async module=>{
   tail=journal.empty();
   const protocol=module.create({operationWindow:f.window,admission:{resolve:async()=>A},api:{authorizeSocket:async()=>({permissions:{read:true,write:false,write_treatment:false,ack:false},collections:['entries']}),executeSocketMutation:async()=>{}},readCurrent:async()=>({identity:'same'}),runtime:()=>({}),domains:['entries'],storageEvents:reader});
   try{
    const socket=new Socket();await protocol.prepare(socket);protocol.bind(socket,'/storage');let answer;
    await Promise.all(socket.listeners('subscribe').map(fn=>fn({},value=>{answer=value;})));assert.equal(answer.success,true);
    const columns=Object.entries({id_kind:'string',doc:{_id:'scope-row',identifier:'public-scope-row',date:1}}).map(([name,value])=>({name,value}));
    tail=journal.append(tail,'entries',{xid:7,lsn:'0/20',action:'I',columns,identity:null},{maxRows:3,maxBytes:10000});
    const retained=await reader.read(A);
    assert.throws(()=>reader.assert(retained),/LIFECYCLE_WINDOW_SCOPE_INVALID/,'ACTUAL_WINDOW_MUST_REFUSE_OUTSIDE_SCOPE');
    await protocol.storage({tenant:A,tail:retained});
    assert.equal(socket.sent[0].event,'create');assert.equal(socket.sent[0].value.doc.identifier,'public-scope-row');
    options.phase='suspended';options.generation=String(Number(options.generation)+1);
    await f.window.drainTenant(A);await f.window.invalidateTenant(A);options.phase='active';
    await assert.rejects(protocol.storage({tenant:A,tail:retained}),/STORAGE_EVENT_RESTORE_CHANGED/,'PUBLICATION_MUST_REJECT_CHANGED_RESTORE_GENERATION');
    assert.equal(socket.sent.length,1,'STALE_GENERATION_MUST_NOT_SEND');
   }finally{protocol.close();}
  };
  await f.window.ready();
  try{
   await criterion(factory);
   const broken=require('./lib/clinical-working-set/control')('../lib/server/realtime/protocol',"const assertCurrent=()=>storageEvents?.assert?.(tail);", "const assertCurrent=()=>storageEvents?.assert?.(tail);assertCurrent();");
   await assert.rejects(criterion(broken),/LIFECYCLE_WINDOW_SCOPE_INVALID/);await criterion(factory);
  }finally{await f.window.close();}
 });

});
