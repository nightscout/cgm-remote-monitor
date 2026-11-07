'use strict';
// Actual cohort handlers/coordinator with recording transport and role contexts.
// No native PG, process deployment, UDS listener or credential-custody evidence.
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const fixture=require('./fixtures/operation-window-runtime-protocol');
const lower=require('../lib/storage/postgres-connection');
const manifest=require('../lib/server/serve/operation-cohort-manifest');
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const roles=['api','evaluator','realtime','tenant-admin'];
const DATA={database:'disposable_test',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.000000'};
function load (overrides,mutate=s=>s) {
  const file=path.resolve(__dirname,'../lib/server/serve/operation-cohort.js'), output={exports:{}};
  const original=require('node:module').createRequire(file);
  vm.runInThisContext('(function(require,module,exports){'+mutate(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>Object.hasOwn(overrides,name)?overrides[name]:original(name),output,output.exports);
  return output.exports;
}
async function lab (mutate) {
  const entries=manifest.validate(roles.map((role,index)=>({id:'peer_'+index,roles:[role],namespaces:['clinical_'+index],endpoint:{socketPath:'/synthetic/peer_'+index+'.sock',maxBytes:100000,timeoutMs:1000}})));
  const handlers=new Map(), locals=new Map(), invalidated=[], actors=roles.map((role,index)=>({pid:100+index,role:'synthetic_'+index,birth:'1700000000.'+index}));
  const flags={};
  const ipc={async open(endpoint,make) {const operations=make(Symbol());handlers.set(endpoint.socketPath,operations);return {async close(){if(handlers.get(endpoint.socketPath)===operations)handlers.delete(endpoint.socketPath);}};},
    client:endpoint=>async(operation,body)=>{
      const handlersForPeer=handlers.get(endpoint.socketPath); if(!handlersForPeer)throw new Error('synthetic missing peer');
      const reply=await handlersForPeer[operation]({},structuredClone(body));
      if(flags.lostAck && operation==='/cohort/invalidate' && endpoint.socketPath===entries[0].endpoint.socketPath)throw new Error('synthetic lost ACK');
      if(flags.wrongAck && operation==='/cohort/invalidate')reply.request='00000000-0000-4000-8000-000000000000';
      if(flags.wrongDB)reply.datastore={...DATA,database_oid:'99999'};
      return structuredClone(reply);
    }};
  async function boot(index) {
    const entry=entries[index], f=fixture();
    const module=load({'../realtime/ipc':ipc,'../../storage/postgres-connection':{
      installOperationWindow:()=>()=>{},cohortBackends:()=>[actors[index]],cohortDatastore:()=>DATA
    },...Object.fromEntries(['preview-api','evaluator-preview','preview-realtime','owner-preview'].map(name=>['./'+name,{boot:async()=>({close:async()=>{},invalidateTenant:async tenant=>invalidated.push([entry.id,tenant])})}]))});
    const cohort=await module.create({window:f.window,names:entry.roles,tenants:[A,B],namespaces:entry.namespaces,participant:entry});
    await cohort.boot(roles[index],{tenantIds:[A,B],namespaces:{clinical:entry.namespaces[0]}});cohort.complete();await cohort.openControl();locals.set(index,cohort);
  }
  for(let index=0;index<entries.length;index++)await boot(index);
  const coordinator=load({'../realtime/ipc':ipc},mutate);
  const remote=await coordinator.createRemote({namespace:'synthetic_window',tenants:[A,B],participants:entries});
  const operator={async query(sql){if(sql.includes('restore-cohort-actors'))return {rows:actors};return {rows:[flags.operatorWrongDB?{...DATA,server_port:5433}:DATA]};}};
  return {coordinator,remote,entries,locals,flags,actors,operator,invalidated,async restart(index){await locals.get(index).close();await boot(index);},
    async close(){await remote.close();for(const local of locals.values())await local.close();}};
}
describe('Separate-process fixed cohort source protocol',function(){
  it('pins all actual peer incarnations, unions actual backend identities, and invalidates only A before ACK',async function(){
    const f=await lab();let pin;
    try{
      pin=await f.coordinator.pin(f.remote,A,{client:f.operator});
      assert.equal((await f.coordinator.assertComplete(f.remote,A,{client:f.operator})).backends,4);
      await f.coordinator.invalidate(f.remote,A);
      assert.deepEqual(f.invalidated.sort(),f.entries.map(entry=>[entry.id,A]).sort());
      assert.equal(f.invalidated.some(row=>row[1]===B),false);
      const b=await f.coordinator.pin(f.remote,B,{client:f.operator});await f.coordinator.releasePin(b);
      await assert.rejects(f.coordinator.pin(f.remote,A,{client:f.operator}),{code:'RESTORE_COHORT_ALREADY_PINNED'});
    }finally{if(pin)await f.coordinator.releasePin(pin);await f.close();}
  });
  it('refuses lost ACK, missing peer, unknown actor and wrong actual operator database',async function(){
    const f=await lab();const pin=await f.coordinator.pin(f.remote,A,{client:f.operator});
    try{
      f.flags.lostAck=true;await assert.rejects(f.coordinator.invalidate(f.remote,A),/lost ACK/);f.flags.lostAck=false;await f.coordinator.invalidate(f.remote,A);
      f.flags.wrongAck=true;await assert.rejects(f.coordinator.invalidate(f.remote,A),{code:'RESTORE_COHORT_PROTOCOL'});f.flags.wrongAck=false;await f.coordinator.invalidate(f.remote,A);
      f.flags.operatorWrongDB=true;await assert.rejects(f.coordinator.assertComplete(f.remote,A,{client:f.operator}),{code:'RESTORE_COHORT_DATASTORE_MISMATCH'});f.flags.operatorWrongDB=false;
      f.actors.push({pid:999,role:'raw_unknown',birth:'1700000001.0'});
      await assert.rejects(f.coordinator.assertComplete(f.remote,A,{client:f.operator}),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});f.actors.pop();await f.coordinator.assertComplete(f.remote,A,{client:f.operator});
      await f.locals.get(1).close();await assert.rejects(f.coordinator.invalidate(f.remote,A),/missing peer/);
    }finally{await f.coordinator.releasePin(pin);await f.close();}
  });
  async function restartCheck(mutate){
    const f=await lab(mutate);const pin=await f.coordinator.pin(f.remote,A,{client:f.operator});
    try{await f.restart(0);await assert.rejects(f.coordinator.assertComplete(f.remote,A,{client:f.operator}),{code:'RESTORE_COHORT_PARTICIPANT_CHANGED'});}
    finally{await f.coordinator.releasePin(pin);await f.close();}
  }
  it('refuses restarted participants during a claim and allows fresh registration after release',async function(){
    await restartCheck();const f=await lab();let pin=await f.coordinator.pin(f.remote,A,{client:f.operator});
    await f.restart(0);await f.coordinator.releasePin(pin);pin=await f.coordinator.pin(f.remote,A,{client:f.operator});await f.coordinator.releasePin(pin);await f.close();
  });
  it('detects a broken incarnation fence and passes restored source',async function(){
    await assert.rejects(restartCheck(s=>s.replace('row.incarnation!==before.incarnation || ','')),/Missing expected rejection/);await restartCheck();
  });
  it('refuses manifest omissions and duplicate endpoints, while admitting explicit API replicas',function(){
    const rows=roles.map((role,index)=>({id:'peer_'+index,roles:[role],namespaces:['clinical_'+index],endpoint:{socketPath:'/synthetic/'+index+'.sock',maxBytes:1000,timeoutMs:1000}}));
    assert.throws(()=>manifest.validate(rows.slice(1)),/cover every role/);
    assert.throws(()=>manifest.validate([...rows,{...rows[0],id:'replica'}]),/Duplicate participant/);
    const replica={...rows[0],id:'replica',endpoint:{...rows[0].endpoint,socketPath:'/synthetic/replica.sock'}};
    assert.equal(manifest.validate([...rows,replica]).length,5);
  });
});

describe('Fixed process configuration v2',function(){
  it('resolves explicit private endpoint references and refuses missing role coverage/local selection',function(){
    const os=require('node:os'),config=require('../lib/server/serve/operation-cohort-config');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cohort-peer-config-')), file=path.join(dir,'config.json');
    const value={version:2,namespace:'synthetic_window',connectionEnv:'SYNTHETIC_PG',locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}],participantId:'peer_0',
      participants:roles.map((role,index)=>({id:'peer_'+index,roles:[role],namespaces:['clinical_'+index],socketPathEnv:'SOCKET_'+index,maxMessageBytes:100000,timeoutMs:1000}))};
    const source={MULTITENANT_OPERATION_CONFIG:file,SYNTHETIC_PG:'postgresql://synthetic:synthetic@127.0.0.1/disposable_test',...Object.fromEntries(roles.map((role,index)=>['SOCKET_'+index,'/synthetic/peer_'+index+'.sock']))};
    try{
      fs.writeFileSync(file,JSON.stringify(value));const parsed=config.load(source);assert.equal(parsed.participantId,'peer_0');assert.equal(parsed.participants.length,4);assert.equal(manifest.isParticipant(parsed.participants[0]),true);
      for(const change of [v=>{v.participantId='absent';},v=>{v.participants.pop();},v=>{v.participants[0].socketPathEnv='ABSENT';},v=>{v.participants[0].timeoutMs=0;}]){
        const changed=structuredClone(value);change(changed);fs.writeFileSync(file,JSON.stringify(changed));assert.throws(()=>config.load(source),/invalid explicit/);
      }
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});

describe('Window and lower lease actual datastore binding',function(){
  function windowModule(mutate=s=>s){
    const file=path.resolve(__dirname,'../lib/tenant-lifecycle/operation-window.js'), output={exports:{}};
    const original=require('node:module').createRequire(file);
    vm.runInThisContext('(function(require,module,exports){'+mutate(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(original,output,output.exports);return output.exports;
  }
  async function bindingCheck(mutate){
    const options={}, f=fixture(options,windowModule(mutate).create);await f.window.ready();
    const before=f.window.datastore;
    // Same schema/table OIDs and catalogue; only the actual PG endpoint differs.
    options.datastore={server_port:5433};let called=false;
    try{
      await assert.rejects(f.window.run(A,()=>{called=true;}),{code:'LIFECYCLE_WINDOW_DATASTORE_CHANGED'});
      assert.equal(called,false);assert.equal(f.pending.size,0);assert.deepEqual(f.window.datastore,before);
      options.datastore={};await f.window.run(A,()=>{called=true;});assert.equal(called,true);
    }finally{await f.window.close();}
  }
  it('refuses an identically migrated foreign datastore before lifetime registration',()=>bindingCheck());
  it('detects removal of the datastore comparison and passes restored source',async function(){
    await assert.rejects(bindingCheck(s=>s.replace("if (!same(await datastore.read(client),database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');",'')),/Missing expected rejection/);await bindingCheck();
  });
});
