'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const file=require.resolve('../lib/pgstream/evaluator'),actual=require(file),local=createRequire(file);
const A='11111111-1111-4111-8111-111111111111';
async function fixture({slot='reserved',grants=true,schema=async()=>{},recover=async()=>{},change=text=>text,schemaStartup}={}){
 let handler,loss,queries=0,bootstrap=0,closed=0,terminal,intervals=0;
 const config={consumer:'evaluator-synthetic',maxBytes:4096,timeIntervalMs:1000,tenants:new Map([[A,{}]]),namespaces:{clock:'test_clock',checkpoint:'test_work'},trustedWorker:{settings:'test_settings',operatorPolicy:'test_policy',activity:'test_activity'},pgstream:{receiver:{url:'http://127.0.0.1:23456/',bindHost:'127.0.0.1',timeoutMs:1000,maxBytes:8192},streamRole:'test_stream',slot:'test_slot',bounds:{stepMs:1000,recoveryMs:2000,pendingMs:2000}}};
 const store={available:true,own:async fn=>{loss=fn;},admit:async()=>{},observe:async()=>({observed:{clock:'1'},completed:{clock:'1'}}),close:async()=>{closed++;}};
 const server=new EventEmitter();server.listen=(port,host,done)=>done();server.close=done=>done();
 const connection={async readOnly(sql){queries++;if(sql.includes('FROM pg_roles'))return{rows:[{rolsuper:false,rolbypassrls:false,rolreplication:true,nonowner:true,same_database:true,plugin:'wal2json',grants,wal_status:slot,restart_lsn:slot==='missing'?null:'0/1'}]};assert(sql.includes('pgstream.webhook_subscriptions'));return{rows:[...actual.routes(config).map(route=>({url:'http://127.0.0.1:23456/pgstream',schema_name:route.schema,table_name:route.table,event_types:['D','I','U']})),{url:'http://127.0.0.1:23456/pgstream',schema_name:'',table_name:'',event_types:['M']}]};}};
 const module={exports:{}};vm.runInThisContext('(function(require,module,exports,setInterval){'+change(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>name==='node:http'?{createServer:fn=>{handler=fn;return server;}}:name==='./checkpoint'?{create:()=>store}:local(name),module,module.exports,()=>{intervals++;throw Error('IDLE_POLL_FORBIDDEN');});
 let opened,error;try{opened=await module.exports.open({config,connection,schemaStartup,onInput:()=>{},onSchema:schema,onUnavailable:async()=>{},onTerminal:code=>{terminal=code;},onRecovered:async s=>{bootstrap++;await recover(s);}});}catch(e){error=e;}
 async function send(body,{method='POST',url='/pgstream'}={}){let status;const req={method,url,async *[Symbol.asyncIterator](){yield Buffer.from(typeof body==='string'?body:JSON.stringify(body));}},res={writeHead(value){status=value;return this;},end(){}};await handler(req,res);return status;}
 return {opened,error,store,send,loss:()=>loss(),stats:()=>({queries,bootstrap,closed,terminal,intervals})};
}
const ddl={Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'test_clock',objects:[]})}};
describe('pgstream startup and useful schema admission without synthetic work',()=>{
 it('starts and stays available with no receipts, no pulse, no idle query or timer',async()=>{const f=await fixture();assert.ifError(f.error);try{await f.opened.ready();const before=f.stats();await new Promise(resolve=>setImmediate(resolve));f.opened.assertAvailable();assert.deepEqual(f.stats(),before);assert.equal(before.queries,2);assert.equal(before.bootstrap,1);assert.equal(before.intervals,0);assert(!JSON.stringify(f.opened.health()).includes('heartbeat'));assert.equal(await f.send({Data:{action:'U',schema:'test_clock',table:'nightscout_heartbeat',columns:[]}}),503);}finally{await f.opened.close();}});
 it('refuses lost/missing slot and serving grants; explicit operator rebootstrap remains required',async()=>{for(const options of [{slot:'lost'},{slot:'missing'},{grants:false}]){const f=await fixture(options);assert.match(f.error.message,options.grants===false?/PGSTREAM_SOURCE_REFUSED/:/PGSTREAM_REBOOTSTRAP_REQUIRED/);assert.equal(f.stats().bootstrap,0);assert.equal(f.stats().closed,1);}});
 it('refuses initial durable bootstrap errors instead of waiting for artificial delivery',async()=>{const f=await fixture({recover:async()=>{throw Error('SYNTHETIC_BOOTSTRAP_FAILED');}});assert.match(f.error.message,/BOOTSTRAP_FAILED/);assert.equal(f.stats().closed,1);});
 it('fences actual schema failure and recovers on the retried schema event without roster/heartbeat work',async()=>{let refuse=true;const f=await fixture({schema:async()=>{if(refuse)throw Error('SYNTHETIC_SCHEMA_REFUSED');}});try{assert.equal(await f.send(ddl),503);assert.throws(f.opened.assertAvailable,/FEED_UNAVAILABLE/);refuse=false;assert.equal(await f.send(ddl),204);f.opened.assertAvailable();assert.equal(f.stats().bootstrap,1);}finally{await f.opened.close();}});
 it('retains owner loss and payload-free route/body/parse refusal diagnostics',async()=>{const f=await fixture();try{assert.equal(await f.send('',{url:'/wrong'}),404);assert.equal(await f.send('{'),503);assert.equal(await f.send('x'.repeat(9000)),503);const h=f.opened.health();assert.equal(h.receiver.routeRefusals,1);assert.equal(h.receiver.parseRefusals,1);assert.equal(h.receiver.bodyRefusals,1);f.store.available=false;await f.loss();assert.throws(f.opened.assertAvailable,/FEED_UNAVAILABLE/);assert.equal(f.stats().terminal,'EVALUATOR_OWNER_UNAVAILABLE');}finally{await f.opened.close();}});
 it('controls: skipping source admission or owner fence is red; restored modules pass',async()=>{
  const broken=await fixture({slot:'lost',change:text=>text.replace('   await admitSource();','')});try{assert.throws(()=>assert(broken.error,'LOST_SLOT_MUST_REFUSE'),/LOST_SLOT_MUST_REFUSE/);}finally{await broken.opened?.close();}
  const good=await fixture({slot:'lost'});assert.match(good.error.message,/REBOOTSTRAP_REQUIRED/);
  const missing=await fixture({change:text=>text.replace('||!store.available)throw new Error(\'EVALUATOR_FEED_UNAVAILABLE\')',')throw new Error(\'EVALUATOR_FEED_UNAVAILABLE\')')});try{missing.store.available=false;assert.throws(()=>assert.throws(missing.opened.assertAvailable,/FEED_UNAVAILABLE/),{code:'ERR_ASSERTION'});}finally{await missing.opened.close();}
  const restored=await fixture();try{restored.store.available=false;assert.throws(restored.opened.assertAvailable,/FEED_UNAVAILABLE/);}finally{await restored.opened.close();}
 });
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function startupSchemaCriterion(change=text=>text){
 const schemaStartup=require('../lib/pgstream/schema-startup').create();
 const construction=deferred(),verification=deferred(),trace=[];
 const f=await fixture({schemaStartup,change,schema:async()=>{trace.push('schema');await verification.promise;trace.push('verified');}});
 let preparing,delivery,attempts=0;
 try{
  preparing=schemaStartup.prepare(async()=>{attempts++;trace.push('prepare');await construction.promise;try{f.opened.assertAvailable();}catch(error){throw schemaStartup.interrupted(error.message);}return 9;});
  preparing.catch(()=>{});await turn();delivery=f.send(ddl);await turn();
  assert.throws(f.opened.assertAvailable,/FEED_UNAVAILABLE/,'KNOWN_SCHEMA_MUST_FENCE_CLINICAL_COMPLETION');
  construction.resolve();await turn();let ready=false;preparing.then(()=>{ready=true;},()=>{});await turn();assert.equal(ready,false,'STARTUP_MUST_AWAIT_SCHEMA_VERIFICATION');
  verification.resolve();assert.equal(await delivery,204);assert.equal(await preparing,9);assert.equal(attempts,2,'SCHEMA_INTERRUPTED_CONSTRUCTION_MUST_RECONCILE');f.opened.assertAvailable();
 }finally{construction.resolve();verification.resolve();await Promise.allSettled([preparing,delivery]);await f.opened.close();}
}
describe('addressed schema events and consumer startup construction',()=>{
 it('fences clinical completion immediately and reconciles only interrupted startup admission',()=>startupSchemaCriterion());
 it('control: bypassing the actual receiver schema boundary fails; restored source passes',async()=>{
  const before="onSchema:schemas=>schemaStartup.schema(async()=>",after="onSchema:schemas=>(async()=>";
  await assert.rejects(startupSchemaCriterion(text=>{assert(text.includes(before));return text.replace(before,after).replace('   })});','   })()});');}),/EVALUATOR_FEED_UNAVAILABLE/);
  await startupSchemaCriterion();
 });
 it('waits for already-entered verification and refuses its actual failure before construction',async()=>{
  const schemaStartup=require('../lib/pgstream/schema-startup').create(),held=deferred();let entered=false,constructed=false;
  const f=await fixture({schemaStartup,schema:async()=>{entered=true;await held.promise;throw Error('UNSAFE_SCHEMA');}});
  const delivery=f.send(ddl);await turn();assert(entered);
  const preparing=schemaStartup.prepare(async()=>{constructed=true;});const refused=assert.rejects(preparing,/UNSAFE_SCHEMA/);await turn();assert.equal(constructed,false);held.resolve();await refused;assert.equal(await delivery,503);assert.equal(constructed,false);assert.throws(f.opened.assertAvailable,/FEED_UNAVAILABLE/);await f.opened.close();
 });
 it('refuses schema failure during construction and preserves unrelated constructor errors',async()=>{
  for(const constructorFails of [false,true]){
   const schemaStartup=require('../lib/pgstream/schema-startup').create(),held=deferred(),verification=deferred();let attempts=0;
   const f=await fixture({schemaStartup,schema:async()=>{await verification.promise;throw Error('UNSAFE_SCHEMA');}});
   const preparing=schemaStartup.prepare(async()=>{attempts++;await held.promise;if(constructorFails)throw Error('CONSTRUCTOR_REFUSED');throw schemaStartup.interrupted('EVALUATOR_FEED_UNAVAILABLE');});
   const refused=assert.rejects(preparing,constructorFails?/CONSTRUCTOR_REFUSED/:/UNSAFE_SCHEMA/);await turn();const delivery=f.send(ddl);await turn();held.resolve();verification.resolve();await refused;assert.equal(attempts,1);assert.equal(await delivery,503);assert.throws(f.opened.assertAvailable,/FEED_UNAVAILABLE/);await f.opened.close();
  }
 });
 it('never retries an untagged error or an availability refusal without a new schema generation',async()=>{
  for(const tagged of [false,true]){const gate=require('../lib/pgstream/schema-startup').create();let attempts=0;await assert.rejects(gate.prepare(async()=>{attempts++;throw tagged?gate.interrupted('EVALUATOR_FEED_UNAVAILABLE'):Error('CONSTRUCTOR_REFUSED');}));assert.equal(attempts,1);}
 });
});

describe('schema generation entering during an existing startup admission wait',()=>{
 it('retains the generation captured before waiting, so the later interrupted construction can reconcile',async()=>{
  const gate=require('../lib/pgstream/schema-startup').create(),first=deferred(),second=deferred();let attempts=0;
  const a=gate.schema(()=>first.promise);let unavailable=true;
  const preparing=gate.prepare(async()=>{attempts++;if(unavailable)throw gate.interrupted('EVALUATOR_FEED_UNAVAILABLE');return 7;});preparing.catch(()=>{});
  const b=gate.schema(async()=>{await second.promise;unavailable=false;});
  first.resolve();await a;await turn();assert.equal(attempts,1);second.resolve();await b;assert.equal(await preparing,7);assert.equal(attempts,2);
 });
});
