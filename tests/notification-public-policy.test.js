'use strict';
// Captured generic PostgreSQL metadata through SQL protocol doubles; no database.
const assert=require('node:assert/strict');
const scope=require('../lib/storage/tenant-scope');
const fixture=require('./fixtures/tenant-notifications');
const measured=require('./fixtures/notification-public-policy-metadata.json');
const suppression=require('../lib/server/serve/evaluator-consumer-readiness').suppression;
const alarmMigration=require('../migrations/candidates/postgres-alarm-suppression-v1.json').migrations[0];
const copy=value=>structuredClone(value);
async function outbox(change={}) {
  const f=fixture(),head=copy(measured.outboxHeads);change.head?.(head);
  f.unsafe({tables:{tenant_notification_heads:head},role:change.role||{}});
  return scope.withTenant(f.A,()=>f.store.ready(f.A));
}
async function alarm(change={}) {
  const table=copy(measured.suppression),role={...measured.suppressionRole,...change.role};change.table?.(table);
  return suppression({async query(sql){
    if(sql.includes('suppression-role'))return {rows:[role]};
    if(sql.includes('suppression-shape'))return {rows:[table]};
    if(sql.includes('suppression-ledger'))return {rows:[{name:alarmMigration.name,checksum:alarmMigration.checksum}]};
    throw new Error('Unexpected suppression metadata query');
  }},'synthetic_alarm');
}
describe('actual PostgreSQL PUBLIC policy metadata representation',function(){
  let mode;
  beforeEach(function(){mode=scope.getTenancyMode();scope.setTenancyMode('multi');});
  afterEach(function(){scope.setTenancyMode(mode);});
  it('admits captured JSONB string PUBLIC role in the consumed outbox guard without changing qualifiers or grants',async function(){await outbox();});
  it('admits captured JSONB string PUBLIC role in the consumed suppression guard without changing qualifiers or grants',async function(){await alarm();});
  it('retains exact numeric PUBLIC role compatibility in both consumed guards',async function(){
    await outbox({head:row=>{row.policies[0].roles=[0];}});await alarm({table:row=>{row.policies[0].roles=[0];}});
  });
  it('refuses wrong or coerced roles in both consumed guards',async function(){
    for(const roles of [[],[1],['1'],[0,0],['0','0'],[null],[false],[true],['PUBLIC'],['00'],['-0'],[{}],[-0]]) {
      await assert.rejects(outbox({head:row=>{row.policies[0].roles=roles;}}),/NOTIFICATION_SCHEMA_UNSAFE/,'OUTBOX_NONPUBLIC_ROLE_REFUSED');
      await assert.rejects(alarm({table:row=>{row.policies[0].roles=roles;}}),/EVALUATOR_CONSUMER_READINESS_REFUSED/,'SUPPRESSION_NONPUBLIC_ROLE_REFUSED');
    }
  });
  it('still refuses an extra permissive policy in both consumed guards',async function(){
    const extra={command:'*',roles:['0'],permissive:true,using:'true',check:'true'};
    await assert.rejects(outbox({head:row=>row.policies.push(extra)}),/NOTIFICATION_SCHEMA_UNSAFE/,'OUTBOX_EXTRA_POLICY_REFUSED');
    await assert.rejects(alarm({table:row=>row.policies.push(extra)}),/EVALUATOR_CONSUMER_READINESS_REFUSED/,'SUPPRESSION_EXTRA_POLICY_REFUSED');
  });
  it('still refuses inherited elevated authority in both consumed guards',async function(){
    await assert.rejects(outbox({role:{elevated_membership:true}}),/NOTIFICATION_SCHEMA_UNSAFE/,'OUTBOX_INHERITED_AUTHORITY_REFUSED');
    await assert.rejects(alarm({role:{operator:true}}),/EVALUATOR_CONSUMER_READINESS_REFUSED/,'SUPPRESSION_INHERITED_AUTHORITY_REFUSED');
  });
  it('still refuses BYPASSRLS authority in both consumed guards',async function(){
    await assert.rejects(outbox({role:{rolbypassrls:true}}),/NOTIFICATION_SCHEMA_UNSAFE/,'OUTBOX_BYPASSRLS_REFUSED');
    await assert.rejects(alarm({role:{rolbypassrls:true}}),/EVALUATOR_CONSUMER_READINESS_REFUSED/,'SUPPRESSION_BYPASSRLS_REFUSED');
  });
  it('keeps forced RLS and exact qualifier checks in both guards',async function(){
    for(const change of [row=>{row.secured=false;},row=>{row.policies[0].using='true';},row=>{row.policies[0].check='true';},row=>{row.policies[0].permissive=false;}]) {
      await assert.rejects(outbox({head:change}),/NOTIFICATION_SCHEMA_UNSAFE/);
      await assert.rejects(alarm({table:change}),/EVALUATOR_CONSUMER_READINESS_REFUSED/);
    }
  });
});
