'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{canonical}=require('../lib/server/serve/evaluator-runtime');
const profiles=require('../lib/pgstream/intake-profile'),candidate=require('../lib/pgstream/assignment-candidate');
const fixture=require('./fixtures/intake-source-protocol'),storeModule=require('../lib/pgstream/intake-store');
const grants=require('../lib/pgstream/intake-grants'),work=require('../lib/pgstream/work-state');
const copy=value=>JSON.parse(JSON.stringify(value));
const p=()=>profiles.create(fixture.options);
async function open({creator,profile=p()}={}){const f=fixture.create(profile);await f.window.ready();f.connection=await (creator||require('../lib/storage/postgres-connection'))(f.options);f.hints=[];f.store=storeModule.create({connection:f.connection,profile,onCommit:value=>{f.hints.push({value,last:f.calls.at(-1).text});}});f.close=async()=>{await f.store.close();await f.connection.end();await f.window.close();await f.canonical.window.close();};return f;}
describe('proposed sole-intake source capability (synthetic SQL; native unmeasured)',()=>{
 it('binds codec/policy/principal/fixed assignment/layout in immutable profile and retains the exact stable legacy owner key',()=>{
  const a=p(),b=profiles.create({...fixture.options,role:'another_intake_writer'}),c=profiles.create({...fixture.options,revision:'9007199254740994'});
  assert.notEqual(a.digest,b.digest);assert.notEqual(a.contractDigest,b.contractDigest);assert.notEqual(a.digest,c.digest);assert.equal(a.ownerKey,b.ownerKey);assert.equal(a.ownerKey,c.ownerKey);
  const old=createHash('sha256').update(canonical(['pgstream-evaluator-owner-v1',fixture.options.namespace,fixture.options.consumer])).digest('hex');assert.equal(a.ownerKey,BigInt.asIntN(64,BigInt('0x'+old.slice(0,16))).toString());assert(Object.isFrozen(a.binding.tenants));
  assert.throws(()=>profiles.create({...fixture.options,codec:undefined}),/PROFILE/);assert.throws(()=>profiles.create({...fixture.options,codec:'unrecognized-research-codec'}),/PROFILE/);assert.throws(()=>profiles.create({...fixture.options,generationDomain:'unrecognized-domain'}),/PROFILE/);assert.throws(()=>profiles.create({...fixture.options,maxGeneration:'2'}),/PROFILE/);assert.throws(()=>profiles.validate({...a,binding:{...a.binding,controlReads:{}}}),/PROFILE/);assert.equal(profiles.DOMAIN.completeMaximum,'4611686018427387902');assert.throws(()=>profiles.create({...fixture.options,unknown:true}),/PROFILE/);assert.throws(()=>profiles.validate({...a,contractDigest:'0'.repeat(64)}),/PROFILE/);
 });
 it('appends one coherent migration without editing any prefix and preserves the complete worker branch/BASE grants',()=>{
  const a=candidate.build(fixture.options),b=candidate.build({...fixture.options,intakeProfile:p()});
  assert.deepEqual(b.catalogue.migrations.slice(0,3),a.catalogue.migrations);assert.equal(require('../lib/migrations/catalogue').validateCatalogue(b.catalogue).length,4);
  assert(b.effectBody.endsWith(a.effectBody.slice(a.effectBody.indexOf('BEGIN\n')+6)));assert(b.effectBody.includes('NEW.consumer=\'evaluator-intake-completed\''));assert(b.effectBody.includes('PGSTREAM_INTAKE_IMMUTABLE'));
  const migration=b.catalogue.migrations[3];assert(!migration.up.some(sql=>/^UPDATE tenant_consumer_checkpoint/.test(sql)));assert(require('../lib/pgstream/worker-grants').UPDATES.includes('contract_digest'));
  assert.throws(()=>candidate.build({...fixture.options,membershipNamespace:'foreign_members',intakeProfile:p()}),/CATALOGUE_BINDING/);
 });
 it('has no implicit constructor/default activation, requires exact validation-only roster and exposes no clinical or arbitrary query API',async()=>{
  const f=await open();try{
   assert.deepEqual(Object.keys(f.store).sort(),['admit','available','close','consumer','digest','observe','observeMany','own','profile'].sort());
   await assert.rejects(f.store.observe(f.A,'clock','2'),/UNAVAILABLE/);await f.store.own(()=>{f.state.losses++;});
   assert.equal(f.store.available,false);await assert.rejects(f.store.admit([f.A]),/FIXED_ROSTER/);await f.store.admit([f.B,f.A]);assert(f.store.available);
   assert(!f.calls.some(c=>/INSERT INTO|ALTER TABLE|GRANT /.test(c.text)));
  }finally{await f.close();}
 });
 it('uses one tracked original backend, no clinical lease, exact bigint context, bounded snapshot and COMMIT-before-hint',async()=>{
  const f=await open();try{await f.store.own(()=>{});await f.store.admit([f.A,f.B]);const before=copy(f.rows.get(f.A)),out=await f.store.observe(f.A,'activity','9007199254740993',false);
   assert.equal(f.clients.length,1);assert.equal(f.state.clinical,0);assert(!f.calls.some(c=>c.text.includes('operation-window-current')));assert.deepEqual(f.window.inflight(f.A),[]);assert(f.calls.every(c=>c.pid===f.clients[0].processID));assert.equal(out.observed.activity,'9007199254740993');assert.equal(out.enabled,false);assert.equal(f.rows.get(f.A).delivery_revision,'1');assert.deepEqual(f.hints.map(h=>h.last),['COMMIT']);assert.equal(f.state.assertions,2);
   for(const key of ['checkpoint','projection','work_completed','work_due_at','work_completed_at','output_identity','output_digest','output_revision','output_restore_generation','delivery_ack_revision','contract_digest','work_owner_ordinal','work_assignment_revision'])assert.deepEqual(f.rows.get(f.A)[key],before[key],key);
   const context=f.calls.find(c=>c.text.startsWith("SELECT set_config('app.pgstream_intake'")).values[0];assert.equal(JSON.parse(context).transactionId,'9007199254740995');assert(!context.includes('restoreGeneration'));
  }finally{await f.close();}
 });
 it('revalidates no-op receipts before COMMIT and repairs lost hints without rejuvenating stored timestamps or output',async()=>{
  const f=await open();try{await f.store.own(()=>{});await f.store.admit([f.A,f.B]);await f.store.observe(f.A,'activity','2',false);const before=copy(f.rows.get(f.A)),updates=f.calls.filter(c=>c.text.startsWith('WITH input')).length;
   await f.store.observe(f.A,'activity','2',true);assert.deepEqual(f.rows.get(f.A),before);assert.equal(f.calls.filter(c=>c.text.startsWith('WITH input')).length,updates);assert.equal(f.state.assertions,4);assert.equal(f.hints.length,2);
   f.state.failAssert=6;await assert.rejects(f.store.observe(f.A,'activity','2',false),/SYNTHETIC_SQL_INTAKE_REFUSAL/);assert.equal(f.hints.length,2);assert.equal(f.store.available,false);
  }finally{await f.close();}
 });
 it('withdraws before loss callback; unknown COMMIT cannot fulfill/hint and remains explicitly uncertain',async()=>{
  const f=await open();try{let unavailableAtLoss;await f.store.own(()=>{unavailableAtLoss=!f.store.available;});await f.store.admit([f.A,f.B]);f.state.commit='unknown';await assert.rejects(f.store.observe(f.A,'clock','2'),e=>e.commitOutcome==='uncertain'&&e.message==='SYNTHETIC_COMMIT_REPLY_LOST');assert.equal(unavailableAtLoss,true);assert.equal(f.store.available,false);assert.deepEqual(f.hints,[]);assert.equal(f.rows.get(f.A).work_observed[0],'2','synthetic server committed but client received no success');await assert.rejects(f.store.observe(f.A,'clock','3'),/UNAVAILABLE/);
  }finally{await f.close();}
 });
 it('refuses missing/provisioned profile, role flags and unexpected effective rights without mutation',async()=>{
  for(const mode of ['missing','badProfile','inherit','extra','update','policy']){const f=await open();try{if(mode==='missing')f.state.missing=true;if(mode==='badProfile')f.state.badProfile=true;if(mode==='inherit')f.state.role.rolinherit=true;if(mode==='extra')f.state.extraAuthority=true;if(mode==='update')f.state.grantsMutation=rs=>rs[0].updates.push('contract_digest');if(mode==='policy')f.state.policiesMutation=rs=>rs.pop();await assert.rejects(f.store.own(()=>{}),/REFUSED|PROVISIONED|PROFILE|AUTHORITY/);assert.equal(f.store.available,false);assert(!f.calls.some(c=>c.text.startsWith('WITH input')));}finally{await f.close();}}
 });
 it('rejects ambient real tenant/SQL/window scopes and foreign owner keys before entering the private port',async()=>{
  const f=await open(),scope=require('../lib/storage/tenant-scope'),previous=scope.getTenancyMode();scope.setTenancyMode('multi');try{await f.store.own(()=>{});await f.store.admit([f.A,f.B]);await assert.rejects(scope.withTenant(f.A,()=>f.store.observe(f.A,'clock','2')),/AMBIENT_TRANSACTION/);assert.equal(f.store.available,true);const protocol=require('./fixtures/operation-window-runtime-protocol')();try{await protocol.window.ready();await assert.rejects(protocol.window.run(f.A,()=>f.store.observe(f.A,'clock','2')),/LIFECYCLE_WINDOW_AMBIENT_SCOPE/);}finally{await protocol.window.close();}await f.store.close();const owner=await f.connection.holdAdvisoryLock('17',()=>{});try{await assert.rejects(owner.openIntakeReceipts(f.profile),/OWNER_KEY/);}finally{await owner.close();}}finally{scope.setTenancyMode(previous);await f.close();}
 });
 it('freezes queued observations and refuses empty/foreign/over64/invalid source batches before queue/SQL',async()=>{
  const f=await open();try{await f.store.own(()=>{});await f.store.admit([f.A,f.B]);const n=f.calls.length;for(const observations of [[],[{tenant:'33333333-3333-4333-8333-333333333333',observed:{clock:'2'}}],Array(65).fill({tenant:f.A,observed:{clock:'2'}}),[{tenant:f.A,observed:{clock:'9223372036854775808'}}]])await assert.rejects(f.store.observeMany(observations));assert.equal(f.calls.length,n);
   let release,reached;const gate=new Promise(r=>{release=r;}),entered=new Promise(r=>{reached=r;});f.state.beforeCommit=async()=>{reached();await gate;};const first=f.store.observe(f.A,'clock','2');await entered;const observations=[{tenant:f.B,observed:{clock:'3'}}],second=f.store.observeMany(observations);observations[0].observed.clock='4';release();await first;await second;assert.equal(f.rows.get(f.B).work_observed[0],'3');
  }finally{await f.close();}
 });
});

// Source/driver controls deliberately do not interpret or claim PL/pgSQL.
function altered(relative,needle,replacement){
 const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve(relative),source=fs.readFileSync(file,'utf8');assert.equal(source.split(needle).length,2,'unique source ablation');const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));compiled._compile(source.replace(needle,replacement),file);return compiled.exports;
}
describe('sole-intake meaningful DB-free controls and SQL source contract',()=>{
 it('original unselected observer reaches COMMIT without owner (criterion RED); explicit intake source refuses before owner (restored criterion GREEN)',async()=>{
  const f=fixture.create(),connection=await require('../lib/storage/postgres-connection')(f.options),legacy=require('../lib/pgstream/checkpoint').create({connection,namespace:f.profile.binding.namespace,consumer:f.profile.binding.consumer,maxBytes:1000,timeIntervalMs:1000,typed:true});
  try{for(const row of f.rows.values()){row.contract_digest=legacy.digest;row.work_owner_ordinal=null;row.work_assignment_revision=null;}async function criterion(observe){await assert.rejects(observe,/INTAKE_UNAVAILABLE/);}
   await assert.rejects(criterion(()=>legacy.observe(f.A,'clock','2')),{code:'ERR_ASSERTION'});assert(f.calls.some(c=>c.text==='COMMIT'));const selected=storeModule.create({connection,profile:f.profile});try{await criterion(()=>selected.observe(f.A,'clock','2'));}finally{await selected.close();}
  }finally{await connection.end();await f.window.close();await f.canonical.window.close();}
 });
 it('removing the actual final no-op assertion makes its expected-refusal criterion RED, restored code GREEN',async()=>{
  const id=require.resolve('../lib/pgstream/intake-receipts'),original=require(id),broken=altered('../lib/pgstream/intake-receipts','await verify();return result;','return result;');
  async function criterion(exports){require.cache[id].exports=exports;const f=await open();try{await f.store.own(()=>{});await f.store.admit([f.A,f.B]);f.state.failAssert=2;await assert.rejects(f.store.observe(f.A,'clock','1'),/SYNTHETIC_SQL_INTAKE_REFUSAL/);assert.equal(f.hints.length,0);}finally{await f.close();require.cache[id].exports=original;}}
  await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(original);
 });
 it('removing the actual owner-key binding makes wrong-resource refusal RED, restored code GREEN',async()=>{
  const broken=altered('../lib/storage/postgres-connection',"if (selected.ownerKey !== key) throw new Error('PGSTREAM_INTAKE_OWNER_KEY');",'');
  async function criterion(creator){const f=fixture.create(),connection=await creator(f.options),owner=await connection.holdAdvisoryLock('17',()=>{});try{await assert.rejects(owner.openIntakeReceipts(f.profile),/OWNER_KEY/);}finally{await owner.close();await connection.end();await f.window.close();await f.canonical.window.close();}}
  await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(require('../lib/storage/postgres-connection'));
 });
 it('SQL source contract fixes the profile, real-role/backend/xid/resource/config and legal transition checks before the unchanged worker branch',()=>{
  const b=candidate.build({...fixture.options,intakeProfile:p()}),s=b.intakeAssertBody,e=b.effectBody;
  for(const token of ["current_user<>'intake_writer'","context->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text","context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text","PGSTREAM_INTAKE_OWNER_REQUIRED","PGSTREAM_INTAKE_SHARED_REQUIRED","PGSTREAM_INTAKE_CONFIGURATION_CHANGED","installed.profile IS DISTINCT FROM",p().digest,p().contractDigest])assert(s.includes(token),token);
  for(const token of ['PGSTREAM_INTAKE_IMMUTABLE','PGSTREAM_INTAKE_VECTOR_TRANSITION','PGSTREAM_INTAKE_DERIVED_TRANSITION','NEW.delivery_ack_revision','NEW.output_restore_generation','NEW.contract_digest','NEW.work_assignment_revision','NEW.work_observed_at[i] IS DISTINCT FROM OLD.work_observed_at[i]'])assert(e.includes(token),token);
  assert(s.indexOf('PGSTREAM_INTAKE_ROSTER_REFUSED')<s.indexOf('FOR subject IN'));assert(s.includes("jsonb_array_length(context->'tenants') NOT BETWEEN 1 AND 64"));assert(!s.includes('pool_membership'));assert(!s.includes('FOR SHARE'));assert(!s.includes('UPDATE '));assert(!s.includes('restoreGeneration'));
  assert(e.indexOf('PGSTREAM_INTAKE_IMMUTABLE')<e.indexOf('EVALUATOR_ASSIGNED_IMMUTABLE'));
 });
 it('SQL source contract refuses absent prior setting before mutation, iterates real tenants and restores exact prior string on both success/error; restoration ablation RED',()=>{
  const s=candidate.build({...fixture.options,intakeProfile:p()}).intakeAssertBody;
  function criterion(source){const requirePrior=source.indexOf('PGSTREAM_INTAKE_UNINITIALIZED_TENANT_SETTING'),loop=source.indexOf("FOR subject IN SELECT jsonb_array_elements_text(context->'tenants')"),set=source.indexOf("set_config('app.current_tenant_id',subject,true)"),lookup=source.indexOf('WHERE tenant_id=subject::uuid'),success=source.indexOf("set_config('app.current_tenant_id',prior_tenant,true)"),handler=source.indexOf('EXCEPTION WHEN OTHERS THEN'),failure=source.lastIndexOf("set_config('app.current_tenant_id',prior_tenant,true)");assert(requirePrior>0&&requirePrior<loop&&loop<set&&set<lookup&&lookup<success&&success<handler&&handler<failure,'EXACT_REAL_TENANT_GUC_RESTORE_REQUIRED');assert(source.includes("IF NOT FOUND OR lifetime_phase NOT IN ('active','suspended')"));assert(source.slice(failure).includes('RAISE;'));}
  criterion(s);assert.throws(()=>criterion(s.replace("  PERFORM set_config('app.current_tenant_id',prior_tenant,true);\n EXCEPTION",' EXCEPTION')),/EXACT_REAL_TENANT_GUC_RESTORE_REQUIRED/);criterion(s);
 });
 it('bounds all SQL/input authority, keeps intake contract writes absent and rejects unsafe profile-selected output/default observation',async()=>{
  const plan=grants.build(p()).join('\n');assert(!grants.UPDATES.includes('contract_digest'));assert(!grants.UPDATES.includes('work_version'));assert(!plan.includes('FOR SHARE'));assert(!plan.includes('GRANT UPDATE ON'));assert(!plan.includes('tenant_write_clock'));assert(plan.includes('AS RESTRICTIVE'));assert(plan.includes('AS PERMISSIVE'));assert.deepEqual(grants.CONTROL_READS.tenant_lifecycle_windows,require('../lib/tenant-lifecycle/operation-window-readiness').layouts.tenant_lifecycle_windows.map(c=>c[0]));assert(!plan.includes('GRANT UPDATE ON "intake_control"'));assert(plan.includes('GRANT SELECT ON "intake_control".tenant_lifecycle_operations'));
  const selected=require('../lib/pgstream/checkpoint').create({connection:{},namespace:fixture.options.namespace,consumer:fixture.options.consumer,maxBytes:1000,timeIntervalMs:1000,typed:true,intakeProfile:p()});assert.equal(selected.digest,p().contractDigest);await assert.rejects(selected.observe(fixture.A,'clock','2'),/WORKER_OBSERVATION_REFUSED/);await assert.rejects(selected.own(()=>{}),/READER_ONLY/);assert.throws(()=>require('../lib/pgstream/checkpoint').create({connection:{},namespace:fixture.options.namespace,consumer:fixture.options.consumer,maxBytes:1000,timeIntervalMs:1000,intakeProfile:p()}),/TYPED_REQUIRED/);
 });
});
describe('actual selected window required by intake source',()=>{
 it('refuses omitted, unbranded and wrong-namespace windows before opening receipts',async()=>{
  for(const kind of ['absent','fake','foreign']){const f=fixture.create();let connection,owner;try{
   if(kind==='absent')delete f.options.operationWindow;
   if(kind==='fake')f.options.operationWindow={namespace:f.profile.binding.lifecycleNamespace,acquireClient:async()=>{},assertClient:async()=>{}};
   if(kind==='foreign')f.options.operationWindow=f.canonical.window;
   connection=await require('../lib/storage/postgres-connection')(f.options);owner=await connection.holdAdvisoryLock(f.profile.ownerKey,()=>{});await assert.rejects(owner.openIntakeReceipts(f.profile),/ACTUAL_WINDOW_REQUIRED/);assert(!f.calls.some(c=>c.text.includes('intake-role')));
  }finally{await owner?.close();await connection?.end();await f.window.close();await f.canonical.window.close();}}
 });
 it('removing actual window branding makes a fake-window refusal criterion RED; restored source GREEN',async()=>{
  const broken=altered('../lib/storage/postgres-connection',"if (!operationWindows.isWindow(operationWindow) || operationWindow.namespace !== selected.binding.lifecycleNamespace) throw new Error('PGSTREAM_INTAKE_ACTUAL_WINDOW_REQUIRED');",'');
  async function criterion(creator){const f=fixture.create();f.options.operationWindow={namespace:f.profile.binding.lifecycleNamespace,acquireClient:async()=>{},assertClient:async()=>{}};let connection,owner;try{connection=await creator(f.options);owner=await connection.holdAdvisoryLock(f.profile.ownerKey,()=>{});await assert.rejects(owner.openIntakeReceipts(f.profile),/ACTUAL_WINDOW_REQUIRED/);}finally{await owner?.close();await connection?.end();await f.window.close();await f.canonical.window.close();}}
  await assert.rejects(criterion(broken),{code:'ERR_ASSERTION'});await criterion(require('../lib/storage/postgres-connection'));
 });
});
describe('intake exact transaction outcome and close boundaries',()=>{
 it('keeps known ROLLBACK separate from unknown COMMIT and never hints or reacquires after refusal',async()=>{
  const f=await open();try{await f.store.own(()=>{});await f.store.admit([f.A,f.B]);const before=copy(f.rows.get(f.A));f.state.commit='refuse';await assert.rejects(f.store.observe(f.A,'clock','2'),e=>e.message==='PGSTREAM_INTAKE_COMMIT_UNCONFIRMED'&&e.commitOutcome==='aborted');assert.deepEqual(f.rows.get(f.A),before);assert.deepEqual(f.hints,[]);await assert.rejects(f.store.own(()=>{}),/OWNER_STATE/);}finally{await f.close();}
 });
 it('withdraws after window closure, preserving a received COMMIT as committed rather than inventing uncertainty',async()=>{
  const f=await open();try{await f.store.own(()=>{});await f.store.admit([f.A,f.B]);f.state.beforeCommit=()=>f.window.close();await assert.rejects(f.store.observe(f.A,'clock','2'),e=>e.message==='PGSTREAM_INTAKE_ACTUAL_WINDOW_REQUIRED'&&e.commitOutcome==='committed');assert.equal(f.store.available,false);assert.equal(f.rows.get(f.A).work_observed[0],'2');assert.deepEqual(f.hints,[]);}finally{await f.close();}
 });
 it('withdraws immediately on actual held-client error before callbacks and does not enter another transaction',async()=>{
  const f=await open();try{let seen;await f.store.own(()=>{seen=f.store.available;});await f.store.admit([f.A,f.B]);const before=f.calls.length;f.clients[0].emit('error',new Error('SYNTHETIC_INTAKE_TRANSPORT_LOSS'));assert.equal(seen,false);assert.equal(f.store.available,false);await assert.rejects(f.store.observe(f.A,'clock','2'),/UNAVAILABLE/);assert.equal(f.calls.length,before);assert.deepEqual(f.hints,[]);}finally{await f.close();}
 });
});
