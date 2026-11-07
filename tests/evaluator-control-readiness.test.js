'use strict';
// Source SQL/ACL protocol, not an actual PostgreSQL evaluator-startup diagnosis.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ready=require('../lib/server/serve/evaluator-consumer-readiness');
const scope=require('../lib/storage/tenant-scope');
const windowFixture=require('./fixtures/operation-window-runtime-protocol');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const controls=['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'].map(table=>'synthetic_window.'+table);
function lab(){
  const f=windowFixture(),flags={},observed=[];
  const migration=require('../migrations/candidates/postgres-alarm-suppression-v1.json').migrations[0];
  const table={kind:'r',persistence:'p',secured:true,columns:[['tenant_id','uuid',true],['alarm_group','text',true],['alarm_level','integer',true],['acked_at','bigint',true],['expires_at','bigint',true]],primary_key:['tenant_id','alarm_group','alarm_level'],
    policies:[{command:'*',roles:[0],permissive:true,using:"tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid",check:"tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid"}]};
  const db={async query(sql,values){
    if(sql.includes('operation-window-')){
      const result=await f.client.query(sql,values);
      if(sql.includes('operation-window-table') && flags.privateRead && values[0].endsWith(flags.privateRead))result.rows[0].reads=true;
      return result;
    }
    if(sql.includes('suppression-role')){
      // Supplied effective-ACL shape: legitimate own reads plus exactly three
      // installed control SELECTs; foreign writes stay forbidden independently.
      const allowed=values[3]||[];
      const reads=[...controls,...(flags.foreignRead?['clinical.entries']:[])];
      const unrelated=!!flags.mutation || reads.some(name=>!allowed.includes(name));
      observed.push({allowed,unrelated});return {rows:[{uses_schema:true,unrelated,creates:false,operator:false}]};
    }
    if(sql.includes('suppression-shape'))return {rows:[table]};
    if(sql.includes('suppression-ledger'))return {rows:[{name:migration.name,checksum:migration.checksum}]};
    if(sql.includes('datastore-challenge'))return {rows:[{acquired:false}]};
    return {rows:[]};
  },transaction:fn=>fn(),snapshotTransaction:fn=>fn(),async end(){}};
  return {f,flags,observed,db};
}
function loadPrepare(overrides,mutate=s=>s){
  const file=path.resolve(__dirname,'../lib/server/serve/evaluator-consumers.js'),output={exports:{}},original=require('node:module').createRequire(file);
  vm.runInThisContext('(function(require,module,exports){'+mutate(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>Object.hasOwn(overrides,name)?overrides[name]:original(name),output,output.exports);return output.exports.prepare;
}
describe('Selected suppression control read scope source protocol',function(){
  let mode;beforeEach(()=>{mode=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(mode));
  it('reproduces the supplied three-control-SELECT ACL refusal without selection, then admits only the actual window',async function(){
    const l=lab();try{
      await assert.rejects(ready.suppression(l.db,'alarm_test'),/READINESS_REFUSED/);assert.equal(l.observed.at(-1).unrelated,true);
      await assert.rejects(ready.suppression(l.db,'alarm_test',{operationWindow:{namespace:'synthetic_window'}}),/actual operation window/);
      await ready.suppression(l.db,'alarm_test',{operationWindow:l.f.window});assert.deepEqual(l.observed.at(-1),{allowed:controls,unrelated:false});
    }finally{await l.f.window.close();}
  });
  it('keeps unrelated reads, private authority/audit SELECT and mutations refused; fresh restored scope passes',async function(){
    const l=lab();try{
      for(const flag of ['foreignRead','mutation']){l.flags[flag]=true;await assert.rejects(ready.suppression(l.db,'alarm_test',{operationWindow:l.f.window}),/READINESS_REFUSED/);l.flags[flag]=false;await ready.suppression(l.db,'alarm_test',{operationWindow:l.f.window});}
      for(const table of ['tenant_lifecycle_restore_authority','tenant_lifecycle_restore_audit']){l.flags.privateRead=table;await assert.rejects(ready.suppression(l.db,'alarm_test',{operationWindow:l.f.window}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});delete l.flags.privateRead;await ready.suppression(l.db,'alarm_test',{operationWindow:l.f.window});}
    }finally{await l.f.window.close();}
  });
  async function prepareCheck(mutate){
    const l=lab();let reader,effects=0;
    const prepare=loadPrepare({'../../storage/postgres-connection':async()=>({...l.db}),'../../tenant-notifications/postgres':()=>({ready:async()=>{}}),
      '../../tenant-alarms/postgres':{createReader:({connection})=>(reader={read:({tenant})=>scope.withTenant(tenant,()=>connection.snapshotTransaction(async()=>{effects++;return {};}))})},
      '../../tenant-notifications/producer':()=>({close(){}}),'../../tenant-notifications/component':()=>({close:async()=>{}}),'../realtime/alarm-transport':{createAdapter:()=>({send(){}})}},mutate);
    const config={tenants:new Map([[A,true],[B,true]]),readCurrent:async()=>({}),consumers:{realtime:{outbox:{connectionString:'synthetic',namespace:'outbox',maxRows:10,maxBytes:10000},suppression:{connectionString:'synthetic',namespace:'alarm_test',maxRows:10,maxBytes:10000},route:{id:'synthetic',socketPath:'/synthetic/unused',maxBytes:10000,timeoutMs:1000},maxPayloadBytes:1000,maxInflight:1,attemptTimeoutMs:1000,retryDelayMs:100,pollIntervalMs:100,retryIntervalMs:100}}};
    let composed;try{
      composed=await prepare({config,clinicalConnection:{transaction:fn=>fn(),query:async()=>({rows:[]})},operationWindow:l.f.window,current:()=>null,isCurrent:async()=>false});
      assert.equal(effects,2);await reader.read({tenant:A});assert.equal(effects,3);
      l.flags.foreignRead=true;await assert.rejects(reader.read({tenant:A}),/READINESS_REFUSED/);assert.equal(effects,3);
      l.flags.foreignRead=false;await reader.read({tenant:B});assert.equal(effects,4);
    }finally{await composed?.close();await l.f.window.close();}
  }
  it('threads actual selection into prepare and every later screened reader snapshot',()=>prepareCheck());
  it('detects omission at the actual prepare call site and passes fresh restored source',async function(){
    await assert.rejects(prepareCheck(s=>s.replace('selected.suppression.namespace, {operationWindow}','selected.suppression.namespace')),/READINESS_REFUSED/);await prepareCheck();
  });
});
