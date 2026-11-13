'use strict';
// Actual pg.Pool constructor/checkout with a synthetic driver and an actual
// source operation window. Native backend visibility is a separate instrument.
// covers: lib/storage/postgres-connection.js, lib/server/serve/operation-cohort.js
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const connect=require('../lib/storage/postgres-connection');
const windowFixture=require('./fixtures/operation-window-runtime-protocol');
const DATA={database:'disposable_test',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.000000'};
function latch(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function fixture(){
 const f=windowFixture();await f.window.ready();const release=connect.installOperationWindow(f.window);let serial=0,action=async()=>{};
 const stores=[];
 class Client extends EventEmitter{
  constructor(){super();this.processID=1000+(++serial);this._queryable=true;this._ending=false;}
  connect(done){queueMicrotask(()=>done(null));}
  query(text,values,done){if(typeof values==='function')done=values;const result=(async()=>{
   const extra=await action(this,text);
   return {rows:[{...DATA,pid:this.processID,role:'synthetic_reader',birth:'1700000000.'+this.processID,rolsuper:false,rolbypassrls:false,...extra}]};
  })();if(done){result.then(value=>done(null,value),done);return;}return result;}
  end(done){this._ending=true;this.emit('end');if(done)queueMicrotask(done);}
 }
 async function open(){const store=await connect({connectionString:'synthetic-snapshot',Client,max:1,idleTimeoutMillis:0});stores.push(store);return store;}
 const baseline=await open();
 return {window:f.window,open,baseline,setAction:fn=>{action=fn;},async close(){for(const store of stores.reverse())await store.end();release();await f.window.close();}};
}
describe('Cohort snapshots wait for actual connection admission',function(){
 it('waits for a held constructor and captures its admitted backend instead of omitting a null identity',async function(){
  const f=await fixture(),entered=latch(),gate=latch();let pending;
  try{
   f.setAction(async client=>{if(client.processID===1002){entered.resolve();await gate.promise;}});
   pending=f.open();await entered.promise;
   assert.throws(()=>connect.cohortDatastore(f.window),/datastore unavailable/,'the synchronous census remains strict');
   let resolved=false;const snapshot=connect.cohortSnapshot(f.window).then(value=>{resolved=true;return value;});
   await new Promise(resolve=>setTimeout(resolve,10));assert.equal(resolved,false);
   gate.resolve();await pending;const seen=await snapshot;
   assert.deepEqual(seen.datastore,DATA);assert.deepEqual(seen.backends.map(row=>row.pid).sort(),[1001,1002]);
  }finally{gate.resolve();await pending;await f.close();}
 });
 it('uses one bounded deadline and keeps a held constructor refused on timeout',async function(){
  const f=await fixture(),entered=latch(),gate=latch();let pending;
  try{
   f.setAction(async client=>{if(client.processID===1002){entered.resolve();await gate.promise;}});
   pending=f.open();await entered.promise;
   await assert.rejects(connect.cohortSnapshot(f.window,{timeoutMs:20}),{code:'POSTGRES_COHORT_INITIALIZATION_TIMEOUT'});
   assert.throws(()=>connect.cohortDatastore(f.window),/datastore unavailable/);
  }finally{gate.resolve();await pending;await f.close();}
 });
 it('refuses an observed constructor admission failure instead of returning a partial baseline',async function(){
  const f=await fixture(),entered=latch(),gate=latch();let pending;
  try{
   f.setAction(async client=>{if(client.processID===1002){entered.resolve();await gate.promise;return {rolsuper:true};}});
   pending=f.open();pending.catch(()=>{});await entered.promise;
   const snapshot=connect.cohortSnapshot(f.window);gate.resolve();
   await assert.rejects(snapshot,/NOSUPERUSER NOBYPASSRLS/);await assert.rejects(pending,/NOSUPERUSER NOBYPASSRLS/);
   assert.deepEqual((await connect.cohortSnapshot(f.window)).backends.map(row=>row.pid),[1001],'failed resource is accepted as gone only after its pool actually drains');
  }finally{gate.resolve();await pending?.catch(()=>{});await f.close();}
 });
 it('refuses an admitted but mismatched datastore',async function(){
  const f=await fixture();
  try{f.setAction(async client=>client.processID===1002?{database_oid:'99999'}:{});await f.open();await assert.rejects(connect.cohortSnapshot(f.window),/datastore unavailable/);}
  finally{await f.close();}
 });
 it('takes one cut while a continuous healthy constructor stream proceeds independently',async function(){
  const f=await fixture(),entered=latch(),gate=latch(),opening=[];let first,timer;
  try{
   f.setAction(async client=>{if(client.processID===1002){entered.resolve();await gate.promise;}else if(client.processID>1002)await new Promise(resolve=>setTimeout(resolve,25));});
   first=f.open();await entered.promise;const snapshot=connect.cohortSnapshot(f.window);
   timer=setInterval(()=>{opening.push(f.open());},2);
   await new Promise(resolve=>setTimeout(resolve,10));gate.resolve();await first;
   const seen=await snapshot;
   assert.deepEqual(seen.backends.map(row=>row.pid).sort(),[1001,1002],'every admitted backend at the captured cut is included');
   assert(opening.length>0,'healthy B-like constructors continue beyond the cut');
   assert.throws(()=>connect.cohortDatastore(f.window),/datastore unavailable/,'later pending records stay strict, rather than being treated as admitted');
  }finally{clearInterval(timer);gate.resolve();await first;await Promise.all(opening);await f.close();}
 });
 it('uses a monotonic timer even when the wall clock moves backwards',async function(){
  const f=await fixture(),entered=latch(),gate=latch();let pending;const original=Date.now;
  try{
   f.setAction(async client=>{if(client.processID===1002){entered.resolve();await gate.promise;}});
   pending=f.open();await entered.promise;let counter=0;Date.now=()=>original()-(++counter)*3600000;
   const start=performance.now();
   try{await assert.rejects(connect.cohortSnapshot(f.window,{timeoutMs:20}),{code:'POSTGRES_COHORT_INITIALIZATION_TIMEOUT'});}
   finally{Date.now=original;}
   assert(performance.now()-start<250,'clock step cannot extend the fixed initialization budget');
  }finally{Date.now=original;gate.resolve();await pending;await f.close();}
 });
});
