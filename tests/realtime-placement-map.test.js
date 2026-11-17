'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const ownership=require('../lib/realtime-ownership'),slice=require('../lib/pool-membership/slice');
describe('immutable static realtime ownership',function(){
  it('STATIC_VECTOR: matches independent full-width SHA256 at K3/K7 and refuses noncanonical UUIDs',function(){
    for(let i=0;i<1000;i++){const tenant='00000000-0000-4000-8000-'+i.toString(16).padStart(12,'0');for(const count of [1,2,3,7,8]){const expected=Number(createHash('sha256').update(tenant,'utf8').digest().readBigUInt64BE(0)%BigInt(count));assert.equal(slice.bucket(tenant,count),expected,'STATIC_VECTOR');for(let ordinal=0;ordinal<count;ordinal++)assert.equal(ownership.create({count,ordinal}).owns(tenant),ordinal===expected);}}
    assert.throws(()=>slice.bucket('00000000-0000-4000-8000-00000000000A',3));
  });
  it('STATIC_CONFIG: exact boot identity is immutable and legacy publication selectors refuse',function(){
    const shape={count:3,ordinal:1},value=ownership.create(shape);shape.ordinal=2;assert.equal(value.ordinal,1);assert(Object.isFrozen(value));
    for(const input of [{count:0,ordinal:0},{count:3,ordinal:3},{count:2.5,ordinal:1},{count:2,ordinal:-1},{count:2,ordinal:0,extra:true}])assert.throws(()=>ownership.create(input),{code:'REALTIME_STATIC_OWNERSHIP_REFUSED'});
    for(const key of ['MULTITENANT_REALTIME_PLACEMENT','MULTITENANT_REALTIME_ROUTES','REALTIME_WORKER_ID','REALTIME_WORKER_INCARNATION','NS_REALTIME_OWNERSHIP_CONTRACT'])assert.throws(()=>ownership.load({[key]:'obsolete'}),{code:'REALTIME_STATIC_OWNERSHIP_REFUSED'});
    assert.deepEqual(ownership.load({}).cached(),{count:1,ordinal:0,rule:slice.RULE});
  });
  it('STATIC_PEERS: ordinal order is preserved and ambiguous, duplicate or service addresses refuse',function(){
    const bounds={maxBytes:1000,timeoutMs:100},observer=require('../lib/server/internal-api/listener-config').observer({NS_REALTIME_INTERNAL_SOCKET:'/synthetic/service.sock'});
    const source=addresses=>({NS_REALTIME_SLICE_PEERS:JSON.stringify(addresses)});
    const selected=ownership.peers(source([{socket:'/synthetic/z.sock'},{url:'http://realtime-2:19913/'}]),observer,bounds);assert.equal(selected.endpoints[0].socketPath,'/synthetic/z.sock');assert.equal(selected.endpoints[1].url,'http://realtime-2:19913/');
    for(const addresses of [[],[{socket:'/synthetic/a.sock'},{socket:'/synthetic/a.sock'}],[{socket:'/synthetic/service.sock'}],[{socket:'relative'}],[{url:'http://realtime/path'}],[{url:'https://realtime:19913/'}],[{url:'http://realtime:19913/',extra:true}]])assert.throws(()=>ownership.peers(source(addresses),observer,bounds));
  });
  it('STATIC_CENSUS: requires every ordinal once with one K including idle owners',function(){
    const rows=Array.from({length:3},(_,ordinal)=>({roles:['realtime'],slice:{count:3,ordinal}}));assert.deepEqual(ownership.census(rows),{count:3,rule:slice.RULE});
    for(const bad of [rows.slice(0,2),[rows[0],rows[0],rows[2]],[rows[0],rows[1],{roles:['realtime'],slice:{count:4,ordinal:2}}]])assert.throws(()=>ownership.census(bad),{code:'REALTIME_STATIC_OWNERSHIP_REFUSED'});
  });
});
