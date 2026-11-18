'use strict';
// Source protocol only: real schema/receiver composition, recorded HTTP and
// database ports. Native clinical/role ownership is a separate owned control.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const receiver=require('../lib/pgstream/receiver');
const native=require('./lib/clinical-stream-native');
const file=require.resolve('../lib/pgstream/evaluator'),local=createRequire(file),actual=require(file);
const A='11111111-1111-4111-8111-111111111111';
const hold=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const marker={action:'M',xid:42,lsn:'0/20',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'test_clock',objects:[]})};
const envelope=()=>native.envelope([marker]);
const standalone={Data:marker};
async function fixture({schema=async()=>{},accept=async()=>[],recover=async()=>{},ready,change=source=>source}={}){
  let handler,loss,closed=0,terminal;
  const config={consumer:'evaluator-source-ready',maxBytes:4096,timeIntervalMs:1000,tenants:new Map([[A,{}]]),
    namespaces:{...Object.fromEntries(require('../lib/storage/clinical-stream-state').DOMAINS.map(domain=>[domain,'test_'+domain])),clock:'test_clock',checkpoint:'test_work'},
    trustedWorker:{settings:'test_settings',operatorPolicy:'test_policy',activity:'test_activity'},
    pgstream:{receiver:{url:'http://127.0.0.1:23456/',bindHost:'127.0.0.1',timeoutMs:1000,maxBytes:8192},streamRole:'test_stream',slot:'test_slot'}};
  const store={available:true,own:async fn=>{loss=fn;},admit:async()=>{},close:async()=>{closed++;}};
  const server=new EventEmitter();server.listen=(_port,_host,done)=>done();server.close=done=>done();
  const connection={async readOnly(sql){
    if(sql.includes('FROM pg_roles'))return {rows:[{rolsuper:false,rolbypassrls:false,rolreplication:true,nonowner:true,same_database:true,plugin:'wal2json',grants:true,wal_status:'reserved',restart_lsn:'0/1'}]};
    assert(sql.includes('pgstream.webhook_subscriptions'));
    return {rows:[...actual.routes(config).map(route=>({url:'http://127.0.0.1:23456/pgstream',schema_name:route.schema,table_name:route.table,event_types:['D','I','U']})),
      {url:'http://127.0.0.1:23456/pgstream',schema_name:'',table_name:'',event_types:['B','C','M']}]};
  }};
  const output={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+change(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>
    name==='node:http'?{createServer:fn=>{handler=fn;return server;}}:name==='./checkpoint'?{create:()=>store}:local(name),output,output.exports);
  const opened=await output.exports.open({config,connection,onInput:()=>{},onSchema:schema,onRecovered:recover,onSourceReady:ready,
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

  it('keeps recovery closed through schema verification and the subsequent clinical commit',async()=>{
    const schemaEntered=hold(),schemaRelease=hold(),acceptEntered=hold(),acceptRelease=hold();let wakes=0;
    const f=await fixture({ready:()=>{wakes++;},schema:async()=>{schemaEntered.resolve();await schemaRelease.promise;},
      accept:async()=>{acceptEntered.resolve();await acceptRelease.promise;return [];}});
    let delivery;
    try{
      await turn();assert.equal(wakes,1);
      delivery=f.send();await schemaEntered.promise;
      assert.equal(f.opened.canResumeVerification(),false);
      schemaRelease.resolve();await acceptEntered.promise;
      assert.equal(f.opened.health().schemaBlocked,false);
      assert.equal(f.opened.canResumeVerification(),false,'SOURCE_READY_MUST_AWAIT_CLINICAL_ACCEPTANCE');
      await turn();assert.equal(wakes,1);
      acceptRelease.resolve();assert.equal(await delivery,204);await turn();
      assert.equal(f.opened.canResumeVerification(),true);assert.equal(wakes,2);
      assert.equal(await f.send(native.envelope([])),204);await turn();assert.equal(wakes,2,'ORDINARY_RECEIVE_DOES_NOT_REPEAT_READY_WAKE');
    }finally{schemaRelease.resolve();acceptRelease.resolve();await delivery;await f.opened.close();}
  });

  it('keeps a failed current receive closed even after an unrelated successful receive',async()=>{
    let refuse=true,wakes=0;
    const f=await fixture({ready:()=>{wakes++;},accept:async()=>{if(refuse)throw Error('synthetic durable refusal');return [];}});
    try{
      await turn();assert.equal(wakes,1);assert.equal(await f.send(),503);
      assert.equal(f.opened.health().schemaBlocked,false);assert.equal(f.opened.canResumeVerification(),false);
      refuse=false;assert.equal(await f.send(native.envelope([])),204);await turn();
      assert.equal(f.opened.canResumeVerification(),false,'UNRELATED_RECEIVE_CANNOT_ACCEPT_FAILED_SCHEMA_CUT');assert.equal(wakes,1);
      assert.equal(await f.send(),204);await turn();assert.equal(f.opened.canResumeVerification(),true);assert.equal(wakes,2);
      assert.equal(f.opened.health().receiver.receiverRefusals,1);
    }finally{await f.opened.close();}
  });

  it('retains a failed schema refusal until its successful retry is actually accepted',async()=>{
    let refuse=true,wakes=0;
    const f=await fixture({ready:()=>{wakes++;},schema:async()=>{if(refuse)throw Error('synthetic schema refusal');}});
    try{
      await turn();assert.equal(await f.send(),503);assert.equal(f.opened.canResumeVerification(),false);assert.equal(wakes,1);
      assert.throws(f.opened.assertAvailable,/EVALUATOR_FEED_UNAVAILABLE/);
      refuse=false;assert.equal(await f.send(),204);await turn();assert.equal(f.opened.canResumeVerification(),true);assert.equal(wakes,2);
      assert.equal(f.opened.health().receiver.schemaRefusals,1);
    }finally{await f.opened.close();}
  });

  it('publishes the latest accepted cut when an older superseded schema settles last',async()=>{
    const entered=hold(),release=hold();let calls=0,wakes=0;
    const f=await fixture({ready:()=>{wakes++;},schema:async()=>{if(!calls++){entered.resolve();await release.promise;}}});
    let older;
    try{
      await turn();older=f.send();await entered.promise;
      assert.equal(await f.send(),204);assert.equal(f.opened.health().receiver.schemaInFlight,1);
      assert.equal(f.opened.canResumeVerification(),false,'SOURCE_READY_MUST_JOIN_OLDER_IN_FLIGHT_SCHEMA');await turn();assert.equal(wakes,1);
      release.resolve();assert.equal(await older,503);await turn();
      assert.equal(f.opened.canResumeVerification(),true);assert.equal(wakes,2,'OLDER_SETTLEMENT_MUST_RELEASE_LATEST_ACCEPTED_CUT');
      const stages=f.opened.health().receiver;assert.equal(stages.schemaRefusals,1);assert.equal(stages.receiverRefusals,1);assert.equal(stages.receiverCompleted,1);
    }finally{release.resolve();await older;await f.opened.close();}
  });

  it('never substitutes an older cut for a failed latest schema',async()=>{
    const entered=hold(),release=hold();let calls=0,wakes=0;
    const f=await fixture({ready:()=>{wakes++;},schema:async()=>{if(!calls++){entered.resolve();await release.promise;}else throw Error('latest schema refused');}});
    let older;
    try{
      await turn();older=f.send();await entered.promise;
      assert.equal(await f.send(),503);release.resolve();assert.equal(await older,503);await turn();
      assert.equal(f.opened.canResumeVerification(),false);assert.equal(wakes,1);
      assert.equal(f.opened.health().receiver.schemaRefusals,2);
    }finally{release.resolve();await older;await f.opened.close();}
  });

  it('never turns a late old clinical acceptance into acceptance of the current failed cut',async()=>{
    const entered=hold(),release=hold();let calls=0,wakes=0;
    const f=await fixture({ready:()=>{wakes++;},accept:async()=>{if(!calls++){entered.resolve();await release.promise;return [];}throw Error('latest clinical refusal');}});
    let older;
    try{
      await turn();older=f.send();await entered.promise;
      assert.equal(await f.send(),503);release.resolve();assert.equal(await older,204);await turn();
      assert.equal(f.opened.canResumeVerification(),false,'OLD_ACCEPTANCE_MUST_NOT_ACCEPT_CURRENT_SCHEMA');assert.equal(wakes,1);
    }finally{release.resolve();await older;await f.opened.close();}
  });

  it('does not withdraw the latest accepted cut when an older clinical acceptance arrives later',async()=>{
    const entered=hold(),release=hold();let calls=0,wakes=0;
    const f=await fixture({ready:()=>{wakes++;},accept:async()=>{if(!calls++){entered.resolve();await release.promise;}return [];}});
    let older;
    try{
      await turn();older=f.send();await entered.promise;
      assert.equal(await f.send(),204);await turn();assert.equal(f.opened.canResumeVerification(),true);assert.equal(wakes,2);
      release.resolve();assert.equal(await older,204);await turn();
      assert.equal(f.opened.canResumeVerification(),true,'OLDER_ACCEPTANCE_MUST_NOT_REPLACE_LATEST_ACCEPTED_CUT');assert.equal(wakes,2);
    }finally{release.resolve();await older;await f.opened.close();}
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
      const release=hold();let wakes=0,done=false,delivery;
      const f=await fixture({ready:()=>{if(++wakes===1)return;if(mode==='throw')throw Error('synthetic wake refusal');if(mode==='reject')return Promise.reject(Error('synthetic wake rejection'));return release.promise;}});
      try{
        await turn();delivery=f.send().then(status=>{done=true;return status;});await turn();
        assert.equal(done,true,'READY_CALLBACK_MUST_NOT_DELAY_ACK');assert.equal(await delivery,204);assert.equal(wakes,2);
        assert.equal(f.opened.canResumeVerification(),true);assert.equal(f.opened.health().receiver.receiverRefusals,0);
      }finally{release.resolve();await delivery;await f.opened.close();}
    }
  });
});
