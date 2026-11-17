'use strict';
const assert=require('node:assert/strict'),sql=require('../lib/storage/clinical-stream-sql'),state=require('../lib/storage/clinical-stream-state'),native=require('./lib/clinical-stream-native');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',digest='a'.repeat(64),limits={maxRows:10,maxBytes:100000};
function fixture({holdCommit=false,loseReply=false}={}){
 const calls=[],durable=new Map([A,B].map(tenant=>[tenant,{projection:[state.bootstrap(null,{stream:native.boundary,checkpoint:10,signature:{stamp:10,deleted:0},rows:[]},limits)],contract_digest:digest,checkpoint:10,work_version:2,work_observed:[],work_completed:[],work_observed_at:[],work_pending_at:null,work_due_at:null,work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0'}]));
 let current,commit,connected=0;
 const client={release:()=>{},query:async(text,values=[])=>{
  calls.push({text,values});
  if(text==='BEGIN'){current=structuredClone(durable);return {};}
  if(text==='ROLLBACK'){current=null;return {};}
  if(text==='COMMIT'){
   if(holdCommit)await new Promise(resolve=>{commit=resolve;});
   for(const [key,value]of current)durable.set(key,value);current=null;
   if(loseReply){loseReply=false;throw new Error('LOST_COMMIT_REPLY');}return {command:'COMMIT'};
  }
  if(text.includes('pg_advisory_xact_lock_shared'))return {rows:[{}]};
  if(text.startsWith('SELECT projection,contract_digest,checkpoint FROM '))return {rows:[structuredClone(current.get(values[0]))]};
  if(text.startsWith('SELECT c.tenant_id'))return {rows:values[0].map(tenant=>({tenant,...structuredClone(current.get(tenant))}))};
  if(text.startsWith('SELECT tenant_id'))return {rows:values[1].map(tenant=>({tenant,...structuredClone(current.get(tenant))}))};
  if(text.startsWith('WITH input')){const patches=JSON.parse(values[1]);for(const patch of patches){const row=current.get(patch.tenant);row.work_observed=patch.observed;row.work_observed_at=patch.observed_at;row.work_pending_at=patch.pending_at;row.work_enabled=patch.enabled;row.work_activity_enabled=patch.activity;row.work_lifecycle_enabled=patch.lifecycle;if(patch.control)row.delivery_revision=String(BigInt(row.delivery_revision)+1n);}return {rowCount:patches.length};}
  if(text.startsWith('UPDATE ')&&text.includes('SET delivery_revision')){const row=current.get(values[0]);row.delivery_revision=String(BigInt(row.delivery_revision)+1n);return {rowCount:1};}
  if(text.startsWith('UPDATE ')&&text.includes('SET projection=')){const row=current.get(values[0]);row.projection=JSON.parse(values[2]);row.contract_digest=values[3];row.checkpoint=values[4];return {rowCount:1};}
  throw new Error('UNEXPECTED_SQL:'+text);
 }};
 const cache=new Map([...durable].map(([tenant,row])=>[tenant,structuredClone(row.projection[0])]));
 const options={cache,pool:{connect:async()=>{connected++;return client;}},observeBackend:async()=>{},table:'synthetic_work.tenant_consumer_checkpoint',consumer:'evaluator-synthetic',snapshotDigest:digest,completedConsumer:'evaluator-synthetic-completed',completedDigest:digest,expectedSource:native.source,lockKey:'123',assertFence:async()=> '1',routes:[{schema:'synthetic_entries',table:'entries',domain:'entries'}],...limits,maxTransactionRows:100,maxTransactionBytes:100000,envelope:native.envelope([native.row('a')])};
 return {options,calls,durable,cache,get connected(){return connected;},commit:()=>commit()};
}
describe('atomic native clinical and control SQL receipt',()=>{
 it('accepts a fresh inactive tenant before clinical bootstrap and keeps its raw work durably pending',async()=>{
  const f=fixture(),initialDigest='b'.repeat(64),row=f.durable.get(A);
  Object.assign(row,{projection:null,checkpoint:0,contract_digest:initialDigest});f.cache.delete(A);
  const receipt=await sql.acceptTransaction({...f.options,initialDigest});
  const saved=f.durable.get(A),input=saved.projection[0];
  assert.equal(input.ready,false);assert.equal(input.rows,undefined);assert.equal(input.floor,1);
  assert.equal(input.stream.snapshot_position,'0/0');assert.equal(input.stream.accepted_position,'0/30');
  assert.equal(saved.contract_digest,digest);assert.equal(saved.work_observed[5],'1');assert.equal(saved.work_completed[5]??null,null);
  assert.notEqual(saved.work_pending_at,null);assert.equal(saved.projection[1].head,1);assert.equal(receipt[0].rawDeliveryPending,true);
  assert.notEqual(f.cache.get(A)?.ready,true,'COLD_RECEIPT_MUST_NOT_CREATE_READY_CLINICAL_RAM');
  assert(f.calls.every(c=>!c.text.includes('.entries')),'COLD_RECEIPT_MUST_NOT_ACQUIRE_SOURCE');
 });
 it('replays an uncertain fresh receipt without duplicating raw delivery or its pending token',async()=>{
  const f=fixture({loseReply:true}),initialDigest='b'.repeat(64);
  Object.assign(f.durable.get(A),{projection:null,checkpoint:0,contract_digest:initialDigest});f.cache.delete(A);
  await assert.rejects(sql.acceptTransaction({...f.options,initialDigest}),/LOST_COMMIT_REPLY/);
  const committed=structuredClone(f.durable),offset=f.calls.length;
  await sql.acceptTransaction({...f.options,initialDigest});assert.deepEqual(f.durable,committed);
  assert.equal(f.durable.get(A).projection[1].head,1);assert.equal(f.durable.get(A).work_observed[5],'1');
  assert.equal(f.calls.slice(offset).filter(call=>call.text.startsWith('UPDATE ')||call.text.startsWith('WITH input')).length,0,'FRESH_REPLAY_MUST_NOT_REWRITE');
 });
 it('refuses foreign or nonempty initial contracts and rolls back a fresh multi-tenant receipt on a failed fence',async()=>{
  const initialDigest='b'.repeat(64);
  for(const patch of [{projection:null,checkpoint:0,contract_digest:'c'.repeat(64)},
    {projection:[],checkpoint:0,contract_digest:initialDigest},{projection:null,checkpoint:1,contract_digest:initialDigest}]){
   const f=fixture();Object.assign(f.durable.get(A),patch);f.cache.delete(A);const before=structuredClone(f.durable);
   await assert.rejects(sql.acceptTransaction({...f.options,initialDigest}),/CLINICAL_STREAM_CONTRACT/);assert.deepEqual(f.durable,before);
  }
  const f=fixture();for(const tenant of [A,B]){Object.assign(f.durable.get(tenant),{projection:null,checkpoint:0,contract_digest:initialDigest});f.cache.delete(tenant);}
  const before=structuredClone(f.durable);let fences=0;
  await assert.rejects(sql.acceptTransaction({...f.options,initialDigest,envelope:native.envelope([native.row('a'),native.row('b',130,'I',B)]),assertFence:async()=>{if(++fences===4)throw new Error('FRESH_OWNER_CHANGED');return '1';}}),/FRESH_OWNER_CHANGED/);
  assert.deepEqual(f.durable,before,'FRESH_RECEIPT_MUST_ROLL_BACK_INPUT_RAW_AND_PENDING');
 });
 it('holds transport ACK until complete SQL COMMIT and does no source/window acquisition',async()=>{
  const f=fixture({holdCommit:true});let ack=false;const pending=sql.acceptTransaction(f.options).then(()=>{ack=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(ack,false);assert.equal(f.durable.get(A).projection[0].rows.length,0);
  assert(f.calls.every(c=>!c.text.includes('.entries')),'WARM_SOURCE_REACQUISITION');f.commit();await pending;assert.equal(ack,true);assert.equal(f.durable.get(A).projection[0].rows,undefined);assert.equal(f.cache.get(A).rows.length,1);
 });
 it('control: removing awaited COMMIT makes early ACK oracle red; restoration passes',async()=>{
  const control=require('./lib/clinical-working-set/control');const broken=control('../lib/storage/clinical-stream-sql',"const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');began=false;","const committed={command:'COMMIT'};began=false;");
  const check=async module=>{const f=fixture({holdCommit:true});let ack=false;const pending=module.acceptTransaction(f.options).then(()=>{ack=true;});await new Promise(resolve=>setImmediate(resolve));const early=ack;if(!early)f.commit();await pending;assert.equal(early,false,'EARLY_COHORT_ACK');};
  await assert.rejects(check(broken),/EARLY_COHORT_ACK/);await check(sql);
 });
 it('commits all clinical tenants and control observations together, rolling back every row on a failed fence',async()=>{
  const f=fixture();let fences=0;await assert.rejects(sql.acceptTransaction({...f.options,envelope:native.envelope([native.row('a'),native.row('b',130,'I',B)]),observations:[{tenant:A,observed:{settings:'4'}}],assertFence:async()=>{if(++fences===4)throw new Error('OWNER_CHANGED');return '1';}}),/OWNER_CHANGED/);
  assert.equal(f.durable.get(A).projection[0].rows.length,0);assert.equal(f.durable.get(B).projection[0].rows.length,0);assert.deepEqual(f.durable.get(A).work_observed,[]);
  for(const tenant of [A,B])f.cache.set(tenant,structuredClone(f.durable.get(tenant).projection[0]));
  await sql.acceptTransaction({...f.options,envelope:native.envelope([native.row('a'),native.row('b',130,'I',B)]),observations:[{tenant:A,observed:{settings:'4'}}]});
  assert.equal(f.durable.get(A).projection[0].rows,undefined);assert.equal(f.cache.get(A).rows.length,1);assert.equal(f.durable.get(B).projection[0].rows,undefined);assert.equal(f.durable.get(A).work_observed[1],'4');
 });
 it('replays uncertain committed delivery without rewrites and returns durable lost-wake obligation',async()=>{
  const f=fixture({loseReply:true});await assert.rejects(sql.acceptTransaction(f.options),/LOST_COMMIT_REPLY/);const offset=f.calls.length;
  const receipts=await sql.acceptTransaction(f.options);assert.equal(receipts[0].tenant,A);assert.equal(receipts[0].deliveryPending,false);assert.equal(receipts[0].rawDeliveryPending,false);
  assert.equal(f.calls.slice(offset).filter(c=>c.text.startsWith('UPDATE ')||c.text.startsWith('WITH input')).length,0,'REPLAY_REWRITES');assert.equal(f.durable.get(A).projection[1].head,1);assert.equal(f.cache.get(A)?.ready,false,'UNCERTAIN_COMMIT_CACHE_NOT_READY');
 });
 it('keeps delayed raw rows after snapshot coverage and late commits with earlier WAL row positions',async()=>{
  const f=fixture();f.durable.get(A).projection[0].stream.snapshot_position='0/50';f.cache.get(A).stream.snapshot_position='0/50';
  await sql.acceptTransaction(f.options);assert.equal(f.cache.get(A).rows.length,0);assert.equal(f.durable.get(A).projection[1].head,1);
  const later=native.row('late');later.lsn='0/11';await sql.acceptTransaction({...f.options,envelope:native.envelope([later],'0/60')});
  assert.equal(f.cache.get(A).rows[0].doc._id,'late');assert.equal(f.durable.get(A).projection[1].head,2,'OLD_TRANSACTION_RAW_MUTATION_LOST');
 });
 it('accepts raw delivery independently when the complete clinical set overflows and remains pending',async()=>{
  const f=fixture();await sql.acceptTransaction({...f.options,maxRows:1,envelope:native.envelope([native.row('a'),native.row('b')])});
  const saved=f.durable.get(A);assert.equal(saved.projection[0].ready,false);assert.equal(saved.projection[0].gap,'rows');assert.equal(saved.work_observed[5],'11');assert.equal(saved.projection[1].head,2);
 });
 it('explicit invalidation advances pending work without rewinding local coverage or racing recovery',async()=>{
  const f=fixture();const receipt=await sql.accept({...f.options,tenant:A,invalidate:true});
  const saved=f.durable.get(A);assert.equal(saved.projection[0].floor,11);assert.equal(saved.projection[0].ready,false);assert.equal(saved.work_observed[5],'11');assert.equal(receipt.rawDeliveryPending,true);
  await sql.accept({...f.options,tenant:A,invalidate:true});assert.equal(f.durable.get(A).projection[0].floor,12);
  await assert.rejects(sql.accept({...f.options,tenant:A,invalidate:true,lockKey:undefined}),/RECOVERY_LOCK/);assert.equal(f.durable.get(A).projection[0].floor,12);
 });
 it('accepts only the explicit fixed worker tenant without effects on a neighbor',async()=>{
  const f=fixture(),before=structuredClone(f.durable.get(B));
  const receipt=await sql.acceptTransaction({...f.options,admits:tenant=>tenant===A,envelope:native.envelope([native.row('a'),native.row('b',130,'I',B)]),observations:[{tenant:B,observed:{settings:'4'}}]});
  assert.deepEqual(receipt.map(r=>r.tenant),[A]);assert.deepEqual(f.durable.get(B),before);assert.equal(f.cache.get(A).rows.length,1);
 });
 it('does no SQL for empty filtered cohorts and rejects malformed partial input before pool acquisition',async()=>{
  const f=fixture();assert.deepEqual(await sql.acceptTransaction({...f.options,envelope:native.envelope([])}),[]);assert.equal(f.connected,0);
  const partial=native.envelope([native.row('a')]);partial.Transaction.pop();await assert.rejects(sql.acceptTransaction({...f.options,envelope:partial}),/BOUNDARY/);assert.equal(f.connected,0);
 });
});
