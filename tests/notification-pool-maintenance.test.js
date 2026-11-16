'use strict';
// Source I/O and generated-protocol controls only, not native trigger execution.
const assert=require('node:assert/strict');
const maintenance=require('../lib/tenant-notifications/pool-notification-maintenance');
const candidate=require('../lib/tenant-notifications/pool-partition-candidate');
const legacy=require('../lib/tenant-notifications/partition-candidate');
const profiles=require('../lib/pgstream/pool-intake-profile');
const binding={checkpointNamespace:'test_checkpoint',membershipNamespace:'test_membership',lifecycleNamespace:'test_control',consumer:'synthetic',evaluatorConsumer:'evaluator-synthetic-completed'};
const profile=profiles.create({namespace:binding.checkpointNamespace,membershipNamespace:binding.membershipNamespace,lifecycleNamespace:binding.lifecycleNamespace,consumer:'evaluator-synthetic',role:'intake_writer',operatorRole:'intake_operator',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:'sha256-modulo-v1'});
const scope={...binding,namespace:'test_outbox'};
const tenant='00000000-0000-4000-8000-000000000001',claim='00000000-0000-4000-8000-000000000002',digest='a'.repeat(64);
function fixture(change={}){
 const events=[],contexts=[];let reads=0;
 const row={pid:41,xid:'19',tenant,role_oid:'123',birth:'2026-11-15 01:00:00+00',generation:'7',claim_id:claim,artifact_digest:digest,phase:'suspended',audit_role:'123',owner_pid:41,owner_birth:'2026-11-15 01:00:00+00',state:'suspended',unrestored:true,unactivated:true,authorized:true,lifetime_held:true,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,owns_lifecycle:false,...change};
 const state={row,lockPid:41,lockXid:'19',cohort:true,afterFirst:null};
 async function query(sql,values){
  assert(!/^\s*(BEGIN|COMMIT|ROLLBACK|ALTER|GRANT|UPDATE|DELETE|INSERT)/i.test(sql));
  if(sql.includes('pool-notification-maintenance-authority')){events.push('AUTHORITY');reads++;if(reads>1)state.afterFirst?.(row);return {rows:[{...row}]};}
  if(sql.includes('pg_advisory_xact_lock(')){events.push('COHORT_LOCK');return {rows:[{backend_pid:state.lockPid,transaction_id:state.lockXid}]};}
  if(sql.includes('pool-notification-maintenance-cohort')){events.push('COHORT_PROOF');return {rows:[{held:state.cohort,pid:state.lockPid,xid:state.lockXid}]};}
  if(sql.includes('set_config')){events.push('STAMP');assert(sql.includes("'app.pgstream_notification_maintenance',$1,true"));contexts.push(JSON.parse(values[0]));return {rows:[]};}
  assert.fail(sql);
 }
 return {query,state,events,contexts,run:(bindings=[scope])=>maintenance.prepareDelete(query,{profile,bindings,tenant,generation:'7'})};
}
describe('pool notification maintenance DELETE seam',()=>{
 it('observes actual tenant exclusion before cohort exclusion and mints only a LOCAL same-claim context',async()=>{
  const f=fixture(),result=await f.run();assert.deepEqual(f.events,['AUTHORITY','COHORT_LOCK','AUTHORITY','COHORT_PROOF','STAMP']);assert.deepEqual(result,{tenant,generation:'7',claimId:claim,staged:true,bindings:[scope]});assert.deepEqual(Object.keys(f.contexts[0]).sort(),maintenance.CONTEXT_FIELDS);assert.equal(f.contexts[0].artifactDigest,digest);assert.equal(f.contexts[0].transactionId,'19');assert.equal(f.contexts[0].profile,profile.digest);
 });
 it('refuses wrong claim, missing exclusion, role/birth mismatch, suspended-stage mismatch and inactive authority before cohort acquisition',async()=>{
  for(const change of [{claim_id:null},{artifact_digest:null},{phase:'active'},{tenant:claim},{generation:'8'},{lifetime_held:false},{authorized:false},{owner_pid:42},{owner_birth:'other'},{audit_role:'124'},{state:'restored'},{unrestored:false},{unactivated:false},{rolsuper:true},{owns_lifecycle:true}]){const f=fixture(change);await assert.rejects(f.run(),/MAINTENANCE_AUTHORITY/);assert.deepEqual(f.events,['AUTHORITY']);assert.equal(f.contexts.length,0);}
 });
 it('refuses early commit, changed backend/claim and missing actual cohort exclusion before minting context',async()=>{
  for(const change of [f=>{f.state.lockXid='20';},f=>{f.state.lockPid=42;},f=>{f.state.cohort=false;},f=>{f.state.afterFirst=row=>{row.claim_id='00000000-0000-4000-8000-000000000003';};},f=>{f.state.afterFirst=row=>{row.xid='20';};}]){const f=fixture();change(f);await assert.rejects(f.run(),/MAINTENANCE_(TRANSACTION|COHORT|IDENTITY_CHANGED)/);assert.equal(f.contexts.length,0);}
 });
 it('checks source-private claim and exact DATA audit stages before any checkpoint lookup, without borrowing the outbox owner key',()=>{
  const built=candidate.build({binding,intakeProfile:profile}),body=built.maintenanceBody;
  assert.deepEqual(built.catalogue.migrations.slice(0,4),legacy.build(binding).catalogue.migrations);
  assert(built.body.indexOf(body)<built.body.indexOf('SELECT work_owner_ordinal'));
  for(const needle of ["TG_OP='DELETE' AND NULLIF(current_setting('app.pgstream_notification_maintenance',true),'') IS NOT NULL","current_setting('app.current_tenant_id',true) IS DISTINCT FROM subject::text","maintenance->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text","maintenance->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text","lifetime.claim_id IS DISTINCT FROM maintenance->>'claimId'","lifetime.artifact_digest IS DISTINCT FROM maintenance->>'artifactDigest'",'lifetime.authorized IS DISTINCT FROM true','lifetime.role_oid IS DISTINCT FROM maintenance_role','lifetime.owner_pid IS DISTINCT FROM pg_backend_pid()','lifetime.owner_birth IS DISTINCT FROM maintenance_birth',"TG_WHEN='BEFORE' AND (lifetime.state<>'suspended' OR lifetime.restored_at IS NOT NULL)","TG_WHEN='AFTER' AND (lifetime.state<>'restored' OR lifetime.restored_at IS NULL)","objsubid=1 AND mode='ExclusiveLock'","objsubid=2 AND mode='ExclusiveLock'",'RETURN OLD;'])assert(body.includes(needle),needle);
  assert(!body.includes(legacy.OWNER_DOMAIN));assert(!body.includes('RETURN NEW'));assert(!/INSERT|UPDATE|SET ROLE|SECURITY DEFINER/.test(body));
  assert.deepEqual(built.READS,maintenance.READS);assert(maintenance.authoritySQL(profile).includes('JOIN "test_control".tenant_lifecycle_restore_audit'));
 });
 it('propagates private authority permission refusal without minting a raw-GUC substitute',async()=>{
  const permission=Object.assign(new Error('permission denied for function tenant_lifecycle_backend_birth'),{code:'42501'}),calls=[];
  await assert.rejects(maintenance.prepareDelete(async sql=>{calls.push(sql);throw permission;},{profile,bindings:[scope],tenant,generation:'7'}),error=>error===permission);
  assert.equal(calls.length,1);assert(calls[0].includes('pool-notification-maintenance-authority'));assert(!calls[0].includes('set_config'));
 });
 it('cold protocol refuses fake-GUC privilege-bypass source and audit-stage/lock omissions',async()=>{
  const protocol=require('../lib/tenant-notifications/partition-protocol'),built=candidate.build({binding,intakeProfile:profile});
  const rows=legacy.TABLES.flatMap(table_name=>['notification_partition_effect','notification_partition_commit'].map(name=>{const deferred=name.endsWith('commit');return {table_name,name,type:deferred?29:31,enabled:'A',deferrable:deferred,deferred,arguments:0,unconditional:true,column_count:0,source:built.body,function_name:'pgstream_notification_partition',function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']};}));
  await protocol.assertInstalled(async()=>({rows}),'test_outbox',binding,profile);
  for(const needle of ['lifetime.authorized IS DISTINCT FROM true','lifetime.owner_birth IS DISTINCT FROM maintenance_birth',"TG_WHEN='AFTER' AND (lifetime.state<>'restored' OR lifetime.restored_at IS NULL)","objsubid=2 AND mode='ExclusiveLock'"]){assert(built.maintenanceBody.includes(needle));await assert.rejects(protocol.assertInstalled(async()=>({rows:rows.map(row=>({...row,source:row.source.replace(needle,'false')}))}),'test_outbox',binding,profile),/PROTOCOL_UNQUALIFIED/);}
 });
 it('retains one complete batch context for two namespace scopes with repeated or different consumers through recorded BEFORE/AFTER checks',async()=>{
  for(const consumer of [binding.consumer,'second_consumer']){
   const second={...scope,namespace:'another_outbox',consumer},f=fixture(),input=[{...scope},{...second}],result=await f.run(input);
   const expected=[second,scope];assert.deepEqual(result.bindings,expected);assert(Object.isFrozen(result.bindings));assert(result.bindings.every(Object.isFrozen));assert.equal(f.contexts.length,1);const context=f.contexts[0],recorded=[];
   // Deferred row records retain subject/scope; both resolve from the same final
   // transaction-local context. This is a source I/O oracle, not a SQL engine.
   for(const when of ['BEFORE','AFTER'])for(const selected of expected){
    const selectedBinding=Object.fromEntries(Object.entries(selected).filter(([key])=>key!=='namespace')),body=candidate.build({binding:selectedBinding,intakeProfile:profile}).maintenanceBody;
    assert(body.includes("WHERE entry->>'namespace'=TG_TABLE_SCHEMA AND entry->>'consumer'=route"));assert(body.includes("maintenance_scope IS DISTINCT FROM ('"+JSON.stringify(selectedBinding)+"'::jsonb||jsonb_build_object('namespace',TG_TABLE_SCHEMA))"));assert(!body.includes("maintenance->>'consumer'"));
    const found=context.bindings.filter(entry=>entry.namespace===selected.namespace&&entry.consumer===selected.consumer);assert.deepEqual(found,[selected]);assert.equal(context.claimId,claim);assert.equal(context.backendPid,41);assert.equal(context.transactionId,'19');recorded.push({when,namespace:selected.namespace,consumer:selected.consumer,claim:context.claimId});
   }
   assert.equal(recorded.length,4);assert.equal(f.events.filter(event=>event==='STAMP').length,1);input[0].consumer='mutated';assert.deepEqual(result.bindings,expected);assert.deepEqual(context.bindings,expected);
  }
 });
 it('rejects singular API, unknown binding fields, duplicate namespace, layout mismatch and oversized batches before database access',async()=>{
  const refused=async bindings=>{const f=fixture();await assert.rejects(f.run(bindings));assert.equal(f.events.length,0);};
  for(const bindings of [[],[scope,scope],[{...scope,namespace:profile.binding.namespace}],[{...scope,membershipNamespace:'other_membership'}],[{...scope,evaluatorConsumer:'evaluator-other-completed'}],[{...scope,retiredRoles:[]}],Array.from({length:33},(_,i)=>({...scope,namespace:'outbox_'+i}))])await refused(bindings);
  const f=fixture();await assert.rejects(maintenance.prepareDelete(f.query,{profile,binding,tenant,generation:'7'}),/MAINTENANCE_INPUT/);assert.equal(f.events.length,0);
 });
 it('emits exact bounded, canonical and namespace-unique scope admission in each trigger source',()=>{
  const body=candidate.build({binding,intakeProfile:profile}).maintenanceBody;
  for(const needle of ["jsonb_array_length(maintenance->'bindings') NOT BETWEEN 1 AND 32","count(DISTINCT entry->>'namespace')","ORDER BY (entry->>'namespace') COLLATE \"C\"","entry->>'checkpointNamespace' IS DISTINCT FROM 'test_checkpoint'","entry->>'evaluatorConsumer' IS DISTINCT FROM 'evaluator-synthetic-completed'","WHERE entry->>'namespace'=TG_TABLE_SCHEMA AND entry->>'consumer'=route",'NOTIFICATION_MAINTENANCE_SCOPE'])assert(body.includes(needle),needle);
 });
 it('keeps private restore-audit and backend-birth rights out of ordinary worker grant plans',()=>{
  const plan=require('../lib/tenant-notifications/partition-grants').build({...binding,intakeProfile:profile,outboxRole:'outbox_writer'}).join('\n');assert(!/restore_audit|restore_authority|backend_birth|EXECUTE/.test(plan));
 });
});
