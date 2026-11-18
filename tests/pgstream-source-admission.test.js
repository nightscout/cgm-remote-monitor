'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const file=require.resolve('../lib/pgstream/evaluator'),actual=require(file),local=createRequire(file);
const A='11111111-1111-4111-8111-111111111111';
const fakeBaseline=require('./lib/schema-baseline-fake');
async function fixture({slot='reserved',grants=true,recover=async()=>{},change=text=>text,clinical,diagnostics,baseline={position:'0/40'}}={}){
 let handler,loss,queries=0,baselineQueries=0,bootstrap=0,closed=0,terminal,intervals=0;
 // Admission now covers clinical input namespaces as well as clock/control.
 const config={consumer:'evaluator-synthetic',maxBytes:4096,timeIntervalMs:1000,tenants:new Map([[A,{}]]),namespaces:{...Object.fromEntries(require('../lib/storage/clinical-stream-state').DOMAINS.map(domain=>[domain,'test_'+domain])),clock:'test_clock',checkpoint:'test_work'},trustedWorker:{settings:'test_settings',operatorPolicy:'test_policy',activity:'test_activity'},pgstream:{receiver:{url:'http://127.0.0.1:23456/',bindHost:'127.0.0.1',timeoutMs:1000,maxBytes:8192},streamRole:'test_stream',slot:'test_slot',bounds:{stepMs:1000,recoveryMs:2000,pendingMs:2000}}};
 const store={available:true,own:async fn=>{loss=fn;},admit:async()=>{},observe:async()=>({observed:{clock:'1'},completed:{clock:'1'}}),close:async()=>{closed++;}};
 const server=new EventEmitter();server.listen=(port,host,done)=>done();server.close=done=>done();
 const connection={async readOnly(sql,values){const startup=fakeBaseline.answer(sql,values,baseline);if(startup){baselineQueries++;return startup;}queries++;if(sql.includes('FROM pg_roles'))return{rows:[{rolsuper:false,rolbypassrls:false,rolreplication:true,nonowner:true,same_database:true,plugin:'wal2json',grants,wal_status:slot,restart_lsn:slot==='missing'?null:'0/1'}]};assert(sql.includes('pgstream.webhook_subscriptions'));return{rows:[...actual.routes(config).map(route=>({url:'http://127.0.0.1:23456/pgstream',schema_name:route.schema,table_name:route.table,event_types:['D','I','U']})),{url:'http://127.0.0.1:23456/pgstream',schema_name:'',table_name:'',event_types:['B','C','M']}]};}};
 const module={exports:{}};vm.runInThisContext('(function(require,module,exports,setInterval){'+change(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>name==='node:http'?{createServer:fn=>{handler=fn;return server;}}:name==='./checkpoint'?{create:()=>store}:name==='../diagnostics/pgstream-receiver' && diagnostics ? diagnostics : local(name),module,module.exports,()=>{intervals++;throw Error('IDLE_POLL_FORBIDDEN');});
 let opened,error;try{opened=await module.exports.open({config,connection,clinical,onInput:()=>{},onUnavailable:async()=>{},onTerminal:code=>{terminal=code;},onRecovered:async s=>{bootstrap++;await recover(s);}});}catch(e){error=e;}
 async function send(body,{method='POST',url='/pgstream'}={}){let status;const req={method,url,async *[Symbol.asyncIterator](){yield Buffer.from(typeof body==='string'?body:JSON.stringify(body));}},res={writeHead(value){status=value;return this;},end(){}};await handler(req,res);return status;}
 return {opened,error,store,send,handler,loss:()=>loss(),stats:()=>({queries,baselineQueries,bootstrap,closed,terminal,intervals})};
}
const ddl={Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'test_clock',objects:[]})}};
const native=require('./lib/clinical-stream-native');
const marker={action:'M',xid:42,lsn:'0/20',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'test_clock',objects:[]})};
describe('pgstream startup and useful schema admission without synthetic work',()=>{
 it('starts and stays available with no receipts, no pulse, no idle query or timer',async()=>{const f=await fixture();assert.ifError(f.error);try{await f.opened.ready();const before=f.stats();await new Promise(resolve=>setImmediate(resolve));f.opened.assertAvailable();assert.deepEqual(f.stats(),before);assert.equal(before.queries,2);assert.equal(before.baselineQueries,3,'ONE_POSITION_SNAPSHOT_AND_SETTLED_CHECK');assert.equal(before.bootstrap,1);assert.equal(before.intervals,0);assert(!JSON.stringify(f.opened.health()).includes('heartbeat'));assert.equal(await f.send({Data:{action:'U',schema:'test_clock',table:'nightscout_heartbeat',columns:[]}}),503);}finally{await f.opened.close();}});
 it('refuses lost/missing slot and serving grants; explicit operator rebootstrap remains required',async()=>{for(const options of [{slot:'lost'},{slot:'missing'},{grants:false}]){const f=await fixture(options);assert.match(f.error.message,options.grants===false?/PGSTREAM_SOURCE_REFUSED/:/PGSTREAM_REBOOTSTRAP_REQUIRED/);assert.equal(f.stats().bootstrap,0);assert.equal(f.stats().closed,1);}});
 it('refuses initial durable bootstrap errors instead of waiting for artificial delivery',async()=>{const f=await fixture({recover:async()=>{throw Error('SYNTHETIC_BOOTSTRAP_FAILED');}});assert.match(f.error.message,/BOOTSTRAP_FAILED/);assert.equal(f.stats().closed,1);});
 // Decision stable-evaluator-runtime: covered DDL costs no source query, bootstrap
 // or roster work; DDL after the startup baseline is terminal.
 it('acknowledges covered DDL with no source query, bootstrap or roster work, and stops on later DDL',async()=>{const f=await fixture({clinical:{maxTransactionRows:100,maxTransactionBytes:8192,acceptTransaction:async()=>[]}});try{const before=f.stats();assert.equal(await f.send(native.envelope([marker],'0/40')),204);f.opened.assertAvailable();assert.deepEqual(f.stats(),before,'COVERED_DDL_IS_FREE');assert.equal(await f.send(native.envelope([marker],'0/41')),503);assert.throws(f.opened.assertAvailable,/FEED_UNAVAILABLE/);assert.equal(f.stats().terminal,'EVALUATOR_SCHEMA_CHANGED_AFTER_STARTUP');assert.equal(f.stats().queries,before.queries,'NO_IN_PLACE_REVERIFICATION');assert.equal(f.stats().bootstrap,1);}finally{await f.opened.close();}});
 it('refuses a standalone DDL marker without a commit position after the baseline',async()=>{const f=await fixture();try{assert.equal(await f.send(ddl),503);assert.equal(f.stats().terminal,'EVALUATOR_SCHEMA_CHANGED_AFTER_STARTUP');}finally{await f.opened.close();}});
 it('retains owner loss and payload-free route/body/parse refusal diagnostics',async()=>{const f=await fixture();try{assert.equal(await f.send('',{url:'/wrong'}),404);assert.equal(await f.send('{'),503);assert.equal(await f.send('x'.repeat(9000)),503);const h=f.opened.health();assert.equal(h.receiver.routeRefusals,1);assert.equal(h.receiver.parseRefusals,1);assert.equal(h.receiver.bodyRefusals,1);f.store.available=false;await f.loss();assert.throws(f.opened.assertAvailable,/FEED_UNAVAILABLE/);assert.equal(f.stats().terminal,'EVALUATOR_OWNER_UNAVAILABLE');}finally{await f.opened.close();}});
 it('controls: skipping source admission or owner fence is red; restored modules pass',async()=>{
  const broken=await fixture({slot:'lost',change:text=>text.replace('   await admitSource();','')});try{assert.throws(()=>assert(broken.error,'LOST_SLOT_MUST_REFUSE'),/LOST_SLOT_MUST_REFUSE/);}finally{await broken.opened?.close();}
  const good=await fixture({slot:'lost'});assert.match(good.error.message,/REBOOTSTRAP_REQUIRED/);
  const missing=await fixture({change:text=>text.replace('||!store.available)throw new Error(\'EVALUATOR_FEED_UNAVAILABLE\')',')throw new Error(\'EVALUATOR_FEED_UNAVAILABLE\')')});try{missing.store.available=false;assert.throws(()=>assert.throws(missing.opened.assertAvailable,/FEED_UNAVAILABLE/),{code:'ERR_ASSERTION'});}finally{await missing.opened.close();}
  const restored=await fixture();try{restored.store.available=false;assert.throws(restored.opened.assertAvailable,/FEED_UNAVAILABLE/);}finally{await restored.opened.close();}
 });
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
describe('pgstream receiver observations', () => {
 async function probe({enabled, abort=false, refuse=false, change=text=>text}) {
  const http=require('node:http');
  const diagnostics=require('../lib/diagnostics/pgstream-receiver');
  const lines=[], schemaEntered=deferred(), release=deferred(), disconnected=deferred(), completed=deferred();
  const captured={create:()=>diagnostics.create({write:line=>{
   const row=JSON.parse(line.slice('PGSTREAM_RECEIVER_TRACE '.length));
   lines.push(row);
   if(row.event==='closed-before-finish') disconnected.resolve();
   if(row.phase==='receive-completed') completed.resolve();
  }})};
  const privateMarker={...marker,content:JSON.stringify({schema_name:'test_clock',objects:[],private:'MUST_STAY_PRIVATE'})};
  const body=JSON.stringify(native.envelope([privateMarker]));
  let writes=0;
  const previous=process.env.NS_PGSTREAM_RECEIVER_TRACE;
  let f;
  try {
   if(enabled) process.env.NS_PGSTREAM_RECEIVER_TRACE='1'; else delete process.env.NS_PGSTREAM_RECEIVER_TRACE;
   f=await fixture({change,diagnostics:captured,clinical:{maxTransactionRows:100,maxTransactionBytes:8192,
    acceptTransaction:async()=>{schemaEntered.resolve();await release.promise;if(refuse)throw Error('MUST_STAY_PRIVATE');writes++;return [];}}});
  } finally {
   if(previous===undefined) delete process.env.NS_PGSTREAM_RECEIVER_TRACE; else process.env.NS_PGSTREAM_RECEIVER_TRACE=previous;
  }
  assert.ifError(f.error);
  const server=http.createServer(f.handler);
  try {
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   let request;
   const response=new Promise((resolve,reject)=>{
    request=http.request({host:'127.0.0.1',port:server.address().port,path:'/pgstream',method:'POST'},res=>{
     res.resume();res.on('end',()=>resolve(res.statusCode));
    });
    request.on('error',reject);request.end(body);
   });
   response.catch(()=>{});
   await schemaEntered.promise;
   assert.equal(f.opened.health().receiver.receiverInFlight,1);assert.equal(f.opened.health().receiver.schemaAcknowledged,1);
   if(abort){
    request.destroy();await assert.rejects(response,{code:'ECONNRESET'});
    await disconnected.promise;
   }
   release.resolve();
   if(abort) await completed.promise; else assert.equal(await response,refuse?503:204);
   assert.equal(writes,refuse?0:1);
   assert.equal(f.opened.health().receiver.receiverCompleted,writes);
   assert(!JSON.stringify(lines).includes('MUST_STAY_PRIVATE'));
   return lines;
  } finally {
   release.resolve();server.closeAllConnections();
   if(server.listening) await new Promise(resolve=>server.close(resolve));
   await f.opened.close();
  }
 }
 it('keeps ordinary replies and the default-off path, and pairs early close with the in-flight operation',async()=>{
  assert.deepEqual(await probe({enabled:false}),[]);
  const normal=await probe({enabled:true});
  assert.equal(normal[0].event,'listening');
  assert.equal(normal.at(-1).event,'response-finished');assert.equal(normal.at(-1).status,204);
  assert(normal.some(x=>x.phase==='clinical-accept' && x.position==='0/30' && x.rows===1 && x.hasSchemaMarker));
  const aborted=await probe({enabled:true,abort:true});
  const closed=aborted.find(x=>x.event==='closed-before-finish');
  assert.equal(closed.phase,'clinical-accept');assert.equal(closed.position,'0/30');
  assert.equal(aborted.at(-1).phase,'receive-completed');
  assert(aborted.filter(x=>x.event!=='listening').every(x=>x.request===closed.request));
  for (const enabled of [false,true]) {
   const refused=await probe({enabled,refuse:true});
   if(enabled) {
    assert(refused.some(x=>x.event==='refused' && x.phase==='clinical-accept'));
    assert.equal(refused.at(-1).status,503);
   } else assert.deepEqual(refused,[]);
  }
 });
 it('detects removal of the actual schema phase marker with otherwise successful HTTP delivery',async()=>{
  const criterion=async change=>{
   const rows=await probe({enabled:true,change});
   assert(rows.some(x=>x.phase==='schema-baseline-covered'),'SCHEMA_PHASE_NOT_OBSERVED');
  };
  const mark="trace?.mark('schema-baseline-'+disposition);";
  await criterion();
  await assert.rejects(criterion(source=>{assert(source.includes(mark));return source.replace(mark,'');}),/SCHEMA_PHASE_NOT_OBSERVED/);
  await criterion();
 });
 it('reports gaps after backpressure and caps records in a busy second',()=>{
  const diagnostics=require('../lib/diagnostics/pgstream-receiver');
  let at=1000, writable=false;
  const rows=[];
  const capture=diagnostics.create({canWrite:()=>writable,wall:()=>at,write:line=>rows.push(JSON.parse(line.slice('PGSTREAM_RECEIVER_TRACE '.length)))});
  capture.listening();writable=true;capture.listening();
  assert.equal(rows[0].dropped,1);
  for(let i=0;i<100;i++)capture.listening();
  assert.equal(rows.length,100);
  at+=1000;capture.listening();
  assert.equal(rows.at(-1).dropped,1);
 });
});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
// The source no longer registers schema work (decision stable-evaluator-runtime).
// These remain unit checks of the schema-startup helper itself.
describe('schema-startup helper without production schema work',()=>{
 it('never retries an untagged error or an availability refusal without a new schema generation',async()=>{
  for(const tagged of [false,true]){const gate=require('../lib/pgstream/schema-startup').create();let attempts=0;await assert.rejects(gate.prepare(async()=>{attempts++;throw tagged?gate.interrupted('EVALUATOR_FEED_UNAVAILABLE'):Error('CONSTRUCTOR_REFUSED');}));assert.equal(attempts,1);}
 });
});

describe('schema generation entering during an existing startup admission wait',()=>{
 it('joins every entered schema before beginning construction',async()=>{
  const gate=require('../lib/pgstream/schema-startup').create(),first=deferred(),second=deferred();let attempts=0;
  const a=gate.schema(()=>first.promise);let unavailable=true;
  const preparing=gate.prepare(async()=>{attempts++;if(unavailable)throw gate.interrupted('EVALUATOR_FEED_UNAVAILABLE');return 7;});preparing.catch(()=>{});
  const b=gate.schema(async()=>{await second.promise;unavailable=false;});
  // A stable admission cut is stronger than constructing and retrying during
  // known in-flight schema work: no constructor runs before both events settle.
  first.resolve();await a;await turn();assert.equal(attempts,0);second.resolve();await b;assert.equal(await preparing,7);assert.equal(attempts,1);
 });
});
