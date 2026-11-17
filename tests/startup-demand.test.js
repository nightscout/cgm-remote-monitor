'use strict';
// Actual startup scheduler with synthetic initialization and lifecycle protocol.
// No native database, transport or capacity result is implied.
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), {createRequire} = require('node:module');
const startup = require('../lib/server/serve/tenant-startup');
const scope = require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function mutant(needle,replacement) {
 const file=require.resolve('../lib/server/serve/tenant-startup'),source=fs.readFileSync(file,'utf8'),out={exports:{}};
 assert.equal(source.split(needle).length,2,'MUTATION_MUST_APPLY_ONCE');
 vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,replacement)+'\n})',{filename:file})(createRequire(file),out,out.exports);
 return out.exports;
}
describe('selected demand-only tenant initialization',function(){
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(prior));
 async function noRoster(api=startup){
  const calls=[],tenants=Array.from({length:10000},(_,i)=>String(i));
  const value=api.create(tenants,undefined,async tenant=>calls.push(tenant),{readiness:'serve',warmOnStart:false,coldAlertMs:null,drainedLog(){}});
  try{
   await value.warm();await turn();assert.equal(calls.length,0,'IDLE_ROSTER_MUST_NOT_INITIALIZE');
   assert.equal(value.health().ready,true);assert.equal(value.health().cold,10000);
   await assert.rejects(value.admit('42'),{code:'TENANT_WARMING'});await value.drained();await value.admit('42');
   assert.deepEqual(calls,['42']);
   value.invalidateTenant('42');await turn();assert.deepEqual(calls,['42'],'INVALIDATION_MUST_WAIT_FOR_DEMAND');
   await assert.rejects(value.admit('42'),{code:'TENANT_WARMING'});await value.drained();assert.deepEqual(calls,['42','42']);
  }finally{await value.close();}
 }
 it('does no roster initialization at ten thousand, then initializes only addressed tenants including restore',()=>noRoster());
 it('control: proactive roster warm fails the idle-work oracle and restoration passes',async()=>{
  const broken=mutant("if (warmOnStart) for (const tenant of cells.keys()) enqueue(tenant);","for (const tenant of cells.keys()) enqueue(tenant);");
  await assert.rejects(noRoster(broken),/IDLE_ROSTER_MUST_NOT_INITIALIZE/);await noRoster();
 });
 it('retains strict all-tenant readiness even with demand-only selected',async()=>{
  const calls=[],value=startup.create([A,B],undefined,async tenant=>{calls.push(tenant);if(tenant===A)throw Object.assign(Error('refused'),{code:'SCHEMA_INVALID'});},{readiness:'all',warmOnStart:false,coldAlertMs:null});
  try{await assert.rejects(value.warm(),{code:'SCHEMA_INVALID'});assert.deepEqual(calls,[A,B]);assert.equal(value.health().ready,false);}finally{await value.close();}
 });
 it('held and refused tenants do not stop a healthy neighbor, and permanent refusal keeps its backoff',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;}),calls=[];
  const value=startup.create([A,B],undefined,async tenant=>{calls.push(tenant);if(tenant===A){await held;throw Object.assign(Error('schema refusal'),{code:'SCHEMA_INVALID'});}},
   {readiness:'serve',warmOnStart:false,concurrency:2,failureRetryMs:1000,coldAlertMs:null,alert(){},drainedLog(){}});
  try{
   await value.warm();await assert.rejects(value.admit(A),{code:'TENANT_WARMING'});await assert.rejects(value.admit(B),{code:'TENANT_WARMING'});await turn();await value.admit(B);
   release();await value.drained();await assert.rejects(value.admit(A),{code:'TENANT_UNAVAILABLE'});assert.deepEqual(calls,[A,B]);await value.admit(B);assert.equal(value.health().failed,1);
  }finally{release();await value.close();}
 });
 it('alerts on requested stalled work and leaves untouched idle tenants quiet',async()=>{
  let release,clock=0;const held=new Promise(resolve=>{release=resolve;}),alerts=[];
  const value=startup.create([A,B],undefined,async()=>held,{readiness:'serve',warmOnStart:false,coldAlertMs:1000,now:()=>clock,alert:(code,tenant)=>alerts.push([code,tenant]),drainedLog(){}});
  try{await value.warm();clock=1001;await new Promise(resolve=>setTimeout(resolve,275));assert.deepEqual(alerts,[]);
   await assert.rejects(value.admit(A),{code:'TENANT_WARMING'});await turn();await new Promise(resolve=>setTimeout(resolve,275));assert.deepEqual(alerts,[['TENANT_COLD_BEYOND_BOUND',A]]);
  }finally{release();await value.drained();await value.close();}
 });
});
