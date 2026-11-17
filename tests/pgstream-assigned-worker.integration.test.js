'use strict';
// Independent worker processes, actual held pg backends and typed output SQL.
// Lifecycle authority and full preview wiring are qualified by their own suites.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),{fork}=require('node:child_process');
const {optInSuite}=require('./support/opt-in');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
optInSuite(!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'disposable NS_TEST_POSTGRES_ADMIN_URI')('fixed assigned workers on independent processes',function(){
 this.timeout(20000);let admin,namespace,role,uri,table;const actors=[];
 before(async()=>{
  admin=new(require('pg').Client)({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI});await admin.connect();
  namespace='assigned_'+crypto.randomBytes(6).toString('hex');role=namespace+'_worker';table='"'+namespace+'".tenant_consumer_checkpoint';
  await require('../lib/migrations/postgres').run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace,catalogue:require('../migrations/candidates/postgres-evaluator-work-v2.json')});
  const secret=crypto.randomBytes(24).toString('hex');await admin.query('CREATE ROLE "'+role+'" LOGIN PASSWORD \''+secret+'\'');
  const endpoint=new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);endpoint.username=role;endpoint.password=secret;uri=endpoint.toString();
  await admin.query('GRANT USAGE ON SCHEMA "'+namespace+'" TO "'+role+'"');await admin.query('GRANT SELECT,UPDATE ON '+table+' TO "'+role+'"');
  await admin.query('CREATE POLICY assigned_metadata ON '+table+' TO "'+role+'" USING (consumer=\'evaluator-assigned-completed\') WITH CHECK (consumer=\'evaluator-assigned-completed\')');
  const digest=require('node:crypto').createHash('sha256').update(require('../lib/server/serve/evaluator-runtime').canonical(['evaluator-work-v2',namespace,'evaluator-assigned'])).digest('hex');
  for(const tenant of [A,B])await admin.query('INSERT INTO '+table+' (tenant_id,consumer,contract_digest,checkpoint) VALUES ($1,$2,$3,0)',[tenant,'evaluator-assigned-completed',digest]);
 });
 function actor(){
  const child=fork(path.join(__dirname,'fixtures/assigned-worker-process.js'),[],{env:{...process.env,NS_ASSIGNED_WORKER_URI:uri},stdio:['ignore','ignore','ignore','ipc']});actors.push(child);let seq=0;const pending=new Map(),events=[];
  child.on('message',message=>{if(message.event){events.push(message);return;}const promise=pending.get(message.id);if(!promise)return;pending.delete(message.id);clearTimeout(promise.timer);if(message.error)promise.reject(Object.assign(new Error(message.error.message),message.error));else promise.resolve(message.value);});
  const call=(op,args={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('WORKER_REPLY_TIMEOUT'));},10000);pending.set(id,{resolve,reject,timer});child.send({id,op,...args});});
  return {child,call,async held(){for(let i=0;i<200;i++){if(events.some(e=>e.event==='held'))return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('WORKER_HOLD_NOT_REACHED');},async close(){await call('close').catch(()=>{});child.disconnect();}};
 }
 after(async()=>{for(const child of actors){if(child.connected)child.disconnect();if(child.exitCode===null)child.kill('SIGTERM');}if(admin){await admin.query('DROP SCHEMA IF EXISTS "'+namespace+'" CASCADE');await admin.query('DROP ROLE IF EXISTS "'+role+'"');await admin.end();}});
 it('keeps disjoint work independent, rejects overlap, replaces a failed backend and refuses its stale completion',async()=>{
  const global=actor(),blocked=actor();try{await global.call('open',{namespace,tenants:[A,B],global:true});await assert.rejects(blocked.call('open',{namespace,tenants:[A]}),/OWNER_CONFLICT/,'GLOBAL_OWNER_EXCLUDES_ASSIGNED');}finally{await blocked.close();await global.close();}
  const left=actor(),right=actor();try{
   const l=await left.call('open',{namespace,tenants:[A]}),r=await right.call('open',{namespace,tenants:[B]});assert.notEqual(l.pid,r.pid,'INDEPENDENT_WORKER_PROCESSES');
   await admin.query('UPDATE '+table+' SET work_observed=ARRAY[NULL,NULL,NULL,NULL,NULL,1]::bigint[],work_observed_at=ARRAY[NULL,NULL,NULL,NULL,NULL,1]::bigint[],work_pending_at=1');
   assert.deepEqual((await left.call('work')).map(row=>row.tenant),[A]);assert.deepEqual((await right.call('work')).map(row=>row.tenant),[B]);
   await assert.rejects(left.call('begin',{tenant:B}),/FOREIGN_TENANT/);
   const mixed=actor();try{await assert.rejects(mixed.call('open',{namespace,tenants:[A,B],global:true}),/OWNER_CONFLICT/,'ASSIGNED_OWNERS_EXCLUDE_GLOBAL');}finally{await mixed.close();}
   const duplicate=actor();try{await assert.rejects(duplicate.call('open',{namespace,tenants:[A,B,C]}),/OWNER_CONFLICT/);}finally{await duplicate.close();}
   const freeKey=require('../lib/pgstream/assigned-worker').configure({tenants:[C],currentGeneration:()=>1},{namespace,consumer:'evaluator-assigned'}).key[0];
   assert.equal((await admin.query('SELECT pg_try_advisory_lock($1::bigint) AS held',[freeKey])).rows[0].held,true,'PARTIAL_ROSTER_LOCKS_RELEASED');await admin.query('SELECT pg_advisory_unlock($1::bigint)',[freeKey]);
   const stale=left.call('complete',{tenant:A,marker:'stale',hold:true});stale.catch(()=>{});await left.held();
   await right.call('complete',{tenant:B,marker:'healthy'});
   assert.equal((await admin.query('SELECT output_revision FROM '+table+' WHERE tenant_id=$1',[B])).rows[0].output_revision,'1','HEALTHY_NEIGHBOR_PROGRESS');
   const backends=(await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",['assigned-worker-'+l.pid])).rows;assert.equal(backends.length,1);
   await admin.query('SELECT pg_terminate_backend($1)',[backends[0].pid]);
   const replacement=actor();try{await replacement.call('open',{namespace,tenants:[A]});await replacement.call('complete',{tenant:A,marker:'replacement'});await left.call('release');await assert.rejects(stale,error=>error.code==='POSTGRES_OPERATIONAL_OWNER_LOST'||error.causeCode==='POSTGRES_OPERATIONAL_OWNER_LOST','STALE_OWNER_TRANSACTION_REFUSED');const output=(await admin.query('SELECT projection->0->\'output\'->\'result\'->\'properties\' AS value FROM '+table+' WHERE tenant_id=$1',[A])).rows[0].value;assert.equal(output.synthetic,'replacement','STALE_OUTPUT_REFUSED');await replacement.call('generation',{generation:'2'});await assert.rejects(replacement.call('complete',{tenant:A,marker:'old-restore'}),/RESTORE_REFUSED/);}finally{await replacement.close();}
  }finally{await left.close();await right.close();}
 });
 it('control: per-process lock keys permit overlapping owners; the actual overlap criterion turns red and restores',async()=>{
  async function criterion(brokenKeys){const first=actor(),second=actor();try{await first.call('open',{namespace,tenants:[A],brokenKeys});await assert.rejects(second.call('open',{namespace,tenants:[A],brokenKeys}),/OWNER_CONFLICT/,'OVERLAPPING_ASSIGNMENT_MUST_REFUSE');}finally{await first.close();await second.close();}}
  await assert.rejects(criterion(true),error=>error.code==='ERR_ASSERTION'&&error.message.includes('OVERLAPPING_ASSIGNMENT_MUST_REFUSE'));await criterion(false);
 });
 it('control: removing the shared global key permits mixed owners; mixed-owner refusal turns red and restores',async()=>{
  async function criterion(brokenShared){const first=actor(),second=actor();try{await first.call('open',{namespace,tenants:[A],global:true});await assert.rejects(second.call('open',{namespace,tenants:[A],brokenShared}),/OWNER_CONFLICT/,'MIXED_OWNERS_MUST_REFUSE');}finally{await first.close();await second.close();}}
  await assert.rejects(criterion(true),error=>error.code==='ERR_ASSERTION'&&error.message.includes('MIXED_OWNERS_MUST_REFUSE'));await criterion(false);
 });

 it('static slices: one held owner excludes duplicate and mixed K, and a lost backend cannot overwrite its same-ordinal replacement',async()=>{
  const left=actor(),right=actor(),mixed=actor(),duplicate=actor();
  const shape={count:2,ordinal:0};
  try{
   const l=await left.call('open',{namespace,tenants:[A],slice:shape});assert.deepEqual(l.assignment.slice,shape);await right.call('open',{namespace,tenants:[B],slice:{count:2,ordinal:1}});
   await assert.rejects(duplicate.call('open',{namespace,tenants:[A],slice:shape}),/OWNER_CONFLICT/,'STATIC_DUPLICATE_MUST_REFUSE');
   await assert.rejects(mixed.call('open',{namespace,tenants:[B],slice:{count:3,ordinal:0}}),/MIXED_LAYOUT_REFUSED/,'MIXED_K_MUST_REFUSE');
   await admin.query('UPDATE '+table+' SET work_observed=ARRAY[NULL,NULL,NULL,NULL,NULL,1]::bigint[],work_observed_at=ARRAY[NULL,NULL,NULL,NULL,NULL,1]::bigint[],work_completed=ARRAY[NULL,NULL,NULL,NULL,NULL,NULL]::bigint[],work_pending_at=1');
   const stale=left.call('complete',{tenant:A,marker:'static-stale',hold:true});stale.catch(()=>{});await left.held();
   await right.call('complete',{tenant:B,marker:'static-healthy'});
   const backends=(await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='idle in transaction'",['assigned-worker-'+l.pid])).rows;assert.equal(backends.length,1);await admin.query('SELECT pg_terminate_backend($1)',[backends[0].pid]);
   const replacement=actor();try{await replacement.call('open',{namespace,tenants:[A],slice:shape});await replacement.call('complete',{tenant:A,marker:'static-replacement'});await left.call('release');await assert.rejects(stale,error=>error.code==='POSTGRES_OPERATIONAL_OWNER_LOST'||error.causeCode==='POSTGRES_OPERATIONAL_OWNER_LOST'||error.message==='EVALUATOR_OWNER_UNAVAILABLE'||error.causeMessage==='EVALUATOR_OWNER_UNAVAILABLE','STATIC_STALE_OWNER_MUST_REFUSE');const output=(await admin.query("SELECT projection->0->'output'->'result'->'properties' AS value FROM "+table+' WHERE tenant_id=$1',[A])).rows[0].value;assert.equal(output.synthetic,'static-replacement','STATIC_REPLACEMENT_OUTPUT_PRESERVED');}finally{await replacement.close();}
  }finally{await Promise.allSettled([left.close(),right.close(),mixed.close(),duplicate.close()]);}
 });
 it('control: process-specific static resource identities permit overlapping owners; exact duplicate criterion turns red and restores',async()=>{
  async function criterion(brokenStaticKeys){const first=actor(),second=actor();try{const args={namespace,tenants:[A],slice:{count:2,ordinal:0},brokenStaticKeys};await first.call('open',args);await assert.rejects(second.call('open',args),/OWNER_CONFLICT/,'STATIC_OVERLAP_MUST_REFUSE');}finally{await Promise.allSettled([first.close(),second.close()]);}}
  await assert.rejects(criterion(true),e=>e.code==='ERR_ASSERTION'&&e.message.includes('STATIC_OVERLAP_MUST_REFUSE'));await criterion(false);
 });

});
