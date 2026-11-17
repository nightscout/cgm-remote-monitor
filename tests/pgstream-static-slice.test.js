'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const assigned=require('../lib/pgstream/assigned-worker'),slice=require('../lib/pool-membership/slice');
const stream=require('../lib/storage/clinical-stream-state'),native=require('./lib/clinical-stream-native');
const control=require('./lib/clinical-working-set/control');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const limits={maxRows:100,maxBytes:100000};
function projected(k,ordinal,rows){const original=native.envelope(rows),Transaction=original.Transaction.filter(frame=>['B','C','M'].includes(frame.action)||slice.bucket((frame.columns||frame.identity).find(c=>c.name==='tenant_id').value,k)===ordinal);return {Slice:{count:k,ordinal},Transaction};}
describe('static evaluator ingress and process assignment',()=>{
 it('keeps caller ordinal ordering, exact local receiver and immutable shape; refuses count/address ambiguity',()=>{
  const receivers=['http://evaluator:19913/','http://evaluator-2:19913/'],receiver={url:receivers[0],bindHost:'0.0.0.0',trust:'network',timeoutMs:1000,maxBytes:10000};
  const value={count:2,ordinal:0,receivers},profile=assigned.processProfile(JSON.stringify(value),receiver);
  assert.deepEqual(profile,value);assert(Object.isFrozen(profile)&&Object.isFrozen(profile.receivers));
  for(const bad of [{...value,count:3},{...value,ordinal:2},{...value,receivers:[receivers[0],receivers[0]]},{...value,receivers:[...receivers].reverse()},{...value,receivers:['http://evaluator:19913/path',receivers[1]]},{...value,extra:true}])assert.throws(()=>assigned.processProfile(JSON.stringify(bad),receiver),/CONFIG/);
  assert.deepEqual(assigned.processProfile(JSON.stringify(value),receiver),profile);
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
 it('preserves original boundary/source/count while validating increasing projected gaps and its own rows',()=>{
  const rows=[native.row('a',123,'I',A),native.row('b',130,'I',B),native.row('c',140,'I',A)];
  const envelope=projected(2,0,rows),checked=stream.validateTransaction(envelope,{...limits,slice:{count:2,ordinal:0}});
  assert.deepEqual(checked.changes.map(row=>row.transaction_index),[1,3]);assert.equal(checked.commit.transaction_count,3);assert.equal(checked.commit.transaction_index,4);assert.deepEqual(checked.source_identity,native.source);
  const full=native.envelope(rows),one=projected(1,0,rows);
  assert.deepEqual(stream.validateTransaction(one,{...limits,slice:{count:1,ordinal:0}}),stream.validateTransaction(full,limits),'K1_NATIVE_BOUNDARY_AND_ROWS_EQUAL');
  const changes=[e=>{e.Slice.count=3;},e=>{e.Slice.ordinal=1;},e=>{e.Transaction[1].transaction_index=3;},e=>{e.Transaction[2].transaction_index=1;},e=>{e.Transaction.at(-1).transaction_count=2;},e=>{e.Transaction.at(-1).source_identity={...e.Transaction.at(-1).source_identity,slot:'foreign'};},e=>{e.Transaction[1].xid++;},e=>{e.Transaction[1].action='T';}];
  for(const change of changes){const bad=structuredClone(envelope);change(bad);assert.throws(()=>stream.validateTransaction(bad,{...limits,slice:{count:2,ordinal:0}}),/SLICE|COVERAGE|ACTION/);}
  assert.throws(()=>stream.validateTransaction(envelope,limits),/SLICE_REFUSED/);assert.throws(()=>stream.validateTransaction(full,{...limits,slice:{count:2,ordinal:0}}),/SLICE_REQUIRED/);
  const small=structuredClone(one);small.Transaction.splice(1,1);assert.throws(()=>stream.validateTransaction(small,{...limits,slice:{count:1,ordinal:0}}),/COVERAGE/);
 });
 it('rejects foreign rows before receiver materialization, including conflicting tenant identity on update; marker-only gaps retain source admission',async()=>{
  let materialized=0,schemas=[];const receive=require('../lib/pgstream/receiver').create({routes:[{schema:'synthetic_entries',table:'entries',kind:'clinical',domain:'entries'}],store:{},onInput:()=>{},onSchema:async s=>{schemas=s;},clinical:{slice:{count:2,ordinal:0},maxTransactionRows:100,maxTransactionBytes:100000,acceptTransaction:async()=>{materialized++;return [];}}});
  const wrong=projected(2,1,[native.row('foreign',100,'I',B)]);wrong.Slice.ordinal=0;
  await assert.rejects(receive(wrong),/SLICE_TENANT_REFUSED/);assert.equal(materialized,0);
  const conflict=projected(2,0,[native.row('update',100,'U',A)]);conflict.Transaction[1].identity.find(c=>c.name==='tenant_id').value=B;await assert.rejects(receive(conflict),/SLICE_TENANT_REFUSED/);assert.equal(materialized,0);
  const marker={action:'M',xid:42,lsn:'0/20',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'synthetic_entries',objects:[]})};
  const own=projected(2,0,[native.row('other',100,'I',B),marker]);await receive(own);assert.equal(materialized,1);assert.deepEqual(schemas,['synthetic_entries']);
  await assert.rejects(receive({Data:marker}),/SLICE_REQUIRED/);
 });
 it('control: removing the actual foreign-slice guard makes its criterion red; restored source refuses',()=>{
  const foreign=projected(2,1,[native.row('foreign',100,'I',B)]);foreign.Slice.ordinal=0;
  const criterion=module=>assert.throws(()=>module.validateTransaction(foreign,{...limits,slice:{count:2,ordinal:0}}),/SLICE_TENANT_REFUSED/,'FOREIGN_SLICE_MUST_REFUSE');
  criterion(stream);const broken=control('../lib/storage/clinical-stream-state',"if(require('../pool-membership/slice').bucket(tenant,shape.count)!==shape.ordinal)",'if(false)');assert.throws(()=>criterion(broken),e=>e.code==='ERR_ASSERTION'&&e.message.includes('FOREIGN_SLICE_MUST_REFUSE'));criterion(stream);
 });
 it('holds one slice resource and uses the original completion transaction without repeated owner probes',async()=>{
  const worker=assigned.configure({slice:{count:2,ordinal:0},roster:()=>[A],currentGeneration:()=>1},{namespace:'synthetic_checkpoint',consumer:'evaluator-static'});
  const owner={available:true,withTenantTransaction:async()=>{},check(){throw Error('REPEATED_OWNER_PROBE');}};
  const guard=await worker.open({readOnly:async()=>({rows:[{marker:String(2*slice.MAX_MEMBERS)}]})},owner);
  const context=await guard.start(A,'1');await guard.finish(context);owner.available=false;await assert.rejects(guard.finish(context),/OWNER_UNAVAILABLE/);
 });
});
