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
 it('default boot drains raw receipts and wakes only addressed owed delivery after transaction acceptance',async()=>{
  const text=require('node:fs').readFileSync(require.resolve('../lib/server/serve/preview-realtime'),'utf8');
  assert.match(text,/check:\s*tenants\s*=>\s*storageEvents\.check\(tenants,\s*\{\s*runtime,\s*protocol,\s*concurrency:\s*REFRESH_CONCURRENCY\s*\}\)/,'DEFAULT_MUST_DRAIN_RAW_EVENTS');
  const evaluate=require('node:fs').readFileSync(require.resolve('../lib/server/serve/evaluator-preview'),'utf8');
  const anchor='acceptTransaction:async(envelope,options)=>{';
  assert.equal(evaluate.split(anchor).length,2,'ONE_ACTUAL_TRANSACTION_ACCEPT_CALLBACK_REQUIRED');
  // Extract the actual selected source function with its syntax tree. Nothing
  // here copies the private implementation or loads a substitute application.
  // Durable acceptance is a faithful deferred port; no SQL is run by this test.
  const tree=require('@babel/parser').parse(evaluate,{sourceType:'script'}),callbacks=[];
  function visit(node){
   if(!node||typeof node!=='object')return;
   if(node.type==='ObjectProperty'&&node.key?.name==='acceptTransaction'&&node.value?.type==='ArrowFunctionExpression')callbacks.push(node.value);
   for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
  }
  visit(tree);assert.equal(callbacks.length,1);assert.equal(callbacks[0].async,true);
  const body=evaluate.slice(callbacks[0].start,callbacks[0].end);
  const B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',D='44444444-4444-4444-8444-444444444444',E='55555555-5555-4555-8555-555555555555';
  async function criterion(callback,{reject=false,assignment}={}){
   let committed,refused,calls=0;const wakes=[];
   const receipts=[{tenant:A,rawDeliveryPending:true,deliveryPending:false},{tenant:B,rawDeliveryPending:false,deliveryPending:true},
    {tenant:C,rawDeliveryPending:false,deliveryPending:false},{tenant:D},{tenant:E,rawDeliveryPending:true,deliveryPending:true}];
   const envelope={kind:'synthetic-complete-native-transaction'},options={source:'synthetic-source',maxTransactionRows:999,maxTransactionBytes:999};
   const replay={acceptTransaction:async(actual,selected)=>{
    calls++;assert.equal(actual,envelope);assert.deepEqual(selected,{...options,maxTransactionRows:123,maxTransactionBytes:10000,slice:assignment&&{count:assignment.count,ordinal:assignment.ordinal}});
    return new Promise((resolve,rejection)=>{committed=resolve;refused=rejection;});
   }};
   const accept=new Function('replay','outputWake','config','return '+callback)(replay,{wake:tenant=>wakes.push(tenant)},{pgstream:{transactionRows:123,receiver:{maxBytes:10000}},processAssignment:assignment});
   const accepting=accept(envelope,options);
   try{
    await Promise.resolve();assert.equal(calls,1);
    if(!committed){await accepting;assert.fail('EXACT_DURABLE_ACCEPTANCE_PORT_REQUIRED');}
    assert.deepEqual(wakes,[],'RAW_DELIVERY_MUST_WAIT_FOR_COMMITTED_TRANSACTION');
    if(reject){const error=new Error('SYNTHETIC_DURABLE_ACCEPTANCE_REFUSED');refused(error);await assert.rejects(accepting,actual=>actual===error);assert.deepEqual(wakes,[],'REFUSED_TRANSACTION_MUST_NOT_WAKE');}
    else{committed(receipts);assert.equal(await accepting,receipts,'RETURN_EXACT_DURABLE_RECEIPTS');assert.deepEqual(wakes,[A,B,E],'ONLY_OWED_RECEIPT_TENANTS_MUST_WAKE');}
   }finally{if(committed)committed(receipts);await accepting.catch(()=>{});}
  }
  await criterion(body);await criterion(body,{reject:true});
  await criterion(body,{assignment:{count:2,ordinal:1}});await criterion(body,{reject:true,assignment:{count:2,ordinal:1}});
  const mutations=[
   ['dropped static assignment',',slice:config.processAssignment&&{count:config.processAssignment.count,ordinal:config.processAssignment.ordinal}',''],
   ['suppressed wake','outputWake.wake(receipt.tenant)','void receipt'],
   ['global wake','outputWake.wake(receipt.tenant)','outputWake.wake()'],
   ['wrong tenant','outputWake.wake(receipt.tenant)',"outputWake.wake('"+C+"')"],
   ['raw-only wake','receipt.rawDeliveryPending||receipt.deliveryPending','receipt.rawDeliveryPending'],
   ['unconditional wake','receipt.rawDeliveryPending||receipt.deliveryPending','true'],
   ['early wake','async(envelope,options)=>{',"async(envelope,options)=>{outputWake.wake('"+A+"');"]
  ];
  for(const [label,needle,replacement]of mutations){
   assert.equal(body.split(needle).length,2,'CONTROL_APPLIES_EXACTLY_ONCE_'+label);
   await assert.rejects(criterion(body.replace(needle,replacement),{assignment:{count:2,ordinal:1}}),error=>error.code==='ERR_ASSERTION',label+' must violate the semantic criterion');
   await criterion(body,{assignment:{count:2,ordinal:1}});
  }
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
    options.phase='active';
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
