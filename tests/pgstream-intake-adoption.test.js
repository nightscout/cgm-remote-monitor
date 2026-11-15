'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {canonical}=require('../lib/server/serve/evaluator-runtime');
const adoption=require('../lib/pgstream/intake-adoption'),profiles=require('../lib/pgstream/intake-profile');
const candidate=require('../lib/pgstream/assignment-candidate'),grants=require('../lib/pgstream/intake-grants'),workers=require('../lib/pgstream/worker-grants');
const source=require('./fixtures/intake-source-protocol');
const lifecycle=require('../lib/tenant-lifecycle/postgres-candidate.json');
const domain=require('../lib/tenant-lifecycle/generation-domain');
const copy=v=>JSON.parse(JSON.stringify(v));
// Strict source/SQL recording model: it does not parse PostgreSQL or prove ACL,
// advisory-lock, RLS, lock-wait, transaction or native COMMIT behavior.
function fixture(){
 const p=profiles.create(source.options),b=p.binding,base=candidate.build(b),selected=candidate.build({...b,intakeProfile:p});
 const opts={direct:true,profile:p,lifetimeRole:'lifetime_reader',workers:[{role:'worker_zero',ordinal:0},{role:'worker_one',ordinal:1}],retiredRoles:['old_writer']};
 const oldDigest=createHash('sha256').update(canonical(['evaluator-work-v2',b.namespace,b.consumer])).digest('hex');
 const tables={};
 for(const m of lifecycle.migrations)for(const sql of m.up){const name=/^CREATE TABLE ([a-z_]+) /.exec(sql)?.[1];if(name)tables['"'+b.lifecycleNamespace+'".'+name]=[];}
 tables['"'+b.lifecycleNamespace+'".tenant_lifecycle_windows']=b.tenants.map((tenant,i)=>({tenant_id:tenant,generation:i?'9007199254740994':'4611686018427387902',phase:i?'active':'suspended',claim_id:i?null:'synthetic-claim',artifact_digest:i?null:'f'.repeat(64)}));
 tables['"'+b.lifecycleNamespace+'".tenant_lifecycle_restore_audit']=[{claim_id:'synthetic-claim',generation:'4611686018427387902',state:'suspended'}];
 const checkpoint='"'+b.namespace+'".tenant_consumer_checkpoint';
 tables[checkpoint]=b.tenants.map(tenant=>({tenant_id:tenant,consumer:b.consumer+'-completed',contract_digest:oldDigest,work_version:'2',work_owner_ordinal:String(p.assignment.owner(tenant)),work_assignment_revision:b.revision,work_observed:'[9007199254740993,null,null,null,null,null]',work_completed:'[1,null,null,null,null,null]',work_pending_at:'10',delivery_revision:'3',delivery_ack_revision:'2',output_revision:'1',projection:'[{"kind":"evaluator-work-v2","output":{"rows":[{"synthetic":true}]}}]'}));
 tables[checkpoint].push({tenant_id:source.A,consumer:b.consumer,contract_digest:'a'.repeat(64),work_version:'0',checkpoint:'9007199254740993',projection:'[]'});
 let state={tables,lifeHistory:lifecycle.migrations.map(({name,checksum})=>({name,checksum})),workHistory:base.catalogue.migrations.map(({name,checksum})=>({name,checksum})),bound:false,installed:false,effect:base.effectBody,assertion:null,acl:{old_writer:['*']},columns:Object.keys(tables[checkpoint][0]),disabled:[]},saved,role=null;
 const calls=[],fault={owner:false,membership:false,foreignWriter:false,corrupt:false,commit:false,ddl:false,wrongRole:false,unsafeOwner:false,badPolicy:false,existingWorkerPolicies:false,definer:false,priorLock:false};
 const admission=require('./fixtures/operation-window-admission-protocol')((kind,rows)=>{if(state.bound){if(kind==='tenant_lifecycle_windows')rows[0].constraints.push({definition:domain.constraint(),valid:true,deferrable:false});if(kind==='ledger')rows.push(...domain.catalogue(p).migrations.slice(-1).map(({name,checksum})=>({name,checksum})));}});
 const query=async(input,values)=>{
  const text=typeof input==='string'?input:input.text;calls.push({text,values:copy(values??null),role});
  if(text==='BEGIN'){saved=copy(state);return {command:'BEGIN',rows:[]};}
  if(text==='COMMIT'){if(fault.commit)throw new Error('SYNTHETIC_COMMIT_REPLY_LOST');saved=null;return {command:'COMMIT',rows:[]};}
  if(text==='ROLLBACK'){if(saved)state=copy(saved);saved=null;return {command:'ROLLBACK',rows:[]};}
  if(text.startsWith('SET LOCAL ROLE ')){role=text.match(/"([a-z_]+)"/)[1];return {rows:[]};}
  if(text==='RESET ROLE'){role=null;return {rows:[]};}
  if(text.startsWith('SET LOCAL search_path')||text.startsWith("SELECT set_config('lock_timeout'"))return {rows:[]};
  const admitted=admission(text,values);if(admitted)return admitted;
  if(text.includes('/* intake-adoption-admin */'))return {rows:[{principal:'admin',login:'admin',pid:731,rolsuper:true,rolbypassrls:true,owned:[b.namespace,b.membershipNamespace,b.lifecycleNamespace].sort()}]};
  if(text.includes('/* intake-adoption-roles */'))return {rows:values[0].map(rolname=>({rolname,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:fault.wrongRole,owns:false}))};
  if(text.includes('/* intake-adoption-prior-locks */'))return {rows:fault.priorLock?[{objid:17}]:[]};
  if(text.includes('/* intake-adoption-owner */'))return {rows:[{held:!fault.owner}]};
  if(text.includes('/* intake-adoption-membership-lock */'))return {rows:[{held:!fault.membership}]};
  if(text.startsWith('LOCK TABLE '))return {rows:[]};
  if(text.includes('/* intake-adoption-object-owners */'))return {rows:values[0].map(table=>({relation:table.replace(/"/g,''),owner:table.includes('"'+b.namespace+'"')?'work_owner':table.includes('"'+b.lifecycleNamespace+'"')?'life_owner':'member_owner',same_owner:true,ordinary:true,unsafe:fault.unsafeOwner}))};
  if(text.includes('/* intake-adoption-old-policies */')){
   const tenant="tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid",rows=[{name:'tenant_consumer_checkpoint_isolation',command:'*',permissive:true,public:true,roles:[],using:tenant,check:tenant}];
   if(fault.existingWorkerPolicies)for(const worker of opts.workers){for(const sql of workers.build({...worker,namespace:b.namespace,consumer:b.consumer,membershipNamespace:b.membershipNamespace,assignment:p.assignment}).filter(v=>v.startsWith('CREATE POLICY '))){const name=sql.split(' ')[2],expression=/ USING \((.*)\) WITH CHECK/.exec(sql)[1];rows.push({name,command:'*',permissive:name.includes('_allow_'),public:false,roles:[worker.role],using:expression,check:expression});}}
   if(fault.badPolicy)rows.push({name:'foreign_policy',command:'*',permissive:true,public:true,roles:[],using:'true',check:'true'});
   return {rows};
  }
  if(text.startsWith('DROP POLICY '))return {rows:[]};

  if(text.includes('/* intake-adoption-ledger */'))return {rows:copy(text.includes('"'+b.namespace+'"')?state.workHistory:state.lifeHistory)};
  if(text.includes('/* intake-adoption-extra-effects */'))return {rows:[]};
  if(text.includes('/* intake-adoption-desired */'))return {rows:[{members:b.members,previous_members:null,slice_rule:'sha256-modulo-v1',revision:b.revision}]};
  if(text.includes('/* intake-adoption-snapshot */')){const table=/ FROM ("[a-z_]+"\.[a-z_]+) t/.exec(text)[1];return {rows:copy(state.tables[table]).map(row=>({row}))};}
  if(text.includes('/* intake-adoption-columns */'))return {rows:state.columns.map(attname=>({attname}))};
  if(text.includes('/* intake-adoption-retired-definers */'))return {rows:fault.definer?[{rolname:'old_writer'}]:[]};
  if(text.includes('/* intake-adoption-retired-rights */'))return {rows:[...Object.entries(state.acl).filter(([,rights])=>rights.length).map(([rolname])=>({rolname})),...(fault.foreignWriter?[{rolname:'foreign_writer'}]:[])]};
  if(text.startsWith('ALTER TABLE '+checkpoint+' DISABLE TRIGGER')){state.disabled.push(text.split('"').at(-2));return {rows:[]};}
  if(text.startsWith('ALTER TABLE '+checkpoint+' ENABLE ALWAYS TRIGGER')){state.disabled=state.disabled.filter(v=>v!==text.split('"').at(-2));return {rows:[]};}
  if(text.startsWith('UPDATE '+checkpoint+' SET contract_digest=')){
   assert.deepEqual(state.disabled.sort(),['pgstream_effect_commit','pgstream_effect_protocol']);
   let rowCount=0;for(const row of state.tables[checkpoint])if(row.consumer===values[1]&&row.contract_digest===values[2]){row.contract_digest=values[0];if(fault.corrupt)row.work_pending_at='11';rowCount++;}return {rows:[],rowCount};
  }
  if(text.startsWith('ALTER TABLE tenant_lifecycle_windows ADD CONSTRAINT')){if(fault.ddl)throw new Error('SYNTHETIC_DDL_FAILURE');state.bound=true;return {rows:[]};}
  if(text.startsWith('CREATE TABLE pgstream_intake_profile')){state.installed=true;return {rows:[]};}
  if(text.startsWith('CREATE FUNCTION pgstream_intake_assert')){state.assertion=text.split('$intake$')[1];return {rows:[]};}
  if(text.startsWith('CREATE OR REPLACE FUNCTION pgstream_assigned_effect_required')){state.effect=text.split('$intake$')[1];return {rows:[]};}
  if(text.startsWith('INSERT INTO "'+b.namespace+'".schema_migrations')){state.workHistory.push({name:values[0],checksum:values[1]});return {rows:[],rowCount:1};}
  if(text.startsWith('INSERT INTO "'+b.lifecycleNamespace+'".schema_migrations')){state.lifeHistory.push({name:values[0],checksum:values[1]});return {rows:[],rowCount:1};}
  if(text.startsWith('REVOKE ALL PRIVILEGES ')){const name=text.endsWith('PUBLIC')?'PUBLIC':text.split('"').at(-2);state.acl[name]=[];return {rows:[]};}
  if(text.startsWith('GRANT ')||text.startsWith('CREATE POLICY ')||text.startsWith('REVOKE ALL ON ')||text.startsWith('INSERT INTO pgstream_intake_profile'))return {rows:[]};
  if(text.includes('FROM pg_trigger')){
   const effect=(name,type,source,fn,columns,deferred)=>({name,type,source,function_name:fn,columns,deferrable:deferred,deferred,enabled:state.disabled.includes(name)?'D':'A',arguments:0,unconditional:true,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']});
   return {rows:[effect('pgstream_assignment_protocol',31,base.assignmentBody,'pgstream_assignment_required',candidate.ASSIGNMENT_COLUMNS,false),effect('pgstream_effect_protocol',19,state.effect,'pgstream_assigned_effect_required',candidate.EFFECT_COLUMNS,false),effect('pgstream_effect_commit',17,state.effect,'pgstream_assigned_effect_required',[],true)]};
  }
  if(text.includes('/* intake-assert-function */'))return {rows:[{source:state.assertion,definer:false,arguments:0,void_result:true,executes:true,language:'plpgsql',config:['search_path=pg_catalog']}]};
  if(text.includes('FROM pg_index'))return {rows:candidate.INDEXES.map(i=>({...i,valid:true,ready:true,unique:false,method:'btree'}))};
  if(text.includes('/* intake-role */'))return {rows:[{principal:role,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:false}]};
  if(text.includes('/* intake-effective-grants */'))return {rows:[{relation:b.namespace+'.tenant_consumer_checkpoint',reads:grants.READS,updates:grants.UPDATES,secured:true},{relation:b.namespace+'.schema_migrations',reads:grants.WORK_CATALOGUE_READ,updates:[],secured:false},{relation:b.namespace+'.pgstream_intake_profile',reads:grants.PROFILE,updates:[],secured:false},{relation:b.membershipNamespace+'.pool_desired',reads:grants.DESIRED,updates:[],secured:false},...Object.entries(grants.CONTROL_READS).map(([table,reads])=>({relation:b.lifecycleNamespace+'.'+table,reads,updates:[],secured:table!=='schema_migrations'}))].map(r=>({...r,reads:[...new Set(r.reads)].sort(),updates:[...r.updates].sort(),kind:'r',persistence:'p',inherited:false,rls:r.secured,forced:r.secured,owns:false,uses_schema:true,creates:false,forbidden:false}))};
  if(text.includes('/* intake-other-rights */'))return {rows:[]};
  if(text.includes('/* intake-policies */')){const expression=grants.expression(p),tenant="tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid";return {rows:[{name:'tenant_consumer_checkpoint_isolation',command:'*',permissive:true,using:tenant,check:tenant},...['restrict','allow'].map(kind=>({name:'pgstream_intake_'+kind,command:'*',permissive:kind==='allow',using:expression,check:expression}))]};}
  if(text.includes('/* evaluator-worker-grants */'))return {rows:[{principal:role,uses_schema:true,secured:true,reads:true,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,memberships:false,creates:false,owns:false,forbidden:false,updates:[...workers.UPDATES].sort()}]};
  if(text.includes('/* evaluator-worker-policies */')){const ordinal=opts.workers.find(w=>w.role===role).ordinal,sql=workers.build({role,...opts.workers[ordinal],namespace:b.namespace,consumer:b.consumer,membershipNamespace:b.membershipNamespace,assignment:p.assignment}),expression=/ USING \((.*)\) WITH CHECK/.exec(sql.find(s=>s.startsWith('CREATE POLICY')))[1];return {rows:['restrict','allow'].map(kind=>({name:'pgstream_worker_'+kind+'_'+ordinal,command:'*',permissive:kind==='allow',using:expression,check:expression}))};}
  throw new Error('UNEXPECTED_SQL '+text.slice(0,100));
 };
 return {opts,p,b,calls,fault,client:{query,processID:731},state:()=>state,checkpoint,initial:copy(state),selected};
}
function altered(needle,replacement){const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../lib/pgstream/intake-adoption'),source=fs.readFileSync(file,'utf8');assert.equal(source.split(needle).length,2);const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(source.replace(needle,replacement),file);return m.exports;}
describe('explicit atomic intake/lifecycle ADMIN adoption source (native UNMEASURED)',()=>{
 it('holds all known owner resources and table locks before exact history/whole namespace/retained contract checks',async()=>{const f=fixture(),out=await adoption.adopt(f.client,f.opts);assert.equal(out.commitOutcome,'committed');assert.equal(out.profile,f.p.digest);assert.equal(f.calls.at(-1).text,'COMMIT');assert.equal(f.calls.filter(c=>c.text==='BEGIN').length,1);assert.equal(f.calls.filter(c=>c.text==='COMMIT').length,1);assert.equal(f.calls.filter(c=>c.text.includes('intake-adoption-owner')).length,3);const lock=f.calls.findIndex(c=>c.text.startsWith('LOCK TABLE ')),snapshot=f.calls.findIndex(c=>c.text.includes('intake-adoption-snapshot'));assert(lock>0&&lock<snapshot);assert(f.calls[lock].text.includes('tenant_activity_audit'));assert(f.calls[lock].text.includes('tenant_lifecycle_ceremony'));assert(f.calls[lock].text.includes('pool_desired'));assert.deepEqual(f.state().disabled,[]);});
 it('rebinds only the exact legacy completed digest, preserving BIGINT strings, BASE, clinical, pending, output, ACK and all lifecycle records',async()=>{const f=fixture();await adoption.adopt(f.client,f.opts);const expected=copy(f.initial.tables);for(const row of expected[f.checkpoint])if(row.consumer.endsWith('-completed'))row.contract_digest=f.p.contractDigest;assert.deepEqual(f.state().tables,expected);assert.equal(f.state().tables[f.checkpoint][0].work_observed,'[9007199254740993,null,null,null,null,null]');assert.equal(f.state().workHistory.length,4);assert.equal(f.state().lifeHistory.length,10);assert.equal(f.state().acl.old_writer.length,0);assert(f.calls.some(c=>c.text.includes('GRANT UPDATE('+workers.UPDATES.join(','))));assert(f.calls.some(c=>c.role==='worker_zero'&&c.text.includes('evaluator-worker-grants')));});
 it('refuses live legacy/worker owners, active membership transaction and elevated/indirect old principal authority before DDL',async()=>{for(const flag of ['owner','membership','wrongRole','unsafeOwner','badPolicy','priorLock']){const f=fixture();f.fault[flag]=true;await assert.rejects(adoption.adopt(f.client,f.opts),/ACTIVE|AUTHORITY|OBJECT_OWNER|OLD_POLICY|FRESH_CLIENT/);assert.deepEqual(f.state(),f.initial);assert(!f.calls.some(c=>c.text.startsWith('ALTER TABLE')));}});
 it('refuses foreign namespace rows, unsupported retained generations and legacy contract drift without any rebind',async()=>{for(const mode of ['extra','range','digest']){const f=fixture();if(mode==='extra')f.state().tables['"'+f.b.lifecycleNamespace+'".tenant_lifecycle_windows'].push({tenant_id:'33333333-3333-4333-8333-333333333333',phase:'active',generation:'1'});if(mode==='range')f.state().tables['"'+f.b.lifecycleNamespace+'".tenant_lifecycle_windows'][0].generation='4611686018427387903';if(mode==='digest')f.state().tables[f.checkpoint][0].contract_digest='0'.repeat(64);const before=copy(f.state());await assert.rejects(adoption.adopt(f.client,f.opts),/COVERAGE|DOMAIN|CONTRACT/);assert.deepEqual(f.state(),before);assert(!f.calls.some(c=>c.text.startsWith('UPDATE ')));}});
 it('rolls back contract rebind plus all ledger/CHECK/profile/ACL effects on DDL, residual foreign writer or exact retained-state failure',async()=>{for(const mode of ['ddl','foreignWriter','corrupt','definer']){const f=fixture();f.fault[mode]=true;await assert.rejects(adoption.adopt(f.client,f.opts),/DDL_FAILURE|WRITERS_REMAIN|RETAINED_STATE|DEFINER_AUTHORITY/);assert.deepEqual(f.state(),f.initial);assert.equal(f.calls.at(-1).text,'ROLLBACK');assert(!f.calls.some(c=>c.text==='COMMIT'));}});
 it('recognizes and replaces only exact old worker policies while preserving their selected BASE/complete/TIME/ACK grant plan',async()=>{const f=fixture();f.fault.existingWorkerPolicies=true;await adoption.adopt(f.client,f.opts);assert.equal(f.calls.filter(c=>c.text.startsWith('DROP POLICY ')).length,4);assert.equal(f.calls.filter(c=>c.text.startsWith('CREATE POLICY pgstream_worker_')).length,4);});
 it('labels reply-lost COMMIT uncertain and never reports successful adoption',async()=>{const f=fixture();f.fault.commit=true;await assert.rejects(adoption.adopt(f.client,f.opts),e=>e.message==='SYNTHETIC_COMMIT_REPLY_LOST'&&e.commitOutcome==='uncertain');});
 it('rejects caller role aliases, arbitrary domain, non-direct clients and reused unsupported history',async()=>{const f=fixture();await assert.rejects(adoption.adopt(f.client,{...f.opts,direct:false}),/DIRECT/);await assert.rejects(adoption.adopt(f.client,{...f.opts,retiredRoles:[f.b.role]}),/ROLES/);await assert.rejects(adoption.adopt({...f.client,processID:undefined},f.opts),/PHYSICAL/);f.state().workHistory.push({name:'unknown',checksum:'0'.repeat(64)});await assert.rejects(adoption.adopt(f.client,f.opts),/HISTORY/);assert(!f.calls.some(c=>c.text.startsWith('UPDATE ')));});
 it('exact preservation criterion goes RED when its actual check is removed and the cutover changes pending age; restored source refuses',async()=>{const broken=altered('retained(before,await state(query,b),b,p.contractDigest);','');async function criterion(api){const f=fixture();f.fault.corrupt=true;await assert.rejects(api.adopt(f.client,f.opts),/RETAINED_STATE/);}await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(adoption);});
 it('retired-authority criterion goes RED when the effective foreign-writer guard is removed; restored source refuses and rolls back',async()=>{const broken=altered("if(remaining.length)throw fail('PGSTREAM_ADOPTION_WRITERS_REMAIN');",'');async function criterion(api){const f=fixture();f.fault.foreignWriter=true;await assert.rejects(api.adopt(f.client,f.opts),/WRITERS_REMAIN/);}await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(adoption);});
 it('old-owner criterion goes RED when actual acquisition check is removed; restored source refuses before mutation',async()=>{const broken=altered("if(row.length!==1||row[0].held!==true)throw fail('PGSTREAM_ADOPTION_OWNER_ACTIVE');",'');async function criterion(api){const f=fixture();f.fault.owner=true;await assert.rejects(api.adopt(f.client,f.opts),/OWNER_ACTIVE/);}await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(adoption);});
});
