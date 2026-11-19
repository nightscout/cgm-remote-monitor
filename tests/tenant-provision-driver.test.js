'use strict';
// covers: lib/tenant-registry/held-client.js, lib/tenant-registry/provision.js, lib/tenant-registry/vault-keys.js
// Actual pinned pg.Client/pg.Pool protocol recording, no listener or database.
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Client,Pool}=require('pg');
const {checkout}=require('../lib/tenant-registry/held-client');
const turn=()=>new Promise(r=>setImmediate(r));
class Stream extends EventEmitter {
  constructor(){super();this.writable=true;}
  write(_bytes,callback){if(callback)queueMicrotask(callback);return true;}
  end(){this.writable=false;}
  destroy(){this.writable=false;}
}

describe('operator checked-out lifetime: actual pg driver and Vault-await recording',function(){
  it('captures actual pg error outside a query and transfers it to release(error), without a public Ready assertion',async function(){
    const clients=[];
    class Driver extends Client {
      constructor(options){super(options);const connection=this.connection,stream=new Stream();connection.stream=stream;
        connection.connect=function(){this._connecting=true;stream.on('error',e=>this.emit('error',e));stream.once('close',()=>this.emit('end'));};clients.push(this);}
    }
    const pool=new Pool({Client:Driver,max:1,connectionTimeoutMillis:1000});pool.on('error',()=>{});
    const pending=checkout(pool);await turn();const client=clients[0];
    client.connection.emit('readyForQuery',{status:'I'});const held=await pending;
    let finish;const vault=new Promise(r=>{finish=r;});let continued=false;
    const work=held.run(()=>vault).then(()=>{continued=true;});
    const refusal=Object.assign(Error('SYNTHETIC_TRANSPORT_LOST'),{code:'SYNTHETIC_TRANSPORT_LOST'});
    client.connection.emit('error',refusal);finish();await assert.rejects(work,e=>e===refusal);assert.equal(continued,false);
    let released;pool.once('release',(error)=>{released=error;});
    assert.throws(()=>held.release(),e=>e===refusal);assert.equal(released,refusal);
    // Model only an actual subsequent peer EOF, not local end() as retirement.
    client.connection.stream.emit('close');await turn();await pool.end();
  });
  for (const phase of ['postgres', 'vault']) it('stops provisioning on the held client failure during ' + phase, async function () {
    const id = '11111111-1111-4111-8111-111111111111';
    const tenant = { id, hosts: ['one.example.test'] };
    const error = Error('synthetic held client failure');
    const client = new EventEmitter();
    const queries = [], requests = [];
    let released, checkouts = 0;
    client.release = failure => { released = failure; };
    client.query = async sql => {
      queries.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ held: true }] };
      if (sql.includes(' AS a0,')) {
        if (phase === 'postgres') throw error;
        return { rows: [{}] };
      }
      if (sql.includes(' AS retained_residue')) return { rows: [{ retained_residue: false }] };
      return { rows: [] };
    };
    const namespaces = Object.fromEntries(['registry','legacy','secrets','authorization','access','clock','control','settings','operatorPolicy']
      .map(kind => [kind, 'recording_' + kind.toLowerCase()]));
    const connect = require('node:test').mock.method(Pool.prototype, 'connect', callback => { checkouts++; callback(null, client); });
    const provisioning = require('../lib/tenant-registry/provision').createProvisioning({
      namespaces, actor: { principal: 'operator', consumer: 'test' },
      vault: { address: 'http://127.0.0.1/', mount: 'transit', getToken: async () => 'synthetic', allowInsecureLoopback: true },
      fetchImpl: async (_url, options) => {
        requests.push(options.method);
        client.emit('error', error);
        return { status: 404, body: { cancel: async () => {} } };
      }
    });
    try {
      assert.equal((await provisioning.provision(tenant)).outcome, 'refused');
      assert.equal(checkouts, 1);
      assert.equal(released, error);
      assert.deepEqual(requests, phase === 'vault' ? ['GET'] : []);
      assert.equal(queries.filter(query => query === 'COMMIT').length, phase === 'vault' ? 1 : 0);
      assert(!queries.some(query => query === 'ROLLBACK' || query.includes('pg_advisory_unlock') || query.startsWith('INSERT')));
    } finally { connect.mock.restore(); await provisioning.close(); }
  });

});

describe('bounded Vault metadata and nested lifetime awaits',function(){
 const {createVaultKeys,MAX_KEY_METADATA_BYTES}=require('../lib/tenant-registry/vault-keys');
 const base={address:'http://127.0.0.1/',mount:'transit',allowInsecureLoopback:true,getToken:async()=> 'synthetic'};
 const key='tenant-access-11111111-1111-4111-8111-111111111111';
 const good=Buffer.from(JSON.stringify({data:{type:'ed25519',exportable:false,keys:{'1':{public_key:Buffer.alloc(32,3).toString('base64')}}}}));
 it('does not retain empty chunk objects outside the byte budget',async function(){
  const original=Buffer.from;let emptyCopies=0;
  const service=createVaultKeys({...base,fetchImpl:async()=>({status:200,ok:true,body:(async function*(){for(let i=0;i<10000;i++)yield new Uint8Array(0);yield good;})()})});
  Buffer.from=function(value,...args){if(value instanceof Uint8Array && value.byteLength===0)emptyCopies++;return original.call(this,value,...args);};
  try {assert.equal(await service.status(key,'ed25519'),'present');assert.equal(emptyCopies,0);}
  finally {Buffer.from=original;}
 });
 it('stops chunk overflow before parsing or key creation and closes the iterator',async function(){
  let calls=0,closed=false,after=false;
  const service=createVaultKeys({...base,fetchImpl:async()=>{calls++;return{status:200,ok:true,body:(async function*(){try{yield Buffer.alloc(MAX_KEY_METADATA_BYTES,32);yield Buffer.from('x');after=true;}finally{closed=true;}})()};}});
  await assert.rejects(service.ensure(key,'ed25519'),{code:'TENANT_PROVISION_VAULT_UNAVAILABLE'});
  assert.equal(calls,1);assert.equal(after,false);assert.equal(closed,true);
 });
 it('a late reply that ignores abort cannot continue from GET to key birth after the held witness fails',async function(){
  let release,failed=false;const pending=new Promise(r=>{release=r;}),calls=[];
  const service=createVaultKeys({...base,fetchImpl:async(_url,init)=>{calls.push(init.method);await pending;return{status:404,ok:false,body:{cancel:async()=>{}}};}});
  const guard=()=>{if(failed)throw Error('SYNTHETIC_HELD_LIFETIME_FAILED');};
  const work=service.ensure(key,'ed25519',guard);while(!calls.length)await turn();failed=true;release();
  await assert.rejects(work,{code:'TENANT_PROVISION_VAULT_UNAVAILABLE'});assert.deepEqual(calls,['GET']);
 });
 for (const phase of ['token','cancel','chunk']) it('bounds a nonsettling '+phase+' await with healthy PG witness',async function(){
  const calls=[],never=new Promise(()=>{});let tokenFinish;
  const token=new Promise(r=>{tokenFinish=r;});
  const service=createVaultKeys({...base,timeoutMs:10,getToken:phase==='token'?()=>token:base.getToken,
   fetchImpl:async(_url,init)=>{calls.push(init.method);return phase==='cancel'?{status:404,ok:false,body:{cancel:()=>never}}:{status:200,ok:true,body:{async *[Symbol.asyncIterator](){await never;yield Buffer.alloc(0);}}};}});
  const started=performance.now();await assert.rejects(service.ensure(key,'ed25519'),{code:'TENANT_PROVISION_VAULT_UNAVAILABLE'});
  assert(performance.now()-started<500);tokenFinish('synthetic');await turn();assert(!calls.includes('POST'));
 });
 it('a late404 ignoring cancellation cannot dispatch POST after elapsed deadline with healthy PG',async function(){
  let release;const pending=new Promise(r=>{release=r;}),calls=[];
  const service=createVaultKeys({...base,timeoutMs:10,fetchImpl:async(_url,init)=>{calls.push(init.method);await pending;return{status:404,ok:false,body:{cancel:async()=>{}}};}});
  await assert.rejects(service.ensure(key,'ed25519'),{code:'TENANT_PROVISION_VAULT_UNAVAILABLE'});
  release();await turn();await turn();assert.deepEqual(calls,['GET']);
 });
 it('permission, timeout and malformed metadata never become an absence/key-create predicate',async function(){
  for(const kind of ['permission','timeout','malformed']){
   const calls=[];const service=createVaultKeys({...base,fetchImpl:async(_url,init)=>{calls.push(init.method);if(kind==='timeout')throw Error('SYNTHETIC_PROVIDER_PRIVATE');return kind==='permission'?{status:403,ok:false,body:{cancel:async()=>{}}}:{status:200,ok:true,body:(async function*(){yield Buffer.from('{"data":null}');})()};}});
   await assert.rejects(service.ensure(key,'ed25519'));assert.deepEqual(calls,['GET']);
  }
 });
 it('accepts a bounded chunked valid reply without writing',async function(){
  const calls=[];const service=createVaultKeys({...base,fetchImpl:async(_url,init)=>{calls.push(init.method);return{status:200,ok:true,body:(async function*(){yield good.subarray(0,30);yield good.subarray(30);})()};}});
  assert.equal(await service.status(key,'ed25519'),'present');assert.deepEqual(calls,['GET']);
 });
});
