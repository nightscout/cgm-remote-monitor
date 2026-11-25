'use strict';
const assert=require('node:assert/strict');
const scope=require('../lib/storage/tenant-scope');
const fixture=require('./fixtures/tenant-notifications');
const ready=require('../lib/tenant-notifications/readiness');
const diagnose=require('./fixtures/tenant-notification-readiness-diagnostic');
describe('bounded notification readiness metadata observations',function(){
  let mode;
  beforeEach(function(){mode=scope.getTenancyMode();scope.setTenancyMode('multi');});
  afterEach(function(){scope.setTenancyMode(mode);});
  it('captures unchanged raw policy values and primitive types before refusal without observer mutation weakening the predicate',async function(){
    const f=fixture(),records=[];
    // Synthetic SQL-protocol metadata tests only the diagnostic hook. It is NOT
    // a statement about the actual PostgreSQL OID/jsonb representation.
    f.unsafe({tables:{tenant_notification_heads:{policies:[{command:'*',roles:['16384'],permissive:true,
      using:"tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid",check:"tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid"}]}}});
    await assert.rejects(scope.withTenant(f.A,()=>f.connection.transaction(()=>ready(f.connection,'notification_test',{
      diagnosticMaxRows:10,diagnosticMaxBytes:100000,onMetadata(record){records.push(structuredClone(record));
        if(record.kind==='table'&&record.table==='tenant_notification_heads')record.rows[0].policies[0].roles=[0];}
    }))),/NOTIFICATION_SCHEMA_UNSAFE/);
    const table=records.find(record=>record.kind==='table');assert.ok(table,'NOTIFICATION_METADATA_BEFORE_ASSERT');
    assert.deepEqual(table.rows[0].policies[0].roles,['16384']);assert.deepEqual(table.policyRoleTypes,[[['string']]],'NOTIFICATION_METADATA_TYPES_UNCHANGED');
    assert.equal(records.some(record=>record.kind==='ledger'),false,'predicate still stops before later SQL after the unsafe table');
  });
  it('captures the separately consumed suppression predicate raw roles before refusal with the same bounded observer',async function(){
    const records=[];
    const db={async query(sql){
      if(sql.includes('suppression-role'))return {rows:[{uses_schema:true,unrelated:false,creates:false,operator:false}]};
      if(sql.includes('suppression-shape'))return {rows:[{kind:'r',persistence:'p',secured:true,
        columns:[['tenant_id','uuid',true],['alarm_group','text',true],['alarm_level','integer',true],['acked_at','bigint',true],['expires_at','bigint',true]],
        primary_key:['tenant_id','alarm_group','alarm_level'],policies:[{command:'*',roles:['16384'],permissive:true,
          using:"tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid",check:"tenant_id = nullif(current_setting('app.current_tenant_id',true),'')::uuid"}]}]};
      throw new Error('No later SQL expected after unchanged suppression refusal');
    }};
    await assert.rejects(require('../lib/server/serve/evaluator-consumer-readiness').suppression(db,'synthetic_alarm',{
      diagnosticMaxRows:10,diagnosticMaxBytes:100000,onMetadata:record=>records.push(record)
    }),/EVALUATOR_CONSUMER_READINESS_REFUSED/);
    const table=records.find(record=>record.kind==='table');assert.ok(table,'SUPPRESSION_METADATA_BEFORE_ASSERT');
    assert.deepEqual(table.policyRoleTypes,[[['string']]]);
  });
  it('refuses diagnostic row or byte overflow without claiming readiness or changing normal readiness',async function(){
    const f=fixture();
    for(const bounds of [{diagnosticMaxRows:1,diagnosticMaxBytes:100000},{diagnosticMaxRows:10,diagnosticMaxBytes:1}]) {
      await assert.rejects(scope.withTenant(f.A,()=>f.connection.transaction(()=>ready(f.connection,'notification_test',{...bounds,onMetadata(){}}))),/NOTIFICATION_DIAGNOSTIC_BOUND/);
    }
    await scope.withTenant(f.A,()=>f.store.ready(f.A));
  });
  it('requires an explicit native grant and finite env-reference inputs before acquiring a diagnostic connection',async function(){
    await assert.rejects(diagnose({env:{},connectionEnv:'PG',namespace:'notification_test',tenant:fixture().A,maxRows:10,maxBytes:10000,timeoutMs:1000,onObservation(){}}),/EXPLICIT_BOUNDED_NOTIFICATION_DIAGNOSTIC_REQUIRED/);
  });
});
