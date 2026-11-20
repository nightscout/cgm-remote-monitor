'use strict';
// Explicit isolated synthetic PostgreSQL socket; no implicit actors or database.
const assert=require('node:assert/strict');
const {Client,Pool}=require('pg');
const {optInSuite}=require('./support/opt-in');
const scope=require('../lib/storage/tenant-scope');
const journal=require('../lib/storage/storage-event-journal');
const sql=require('../lib/storage/clinical-stream-sql');
const identity=require('../lib/storage/storage-event-identity-sql');
const state=require('../lib/storage/clinical-stream-state');
const recoveryFactory=require('../lib/pgstream/snapshot-recovery');
const control=require('./lib/clinical-working-set/control');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',digest='a'.repeat(64),completedDigest='b'.repeat(64);
const enabled=!!process.env.CLINICAL_WINDOW_PG_SOCKET||process.env.NS_CLINICAL_WINDOW_TEST==='1'&&!!process.env.NS_TEST_POSTGRES_ADMIN_URI;
optInSuite(enabled,'CLINICAL_WINDOW_PG_SOCKET or NS_CLINICAL_WINDOW_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('native WAL identity and durable raw delivery independent of clinical cache',function(){
 this.timeout(20000);let db,pool,mode,source,recovery;
 const table='synthetic_raw_work.tenant_consumer_checkpoint',consumer='evaluator-synthetic';
 const limits={maxRows:10,maxBytes:200000};
 before(async()=>{
  mode=scope.getTenancyMode();scope.setTenancyMode('multi');
  const config=process.env.CLINICAL_WINDOW_PG_SOCKET?{host:process.env.CLINICAL_WINDOW_PG_SOCKET,user:'postgres',database:'postgres'}:{connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI};
  db=new Client(config);await db.connect();await db.query("SET output_plugin_libraries='wal2json'");pool=new Pool({...config,max:2});
  await db.query("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='synthetic_storage'");
  await db.query('DROP SCHEMA IF EXISTS synthetic_raw CASCADE;DROP SCHEMA IF EXISTS synthetic_raw_work CASCADE;CREATE SCHEMA synthetic_raw;CREATE SCHEMA synthetic_raw_work');
  for(const domain of ['entries','food','activity']){
   await db.query('CREATE TABLE synthetic_raw.'+domain+' (tenant_id uuid NOT NULL,id_kind text NOT NULL,"_id" text NOT NULL,doc jsonb NOT NULL,storage_bytes bigint NOT NULL DEFAULT 80,PRIMARY KEY(tenant_id,id_kind,"_id"))');
   for(const text of identity.build({namespace:'synthetic_raw',domain}))await db.query(text);
   await identity.assertReady(db,{namespace:'synthetic_raw',domain});
  }
  await db.query('CREATE TABLE '+table+'(tenant_id uuid,consumer text,checkpoint bigint DEFAULT 0,contract_digest text,projection jsonb,delivery_revision bigint DEFAULT 0,PRIMARY KEY(tenant_id,consumer))');
  for(const tenant of [A,B]){
   await db.query('INSERT INTO '+table+'(tenant_id,consumer,contract_digest,projection) VALUES($1,$2,$3,$4)',[tenant,consumer,digest,JSON.stringify([state.empty()])]);
   await db.query('INSERT INTO '+table+'(tenant_id,consumer,contract_digest,projection) VALUES($1,$2,$3,$4)',[tenant,consumer+'-completed',completedDigest,JSON.stringify([{kind:'evaluator-work-v2',output:{frame:{sgvs:[]},rows:[]}}])]);
  }
  await db.query("SELECT * FROM pg_create_logical_replication_slot('synthetic_storage','wal2json')");
  const identify=new Client({...config,replication:'database'});await identify.connect();try{const row=(await identify.query('IDENTIFY_SYSTEM')).rows[0];source={system_id:String(row.systemid),timeline:Number(row.timeline),database:row.dbname,slot:'synthetic_storage'};}finally{await identify.end();}
  const columns={work_version:'integer DEFAULT 2',work_observed:'bigint[]',work_completed:'bigint[]',work_observed_at:'bigint[]',work_pending_at:'bigint',work_due_at:'bigint',work_completed_at:'bigint',work_enabled:'boolean DEFAULT true',work_activity_enabled:'boolean DEFAULT true',work_lifecycle_enabled:'boolean DEFAULT true',delivery_ack_revision:'bigint DEFAULT 0',output_identity:'text',output_digest:'text',output_revision:'bigint DEFAULT 0',output_restore_generation:'bigint'};
  for(const [name,type]of Object.entries(columns))await db.query('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type);
  const connection={async importedSnapshotTransaction(name,fn,{signal,timeoutMs}){
   if(!/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(name))throw new Error('TEST_SNAPSHOT_NAME');
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await db.query("SET TRANSACTION SNAPSHOT '"+name+"'");await db.query("SELECT set_config('statement_timeout',$1,true)",[String(timeoutMs)]);if(signal?.aborted)throw signal.reason;const result=await fn();if(signal?.aborted)throw signal.reason;await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}
  }};
  recovery=recoveryFactory.create({connection,createReplicationClient:()=>new Client({...config,replication:'database'}),createLockClient:()=>new Client(config),namespace:'synthetic_raw_work',consumer,mainSource:source,generation:async()=> 'fixture:1',timeoutMs:5000,maxQueued:4});
  for(const tenant of [A,B])await recovery.withSnapshot({tenant,fn:async boundary=>{const input=state.bootstrap(null,{checkpoint:0,signature:{stamp:0,deleted:0},stream:boundary,rows:[]},limits);await db.query('UPDATE '+table+' SET projection=$3::jsonb WHERE tenant_id=$1 AND consumer=$2',[tenant,consumer,JSON.stringify([input])]);}});

 });
 after(async()=>{try{await recovery?.close();await db?.query("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='synthetic_storage'");}finally{await pool?.end();await db?.end();scope.setTenancyMode(mode);}});
 // Native SQL/storage proof, not a webhook framing qualification. The joined
 // connector/receiver campaign separately proves its transport. This adapter
 // retains the decoder's actual B/C and complete SQL result before acceptance.
 const wal=async()=>{
  const decoded=(await db.query("SELECT data FROM pg_logical_slot_get_changes('synthetic_storage',NULL,NULL,'format-version','2','include-xids','true','include-lsn','true','include-transaction','true','add-tables','synthetic_raw.*')")).rows.map(row=>JSON.parse(row.data));
  let frames;const changes=[];
  for(const row of decoded){
   if(row.action==='B'){frames=[{...row,source_identity:source,transaction_index:0}];continue;}
   if(!frames)throw new Error('NATIVE_WAL_MISSING_BEGIN');
   if(row.action==='C'){
    const envelope={Transaction:[...frames,{...row,source_identity:source,transaction_index:frames.length,transaction_count:frames.length-1}]};
    for(const event of frames.slice(1)){Object.defineProperty(event,'cohort',{value:envelope});changes.push(event);}frames=undefined;
   }else frames.push({...row,transaction_index:frames.length});
  }
  if(frames)throw new Error('NATIVE_WAL_INCOMPLETE_COHORT');return changes;
 };
 const options=envelope=>({pool,observeBackend:async()=>{},table,consumer,envelope,routes:['entries','food','activity'].map(domain=>({schema:'synthetic_raw',table:domain,domain})),expectedSource:source,assertFence:async()=> 'fixture:1',lockKey:tenant=>recoveryFactory.lockKey('synthetic_raw_work',consumer,tenant),snapshotDigest:digest,completedConsumer:consumer+'-completed',completedDigest,...limits,maxTransactionRows:256,maxTransactionBytes:400000});
 const accept=event=>sql.acceptTransaction(options(event.cohort));
 const tail=async(tenant=A)=>(await db.query("SELECT projection->1 AS storage FROM "+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,consumer])).rows[0].storage;
 it('actual FULL WAL includes old public identifier and TOAST document, while unchanged metadata emits no client update',async()=>{
  const large=Array.from({length:300},(_,i)=>require('node:crypto').createHash('sha256').update(String(i)).digest('hex')).join('');
  for(const domain of ['entries','food','activity'])await db.query('INSERT INTO synthetic_raw.'+domain+' VALUES($1,\'string\',$2,$3)',[A,domain+'-old',{_id:domain+'-old',identifier:'public-'+domain,date:1,extension:large}]);
  for(const event of await wal())await accept(event);
  assert.equal((await tail()).events.length,3);
  await db.query('UPDATE synthetic_raw.food SET storage_bytes=90 WHERE tenant_id=$1',[A]);
  const metadata=(await wal())[0];assert(metadata.identity.some(c=>c.name==='doc'),'FULL_OLD_DOC_IN_WAL');assert.deepEqual(journal.changes('food',metadata),[]);
  await accept(metadata);assert.equal((await tail()).events.length,3);
  await db.query('DELETE FROM synthetic_raw.food WHERE tenant_id=$1',[A]);
  const deleted=(await wal())[0];const old=JSON.parse(deleted.identity.find(c=>c.name==='doc').value);assert.equal(old.extension,large,'OLD_TOAST_BYTES_RECOVERABLE');
  await accept(deleted);assert.equal((await tail()).events.at(-1).value.identifier,'public-food');
 });
 it('replays accepted equal-LSN distinct COPY rows exactly, survives cold state, and preserves neighbor/source isolation',async()=>{
  const copy=new (require('pg').Query)('COPY synthetic_raw.activity(tenant_id,id_kind,"_id",doc) FROM STDIN');
  copy.handleCopyInResponse=connection=>{connection.sendCopyFromChunk(Buffer.from(Array.from({length:3},(_,i)=>B+'\tstring\tcopy-'+i+'\t'+JSON.stringify({_id:'copy-'+i,identifier:'public-copy-'+i})).join('\n')+'\n'));connection.endCopyFrom();};
  await new Promise((resolve,reject)=>{copy.once('end',resolve);copy.once('error',reject);db.query(copy);});
  const events=await wal();assert.equal(events.length,3);assert.equal(new Set(events.map(e=>e.lsn)).size,1,'ACTUAL_MULTI_INSERT_EQUAL_LSN');
  for(const event of events)await accept(event);
  const before=await tail(B);for(const event of events)await accept(event);assert.deepEqual(await tail(B),before);
  assert.equal(before.events.length,3);assert.equal((await tail(A)).events.length,4);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM synthetic_raw.entries')).rows[0].n,1,'CLINICAL_CACHE_CANNOT_DELETE_HISTORY');
 });
 it('RED/restored controls reject missing FULL identity and receipt-before-commit, preserving raw coverage',async()=>{
  await db.query('ALTER TABLE synthetic_raw.entries REPLICA IDENTITY DEFAULT');
  await assert.rejects(identity.assertReady(db,{namespace:'synthetic_raw',domain:'entries'}),/FULL_IDENTITY/);
  for(const text of identity.build({namespace:'synthetic_raw',domain:'entries'}))await db.query(text);
  await identity.assertReady(db,{namespace:'synthetic_raw',domain:'entries'});
  await db.query('DELETE FROM synthetic_raw.entries WHERE tenant_id=$1',[A]);const event=(await wal())[0];
  const before=await tail();
  const broken=control('../lib/storage/clinical-stream-sql',"const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');began=false;","const committed={command:'COMMIT'};began=false;");
  // Returning a pooled connection with an open transaction is itself invalid;
  // force rollback on release, as a lost process/connection would do.
  const guardedPool={connect:async()=>{const client=await pool.connect();return {query:client.query.bind(client),release:async()=>{await client.query('ROLLBACK');client.release();}};}};
  await broken.acceptTransaction({...options(event.cohort),pool:guardedPool});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(await tail(),before,'NO_DURABLE_RECEIPT_WITHOUT_COMMIT');
  await accept(event);assert.equal((await tail()).events.at(-1).value.identifier,'public-entries');
 });
 it('actual typed clinical completion retains the independently accepted storage tail',async()=>{
  const connection={query:db.query.bind(db),holdAdvisoryLock:async()=>({available:true,close:async()=>{},withTenant:async(tenant,fn)=>{await db.query('BEGIN');try{const value=await fn();await db.query('COMMIT');return value;}catch(error){await db.query('ROLLBACK');throw error;}}})};
  const store=require('../lib/pgstream/typed-checkpoint').create({connection,namespace:'synthetic_raw_work',consumer,maxBytes:400000,timeIntervalMs:60000});
  await db.query('UPDATE '+table+' SET contract_digest=$3,work_observed=$4 WHERE tenant_id=$1 AND consumer=$2',[A,consumer+'-completed',store.digest,['1',null,null,null,null,null]]);
  const before=await tail();await store.own();
  await scope.withTenant(A,()=>store.complete(A,{observed:{clock:'1'},identity:'same',result:{checkpoint:1,properties:{},emitted:[],requested:[],rows:[],frame:{lastUpdated:1,sgvs:[]}}}));
  assert.deepEqual(await tail(),before,'CLINICAL_OUTPUT_REPLACEMENT_MUST_KEEP_RAW_TAIL');
  const reader=require('../lib/pgstream/storage-events').create({config:{completedOutput:{namespace:'synthetic_raw_work',consumer},...limits},connection});
  await db.query("DROP ROLE IF EXISTS synthetic_raw_reader;CREATE ROLE synthetic_raw_reader NOLOGIN;GRANT USAGE ON SCHEMA synthetic_raw_work TO synthetic_raw_reader;GRANT SELECT ON "+table+" TO synthetic_raw_reader;ALTER TABLE "+table+" ENABLE ROW LEVEL SECURITY;ALTER TABLE "+table+" FORCE ROW LEVEL SECURITY;CREATE POLICY raw_reader ON "+table+" USING(tenant_id=current_setting('synthetic.rawtenant')::uuid)");
  await db.query("SELECT set_config('synthetic.rawtenant',$1,false)",[A]);await db.query('SET ROLE synthetic_raw_reader');
  try{const read=await scope.withTenant(A,()=>reader.read(A));assert.deepEqual(read,before,'ACTUAL_REALTIME_RAW_TAIL_READER');reader.assert(read);await assert.rejects(scope.withTenant(B,()=>reader.read(B)),/NOT_PROVISIONED/);await assert.rejects(db.query('SELECT * FROM synthetic_raw.entries'),error=>error.code==='42501');}
  finally{await db.query('RESET ROLE');}await store.close();
 });

 it('records scoped WAL cost of full old identity for an unchanged-document metadata update',async()=>{
  // This measures WAL bytes in this synthetic table only, not serving latency,
  // capacity or the existing production storage-size trigger's total cost.
  const measure=async identityMode=>{
   await db.query('ALTER TABLE synthetic_raw.activity REPLICA IDENTITY '+identityMode);
   const start=(await db.query('SELECT pg_current_wal_insert_lsn() AS lsn')).rows[0].lsn;
   await db.query('UPDATE synthetic_raw.activity SET storage_bytes=storage_bytes+1 WHERE tenant_id=$1',[A]);
   return Number((await db.query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text AS bytes',[start])).rows[0].bytes);
  };
  const defaultBytes=await measure('DEFAULT'),fullBytes=await measure('FULL');
  assert(defaultBytes>0&&fullBytes>0);console.log('STORAGE_WAL_COST '+JSON.stringify({scope:'one unchanged-document update, synthetic 19200-byte extension, no size trigger',defaultBytes,fullBytes}));
 });

 it('applies identity after the actual populated ordered catalogue and tenant-bound size backfill',async()=>{
  const migrations=require('../lib/migrations/catalogue'),catalogue=require('../migrations/candidates/postgres-entries-v1.json'),namespace='synthetic_raw_migrate';
  await db.query('DROP SCHEMA IF EXISTS '+namespace+' CASCADE;CREATE SCHEMA '+namespace);await db.query('BEGIN');
  try{
   await db.query('SET LOCAL search_path='+namespace+',pg_catalog');
   for(const migration of migrations.validateCatalogue(catalogue)){
    if(migration.operation?.kind==='clinical-storage-size-v1'){
     for(const tenant of [A,B]){
      await db.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
      await db.query('INSERT INTO '+namespace+".entries(tenant_id,id_kind,doc) VALUES($1,'string',$2)",[tenant,{_id:'populated-'+tenant.slice(0,1),sgv:123}]);
     }
    }
    for(const statement of migrations.renderMigration(migration,namespace))await db.query(statement);
   }
   const rows=(await db.query('SELECT storage_bytes,insertion_ordinal FROM '+namespace+'.entries')).rows;
   assert.equal(rows.length,2);assert(rows.every(row=>Number(row.storage_bytes)>0&&Number(row.insertion_ordinal)>0),'POPULATED_BACKFILL_MUST_RETAIN_STORAGE_AND_ORDER');
   assert.equal((await db.query("SELECT current_setting('app.current_tenant_id') AS tenant")).rows[0].tenant,B,'BACKFILL_MUST_RESTORE_CALLER_BINDING');
   await identity.assertReady(db,{namespace,domain:'entries'});await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}
 });

 it('replays an actual committed receipt after its COMMIT reply is lost without duplicating raw work',async()=>{
  await db.query('INSERT INTO synthetic_raw.activity VALUES($1,\'string\',$2,$3)',[A,'unknown-commit',{_id:'unknown-commit',identifier:'unknown-commit',date:1}]);
  const event=(await wal()).find(row=>row.columns?.some(column=>column.name==='_id'&&column.value==='unknown-commit'));assert(event);
  const currentDigest=(await db.query('SELECT contract_digest FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[A,consumer+'-completed'])).rows[0].contract_digest;
  const receiptOptions={...options(event.cohort),completedDigest:currentDigest};
  const before=await tail(),cache=new Map([[A,{ready:false}]]);let lost=true;
  const uncertainPool={async connect(){const client=await pool.connect();return {async query(text,values){const result=await client.query(text,values);if(text==='COMMIT'&&lost){lost=false;throw new Error('SYNTHETIC_COMMIT_REPLY_LOST');}return result;},release:error=>client.release(error)};}};
  await assert.rejects(sql.acceptTransaction({...receiptOptions,pool:uncertainPool,cache}),/SYNTHETIC_COMMIT_REPLY_LOST/);
  assert.equal(cache.has(A),false,'UNCERTAIN_COMMIT_MUST_EVICT_RAM');
  const committed=await tail();assert.equal(committed.head,before.head+1);assert.equal(committed.events.at(-1).value.doc.identifier,'unknown-commit');
  const receipt=await sql.acceptTransaction(receiptOptions);assert.deepEqual(await tail(),committed,'COMPLETE_REPLAY_MUST_NOT_DUPLICATE_RAW_DELIVERY');
  assert(receipt.some(row=>row.tenant===A&&row.pendingAt!==null),'COMMITTED_ACCEPTANCE_MUST_REMAIN_RECOVERABLE');
 });

 it('bounds the receipt tail by its own limit, not the clinical-input limits; RED when the clinical limits are passed through',async()=>{
  // Seed a tail deeper than the journal bound, as an old-cap journal would be.
  const seed=async()=>{
   const current=journal.validate(await tail(B)),depth=journal.BOUNDS.maxRows+500,events=[];
   for(let i=1;i<=depth;i++)events.push({event:'create',domain:'food',value:{colName:'food',doc:{identifier:'seed-'+i}},sequence:current.head+i});
   const seeded=journal.validate({...current,base:current.head,head:current.head+depth,events,keys:[]});
   await db.query("UPDATE "+table+" SET projection=jsonb_set(projection,'{1}',$3::jsonb) WHERE tenant_id=$1 AND consumer=$2",[B,consumer,JSON.stringify(seeded)]);
   return seeded;
  };
  const insert=async id=>{await db.query('INSERT INTO synthetic_raw.food VALUES($1,\'string\',$2,$3)',[B,id,{_id:id,identifier:'public-'+id}]);return (await wal())[0];};
  const first=await insert('bound-red'),second=await insert('bound-green');
  let seeded=await seed();
  const broken=control('../lib/storage/clinical-stream-sql','journal.BOUNDS);','{maxRows,maxBytes});');
  await broken.acceptTransaction(options(first.cohort));
  assert.equal((await tail(B)).events.length,limits.maxRows,'RED: clinical limits bound the tail');
  seeded=await seed();
  await accept(second);
  const after=await tail(B);
  assert.equal(after.head,seeded.head+1);assert.equal(after.events.length,journal.BOUNDS.maxRows,'TAIL_BOUND_IS_ITS_OWN');
  assert.equal(after.base,after.head-journal.BOUNDS.maxRows);assert.equal(after.events.at(-1).value.doc.identifier,'public-bound-green');
 });

});
