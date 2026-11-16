'use strict';
// Actual evaluator/delivery monitor code with inert HTTP ports. No listener,
// maintained binary, OS child or database is started by this source protocol.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const delivery=require('../lib/pgstream/delivery-health');
const receiver=require('../lib/pgstream/receiver');
function load(file,ports,change=source=>source){
  const name=require.resolve(file),module=new Module(name);module.filename=name;module.paths=Module._nodeModulePaths(path.dirname(name));
  const ordinary=module.require.bind(module);module.require=request=>Object.hasOwn(ports,request)?ports[request]:ordinary(request);
  module._compile(change(fs.readFileSync(name,'utf8')),name);return module.exports;
}
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const A='11111111-1111-4111-8111-111111111111';
async function evaluator({healthy=true,schema=async()=>{},observe=async()=>({observed:{clock:'1'},completed:{clock:'1'}}),change}={}){
  let handler,ports,accepted=0,last=0;
  const config={connectionString:'postgres://synthetic:synthetic@127.0.0.1/synthetic',consumer:'synthetic',maxBytes:4096,timeIntervalMs:1000,tenants:new Map([[A,{}]]),namespaces:{clock:'stage_clock',checkpoint:'stage_work'},trustedWorker:{settings:'stage_settings',operatorPolicy:'stage_policy',activity:'stage_lifecycle'},pgstream:{receiver:{url:'http://127.0.0.1:23456/',trust:'network',bindHost:'127.0.0.1',maxBytes:8192,timeoutMs:1000},streamRole:'synthetic',slot:'stage_slot',bounds:{stepMs:1000}}};
  const selected=require('../lib/pgstream/evaluator').routes(config),url=config.connectionString;
  const wire={source:{postgres:{mode:'replication',url,replication:{replication_slot:'stage_slot',plugin:{add_tables:selected.map(row=>row.schema+'.'+row.table).join(',')}}}},target:{webhooks:{subscriptions:{store:{url:url+'?pool_max_conns=2',cache:{enabled:false}},server:{address:'127.0.0.1:23457'}},notifier:{strict_mode:true}}}};
  const store={own:async()=>{},admit:async()=>{},health:async()=>({pending:false}),observe,close:async()=>{},available:true};
  const server=new EventEmitter();server.listen=(port,host,done)=>done();server.close=done=>done();
  const implementation=load('../lib/pgstream/evaluator',{
    'node:fs':{readFileSync:file=>file==='/synthetic/wire'?JSON.stringify(wire):Buffer.from('synthetic-binary')},
    'node:crypto':{createHash:()=>({update(){return this;},digest:()=>require('../lib/pgstream/evaluator').BINARY_SHA256})},
    'node:http':{createServer:fn=>{handler=fn;return server;}},
    './checkpoint':{create:()=>store},'./receiver':receiver,
    './delivery-health':{RECEIVER_COUNTERS:delivery.RECEIVER_COUNTERS,start:async options=>{ports=options;return {receipt:value=>{if(value>1)throw Object.assign(new Error('PRIVATE_HEARTBEAT_ERROR'),{code:'PGSTREAM_HEARTBEAT_INVALID'});if(value>last){accepted++;last=value;}},health:()=>({healthy}),close:async()=>{}};}}
  },change);
  const opened=await implementation.open({config,connection:{readOnly:async()=>({rows:[{revision:'0'}]})},onInput:()=>{},onSchema:schema,onUnavailable:async()=>{},onRecovered:async()=>{}});
  async function send(body,{method='POST',url='/pgstream'}={}){let status;const req={method,url,async *[Symbol.asyncIterator](){yield Buffer.from(typeof body==='string'?body:JSON.stringify(body));}},res={writeHead:value=>{status=value;return res;},end(){}};await handler(req,res);return status;}
  return {opened,send,snapshot:()=>ports.receiverDiagnostics(),accepted:()=>accepted,store};
}
const ddl={Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'stage_clock',objects:[{schema:'stage_clock'}]})}};
const heartbeat=revision=>({Data:{action:'U',schema:'stage_clock',table:'nightscout_heartbeat',columns:[{name:'id',value:1},{name:'revision',value:revision}]}});
const clockEvent={Data:{action:'U',schema:'stage_clock',table:'tenant_write_clock',columns:[{name:'tenant_id',value:A},{name:'last_stamp',value:'1'}]}};
describe('payload-free receiver stage failure diagnostics (inert ports)',function(){
  it('exposes owned receipt readiness before stream freshness, and never exposes an unowned receiver',async()=>{const f=await evaluator({healthy:false});try{assert.equal(await f.send('',{method:'GET',url:'/pgstream/ready'}),204);assert.equal(f.opened.health().healthy,false);assert.throws(()=>f.opened.assertAvailable(),/EVALUATOR_FEED_UNAVAILABLE/);f.store.available=false;assert.equal(await f.send('',{method:'GET',url:'/pgstream/ready'}),503);}finally{await f.opened.close();}});
  it('distinguishes no arrival, route, body, parse and parsed-receiver refusals without retaining private text',async()=>{
    const f=await evaluator();try{
      assert(Object.values(f.snapshot()).every(value=>value===0));
      assert.equal(await f.send('PRIVATE_ROUTE',{method:'GET'}),404);
      assert.equal(await f.send('p'.repeat(8193)),503);
      assert.equal(await f.send('PRIVATE_PARSE'),503);
      assert.equal(await f.send({Data:{private:'PRIVATE_EVENT'}}),503);
      const state=f.snapshot();assert.equal(state.httpArrivals,4);assert.equal(state.routeRefusals,1);assert.equal(state.bodyRefusals,1);assert.equal(state.parseRefusals,1);assert.equal(state.parsed,1);assert.equal(state.receiverRefusals,1);assert.equal(state.receiverCompleted,0);assert.equal(state.receiverInFlight,0);
      assert.deepEqual(Object.keys(state),delivery.RECEIVER_COUNTERS);assert(!JSON.stringify(state).includes('PRIVATE'));
    }finally{await f.opened.close();}
  });
  it('reports schema in-flight before completion and withholds HTTP success until the actual callback finishes',async()=>{
    const hold=gate(),entered=gate(),f=await evaluator({schema:()=>{entered.resolve();return hold.promise;}});let status;
    try{const request=f.send(ddl).then(value=>{status=value;});await entered.promise;const during=f.snapshot();assert.equal(during.schemaStarted,1);assert.equal(during.schemaInFlight,1);assert.equal(during.schemaCompleted,0);assert.equal(during.receiverInFlight,1);assert.equal(status,undefined,'ACK_MUST_WAIT_FOR_SCHEMA');hold.resolve();await request;assert.equal(status,204);assert.equal(f.snapshot().schemaCompleted,1);assert.equal(f.snapshot().schemaInFlight,0);assert.equal(f.snapshot().receiverCompleted,1);assert.equal(during.schemaCompleted,0,'SNAPSHOT_MUST_NOT_ALIAS');}
    finally{hold.resolve();await f.opened.close();}
  });
  it('distinguishes rejected schema and receiver persistence from completed work without ACK relaxation',async()=>{
    for(const selection of ['schema','observe']){const error=Object.assign(new Error('PRIVATE_CALLBACK_DATA'),{code:'PRIVATE_CODE'}),f=await evaluator({[selection]:async()=>{throw error;}});
      try{assert.equal(await f.send(selection==='schema'?ddl:clockEvent),503);const state=f.snapshot();assert.equal(state.receiverRefusals,1);assert.equal(state.receiverCompleted,0);assert.equal(state.schemaRefusals,selection==='schema'?1:0);assert.equal(state.schemaCompleted,0);assert.equal(state.schemaInFlight,0);assert(!JSON.stringify(state).includes('PRIVATE'));}
      finally{await f.opened.close();}
    }
  });
  it('keeps heartbeat callbacks distinct from accepted monotone receipts, duplicate callbacks and rejection',async()=>{
    const f=await evaluator();try{assert.equal(await f.send(heartbeat(1)),204);assert.equal(await f.send(heartbeat(1)),204);assert.equal(await f.send(heartbeat(2)),503);const state=f.snapshot();assert.equal(state.heartbeatCallbacks,3);assert.equal(state.heartbeatCompleted,2);assert.equal(state.heartbeatRefusals,1);assert.equal(f.accepted(),1);assert.equal(state.receiverCompleted,2);assert.equal(state.receiverRefusals,1);}
    finally{await f.opened.close();}
  });
  it('control: omitting actual schema-entry instrumentation makes the in-flight witness red; restored source passes',async()=>{
    async function criterion(change){const hold=gate(),entered=gate(),f=await evaluator({change,schema:()=>{entered.resolve();return hold.promise;}});const request=f.send(ddl);try{await entered.promise;assert.equal(f.snapshot().schemaStarted,1,'SCHEMA_ENTRY_WITNESS');}finally{hold.resolve();await request;await f.opened.close();}}
    const needle="increment('schemaStarted');increment('schemaInFlight');";
    await assert.rejects(criterion(source=>{assert(source.includes(needle));return source.replace(needle,"increment('schemaInFlight');");}),/SCHEMA_ENTRY_WITNESS/);await criterion();
  });
});
async function deliveryMonitor(reader){
  let source={identity:true,grants:true,slot:'valid'},unavailable;
  const implementation=load('../lib/pgstream/delivery-health',{});
  const owner=await implementation.start({bounds:{heartbeatMs:10000,stallMs:20000,stepMs:100,recoveryMs:100000,pendingMs:5000},pulse:async()=>{},inspect:async()=>source,pending:async()=>({pending:false}),onUnavailable:async(code,signal,details)=>{unavailable=details;},receiverDiagnostics:reader,now:()=>100000});
  return {owner,fail:async()=>{source={...source,grants:false};await owner.check();return unavailable;}};
}
describe('delivery health receiver snapshot (no process lifecycle)',function(){
  it('includes fixed numeric receiver phases in original failure details while keeping them off health',async()=>{
    const counters=Object.fromEntries(delivery.RECEIVER_COUNTERS.map(key=>[key,0]));counters.httpArrivals=4;counters.schemaStarted=2;counters.schemaInFlight=1;counters.schemaCompleted=1;counters.heartbeatCallbacks=3;counters.heartbeatCompleted=2;counters.heartbeatRefusals=1;counters.private='PRIVATE_PAYLOAD';
    const f=await deliveryMonitor(()=>counters);try{f.owner.receipt(1);const details=await f.fail();assert.equal(details.code,'PGSTREAM_SOURCE_REFUSED');assert.equal(details.receiver.schemaInFlight,1);assert.equal(details.receiver.httpArrivals,4);assert.equal(details.receipts,1);assert.equal(details.receiver.heartbeatCallbacks,3);assert(!JSON.stringify(details).includes('PRIVATE'));assert.equal(Object.hasOwn(f.owner.health(),'receiver'),false);counters.schemaInFlight=0;assert.equal(details.receiver.schemaInFlight,1);}
    finally{await f.owner.close();}
  });
  it('marks missing/malformed/throwing snapshots unavailable without changing the refusal or reading getters',async()=>{
    for(const reader of [undefined,()=>({private:'PRIVATE_PAYLOAD'}),()=>{throw Error('PRIVATE_PAYLOAD');},()=>Object.fromEntries(delivery.RECEIVER_COUNTERS.map(key=>[key,Number.MAX_SAFE_INTEGER+1])),()=>{const fields=Object.fromEntries(delivery.RECEIVER_COUNTERS.map(key=>[key,0]));Object.defineProperty(fields,'httpArrivals',{get(){throw Error('GETTER_MUST_NOT_RUN');}});return fields;}]){
      const f=await deliveryMonitor(reader);try{const details=await f.fail();assert.equal(details.code,'PGSTREAM_SOURCE_REFUSED');assert.equal(details.receiver,null);assert(!JSON.stringify(details).includes('PRIVATE'));}finally{await f.owner.close();}
    }
  });
});
