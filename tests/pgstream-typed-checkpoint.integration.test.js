'use strict';
const assert=require('node:assert/strict');
const {optInSuite}=require('./support/opt-in');
const {create,WORK_COLUMNS}=require('../lib/pgstream/checkpoint');
const {run}=require('../lib/migrations/postgres');
const scope=require('../lib/storage/tenant-scope');
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI,'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('typed evaluator receipts and output handoff on actual PostgreSQL',function(){
 this.timeout(30000);const lab=require('./fixtures/tenant-projection-evaluator')();let store,table;
 before(async()=>{await lab.open();table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint';await run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:lab.replayNamespace,catalogue:require('../migrations/candidates/postgres-evaluator-work-v2.json')});await lab.admin.query('GRANT UPDATE('+WORK_COLUMNS.join(',')+') ON '+table+' TO "'+lab.readerRole+'"');await lab.admin.query('CREATE POLICY typed_receipts ON '+table+' TO "'+lab.readerRole+'" USING (consumer=\'evaluator-typed-completed\') WITH CHECK (consumer=\'evaluator-typed-completed\')');});
 beforeEach(async()=>{await lab.reset();store=create({connection:lab.reader,namespace:lab.replayNamespace,consumer:'evaluator-typed',maxBytes:4194304,timeIntervalMs:60000,typed:true});for(const tenant of [lab.A,lab.B])await lab.provision(store.consumer,tenant,null,0,store.digest);await store.own(()=>{});await store.admit([lab.A,lab.B]);});
 afterEach(async()=>{await store?.close();});after(()=>lab.close());
 const result=()=>({checkpoint:1,trigger:'acquisition',properties:{bgnow:123},emitted:[],requested:[],encodedRows:[{synthetic:'x'.repeat(32768)}],frame:{sgvs:[{mgdl:123}],lastUpdated:10},due:{dueAt:8572.42857142857,slow:[]}});
 const row=async tenant=>(await lab.admin.query('SELECT * FROM '+table+' WHERE consumer=$1 AND tenant_id=$2',[store.consumer,tenant])).rows[0];
 it('commits exact source versions and control outbox while tenant work is suspended',async()=>{await store.observe(lab.A,'clock','9007199254740993');await store.observe(lab.B,'activity','1',false);assert.deepEqual(await store.begin(lab.A),{clock:'9007199254740993'});assert.equal((await row(lab.B)).work_enabled,false);assert.equal((await row(lab.B)).delivery_revision,'1','CONTROL_COMMITS_DELIVERY_OBLIGATION');assert.equal((await row(lab.A)).delivery_revision,'0');assert.deepEqual((await store.work()).map(r=>r.tenant),[lab.A]);});
 it('atomically separates typed progress from immutable output and advances durable handoff once',async()=>{await store.observe(lab.A,'clock','1');const first=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'1'},identity:'a'.repeat(64),restoreGeneration:'9007199254740993',result:result()}));const stored=await row(lab.A);assert.equal(stored.work_due_at,'8573');assert.equal(stored.output_restore_generation,'9007199254740993');assert.deepEqual(Object.keys(stored.projection[0]).sort(),['kind','output']);assert(!Object.hasOwn(stored.projection[0].output,'outputRevision'));assert.equal(stored.delivery_revision,'1');assert.equal(first.deliveryPending,true);await store.observe(lab.A,'clock','2');const next=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'2'},identity:'a'.repeat(64),restoreGeneration:'9007199254740993',result:result(),retainedOutput:first.output}));assert.equal(next.changed,false);assert.equal(next.output,first.output);const saved=await row(lab.A);assert.deepEqual(saved.projection,stored.projection);assert.equal(saved.delivery_revision,'1');assert.equal(next.deliveryPending,false,'UNCHANGED_OUTPUT_IS_NO_NEW_OBLIGATION');assert.equal(saved.delivery_ack_revision,'0','EVALUATOR_WRITES_NO_DELIVERY_ACK');});
 // M1 (lib/metrics): a completion reports the writer's durable mark of the
 // oldest owed input only when it covers that input.
 it('reports coveredAt only when the completion covers the oldest owed input',async()=>{await store.observe(lab.A,'clock','1');const pending=Number((await row(lab.A)).work_pending_at);assert(Number.isSafeInteger(pending)&&pending>0);const first=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'1'},identity:'a'.repeat(64),result:result()}));assert.equal(first.coveredAt,pending,'COVERED_MARK');assert.equal(first.pendingAt,null);await store.observe(lab.A,'clock','2');const second=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'1'},identity:'a'.repeat(64),result:result(),retainedOutput:first.output}));assert.equal(second.coveredAt,null,'UNCOVERED_INPUT_REPORTED_COVERED');assert.equal(second.pendingAt,Number((await row(lab.A)).work_pending_at));});
 it('reuses only the current immutable revision, rejecting tampered retained fields',async()=>{await store.observe(lab.A,'clock','1');const first=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'1'},identity:'a'.repeat(64),result:result()}));assert.equal(await store.output(lab.A,'a'.repeat(64),{retained:first.output}),first.output);for(const mutate of [o=>({...o,inputCheckpoint:99}),o=>({...o,frame:{...o.frame,lastUpdated:99}}),o=>({...o,rows:[]})]){const hint=mutate(first.output);const output=await store.output(lab.A,'a'.repeat(64),{retained:hint});assert.notEqual(output,hint);assert.deepEqual(output,first.output);}await store.observe(lab.A,'activity','1',false);await assert.rejects(store.output(lab.A,'a'.repeat(64)),/CONTROL_PENDING/);});
 // The runtime's cold loadOutput: one statement, so a completion landing
 // between two reads cannot label one revision's body with another's version.
 it('reads a cold output in one statement from one snapshot',async()=>{
  const queries=[];let between=null;
  const reader={...lab.reader,async query(text,values){const result=await lab.reader.query(text,values);if(String(text).includes('tenant_consumer_checkpoint')){queries.push(text);if(between){const step=between;between=null;await step();}}return result;}};
  await store.close();store=create({connection:reader,namespace:lab.replayNamespace,consumer:'evaluator-typed',maxBytes:4194304,timeIntervalMs:60000,typed:true});await store.own(()=>{});await store.admit([lab.A,lab.B]);
  await store.observe(lab.A,'clock','1');const one=result();delete one.encodedRows;
  const first=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'1'},identity:'a'.repeat(64),result:one}));
  queries.length=0;const cold=await store.output(lab.A,'a'.repeat(64));
  assert.equal(queries.length,1,'COLD_OUTPUT_ONE_STATEMENT');assert.deepEqual(cold.frame,one.frame);assert.equal(cold.outputRevision,first.output.outputRevision);
  await store.observe(lab.A,'clock','2');const two={...result(),properties:{bgnow:150},frame:{sgvs:[{mgdl:150}],lastUpdated:20}};delete two.encodedRows;
  let second;between=()=>scope.withTenant(lab.A,async()=>{second=await store.complete(lab.A,{observed:{clock:'2'},identity:'a'.repeat(64),result:two});});
  const raced=await store.output(lab.A,'a'.repeat(64));
  assert(second?.changed,'COMPLETION_INTERLEAVED_AFTER_FIRST_STATEMENT');
  const body=raced.outputRevision===first.output.outputRevision?one:two;
  assert.deepEqual(raced.frame,body.frame,'COLD_OUTPUT_TORN_ACROSS_REVISIONS');assert.deepEqual(raced.result.properties,body.properties);
 });
 it('persists and reuses row-free clinical completion through cold output recovery',async()=>{
  await store.observe(lab.A,'clock','1');const clinical=result();delete clinical.encodedRows;
  const first=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'1'},identity:'a'.repeat(64),result:clinical}));
  const stored=(await row(lab.A)).projection[0].output;
  assert.equal(Object.hasOwn(stored,'rows'),false,'STREAM_OUTPUT_MUST_NOT_PERSIST_RAW_PROJECTION');assert.deepEqual(stored.frame,clinical.frame);
  const cold=await store.output(lab.A,'a'.repeat(64));assert.deepEqual(cold.frame,clinical.frame);assert.equal(cold.rows,undefined);
  assert.equal(await store.output(lab.A,'a'.repeat(64),{retained:cold}),cold,'ROW_FREE_OUTPUT_MUST_RETAIN_VALID_CONTENT_DIGEST');
  const same=await scope.withTenant(lab.A,()=>store.complete(lab.A,{observed:{clock:'1'},identity:'a'.repeat(64),result:clinical,retainedOutput:cold}));
  assert.equal(same.changed,false);assert.equal(same.output,cold);assert.deepEqual((await row(lab.A)).projection[0].output,stored);
 });
 it('detects a removed actual typed UPDATE grant and succeeds only after restoration',async()=>{await lab.admin.query('REVOKE UPDATE(work_observed) ON '+table+' FROM "'+lab.readerRole+'"');try{await assert.rejects(store.observe(lab.A,'clock','1'),error=>error.code==='42501');assert.deepEqual(await store.begin(lab.A),{});}finally{await lab.admin.query('GRANT UPDATE(work_observed) ON '+table+' TO "'+lab.readerRole+'"');}await store.observe(lab.A,'clock','1');assert.deepEqual(await store.begin(lab.A),{clock:'1'});});
 // Prototype compatibility is retired: preserve old data on refusal, never promote it.
 it('refuses nonempty old work without transferring or altering its payload',async()=>{
  const state={kind:'evaluator-work-v1',output:{synthetic:'x'.repeat(1048576)}};
  await lab.admin.query('UPDATE '+table+' SET work_version=0,projection=$2::jsonb WHERE tenant_id=$1 AND consumer=$3',[lab.A,JSON.stringify([state]),store.consumer]);
  const before=await row(lab.A);let transferred=0;
  const pool={async connect(){return {async query(...args){const result=await lab.admin.query(...args);if(String(args[0]).startsWith('SELECT tenant_id'))transferred+=Buffer.byteLength(JSON.stringify(result.rows));return result;},release(){}};}};
  await assert.rejects(require('../lib/pgstream/work-state').admit({pool,observeBackend:async()=>{},table:lab.replayNamespace+'.tenant_consumer_checkpoint',consumer:store.consumer,digest:store.digest,tenants:[lab.A]}),/EVALUATOR_OUTPUT_CONTRACT/);
  assert(transferred<1024,'ADMISSION_MUST_NOT_TRANSFER_CLINICAL_OUTPUT');assert.deepEqual(await row(lab.A),before);
 });
 it('admits a new live tenant without restarting or rereading the existing roster and caps each admission page',async()=>{
  const tenants=Array.from({length:65},(_,i)=>'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
  await lab.admin.query('INSERT INTO '+table+' (tenant_id,consumer,contract_digest,checkpoint) SELECT tenant,$2,$3,0 FROM unnest($1::uuid[]) AS tenant',[tenants,store.consumer,store.digest]);await assert.rejects(store.begin(tenants[64]),/OUTPUT_CONTRACT/);const pages=[];
  const pool={async connect(){return {async query(...args){if(String(args[0]).startsWith('SELECT tenant_id'))pages.push(args[1][1].length);return lab.admin.query(...args);},release(){}};}};
  await require('../lib/pgstream/work-state').admit({pool,observeBackend:async()=>{},table:lab.replayNamespace+'.tenant_consumer_checkpoint',consumer:store.consumer,digest:store.digest,tenants});assert.deepEqual(pages,[64,1]);assert.deepEqual(await store.begin(tenants[64]),{});await store.observe(tenants[64],'clock','9007199254740993');assert.deepEqual(await store.begin(tenants[64]),{clock:'9007199254740993'});assert.deepEqual(await store.begin(lab.A),{});
 });
 it('commits each control generation as a monotone delivery obligation with no evaluator ACK surface',async()=>{await store.observe(lab.A,'activity','1',true);await store.observe(lab.A,'policy','1');assert.equal((await row(lab.A)).delivery_revision,'2');await store.observe(lab.A,'policy','1');assert.equal((await row(lab.A)).delivery_revision,'2','DUPLICATE_IS_NO_NEW_OBLIGATION');for(const retired of ['deliveries','acknowledge'])assert.equal(store[retired],undefined,'RETIRED '+retired);assert.equal((await row(lab.A)).delivery_ack_revision,'0');});
 // Durable M1 (lane m1-durable, 2026-11-21): the completion UPDATE that clears
 // or raises the writer's mark also counts that mark's lag on the row, so the
 // count commits or rolls back with the mark (lib/pgstream/completion-lag.js).
 describe('durable completion lag on the work row',function(){
  const lagOf=async tenant=>{const r=(await lab.admin.query('SELECT work_pending_at::text AS pending,work_completed_at::text AS completed,lag_count::text AS count,lag_sum_ms::text AS sum,lag_max_ms::text AS max,lag_buckets::text[] AS buckets,lag_over_120s::text AS over,lag_negative::text AS negative FROM '+table+' WHERE consumer=$1 AND tenant_id=$2',[store.consumer,tenant])).rows[0];return {...r,count:Number(r.count),sum:Number(r.sum),max:Number(r.max),buckets:r.buckets.map(Number),over:Number(r.over),negative:Number(r.negative)};};
  const mark=at=>require('../lib/writer-driven').mark((text,values)=>lab.admin.query(text,values),{table,consumer:store.consumer},lab.A,{source:'clock',at});
  const finish=(observed,extra={},target=store)=>scope.withTenant(lab.A,()=>target.complete(lab.A,{observed,identity:'a'.repeat(64),result:result(),...extra}));
  const only=(index,n=1)=>Array.from({length:10},(_,i)=>i===index-1?n:0);
  it('migration 0010 brings a schema built by the previous catalogue forward; existing rows read zero observations',async()=>{
   const current=require('../migrations/candidates/postgres-evaluator-work-v2.json');
   const previous={...current,migrations:current.migrations.filter(m=>m.name!=='0010_evaluator_completion_lag')};
   assert.equal(previous.migrations.length,current.migrations.length-1);assert.equal(current.migrations.at(-1).name,'0010_evaluator_completion_lag');
   const namespace=lab.replayNamespace+'_m1seed',seed='"'+namespace+'".tenant_consumer_checkpoint',uri=process.env.NS_TEST_POSTGRES_ADMIN_URI;
   await lab.admin.query('CREATE SCHEMA "'+namespace+'"');
   try{
    await run('up',{direct:true,connectionString:uri,namespace,catalogue:previous});
    await lab.admin.query(`INSERT INTO ${seed} (tenant_id,consumer,contract_digest,checkpoint,projection,work_version,work_observed,work_completed,work_observed_at,work_pending_at,work_completed_at)
     VALUES ($1,'evaluator-seed-completed',$2,0,'[{"kind":"evaluator-work-v2","output":null}]'::jsonb,2,'{4,NULL,NULL,NULL,NULL,1}','{3,NULL,NULL,NULL,NULL,1}','{7,NULL,NULL,NULL,NULL,1}',7,5)`,[lab.A,'a'.repeat(64)]);
    const columns=async()=>(await lab.admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='tenant_consumer_checkpoint' AND column_name LIKE 'lag\\_%' ORDER BY column_name",[namespace])).rows.map(r=>r.column_name);
    assert.deepEqual(await columns(),[]);
    await run('up',{direct:true,connectionString:uri,namespace,catalogue:current});
    assert.deepEqual(await columns(),[...require('../lib/pgstream/completion-lag').COLUMNS].sort());
    const row=(await lab.admin.query('SELECT work_pending_at::text AS pending,lag_count::text AS count,lag_sum_ms::text AS sum,lag_max_ms::text AS max,lag_buckets::text AS buckets,lag_over_120s::text AS over,lag_negative::text AS negative FROM '+seed)).rows[0];
    assert.deepEqual(row,{pending:'7',count:'0',sum:'0',max:'0',buckets:'{0,0,0,0,0,0,0,0,0,0}',over:'0',negative:'0'},'EXISTING_ROW_DEFAULTS');
    const ledger=async()=>(await lab.admin.query('SELECT name FROM "'+namespace+'".schema_migrations ORDER BY name')).rows.map(r=>r.name);
    assert.equal((await ledger()).at(-1),'0010_evaluator_completion_lag');const applied=(await ledger()).length;
    await run('up',{direct:true,connectionString:uri,namespace,catalogue:current});assert.equal((await ledger()).length,applied,'REPEAT_UP_IS_A_NO_OP');
   }finally{await lab.admin.query('DROP SCHEMA IF EXISTS "'+namespace+'" CASCADE');}
  });
  it('a covering completion counts the lag of the mark it clears, once, from the oldest mark',async()=>{
   const zero=await lagOf(lab.A);assert.deepEqual([zero.count,zero.sum,zero.max,zero.over,zero.negative,zero.buckets],[0,0,0,0,0,only(0)],'NEW_ROW_READS_ZERO');
   const t=Date.now();await mark(t-4000);await mark(t-1000);
   assert.equal((await lagOf(lab.A)).pending,String(t-4000),'MARK_KEEPS_THE_OLDEST');
   const done=await finish(await store.begin(lab.A));const row=await lagOf(lab.A);
   const expected=Number(row.completed)-(t-4000);
   assert.equal(row.pending,null);assert.equal(done.coveredAt,t-4000);
   assert.equal(row.count,1,'COVERING_COMPLETION_NOT_COUNTED_ONCE');
   assert.equal(row.sum,expected,'LAG_FROM_WRONG_MARK '+row.sum+' != '+expected);assert.equal(row.max,expected);assert.equal(done.durableLagMs,expected);
   assert.deepEqual(row.buckets,only(5),'BUCKET '+row.buckets);assert.equal(row.over,0);assert.equal(row.negative,0);
  });
  it('a completion that covers nothing new adds nothing',async()=>{
   await mark(Date.now()-2000);const observed=await store.begin(lab.A);await finish(observed);const first=await lagOf(lab.A);assert.equal(first.count,1);
   await mark(Date.now());const stale=await finish(observed);
   const after=await lagOf(lab.A);assert.notEqual(after.pending,null,'INPUT_STILL_OWED');
   assert.deepEqual([after.count,after.sum,after.max,after.buckets],[first.count,first.sum,first.max,first.buckets],'NON_COVERING_COMPLETION_COUNTED');
   assert.equal(stale.coveredAt,null);assert.equal(stale.durableLagMs,null);
  });
  it('counts over 120 s and a mark ahead of the completion clock (observed as 0)',async()=>{
   await mark(Date.now()-130000);await finish(await store.begin(lab.A));
   let row=await lagOf(lab.A);assert.equal(row.count,1);assert.equal(row.over,1,'OVER_DEADLINE_NOT_COUNTED');assert.deepEqual(row.buckets,only(10));assert(row.max>120000);
   const sum=row.sum;await mark(Date.now()+60000);await finish(await store.begin(lab.A));
   row=await lagOf(lab.A);assert.equal(row.count,2);assert.equal(row.negative,1,'NEGATIVE_NOT_COUNTED');assert.equal(row.sum,sum,'NEGATIVE_ADDED_TO_SUM');assert.deepEqual(row.buckets,[1,0,0,0,0,0,0,0,0,1]);assert.equal(row.over,1);
  });
  it('a COMMIT that fails after the UPDATE leaves both the mark and the lag unchanged',async()=>{
   const fn='"'+lab.replayNamespace+'".m1_fail_at_commit';
   try{
    await mark(Date.now()-3000);const before=await lagOf(lab.A);
    await lab.admin.query('CREATE FUNCTION '+fn+'() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION \'M1_COMMIT_FAILS\'; END$$');
    await lab.admin.query('CREATE CONSTRAINT TRIGGER m1_fail_at_commit AFTER UPDATE ON '+table+' DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.work_pending_at IS DISTINCT FROM OLD.work_pending_at) EXECUTE FUNCTION '+fn+'()');
    await assert.rejects(finish(await store.begin(lab.A)),/M1_COMMIT_FAILS/);
    assert.deepEqual(await lagOf(lab.A),before,'ROLLED_BACK_COMPLETION_CHANGED_THE_ROW');
   }finally{await lab.admin.query('DROP TRIGGER IF EXISTS m1_fail_at_commit ON '+table);await lab.admin.query('DROP FUNCTION IF EXISTS '+fn+'()');}
   await finish(await store.begin(lab.A));assert.equal((await lagOf(lab.A)).count,1,'COUNTED_ONCE_AFTER_THE_TRIGGER_IS_GONE');
  });
  it('a completion fenced by the restore generation counts nothing; the current generation counts once',async()=>{
   const windows='"'+lab.replayNamespace+'".tenant_lifecycle_windows';let fenced;
   try{
    await lab.admin.query('CREATE TABLE '+windows+' (tenant_id uuid PRIMARY KEY, generation bigint NOT NULL, lock_key bigint NOT NULL)');
    await lab.admin.query('GRANT SELECT ON '+windows+' TO "'+lab.readerRole+'"');
    await lab.admin.query('INSERT INTO '+windows+' VALUES ($1,2,4242)',[lab.A]);
    fenced=create({connection:lab.reader,namespace:lab.replayNamespace,consumer:'evaluator-typed',maxBytes:4194304,timeIntervalMs:60000,typed:true,generationFence:{table:windows}});
    await store.close();await fenced.own(()=>{});
    await mark(Date.now()-3000);const before=await lagOf(lab.A);
    await assert.rejects(finish(await fenced.begin(lab.A),{restoreGeneration:'1'},fenced),/EVALUATOR_COMPLETION_RESTORE_REFUSED/);
    assert.deepEqual(await lagOf(lab.A),before,'FENCED_COMPLETION_CHANGED_THE_ROW');
    await finish(await fenced.begin(lab.A),{restoreGeneration:'2'},fenced);
    const row=await lagOf(lab.A);assert.equal(row.pending,null);assert.equal(row.count,1);
   }finally{await fenced?.close();await lab.admin.query('DROP TABLE IF EXISTS '+windows);}
  });
 });
});
