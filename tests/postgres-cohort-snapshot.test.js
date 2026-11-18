'use strict';
// Actual pg.Pool constructor/checkout with a synthetic driver and an actual
// source operation window. Native backend visibility is a separate instrument.
// covers: lib/storage/postgres-connection.js, lib/server/serve/operation-cohort.js
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const connect=require('../lib/storage/postgres-connection');
const windowFixture=require('./fixtures/operation-window-runtime-protocol');
const DATA={database:'disposable_test',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.000000'};
async function fixture({failBaseline=false}={}){
 const options={available:()=>available};let available=true;
 const f=windowFixture(options);
 await f.window.ready();const release=connect.installOperationWindow(f.window);let serial=0,action=async()=>{if(failBaseline)throw Error('synthetic constructor failure');};
 const stores=[];
 class Client extends EventEmitter{
  constructor(){super();this.processID=1000+(++serial);this._queryable=true;this._ending=false;}
  connect(done){queueMicrotask(()=>done(null));}
  query(input,values,done){if(typeof values==='function'){done=values;values=undefined;}const text=typeof input==='string'?input:input.text;if(typeof input==='object')values=input.values;const result=(async()=>{
   const extra=await action(this,text);
   // Constructor admission now queries the actual structural protocol. Identity
   // rows alone cannot stand in for catalogue, grant, policy and ledger rows.
   const result=await f.client.query(text,values);
   return {...result,rows:result.rows.map(row=>row.pid===undefined?row:{...row,pid:this.processID,...extra})};
  })();if(done){result.then(value=>done(null,value),done);return;}return result;}
  end(done){this._ending=true;this.emit('end');if(done)queueMicrotask(done);}
 }
 async function open(){const store=await connect({connectionString:'synthetic-snapshot',Client,max:1,idleTimeoutMillis:0});stores.push(store);return store;}
 const close=async()=>{try{for(const store of stores.reverse())await store.end();}finally{release();await f.window.close();}};
 let baseline;
 try{baseline=await open();}catch(error){await close();throw error;}
 return {window:f.window,open,baseline,setAction:fn=>{action=fn;},endControl:()=>{available=false;},close};
}
describe('Generation scope on a lower connection',function(){
 it('commits a healthy explicit read directly and rolls it back when role availability is withdrawn',async function(){
  const f=await fixture(), tenant='11111111-1111-4111-8111-111111111111';
  const scope=require('../lib/storage/tenant-scope');
  const previousMode=scope.getTenancyMode();scope.setTenancyMode('multi');
  try{
   await f.window.run(tenant,()=>{});
   const statements=[];
   f.setAction(async(client,sql)=>{statements.push(sql);});
   const read=lose=>scope.withTenant(tenant,()=>f.baseline.readOnlyTransaction(async()=>{
    await f.baseline.query('SELECT 1 AS sample');
    if(lose)f.endControl();
   }));
   await read(false);
   assert.deepEqual(statements.slice(statements.lastIndexOf('SELECT 1 AS sample')+1),['COMMIT']);
   statements.length=0;
   await assert.rejects(read(true),{code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});
   assert.deepEqual(statements.slice(statements.lastIndexOf('SELECT 1 AS sample')+1),['ROLLBACK']);
  }finally{try{await f.close();}finally{scope.setTenancyMode(previousMode);}}
 });
 it('releases the selected scope after a failed constructor',async function(){
  await assert.rejects(fixture({failBaseline:true}),/synthetic constructor failure/);
  const f=await fixture();try{assert.deepEqual(f.window.datastore,DATA);}finally{await f.close();}
 });
 it('refuses a mismatched datastore during cold backend admission',async function(){
  const f=await fixture();
  try{f.setAction(async client=>client.processID===1002?{database_oid:'99999'}:{});await assert.rejects(f.open(),{code:'POSTGRES_GENERATION_DATASTORE_MISMATCH'});}
  finally{await f.close();}
 });
});
