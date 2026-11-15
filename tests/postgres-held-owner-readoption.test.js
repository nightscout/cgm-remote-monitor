'use strict';
// Actual selected operation window, owner capability and pg.Pool with a
// synthetic SQL driver. No database/service or product timeout is changed.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
async function fixture (oldCheckout = false, trustedWorker = true) {
  let factory = require('../lib/storage/postgres-connection');
  if (oldCheckout) {
    const file = require.resolve('../lib/storage/postgres-connection'), loaded = new Module(file,module);
    loaded.filename=file; loaded.paths=Module._nodeModulePaths(path.dirname(file));
    const source=fs.readFileSync(file,'utf8'), start=source.indexOf('    const owners = [...heldOwners.values()];');
    const end=source.indexOf('    const client = await pool.connect(); let failure;',start);
    assert(start>0&&end>start); loaded._compile(source.slice(0,start)+source.slice(end),file); factory=loaded.exports;
  }
  const protocol = require('./fixtures/operation-window-runtime-protocol')({trustedWorker});
  const clients=[],calls=[];let losses=0,lock=true,action=async()=>{};
  class Client extends EventEmitter {
    constructor () {super();this.processID=1001+clients.length;this._queryable=true;this._ending=false;clients.push(this);}
    connect (done) {queueMicrotask(()=>done(null));}
    query (input,values,done) {
      if(typeof values==='function'){done=values;values=undefined;}
      const text=typeof input==='string'?input:input.text; if(typeof input==='object')values=input.values;
      const work=(async()=>{
        calls.push({text,pid:this.processID});const override=await action(this,text,values);if(override)return override;
        if(text.includes('pg_try_advisory_lock(')||text.includes("locktype='advisory'"))return {rows:[{held:lock}]};
        const result=await protocol.client.query(text,values);
        return {...result,rows:result.rows.map(row=>row.pid===undefined?row:{...row,pid:this.processID})};
      })();if(done){work.then(value=>done(null,value),done);return;}return work;
    }
    end (done) {this._ending=true;this.emit('end');if(done)queueMicrotask(done);}
  }
  await protocol.window.ready();const release=factory.installOperationWindow(protocol.window);
  const connection=await factory({connectionString:'synthetic-held-owner',Client,max:1,idleTimeoutMillis:0,connectionTimeoutMillis:50});
  const owner=await require('../lib/realtime-placement/owner').acquire({connection,worker:'test-owner',consumer:'realtime-held-owner',onLoss:()=>{losses++;}});
  return {factory,window:protocol.window,connection,owner,clients,calls,get losses(){return losses;},
    setLock:value=>{lock=value;},setAction:fn=>{action=fn;},
    verify:()=>protocol.window.verifyOperational(()=>factory.readopt(protocol.window)),
    async close(){await owner.close();await connection.end();release();await protocol.window.close();}};
}
describe('selected held-owner backend re-observation',function(){
  let previous;
  beforeEach(()=>{previous=scope.getTenancyMode();scope.setTenancyMode('multi');});
  afterEach(()=>scope.setTenancyMode(previous));
  it('re-verifies the exact held backend without checking out a second max1 client or changing census',async()=>{
    const f=await fixture();
    try{
      const before=f.factory.cohortBackends(f.window);await f.verify();
      assert.deepEqual(f.factory.cohortBackends(f.window),before);assert.equal(f.clients.length,1);
      assert(f.owner.available);assert.equal(f.losses,0);await f.window.run(A,async()=>{});
      assert(f.calls.some(c=>c.text.includes("locktype='advisory'")));
      assert(f.calls.filter(c=>c.text.startsWith('SELECT pg_backend_pid()')).length>=2,'fresh held backend identity query');
    }finally{await f.close();}
  });
  it('retains bounded live admission on a public/mixed owner window',async()=>{
    const f=await fixture(false,false);
    try{
      await f.verify();
      await f.owner.withTenant(A,async()=>{await f.connection.query('SELECT ordinary_tenant_work');});
      assert(f.calls.some(c=>c.text.includes('operation-window-current lower')));
      assert(!f.calls.some(c=>c.text.includes('operation-window-current trusted-lower')));
      assert.equal(f.window.trustedWorker,false);assert.equal(f.clients.length,1);
    }finally{await f.close();}
  });
  it('serializes re-observation and external lock checks after the owner transaction commits',async()=>{
    const f=await fixture();let finish,reached;
    const gate=new Promise(resolve=>{finish=resolve;}),entered=new Promise(resolve=>{reached=resolve;});
    let active=false;
    f.setAction(async(client,text)=>{if(text.startsWith('SELECT pg_backend_pid()'))assert(!active,'REOBSERVE_OUTSIDE_OWNER_TRANSACTION');});
    const owned=f.owner.withTenant(A,async()=>{active=true;reached();await gate;active=false;});
    try{
      await entered;let verified=false;const pending=f.verify().then(()=>{verified=true;});
      const checking=f.owner.check();await new Promise(resolve=>setImmediate(resolve));assert.equal(verified,false);
      finish();await owned;await pending;await checking;assert(f.owner.available);assert.equal(f.clients.length,1);
    }finally{finish();await owned.catch(()=>{});await f.close();}
  });
  it('refuses readoption inside its owner transaction instead of waiting on itself',async()=>{
    const f=await fixture();
    try{await f.owner.withTenant(A,async()=>{
      await assert.rejects(f.factory.readopt(f.window),/idle transaction scope/);
      await f.owner.check();
    });assert(f.owner.available);}finally{await f.close();}
  });
  it('latches lock, PID, birth, role, datastore, verification and transport loss before readoption can succeed',async()=>{
    for(const phase of ['lock','pid','birth','role','datastore','verification','transport']){
      const f=await fixture();
      try{
        if(phase==='lock')f.setLock(false);
        if(phase==='pid')f.clients[0].processID++;
        f.setAction(async(client,text)=>{
          if(phase==='verification'&&text.includes('FROM pg_roles'))throw Error('synthetic verification refused');
          if(text.startsWith('SELECT pg_backend_pid()')){
            if(phase==='transport')client.emit('error',Error('synthetic held transport loss'));
            if(['birth','role','datastore'].includes(phase))return {rows:[{pid:client.processID,role:phase==='role'?'changed':'synthetic_worker',
              birth:phase==='birth'?'changed':'1700000000.000001',database:'disposable_test',database_oid:phase==='datastore'?'999':'16384',
              server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.000000'}]};
          }
        });
        await assert.rejects(f.verify());assert.equal(f.owner.available,false,phase);assert.equal(f.losses,1,phase);
        await assert.rejects(f.window.run(A,async()=>{}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      }finally{await f.close();}
    }
  });
  it('close drains a queued verification and releases the exact held resource without reopening admission',async()=>{
    const f=await fixture();let finish,reached;
    const gate=new Promise(resolve=>{finish=resolve;}),entered=new Promise(resolve=>{reached=resolve;});
    const owned=f.owner.withTenant(A,async()=>{reached();await gate;});
    try{
      await entered;const pending=f.verify();pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
      const closing=f.owner.close();finish();await owned;await assert.rejects(pending);await closing;
      assert.equal(f.owner.available,false);assert.equal(f.clients.length,1);
      await assert.rejects(f.window.run(A,async()=>{}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    }finally{finish();await owned.catch(()=>{});await f.close();}
  });
  it('control: restoring the extra pool checkout reproduces exhaustion and fails the readoption criterion',async()=>{
    const f=await fixture(true);
    try{
      await assert.rejects(f.verify(),/timeout exceeded when trying to connect/);
      assert(f.owner.available);assert.equal(f.losses,0);assert.equal(f.clients.length,1);
      await assert.rejects(f.window.run(A,async()=>{}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
    }finally{await f.close();}
  });
});
