'use strict';
// Actual coordinator and static participant protocol. Peer/client model only;
// native backend census remains independently exercised by the sharding suite.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const manifests=require('../lib/server/serve/operation-cohort-manifest'),lower=require('../lib/storage/postgres-connection');
const A='00000000-0000-4000-8000-000000000001';
const DATA={database:'synthetic_test',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.0'};
function fixture(){
  const participants=manifests.validate([['api'],['evaluator'],['tenant-admin'],['realtime',0],['realtime',1]].map(([role,ordinal],index)=>({id:'peer_'+index,roles:[role],...(ordinal===undefined?{}:{slice:{count:2,ordinal}}),namespaces:['synthetic_clinical'],endpoint:{socketPath:'/synthetic/peer_'+index+'.sock',maxBytes:100000,timeoutMs:1000}})));
  const flags={},invalidated=[],actors=participants.map((row,index)=>({pid:index+100,role:row.id,birth:String(index+1000)}));let replacement=false;
  function status(peer,body){
    if(flags.missing===peer.id)throw Error('static peer unreachable');const index=participants.indexOf(peer);
    const ownership=peer.slice?{...peer.slice,rule:require('../lib/pool-membership/slice').RULE}:null;if(flags.wrongSlice===peer.id)ownership.ordinal=0;if(flags.wrongK===peer.id)ownership.count=3;
    return{version:4,participant:peer.id,incarnation:'00000000-0000-4000-8000-'+String(index+1+(replacement&&index===3?10:0)).padStart(12,'0'),namespace:'synthetic_control',roles:peer.roles,tenants:[A],namespaces:peer.namespaces,identity:require('./fixtures/operation-window-admission-protocol').identity,datastore:DATA,backends:[actors[index]],ownership,...body};
  }
  const file=path.resolve(__dirname,'../lib/server/serve/operation-cohort.js'),output={exports:{}},original=require('node:module').createRequire(file);
  const clients={lifecycleParticipant:endpoint=>{const peer=participants.find(row=>row.endpoint.socketPath===endpoint.socketPath);return{getStatus:async body=>status(peer,body),invalidateTenant:async body=>{invalidated.push(peer.id);const{incarnation,identity,...echo}=body;return status(peer,echo);}};}};
  vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{filename:file})(name=>name==='../internal-api/clients'?clients:original(name),output,output.exports);
  const coordinator=output.exports,client={query:async sql=>{if(sql==='SELECT pg_catalog.pg_stat_clear_snapshot()')return{rows:[{}]};if(sql==='SELECT '+lower.datastoreSQL)return{rows:[DATA]};assert(sql.includes('restore-cohort-actors'));return{rows:actors};}};
  return{coordinator,participants,flags,invalidated,client,replace(){replacement=true;},open:rows=>coordinator.createRemote({namespace:'synthetic_control',tenants:[A],participants:rows||participants})};
}
describe('exact static realtime maintenance census',function(){
  it('STATIC_COHORT: pins every fixed peer and reported backend including idle ordinals through invalidation',async function(){const f=fixture(),remote=await f.open();let token;try{token=await f.coordinator.pin(remote,A,{client:f.client});assert.deepEqual(await f.coordinator.assertComplete(remote,A,{client:f.client}),{tenant:A,backends:5,exempt:0});await f.coordinator.invalidate(remote,A);assert.deepEqual(f.invalidated,f.participants.map(row=>row.id));}finally{if(token)await f.coordinator.releasePin(token);await remote.close();}});
  it('STATIC_COHORT_OMISSION: a second realtime process never excuses a missing configured ordinal',async function(){const f=fixture();await assert.rejects(f.open(f.participants.filter(row=>row.slice?.ordinal!==1)),{code:'REALTIME_STATIC_OWNERSHIP_REFUSED'});});
  it('STATIC_COHORT_SUBSET: wrong ordinal, mixed K and an unreachable peer refuse before maintenance',async function(){const f=fixture();f.flags.wrongSlice='peer_4';await assert.rejects(f.open(),{code:'RESTORE_COHORT_OWNERSHIP_MISMATCH'});delete f.flags.wrongSlice;f.flags.wrongK='peer_4';await assert.rejects(f.open(),{code:'RESTORE_COHORT_OWNERSHIP_MISMATCH'});delete f.flags.wrongK;f.flags.missing='peer_4';await assert.rejects(f.open(),/static peer unreachable/);});
  it('STATIC_COHORT_REPLACEMENT: same ordinal with a new process incarnation invalidates the pinned operation',async function(){const f=fixture(),remote=await f.open();let token;try{token=await f.coordinator.pin(remote,A,{client:f.client});f.replace();await assert.rejects(f.coordinator.assertComplete(remote,A,{client:f.client}),{code:'RESTORE_COHORT_PARTICIPANT_CHANGED'});}finally{if(token)await f.coordinator.releasePin(token);await remote.close();}});
});
