'use strict';
// Explicit one-way ADMIN cutover. Never selected by a serving constructor.
const {createHash}=require('node:crypto');
const profiles=require('./intake-profile');
const domain=require('../tenant-lifecycle/generation-domain');
const candidate=require('./assignment-candidate');
const catalogue=require('../migrations/catalogue');
const legacyLifecycle=require('../tenant-lifecycle/postgres-candidate.json');
const {canonical}=require('../server/serve/evaluator-runtime');
const q=value=>'"'+value+'"';
const lifecycleTables=Object.freeze([...new Set(legacyLifecycle.migrations.flatMap(m=>m.up.map(sql=>/^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1]).filter(Boolean)))].sort());
const fail=code=>Object.assign(new Error(code),{code});
function options(value){
 if(!value||value.direct!==true)throw fail('PGSTREAM_ADOPTION_DIRECT_REQUIRED');
 const profile=profiles.validate(value.profile),b=profile.binding;
 const names=[value.lifetimeRole,...(value.workers||[]).map(v=>v.role),...(value.retiredRoles||[])];
 if(!Array.isArray(value.workers)||value.workers.length!==b.members||value.workers.some((v,i)=>!v||v.ordinal!==i)||!Array.isArray(value.retiredRoles)||!value.retiredRoles.length||names.some(v=>!profiles.name(v))||new Set([...names,b.role]).size!==names.length+1)throw fail('PGSTREAM_ADOPTION_ROLES');
 if(value.registryNamespace!==undefined&&(!profiles.name(value.registryNamespace)||['public','information_schema',b.namespace,b.membershipNamespace,b.lifecycleNamespace].includes(value.registryNamespace)||value.registryNamespace.startsWith('pg_')))throw fail('PGSTREAM_ADOPTION_REGISTRY');
 const timeout=value.lockTimeoutMs??2000,statement=value.statementTimeoutMs??10000;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>600000||!Number.isSafeInteger(statement)||statement<timeout||statement>600000)throw fail('PGSTREAM_ADOPTION_TIMEOUT');
 return Object.freeze({profile,registryNamespace:value.registryNamespace,lifetimeRole:value.lifetimeRole,workers:Object.freeze(value.workers.map(v=>Object.freeze({role:v.role,ordinal:v.ordinal}))),retiredRoles:Object.freeze([...value.retiredRoles]),lockTimeoutMs:timeout,statementTimeoutMs:statement});
}
const digest=(namespace,consumer)=>createHash('sha256').update(canonical(['evaluator-work-v2',namespace,consumer])).digest('hex');
const ownerKeys=p=>[p.ownerKey,...Array.from({length:p.binding.members},(_,i)=>createHash('sha256').update(require('./partition-work').OWNER_DOMAIN+p.binding.namespace+':'+p.binding.consumer+':'+i).digest().readBigInt64BE(0).toString())];
async function ledger(query,namespace,files){
 const rows=(await query('SELECT /* intake-adoption-ledger */ name,checksum FROM '+q(namespace)+'.schema_migrations ORDER BY name COLLATE "C"')).rows;
 if(canonical(rows)!==canonical(files.map(({name,checksum})=>({name,checksum}))))throw fail('PGSTREAM_ADOPTION_HISTORY');
}
async function asRole(query,role,fn){
 await query('SET LOCAL ROLE '+q(role));
 const result=await fn();await query('RESET ROLE');return result;
}
async function lifecycleReady(query,o,selected){
 return asRole(query,o.lifetimeRole,()=>require('../tenant-lifecycle/operation-window-readiness').admit({query},o.profile.binding.lifecycleNamespace,{lifetime:true,...(selected?{intakeProfile:o.profile}:{})}));
}
async function state(query,b){
 // Full administrative visibility is checked before these unfiltered snapshots.
 const tables=[...lifecycleTables.map(v=>q(b.lifecycleNamespace)+'.'+v),q(b.namespace)+'.tenant_consumer_checkpoint'];
 const out={};for(const table of tables)out[table]=(await query('SELECT /* intake-adoption-snapshot */ (SELECT jsonb_object_agg(key,value) FROM jsonb_each_text(to_jsonb(t))) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows.map(v=>v.row);
 return out;
}
function retained(before,after,b,newDigest){
 const expected=JSON.parse(JSON.stringify(before)),table=q(b.namespace)+'.tenant_consumer_checkpoint';
 for(const row of expected[table])if(row.consumer===b.consumer+'-completed')row.contract_digest=newDigest;
 // JSONB lexical ordering can change when the digest changes; compare multisets.
 const sorted=value=>Object.fromEntries(Object.entries(value).map(([key,rows])=>[key,rows.map(canonical).sort()]));
 if(canonical(sorted(expected))!==canonical(sorted(after)))throw fail('PGSTREAM_ADOPTION_RETAINED_STATE');
}
async function rebind(query,p){
 const b=p.binding,table=q(b.namespace)+'.tenant_consumer_checkpoint';
 // Only the exact previously validated function/three triggers are interrupted.
 // Whole-table locks and all original/selected owner keys remain held throughout.
 for(const trigger of ['pgstream_effect_protocol','pgstream_effect_commit'])await query('ALTER TABLE '+table+' DISABLE TRIGGER '+q(trigger));
 const changed=await query('UPDATE '+table+' SET contract_digest=$1 WHERE consumer=$2 AND contract_digest=$3',[p.contractDigest,b.consumer+'-completed',digest(b.namespace,b.consumer)]);
 if(changed.rowCount!==b.tenants.length)throw fail('PGSTREAM_ADOPTION_REBIND_COUNT');
 for(const trigger of ['pgstream_effect_protocol','pgstream_effect_commit'])await query('ALTER TABLE '+table+' ENABLE ALWAYS TRIGGER '+q(trigger));
}
async function migrate(query,namespace,migration){
 await query('SET LOCAL search_path TO '+q(namespace)+', pg_catalog');
 for(const text of catalogue.renderMigration(migration,namespace))await query({text,queryMode:'extended'});
 await query('INSERT INTO '+q(namespace)+'.schema_migrations (name,checksum) VALUES ($1,$2)',[migration.name,migration.checksum]);
 await query('SET LOCAL search_path TO pg_catalog');
}
async function roles(query,o){
 const b=o.profile.binding,wanted=[b.role,o.lifetimeRole,...o.workers.map(v=>v.role),...o.retiredRoles];
 const rows=(await query(`SELECT /* intake-adoption-roles */ rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit,
 EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) AS memberships,
 EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=ANY($2::text[]) AND pg_has_role(r.oid,n.nspowner,'MEMBER')) AS owns
 FROM pg_roles r WHERE rolname=ANY($1::text[])`,[wanted,[b.namespace,b.membershipNamespace,b.lifecycleNamespace]])).rows;
 if(rows.length!==wanted.length||new Set(rows.map(v=>v.rolname)).size!==wanted.length||rows.some(r=>!wanted.includes(r.rolname)||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit','memberships','owns'].some(k=>r[k]!==false)))throw fail('PGSTREAM_ADOPTION_ROLE_AUTHORITY');
}
async function safeObjects(query,tables){
 const rows=(await query(`SELECT /* intake-adoption-object-owners */ n.nspname||'.'||c.relname AS relation,o.rolname AS owner,
 c.relowner=n.nspowner AS same_owner,c.relkind='r' AND c.relpersistence='p' AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS ordinary,
 o.rolcanlogin OR o.rolsuper OR o.rolbypassrls OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication AS unsafe
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles o ON o.oid=c.relowner WHERE c.oid=ANY($1::regclass[])`,[tables])).rows;
 const wanted=tables.map(v=>v.replace(/"/g,''));
 if(rows.length!==wanted.length||new Set(rows.map(r=>r.relation)).size!==wanted.length||rows.some(r=>!wanted.includes(r.relation)||r.same_owner!==true||r.ordinary!==true||r.unsafe!==false||!profiles.name(r.owner)))throw fail('PGSTREAM_ADOPTION_OBJECT_OWNER');
 return new Map(rows.map(r=>[r.relation.split('.')[0],r.owner]));
}
async function policyInventory(query,o){
 const b=o.profile.binding,rows=(await query(`SELECT /* intake-adoption-old-policies */ p.polname AS name,p.polcmd AS command,p.polpermissive AS permissive,
 ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.oid=ANY(p.polroles) ORDER BY r.rolname) AS roles,p.polroles=ARRAY[0::oid] AS public,
 pg_get_expr(p.polqual,p.polrelid) AS "using",pg_get_expr(p.polwithcheck,p.polrelid) AS "check" FROM pg_policy p WHERE p.polrelid=$1::regclass`,[q(b.namespace)+'.tenant_consumer_checkpoint'])).rows;
 const normal=value=>typeof value==='string'?value.replace(/[\s()]/g,''):null;
 const publicRows=rows.filter(r=>r.name==='tenant_consumer_checkpoint_isolation'),tenant="tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid";
 const canon=require('../tenant-lifecycle/catalogue-structure');
 if(publicRows.length!==1||publicRows[0].command!=='*'||publicRows[0].permissive!==true||publicRows[0].public!==true||canon(publicRows[0].using,b.namespace)!==canon(tenant,b.namespace)||canon(publicRows[0].check,b.namespace)!==canon(tenant,b.namespace))throw fail('PGSTREAM_ADOPTION_PUBLIC_POLICY');
 const old=rows.filter(r=>r.name!=='tenant_consumer_checkpoint_isolation');
 for(const row of old){
  const match=/^pgstream_worker_(restrict|allow)_([01])$/.exec(row.name),worker=match&&o.workers[Number(match[2])];
  if(!worker)throw fail('PGSTREAM_ADOPTION_OLD_POLICY');
  const statement=require('./worker-grants').build({...worker,namespace:b.namespace,membershipNamespace:b.membershipNamespace,consumer:b.consumer,assignment:o.profile.assignment}).find(sql=>sql.startsWith('CREATE POLICY '+row.name+' '));
  const expression=/ USING \((.*)\) WITH CHECK/.exec(statement)[1];
  if(row.command!=='*'||row.permissive!==(match[1]==='allow')||row.public!==false||row.roles.length!==1||![worker.role,...o.retiredRoles].includes(row.roles[0])||normal(row.using)!==normal(expression)||normal(row.check)!==normal(expression))throw fail('PGSTREAM_ADOPTION_OLD_POLICY');
 }
 return old.map(r=>r.name);
}
async function retire(query,o,oldPolicies){
 const b=o.profile.binding,table=q(b.namespace)+'.tenant_consumer_checkpoint';
 const columns=(await query('SELECT /* intake-adoption-columns */ attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum',[table])).rows.map(v=>v.attname);
 const expectedColumns=['tenant_id','consumer','contract_digest','checkpoint','projection',...require('./work-state').COLUMNS,'work_owner_ordinal','work_assignment_revision'];
 if(canonical(columns)!==canonical(expectedColumns))throw fail('PGSTREAM_ADOPTION_COLUMNS');
 for(const role of ['PUBLIC',...o.retiredRoles,b.role,...o.workers.map(v=>v.role)]){
  const principal=role==='PUBLIC'?role:q(role);
  await query('REVOKE ALL PRIVILEGES ON '+table+' FROM '+principal);
  await query('REVOKE ALL PRIVILEGES ('+columns.map(q).join(',')+') ON '+table+' FROM '+principal);
 }
 // Effective ACLs include PUBLIC and indirect grants; no ownership/membership
 // exemption for serving or retired principals is accepted.
 const remaining=await require('./intake-adoption-authority').find(query,{table,principals:[b.role,o.lifetimeRole,...o.workers.map(v=>v.role),...o.retiredRoles]});
 if(remaining.length)throw fail('PGSTREAM_ADOPTION_WRITERS_REMAIN');
 // The explicit legacy registry identity is retired in this same transaction;
 // selected worker grants are distinct and remain untouched.
 if(o.registryNamespace){
  const registry=require('../tenant-registry/postgres');
  await ledger(query,o.registryNamespace,catalogue.validateCatalogue(registry.catalogue));
  for(const role of o.retiredRoles)for(const text of registry.retiredReaderGrants({namespace:o.registryNamespace,role}))await query(text);
 }
 const definer=(await query(`SELECT /* intake-adoption-retired-definers */ r.rolname FROM pg_roles r WHERE r.rolname=ANY($1::text[]) AND EXISTS
 (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_function_privilege(r.oid,p.oid,'EXECUTE'))`,[o.retiredRoles])).rows;
 if(definer.length)throw fail('PGSTREAM_ADOPTION_DEFINER_AUTHORITY');
 for(const name of oldPolicies)await query('DROP POLICY '+q(name)+' ON '+table);
 for(const text of require('./intake-grants').build(o.profile))await query(text);
 for(const worker of o.workers)for(const text of require('./worker-grants').build({...worker,namespace:b.namespace,membershipNamespace:b.membershipNamespace,consumer:b.consumer,assignment:o.profile.assignment}))await query(text);
}
async function adopt(client,input){
 const o=options(input),p=o.profile,b=p.binding,query=client.query.bind(client);
 if(!Number.isSafeInteger(client.processID)||client.processID<1)throw fail('PGSTREAM_ADOPTION_PHYSICAL_CLIENT');
 let began=false,commitStarted=false;
 try{
  const begin=await query('BEGIN');began=true;if(begin.command!=='BEGIN')throw fail('PGSTREAM_ADOPTION_BEGIN');
  await query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),set_config('row_security','off',true)",[String(o.lockTimeoutMs),String(o.statementTimeoutMs)]);
  const admin=(await query(`SELECT /* intake-adoption-admin */ current_user AS principal,session_user AS login,pg_backend_pid() AS pid,r.rolsuper,r.rolbypassrls,
 ARRAY(SELECT n.nspname::text FROM pg_namespace n WHERE n.nspname=ANY($1::text[]) AND pg_has_role(current_user,n.nspowner,'MEMBER') ORDER BY n.nspname) AS owned FROM pg_roles r WHERE r.rolname=current_user`,[[b.namespace,b.membershipNamespace,b.lifecycleNamespace]])).rows;
  if(admin.length!==1||admin[0].pid!==client.processID||admin[0].principal!==admin[0].login||!(admin[0].rolsuper===true||admin[0].rolbypassrls===true)||canonical(admin[0].owned)!==canonical([b.namespace,b.membershipNamespace,b.lifecycleNamespace].sort()))throw fail('PGSTREAM_ADOPTION_ADMIN_REQUIRED');
  await roles(query,o);
  const priorLocks=(await query("SELECT /* intake-adoption-prior-locks */ objid FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()")).rows;
  if(priorLocks.length)throw fail('PGSTREAM_ADOPTION_FRESH_CLIENT_REQUIRED');
  // Transaction-scoped exclusive keys refuse live legacy intake/selected workers.
  for(const key of ownerKeys(p)){const row=(await query('SELECT /* intake-adoption-owner */ pg_try_advisory_xact_lock($1::bigint) AS held',[key])).rows;if(row.length!==1||row[0].held!==true)throw fail('PGSTREAM_ADOPTION_OWNER_ACTIVE');}
  const keys=require('../pool-membership/transaction-lock').key(b.membershipNamespace,'evaluator');
  const membership=(await query('SELECT /* intake-adoption-membership-lock */ pg_try_advisory_xact_lock($1::integer,$2::integer) AS held',keys)).rows;
  if(membership.length!==1||membership[0].held!==true)throw fail('PGSTREAM_ADOPTION_MEMBERSHIP_ACTIVE');
  const lockTables=[q(b.namespace)+'.tenant_consumer_checkpoint',q(b.namespace)+'.schema_migrations',q(b.membershipNamespace)+'.pool_desired',...['schema_migrations',...lifecycleTables].map(t=>q(b.lifecycleNamespace)+'.'+t)].sort();
  await query('LOCK TABLE '+lockTables.join(',')+' IN ACCESS EXCLUSIVE MODE');
  const owners=await safeObjects(query,lockTables),oldPolicies=await policyInventory(query,o);
  const beforeCatalogue=candidate.build(b),selected=candidate.build({...b,intakeProfile:p});
  await ledger(query,b.namespace,beforeCatalogue.catalogue.migrations);await ledger(query,b.lifecycleNamespace,legacyLifecycle.migrations);
  await lifecycleReady(query,o,false);await require('./assignment-protocol').assertInstalled(query,b);
  // Unknown checkpoint triggers/rules are never disabled or silently adopted.
  const extras=(await query(`SELECT /* intake-adoption-extra-effects */ c.relname FROM pg_class c WHERE c.oid=$1::regclass AND
 (EXISTS(SELECT 1 FROM pg_rewrite w WHERE w.ev_class=c.oid) OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgname<>ALL($2::text[])))`,[q(b.namespace)+'.tenant_consumer_checkpoint',['pgstream_assignment_protocol','pgstream_effect_protocol','pgstream_effect_commit']])).rows;
  if(extras.length)throw fail('PGSTREAM_ADOPTION_EXTRA_EFFECTS');
  const desired=(await query('SELECT /* intake-adoption-desired */ members,previous_members,slice_rule,revision::text FROM '+q(b.membershipNamespace)+'.pool_desired WHERE pool_kind=$1',['evaluator'])).rows;
  if(desired.length!==1||desired[0].members!==b.members||desired[0].previous_members!==null||desired[0].slice_rule!=='sha256-modulo-v1'||desired[0].revision!==b.revision)throw fail('PGSTREAM_ADOPTION_ASSIGNMENT');
  const before=await state(query,b),life=before[q(b.lifecycleNamespace)+'.tenant_lifecycle_windows'];
  domain.validateRoster(p,life.map(row=>({tenant:row.tenant_id,phase:row.phase,generation:String(row.generation)})));
  const completed=before[q(b.namespace)+'.tenant_consumer_checkpoint'].filter(r=>r.consumer===b.consumer+'-completed');
  if(completed.length!==b.tenants.length||new Set(completed.map(r=>r.tenant_id)).size!==b.tenants.length||completed.some(r=>!b.tenants.includes(r.tenant_id)||r.contract_digest!==digest(b.namespace,b.consumer)||r.work_version!=='2'||r.work_owner_ordinal!==String(p.assignment.owner(r.tenant_id))||String(r.work_assignment_revision)!==b.revision))throw fail('PGSTREAM_ADOPTION_RETAINED_CONTRACT');
  await rebind(query,p);
  await asRole(query,owners.get(b.lifecycleNamespace),()=>migrate(query,b.lifecycleNamespace,domain.catalogue(p).migrations.at(-1)));
  await asRole(query,owners.get(b.namespace),()=>migrate(query,b.namespace,selected.catalogue.migrations.find(m=>m.name==='0004_evaluator_sole_intake')));
  await retire(query,o,oldPolicies);
  await lifecycleReady(query,o,true);await require('./assignment-protocol').assertInstalled(query,{...b,intakeProfile:p});
  await asRole(query,b.role,()=>require('./intake-grants').assertReady(query,p));
  for(const worker of o.workers)await asRole(query,worker.role,()=>require('./worker-grants').assertReady(query,{namespace:b.namespace,membershipNamespace:b.membershipNamespace,consumer:b.consumer,assignment:p.assignment,ordinal:worker.ordinal}));
  await ledger(query,b.namespace,selected.catalogue.migrations);await ledger(query,b.lifecycleNamespace,domain.catalogue(p).migrations);
  retained(before,await state(query,b),b,p.contractDigest);
  commitStarted=true;const commit=await query('COMMIT');began=false;
  if(commit.command!=='COMMIT')throw Object.assign(fail('PGSTREAM_ADOPTION_COMMIT_UNCONFIRMED'),{commitOutcome:commit.command==='ROLLBACK'?'aborted':'uncertain'});
  return Object.freeze({profile:p.digest,contractDigest:p.contractDigest,tenants:b.tenants.length,commitOutcome:'committed',downgrade:'REFUSED: restore the exact pre-cutover database and retired runtime together; no down migration'});
 }catch(error){
  if(commitStarted&&!error.commitOutcome)error.commitOutcome='uncertain';
  if(began)try{await query('ROLLBACK');}catch(rollback){throw Object.assign(new globalThis.AggregateError([error,rollback],'PGSTREAM_ADOPTION_ROLLBACK_FAILED'),{commitOutcome:error.commitOutcome||'not-attempted'});}
  throw error;
 }
}
async function run(input){
 const opts=options(input),connection=require('../migrations/postgres-check').connectionOptions(input.connectionString);
 const {Client}=require('pg'),admission=require('../storage/connection-admission');
 const client=new (admission.wrapClient(Client,'migration-direct'))({...connection,application_name:'nightscout-intake-adoption',connectionTimeoutMillis:10000,statement_timeout:opts.statementTimeoutMs});
 let result,error;
 try{await client.connect();result=await adopt(client,{...opts,direct:true});}catch(failure){error=failure;}
 try{await client.end();}catch(cleanup){throw new (require('../storage/postgres-cleanup-error'))(error||cleanup,cleanup);}
 if(error)throw error;return result;
}
module.exports={run,adopt,options,ownerKeys};
