'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const assigned=require('../lib/pgstream/assigned-worker'),slice=require('../lib/pool-membership/slice');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
describe('static evaluator process assignment',()=>{
 it('derives ordinal from the hostname and K from NS_EVALUATOR_SLICES; K=1 is unsliced',()=>{
  for(let ordinal=0;ordinal<3;ordinal++)assert.deepEqual({...assigned.hostAssignment({NS_EVALUATOR_SLICES:'3'},'evaluator-'+ordinal)},{count:3,ordinal});
  assert.equal(assigned.hostAssignment({},'evaluator-1'),undefined);
  assert.equal(assigned.hostAssignment({NS_EVALUATOR_SLICES:'1'},'3f2a9c1d0b7e'),undefined);
  // Ordinal >= K: not refused, owns nothing.
  assert.equal(assigned.hostAssignment({NS_EVALUATOR_SLICES:'2'},'evaluator-5').ordinal,5);
  const none=assigned.configure({slice:{count:2,ordinal:5},roster:()=>[],currentGeneration:()=>1},{namespace:'synthetic_checkpoint',consumer:'evaluator-static'});
  assert.deepEqual(none.tenants,[]);assert.throws(()=>none.tenant(A),/FOREIGN_TENANT/);assert.equal(none.filter([]).sql,' AND FALSE');
  const gate=require('../lib/pgstream/static-gate').create({shape:{count:2,ordinal:5},tenants:[],available:()=>true});
  assert.equal(gate.admits(A)||gate.admits(B),false);
  for(const [env,host] of [[{NS_EVALUATOR_SLICES:'2'},'3f2a9c1d0b7e'],[{NS_EVALUATOR_SLICES:'0'},'evaluator-0'],[{NS_EVALUATOR_SLICES:'x'},'evaluator-0'],[{NS_EVALUATOR_SLICES:'2'},'evaluator-01']])
   assert.throws(()=>assigned.hostAssignment(env,host),/ASSIGNMENT_CONFIG/,JSON.stringify([env,host]));
 });
 it('uses full-width canonical hash at K3/K7 and updates its bounded active roster without changing owner identity',()=>{
  const ids=Array.from({length:100},(_,i)=>crypto.createHash('sha256').update(String(i)).digest('hex').slice(0,32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5'));
  for(const k of [3,7])for(let ordinal=0;ordinal<k;ordinal++){
   let active=ids.filter(t=>Number(crypto.createHash('sha256').update(t).digest().readBigUInt64BE(0)%BigInt(k))===ordinal);
   const worker=assigned.configure({slice:{count:k,ordinal},roster:()=>active,currentGeneration:()=>1},{namespace:'synthetic_checkpoint',consumer:'evaluator-static'}),identity=worker.identity,key=worker.key;
   assert.deepEqual(worker.tenants,[...active].sort());active=active.slice(1);assert.deepEqual(worker.tenants,[...active].sort());assert.equal(worker.identity,identity);assert.equal(worker.key,key);
   const foreign=ids.find(t=>slice.bucket(t,k)!==ordinal);assert.throws(()=>worker.tenant(foreign),/FOREIGN_TENANT/);assert.throws(()=>worker.tenant(ids[0].toUpperCase()),/FOREIGN_TENANT/);
  }
 });
 it('accepts a roster above 10,000 tenants and still refuses duplicate, foreign and non-UUID ids',()=>{
  const uuid=i=>crypto.createHash('sha256').update('roster-'+i).digest('hex').slice(0,32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/,'$1-$2-$3-$4-$5');
  const ids=Array.from({length:10001},(_,i)=>uuid(i)),options={namespace:'synthetic_checkpoint',consumer:'evaluator-static'};
  let active=ids;const worker=assigned.configure({slice:{count:1,ordinal:0},roster:()=>active,currentGeneration:()=>1},options);
  assert.equal(worker.tenants.length,10001);assert.deepEqual(worker.filter([]),{sql:' AND TRUE',values:[]});
  active=[...ids,ids[0]];assert.throws(()=>worker.tenants,/EVALUATOR_STATIC_ROSTER_REFUSED/);
  active=[...ids.slice(1),ids[0].toUpperCase()];assert.throws(()=>worker.tenants,/FOREIGN_TENANT/);
  const half=assigned.configure({slice:{count:2,ordinal:0},roster:()=>ids,currentGeneration:()=>1},options);
  assert.throws(()=>half.tenants,/FOREIGN_TENANT/);
  assert.equal(assigned.configure({slice:{count:2,ordinal:0},roster:()=>ids.filter(id=>slice.bucket(id,2)===0),currentGeneration:()=>1},options).tenants.length,ids.filter(id=>slice.bucket(id,2)===0).length);
 });
 it('filters durable work by process slice even before the first tenant is in memory',()=>{
  const params=['evaluator-synthetic-completed',1234];
  const worker=assigned.configure({slice:{count:7,ordinal:3},roster:()=>{throw new Error('ROSTER_ENUMERATED');},currentGeneration:()=>1},{namespace:'synthetic_checkpoint',consumer:'evaluator-static'});
  const filter=worker.filter(params);
  assert.equal(filter.values,params);
  assert.equal(filter.sql,' AND '+slice.sqlPredicate(7,3));
  assert.equal(slice.sqlPredicate(2,2),'FALSE','an ordinal at or above K owns nothing');assert.throws(()=>slice.sqlPredicate(2,-1),/Pool slice/);
 });
 it('holds one slice resource and uses the original completion transaction without repeated owner probes',async()=>{
  const worker=assigned.configure({slice:{count:2,ordinal:0},roster:()=>[A],currentGeneration:()=>1},{namespace:'synthetic_checkpoint',consumer:'evaluator-static'});
  const owner={available:true,withTenantTransaction:async()=>{},check(){throw Error('REPEATED_OWNER_PROBE');}};
  const guard=await worker.open({readOnly:async()=>({rows:[{marker:String(2*slice.MAX_MEMBERS)}]})},owner);
  const context=await guard.start(A,'1');await guard.finish(context);owner.available=false;await assert.rejects(guard.finish(context),/OWNER_UNAVAILABLE/);
 });
});
