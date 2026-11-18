'use strict';
// Actual source composition with supplied protocol doubles; no PostgreSQL/runtime qualification.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
const fixed=require('../lib/pgstream/fixed-assignment');
const owners=require('../lib/tenant-notifications/partition-owner');
const ids=Array.from({length:64},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const assignment=fixed.create({tenants:ids,members:2,revision:'7'});
const binding={checkpointNamespace:'test_checkpoint',membershipNamespace:'test_membership',lifecycleNamespace:'test_control',consumer:'synthetic',evaluatorConsumer:'evaluator-synthetic-completed'};
const partition=ordinal=>({...binding,assignment,self:{ordinal,memberId:ids[ordinal],rule:assignment.rule},currentGeneration:()=> '1'});
function isolated(relative,mocks,mutate=raw=>raw){
 const filename=path.resolve(__dirname,'../lib',relative),loaded=new Module(filename,module);
 loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
 const original=loaded.require.bind(loaded);loaded.require=name=>Object.hasOwn(mocks,name)?mocks[name]:original(name);
 loaded._compile(mutate(fs.readFileSync(filename,'utf8')),filename);return loaded.exports;
}
function preparation(ordinal,{roster=ids,inactive=[],mutate}={}){
 const calls={opens:0,catalogue:0,suppression:0,ready:[],reads:[],owners:0};
 const owner=owners.configure(partition(ordinal),'test_outbox');
 const connection={transaction:fn=>fn(),query:async()=>({rows:[]}),end:async()=>{}};
 const store={ownsTenant:owner.ownsTenant,own:async()=>{calls.owners++;},close:async()=>{},ready:async id=>{calls.ready.push(id);}};
 const startup=require('../lib/server/serve/tenant-startup');
 const module=isolated('server/serve/evaluator-consumers.js',{
  '../../storage/postgres-connection':async options=>{calls.opens++;if(options.admitBackend)await options.admitBackend(connection);return connection;},
  '../../tenant-notifications/postgres':()=>store,
  '../../tenant-notifications/readiness':async()=>{calls.catalogue++;},
  '../../tenant-alarms/postgres':{createReader:()=>({read:async({tenant})=>{calls.reads.push(tenant);},allows:async()=>true})},
  '../../tenant-notifications/producer':()=>({close(){}}),
  '../../tenant-notifications/component':()=>({close:async()=>{}}),
  '../realtime/alarm-transport':{createSliceAdapter:()=>({send(){throw Error('NO_ADAPTER_EFFECT');}})},
  './evaluator-consumer-readiness':{sameDatastore:async()=>{},suppression:async()=>{calls.suppression++;}},
  './tenant-startup':{...startup,attempt:async(_,id,fn)=>inactive.includes(id)?false:fn()}
 },mutate);
 const config={consumer:'evaluator-synthetic',tenants:new Map(roster.map(id=>[id,{}])),readCurrent:async()=>{},consumers:{realtime:{
  partitionMetadata:{checkpointNamespace:binding.checkpointNamespace,membershipNamespace:binding.membershipNamespace,lifecycleNamespace:binding.lifecycleNamespace},
  expectedCatalogue:require('../lib/tenant-notifications/partition-candidate').build(binding).catalogue,
  outbox:{namespace:'test_outbox',maxRows:10,maxBytes:10000,maxConnections:2},
  suppression:{namespace:'test_alarm',maxRows:10,maxBytes:10000,maxConnections:2},route:{id:'synthetic'},
  maxPayloadBytes:1000,maxInflight:1,attemptTimeoutMs:100,retryDelayMs:100,pollIntervalMs:100,retryIntervalMs:100}}};
 const args={config,partition:partition(ordinal),onUnavailable(){},current:()=>{},isCurrent:async()=>true};
 return {calls,config,args,prepare:()=>module.prepare(args)};
}
async function startupCheck(ordinal,options){
 const lab=preparation(ordinal,options),result=await lab.prepare();
 try {
  const expected=ids.filter(id=>assignment.owner(id)===ordinal);
  assert.deepEqual(lab.calls.ready,expected,'ONLY_LOCAL_SLICE_STARTUP');
  assert.deepEqual(lab.calls.reads,expected);
  assert.equal(lab.config.tenants.size,ids.length,'COMPLETE_CONFIG_RETAINED');
  const foreign=ids.find(id=>assignment.owner(id)!==ordinal),before=lab.calls.ready.length;
  assert.equal(await result.prepareTenant(foreign),false);assert.equal(lab.calls.ready.length,before);
  await assert.rejects(result.prepareTenant('ffffffff-ffff-4fff-8fff-ffffffffffff'),/ASSIGNMENT_TENANT/);
 } finally {await result.close();}
}
describe('notification partition source adoption boundaries',function(){
 let mode;beforeEach(()=>{mode=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(mode));
 for(const ordinal of [0,1])it('prepares only ordinal '+ordinal+' from the complete two-slice config and skips known foreign dynamic tenants',()=>startupCheck(ordinal));
 // Decisions catalogue-verification-admin-owned and platform-application-boundary:
 // the admin pre-start step screens the outbox and suppression stores, not serving.
 it('keeps catalogue and suppression screens off the serving path when every local tenant is inactive',async function(){
  const lab=preparation(0,{inactive:ids.filter(id=>assignment.owner(id)===0)}),result=await lab.prepare();
  try{assert.equal(lab.calls.ready.length,0);assert.equal(lab.calls.reads.length,0);assert.equal(lab.calls.catalogue,0);assert.equal(lab.calls.suppression,0);assert.equal(lab.calls.owners,1);assert.equal(lab.config.tenants.size,ids.length);}finally{await result.close();}
 });
 it('refuses missing assignments and invalid owner ordinals rather than silently selecting a slice',async function(){
  const lab=preparation(0,{roster:[...ids,'ffffffff-ffff-4fff-8fff-ffffffffffff']});
  await assert.rejects(lab.prepare(),/ASSIGNMENT_TENANT/);
  for(const ordinal of [undefined,null,-1,2]){
   const bad={...partition(0),assignment:{...assignment,owner:()=>ordinal}};
   assert.throws(()=>owners.configure(bad,'test_outbox').ownsTenant(ids[0]),/ASSIGNMENT_REFUSED/);
  }
 });
 it('refuses a route mismatch before opening any resource and keeps default-off behavior',async function(){
  const lab=preparation(0);lab.args.partition={...lab.args.partition,consumer:'other'};
  await assert.rejects(lab.prepare(),/ROUTE_MISMATCH/);assert.equal(lab.calls.opens,0);
  const off=isolated('server/serve/evaluator-consumers.js',{'../../storage/postgres-connection':()=>{throw Error('NO_RESOURCE');}});
  assert.equal(await off.prepare({config:{}}),null);
 });
 it('requires both static metadata and matching runtime capability before any resource opens',async function(){
  for(const change of [lab=>{delete lab.args.partition;},lab=>{delete lab.config.consumers.realtime.partitionMetadata;},lab=>{delete lab.config.consumers.realtime.expectedCatalogue;},lab=>{lab.config.consumer='evaluator-other';},...['checkpointNamespace','membershipNamespace','lifecycleNamespace','evaluatorConsumer'].map(key=>lab=>{lab.args.partition={...lab.args.partition,[key]:'conflicting_binding'};})]){
   const lab=preparation(0);change(lab);await assert.rejects(lab.prepare(),/PARTITION_(RUNTIME_REQUIRED|METADATA_REQUIRED|METADATA_MISMATCH)/);assert.equal(lab.calls.opens,0);
  }
 });
 it('startup ablation breaks the actual local-slice criterion and restored source passes',async function(){
  const needle='      if (store.ownsTenant && !store.ownsTenant(tenant)) return false;';
  await assert.rejects(startupCheck(0,{mutate:raw=>{assert(raw.includes(needle));return raw.replace(needle,'');}}),/ONLY_LOCAL_SLICE_STARTUP/);
  await startupCheck(0);
 });
 it('route-guard ablation permits resource acquisition and restored guard prevents it',async function(){
  const needle="  if (partition !== undefined && partition?.consumer !== selected.route.id) throw new Error('NOTIFICATION_PARTITION_ROUTE_MISMATCH');";
  const bindingCheck='Object.entries(binding).some(([key, value]) => partition[key] !== value)';
  const broken=preparation(0,{mutate:raw=>{assert(raw.includes(needle));assert(raw.includes(bindingCheck));return raw.replace(needle,'').replace(bindingCheck,"Object.entries(binding).filter(([key]) => key !== 'consumer').some(([key, value]) => partition[key] !== value)");}});broken.args.partition={...broken.args.partition,consumer:'other'};
  const result=await broken.prepare();try{assert.equal(broken.calls.opens,2);}finally{await result.close();}
  const restored=preparation(0);restored.args.partition={...restored.args.partition,consumer:'other'};
  await assert.rejects(restored.prepare(),/ROUTE_MISMATCH/);assert.equal(restored.calls.opens,0);
 });
});
describe('selected store exact consumer boundary',function(){
 let mode;beforeEach(()=>{mode=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(mode));
 function storeFixture(){
  const queries=[],connection={transaction:async fn=>fn(),async query(sql){queries.push(sql);return {rows:[{tenant_id:ids[0],consumer:'foreign',request_id:ids[1]}]};}};
  const make=isolated('tenant-notifications/postgres.js',{'./partition-owner':{configure:()=>({binding,transaction:async(_,id,fn)=>fn()})}});
  const store=make({connection,namespace:'test_outbox',maxRows:10,maxBytes:10000,partition:{},assertOperational:async()=>{}});
  return {store,queries};
 }
 it('refuses foreign explicit consumers before SQL across enqueue/consume/due/receipts',async function(){
  const {store,queries}=storeFixture();await scope.withTenant(ids[0],async()=>{
   assert.throws(()=>store.enqueue({tenant:ids[0],consumer:'foreign'}),/CONSUMER_MISMATCH/);
   for(const [method,input] of [['consume',{transform:async()=>{throw Error('NO_TRANSFORM');}}],['due',{}],['receipts',{}]])await assert.rejects(store[method]({tenant:ids[0],consumer:'foreign',...input}),/CONSUMER_MISMATCH/);
  });assert.equal(queries.length,0);
 });
 it('refuses a foreign request ID before producer/head locks or DML across begin/dispatch/finish',async function(){
  const {store,queries}=storeFixture();await scope.withTenant(ids[0],async()=>{
   for(const method of ['begin','dispatch','finish'])await assert.rejects(store[method]({tenant:ids[0],id:ids[1],normalPolicy:'realtime-cycle',at:1,until:2,state:'cancelled',nextAt:2,receipt:null,cleared:[]}),/CONSUMER_MISMATCH/);
  });assert.equal(queries.length,3);assert(queries.every(sql=>sql.startsWith('SELECT *')&&!sql.includes('FOR UPDATE')));
 });
});
