'use strict';
// Explicit offline ADMIN cutover. Predecessor values regenerate historical
// source only; current tenant/assignment authority is read from the database.
const profiles=require('./pool-intake-profile'),legacyProfiles=require('./intake-profile');
const {createHash}=require('node:crypto');
const catalogue=require('../migrations/catalogue'),domain=require('../tenant-lifecycle/generation-domain');
const {canonical}=require('../server/serve/evaluator-runtime');
const q=value=>'"'+value+'"',literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
const fail=code=>Object.assign(new Error(code),{code});
const PROFILE_COLUMNS=Object.freeze(['consumer','profile','digest','contract_digest']);
const PROFILE_CHECK='pgstream_intake_profile_check',ORIGIN_MIGRATION='0008_evaluator_pool_intake_from_selected_v1';
const EFFECTS=Object.freeze(['pgstream_assignment_protocol','pgstream_effect_protocol','pgstream_effect_commit']);
const OPTION_FIELDS=Object.freeze(['direct','profile','predecessorProfile','lifetimeRole','workers','retiredRoles','notificationBindings','registryNamespace','lockTimeoutMs','statementTimeoutMs','connectionString']);
const legacyLifecycle=require('../tenant-lifecycle/postgres-candidate.json');
const lifecycleTables=Object.freeze([...new Set(legacyLifecycle.migrations.flatMap(m=>m.up.map(sql=>/^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1]).filter(Boolean)))].sort());
function binding(profile,predecessorProfile){
 const p=profiles.validate(profile),old=legacyProfiles.validate(predecessorProfile),b=p.binding,previous=old.binding;
 if(['namespace','membershipNamespace','lifecycleNamespace','consumer','codec','generationDomain'].some(key=>b[key]!==previous[key]))throw fail('PGSTREAM_POOL_ADOPTION_BINDING');return {profile:p,predecessorProfile:old};
}
function fresh(value){
 const b=value.binding,legacy=require('./assignment-candidate').build(b),assignment=require('./pool-assignment-candidate').build({base:legacy,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,operatorRole:b.operatorRole});
 const intake=require('./pool-intake-candidate').build({base:assignment,intakeProfile:value});return require('./pool-checkpoint-provision-candidate').build({base:intake,intakeProfile:value});
}
function profileCheck(migration){const statement=migration.up.find(sql=>sql.startsWith('CREATE TABLE pgstream_intake_profile ')),match=statement&&/CHECK \((.*)\)\)$/.exec(statement);if(!match)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_SOURCE');return match[1];}
function extendCatalogue({base,profile,predecessorProfile}){
 const pair=binding(profile,predecessorProfile),p=pair.profile,old=pair.predecessorProfile,b=p.binding,expected=fresh(p);
 if(!base||canonical(base.catalogue)!==canonical(expected.catalogue)||base.effectBody!==expected.effectBody||base.assignmentBody!==expected.assignmentBody||base.intakeAssertBody!==expected.intakeAssertBody||base.provisionBody!==expected.provisionBody)throw fail('PGSTREAM_POOL_ADOPTION_FRESH_SOURCE');
 const previous=require('./assignment-candidate').build({...old.binding,intakeProfile:old});
 const original=expected.catalogue.migrations.find(m=>m.name==='0008_evaluator_pool_intake');if(!original||original.up.length!==7)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_SOURCE');
 const up=[
  'ALTER TABLE pgstream_intake_profile DROP CONSTRAINT '+PROFILE_CHECK,
  'UPDATE pgstream_intake_profile SET profile='+literal(JSON.stringify(b))+'::jsonb,digest='+literal(p.digest)+',contract_digest='+literal(p.contractDigest)+' WHERE consumer='+literal(b.consumer+'-completed')+' AND profile='+literal(JSON.stringify(old.binding))+'::jsonb AND digest='+literal(old.digest)+' AND contract_digest='+literal(old.contractDigest),
  'ALTER TABLE pgstream_intake_profile ADD CONSTRAINT '+PROFILE_CHECK+' CHECK ('+profileCheck(original)+')',
  ...original.up.slice(3).map(sql=>sql.startsWith('CREATE FUNCTION pgstream_intake_assert()')?sql.replace('CREATE FUNCTION ','CREATE OR REPLACE FUNCTION '):sql)
 ];
 const replacement={name:ORIGIN_MIGRATION,up,checksum:catalogue.checksum(up)},tail=expected.catalogue.migrations.filter(m=>m.name>='0006').map(m=>m===original?replacement:m);
 const result={...expected,predecessorProfile:old,catalogue:{version:1,migrations:[...previous.catalogue.migrations,...tail]}};catalogue.validateCatalogue(result.catalogue);return result;
}
// Only the generated four-column constant AND expression is recognized.
// Parentheses/::text deparsing and JSONB key order are immaterial; every literal,
// field, type and operator is retained. Functions, OR and unknown grammar refuse.
function constantCheck(source){
 if(typeof source!=='string'||source.length>32768)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');
 const tokens=[];let offset=0,depth=0;
 while(offset<source.length){const rest=source.slice(offset);let match;
  if((match=/^\s+/.exec(rest))){offset+=match[0].length;continue;}
  if(rest[0]==='('){if(++depth>32)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');offset++;continue;}if(rest[0]===')'){if(--depth<0)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');offset++;continue;}
  if(rest[0]==="'"){let value='',at=1,closed=false;for(;at<rest.length;at++){if(rest[at]==="'"){if(rest[at+1]==="'"){value+="'";at++;}else{closed=true;at++;break;}}else{if(rest[at]==='\\'||rest.charCodeAt(at)===0)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');value+=rest[at];}}if(!closed)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');tokens.push({kind:'literal',value});offset+=at;continue;}
  if((match=/^(::|=|[a-z_][a-z_0-9]*)/i.exec(rest))){tokens.push({kind:'token',value:match[0].toLowerCase()});offset+=match[0].length;continue;}throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');
 }
 if(depth!==0)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');let at=0;const result=[];
 for(const field of PROFILE_COLUMNS){if(tokens[at++]?.value!==field||tokens[at++]?.value!=='=')throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');const value=tokens[at++];if(value?.kind!=='literal')throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');const type=field==='profile'?'jsonb':'text';if(tokens[at]?.value==='::'){at++;if(tokens[at++]?.value!==type)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');}else if(type==='jsonb')throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');let owned=value.value;if(type==='jsonb')try{owned=JSON.parse(owned);}catch{throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');}result.push([field,type,owned]);if(field!==PROFILE_COLUMNS.at(-1)&&tokens[at++]?.value!=='and')throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');}
 if(at!==tokens.length)throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');return canonical(result);
}
function options(input){
 if(!input||typeof input!=='object'||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!OPTION_FIELDS.includes(key)))throw fail('PGSTREAM_POOL_ADOPTION_OPTIONS');input=Object.fromEntries(OPTION_FIELDS.map(key=>[key,input[key]]));if(input.direct!==true)throw fail('PGSTREAM_ADOPTION_DIRECT_REQUIRED');
 const ownedArray=(source,maximum,copy)=>{if(!Array.isArray(source)||!Number.isSafeInteger(source.length)||source.length>maximum)throw fail('PGSTREAM_POOL_ADOPTION_OPTIONS');const result=new Array(source.length);for(let i=0;i<result.length;i++)result[i]=copy(source[i]);return result;};
 input.workers=ownedArray(input.workers,1024,value=>{if(!value||Object.keys(value).sort().join(',')!=='ordinal,role')throw fail('PGSTREAM_ADOPTION_ROLES');return {role:value.role,ordinal:value.ordinal};});
 input.retiredRoles=ownedArray(input.retiredRoles,256,value=>value);if(new Set(input.retiredRoles).size!==input.retiredRoles.length)throw fail('PGSTREAM_ADOPTION_ROLES');
 input.notificationBindings=ownedArray(input.notificationBindings,32,value=>{const fields=['checkpointNamespace','consumer','evaluatorConsumer','lifecycleNamespace','membershipNamespace','namespace','retiredRoles'];if(!value||Object.keys(value).sort().join(',')!==fields.join(','))throw fail('PGSTREAM_POOL_ADOPTION_NOTIFICATIONS');const copy=Object.fromEntries(fields.map(key=>[key,value[key]]));copy.retiredRoles=ownedArray(copy.retiredRoles,256,role=>role);return copy;});
 const pair=binding(input.profile,input.predecessorProfile),p=pair.profile,old=pair.predecessorProfile;
 if(!Array.isArray(input.workers)||input.workers.length!==old.binding.members||input.workers.some((worker,index)=>!worker||worker.ordinal!==index)||!Array.isArray(input.retiredRoles)||!input.retiredRoles.includes(old.binding.role)||!input.retiredRoles.length)throw fail('PGSTREAM_ADOPTION_ROLES');
 const notificationCandidate=require('../tenant-notifications/partition-candidate');
 if(!Array.isArray(input.notificationBindings)||!input.notificationBindings.length||input.notificationBindings.length>32)throw fail('PGSTREAM_POOL_ADOPTION_NOTIFICATIONS');
 const notificationBindings=input.notificationBindings.map(value=>{
  if(!value||Object.keys(value).sort().join(',')!=='checkpointNamespace,consumer,evaluatorConsumer,lifecycleNamespace,membershipNamespace,namespace,retiredRoles'||!legacyProfiles.name(value.namespace)||[p.binding.namespace,p.binding.membershipNamespace,p.binding.lifecycleNamespace].includes(value.namespace)||!Array.isArray(value.retiredRoles)||!value.retiredRoles.length||value.retiredRoles.some(role=>!legacyProfiles.name(role))||new Set(value.retiredRoles).size!==value.retiredRoles.length)throw fail('PGSTREAM_POOL_ADOPTION_NOTIFICATIONS');
  const binding=notificationCandidate.bindings(Object.fromEntries(['checkpointNamespace','consumer','evaluatorConsumer','lifecycleNamespace','membershipNamespace'].map(key=>[key,value[key]])));
  if(binding.checkpointNamespace!==p.binding.namespace||binding.membershipNamespace!==p.binding.membershipNamespace||binding.lifecycleNamespace!==p.binding.lifecycleNamespace||binding.evaluatorConsumer!==p.binding.consumer+'-completed')throw fail('PGSTREAM_POOL_ADOPTION_NOTIFICATIONS');
  return Object.freeze({...binding,namespace:value.namespace,retiredRoles:Object.freeze([...value.retiredRoles])});
 });
 if(new Set(notificationBindings.map(value=>value.namespace)).size!==notificationBindings.length)throw fail('PGSTREAM_POOL_ADOPTION_NOTIFICATIONS');
 const retiredRoles=[...new Set([...input.retiredRoles,...notificationBindings.flatMap(value=>value.retiredRoles)])],names=[p.binding.role,p.binding.operatorRole,input.lifetimeRole,...input.workers.map(worker=>worker.role),...retiredRoles];if(names.some(value=>!legacyProfiles.name(value))||new Set(names).size!==names.length)throw fail('PGSTREAM_ADOPTION_ROLES');
 const lockTimeoutMs=input.lockTimeoutMs??2000,statementTimeoutMs=input.statementTimeoutMs??10000;if(!Number.isSafeInteger(lockTimeoutMs)||lockTimeoutMs<1||lockTimeoutMs>600000||!Number.isSafeInteger(statementTimeoutMs)||statementTimeoutMs<lockTimeoutMs||statementTimeoutMs>600000)throw fail('PGSTREAM_ADOPTION_TIMEOUT');
 if(input.registryNamespace!==undefined&&(!legacyProfiles.name(input.registryNamespace)||[p.binding.namespace,p.binding.membershipNamespace,p.binding.lifecycleNamespace,...notificationBindings.map(value=>value.namespace)].includes(input.registryNamespace)))throw fail('PGSTREAM_ADOPTION_REGISTRY');
 return Object.freeze({...pair,lifetimeRole:input.lifetimeRole,workers:Object.freeze(input.workers.map(worker=>Object.freeze({role:worker.role,ordinal:worker.ordinal}))),retiredRoles:Object.freeze(retiredRoles),notificationBindings:Object.freeze(notificationBindings),registryNamespace:input.registryNamespace,lockTimeoutMs,statementTimeoutMs});
}
function notificationBinding(value){return Object.fromEntries(['checkpointNamespace','consumer','evaluatorConsumer','lifecycleNamespace','membershipNamespace'].map(key=>[key,value[key]]));}
function ownerKeys(o){
 const keys=require('./intake-adoption').ownerKeys(o.predecessorProfile),notification=require('../tenant-notifications/partition-candidate');
 for(const binding of o.notificationBindings)for(let ordinal=0;ordinal<o.predecessorProfile.binding.members;ordinal++)keys.push(createHash('sha256').update(notification.OWNER_DOMAIN+binding.namespace+':'+binding.consumer+':'+ordinal).digest().readBigInt64BE(0).toString());return Object.freeze([...new Set(keys)]);
}
async function ledger(query,namespace,files){const rows=(await query('SELECT /* pool-intake-adoption-ledger */ name,checksum FROM '+q(namespace)+'.schema_migrations ORDER BY name COLLATE "C"')).rows;if(canonical(rows)!==canonical(catalogue.validateCatalogue({version:1,migrations:files}).map(({name,checksum})=>({name,checksum}))))throw fail('PGSTREAM_ADOPTION_HISTORY');}
async function asRole(query,role,fn){await query('SET LOCAL ROLE '+q(role));const result=await fn();await query('RESET ROLE');return result;}
async function migrate(query,namespace,migration){await query('SET LOCAL search_path TO '+q(namespace)+', pg_catalog');for(const text of catalogue.renderMigration(migration,namespace))await query({text,queryMode:'extended'});await query('INSERT INTO '+q(namespace)+'.schema_migrations (name,checksum) VALUES ($1,$2)',[migration.name,migration.checksum]);await query('SET LOCAL search_path TO pg_catalog');}
async function safeRoles(query,o){
 const b=o.profile.binding,wanted=[b.role,b.operatorRole,o.lifetimeRole,...o.workers.map(worker=>worker.role),...o.retiredRoles];
 const rows=(await query(`SELECT /* pool-intake-adoption-roles */ rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit,
 EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) AS memberships,
 EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY($2::text[]) AND pg_has_role(r.oid,n.nspowner,'MEMBER')) AS owns
 FROM pg_roles r WHERE rolname=ANY($1::text[])`,[wanted,[b.namespace,b.membershipNamespace,b.lifecycleNamespace,...o.notificationBindings.map(value=>value.namespace)]])).rows;
 if(rows.length!==wanted.length||new Set(rows.map(row=>row.rolname)).size!==wanted.length||rows.some(row=>!wanted.includes(row.rolname)||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit','memberships','owns'].some(key=>row[key]!==false)))throw fail('PGSTREAM_ADOPTION_ROLE_AUTHORITY');
}
async function safeObjects(query,tables){
 const rows=(await query(`SELECT /* pool-intake-adoption-object-owners */ n.nspname||'.'||c.relname AS relation,o.rolname AS owner,
 c.relowner=n.nspowner AS same_owner,c.relkind='r' AND c.relpersistence='p' AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS ordinary,
 o.rolcanlogin OR o.rolsuper OR o.rolbypassrls OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication AS unsafe
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=ANY($1::regclass[])`,[tables])).rows;
 const wanted=tables.map(value=>value.replace(/"/g,''));if(rows.length!==wanted.length||new Set(rows.map(row=>row.relation)).size!==wanted.length||rows.some(row=>!wanted.includes(row.relation)||row.same_owner!==true||row.ordinary!==true||row.unsafe!==false||!legacyProfiles.name(row.owner)))throw fail('PGSTREAM_ADOPTION_OBJECT_OWNER');return new Map(rows.map(row=>[row.relation.split('.')[0],row.owner]));
}
async function safeFunctions(query,o){
 const b=o.profile.binding,wanted=[...['pgstream_assignment_required','pgstream_assigned_effect_required','pgstream_intake_assert'].map(name=>b.namespace+'.'+name),b.membershipNamespace+'.pool_mutation_lock_required',...o.notificationBindings.map(value=>value.namespace+'.pgstream_notification_partition')];
 const rows=(await query(`SELECT /* pool-intake-adoption-function-owners */ n.nspname||'.'||p.proname AS function,p.proowner=n.nspowner AS same_owner,
 o.rolcanlogin OR o.rolsuper OR o.rolbypassrls OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication AS unsafe
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles o ON o.oid=p.proowner WHERE n.nspname||'.'||p.proname=ANY($1::text[])`,[wanted])).rows;
 if(rows.length!==wanted.length||new Set(rows.map(row=>row.function)).size!==wanted.length||rows.some(row=>!wanted.includes(row.function)||row.same_owner!==true||row.unsafe!==false))throw fail('PGSTREAM_POOL_ADOPTION_FUNCTION_OWNER');
}
async function predecessorReady(query,o){
 const p=o.predecessorProfile,b=p.binding,table=q(b.namespace)+'.pgstream_intake_profile';
 const columns=(await query('SELECT /* pool-intake-adoption-profile-columns */ attname AS name,format_type(atttypid,atttypmod) AS type,attnotnull AS required FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',[table])).rows;
 if(canonical(columns)!==canonical(PROFILE_COLUMNS.map((name,index)=>({name,type:index===1?'jsonb':'text',required:true}))))throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_COLUMNS');
 const constraints=(await query('SELECT /* pool-intake-adoption-profile-constraints */ conname AS name,contype AS type,convalidated AS valid,condeferrable AS deferrable,pg_get_expr(conbin,conrelid) AS expression,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname',[table])).rows;
 const check=constraints.filter(row=>row.type==='c'),primary=constraints.filter(row=>row.type==='p'),expected=require('./assignment-candidate').build({...b,intakeProfile:p});
 if(constraints.length!==2||check.length!==1||check[0].name!==PROFILE_CHECK||check[0].valid!==true||check[0].deferrable!==false||constantCheck(check[0].expression)!==constantCheck(profileCheck(expected.catalogue.migrations.find(m=>m.name==='0004_evaluator_sole_intake')))||primary.length!==1||primary[0].name!=='pgstream_intake_profile_pkey'||primary[0].valid!==true||primary[0].deferrable!==false||primary[0].definition!=='PRIMARY KEY (consumer)')throw fail('PGSTREAM_POOL_ADOPTION_PROFILE_CHECK');
 const rows=(await query('SELECT /* pool-intake-adoption-old-profile */ consumer,profile,digest,contract_digest FROM '+table)).rows;
 if(rows.length!==1||rows[0].consumer!==b.consumer+'-completed'||rows[0].digest!==p.digest||rows[0].contract_digest!==p.contractDigest||canonical(rows[0].profile)!==canonical(p.binding))throw fail('PGSTREAM_POOL_ADOPTION_OLD_PROFILE');
 await require('./assignment-protocol').assertInstalled(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,intakeProfile:p,requireIntakeExecute:false});
 await asRole(query,b.role,()=>require('./intake-grants').assertReady(query,p));
 return expected;
}
async function oldPolicies(query,o){
 const p=o.predecessorProfile,b=p.binding,rows=(await query(`SELECT /* pool-intake-adoption-old-policies */ p.polname AS name,p.polcmd AS command,p.polpermissive AS permissive,
 ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid=ANY(p.polroles) ORDER BY r.rolname) AS roles,p.polroles=ARRAY[0::oid] AS public,
 pg_get_expr(p.polqual,p.polrelid) AS "using",pg_get_expr(p.polwithcheck,p.polrelid) AS "check" FROM pg_policy p WHERE p.polrelid=$1::regclass`,[q(b.namespace)+'.tenant_consumer_checkpoint'])).rows;
 const normal=value=>typeof value==='string'?value.replace(/[\s()]/g,''):null,tenant="tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid",publicRows=rows.filter(row=>row.name==='tenant_consumer_checkpoint_isolation');
 const canonicalPolicy=require('../tenant-lifecycle/catalogue-structure');if(publicRows.length!==1||publicRows[0].command!=='*'||publicRows[0].permissive!==true||publicRows[0].public!==true||canonicalPolicy(publicRows[0].using,b.namespace)!==canonicalPolicy(tenant,b.namespace)||canonicalPolicy(publicRows[0].check,b.namespace)!==canonicalPolicy(tenant,b.namespace))throw fail('PGSTREAM_ADOPTION_PUBLIC_POLICY');
 const selected=rows.filter(row=>row.name!=='tenant_consumer_checkpoint_isolation'),seen=new Set(),workerRoles=new Map();
 for(const row of selected){
  let expression,principal,permissive;const intake=/^pgstream_intake_(restrict|allow)$/.exec(row.name),worker=/^pgstream_worker_(restrict|allow)_([01])$/.exec(row.name);
  if(intake){expression=require('./intake-grants').expression(p);principal=b.role;permissive=intake[1]==='allow';}
  else if(worker&&Number(worker[2])<b.members&&Array.isArray(row.roles)&&row.roles.length===1&&o.retiredRoles.includes(row.roles[0])){const ordinal=Number(worker[2]);principal=row.roles[0];if(workerRoles.has(ordinal)&&workerRoles.get(ordinal)!==principal)throw fail('PGSTREAM_ADOPTION_OLD_POLICY');workerRoles.set(ordinal,principal);permissive=worker[1]==='allow';const statement=require('./worker-grants').build({role:principal,ordinal,namespace:b.namespace,membershipNamespace:b.membershipNamespace,consumer:b.consumer,assignment:p.assignment}).find(text=>text.startsWith('CREATE POLICY '+row.name+' '));expression=/ USING \((.*)\) WITH CHECK/.exec(statement)[1];}
  else throw fail('PGSTREAM_ADOPTION_OLD_POLICY');
  if(seen.has(row.name)||row.command!=='*'||row.permissive!==permissive||row.public!==false||!Array.isArray(row.roles)||row.roles.length!==1||row.roles[0]!==principal||!o.retiredRoles.includes(principal)||normal(row.using)!==normal(expression)||normal(row.check)!==normal(expression))throw fail('PGSTREAM_ADOPTION_OLD_POLICY');seen.add(row.name);
 }
 const wanted=['pgstream_intake_restrict','pgstream_intake_allow',...Array.from({length:b.members},(_,ordinal)=>['pgstream_worker_restrict_'+ordinal,'pgstream_worker_allow_'+ordinal]).flat()];if(canonical([...seen].sort())!==canonical(wanted.sort())||workerRoles.size!==b.members||new Set([...workerRoles.values(),b.role]).size!==b.members+1)throw fail('PGSTREAM_ADOPTION_OLD_POLICY');
 for(const [ordinal,role] of workerRoles)await asRole(query,role,()=>require('./worker-grants').assertReady(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,consumer:b.consumer,assignment:p.assignment,ordinal}));return [...seen];
}
async function snapshot(query,o){
 const b=o.profile.binding,tables=[...lifecycleTables.map(table=>q(b.lifecycleNamespace)+'.'+table),q(b.namespace)+'.tenant_consumer_checkpoint',q(b.membershipNamespace)+'.pool_desired',q(b.membershipNamespace)+'.pool_membership',...o.notificationBindings.flatMap(value=>require('../tenant-notifications/partition-candidate').TABLES.map(table=>q(value.namespace)+'.'+table))];
 const saved={};for(const table of tables)saved[table]=(await query('SELECT /* pool-intake-adoption-snapshot */ (SELECT jsonb_object_agg(key,value) FROM jsonb_each_text(to_jsonb(t))) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows.map(row=>row.row);return saved;
}
function retained(before,after,p){
 const b=p.binding,expected=JSON.parse(JSON.stringify(before)),checkpoint=q(b.namespace)+'.tenant_consumer_checkpoint',desired=q(b.membershipNamespace)+'.pool_desired';
 for(const row of expected[checkpoint])if(row.consumer===b.consumer+'-completed')row.contract_digest=p.contractDigest;
 for(const row of expected[desired]){row.partitioned='true';row.previous_partitioned=row.previous_members===null?null:'true';}
 const ordered=value=>Object.fromEntries(Object.entries(value).map(([table,rows])=>[table,rows.map(canonical).sort()]));if(canonical(ordered(expected))!==canonical(ordered(after)))throw fail('PGSTREAM_ADOPTION_RETAINED_STATE');
}
async function closeWriters(query,o,policies){
 const b=o.profile.binding,table=q(b.namespace)+'.tenant_consumer_checkpoint',columns=(await query('SELECT /* pool-intake-adoption-columns */ attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',[table])).rows.map(row=>row.attname);
 const expected=['tenant_id','consumer','contract_digest','checkpoint','projection',...require('./work-state').COLUMNS,'work_owner_ordinal','work_assignment_revision'];if(canonical(columns)!==canonical(expected))throw fail('PGSTREAM_ADOPTION_COLUMNS');
 const principals=[b.role,b.operatorRole,o.lifetimeRole,...o.workers.map(worker=>worker.role),...o.retiredRoles];
 for(const role of ['PUBLIC',...principals]){const name=role==='PUBLIC'?role:q(role);await query('REVOKE ALL PRIVILEGES ON '+table+' FROM '+name);await query('REVOKE ALL PRIVILEGES ('+columns.map(q).join(',')+') ON '+table+' FROM '+name);}
 const remaining=await require('./intake-adoption-authority').find(query,{table,principals});if(remaining.length)throw fail('PGSTREAM_ADOPTION_WRITERS_REMAIN');
 if(o.registryNamespace){const registry=require('../tenant-registry/postgres');await ledger(query,o.registryNamespace,registry.catalogue.migrations);for(const role of o.retiredRoles)for(const text of registry.retiredReaderGrants({namespace:o.registryNamespace,role}))await query(text);}
 for(const role of o.retiredRoles){await query('REVOKE ALL ON FUNCTION '+q(b.namespace)+'.pgstream_intake_assert() FROM '+q(role));await query('REVOKE ALL PRIVILEGES ON '+q(b.namespace)+'.pgstream_intake_profile FROM '+q(role));}
 const definer=(await query(`SELECT /* pool-intake-adoption-retired-definers */ r.rolname FROM pg_roles r WHERE r.rolname=ANY($1::text[]) AND EXISTS
 (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_function_privilege(r.oid,p.oid,'EXECUTE'))`,[o.retiredRoles])).rows;if(definer.length)throw fail('PGSTREAM_ADOPTION_DEFINER_AUTHORITY');
 for(const name of policies)await query('DROP POLICY '+q(name)+' ON '+table);
 for(const binding of o.notificationBindings){
  for(const relation of require('../tenant-notifications/partition-candidate').TABLES){
   const target=q(binding.namespace)+'.'+relation,columns=(await query('SELECT /* pool-intake-adoption-notification-columns */ attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',[target])).rows.map(row=>row.attname);
   if(!columns.length||columns.some(column=>!legacyProfiles.name(column)))throw fail('PGSTREAM_POOL_ADOPTION_NOTIFICATION_COLUMNS');
   for(const role of ['PUBLIC',...o.retiredRoles]){const principal=role==='PUBLIC'?role:q(role);await query('REVOKE ALL PRIVILEGES ON '+target+' FROM '+principal);await query('REVOKE ALL PRIVILEGES ('+columns.map(q).join(',')+') ON '+target+' FROM '+principal);}
   if((await require('./intake-adoption-authority').find(query,{table:target,principals:o.retiredRoles})).length)throw fail('PGSTREAM_ADOPTION_WRITERS_REMAIN');
  }
  for(const role of o.retiredRoles)await query('REVOKE ALL ON FUNCTION '+q(binding.namespace)+'.pgstream_notification_partition() FROM '+q(role));
 }
}
async function adopt(client,input){
 const o=options(input),p=o.profile,b=p.binding,old=o.predecessorProfile,previous=old.binding;
 if(!client||typeof client.query!=='function'||!Number.isSafeInteger(client.processID)||client.processID<1)throw fail('PGSTREAM_ADOPTION_PHYSICAL_CLIENT');const query=client.query.bind(client);let began=false,commitStarted=false;
 try{
  const begin=await query('BEGIN');began=true;if(begin.command!=='BEGIN')throw fail('PGSTREAM_ADOPTION_BEGIN');
  await query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),set_config('row_security','off',true)",[String(o.lockTimeoutMs),String(o.statementTimeoutMs)]);
  const admin=(await query(`SELECT /* pool-intake-adoption-admin */ current_user AS principal,session_user AS login,pg_backend_pid() AS pid,r.rolsuper,r.rolbypassrls,
 ARRAY(SELECT n.nspname::text FROM pg_namespace n WHERE n.nspname=ANY($1::text[]) AND pg_has_role(current_user,n.nspowner,'MEMBER') ORDER BY n.nspname) AS owned FROM pg_roles r WHERE r.rolname=current_user`,[[b.namespace,b.membershipNamespace,b.lifecycleNamespace]])).rows;
  if(admin.length!==1||admin[0].pid!==client.processID||admin[0].principal!==admin[0].login||!(admin[0].rolsuper===true||admin[0].rolbypassrls===true)||canonical(admin[0].owned)!==canonical([b.namespace,b.membershipNamespace,b.lifecycleNamespace].sort()))throw fail('PGSTREAM_ADOPTION_ADMIN_REQUIRED');
  await safeRoles(query,o);if((await query("SELECT /* pool-intake-adoption-prior-locks */ objid FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()")).rows.length)throw fail('PGSTREAM_ADOPTION_FRESH_CLIENT_REQUIRED');
  for(const key of ownerKeys(o)){const rows=(await query('SELECT /* pool-intake-adoption-owner */ pg_try_advisory_xact_lock($1::bigint) AS held',[key])).rows;if(rows.length!==1||rows[0].held!==true)throw fail('PGSTREAM_ADOPTION_OWNER_ACTIVE');}
  const membership=(await query('SELECT /* pool-intake-adoption-membership-lock */ pg_try_advisory_xact_lock($1::integer,$2::integer) AS held',require('../pool-membership/transaction-lock').key(b.membershipNamespace,'evaluator'))).rows;if(membership.length!==1||membership[0].held!==true)throw fail('PGSTREAM_ADOPTION_MEMBERSHIP_ACTIVE');
  const lockTables=[q(b.namespace)+'.tenant_consumer_checkpoint',q(b.namespace)+'.pgstream_intake_profile',q(b.namespace)+'.schema_migrations',...['schema_migrations','pool_desired','pool_membership'].map(table=>q(b.membershipNamespace)+'.'+table),...['schema_migrations',...lifecycleTables].map(table=>q(b.lifecycleNamespace)+'.'+table),...o.notificationBindings.flatMap(value=>['schema_migrations',...require('../tenant-notifications/partition-candidate').TABLES].map(table=>q(value.namespace)+'.'+table))].sort();await query('LOCK TABLE '+lockTables.join(',')+' IN ACCESS EXCLUSIVE MODE');
  const owners=await safeObjects(query,lockTables);await safeFunctions(query,o);const beforeCatalogue=await predecessorReady(query,o),policies=await oldPolicies(query,o);
  const oldLife=domain.catalogue(old),oldPool=require('../../migrations/candidates/postgres-pool-mutation-v1.json');await ledger(query,b.namespace,beforeCatalogue.catalogue.migrations);await ledger(query,b.lifecycleNamespace,oldLife.migrations);await ledger(query,b.membershipNamespace,oldPool.migrations);
  await require('../pool-membership/fixed-protocol').assertInstalled(query,b.membershipNamespace);await asRole(query,o.lifetimeRole,()=>require('../tenant-lifecycle/operation-window-readiness').admit({query},b.lifecycleNamespace,{lifetime:true,intakeProfile:old}));
  for(const binding of o.notificationBindings){
   const selected=require('../tenant-notifications/partition-candidate').build(notificationBinding(binding));await ledger(query,binding.namespace,selected.catalogue.migrations);await require('../tenant-notifications/partition-protocol').assertInstalled(query,binding.namespace,notificationBinding(binding));
   const extra=(await query(`SELECT /* pool-intake-adoption-notification-extra-effects */ c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND (EXISTS(SELECT 1 FROM pg_rewrite w WHERE w.ev_class=c.oid) OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgname<>ALL($3::text[])))`,[binding.namespace,require('../tenant-notifications/partition-candidate').TABLES,['notification_partition_effect','notification_partition_commit']])).rows;if(extra.length)throw fail('PGSTREAM_ADOPTION_EXTRA_EFFECTS');
  }
  const extras=(await query(`SELECT /* pool-intake-adoption-extra-effects */ c.relname FROM pg_class c WHERE c.oid=ANY($1::regclass[]) AND
 (EXISTS(SELECT 1 FROM pg_rewrite w WHERE w.ev_class=c.oid) OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND (c.relname<>'tenant_consumer_checkpoint' OR t.tgname<>ALL($2::text[]))))`,[[q(b.namespace)+'.tenant_consumer_checkpoint',q(b.namespace)+'.pgstream_intake_profile'],EFFECTS])).rows;if(extras.length)throw fail('PGSTREAM_ADOPTION_EXTRA_EFFECTS');
  const desired=(await query('SELECT /* pool-intake-adoption-desired */ members,previous_members,slice_rule,revision::text FROM '+q(b.membershipNamespace)+'.pool_desired WHERE pool_kind=$1',['evaluator'])).rows;if(desired.length!==1||desired[0].members!==previous.members||desired[0].previous_members!==null||desired[0].slice_rule!==b.sliceRule||desired[0].revision!==previous.revision)throw fail('PGSTREAM_ADOPTION_ASSIGNMENT');
  const before=await snapshot(query,o),life=before[q(b.lifecycleNamespace)+'.tenant_lifecycle_windows'];domain.validateRoster(p,life.map(row=>({tenant:row.tenant_id,phase:row.phase,generation:String(row.generation)})));
  const completed=before[q(b.namespace)+'.tenant_consumer_checkpoint'].filter(row=>row.consumer===b.consumer+'-completed');if(new Set(completed.map(row=>row.tenant_id)).size!==completed.length||completed.some(row=>!life.some(current=>current.tenant_id===row.tenant_id)||row.contract_digest!==old.contractDigest||row.work_version!=='2'||row.work_owner_ordinal!==String(old.assignment.owner(row.tenant_id))||row.work_assignment_revision!==desired[0].revision))throw fail('PGSTREAM_ADOPTION_RETAINED_CONTRACT');
  await closeWriters(query,o,policies);
  const target=require('./pool-catalogue').build(p,{predecessorProfile:old});if(!target.predecessorProfile||target.predecessorProfile.digest!==old.digest)throw fail('PGSTREAM_POOL_ADOPTION_ORIGIN_REQUIRED');
  // All actual old writers and known owner resources are excluded before the
  // only interruption: exact previously validated effect triggers during digest
  // conversion. No unknown trigger is disabled or silently adopted.
  for(const trigger of EFFECTS.slice(1))await query('ALTER TABLE '+q(b.namespace)+'.tenant_consumer_checkpoint DISABLE TRIGGER '+q(trigger));
  const changed=await query('UPDATE '+q(b.namespace)+'.tenant_consumer_checkpoint SET contract_digest=$1 WHERE consumer=$2 AND contract_digest=$3',[p.contractDigest,b.consumer+'-completed',old.contractDigest]);if(changed.rowCount!==completed.length)throw fail('PGSTREAM_ADOPTION_REBIND_COUNT');
  for(const trigger of EFFECTS.slice(1))await query('ALTER TABLE '+q(b.namespace)+'.tenant_consumer_checkpoint ENABLE ALWAYS TRIGGER '+q(trigger));
  for(const migration of domain.catalogue(p).migrations.slice(oldLife.migrations.length))await asRole(query,owners.get(b.lifecycleNamespace),()=>migrate(query,b.lifecycleNamespace,migration));
  for(const migration of require('../pool-membership/pool-candidate').build().migrations.slice(oldPool.migrations.length))await asRole(query,owners.get(b.membershipNamespace),()=>migrate(query,b.membershipNamespace,migration));
  for(const migration of target.catalogue.migrations.slice(beforeCatalogue.catalogue.migrations.length))await asRole(query,owners.get(b.namespace),()=>migrate(query,b.namespace,migration));
  for(const text of require('./pool-intake-grants').build(p))await query(text);
  for(const worker of o.workers)for(const text of require('./pool-worker-grants').build({role:worker.role,profile:p,ordinal:worker.ordinal}))await query(text);
  for(const text of require('./pool-operator-grants').build({role:b.operatorRole,profile:p}))await query(text);
  await asRole(query,o.lifetimeRole,()=>require('../tenant-lifecycle/operation-window-readiness').admit({query},b.lifecycleNamespace,{lifetime:true,intakeProfile:p}));
  await require('./assignment-protocol').assertInstalled(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,lifecycleNamespace:b.lifecycleNamespace,poolProfile:p,poolIntake:true,predecessorProfile:old,requireIntakeExecute:false});
  await asRole(query,b.role,()=>require('./pool-intake-grants').assertReady(query,p));for(const worker of o.workers)await asRole(query,worker.role,()=>require('./pool-worker-grants').assertReady(query,{profile:p,ordinal:worker.ordinal}));await asRole(query,b.operatorRole,()=>require('./pool-operator-grants').assertReady(query,{profile:p}));
  const current=require('../tenant-lifecycle/pool-authority').create({namespace:b.lifecycleNamespace});for(const row of life){await query("SELECT set_config('app.current_tenant_id',$1,true)",[row.tenant_id]);const value=await current.read(query,row.tenant_id);if(value.eligibility!=='deleted'&&!completed.some(checkpoint=>checkpoint.tenant_id===row.tenant_id))throw fail('PGSTREAM_ADOPTION_RETAINED_CONTRACT');}
  const linkRows=(await query('SELECT /* pool-intake-adoption-new-links */ count(*)::text AS count FROM '+q(b.lifecycleNamespace)+'.'+require('../tenant-lifecycle/recommission-candidate').TABLE)).rows;if(linkRows.length!==1||linkRows[0].count!=='0')throw fail('PGSTREAM_ADOPTION_RETAINED_STATE');
  await ledger(query,b.namespace,target.catalogue.migrations);await ledger(query,b.lifecycleNamespace,domain.catalogue(p).migrations);await ledger(query,b.membershipNamespace,require('../pool-membership/pool-candidate').build().migrations);retained(before,await snapshot(query,o),p);
  commitStarted=true;const commit=await query('COMMIT');began=false;if(commit.command!=='COMMIT')throw Object.assign(fail('PGSTREAM_ADOPTION_COMMIT_UNCONFIRMED'),{commitOutcome:commit.command==='ROLLBACK'?'aborted':'uncertain'});
  return Object.freeze({profile:p.digest,predecessorProfile:old.digest,contractDigest:p.contractDigest,tenants:completed.length,notificationScopes:o.notificationBindings.length,scope:'CHECKPOINT_INTAKE_ADOPTION_AND_DECLARED_OUTBOX_QUIESCENCE_NOT_NOTIFICATION_LEDGER_ADOPTION_OR_NETWORK_TERMINATION_PROOF',commitOutcome:'committed',downgrade:'REFUSED: restore exact pre-cutover database, grants and runtime together; no down migration'});
 }catch(error){if(commitStarted&&!error.commitOutcome)error.commitOutcome='uncertain';if(began)try{await query('ROLLBACK');}catch(rollback){throw Object.assign(new globalThis.AggregateError([error,rollback],'PGSTREAM_ADOPTION_ROLLBACK_FAILED'),{commitOutcome:error.commitOutcome||'not-attempted'});}throw error;}
}
async function run(input){
 const opts=options(input),connection=require('../migrations/postgres-check').connectionOptions(input.connectionString),{Client}=require('pg'),admission=require('../storage/connection-admission');
 const client=new (admission.wrapClient(Client,'migration-direct'))({...connection,application_name:'nightscout-pool-intake-adoption',connectionTimeoutMillis:10000,statement_timeout:opts.statementTimeoutMs});let result,error;
 try{await client.connect();result=await adopt(client,{...opts,direct:true});}catch(failure){error=failure;}try{await client.end();}catch(cleanup){throw new (require('../storage/postgres-cleanup-error'))(error||cleanup,cleanup);}if(error)throw error;return result;
}
module.exports={run,adopt,options,ownerKeys,extendCatalogue,constantCheck,ORIGIN_MIGRATION};
