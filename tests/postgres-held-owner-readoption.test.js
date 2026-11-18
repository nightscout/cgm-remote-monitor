'use strict';
// Actual selected operation window, owner capability and pg.Pool with a
// synthetic SQL driver. No database/service or product timeout is changed.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
async function fixture (trustedWorker = true) {
  const factory = require('../lib/storage/postgres-connection');
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
  const key=require('../lib/realtime-ownership/owner').keys('realtime-held-owner',{count:1,ordinal:0}).owner;
  const owner=await connection.holdAdvisoryLock(key,()=>{losses++;});
  return {factory,window:protocol.window,connection,owner,clients,calls,get losses(){return losses;},
    setLock:value=>{lock=value;},setAction:fn=>{action=fn;},
    async close(){await owner.close();await connection.end();release();await protocol.window.close();}};
}
describe('selected held-owner backend integrity',function(){
  let previous;
  beforeEach(()=>{previous=scope.getTenancyMode();scope.setTenancyMode('multi');});
  afterEach(()=>scope.setTenancyMode(previous));
  it('retains bounded live admission on a public/mixed owner window',async()=>{
    const f=await fixture(false);
    try{
      await f.owner.withTenant(A,async()=>{await f.connection.query('SELECT ordinary_tenant_work');});
      assert(f.calls.some(c=>c.text.includes('/* operation-window-current */')));
      assert(f.calls.some(c=>c.text.includes('/* operation-window-final */')));
      assert.equal(f.window.trustedWorker,false);assert.equal(f.clients.length,1);
    }finally{await f.close();}
  });
  it('retires the owner after an uncertain COMMIT and never replays its body',async()=>{
    const f=await fixture();
    let attempts=0;
    try{
      f.setAction(async(client,text)=>{if(text==='COMMIT')throw new Error('synthetic lost COMMIT response');});
      await assert.rejects(f.owner.withTenant(A,async()=>{attempts++;}),/lost COMMIT response/);
      assert.equal(f.owner.available,false);
      assert.equal(f.losses,1);
      await assert.rejects(f.owner.withTenant(A,async()=>{attempts++;}),{code:'POSTGRES_OPERATIONAL_OWNER_LOST'});
      assert.equal(attempts,1);
    }finally{await f.close();}
  });
  it('latches advisory lock loss and refuses following tenant work',async()=>{
    const f=await fixture();
    try {
      f.setLock(false);
      await assert.rejects(f.owner.check());
      assert.equal(f.owner.available,false);
      await assert.rejects(f.owner.withTenant(A,async()=>assert.fail()),{code:'POSTGRES_OPERATIONAL_OWNER_LOST'});
    } finally {await f.close();}
  });
});
