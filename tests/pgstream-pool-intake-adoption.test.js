'use strict';
// Administrative SQL command/rollback model only. External readiness ports are
// explicitly recorded stand-ins; native ACL/RLS/parser/lock/COMMIT proof is not
// supplied by this fixture. Grant plans are actual source-builder statements.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const adoption=require('../lib/pgstream/pool-intake-adoption'),v1=require('../lib/pgstream/intake-profile'),v2=require('../lib/pgstream/pool-intake-profile');
const catalogue=require('../lib/migrations/catalogue'),domain=require('../lib/tenant-lifecycle/generation-domain');
const candidate=require('../lib/pgstream/assignment-candidate'),notification=require('../lib/tenant-notifications/partition-candidate');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',D='33333333-3333-4333-8333-333333333333';
const oldOptions={namespace:'origin_work',membershipNamespace:'origin_members',lifecycleNamespace:'origin_life',role:'old_intake',consumer:'evaluator-origin',codec:v1.CODEC,generationDomain:v1.GENERATION_DOMAIN,members:2,revision:'9007199254740993',tenants:[A,B]};
const oldProfile=()=>v1.create(oldOptions),profile=()=>v2.create({namespace:oldOptions.namespace,membershipNamespace:oldOptions.membershipNamespace,lifecycleNamespace:oldOptions.lifecycleNamespace,role:'new_intake',operatorRole:'new_operator',consumer:oldOptions.consumer,codec:v2.CODEC,generationDomain:v2.GENERATION_DOMAIN,sliceRule:'sha256-modulo-v1'});
const copy=value=>JSON.parse(JSON.stringify(value)),q=value=>'"'+value+'"';
function fresh(p){const b=p.binding,assignment=require('../lib/pgstream/pool-assignment-candidate').build({base:candidate.build(b),membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,operatorRole:b.operatorRole}),intake=require('../lib/pgstream/pool-intake-candidate').build({base:assignment,intakeProfile:p});return require('../lib/pgstream/pool-checkpoint-provision-candidate').build({base:intake,intakeProfile:p});}
function sourceApi({from,to,ports}={}){
 const file=require.resolve('../lib/pgstream/pool-intake-adoption'),source=fs.readFileSync(file,'utf8');if(from)assert.equal(source.split(from).length,2,'one exact source mutation anchor');
 const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const original=m.require.bind(m);m.require=id=>ports?.[id]||original(id);m._compile(from?source.replace(from,to):source,file);return m.exports;
}
function fixture(){
 const old=oldProfile(),p=profile(),b=p.binding,previous=candidate.build({...old.binding,intakeProfile:old}),selected=require('../lib/pgstream/pool-catalogue').build(p,{predecessorProfile:old});
 const binding={namespace:'origin_outbox',checkpointNamespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,evaluatorConsumer:b.consumer+'-completed',consumer:'origin-route',retiredRoles:['old_outbox','old_ack']};
 const opts={direct:true,profile:p,predecessorProfile:old,lifetimeRole:'lifetime_reader',workers:[{role:'new_worker_zero',ordinal:0},{role:'new_worker_one',ordinal:1}],retiredRoles:['old_intake','old_worker_zero','old_worker_one'],notificationBindings:[binding]};
 const oldNotify=notification.build(Object.fromEntries(['checkpointNamespace','membershipNamespace','lifecycleNamespace','evaluatorConsumer','consumer'].map(key=>[key,binding[key]]))),checkpoint=q(b.namespace)+'.tenant_consumer_checkpoint',desired=q(b.membershipNamespace)+'.pool_desired';
 const tables={};for(const migration of require('../lib/tenant-lifecycle/postgres-candidate.json').migrations)for(const sql of migration.up){const name=/^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1];if(name)tables[q(b.lifecycleNamespace)+'.'+name]=[];}
 tables[q(b.lifecycleNamespace)+'.tenant_lifecycle_windows']=[A,B].map((tenant,index)=>({tenant_id:tenant,phase:index?'suspended':'active',generation:index?'9':'7',claim_id:null,artifact_digest:null}));
 tables[q(b.lifecycleNamespace)+'.tenant_lifecycle_restore_audit']=[{tenant_id:B,claim_id:'synthetic-claim',state:'suspended',generation:'9',artifact_digest:'f'.repeat(64)}];
 tables[checkpoint]=[A,B].map(tenant=>({tenant_id:tenant,consumer:b.consumer+'-completed',contract_digest:old.contractDigest,work_version:'2',work_owner_ordinal:String(old.assignment.owner(tenant)),work_assignment_revision:old.binding.revision,work_observed:'[9007199254740993,null,null,null,null,null]',work_completed:'[1,null,null,null,null,null]',work_observed_at:'[10,null,null,null,null,null]',work_pending_at:'10',work_due_at:'999',work_completed_at:'20',output_identity:'a'.repeat(64),output_digest:'b'.repeat(64),output_revision:'8',output_restore_generation:tenant===A?'7':'9',delivery_revision:'9',delivery_ack_revision:'7',checkpoint:'9007199254740993',projection:'[{"kind":"evaluator-work-v2","output":{"synthetic":true}}]'}));
 tables[checkpoint].push({tenant_id:A,consumer:b.consumer,contract_digest:'a'.repeat(64),work_version:'0',checkpoint:'9007199254740993',projection:'[]'});
 tables[desired]=[{pool_kind:'evaluator',members:'2',previous_members:null,slice_rule:'sha256-modulo-v1',revision:old.binding.revision,updated_at:'synthetic-old-time'}];tables[q(b.membershipNamespace)+'.pool_membership']=[{pool_kind:'evaluator',ordinal:'0',member_id:'synthetic-retired-member',lease_expires_at:'synthetic-expired-time'}];
 for(const table of notification.TABLES)tables[q(binding.namespace)+'.'+table]=[{tenant_id:A,consumer:binding.consumer,request_id:'synthetic-request',dedup_key:'synthetic-dedup',producer_id:'synthetic-producer',state:'uncertain',attempt_token:'synthetic-attempt',receipt:'synthetic-retained-ack',suppression:'synthetic-suppression'}];
 const checkSource=previous.catalogue.migrations.find(m=>m.name==='0004_evaluator_sole_intake').up[0].match(/CHECK \((.*)\)\)$/)[1];
 const histories=Object.fromEntries([[b.namespace,previous.catalogue.migrations],[b.lifecycleNamespace,domain.catalogue(old).migrations],[b.membershipNamespace,require('../migrations/candidates/postgres-pool-mutation-v1.json').migrations],[binding.namespace,oldNotify.catalogue.migrations]].map(([namespace,files])=>[namespace,files.map(({name,checksum})=>({name,checksum}))]));
 let state={tables,histories,profile:{consumer:b.consumer+'-completed',profile:old.binding,digest:old.digest,contract_digest:old.contractDigest},check:checkSource,disabled:[],grants:[],writers:{[checkpoint]:['old_intake','old_worker_zero','old_worker_one'],...Object.fromEntries(notification.TABLES.map(table=>[q(binding.namespace)+'.'+table,['old_outbox']]))},functionBodies:{assignmentBody:previous.assignmentBody,effectBody:previous.effectBody,intakeAssertBody:previous.intakeAssertBody},deleted:[],links:[],role:null,tenant:''},saved;
 const initial=copy(state),calls=[],portCalls=[],fault={owner:null,foreignWriter:false,extraEffects:false,unsafeOwner:false,unsafeFunction:false,role:false,admin:false,badProfile:false,badCheck:false,badColumns:false,badPolicy:false,corrupt:false,ddl:false,commit:null,port:false};
 const oldWorkers=[{role:'old_worker_zero',ordinal:0},{role:'old_worker_one',ordinal:1}],tenantPolicy="tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid";
 const policies=[{name:'tenant_consumer_checkpoint_isolation',command:'*',permissive:true,public:true,roles:[],using:tenantPolicy,check:tenantPolicy},...['restrict','allow'].map(kind=>({name:'pgstream_intake_'+kind,command:'*',permissive:kind==='allow',public:false,roles:[old.binding.role],using:require('../lib/pgstream/intake-grants').expression(old),check:require('../lib/pgstream/intake-grants').expression(old)})),...oldWorkers.flatMap(worker=>require('../lib/pgstream/worker-grants').build({...worker,namespace:b.namespace,membershipNamespace:b.membershipNamespace,consumer:b.consumer,assignment:old.assignment}).filter(sql=>sql.startsWith('CREATE POLICY ')).map(sql=>{const match=/CREATE POLICY ([a-z_0-9]+).* USING \((.*)\) WITH CHECK/.exec(sql);return {name:match[1],command:'*',permissive:match[1].includes('_allow_'),public:false,roles:[worker.role],using:match[2],check:match[2]};}))];
 const query=async(input,values=[])=>{
  const sql=typeof input==='string'?input:input.text;calls.push({sql,values:copy(values),role:state.role});
  if(sql==='BEGIN'){saved=copy(state);return {command:'BEGIN',rows:[]};}
  if(sql==='ROLLBACK'){if(saved)state=copy(saved);saved=null;return {command:'ROLLBACK',rows:[]};}
  if(sql==='COMMIT'){if(fault.commit==='after'){saved=null;throw new Error('SYNTHETIC_COMMIT_REPLY_LOST');}if(fault.commit==='before')throw new Error('SYNTHETIC_COMMIT_REPLY_LOST');saved=null;return {command:'COMMIT',rows:[]};}
  if(sql.startsWith('SET LOCAL ROLE ')){state.role=sql.split('"')[1];return {rows:[]};}if(sql==='RESET ROLE'){state.role=null;return {rows:[]};}
  if(sql.startsWith('SET LOCAL search_path')||sql.startsWith("SELECT set_config('lock_timeout'"))return {rows:[]};
  if(sql.startsWith("SELECT set_config('app.current_tenant_id',$1")){state.tenant=values[0];return {rows:[]};}
  if(sql.includes('/* pool-intake-adoption-admin */'))return {rows:[{principal:'bootstrap',login:'bootstrap',pid:731,rolsuper:true,rolbypassrls:true,owned:fault.admin?[]:[b.namespace,b.membershipNamespace,b.lifecycleNamespace].sort()}]};
  if(sql.includes('/* pool-intake-adoption-roles */'))return {rows:values[0].map(rolname=>({rolname,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:fault.role,owns:false}))};
  if(sql.includes('/* pool-intake-adoption-prior-locks */'))return {rows:[]};
  if(sql.includes('/* pool-intake-adoption-owner */'))return {rows:[{held:values[0]!==fault.owner}]};
  if(sql.includes('/* pool-intake-adoption-membership-lock */'))return {rows:[{held:true}]};
  if(sql.startsWith('LOCK TABLE '))return {rows:[]};
  if(sql.includes('/* pool-intake-adoption-object-owners */'))return {rows:values[0].map(value=>({relation:value.replace(/"/g,''),owner:value.split('"')[1]+'_owner',same_owner:true,ordinary:true,unsafe:fault.unsafeOwner}))};
  if(sql.includes('/* pool-intake-adoption-function-owners */'))return {rows:values[0].map(value=>({function:value,same_owner:true,unsafe:fault.unsafeFunction}))};
  if(sql.includes('/* pool-intake-adoption-profile-columns */'))return {rows:['consumer','profile','digest','contract_digest',...(fault.badColumns?['extra']:[])].map((name,index)=>({name,type:index===1?'jsonb':'text',required:true}))};
  if(sql.includes('/* pool-intake-adoption-profile-constraints */'))return {rows:[{name:'pgstream_intake_profile_check',type:'c',valid:true,deferrable:false,expression:fault.badCheck?state.check.replace(' AND ',' OR '):state.check,definition:'unused'}, {name:'pgstream_intake_profile_pkey',type:'p',valid:true,deferrable:false,expression:null,definition:'PRIMARY KEY (consumer)'}]};
  if(sql.includes('/* pool-intake-adoption-old-profile */'))return {rows:[{...copy(state.profile),...(fault.badProfile?{digest:'0'.repeat(64)}:{})}]};
  if(sql.includes('/* pool-intake-adoption-old-policies */'))return {rows:fault.badPolicy?policies.slice(0,-1):copy(policies)};
  if(sql.includes('/* pool-intake-adoption-ledger */'))return {rows:copy(state.histories[sql.split('"')[1]]).sort((a,b)=>a.name.localeCompare(b.name))};
  if(sql.includes("t.tgname='pool_mutation_protocol'"))return {rows:['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:require('../lib/pool-membership/fixed-protocol').BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}))};
  if(sql.includes('/* pool-checkpoint-provision-protocol */'))return {rows:[false,true].map(deferred=>({name:deferred?'pgstream_checkpoint_provision_commit':'pgstream_checkpoint_provision',type:deferred?5:7,enabled:'A',deferrable:deferred,deferred,arguments:0,unconditional:true,columns:'',source:state.functionBodies.provisionBody,function_name:'pgstream_checkpoint_provision_required',definer:false,config:['search_path=pg_catalog'],function_arguments:0,trigger_result:true,language:'plpgsql'}))};
  if(sql.includes('/* pool-checkpoint-provision-ledger */'))return {rows:copy(state.histories[b.namespace])};
  if(sql.includes('/* pool-checkpoint-provision-profile */'))return {rows:[copy(state.profile)]};
  if(sql.includes('t.tgname=ANY($2::text[])'))return {rows:[['pgstream_assignment_protocol',31,false,'assignmentBody','pgstream_assignment_required',candidate.ASSIGNMENT_COLUMNS],['pgstream_effect_protocol',19,false,'effectBody','pgstream_assigned_effect_required',candidate.EFFECT_COLUMNS],['pgstream_effect_commit',17,true,'effectBody','pgstream_assigned_effect_required',[]]].map(([name,type,deferred,key,function_name,columns])=>({name,type,deferred,deferrable:deferred,enabled:'A',arguments:0,unconditional:true,source:state.functionBodies[key],function_name,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog'],columns}))};
  if(sql.includes('/* intake-assert-function */'))return {rows:[{source:state.functionBodies.intakeAssertBody,definer:false,config:['search_path=pg_catalog'],arguments:0,void_result:true,executes:true,language:'plpgsql'}]};
  if(sql.includes('FROM pg_index'))return {rows:candidate.INDEXES.map(index=>({name:index.name,valid:true,ready:true,unique:false,method:'btree',predicate:index.predicate,columns:index.columns}))};
  if(sql.includes('FROM pg_trigger')&&sql.includes("'notification_partition_effect'"))throw new Error('UNEXPECTED_LITERAL_NOTIFICATION_PROTOCOL');
  if(sql.includes('cardinality(t.tgattr::smallint[])'))return {rows:notification.TABLES.flatMap(table_name=>['notification_partition_effect','notification_partition_commit'].map(name=>({table_name,name,type:name.endsWith('_commit')?29:31,enabled:'A',deferrable:name.endsWith('_commit'),deferred:name.endsWith('_commit'),arguments:0,unconditional:true,column_count:0,source:oldNotify.body,function_name:'pgstream_notification_partition',function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']})))};
  if(sql.includes('/* pool-intake-adoption-extra-effects */')||sql.includes('/* pool-intake-adoption-notification-extra-effects */'))return {rows:fault.extraEffects?[{relname:'unknown_trigger'}]:[]};
  if(sql.includes('/* pool-intake-adoption-desired */'))return {rows:[{members:2,previous_members:null,slice_rule:'sha256-modulo-v1',revision:old.binding.revision}]};
  if(sql.includes('/* pool-intake-adoption-snapshot */')){const table=/ FROM ("[a-z_]+"\.[a-z_]+) t/.exec(sql)[1];return {rows:copy(state.tables[table]).map(row=>({row}))};}
  if(sql.includes('/* pool-intake-adoption-columns */'))return {rows:['tenant_id','consumer','contract_digest','checkpoint','projection',...require('../lib/pgstream/work-state').COLUMNS,'work_owner_ordinal','work_assignment_revision'].map(attname=>({attname}))};
  if(sql.includes('/* pool-intake-adoption-notification-columns */'))return {rows:Object.keys(state.tables[values[0]][0]).map(attname=>({attname}))};
  if(sql.startsWith('REVOKE ALL PRIVILEGES ')){const match=/ ON ("[a-z_]+"\.[a-z_]+) FROM (PUBLIC|"[a-z_]+")$/.exec(sql);if(match){const role=match[2].replace(/"/g,'');state.writers[match[1]]=(state.writers[match[1]]||[]).filter(value=>value!==role);}return {rows:[]};}
  if(sql.includes('/* intake-adoption-retired-rights */'))return {rows:[...(state.writers[values[0]]||[]),...(fault.foreignWriter&&values[0]===checkpoint?['foreign_writer']:[])].map(principal=>({principal,capability:principal,can_login:true,superuser:false,authenticated:false,owns:false,writes:true}))};
  if(sql.includes('/* pool-intake-adoption-retired-definers */'))return {rows:[]};
  if(sql.startsWith('DROP POLICY '))return {rows:[]};
  if(sql.startsWith('ALTER TABLE '+checkpoint+' DISABLE TRIGGER')){state.disabled.push(sql.split('"').at(-2));return {rows:[]};}
  if(sql.startsWith('ALTER TABLE '+checkpoint+' ENABLE ALWAYS TRIGGER')){state.disabled=state.disabled.filter(value=>value!==sql.split('"').at(-2));return {rows:[]};}
  if(sql.startsWith('UPDATE '+checkpoint+' SET contract_digest=')){assert.deepEqual(state.disabled.sort(),['pgstream_effect_commit','pgstream_effect_protocol']);let rowCount=0;for(const row of state.tables[checkpoint])if(row.consumer===values[1]&&row.contract_digest===values[2]){row.contract_digest=values[0];if(fault.corrupt)row.work_pending_at='11';rowCount++;}return {rows:[],rowCount};}
  if(typeof input==='object'&&fault.ddl)throw new Error('SYNTHETIC_MIGRATION_REFUSAL');
  if(sql.startsWith('INSERT INTO "')&&sql.includes('.schema_migrations')){state.histories[sql.split('"')[1]].push({name:values[0],checksum:values[1]});return {rows:[],rowCount:1};}
  if(sql.startsWith('ALTER TABLE pool_desired ADD COLUMN partitioned')){state.tables[desired].forEach(row=>{row.partitioned='true';});return {rows:[]};}
  if(sql.startsWith('ALTER TABLE pool_desired ADD COLUMN previous_partitioned')){state.tables[desired].forEach(row=>{row.previous_partitioned=null;});return {rows:[]};}
  if(sql.startsWith('UPDATE pool_desired SET previous_partitioned=')){state.tables[desired].forEach(row=>{if(row.previous_members!==null)row.previous_partitioned='true';});return {rows:[]};}
  if(sql.startsWith('UPDATE pgstream_intake_profile SET profile=')){assert(sql.includes(old.digest)&&sql.includes(p.digest));state.profile={consumer:b.consumer+'-completed',profile:p.binding,digest:p.digest,contract_digest:p.contractDigest};return {rows:[],rowCount:1};}
  if(sql.startsWith('ALTER TABLE pgstream_intake_profile ADD CONSTRAINT')){state.check=sql.slice(sql.indexOf('CHECK (')+7,-1);return {rows:[]};}
  if(sql.startsWith('CREATE OR REPLACE FUNCTION pgstream_assignment_required')){const tag=/ AS (\$[a-z_]+\$)/.exec(sql)[1];state.functionBodies.assignmentBody=sql.split(tag)[1];return {rows:[]};}
  if(sql.startsWith('CREATE OR REPLACE FUNCTION pgstream_assigned_effect_required')){const tag=/ AS (\$[a-z_]+\$)/.exec(sql)[1];state.functionBodies.effectBody=sql.split(tag)[1];return {rows:[]};}
  if(sql.startsWith('CREATE OR REPLACE FUNCTION pgstream_intake_assert')){const tag=/ AS (\$[a-z_]+\$)/.exec(sql)[1];state.functionBodies.intakeAssertBody=sql.split(tag)[1];return {rows:[]};}
  if(/^(CREATE|CREATE OR REPLACE) FUNCTION pgstream_checkpoint_provision_required/.test(sql)){const tag=/ AS (\$[a-z_]+\$)/.exec(sql)[1];state.functionBodies.provisionBody=sql.split(tag)[1];return {rows:[]};}
  if(sql.startsWith('GRANT ')||sql.startsWith('CREATE POLICY ')){state.grants.push(sql);return {rows:[]};}
  if(/^(CREATE |ALTER TABLE |REVOKE ALL ON |REVOKE EXECUTE ON |DROP FUNCTION )/.test(sql))return {rows:[]};
  if(sql.includes('/* pool-lifecycle-authority */')){assert.equal(state.tenant,values[0]);const row=state.tables[q(b.lifecycleNamespace)+'.tenant_lifecycle_windows'].find(value=>value.tenant_id===values[0]);return {rows:row?[{tenant:row.tenant_id,bound:true,generation:row.generation,phase:row.phase,deletion:state.deleted.includes(row.tenant_id)}]:[]};}
  if(sql.includes('/* pool-intake-adoption-new-links */'))return {rows:[{count:String(state.links.length)}]};
  throw new Error('UNEXPECTED_ADOPTION_SQL '+sql.slice(0,110));
 };
 function port(kind,expected){portCalls.push({kind,role:state.role,expected});if(fault.port)throw new Error('SYNTHETIC_READINESS_REFUSAL');}
 const actualIntake=require('../lib/pgstream/intake-grants'),actualWorker=require('../lib/pgstream/worker-grants'),poolIntake=require('../lib/pgstream/pool-intake-grants'),poolWorker=require('../lib/pgstream/pool-worker-grants'),poolOperator=require('../lib/pgstream/pool-operator-grants');
 const assertPlans=(kind,plans)=>{port(kind);for(const statement of plans)assert(state.grants.includes(statement),'SOURCE_GRANT_PLAN_EXECUTED: '+kind);};
 const ports={
  './assignment-protocol':{assertInstalled:async(query,value)=>{port('assignment',value);return require('../lib/pgstream/assignment-protocol').assertInstalled(query,value);}},
  './intake-grants':{...actualIntake,assertReady:async(_query,value)=>{port('old-intake');assert.equal(value.digest,old.digest);assert.equal(state.role,old.binding.role);}},
  './worker-grants':{...actualWorker,assertReady:async(_query,value)=>{port('old-worker',value);assert.equal(state.role,oldWorkers[value.ordinal].role);}},
  './pool-intake-grants':{...poolIntake,assertReady:async(_query,value)=>{assert.equal(state.role,p.binding.role);assertPlans('new-intake',poolIntake.build(value));}},
  './pool-worker-grants':{...poolWorker,assertReady:async(_query,value)=>{const worker=opts.workers[value.ordinal];assert.equal(state.role,worker.role);assertPlans('new-worker',poolWorker.build({role:worker.role,profile:p,ordinal:worker.ordinal}));}},
  './pool-operator-grants':{...poolOperator,assertReady:async()=>{assert.equal(state.role,p.binding.operatorRole);assertPlans('new-operator',poolOperator.build({role:p.binding.operatorRole,profile:p}));}},
  '../tenant-lifecycle/operation-window-readiness':{admit:async(_client,namespace,value)=>{port('lifecycle',value);assert.equal(namespace,b.lifecycleNamespace);assert.equal(state.role,opts.lifetimeRole);assert.equal(value.lifetime,true);const expected=domain.catalogue(value.intakeProfile).migrations.map(({name,checksum})=>({name,checksum}));assert.deepEqual(state.histories[b.lifecycleNamespace],expected);return Object.freeze({sourcePort:true});}}
 };
 return {old,p,b,opts,checkpoint,desired,previous,selected,binding,ports,calls,portCalls,fault,client:{query,processID:731},initial,state:()=>state,api:sourceApi({ports})};
}
describe('selected-v1 to v2 historical catalogue/provenance source',()=>{
 it('preserves every v1 migration and fresh v2 body while replacing only the origin-specific metadata migration',()=>{
  const f=fixture(),base=fresh(f.p),saved=copy(base),built=adoption.extendCatalogue({base,profile:f.p,predecessorProfile:f.old});assert.deepEqual(base,saved);assert.deepEqual(built.catalogue.migrations.slice(0,f.previous.catalogue.migrations.length),f.previous.catalogue.migrations);
  for(const name of ['0006_evaluator_pool_assignment_v2','0007_scope_assignment_lifecycle_reads','0009_evaluator_pool_checkpoint_provision']){const actual=built.catalogue.migrations.find(m=>m.name===name),expected=base.catalogue.migrations.find(m=>m.name===name);assert(actual&&expected,name);assert.deepEqual(actual,expected);}
  const migration=built.catalogue.migrations.find(m=>m.name===adoption.ORIGIN_MIGRATION);assert(migration);assert(!migration.up.some(sql=>sql.startsWith('CREATE TABLE')));assert(migration.up.some(sql=>sql.startsWith('UPDATE pgstream_intake_profile')));assert(migration.up.some(sql=>sql.startsWith('CREATE OR REPLACE FUNCTION pgstream_intake_assert')));assert.deepEqual(f.p.binding,profile().binding);assert(!Object.hasOwn(f.p.binding,'tenants'));assert(!Object.hasOwn(f.p.binding,'predecessorProfile'));catalogue.validateCatalogue(built.catalogue);
 });
 it('recognizes only the four constant-AND CHECK with literal-preserving JSONB normalization',()=>{
  const f=fixture(),source=f.previous.catalogue.migrations.find(m=>m.name==='0004_evaluator_sole_intake').up[0].match(/CHECK \((.*)\)\)$/)[1],reference=adoption.constantCheck(source);
  assert.equal(adoption.constantCheck('('+source.replaceAll(' AND ',') AND (')+')'),reference);assert.equal(adoption.constantCheck(source.replace("consumer='", "consumer = '").replace(" AND profile=",' AND profile = ')),reference);
  for(const broken of [source.replace(' AND ',' OR '),source+' AND true',source+'(',')'+source,source.replace('consumer=','current_user='),source.replace('::jsonb','::text'),source.replace(f.old.digest,'0'.repeat(64))])assert.notEqual((()=>{try{return adoption.constantCheck(broken);}catch{return 'REFUSED';}})(),reference);
 });
 it('requires explicit distinct roles, complete source-bound notification scopes and physical direct-client options',()=>{
  const f=fixture(),o=adoption.options(f.opts);assert.equal(o.predecessorProfile.digest,f.old.digest);assert.equal(o.notificationBindings.length,1);assert.equal(adoption.ownerKeys(o).length,5);
  for(const patch of [{direct:false},{predecessorProfile:undefined},{notificationBindings:[]},{notificationBindings:[{...f.binding,evaluatorConsumer:'evaluator-other-completed'}]},{workers:[{role:'old_worker_zero',ordinal:0},{role:'new_worker_one',ordinal:1}]},{readAuthority:()=>({eligibility:'active'})}])assert.throws(()=>adoption.options({...f.opts,...patch}));
 });
});
describe('explicit ADMIN selected-v1 to v2 command/rollback source model',()=>{
 it('quiesces actual declared intake/clinical/outbox keys before table locks and preserves all state except selected digest and added placement columns',async()=>{
  const f=fixture(),out=await f.api.adopt(f.client,f.opts);assert.equal(out.commitOutcome,'committed');assert.equal(out.predecessorProfile,f.old.digest);assert.equal(out.notificationScopes,1);assert(out.scope.includes('NOT_NOTIFICATION_LEDGER_ADOPTION'));
  const held=f.calls.filter(call=>call.sql.includes('/* pool-intake-adoption-owner */')).map(call=>call.values[0]);assert.deepEqual(held,adoption.ownerKeys(adoption.options(f.opts)));assert.equal(held.length,5);const lock=f.calls.findIndex(call=>call.sql.startsWith('LOCK TABLE '));assert(lock>f.calls.findIndex(call=>call.sql.includes('pool-intake-adoption-membership-lock')));assert(f.calls[lock].sql.includes('tenant_notification_requests'));assert(f.calls[lock].sql.includes('pool_membership'));
  const expected=copy(f.initial.tables);for(const row of expected[f.checkpoint])if(row.consumer===f.b.consumer+'-completed')row.contract_digest=f.p.contractDigest;for(const row of expected[f.desired]){row.partitioned='true';row.previous_partitioned=null;}assert.deepEqual(f.state().tables,expected);assert.deepEqual(f.state().disabled,[]);assert.equal(f.state().profile.digest,f.p.digest);assert.equal(f.calls.at(-1).sql,'COMMIT');assert.equal(f.calls.filter(call=>call.sql==='COMMIT').length,1);assert(f.portCalls.some(call=>call.kind==='new-operator'));assert(f.portCalls.some(call=>call.kind==='old-worker'));
 });
 it('uses current positive deleted authority for absent checkpoint instead of turning predecessor roster into current authority',async()=>{
  const f=fixture();f.state().tables[q(f.b.lifecycleNamespace)+'.tenant_lifecycle_windows'].push({tenant_id:D,phase:'suspended',generation:'11',claim_id:null,artifact_digest:null});f.state().deleted.push(D);await f.api.adopt(f.client,f.opts);assert(!f.state().tables[f.checkpoint].some(row=>row.tenant_id===D));assert(f.calls.some(call=>call.sql.includes('pool-lifecycle-authority')&&call.values[0]===D));
  const active=fixture();active.state().tables[q(active.b.lifecycleNamespace)+'.tenant_lifecycle_windows'].push({tenant_id:D,phase:'active',generation:'11',claim_id:null,artifact_digest:null});const before=copy(active.state());await assert.rejects(active.api.adopt(active.client,active.opts),/RETAINED_CONTRACT/);assert.deepEqual(active.state(),before);
 });
 it('refuses actual outbox-owner conflict, unknown triggers, unknown ledger/profile/CHECK or unsafe roles/functions before disabling effects',async()=>{
  for(const mode of ['outbox','extraEffects','unsafeOwner','unsafeFunction','role','admin','badProfile','badCheck','badColumns','badPolicy','history']){
   const f=fixture();if(mode==='outbox')f.fault.owner=adoption.ownerKeys(adoption.options(f.opts)).at(-1);else if(mode==='history')f.state().histories[f.b.namespace].push({name:'0999_unknown',checksum:'0'.repeat(64)});else f.fault[mode]=true;const before=copy(f.state());await assert.rejects(f.api.adopt(f.client,f.opts));assert.deepEqual(f.state(),before,mode);assert(!f.calls.some(call=>call.sql.includes(' DISABLE TRIGGER ')),mode);
  }
 });
 it('rolls back exact prefix, metadata, digest, ACL and all retained data on DDL, foreign-writer, preservation or readiness refusal',async()=>{
  for(const mode of ['ddl','foreignWriter','corrupt','port']){const f=fixture();f.fault[mode]=true;const before=copy(f.state());await assert.rejects(f.api.adopt(f.client,f.opts));assert.deepEqual(f.state(),before,mode);assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert(!f.calls.some(call=>call.sql==='COMMIT'));}
 });
 it('reports lost COMMIT reply as uncertain for both modeled server outcomes without reporting adoption success',async()=>{
  for(const mode of ['before','after']){const f=fixture();f.fault.commit=mode;await assert.rejects(f.api.adopt(f.client,f.opts),error=>error.message==='SYNTHETIC_COMMIT_REPLY_LOST'&&error.commitOutcome==='uncertain');assert.equal(f.state().profile.digest,mode==='after'?f.p.digest:f.old.digest);}
 });
 it('meaningful source omissions: owner conflict, foreign writer and retained-state refusal each go RED then restored GREEN',async()=>{
  const controls=[{from:"if(rows.length!==1||rows[0].held!==true)throw fail('PGSTREAM_ADOPTION_OWNER_ACTIVE');",to:'',fault:f=>{f.fault.owner=adoption.ownerKeys(adoption.options(f.opts)).at(-1);},pattern:/OWNER_ACTIVE/},{from:"if(remaining.length)throw fail('PGSTREAM_ADOPTION_WRITERS_REMAIN');",to:'',fault:f=>{f.fault.foreignWriter=true;},pattern:/WRITERS_REMAIN/},{from:'retained(before,await snapshot(query,o),p);',to:'',fault:f=>{f.fault.corrupt=true;},pattern:/RETAINED_STATE/}];
  for(const control of controls){const qualify=async broken=>{const f=fixture();control.fault(f);const api=sourceApi({...broken,ports:f.ports});await assert.rejects(api.adopt(f.client,f.opts),control.pattern);};await qualify();await assert.rejects(qualify(control),{code:'ERR_ASSERTION'});await qualify();}
 });
 it('control: treating OR as AND in the actual bounded CHECK parser makes unknown old source refusal RED then restored GREEN',async()=>{
  const qualify=async change=>{const f=fixture();f.fault.badCheck=true;await assert.rejects(sourceApi({...change,ports:f.ports}).adopt(f.client,f.opts),/PROFILE_CHECK/);};
  const from="if(field!==PROFILE_COLUMNS.at(-1)&&tokens[at++]?.value!=='and')throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');",to='if(field!==PROFILE_COLUMNS.at(-1))at++;';await qualify();await assert.rejects(qualify({from,to}),{code:'ERR_ASSERTION'});await qualify();
 });
});

describe('actual adoption-to-assignment protocol provenance composition',()=>{
 it('passes the retained historical ledger through real protocol/provision admission; omission is RED and restored is GREEN',async()=>{
  const omitted=fixture(),broken=sourceApi({ports:omitted.ports,from:'poolProfile:p,poolIntake:true,predecessorProfile:old,requireIntakeExecute:false',to:'poolProfile:p,poolIntake:true,requireIntakeExecute:false'});
  await assert.rejects(broken.adopt(omitted.client,omitted.opts),/PGSTREAM_POOL_PROVISION_LEDGER/);assert.deepEqual(omitted.state(),omitted.initial);
  const restored=fixture();assert.equal((await restored.api.adopt(restored.client,restored.opts)).commitOutcome,'committed');
  assert(restored.calls.some(call=>call.sql.includes('pool-checkpoint-provision-ledger')));assert(restored.calls.some(call=>call.sql.includes('intake-assert-function')));
 });
});
