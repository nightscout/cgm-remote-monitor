'use strict';
// Synthetic SQL recording protocol for actual pg.Pool/postgres-connection.
// Does not execute PL/pgSQL, establish grants/locks/RLS, or qualify native SQL.
const {EventEmitter}=require('node:events');
const profiles=require('../../lib/pgstream/intake-profile'),candidate=require('../../lib/pgstream/assignment-candidate'),grants=require('../../lib/pgstream/intake-grants');
const copy=value=>JSON.parse(JSON.stringify(value));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const options={namespace:'intake_work',membershipNamespace:'intake_members',lifecycleNamespace:'intake_control',consumer:'evaluator-intake',role:'intake_writer',revision:'9007199254740993',members:2,codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,tenants:[A,B]};
function create(profile=profiles.create(options)){
 const b=profile.binding,built=candidate.build({...b,intakeProfile:profile}),clients=[],calls=[],rows=new Map();
 const canonical=require('./operation-window-runtime-protocol')({trustedWorker:true,intakeProfile:profiles.create({...options,lifecycleNamespace:'synthetic_window'})});
 const window=require('../../lib/tenant-lifecycle/operation-window').create({namespace:b.lifecycleNamespace,locks:b.tenants.map((tenant,i)=>({tenant,key:String(17+i*2)})),pool:canonical.pool,trustedWorker:true,intakeProfile:profile});
 const admission=require('./operation-window-admission-protocol')(require('./lifecycle-domain-profile').metadata(profile));
 const state={held:true,failAssert:0,assertions:0,commit:'normal',beforeCommit:async()=>{},role:{},missing:false,extraAuthority:false,badProfile:false,grantsMutation:()=>{},policiesMutation:()=>{},clinical:0,losses:0,verify:0};
 for(const tenant of b.tenants)rows.set(tenant,{tenant,contract_digest:profile.contractDigest,work_version:2,work_observed:['1',null,null,null,null,null],work_completed:['1',null,null,null,null,null],work_observed_at:['10',null,null,null,null,null],work_pending_at:null,work_due_at:'200',work_completed_at:'20',work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0',output_identity:'a'.repeat(64),output_digest:'b'.repeat(64),output_revision:'1',output_restore_generation:'7',work_owner_ordinal:profile.assignment.owner(tenant),work_assignment_revision:b.revision,checkpoint:'7',projection:[{kind:'evaluator-work-v2',output:{synthetic:true}}]});
 function protocol(text,values,client){
  const admitted=admission(text,values);if(admitted)return admitted;
  if(text.includes('/* intake-role */'))return {rows:[{principal:b.role,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:false,...state.role}]};
  if(text.includes('/* intake-effective-grants */')){const plan=[
   {relation:b.namespace+'.tenant_consumer_checkpoint',reads:grants.READS,updates:grants.UPDATES,secured:true},
   {relation:b.namespace+'.schema_migrations',reads:grants.WORK_CATALOGUE_READ,updates:[],secured:false},
   {relation:b.namespace+'.pgstream_intake_profile',reads:grants.PROFILE,updates:[],secured:false},
   {relation:b.membershipNamespace+'.pool_desired',reads:grants.DESIRED,updates:[],secured:false},
   ...Object.entries(grants.CONTROL_READS).map(([table,reads])=>({relation:b.lifecycleNamespace+'.'+table,reads,updates:[],secured:table!=='schema_migrations'}))
  ].map(r=>({...r,reads:[...new Set(r.reads)].sort(),updates:[...r.updates].sort(),kind:'r',persistence:'p',inherited:false,rls:r.secured,forced:r.secured,owns:false,uses_schema:true,creates:false,forbidden:false}));state.grantsMutation(plan);return {rows:plan};}
  if(text.includes('/* intake-other-rights */'))return {rows:state.extraAuthority?[{relation:'other.clinical'}]:[]};
  if(text.includes('/* intake-policies */')){const expression=grants.expression(profile),tenant="tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid",policies=[{name:'tenant_consumer_checkpoint_isolation',command:'*',permissive:true,using:tenant,check:tenant},...['restrict','allow'].map(kind=>({name:'pgstream_intake_'+kind,command:'*',permissive:kind==='allow',using:expression,check:expression}))];state.policiesMutation(policies);return {rows:policies};}
  if(text.includes("t.tgname='pool_mutation_protocol'"))return {rows:['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:require('../../lib/pool-membership/fixed-protocol').BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}))};
  if(text.includes('FROM pg_trigger')){const effect=(name,type,source,fn,columns,deferred)=>({name,type,source,function_name:fn,columns,deferrable:deferred,deferred,enabled:'A',arguments:0,unconditional:true,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']});return {rows:[effect('pgstream_assignment_protocol',31,built.assignmentBody,'pgstream_assignment_required',candidate.ASSIGNMENT_COLUMNS,false),effect('pgstream_effect_protocol',19,built.effectBody,'pgstream_assigned_effect_required',candidate.EFFECT_COLUMNS,false),effect('pgstream_effect_commit',17,built.effectBody,'pgstream_assigned_effect_required',[],true)]};}
  if(text.includes('/* intake-assert-function */'))return {rows:[{source:built.intakeAssertBody,definer:false,config:['search_path=pg_catalog'],arguments:0,void_result:true,executes:true,language:'plpgsql'}]};
  if(text.includes('FROM pg_index'))return {rows:candidate.INDEXES.map(index=>({...index,valid:true,ready:true,unique:false,method:'btree'}))};
  if(text.startsWith('SELECT to_regclass('))return {rows:[{present:true}]};
  if(text.startsWith('SELECT name, checksum FROM'))return {rows:built.catalogue.migrations.map(({name,checksum})=>({name,checksum}))};
  if(text.includes('/* intake-installed-profile */'))return {rows:[{consumer:b.consumer+'-completed',profile:b,digest:state.badProfile?'0'.repeat(64):profile.digest,contract_digest:profile.contractDigest}]};
  if(text.includes('/* intake-admission */'))return {rows:state.missing?[]:values[1].map(id=>copy(rows.get(id)))};
  if(text.includes('pg_try_advisory_lock(')||text.includes("locktype='advisory'"))return {rows:[{held:state.held}]};
  if(text.includes('pg_advisory_xact_lock'))return {rows:[{backend_pid:client.processID,transaction_id:client.xid}]};
  if(text.startsWith("SELECT set_config('app.current_tenant_id','',true)")){client.tenant='';return {rows:[]};}
  if(text.startsWith("SELECT set_config('app.pgstream_intake'")){client.context=JSON.parse(values[0]);return {rows:[]};}
  if(text==='SELECT "'+b.namespace+'".pgstream_intake_assert()'){state.assertions++;if(state.failAssert===state.assertions)throw new Error('SYNTHETIC_SQL_INTAKE_REFUSAL');if(client.tenant!=='')throw new Error('SYNTHETIC_UNINITIALIZED_TENANT_SETTING');return {rows:[]};}
  if(text.startsWith('SELECT tenant_id::text AS tenant,contract_digest,'))return {rows:values[1].map(id=>copy(client.pending.get(id)))};
  if(text.startsWith('WITH input AS')){const patches=JSON.parse(values[1]);for(const patch of patches){const row=client.pending.get(patch.tenant);Object.assign(row,{work_observed:patch.observed,work_observed_at:patch.observed_at,work_pending_at:patch.pending_at===null?null:String(patch.pending_at),work_enabled:patch.enabled,work_activity_enabled:patch.activity,work_lifecycle_enabled:patch.lifecycle,delivery_revision:String(BigInt(row.delivery_revision)+(patch.control?1n:0n))});}return {rows:[],rowCount:patches.length};}
  if(text==='BEGIN'){client.pending=new Map([...rows].map(([id,row])=>[id,copy(row)]));client.xid=String(BigInt(client.xid)+1n);return {rows:[]};}
  if(text==='COMMIT')return null;
  if(text==='ROLLBACK'){client.pending=null;return {rows:[],command:'ROLLBACK'};}
  if(text.includes('pg_advisory_unlock('))return {rows:[]};
  if(text.includes('FROM pg_roles')||text.startsWith('SELECT pg_backend_pid() AS pid'))return {rows:[{rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,pid:client.processID,role:b.role,role_oid:61,birth:'1700000000.000001',database:'disposable_test',database_oid:'16384',server_address:'127.0.0.1',server_port:5432,postmaster_birth:'1700000000.000000'}]};
  throw new Error('SYNTHETIC_SQL_UNEXPECTED');
 }
 class Client extends EventEmitter{
  constructor(){super();this.processID=9300+clients.length;this.xid='9007199254740993';this._queryable=true;this._ending=false;clients.push(this);}
  connect(done){queueMicrotask(()=>done(null));}
  query(input,values,done){if(typeof values==='function'){done=values;values=undefined;}const text=typeof input==='string'?input:input.text;if(typeof input==='object')values=input.values;
   const run=(async()=>{calls.push({text,values:copy(values??null),pid:this.processID});if(text==='COMMIT'){await state.beforeCommit();if(state.commit==='refuse')return {rows:[],command:'ROLLBACK'};if(this.pending)for(const [id,row]of this.pending)rows.set(id,copy(row));this.pending=null;if(state.commit==='unknown')throw new Error('SYNTHETIC_COMMIT_REPLY_LOST');return {rows:[],command:'COMMIT'};}return protocol(text,values,this);})();if(done){run.then(value=>done(null,value),done);return;}return run;
  }
  end(done){this._ending=true;this.emit('end');if(done)queueMicrotask(done);}
 }
 return {A,B,profile,built,rows,calls,clients,state,Client,window,canonical,
  options:{connectionString:'synthetic-intake',Client,max:1,idleTimeoutMillis:0,connectionTimeoutMillis:50,admitBackend:async()=>{state.verify++;},operationWindow:window}};
}
module.exports={create,options,A,B};
