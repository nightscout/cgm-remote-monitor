'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111';
function load(relative,mocks,mutate=s=>s){const file=path.resolve(__dirname,'../lib',relative),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const normal=m.require.bind(m);m.require=name=>Object.hasOwn(mocks,name)?mocks[name]:normal(name);m._compile(mutate(fs.readFileSync(file,'utf8')),file);return m.exports;}
function fixture(mutate,{platformVerified=false}={}){
 const calls={open:0,read:0,check:0,close:0,openOptions:[]};let version=1,fail=false,hold,change=false;
 const binding={connectionString:'postgres://synthetic:synthetic@localhost/synthetic_test',namespaces:{settings:'display_settings',operatorPolicy:'operator_policy'}};
 const open=async(config,options)=>{calls.open++;calls.openOptions.push(options);assert.deepEqual(config,binding);return{async read(){calls.read++;if(hold)await hold;if(fail)throw Error('synthetic connection failure');const v=version;if(change)version++;return{version:v,effective:{SHOW_SECONDS:{value:v%2===1}}};},async check(){calls.check++;},async close(){calls.close++;}};};
 const reader=load('tenant-settings/presentation-reader.js',{'./effective-postgres':open})(binding,{platformVerified});
 const selectedState={namespace:'outbox',consumer:'realtime',maxRows:10,maxBytes:10000,maxPayloadBytes:1000,
   async readCurrent(tenant,registryAdmission,settingsReader){assert.equal(tenant,A);assert.equal(settingsReader,reader,'ACK must borrow the API-owned reader');assert(settingsReader.matches(binding));const state=await settingsReader.read(tenant);return{identity:String(state.version)};}};
 const config={registry:{namespace:'registry'},bindings:new Map([[A,{}]]),socketForwarding:{consumerState:selectedState,alarm:{namespace:'alarms'}}};
 const api=load('server/realtime/private-api.js',{'../../tenant-alarms/composition':{createReceiver:options=>()=>options.admitAckInTransaction({operation:{tenant:A}})},'../../tenant-notifications/ack-admission':()=>async()=>({accepted:true,at:1})},mutate);
 const token=Symbol(),ops=api.operations({token,config,admission:{registry:true,resolveHost:async()=>A,allows:async()=>true},authority:{},alarmConnection:{},displaySettings:reader});
 return{reader,calls,ack:()=>scope.withTenant(A,()=>ops.executeSocketMutation({transport:token},{host:'synthetic.test',envelope:{}})),setVersion:v=>version=v,setFail:v=>fail=v,setHold:p=>hold=p,setChange:v=>change=v};
}
describe('API display and notification ACK settings reader ownership',function(){
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(prior));
 it('shares one lazy capability, reads fresh settings for every ACK, keeps it across a failed read and closes once',async()=>{
  const f=fixture();assert.equal(f.reader.health().ready,false);await f.reader.check();
  assert.equal((await f.ack()).accepted,true);f.setVersion(2);await f.ack();
  assert.equal(f.calls.open,1);assert.equal(f.calls.read,4);assert.equal(f.calls.check,0);
  f.setChange(true);await assert.rejects(f.ack(),{code:'SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED'});f.setChange(false);
  // A failed read refuses that read only; the shared capability stays open.
  f.setFail(true);await assert.rejects(f.ack(),{code:'SETTINGS_POLICY_UNAVAILABLE'});assert.equal(f.reader.health().ready,true);assert.equal(f.calls.close,0);
  f.setFail(false);await f.ack();assert.equal(f.calls.open,1);assert.equal(f.reader.health().ready,true);
  await f.reader.close();await f.reader.close();assert.equal(f.calls.close,1);await assert.rejects(f.ack(),{code:'SETTINGS_POLICY_UNAVAILABLE'});
 });
 it('drains an in-flight ACK read before exact idempotent cleanup',async()=>{
  const f=fixture();await f.reader.check();let release;f.setHold(new Promise(r=>release=r));const ack=f.ack();await new Promise(setImmediate);
  let ended=false;const closing=f.reader.close().then(()=>ended=true);await new Promise(setImmediate);assert.equal(ended,false);assert.equal(f.calls.close,0);
  release();await assert.rejects(ack,{code:'SETTINGS_POLICY_UNAVAILABLE'});await closing;assert.equal(f.calls.close,1);
 });
 it('keeps the API proof trust, and refuses a failed ACK settings read without reopening',async()=>{
  const f=fixture(undefined,{platformVerified:true});
  try{
   await f.ack();f.setFail(true);await assert.rejects(f.ack(),{code:'SETTINGS_POLICY_UNAVAILABLE'});
   assert.equal(f.reader.health().ready,true);assert.equal(f.calls.close,0);
   f.setFail(false);f.setVersion(2);await f.ack();
   assert.equal(f.calls.open,1);assert.equal(f.calls.openOptions.length,1);
   assert(f.calls.openOptions.every(options=>options.platformVerified===true),'every open uses the internal proof option');
   assert.equal(f.reader.health().ready,true);
  }finally{await f.reader.close();}
 });
 it('red/restored: omitting the shared reader from metadata access is caught at the actual ACK call',async()=>{
  const needle='metadataAdmission, displaySettings)';const broken=fixture(s=>{assert(s.includes(needle));return s.replaceAll(needle,'metadataAdmission, undefined)');});
  await assert.rejects(broken.ack(),assert.AssertionError);await broken.reader.close();
  const restored=fixture();await restored.ack();await restored.reader.close();
 });
});
