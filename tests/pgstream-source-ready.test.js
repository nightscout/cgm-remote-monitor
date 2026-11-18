'use strict';
// Source protocol only: real schema/receiver composition, recorded HTTP and
// database ports. Native clinical/role ownership is a separate owned control.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const receiver=require('../lib/pgstream/receiver');
const native=require('./lib/clinical-stream-native');
const fakeBaseline=require('./lib/schema-baseline-fake');
const file=require.resolve('../lib/pgstream/evaluator'),local=createRequire(file),actual=require(file);
const A='11111111-1111-4111-8111-111111111111';
const hold=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const marker={action:'M',xid:42,lsn:'0/20',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'test_clock',objects:[]})};
const envelope=()=>native.envelope([marker]);
const standalone={Data:marker};
let sendDuringOpen;
const sendDuring=async()=>sendDuringOpen;
async function fixture({accept=async()=>[],recover=async()=>{},ready,change=source=>source,baseline={},holdAdmission}={}){
  let handler,loss,closed=0,terminal;
  const config={consumer:'evaluator-source-ready',maxBytes:4096,timeIntervalMs:1000,tenants:new Map([[A,{}]]),
    namespaces:{...Object.fromEntries(require('../lib/storage/clinical-stream-state').DOMAINS.map(domain=>[domain,'test_'+domain])),clock:'test_clock',checkpoint:'test_work'},
    trustedWorker:{settings:'test_settings',operatorPolicy:'test_policy',activity:'test_activity'},
    pgstream:{receiver:{url:'http://127.0.0.1:23456/',bindHost:'127.0.0.1',timeoutMs:1000,maxBytes:8192},streamRole:'test_stream',slot:'test_slot',bounds:{stepMs:1000,recoveryMs:2000,pendingMs:2000}}};
  const store={available:true,own:async fn=>{loss=fn;},admit:async()=>{},close:async()=>{closed++;}};
  const server=new EventEmitter();server.listen=(_port,_host,done)=>done();server.close=done=>done();
  const connection={async readOnly(sql,values){
    const startup=fakeBaseline.answer(sql,values,baseline);if(startup)return startup;
    if(sql.includes('FROM pg_roles')){if(holdAdmission)await holdAdmission();return {rows:[{rolsuper:false,rolbypassrls:false,rolreplication:true,nonowner:true,same_database:true,plugin:'wal2json',grants:true,wal_status:'reserved',restart_lsn:'0/1'}]};}
    assert(sql.includes('pgstream.webhook_subscriptions'));
    return {rows:[...actual.routes(config).map(route=>({url:'http://127.0.0.1:23456/pgstream',schema_name:route.schema,table_name:route.table,event_types:['D','I','U']})),
      {url:'http://127.0.0.1:23456/pgstream',schema_name:'',table_name:'',event_types:['B','C','M']}]};
  }};
  const output={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+change(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>
    name==='node:http'?{createServer:fn=>{handler=fn;sendDuringOpen=body=>send(body);return server;}}:name==='./checkpoint'?{create:()=>store}:local(name),output,output.exports);
  const opened=await output.exports.open({config,connection,onInput:()=>{},onRecovered:recover,onSourceReady:ready,
    onUnavailable:async()=>{},onTerminal:code=>{terminal=code;},clinical:{maxTransactionRows:100,maxTransactionBytes:8192,acceptTransaction:accept}});
  async function send(body=envelope(),{onEnd}={}){
    let status;
    const req={method:'POST',url:'/pgstream',async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}};
    const res={writeHead(value){status=value;return this;},end(){onEnd?.();}};
    await handler(req,res);return status;
  }
  return {opened,store,send,loss:()=>loss(),stats:()=>({closed,terminal})};
}

describe('post-receive source readiness',function(){
  it('publishes initial readiness only after recovery and validates the optional callback',async()=>{
    const entered=hold(),release=hold();let wakes=0,recovered=false;
    const opening=fixture({recover:async()=>{entered.resolve();await release.promise;recovered=true;},ready:()=>{assert(recovered);wakes++;}});
    await entered.promise;assert.equal(wakes,0);release.resolve();const f=await opening;
    try{await turn();assert.equal(wakes,1);assert.equal(f.opened.canResumeVerification(),true);}
    finally{await f.opened.close();}
    for(const ready of [null,false,{},'callback'])await assert.rejects(fixture({ready}),TypeError);
    const optional=await fixture();await optional.opened.close();
  });

  it('keeps accepted schema receipts private and preserves the receiver result contract',async()=>{
    const token=Symbol('private schema'),entered=hold(),release=hold();let returned=false;
    const receive=receiver.create({routes:[],relevantSchemas:['test_clock'],store:{},onInput:()=>{},onSchema:async()=>token,
      clinical:{maxTransactionRows:100,maxTransactionBytes:8192,acceptTransaction:async()=>{entered.resolve();await release.promise;return [];}}});
    const pending=receive(envelope()).then(result=>{returned=true;return result;});
    await entered.promise;assert.equal(returned,false,'RESULT_MUST_WAIT_FOR_CLINICAL_ACCEPTANCE');
    release.resolve();const result=await pending;
    assert.deepEqual(result,{kind:'transaction',tenants:[]});assert.deepEqual(Object.getOwnPropertySymbols(result),[]);
    assert.equal(receiver.acceptedSchemaToken(result),token);
    for(const copy of [{...result},structuredClone(result),{},null])assert.equal(receiver.acceptedSchemaToken(copy),null);
    const schema=await receive(standalone);assert.deepEqual(schema,{kind:'schema'});assert.equal(receiver.acceptedSchemaToken(schema),token);
    const irrelevant=await receive({Data:{...marker,content:JSON.stringify({schema_name:'foreign',objects:[]})}});
    assert.deepEqual(irrelevant,{kind:'irrelevant-schema'});assert.equal(receiver.acceptedSchemaToken(irrelevant),null);
    const refusal=Error('synthetic durable refusal');
    const failed=receiver.create({routes:[],relevantSchemas:['test_clock'],store:{},onInput:()=>{},onSchema:async()=>token,
      clinical:{maxTransactionRows:100,maxTransactionBytes:8192,acceptTransaction:async()=>{throw refusal;}}});
    await assert.rejects(failed(envelope()),error=>error===refusal);
  });

  // Decision stable-evaluator-runtime: one startup-verified source cut. DDL at
  // or before it is acknowledged with no new cut; later relevant DDL is terminal.
  it('acknowledges replayed DDL at or before the startup baseline without blocking or a second wake',async()=>{
    let wakes=0;const f=await fixture({ready:()=>{wakes++;},baseline:{position:'0/40'}});
    try{
      await turn();assert.equal(wakes,1);
      for(const position of ['0/20','0/30','0/40'])assert.equal(await f.send(native.envelope([marker],position)),204);
      await turn();assert.equal(wakes,1,'COVERED_DDL_IS_NOT_A_NEW_SOURCE_CUT');
      assert.equal(f.opened.canResumeVerification(),true);f.opened.assertAvailable();
      const h=f.opened.health();
      assert.equal(h.schemaBlocked,false);assert.equal(h.receiver.schemaAcknowledged,3);assert.equal(h.receiver.schemaRefusals,0);
      assert.deepEqual(h.schema,{phase:'established',baseline:'0/40',acknowledged:3,startupAcknowledged:0,repeated:0,terminalPosition:null});
      assert.equal(f.stats().terminal,undefined);
    }finally{await f.opened.close();}
  });

  it('treats a repeated already-acknowledged position as a no-op',async()=>{
    const f=await fixture({baseline:{position:'0/40'}});
    try{
      const twice=native.envelope([marker],'0/30');
      assert.equal(await f.send(twice),204);assert.equal(await f.send(twice),204);
      const h=f.opened.health();
      assert.equal(h.receiver.schemaRepeated,1);assert.equal(h.schema.acknowledged,1);assert.equal(h.schema.repeated,1);
      assert.equal(f.opened.canResumeVerification(),true);
    }finally{await f.opened.close();}
  });

  it('refuses relevant DDL after the baseline, blocks the source and stops the role with one typed code',async()=>{
    let wakes=0;const f=await fixture({ready:()=>{wakes++;},baseline:{position:'0/40'}});
    try{
      await turn();assert.equal(wakes,1);
      assert.equal(await f.send(native.envelope([marker],'0/50')),503);
      assert.equal(f.stats().terminal,actual.SCHEMA_TERMINAL);assert.equal(actual.SCHEMA_TERMINAL,'EVALUATOR_SCHEMA_CHANGED_AFTER_STARTUP');
      assert.throws(f.opened.assertAvailable,/EVALUATOR_FEED_UNAVAILABLE/);await assert.rejects(f.opened.ready(),/PGSTREAM_NOT_READY/);
      assert.equal(f.opened.canResumeVerification(),false);
      // Neither a covered position nor ordinary input reopens the source.
      assert.equal(await f.send(native.envelope([marker],'0/30')),503);assert.equal(await f.send(native.envelope([marker],'0/50')),503);
      await turn();assert.equal(f.opened.canResumeVerification(),false);assert.equal(wakes,1);
      const h=f.opened.health();assert.equal(h.schema.phase,'terminal');assert.equal(h.schema.terminalPosition,'0/50');assert.equal(h.receiver.schemaRefusals,3,'EVERY_REFUSED_DELIVERY_COUNTED');
    }finally{await f.opened.close();}
  });

  it('ignores DDL outside the evaluator schemas after the baseline',async()=>{
    const f=await fixture({baseline:{position:'0/40'}});
    try{
      const foreign={...marker,content:JSON.stringify({schema_name:'unrelated',objects:[]})};
      assert.equal(await f.send(native.envelope([foreign],'0/90')),204);
      assert.equal(f.stats().terminal,undefined);assert.equal(f.opened.health().receiver.schemaStarted,0);f.opened.assertAvailable();
    }finally{await f.opened.close();}
  });

  it('compares DDL that arrives while the position is being read against that position',async()=>{
    for(const [ddl,expected] of [['0/40',204],['0/41',503]]){
      const read=hold(),release=hold();let status;
      const opening=fixture({baseline:{position:async()=>{read.resolve();await release.promise;return '0/40';}}});
      await read.promise;
      const delivery=(await sendDuring()).call(null,native.envelope([marker],ddl));
      release.resolve();const f=await opening;status=await delivery;
      try{assert.equal(status,expected,'CAPTURING_POSITION_'+ddl);assert.equal(f.stats().terminal,expected===503?actual.SCHEMA_TERMINAL:undefined);}
      finally{await f.opened.close();}
    }
  });

  it('acknowledges DDL received before the position read as committed before it',async()=>{
    const admission=hold(),release=hold();
    const opening=fixture({holdAdmission:async()=>{admission.resolve();await release.promise;}});
    await admission.promise;
    const delivery=(await sendDuring()).call(null,native.envelope([marker],'0/FFFFFFFF'));
    assert.equal(await delivery,204,'STARTUP_DDL_PRECEDES_BASELINE');
    release.resolve();const f=await opening;
    try{const h=f.opened.health();assert.equal(h.schema.startupAcknowledged,1);assert.equal(h.schema.phase,'established');f.opened.assertAvailable();}
    finally{await f.opened.close();}
  });

  it('control: comparing against no baseline acknowledges post-baseline DDL; restored source refuses it',async()=>{
    async function criterion(change){
      const f=await fixture({change,baseline:{position:'0/40'}});
      try{assert.equal(await f.send(native.envelope([marker],'0/50')),503,'POST_BASELINE_DDL_MUST_REFUSE');}finally{await f.opened.close();}
    }
    const needle="     const disposition=await baseline.observe(position);";
    await assert.rejects(criterion(text=>{assert.equal(text.split(needle).length,2);return text.replace(needle,"     const disposition='covered';");}),/POST_BASELINE_DDL_MUST_REFUSE/);
    await criterion(text=>text);
  });

  it('keeps the independent owner witness mandatory before its loss callback completes',async()=>{
    const f=await fixture();
    try{
      assert.equal(f.opened.canResumeVerification(),true);f.store.available=false;
      assert.equal(f.opened.canResumeVerification(),false,'SOURCE_READY_MUST_REQUIRE_CURRENT_OWNER');
      await f.loss();assert.equal(f.opened.canResumeVerification(),false);
    }finally{await f.opened.close();}
  });

  it('checks owner loss and closure before publishing a ready wake',async()=>{
    for(const close of [false,true]){
      let wakes=0,stopping;
      const f=await fixture({ready:()=>{wakes++;}});
      try{
        await turn();assert.equal(wakes,1);
        assert.equal(await f.send(envelope(),{onEnd:()=>{
          if(close)stopping=f.opened.close();else {f.store.available=false;stopping=f.loss();}
        }}),204);
        await stopping;await turn();assert.equal(f.opened.canResumeVerification(),false);assert.equal(wakes,1);
        if(!close)assert.equal(f.stats().terminal,'EVALUATOR_OWNER_UNAVAILABLE');
      }finally{await f.opened.close();}
    }
  });

  it('does not await callback work or turn callback throw/rejection into a receive failure',async()=>{
    for(const mode of ['held','throw','reject']){
      const release=hold();let wakes=0,delivery;
      const f=await fixture({ready:()=>{wakes++;if(mode==='throw')throw Error('synthetic wake refusal');if(mode==='reject')return Promise.reject(Error('synthetic wake rejection'));return release.promise;}});
      try{
        await turn();assert.equal(wakes,1);
        delivery=f.send();assert.equal(await delivery,204,'READY_CALLBACK_MUST_NOT_DELAY_OR_FAIL_ACK');
        assert.equal(f.opened.canResumeVerification(),true);assert.equal(f.opened.health().receiver.receiverRefusals,0);
      }finally{release.resolve();await delivery;await f.opened.close();}
    }
  });
});
