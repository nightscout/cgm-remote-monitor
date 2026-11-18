'use strict';
const assert=require('node:assert/strict');
const manifests=require('../lib/server/serve/operation-cohort-manifest');
const ownership=require('../lib/realtime-ownership');
function configuredParticipants(){
  return manifests.validate([['api'],['evaluator'],['tenant-admin'],['realtime',0],['realtime',1]].map(([role,ordinal],index)=>({id:'peer_'+index,roles:[role],...(ordinal===undefined?{}:{slice:{count:2,ordinal}}),namespaces:['synthetic_clinical'],endpoint:{socketPath:'/synthetic/peer_'+index+'.sock',maxBytes:100000,timeoutMs:1000}})));
}
describe('static realtime process roster',function(){
  it('includes every configured ordinal, including an idle owner',function(){
    const peers=configuredParticipants();
    assert.equal(ownership.census(peers).count,2);
    assert.throws(()=>ownership.census(peers.filter(row=>row.slice?.ordinal!==1)),{code:'REALTIME_STATIC_OWNERSHIP_REFUSED'});
  });
  it('refuses duplicate ordinals and inconsistent partition counts',function(){
    for(const shape of [{count:2,ordinal:0},{count:3,ordinal:1}]){
      const peers=configuredParticipants().map(row=>row.slice?.ordinal===1?{...row,slice:shape}:row);
      assert.throws(()=>ownership.census(peers),{code:'REALTIME_STATIC_OWNERSHIP_REFUSED'});
    }
  });
});
