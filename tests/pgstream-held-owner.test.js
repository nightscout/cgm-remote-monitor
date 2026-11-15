'use strict';
// Actual pg.Pool, connection wrapper, operation window and owner capability;
// synthetic pg Client only. No native datastore or restored-process claim.
const {it}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const scope=require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111';
async function fixture(broken=false){
 let factory=require('../lib/storage/postgres-connection');
 if(broken){const file=require.resolve('../lib/storage/postgres-connection'),source=fs.readFileSync(file,'utf8'),needle="if (heldClient && outer.client !== heldClient) throw Object.assign(new Error('PostgreSQL held owner cannot join another backend transaction'), { code: 'POSTGRES_OWNER_TRANSACTION_MISMATCH' });";assert.equal(source.split(needle).length,2);const loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));loaded._compile(source.replace(needle,''),file);factory=loaded.exports;}
 const protocol=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true}),clients=[],calls=[];
 class Client extends EventEmitter{
  constructor(){super();this.processID=1001+clients.length;this._queryable=true;this._ending=false;clients.push(this);}
  connect(done){queueMicrotask(()=>done(null));}
  query(input,values,done){if(typeof values==='function'){done=values;values=undefined;}const text=typeof input==='string'?input:input.text;if(typeof input==='object')values=input.values;
   const work=(async()=>{calls.push({text,pid:this.processID});if(text.includes('pg_try_advisory_lock(')||text.includes("locktype='advisory'"))return {rows:[{held:true}]};const result=await protocol.client.query(text,values);return {...result,rows:result.rows.map(row=>row.pid===undefined?row:{...row,pid:this.processID})};})();
   if(done){work.then(value=>done(null,value),done);return;}return work;
  }
  end(done){this._ending=true;this.emit('end');if(done)queueMicrotask(done);}
 }
 await protocol.window.ready();const release=factory.installOperationWindow(protocol.window);
 const connection=await factory({connectionString:'synthetic-partition-owner',Client,max:2,idleTimeoutMillis:0,connectionTimeoutMillis:50});
 const owner=await connection.holdAdvisoryLock('567',()=>{});
 return {connection,owner,clients,calls,async close(){await owner.close();await connection.end();release();await protocol.window.close();}};
}
it('actual owner capability binds PID, refuses foreign outer backend before effects, preserves ordinary nested work and revokes PID after close',async()=>{
 const previous=scope.getTenancyMode();scope.setTenancyMode('multi');const f=await fixture();
 try{
  assert.equal(f.owner.backendPid,f.clients[0].processID);
  let effects=0;
  await f.connection.withTenant(A,async()=>{
   await f.connection.withTenant(A,()=>f.connection.query('SELECT ordinary_nested'));
   await assert.rejects(f.owner.withTenant(A,async()=>{effects++;await f.connection.query('SELECT forbidden_effect');}),{code:'POSTGRES_OWNER_TRANSACTION_MISMATCH'});
  });
  assert.equal(effects,0);assert(!f.calls.some(row=>row.text==='SELECT forbidden_effect'));
  await f.owner.withTenant(A,()=>f.connection.withTenant(A,()=>f.connection.query('SELECT actual_owner_effect')));
  assert.equal(f.calls.find(row=>row.text==='SELECT actual_owner_effect').pid,f.owner.backendPid);
  assert.equal(f.clients.length,2);await f.owner.close();assert.throws(()=>f.owner.backendPid,{code:'POSTGRES_OPERATIONAL_OWNER_LOST'});
 }finally{await f.close();scope.setTenancyMode(previous);}
});
it('control: remove only the held-client mismatch refusal; actual owner/outer-backend criterion turns red then restores',async()=>{
 const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
 async function qualify(broken){const f=await fixture(broken);try{await f.connection.withTenant(A,()=>assert.rejects(f.owner.withTenant(A,()=>f.connection.query('SELECT foreign_effect')),{code:'POSTGRES_OWNER_TRANSACTION_MISMATCH'}));}finally{await f.close();}}
 try{await assert.rejects(qualify(true),{code:'ERR_ASSERTION'});await qualify(false);}finally{scope.setTenancyMode(previous);}
});
