'use strict';
// Actual source APIs with recording/transactional JavaScript SQL protocols.
// These checks do not execute PostgreSQL triggers, locks, RLS or COMMIT hooks.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const profiles=require('../lib/pgstream/pool-intake-profile'),receipts=require('../lib/pgstream/pool-intake-receipts'),stores=require('../lib/pgstream/pool-intake-store');
const grants=require('../lib/pgstream/pool-intake-grants'),candidate=require('../lib/pgstream/pool-intake-candidate');
const {RULE,bucket}=require('../lib/pool-membership/slice');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',D='33333333-3333-4333-8333-333333333333';
const options={namespace:'pool_work',membershipNamespace:'pool_members',lifecycleNamespace:'pool_control',role:'pool_intake',operatorRole:'pool_operator',consumer:'evaluator-pool',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:RULE};
const profile=()=>profiles.create(options),copy=value=>JSON.parse(JSON.stringify(value));
function base(){return require('../lib/pgstream/pool-assignment-candidate').build({base:require('../lib/pgstream/assignment-candidate').build(options),membershipNamespace:options.membershipNamespace,lifecycleNamespace:options.lifecycleNamespace,operatorRole:options.operatorRole});}
function sourceApi(name,{from,to,protocolCalls}={}){
 const file=require.resolve('../lib/pgstream/'+name),source=fs.readFileSync(file,'utf8');if(from)assert.equal(source.split(from).length,2,'exact authored mutation anchor');
 const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);
 if(protocolCalls)m.require=id=>id==='./assignment-protocol'?{assertInstalled:async(query,value)=>{assert.equal(typeof query,'function');protocolCalls.push(value);}}:original(id);
 m._compile(from?source.replace(from,to):source,file);return m.exports;
}
function fixture(p=profile(),{predecessorProfile}={}){
 const built=require('../lib/pgstream/pool-catalogue').build(p,{predecessorProfile}),calls=[],rows=new Map(),authority=new Map([[A,{generation:'7',phase:'active',deletion:false}],[B,{generation:'9',phase:'suspended',deletion:false}],[D,{generation:'11',phase:'suspended',deletion:true}]]);
 for(const tenant of [A,B])rows.set(tenant,{tenant,contract_digest:p.contractDigest,work_version:2,work_owner_ordinal:bucket(tenant,3),work_assignment_revision:'9007199254740993',work_observed:['1',null,null,null,null,null],work_completed:['1',null,null,null,null,null],work_observed_at:['10',null,null,null,null,null],work_pending_at:null,work_due_at:'200',work_completed_at:'20',work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0',output_identity:'a'.repeat(64),output_digest:'b'.repeat(64),output_revision:'1',output_restore_generation:authority.get(tenant).generation,checkpoint:'7',projection:[{kind:'evaluator-work-v2',output:{synthetic:true}}]});
 const state={tenant:'',context:null,assertions:0,failAssert:0,revision:'9007199254740993',members:3,pid:41,xid:'9007199254740999',role:{},badProfile:false,badPlacement:false,extra:false,grantMutation:()=>{},policyMutation:()=>{},authorityReads:new Map(),authorityMutation:()=>{}};
 async function query(sql,values=[]){
  calls.push({sql,values:copy(values),tenant:state.tenant});
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[{backend_pid:state.pid,transaction_id:state.xid}]};
  if(sql.includes('/* pool-intake-desired */'))return {rows:[{members:state.members,revision:state.revision,rule:RULE,backend_pid:state.pid,transaction_id:state.xid}]};
  if(sql.startsWith("SELECT set_config('app.current_tenant_id',$1")){state.tenant=values[0];return {rows:[]};}
  if(sql.includes('/* pool-lifecycle-authority */')){
   assert.equal(state.tenant,values[0],'ACTUAL_AUTHORITY_TENANT_GUC');const tenant=values[0],count=(state.authorityReads.get(tenant)||0)+1;state.authorityReads.set(tenant,count);state.authorityMutation(tenant,count);
   const value=authority.get(tenant);return {rows:value?[{tenant,bound:true,...value}]:[]};
  }
  if(sql.includes('/* pool-intake-admission */')){assert.equal(state.tenant,values[1]);return {rows:rows.has(values[1])?[copy(rows.get(values[1]))]:[]};}
  if(sql.startsWith("SELECT set_config('app.pgstream_intake'")){state.context=JSON.parse(values[0]);return {rows:[]};}
  if(sql==='SELECT "pool_work".pgstream_intake_assert()'){
   state.assertions++;if(state.assertions===state.failAssert)throw new Error('SYNTHETIC_POOL_SQL_REFUSAL');assert.deepEqual(Object.keys(state.context).sort(),candidate.CONTEXT_FIELDS);
   assert.equal(state.context.revision,state.revision);assert.equal(state.context.backendPid,String(state.pid));assert.equal(state.context.transactionId,state.xid);assert.equal(state.context.profile,p.digest);
   for(const tenant of state.context.tenants){assert.equal(state.context.generations[tenant],authority.get(tenant)?.generation);if(!authority.get(tenant)?.deletion)assert(rows.has(tenant),'ACTIVE_CHECKPOINT_REQUIRED');}
   return {rows:[]};
  }
  if(sql.startsWith('SELECT tenant_id::text AS tenant,contract_digest,')){
   assert.equal(values[1].length,1,'RLS_RECEIPT_ONE_ACTUAL_TENANT');assert.equal(state.tenant,values[1][0],'RLS_RECEIPT_GUC');return {rows:values[1].filter(id=>rows.has(id)).map(id=>copy(rows.get(id)))};
  }
  if(sql.startsWith('WITH input AS')){const patches=JSON.parse(values[1]);assert.equal(patches.length,1);assert.equal(state.tenant,patches[0].tenant,'RLS_RECEIPT_UPDATE_GUC');for(const patch of patches){const row=rows.get(patch.tenant);Object.assign(row,{work_observed:patch.observed,work_observed_at:patch.observed_at,work_pending_at:patch.pending_at===null?null:String(patch.pending_at),work_enabled:patch.enabled,work_activity_enabled:patch.activity,work_lifecycle_enabled:patch.lifecycle,delivery_revision:String(BigInt(row.delivery_revision)+(patch.control?1n:0n))});}return {rows:[],rowCount:patches.length};}
  if(sql.includes('/* pool-intake-installed-profile */'))return {rows:[{consumer:options.consumer+'-completed',profile:p.binding,digest:state.badProfile?'0'.repeat(64):p.digest,contract_digest:p.contractDigest}]};
  if(sql.includes('/* pool-intake-health-profile */'))return {rows:[{consumer:options.consumer+'-completed',digest:p.digest,contract_digest:p.contractDigest,profile_matches:!state.badProfile}]};
  if(sql.includes('/* pool-intake-pending-health */')){assert.equal(values.length,2);assert(!sql.includes('ANY('));const pending=[...rows.values()].filter(row=>row.work_enabled&&row.work_pending_at!==null).map(row=>Number(row.work_pending_at));return {rows:[{oldest:pending.length?String(Math.min(...pending)):null}]};}
  if(sql.includes('/* intake-role */'))return {rows:[{principal:options.role,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:false,...state.role}]};
  if(sql.includes('/* intake-effective-grants */')){
   const wanted=[{relation:options.namespace+'.tenant_consumer_checkpoint',reads:grants.READS,updates:grants.UPDATES,secured:true},{relation:options.namespace+'.schema_migrations',reads:grants.WORK_CATALOGUE_READ,updates:[],secured:false},{relation:options.membershipNamespace+'.schema_migrations',reads:grants.WORK_CATALOGUE_READ,updates:[],secured:false},{relation:options.namespace+'.pgstream_intake_profile',reads:grants.PROFILE,updates:[],secured:false},{relation:options.membershipNamespace+'.pool_desired',reads:grants.DESIRED,updates:[],secured:false},...Object.entries(grants.CONTROL_READS).map(([table,reads])=>({relation:options.lifecycleNamespace+'.'+table,reads,updates:[],secured:table!=='schema_migrations'}))].map(row=>({...row,reads:[...new Set(row.reads)].sort(),updates:[...row.updates].sort(),kind:'r',persistence:'p',inherited:false,rls:row.secured,forced:row.secured,owns:false,uses_schema:true,creates:false,forbidden:false}));state.grantMutation(wanted);return {rows:wanted};
  }
  if(sql.includes('/* intake-other-rights */'))return {rows:state.extra?[{relation:'other.clinical'}]:[]};
  if(sql.includes('/* intake-policies */')){const expression=grants.expression(p),tenant="tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid",policies=[{name:'tenant_consumer_checkpoint_isolation',command:'*',permissive:true,using:tenant,check:tenant},...['restrict','allow'].map(kind=>({name:'pgstream_intake_'+kind,command:'*',permissive:kind==='allow',using:expression,check:expression}))];state.policyMutation(policies);return {rows:policies};}
  if(sql.includes("t.tgname='pool_mutation_protocol'"))return {rows:['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:require('../lib/pool-membership/fixed-protocol').BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}))};
  if(sql.includes('/* pool-placement-columns */'))return {rows:[{name:'partitioned',type:'boolean',required:true,default_value:'true'},{name:'previous_partitioned',type:'boolean',required:false,default_value:null}]};
  if(sql.includes('/* pool-placement-constraint */'))return {rows:[{expression:state.badPlacement?'true':require('../lib/pool-membership/pool-candidate').EXPRESSION,valid:true,deferrable:false}]};
  if(sql.includes('/* pool-checkpoint-provision-protocol */'))return {rows:['pgstream_checkpoint_provision','pgstream_checkpoint_provision_commit'].map(name=>{const deferred=name.endsWith('_commit');return {name,type:deferred?5:7,enabled:'A',deferrable:deferred,deferred,arguments:0,unconditional:true,columns:'',source:built.provisionBody,function_name:'pgstream_checkpoint_provision_required',definer:false,config:['search_path=pg_catalog'],function_arguments:0,trigger_result:true,language:'plpgsql'};})};
  if(sql.includes('/* pool-checkpoint-provision-ledger */'))return {rows:built.catalogue.migrations.map(({name,checksum})=>({name,checksum}))};
  if(sql.includes('/* pool-checkpoint-provision-profile */'))return {rows:[{consumer:options.consumer+'-completed',profile:p.binding,digest:p.digest,contract_digest:p.contractDigest}]};
  if(sql.includes('FROM pg_trigger')){const legacy=require('../lib/pgstream/assignment-candidate'),entry=(name,type,source,fn,columns,deferred)=>({name,type,source,function_name:fn,columns,deferrable:deferred,deferred,enabled:'A',arguments:0,unconditional:true,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']});return {rows:[entry('pgstream_assignment_protocol',31,built.assignmentBody,'pgstream_assignment_required',legacy.ASSIGNMENT_COLUMNS,false),entry('pgstream_effect_protocol',19,built.effectBody,'pgstream_assigned_effect_required',legacy.EFFECT_COLUMNS,false),entry('pgstream_effect_commit',17,built.effectBody,'pgstream_assigned_effect_required',[],true)]};}
  if(sql.includes('/* intake-assert-function */'))return {rows:[{source:built.intakeAssertBody,definer:false,config:['search_path=pg_catalog'],arguments:0,void_result:true,executes:true,language:'plpgsql'}]};
  if(sql.includes('FROM pg_index'))return {rows:require('../lib/pgstream/assignment-candidate').INDEXES.map(index=>({...index,valid:true,ready:true,unique:false,method:'btree'}))};
  if(sql.startsWith('SELECT to_regclass('))return {rows:[{present:true}]};
  if(sql.startsWith('SELECT name, checksum FROM'))return {rows:(sql.includes('"'+options.membershipNamespace+'"')?require('../lib/pool-membership/pool-candidate').build().migrations:built.catalogue.migrations).map(({name,checksum})=>({name,checksum}))};
  throw new Error('UNEXPECTED_SQL_SOURCE_PROTOCOL: '+sql.slice(0,80));
 }
 return {profile:p,built,calls,rows,authority,state,query};
}
describe('v2 pool intake candidate (generated source only)',()=>{
 it('appends one exact migration preserving all old source and complete worker transition/COMMIT logic',()=>{
  const original=base(),saved=copy(original),built=candidate.build({base:original,intakeProfile:profile()});assert.deepEqual(original,saved);assert.deepEqual(built.catalogue.migrations.slice(0,-1),original.catalogue.migrations);assert.equal(built.catalogue.migrations.at(-1).name,'0008_evaluator_pool_intake');require('../lib/migrations/catalogue').validateCatalogue(built.catalogue);
  const prefix=original.effectBody.slice(0,original.effectBody.indexOf('BEGIN\n')+6),tail=original.effectBody.slice(original.effectBody.indexOf('BEGIN\n')+6);assert(built.effectBody.endsWith(tail));assert(prefix.includes('DECLARE transition jsonb;'));assert(built.effectBody.includes(original.transitionBody));
  const data=built.catalogue.migrations.at(-1).up.join('\n');assert(!data.includes('ARRAY[\''+A));assert(!data.includes('UPDATE tenant_consumer_checkpoint'));assert(!data.includes('DROP TRIGGER'));assert(!data.includes('DISABLE'));assert(data.includes('CREATE TABLE pgstream_intake_profile'));assert(data.includes(profile().digest));assert(data.includes('GRANT EXECUTE ON FUNCTION pgstream_intake_assert() TO "pool_intake"'));
 });
 it('uses current desired/authority and preserves row fields, with exact deferred row tenant binding/restoration',()=>{
  const built=candidate.build({base:base(),intakeProfile:profile()}),s=built.intakeAssertBody,e=built.effectBody;
  for(const token of ['desired.members NOT BETWEEN 1 AND 1024',"desired.revision::text IS DISTINCT FROM context->>'revision'","context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text","mode='ExclusiveLock'","objsubid=1","mode='ShareLock'",'saved_checkpoint.work_assignment_revision IS DISTINCT FROM desired.revision','IF NOT lifetime.deletion THEN','mod((get_byte(bytes,0)::numeric*72057594037927936',"w.phase,w.generation::text AS generation",'tenant_lifecycle_requests','tenant_lifecycle_ceremony',require('../lib/tenant-lifecycle/recommission-candidate').TABLE])assert(s.includes(token),token);
  for(const key of ['checkpoint','projection','work_completed','work_due_at','work_completed_at','output_identity','output_digest','output_revision','output_restore_generation','delivery_ack_revision','contract_digest','work_owner_ordinal','work_assignment_revision'])assert(e.includes('NEW.'+key)&&e.includes('OLD.'+key),key);
  const set=e.indexOf("PERFORM set_config('app.current_tenant_id',NEW.tenant_id::text,true);"),read=e.indexOf('INTO intake_lifetime'),restore=e.indexOf("PERFORM set_config('app.current_tenant_id',intake_prior,true);");assert(set>0&&read>set&&restore>read);assert.equal(e.split("PERFORM set_config('app.current_tenant_id',intake_prior,true);").length,3);assert(e.includes('IF NOT intake_found OR intake_lifetime.deletion'));
 });
 it('control: changing deferred row binding to caller tenant is RED, then original source GREEN',()=>{
  const qualify=api=>{const e=api.build({base:base(),intakeProfile:profile()}).effectBody,set=e.indexOf("PERFORM set_config('app.current_tenant_id',NEW.tenant_id::text,true);"),read=e.indexOf('INTO intake_lifetime');assert(set>=0&&set<read,'DEFERRED_ROW_MUST_BIND_OWN_TENANT');let caller=B,prior=caller;if(set>=0)caller=A;assert.equal(caller,A,'DEFERRED_EARLIER_ROW_VISIBLE');caller=prior;assert.equal(caller,B);};qualify(candidate);const broken=sourceApi('pool-intake-candidate',{from:"PERFORM set_config('app.current_tenant_id',NEW.tenant_id::text,true);",to:"PERFORM set_config('app.current_tenant_id',intake_prior,true);"});assert.throws(()=>qualify(broken),{code:'ERR_ASSERTION'});qualify(candidate);
 });
});
describe('v2 pool receipt transaction source protocols',()=>{
 it('owns bounded observations without caller hooks and keeps arbitrary UUIDs for current authority validation',()=>{
  let reads=0;const observations=[{get tenant(){reads++;return D;},observed:{clock:'2'}}];observations.toJSON=()=>assert.fail('CALLER_TOJSON');observations[Symbol.iterator]=()=>assert.fail('CALLER_ITERATOR');const batch=receipts.capture(profile(),observations);assert.equal(reads,1);assert.equal(batch[0].tenant,D);assert(Object.isFrozen(batch)&&Object.isFrozen(batch[0].observed));
  for(const bad of [[],new Array(65).fill({tenant:A,observed:{clock:'1'}}),[{tenant:A,observed:{unknown:'1'}}],[{tenant:A,observed:{clock:{toString:()=> '1'}}}],[{tenant:A,observed:{clock:'1'},extra:true}]])assert.throws(()=>receipts.capture(profile(),bad));
 });
 it('persists each active/suspended tenant under its own GUC and preserves completed/due/output/ACK fields',async()=>{
  const f=fixture(),before=copy([...f.rows]);const out=await receipts.observe(f.query,f.profile,41,[{tenant:A,observed:{activity:'2'},eligibility:{activity:false}},{tenant:B,observed:{clock:'3'}}]);assert.equal(out.length,2);assert.equal(f.rows.get(A).work_observed[3],'2');assert.equal(f.rows.get(B).work_observed[0],'3');assert.equal(f.state.assertions,2);
  for(const [tenant,old] of before)for(const key of ['checkpoint','projection','work_completed','work_due_at','work_completed_at','output_identity','output_digest','output_revision','output_restore_generation','delivery_ack_revision','contract_digest','work_owner_ordinal','work_assignment_revision'])assert.deepEqual(f.rows.get(tenant)[key],old[key],key);
  assert.equal(f.state.context.revision,'9007199254740993');assert.deepEqual(f.state.context.generations,{[A]:'7',[B]:'9'});assert(f.calls.filter(call=>call.sql.startsWith('WITH input AS')).every(call=>call.tenant===JSON.parse(call.values[1])[0].tenant));
 });
 it('discards only positive current deleted authority without reading or writing its checkpoint, and still rechecks no-op/deleted SQL assertions',async()=>{
  const f=fixture(),out=await receipts.observe(f.query,f.profile,41,[{tenant:D,observed:{clock:'8'}}]);assert.deepEqual(copy(out),[{discarded:true,observed:{clock:'8'},completed:{clock:'8'},pendingAt:null,deliveryPending:false}]);assert(!f.calls.some(call=>call.sql.includes('.tenant_consumer_checkpoint')));assert.equal(f.state.authorityReads.get(D),2);assert.equal(f.state.assertions,2);
  const active=fixture();await receipts.observe(active.query,active.profile,41,[{tenant:A,observed:{clock:'1'}}]);assert.equal(active.state.assertions,2);assert(!active.calls.some(call=>call.sql.startsWith('WITH input AS')));
 });
 it('refuses unknown authority, missing active checkpoints, wrong held PID, changed authority and final no-op assertion',async()=>{
  const unknown=fixture();unknown.authority.delete(D);await assert.rejects(receipts.observe(unknown.query,unknown.profile,41,[{tenant:D,observed:{clock:'2'}}]),/AUTHORITY/);
  const missing=fixture();missing.rows.delete(A);await assert.rejects(receipts.observe(missing.query,missing.profile,41,[{tenant:A,observed:{clock:'2'}}]));assert(!missing.rows.has(A));
  const pid=fixture();await assert.rejects(receipts.observe(pid.query,pid.profile,42,[{tenant:A,observed:{clock:'2'}}]),/BACKEND/);
  const changed=fixture();changed.state.authorityMutation=(tenant,count)=>{if(count===2)changed.authority.get(tenant).generation='8';};await assert.rejects(receipts.observe(changed.query,changed.profile,41,[{tenant:A,observed:{clock:'1'}}]),/LIFECYCLE_CHANGED/);
  const late=fixture();late.state.failAssert=2;await assert.rejects(receipts.observe(late.query,late.profile,41,[{tenant:D,observed:{clock:'1'}}]),/SYNTHETIC_POOL_SQL_REFUSAL/);
 });
 it('validates a changing current admission population without converting checkpoints and allows only positively deleted absence',async()=>{
  const f=fixture();await receipts.admitTenants(f.query,f.profile,[A,D]);await receipts.admitTenants(f.query,f.profile,[B]);assert(!f.calls.some(call=>/INSERT|UPDATE|ALTER|GRANT/.test(call.sql)));assert(!f.calls.filter(call=>call.sql.includes('/* pool-intake-admission */')).some(call=>call.values[1]===D));
  f.rows.delete(B);await assert.rejects(receipts.admitTenants(f.query,f.profile,[B]),/NOT_PROVISIONED/);f.state.badProfile=true;await assert.rejects(receipts.admitTenants(f.query,f.profile,[]),/INSTALLED_PROFILE/);
 });
 it('health checks installed infrastructure and pending source consumer globally without a frozen tenant list',async()=>{
  const f=fixture();assert.deepEqual(await receipts.health(f.query,f.profile),{pending:false,oldestPendingAt:null});f.rows.get(B).work_pending_at='123';assert.deepEqual(await receipts.health(f.query,f.profile),{pending:true,oldestPendingAt:123});f.state.badProfile=true;await assert.rejects(receipts.health(f.query,f.profile),/INSTALLED_PROFILE/);
 });
 it('controls: omitting actual final assertion, final current authority, or per-tenant GUC makes intended refusals RED then restores',async()=>{
  const cases=[{from:'await verify();return result;',to:'return result;',qualify:async api=>{const f=fixture();f.state.failAssert=2;await assert.rejects(api.observe(f.query,f.profile,41,[{tenant:D,observed:{clock:'1'}}]),/SYNTHETIC_POOL_SQL_REFUSAL/);}},{from:'if(value.identity!==old.identity||value.generation!==old.generation||value.eligibility!==old.eligibility)throw new Error(\'PGSTREAM_INTAKE_LIFECYCLE_CHANGED\');}\n await verify();',to:'}\n await verify();',qualify:async api=>{const f=fixture();f.state.authorityMutation=(tenant,count)=>{if(count===2)f.authority.get(tenant).deletion=true;};await assert.rejects(api.observe(f.query,f.profile,41,[{tenant:A,observed:{clock:'1'}}]),/LIFECYCLE_CHANGED/);}},{from:"await query(\"SELECT set_config('app.current_tenant_id',$1,true)\",[input.tenant]);",to:'',qualify:async api=>{const f=fixture();const out=await api.observe(f.query,f.profile,41,[{tenant:A,observed:{clock:'2'}},{tenant:B,observed:{clock:'2'}}]);assert.equal(out.length,2);assert.equal(f.rows.get(A).work_observed[0],'2');assert.equal(f.rows.get(B).work_observed[0],'2');}}];
  for(const control of cases){const broken=sourceApi('pool-intake-receipts',control);await assert.rejects(control.qualify(broken),{code:'ERR_ASSERTION'});await control.qualify(receipts);}
 });
});
describe('v2 pool intake grants and private-store source ports',()=>{
 it('grants dynamic consumer-only checkpoint scope and exact lifecycle column reads, preserving canonical public policy',async()=>{
  const p=profile(),plan=grants.build(p).join('\n');assert(plan.includes('AS RESTRICTIVE'));assert(plan.includes('AS PERMISSIVE'));assert(!plan.includes(A));assert(!plan.includes('GRANT SELECT ON "pool_control"'));for(const [table,columns] of Object.entries(profiles.CONTROL_READS))assert(plan.includes('GRANT SELECT('+columns.join(',')+') ON "pool_control".'+table));assert(!grants.UPDATES.includes('contract_digest'));assert(!grants.UPDATES.includes('work_due_at'));
  const f=fixture();await grants.assertReady(f.query,p);for(const configure of [s=>{s.role.rolinherit=true;},s=>{s.extra=true;},s=>{s.grantMutation=rows=>rows[0].updates.push('contract_digest');},s=>{s.grantMutation=rows=>rows[0].forced=false;},s=>{s.policyMutation=rows=>rows[0].using='true';},s=>{s.policyMutation=rows=>rows.pop();}]){const bad=fixture();configure(bad.state);await assert.rejects(grants.assertReady(bad.query,bad.profile),/REFUSED|AUTHORITY/);}
 });
 it('boot admission validates exact installed profile/catalogue and forwards the explicit v2 protocol contract (protocol seam recorded)',async()=>{
  const f=fixture();assert.equal((await receipts.admit(f.query,f.profile)).digest,f.profile.digest);assert(f.calls.some(call=>call.sql.includes('FROM pg_trigger')));assert(f.calls.some(call=>call.sql.includes('/* intake-assert-function */')));
  const calls=[],api=sourceApi('pool-intake-receipts',{protocolCalls:calls});assert.equal((await api.admit(f.query,f.profile)).digest,f.profile.digest);assert.deepEqual(calls,[{namespace:options.namespace,membershipNamespace:options.membershipNamespace,lifecycleNamespace:options.lifecycleNamespace,poolProfile:f.profile,poolIntake:true,predecessorProfile:undefined,requireIntakeExecute:true}]);assert(!f.calls.some(call=>call.sql.includes('pool-intake-admission')));assert(f.calls.some(call=>call.sql.includes('/* pool-placement-constraint */')));assert(f.calls.some(call=>call.sql.includes('/* pool-checkpoint-provision-protocol */')));f.state.badProfile=true;await assert.rejects(api.admit(f.query,f.profile),/INSTALLED_PROFILE/);
 });
 it('admits explicit selected-v1 provenance against full10 while keeping current assignment independent and rejecting fresh-only history or bad membership5',async()=>{
  const p=profile(),old=require('../lib/pgstream/intake-profile').create({namespace:options.namespace,membershipNamespace:options.membershipNamespace,lifecycleNamespace:options.lifecycleNamespace,role:'old_pool_intake',consumer:options.consumer,codec:options.codec,generationDomain:options.generationDomain,members:2,revision:'7',tenants:[A,B]}),f=fixture(p,{predecessorProfile:old});
  assert.equal((await receipts.admit(f.query,p,{predecessorProfile:old})).digest,p.digest);assert(f.built.catalogue.migrations.some(migration=>migration.name==='0008_evaluator_pool_intake_from_selected_v1'));assert.equal(f.built.catalogue.migrations.at(-1).name,'0010_pool_singleton_effects');assert.equal(f.state.members,3);
  await assert.rejects(receipts.admit(f.query,p),{code:'MIG_UNKNOWN'});f.state.badPlacement=true;await assert.rejects(receipts.admit(f.query,p,{predecessorProfile:old}),/PLACEMENT_CONSTRAINT/);
 });
 it('control: omitting provenance from actual catalogue selection is RED for an adopted ledger, then restored GREEN',async()=>{
  const p=profile(),old=require('../lib/pgstream/intake-profile').create({namespace:options.namespace,membershipNamespace:options.membershipNamespace,lifecycleNamespace:options.lifecycleNamespace,role:'old_pool_intake',consumer:options.consumer,codec:options.codec,generationDomain:options.generationDomain,members:2,revision:'7',tenants:[A,B]});
  const qualify=async api=>{const f=fixture(p,{predecessorProfile:old});assert.equal((await api.admit(f.query,p,{predecessorProfile:old})).digest,p.digest);};await qualify(receipts);const broken=sourceApi('pool-intake-receipts',{from:'.build(p,{predecessorProfile}).catalogue;',to:'.build(p).catalogue;'});await assert.rejects(qualify(broken),{code:'MIG_UNKNOWN'});await qualify(receipts);
 });
 it('control: removing actual FORCE-RLS readiness makes unsafe metadata refusal RED then restores',async()=>{
  const qualify=async api=>{const f=fixture();f.state.grantMutation=rows=>{rows[0].forced=false;};await assert.rejects(api.assertReady(f.query,f.profile),/GRANTS_REFUSED/);};
  await qualify(grants);const broken=sourceApi('pool-intake-grants',{from:'r.forced!==w.secured||',to:''});await assert.rejects(qualify(broken),{code:'ERR_ASSERTION'});await qualify(grants);
 });
 it('store admits changing rosters on the same sole owner, hints only after source port return and never on terminal or uncertain commit',async()=>{
  const p=profile(),hints=[],admitted=[],f=fixture(p);let portAvailable=true,ownerAvailable=true,closed=false,commit='normal',loss;
  const port={get available(){return portAvailable;},admit:async tenants=>{admitted.push([...tenants]);return receipts.admitTenants(f.query,p,tenants);},observeMany:async batch=>{const out=await receipts.observe(f.query,p,41,batch);if(commit==='unknown'){portAvailable=false;throw Object.assign(new Error('SYNTHETIC_COMMIT_REPLY_LOST'),{commitOutcome:'uncertain'});}f.calls.push({sql:'COMMIT'});return out;},health:()=>receipts.health(f.query,p)};
  const connection={holdAdvisoryLock:async(key,onLoss)=>{assert.equal(key,p.ownerKey);loss=onLoss;return {get available(){return ownerAvailable;},openIntakeReceipts:async actual=>{assert.strictEqual(actual,p);return port;},close:async()=>{closed=true;ownerAvailable=false;}};}};
  const store=stores.create({connection,profile:p,onCommit:hint=>hints.push({hint,last:f.calls.at(-1).sql})});await assert.rejects(store.observe(A,'clock','2'),/UNAVAILABLE/);await store.own(()=>{});await store.admit([A,D]);await store.admit([B]);assert.deepEqual(admitted,[[A,D],[B]]);assert(store.available);
  await store.observeMany([{tenant:A,observed:{activity:'2'}},{tenant:D,observed:{clock:'2'}}]);assert.deepEqual(hints,[{hint:{tenant:A,kind:'observe'},last:'COMMIT'}]);commit='unknown';await assert.rejects(store.observe(A,'clock','3'),error=>error.commitOutcome==='uncertain');assert.equal(hints.length,1);assert.equal(store.available,false);await assert.rejects(store.own(()=>{}),/OWNER_STATE/);await loss();await store.close();assert(closed);
 });
 it('store retains committed outcome if ownership disappears after a confirmed private-port result, without emitting a hint',async()=>{
  const p=profile(),hints=[];let available=true;
  const port={get available(){return available;},admit:async()=>{},observeMany:async()=>{available=false;return [{deliveryPending:true}];},health:async()=>({pending:false,oldestPendingAt:null})};
  const connection={holdAdvisoryLock:async()=>({available:true,openIntakeReceipts:async()=>port,close:async()=>{}})},store=stores.create({connection,profile:p,onCommit:hint=>hints.push(hint)});await store.own(()=>{});await store.admit([A]);await assert.rejects(store.observe(A,'clock','2'),error=>error.commitOutcome==='committed');assert.deepEqual(hints,[]);await store.close();
 });
 it('store forwards historical provenance separately to the private port; omission is RED and pure current profile stays unchanged',async()=>{
  const p=profile(),old=require('../lib/pgstream/intake-profile').create({namespace:options.namespace,membershipNamespace:options.membershipNamespace,lifecycleNamespace:options.lifecycleNamespace,role:'old_pool_intake',consumer:options.consumer,codec:options.codec,generationDomain:options.generationDomain,members:2,revision:'7',tenants:[A,B]});
  const qualify=async api=>{let entered=false;const connection={holdAdvisoryLock:async()=>({available:true,openIntakeReceipts:async(value,provenance)=>{assert.strictEqual(value,p);assert.deepEqual(provenance,{predecessorProfile:old});entered=true;return {available:true,admit:async()=>{}};},close:async()=>{}})},store=api.create({connection,profile:p,predecessorProfile:old});try{await store.own(()=>{});assert(entered);assert(!Object.hasOwn(p.binding,'predecessorProfile'));}finally{await store.close();}};
  await qualify(stores);const broken=sourceApi('pool-intake-store',{from:'owner.openIntakeReceipts(p,{predecessorProfile})',to:'owner.openIntakeReceipts(p)'});await assert.rejects(qualify(broken),{code:'ERR_ASSERTION'});await qualify(stores);
 });
});
