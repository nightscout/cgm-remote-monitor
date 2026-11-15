'use strict';
const assert=require('node:assert/strict');
const scope=require('../lib/storage/tenant-scope');
const fixture=require('./fixtures/tenant-notifications');
const readiness=require('../lib/tenant-notifications/readiness');
const admission=require('../lib/tenant-notifications/ack-admission');
const candidate=require('../lib/tenant-notifications/partition-candidate');
const binding={checkpointNamespace:'test_checkpoint',membershipNamespace:'test_membership',lifecycleNamespace:'test_control',consumer:'synthetic',evaluatorConsumer:'evaluator-synthetic-completed'};
describe('notification partition pre-send and independent user ACK source controls',function(){
 let mode;beforeEach(()=>{mode=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(mode));
 it('checks fresh admission after confirmed dispatch COMMIT and refuses without adapter effects',async function(){
  const f=fixture();f.setCycle([fixture.notification()]);let checks=0;
  const c=f.component({beforeSend:async tenant=>{checks++;assert.equal(tenant,f.A);assert.equal(f.calls.at(-1),'COMMIT');assert.equal(f.snapshot().requests[0].state,'attempting');return false;}});
  const result=await c.run(f.A);assert.equal(checks,1);assert.equal(f.effects.length,0);assert.equal(result.results[0].state,'deferred');await c.close();
 });
 it('never enters pre-send or adapter after an uncertain dispatch result',async function(){
  const f=fixture();f.setCycle([fixture.notification()]);let checks=0;
  const store={...f.store,dispatch:async args=>{await f.store.dispatch(args);throw Error('DISPATCH_COMMIT_UNCONFIRMED');}};
  const c=f.component({store,beforeSend:async()=>{checks++;return true;}});
  await assert.rejects(c.run(f.A),/COMMIT_UNCONFIRMED/);assert.equal(checks,0);assert.equal(f.effects.length,0);await c.close();
 });
 it('aborts an owned adapter wait on owner-loss shutdown and ignores late acceptance',async function(){
  const f=fixture();f.setCycle([fixture.notification()]);let sent,done;
  const c=f.component({beforeSend:async()=>true,adapter:{id:'synthetic',send(row,callback){sent=row;done=callback;}}});
  const run=c.run(f.A);await new Promise(resolve=>setImmediate(resolve));assert(sent);await c.close();await run;
  assert.equal(sent.signal.aborted,true);done(null,{accepted:true});assert.equal(f.snapshot().requests[0].state,'attempting');
 });
 it('accepts the explicit opt-in ledger for read-only ACK with no live worker or pool/checkpoint query',async function(){
  const f=fixture(),catalogue=candidate.build(binding).catalogue;let queries=0;
  const connection={async query(sql,values){queries++;assert(!/pool_membership|pool_desired|tenant_consumer_checkpoint/.test(sql));
   if(sql.includes('notification-readiness-ledger'))return {rows:catalogue.migrations.map(({name,checksum})=>({name,checksum}))};
   if(sql.includes('notification-ack-time'))return {rows:[{now_ms:String(f.now())}]};
   const result=await f.connection.query(sql,values);
   if(sql.includes('notification-readiness-table'))for(const row of result.rows){row.inserts=false;row.any_writes=false;row.columns.forEach(column=>{column.inserts=false;column.updates=false;});}
   return result;
  }};
  const ack=admission({namespace:'notification_test',consumer:'synthetic',alarmNamespace:'alarm_protocol',maxRows:10,maxBytes:65536,maxPayloadBytes:10000,expectedCatalogue:catalogue});
  await scope.withTenant(f.A,()=>f.connection.transaction(async()=>{
   await assert.rejects(readiness(connection,'notification_test',{stateReadOnly:true,alarmTable:'"alarm_protocol".tenant_alarm_suppression'}),/SCHEMA_UNSAFE/);
   const result=await ack({connection,operation:{tenant:f.A,args:[1,'default',1000]},configIdentity:'current'});assert.equal(result.accepted,true);
  }));assert(queries>0);
 });
});
