'use strict';
// Recording ports for tests of preview composition, never native SQL. The
// writer-driven source (lib/writer-driven) has no stream recovery, slot or
// receipt; the start schema check is recorded, never run against a database.
function document(pgstream={}){
 return {bounds:pgstream.bounds};
}
function config(pgstream={}){
 const {bounds,outputPeer,outputPeers}=pgstream;
 return {bounds,...(outputPeer?{outputPeer}:{}),...(outputPeers?{outputPeers}:{})};
}
function writer(lifecycleNamespace='synthetic_activity'){
 return {sweepMs:60000,lifecycleNamespace};
}
function replay(){
 return {};
}
function mocks({events=[]}={}){
 return {'../../writer-driven/schema':{CODE:require('../../lib/writer-driven/schema').CODE,async check(){events.push('schema-checked');}},
  '../../tenant-lifecycle/generation-scope':{...require('../../lib/tenant-lifecycle/generation-scope'),catalogue:()=>({version:1,migrations:[]})}};
}
module.exports={document,config,writer,replay,mocks};
