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
 const options={pool:{connect:async()=>{connected++;return client;}},observeBackend:async()=>{},table:'synthetic_work.tenant_consumer_checkpoint',consumer:'evaluator-synthetic',snapshotDigest:digest,completedConsumer:'evaluator-synthetic-completed',completedDigest:digest,expectedSource:native.source,lockKey:'123',assertFence:async()=> '1',routes:[{schema:'synthetic_entries',table:'entries',domain:'entries'}],...limits,maxTransactionRows:100,maxTransactionBytes:100000,envelope:native.envelope([native.row('a')])};
 return {options,calls,durable,get connected(){return connected;},commit:()=>commit()};
}
describe('atomic native clinical and control SQL receipt',()=>{
 it('holds transport ACK until complete SQL COMMIT and does no source/window acquisition',async()=>{
  const f=fixture({holdCommit:true});let ack=false;const pending=sql.acceptTransaction(f.options).then(()=>{ack=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(ack,false);assert.equal(f.durable.get(A).projection[0].rows.length,0);
  assert(f.calls.every(c=>!c.text.includes('.entries')),'WARM_SOURCE_REACQUISITION');f.commit();await pending;assert.equal(ack,true);assert.equal(f.durable.get(A).projection[0].rows.length,1);
 });
 it('control: removing awaited COMMIT makes early ACK oracle red; restoration passes',async()=>{
  const control=require('./lib/clinical-working-set/control');const broken=control('../lib/storage/clinical-stream-sql',"const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');began=false;","const committed={command:'COMMIT'};began=false;");
  const check=async module=>{const f=fixture({holdCommit:true});let ack=false;const pending=module.acceptTransaction(f.options).then(()=>{ack=true;});await new Promise(resolve=>setImmediate(resolve));const early=ack;if(!early)f.commit();await pending;assert.equal(early,false,'EARLY_COHORT_ACK');};
  await assert.rejects(check(broken),/EARLY_COHORT_ACK/);await check(sql);
 });
 it('commits all clinical tenants and control observations together, rolling back every row on a failed fence',async()=>{
  const f=fixture();let fences=0;await assert.rejects(sql.acceptTransaction({...f.options,envelope:native.envelope([native.row('a'),native.row('b',130,'I',B)]),observations:[{tenant:A,observed:{settings:'4'}}],assertFence:async()=>{if(++fences===4)throw new Error('OWNER_CHANGED');return '1';}}),/OWNER_CHANGED/);
  assert.equal(f.durable.get(A).projection[0].rows.length,0);assert.equal(f.durable.get(B).projection[0].rows.length,0);assert.deepEqual(f.durable.get(A).work_observed,[]);
  await sql.acceptTransaction({...f.options,envelope:native.envelope([native.row('a'),native.row('b',130,'I',B)]),observations:[{tenant:A,observed:{settings:'4'}}]});
  assert.equal(f.durable.get(A).projection[0].rows.length,1);assert.equal(f.durable.get(B).projection[0].rows.length,1);assert.equal(f.durable.get(A).work_observed[1],'4');
 });
 it('replays uncertain committed delivery without rewrites and returns durable lost-wake obligation',async()=>{
  const f=fixture({loseReply:true});await assert.rejects(sql.acceptTransaction(f.options),/LOST_COMMIT_REPLY/);const offset=f.calls.length;
  const receipts=await sql.acceptTransaction(f.options);assert.equal(receipts[0].tenant,A);assert.equal(receipts[0].deliveryPending,true);assert.equal(receipts[0].rawDeliveryPending,false);
  assert.equal(f.calls.slice(offset).filter(c=>c.text.startsWith('UPDATE ')||c.text.startsWith('WITH input')).length,0,'REPLAY_REWRITES');assert.equal(f.durable.get(A).projection[1].head,1);
 });
 it('keeps delayed raw rows after snapshot coverage and late commits with earlier WAL row positions',async()=>{
  const f=fixture();f.durable.get(A).projection[0].stream.snapshot_position='0/50';
  await sql.acceptTransaction(f.options);assert.equal(f.durable.get(A).projection[0].rows.length,0);assert.equal(f.durable.get(A).projection[1].head,1);
  const later=native.row('late');later.lsn='0/11';await sql.acceptTransaction({...f.options,envelope:native.envelope([later],'0/60')});
  assert.equal(f.durable.get(A).projection[0].rows[0].doc._id,'late');assert.equal(f.durable.get(A).projection[1].head,2,'OLD_TRANSACTION_RAW_MUTATION_LOST');
 });
 it('accepts raw delivery independently when the complete clinical set overflows and remains pending',async()=>{
  const f=fixture();await sql.acceptTransaction({...f.options,maxRows:1,envelope:native.envelope([native.row('a'),native.row('b')])});
  const saved=f.durable.get(A);assert.equal(saved.projection[0].ready,false);assert.equal(saved.projection[0].gap,'rows');assert.equal(saved.work_observed[5],'11');assert.equal(saved.projection[1].head,2);
 });
 it('explicit invalidation advances pending work without rewinding local coverage or racing recovery',async()=>{
  const f=fixture();const receipt=await sql.accept({...f.options,tenant:A,invalidate:true});
  const saved=f.durable.get(A);assert.equal(saved.projection[0].floor,11);assert.equal(saved.projection[0].ready,false);assert.equal(saved.work_observed[5],'11');assert.equal(receipt.deliveryPending,true);
  await sql.accept({...f.options,tenant:A,invalidate:true});assert.equal(f.durable.get(A).projection[0].floor,12);
  await assert.rejects(sql.accept({...f.options,tenant:A,invalidate:true,lockKey:undefined}),/RECOVERY_LOCK/);assert.equal(f.durable.get(A).projection[0].floor,12);
 });
 it('does no SQL for empty filtered cohorts and rejects malformed partial input before pool acquisition',async()=>{
  const f=fixture();assert.deepEqual(await sql.acceptTransaction({...f.options,envelope:native.envelope([])}),[]);assert.equal(f.connected,0);
  const partial=native.envelope([native.row('a')]);partial.Transaction.pop();await assert.rejects(sql.acceptTransaction({...f.options,envelope:partial}),/BOUNDARY/);assert.equal(f.connected,0);
 });
});
