'use strict';
// Source-model checks only. No native PostgreSQL trigger/lock/COMMIT claim.
const assert=require('node:assert/strict');
const owner=require('../lib/tenant-notifications/partition-owner');
const candidate=require('../lib/tenant-notifications/partition-candidate');
const grants=require('../lib/tenant-notifications/partition-grants');
const protocol=require('../lib/tenant-notifications/partition-protocol');
const assignmentCandidate=require('../lib/pgstream/assignment-candidate');
const membershipProtocol=require('../lib/pool-membership/fixed-protocol');
const fixed=require('../lib/pgstream/fixed-assignment');
const {RULE}=require('../lib/pool-membership/slice');
const binding={checkpointNamespace:'test_checkpoint',membershipNamespace:'test_membership',lifecycleNamespace:'test_control',consumer:'synthetic',evaluatorConsumer:'evaluator-synthetic-completed'};
const ids=Array.from({length:64},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const REV='9007199254740993';
function fixture({ordinal=0,revision=REV,runTransaction,fallbackQuery}={}){
 const assignment=fixed.create({tenants:ids,members:2,revision}),self={ordinal,memberId:ids[ordinal],rule:RULE};
 const built=candidate.build(binding),clinical=assignmentCandidate.build(binding);
 const shape=(name,type,source,fn,deferred=false)=>({name,type,source,function_name:fn,deferrable:deferred,deferred,enabled:'A',arguments:0,unconditional:true,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']});
 const notification=candidate.TABLES.flatMap(table_name=>['notification_partition_effect','notification_partition_commit'].map(name=>({...shape(name,name.endsWith('commit')?29:31,built.body,'pgstream_notification_partition',name.endsWith('commit')),table_name,column_count:0})));
 const instruments={notification,assignment:[{...shape('pgstream_assignment_protocol',31,clinical.assignmentBody,'pgstream_assignment_required'),columns:assignmentCandidate.ASSIGNMENT_COLUMNS},{...shape('pgstream_effect_protocol',19,clinical.effectBody,'pgstream_assigned_effect_required'),columns:assignmentCandidate.EFFECT_COLUMNS},{...shape('pgstream_effect_commit',17,clinical.effectBody,'pgstream_assigned_effect_required',true),columns:[]}],indexes:assignmentCandidate.INDEXES.map(index=>({...index,valid:true,ready:true,unique:false,method:'btree'}))};
 let active=false,xid=0,held=false,loss,live=true,generation='7',pid=41,assigned=revision,failCommit=false,broadReads=false;
 const events=[],keys=[];
 const selection=owner.configure({...binding,assignment,self,currentGeneration:()=>generation},'test_outbox');
 const connection={
  async holdAdvisoryLock(key,onLoss){held=true;loss=onLoss;keys.push(key);return {get available(){return held;},backendPid:41,async check(){if(!held)throw Error('LOST');},async close(){held=false;events.push('RELEASE');},async withTenantTransaction(tenant,fn){assert(!active);active=true;xid++;events.push('BEGIN');try{const result=await (runTransaction?runTransaction(fn):fn());if(failCommit)throw Error('COMMIT_UNCONFIRMED');events.push('COMMIT');return result;}catch(error){events.push('ROLLBACK');throw error;}finally{active=false;}}};},
  async readOnly(sql,values){
   if(sql.includes('notification-partition-grants')){const expected={pool_membership:grants.MEMBERS,pool_desired:grants.DESIRED,tenant_consumer_checkpoint:grants.ASSIGNMENT};return {rows:[{uses_schema:true,creates:false,owns:false,broad_reads:broadReads,writes:false,reads:[...expected[values[1]]].sort()}]};}
   if(sql.includes('FROM pg_index'))return {rows:instruments.indexes};
   if(sql.includes('FROM pg_trigger'))return {rows:sql.includes('column_count')?instruments.notification:sql.includes('t.tgname AS name')?instruments.assignment:['pool_membership','pool_desired'].map(table_name=>({...shape('',31,membershipProtocol.BODY,'pool_mutation_lock_required'),table_name}))};
   assert.fail(sql);
  },
  async query(sql,values){assert(active);const identity={backend_pid:pid,transaction_id:String(xid)};
   if(sql.includes('pg_advisory_xact_lock_shared')){events.push('SHARED');return {rows:[identity]};}
   if(sql.includes('.pool_desired'))return {rows:[{...identity,members:2,revision,rule:RULE}]};
   if(sql.includes('json_agg(json_build_object'))return {rows:[{...identity,members:[0,1].map(index=>({ordinal:index,memberId:ids[index],rule:RULE,appliedMembers:2,live}))}]};
   if(sql.includes('SELECT work_owner_ordinal'))return {rows:[{work_owner_ordinal:ordinal,work_assignment_revision:assigned}]};
   if(sql.includes('set_config')){const context=JSON.parse(values[0]);assert.equal(context.backendPid,41);assert.equal(context.transactionId,String(xid));assert.equal(context.revision,revision);events.push('STAMP');return {rows:[]};}
   if(fallbackQuery)return fallbackQuery(sql,values);
   assert.fail(sql);
  }
 };
 return {selection,connection,events,keys,instruments,owned:ids.find(id=>assignment.owner(id)===ordinal),foreign:ids.find(id=>assignment.owner(id)!==ordinal),lose(){held=false;loss();},live(value){live=value;},generation(value){generation=value;},pid(value){pid=value;},assigned(value){assigned=value;},fail(value){failCommit=value;},broad(value){broadReads=value;}};
}
describe('opt-in notification partition source ownership',function(){
 it('keeps a distinct stable outbox key across assignment revisions and ordinals',async function(){
  const a=fixture(),b=fixture({revision:'9007199254740994'}),c=fixture({ordinal:1});
  assert.equal(a.selection.key,b.selection.key);assert.notEqual(a.selection.key,c.selection.key);
  await a.selection.own(a.connection);await a.selection.transaction(a.connection,a.owned,async()=>{a.events.push('EFFECT');});
  assert.deepEqual(a.events,['BEGIN','SHARED','STAMP','EFFECT','SHARED','COMMIT']);
  await a.selection.close();assert.equal(a.selection.available(),false);
 });
 it('refuses foreign tenants, wrong actual PID, stale assignment and unconfirmed COMMIT',async function(){
  const f=fixture();await f.selection.own(f.connection);
  await assert.rejects(f.selection.transaction(f.connection,f.foreign,()=>{}),/FOREIGN_TENANT/);
  f.pid(42);await assert.rejects(f.selection.transaction(f.connection,f.owned,()=>{}),/OWNER_TRANSACTION/);f.pid(41);
  f.assigned('3');await assert.rejects(f.selection.transaction(f.connection,f.owned,()=>{}),/ASSIGNMENT_REFUSED/);f.assigned(REV);
  f.fail(true);assert.equal(await f.selection.beforeSend(f.connection,f.owned),false);
  assert.equal(f.events.at(-1),'ROLLBACK');await f.selection.close();
 });
 it('rechecks membership and restore context after the transaction body and latches owner loss',async function(){
  const f=fixture();let losses=0;await f.selection.own(f.connection,()=>{losses++;});
  await assert.rejects(f.selection.transaction(f.connection,f.owned,()=>{f.live(false);}),/MEMBERSHIP_REFUSED/);f.live(true);
  await assert.rejects(f.selection.transaction(f.connection,f.owned,()=>{f.generation('8');}),/FINAL_FENCE/);
  f.lose();assert.equal(losses,1);assert.equal(await f.selection.beforeSend(f.connection,f.owned),false);await f.selection.close();
 });
 it('rejects extra metadata grants and altered or missing all-table/deferred trigger metadata',async function(){
  const f=fixture();f.broad(true);await assert.rejects(f.selection.own(f.connection),/GRANTS_REFUSED/);assert.equal(f.events.at(-1),'RELEASE');
  for(const mutate of [rows=>rows.pop(),rows=>{rows[0].source=rows[0].source.trim();},rows=>{rows[1].deferred=false;},rows=>{rows[0].enabled='O';},rows=>{rows[0].column_count=1;}]){
   const g=fixture();mutate(g.instruments.notification);await assert.rejects(protocol.assertInstalled(g.connection.readOnly,'test_outbox',binding),/PROTOCOL_UNQUALIFIED/);
  }
 });
 it('runs actual store producer/request/dispatch/finish on the held backend and preserves delivery identity',async function(){
  const scope=require('../lib/storage/tenant-scope'),makeFixture=require('./fixtures/tenant-notifications'),makeStore=require('../lib/tenant-notifications/postgres');
  const f=makeFixture(),mode=scope.getTenancyMode();scope.setTenancyMode('multi');
  // The synthetic component tenant is admitted by a real fixed assignment.
  const assignment=fixed.create({tenants:[f.A,f.B],members:2,revision:REV}),ordinal=assignment.owner(f.A);
  const g=fixture({ordinal,runTransaction:fn=>f.connection.transaction(fn),fallbackQuery:(sql,values)=>f.connection.query(sql,values)});
  g.connection.transaction=()=>{throw Error('UNHELD_BACKEND');};
  // Use fixture's assignment for both fence and table model tenant selection.
  const partition={...binding,assignment,self:{ordinal,memberId:ids[ordinal],rule:RULE},currentGeneration:()=> '7'};
  const store=makeStore({connection:g.connection,namespace:'test_outbox',maxRows:10,maxBytes:65536,assertOperational:async()=>{},partition});
  let component;
  try{
   await store.own();f.setCycle([makeFixture.notification()]);component=f.component({store,beforeSend:tenant=>store.beforeSend(tenant)});
   // Guard fixture's roster uses the same stable two-member identities/rule.
   await component.run(f.A);assert.equal(f.effects.length,1);const row=f.snapshot().requests[0];
   assert.equal(row.state,'accepted');assert.equal(row.consumer,'synthetic');assert.equal(row.request_id,f.effects[0].id);assert.equal(row.attempt,1);
   assert(f.calls.some(row=>row.sql?.includes('notification-producer-lock')));
  }finally{await component?.close();await store.close();scope.setTenancyMode(mode);}
 });
 it('keeps base migrations exact and plans only narrow outbox metadata grants',function(){
  const base=require('../lib/tenant-notifications/postgres-candidate.json');const built=candidate.build(binding);
  assert.deepEqual(built.catalogue.migrations.slice(0,2),base.migrations);assert.equal(candidate.expectedMigrations(built.catalogue).length,3);
  const plan=grants.build({...binding,outboxRole:'outbox_worker',suppressionRole:'suppression_reader',ackRole:'socket_ack'}).join('\n');
  assert(!/UPDATE|INSERT|DELETE|socket_ack|suppression_reader/.test(plan));assert(plan.includes('work_owner_ordinal,work_assignment_revision'));
  assert.throws(()=>grants.build({...binding,outboxRole:'same_role',ackRole:'same_role'}),/DISTINCT_ROLES/);
  assert.equal(owner.configure(undefined,'unused'),null);
 });
});
