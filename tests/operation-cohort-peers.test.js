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
async function lab (mutate, timeoutMs = 1000) {
  const entries=manifest.validate(roles.map((role,index)=>({id:'peer_'+index,roles:[role],namespaces:['clinical_'+index],endpoint:{socketPath:'/synthetic/peer_'+index+'.sock',maxBytes:100000,timeoutMs}})));
  const handlers=new Map(), locals=new Map(), invalidated=[], actors=roles.map((role,index)=>({pid:100+index,role:'synthetic_'+index,birth:'1700000000.'+index}));
  const flags={};
  const late={pid:801,role:'synthetic_late_reader',birth:'1700000003.000001'};
  const backends=index=>[actors[index],...(index===0&&flags.admitLate?[{...late,...(flags.lateWrongBirth?{birth:'1700000003.000002'}:{})}]:[])];
  const ipc={async open(endpoint,service,make) {const operations=make(Symbol());handlers.set(endpoint.socketPath,operations);return {async close(){if(handlers.get(endpoint.socketPath)===operations)handlers.delete(endpoint.socketPath);}};}};
  const clients={lifecycleParticipant:endpoint=>Object.fromEntries(['getStatus','invalidateTenant'].map(operation=>[operation,async body=>{
      if(operation==='getStatus'){flags.statusRequests=(flags.statusRequests||0)+1;if(flags.holdStatus){flags.statusEntered();await flags.holdStatus;}}
      const handlersForPeer=handlers.get(endpoint.socketPath); if(!handlersForPeer)throw new Error('synthetic missing peer');
      const reply=await handlersForPeer[operation]({},structuredClone(body));
      if(flags.lostAck && operation==='invalidateTenant' && endpoint.socketPath===entries[0].endpoint.socketPath)throw new Error('synthetic lost ACK');
      if(flags.wrongAck && operation==='invalidateTenant')reply.request='00000000-0000-4000-8000-000000000000';
      if(flags.wrongDB)reply.datastore={...DATA,database_oid:'99999'};
      return structuredClone(reply);
    }]))};
  async function boot(index) {
    const entry=entries[index], f=fixture();
    const module=load({'../internal-api/transport':ipc,'../internal-api/clients':clients,'../../storage/postgres-connection':{
      installOperationWindow:()=>()=>{},cohortBackends:()=>[actors[index]],cohortDatastore:()=>DATA,cohortSnapshot:async()=>({datastore:DATA,backends:backends(index)})
    },...Object.fromEntries(['preview-api','evaluator-preview','preview-realtime','owner-preview'].map(name=>['./'+name,{boot:async()=>({close:async()=>{},invalidateTenant:async tenant=>invalidated.push([entry.id,tenant])})}]))});
    const cohort=await module.create({window:f.window,names:entry.roles,tenants:[A,B],namespaces:entry.namespaces,participant:entry});
    await cohort.boot(roles[index],{tenantIds:[A,B],namespaces:{clinical:entry.namespaces[0]}});cohort.complete();
    // serve.internal binds the lifecycle handlers; the recording transport stands in for it.
    const operations=module.controlOperations(cohort),address=entry.endpoint.socketPath;handlers.set(address,operations);
    locals.set(index,{async close(){if(handlers.get(address)===operations)handlers.delete(address);await cohort.close();}});
  }
  for(let index=0;index<entries.length;index++)await boot(index);
  const coordinator=load({'../internal-api/transport':ipc,'../internal-api/clients':clients},mutate);
  const remote=await coordinator.createRemote({namespace:'synthetic_window',tenants:[A,B],participants:entries});
  const operator={async query(sql){
    if(sql==='SELECT pg_catalog.pg_stat_clear_snapshot()')return {rows:[{}]};
    if(sql==='SELECT '+lower.datastoreSQL)return {rows:[flags.operatorWrongDB?{...DATA,server_port:5433}:DATA]};
    assert(sql.includes('restore-cohort-actors'),'Unexpected operator census SQL');
    if(flags.actorDelayMs)await new Promise(resolve=>setTimeout(resolve,flags.actorDelayMs));
    flags.actorQueries=(flags.actorQueries||0)+1;
    if(flags.birthAfterStatus){flags.admitLate=true;return {rows:[...actors,late]};}return {rows:actors};
  }};
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
  it('classifies one actor born after a status cut only by a full pinned peer re-observation',async function(){
    const f=await lab();const pin=await f.coordinator.pin(f.remote,A,{client:f.operator});
    try{
      f.flags.birthAfterStatus=true;const before=f.flags.statusRequests,queries=f.flags.actorQueries;
      assert.equal((await f.coordinator.assertComplete(f.remote,A,{client:f.operator})).backends,5);
      assert.equal(f.flags.statusRequests-before,8,'exactly one complete peer re-observation');assert.equal(f.flags.actorQueries-queries,1,'the original SQL actor cut is retained');
      f.flags.admitLate=false;f.flags.lateWrongBirth=true;
      await assert.rejects(f.coordinator.assertComplete(f.remote,A,{client:f.operator}),{code:'RESTORE_COHORT_UNKNOWN_BACKEND'});
      f.flags.lateWrongBirth=false;f.flags.admitLate=false;f.flags.wrongDB=true;
      await assert.rejects(f.coordinator.assertComplete(f.remote,A,{client:f.operator}),{code:'RESTORE_COHORT_PARTICIPANT_CHANGED'});
    }finally{await f.coordinator.releasePin(pin);await f.close();}
  });
  it('does not restart the configured snapshot budget after elapsed census work',async function(){
    const f=await lab(undefined,20);const pin=await f.coordinator.pin(f.remote,A,{client:f.operator});
    try{
      f.flags.birthAfterStatus=true;f.flags.actorDelayMs=30;const before=f.flags.statusRequests;
      await assert.rejects(f.coordinator.assertComplete(f.remote,A,{client:f.operator}),{code:'RESTORE_COHORT_SNAPSHOT_TIMEOUT'});
      assert.equal(f.flags.statusRequests-before,4,'no fresh RPC round starts after the one admitted budget expires');
    }finally{await f.coordinator.releasePin(pin);await f.close();}
  });
  async function closedWhileWaiting(kind,mutate){
    const f=await lab(mutate);let pin=await f.coordinator.pin(f.remote,A,{client:f.operator}),release,entered;
    const gate=new Promise(resolve=>{release=resolve;}),waiting=new Promise(resolve=>{entered=resolve;});
    try{
      f.flags.holdStatus=gate;f.flags.statusEntered=entered;
      const pending=f.coordinator.assertComplete(f.remote,A,{client:f.operator});await waiting;
      if(kind==='close')await f.remote.close();else{await f.coordinator.releasePin(pin);pin=null;}
      release();await assert.rejects(pending,{code:kind==='close'?'RESTORE_COHORT_INCOMPLETE':'RESTORE_COHORT_PIN_REQUIRED'});
    }finally{release();if(pin)await f.coordinator.releasePin(pin);await f.close();}
  }
  it('refuses a closed cohort or released exact pin after a held snapshot reply',async function(){
    await closedWhileWaiting('close');await closedWhileWaiting('release');
  });
  it('detects a removed post-await live-ownership fence and passes restored source',async function(){
    const mutation=s=>{const old="stateOf(cohort,tenant);\n    if (state.kind === 'remote' && state.pinned.get(tenant) !== pin) throw fail('RESTORE_COHORT_PIN_REQUIRED');";assert(s.includes(old));return s.replace(old,'/* deliberate missing live ownership fence */');};
    await assert.rejects(closedWhileWaiting('close',mutation),/Missing expected rejection/);
    await closedWhileWaiting('close');
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
  it('derives participant addresses from serve.internal and peer addresses and refuses missing role coverage/local selection',function(){
    const os=require('node:os'),config=require('../lib/server/serve/operation-cohort-config');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cohort-peer-config-')), file=path.join(dir,'config.json');
    const value={version:2,namespace:'synthetic_window',connectionEnv:'SYNTHETIC_PG',locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}],participantId:'peer_0',
      participants:roles.map((role,index)=>({id:'peer_'+index,roles:[role],namespaces:['clinical_'+index],maxMessageBytes:100000,timeoutMs:1000}))};
    const env=role=>'NS_'+role.toUpperCase().replace('-','_')+'_INTERNAL_';
    const source={MULTITENANT_OPERATION_CONFIG:file,SYNTHETIC_PG:'postgresql://synthetic:synthetic@127.0.0.1/disposable_test',NS_SERVE_INTERNAL_SOCKET:'/synthetic/api.sock',
      ...Object.fromEntries(roles.slice(1).map(role=>[env(role)+'SOCKET','/synthetic/'+role+'.sock']))};
    try{
      fs.writeFileSync(file,JSON.stringify(value));const parsed=config.load(source);assert.equal(parsed.participantId,'peer_0');assert.equal(parsed.participants.length,4);assert.equal(manifest.isParticipant(parsed.participants[0]),true);
      assert.deepEqual(parsed.participants.map(row=>row.endpoint.socketPath),roles.map(role=>'/synthetic/'+role+'.sock'),'own serve.internal for peer_0, peer addresses for the rest');
      const networkSource={MULTITENANT_OPERATION_CONFIG:file,SYNTHETIC_PG:source.SYNTHETIC_PG,NS_SERVE_INTERNAL_HOST:'0.0.0.0',NS_SERVE_INTERNAL_PORT:'1401',
        ...Object.fromEntries(roles.slice(1).map(role=>[env(role)+'URL','http://'+role+'.nightscout.svc.cluster.local:1401']))};
      const http=config.load(networkSource);
      assert.equal(http.participants[0].endpoint.url,'http://127.0.0.1:1401/','own wildcard listener is dialled on loopback');assert.equal(http.participants[1].endpoint.url,'http://evaluator.nightscout.svc.cluster.local:1401/');
      assert.throws(()=>config.load({...networkSource,NS_REALTIME_INTERNAL_URL:networkSource.NS_EVALUATOR_INTERNAL_URL+'/'}),/invalid explicit/,'equivalent HTTP origins cannot alias participant endpoints');
      assert.throws(()=>config.load({...source,NS_API_INTERNAL_SOCKET:'/synthetic/elsewhere.sock'}),/invalid explicit/,'a peer address cannot move a co-resident role');
      for(const retired of [{socketPathEnv:'SOCKET_0'},{endpoint:{urlEnv:'PRIVATE_0',trust:'network'}}]){
        const old=structuredClone(value);Object.assign(old.participants[0],retired);fs.writeFileSync(file,JSON.stringify(old));assert.throws(()=>config.load(source),/invalid explicit/,'per-contract endpoint keys are retired');
      }
      for(const change of [v=>{v.participantId='absent';},v=>{v.participants.pop();},v=>{v.participants[0].roles=['api','unknown'];},v=>{v.participants[0].timeoutMs=0;}]){
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
    await assert.rejects(bindingCheck(s=>{const line="if (row.pid !== client.processID || !same(datastore.identity(row), database)) throw fail('LIFECYCLE_WINDOW_DATASTORE_CHANGED');";assert.ok(s.includes(line));return s.replace(line,'');}),/Missing expected rejection/);await bindingCheck();
  });
});

describe('Actual private IPC client cohort path admission',function(){
  function actualClient(mutate=s=>s,onFilesystem=()=>{}){
    const file=path.resolve(__dirname,'../lib/server/internal-api/transport.js'), output={exports:{}};
    const original=require('node:module').createRequire(file), uid=process.getuid();
    const filesystem={lstatSync:target=>{onFilesystem();return {uid,mode:target==='/synthetic'?0o700:0o600,isDirectory:()=>target==='/synthetic',isSymbolicLink:()=>false,isSocket:()=>target==='/synthetic/cohort.sock'};},realpathSync:target=>target};
    vm.runInThisContext('(function(require,module,exports){'+mutate(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>name==='node:fs'?filesystem:original(name),output,output.exports);
    return output.exports.client;
  }
  function transport(){
    const {EventEmitter}=require('node:events'), calls=[];
    const request=(options,callback)=>{
      const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>req.emit('close');
      req.end=bytes=>{
        calls.push({options,body:JSON.parse(bytes.toString())});
        const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};res.destroy=()=>{};
        callback(res);queueMicrotask(()=>{res.emit('data',Buffer.from(JSON.stringify({accepted:true,path:options.path})));res.emit('end');req.emit('close');});
      };return req;
    };return {calls,request};
  }
  const service={id:'synthetic-cohort-paths',version:1,operations:{
    getStatus:{path:'/cohort/status',request:{type:'object'},response:{type:'object'}},
    invalidateTenant:{path:'/cohort/invalidate',request:{type:'object'},response:{type:'object'}}}};
  async function invoke(name,path,mutate){
    const recording=transport(), client=actualClient(mutate)({socketPath:'/synthetic/cohort.sock',maxBytes:1000,timeoutMs:1000},service,recording.request);
    const result=await client[name]({request:'11111111-1111-4111-8111-111111111111'});
    assert.deepEqual(result,{accepted:true,path});assert.equal(recording.calls.length,1);assert.equal(recording.calls[0].options.path,path);assert.equal(recording.calls[0].options.method,'POST');
  }
  it('maps exactly both named cohort operations to their registered paths',async function(){
    await invoke('getStatus','/cohort/status');await invoke('invalidateTenant','/cohort/invalidate');
  });
  it('detects a wrong wire path and passes restored source',async function(){
    await assert.rejects(invoke('getStatus','/cohort/status',s=>s.replace('path: operation.path',"path: '/cohort/unowned'")),assert.AssertionError);
    await invoke('getStatus','/cohort/status');
  });
  it('exposes no caller-selected path dispatch before filesystem or transport access',function(){
    let called=false,filesystem=false;const client=actualClient(undefined,()=>{filesystem=true;})({socketPath:'/synthetic/cohort.sock',maxBytes:1000,timeoutMs:1000},service,()=>{called=true;throw new Error('must not send');});
    assert.deepEqual(Object.keys(client),['getStatus','invalidateTenant']);assert.equal(client['/cohort/arbitrary'],undefined);assert.equal(client.constructor,undefined);assert.equal(called,false);assert.equal(filesystem,false);
  });
});
