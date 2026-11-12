'use strict';
// Native only, opt in. The test owns its uniquely named Docker container and
// synthetic schema; it never selects an existing database or container.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const pgfeed = require('../lib/change-feed/postgres');
const { decode } = require('../lib/change-feed/pgoutput');
const configFactory = require('../lib/change-feed/config');
const readerFactory = require('../lib/change-feed/reader');
const consumerFactory = require('../lib/change-feed/consumer');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const IMAGE = 'postgres@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a';
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const suite = process.env.NS_D6_FEED_TEST === '1' ? describe : describe.skip;
suite('D6 native metadata feed, privilege and failure controls', function () {
  this.timeout(30000);
  let container, admin, serving, store, reader, consumer, source, config, seen, reads, listeners, alerts, killCommit=false;
  class ProofClient extends Client {
    async query(text,...args) {
      if (killCommit && text === 'COMMIT') { killCommit=false; await admin.query('SELECT pg_terminate_backend($1)',[this.processID]); }
      return super.query(text,...args);
    }
  }
  const docker = args => execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  before(async function () {
    container = 'ns-d6-reader-test-'+process.pid+'-'+Date.now();
    docker(['run','--detach','--name',container,'--network','bridge','-p','127.0.0.1::5432',
      '-e','POSTGRES_HOST_AUTH_METHOD=trust',IMAGE,'-c','wal_level=logical','-c','max_replication_slots=4',
      '-c','max_slot_wal_keep_size=64MB','-c','log_min_messages=warning']);
    const port = docker(['port',container,'5432/tcp']).split(':').at(-1);
    source = user => 'postgres://'+user+':synthetic@127.0.0.1:'+port+'/postgres';
    for (let retry=0;retry<100;retry++) {
      admin = new Client({connectionString:source('postgres')});
      try {await admin.connect();break;} catch {await admin.end().catch(()=>{});await sleep(100);}
    }
    await admin.query(`CREATE ROLE tenant_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION;
      CREATE ROLE feed_owner NOLOGIN NOSUPERUSER NOBYPASSRLS REPLICATION;
      CREATE ROLE feed_login LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION;
      CREATE ROLE serving LOGIN NOSUPERUSER NOBYPASSRLS NOREPLICATION;
      CREATE SCHEMA clock AUTHORIZATION tenant_owner; CREATE SCHEMA control AUTHORIZATION tenant_owner; CREATE SCHEMA feed;
      CREATE TABLE clock.tenant_write_clock(tenant_id uuid PRIMARY KEY,last_stamp bigint NOT NULL,last_delete_stamp bigint NOT NULL DEFAULT 0);
      CREATE TABLE control.tenant_activity(tenant_id uuid PRIMARY KEY,version bigint NOT NULL,paused boolean NOT NULL,suspended boolean NOT NULL,deletion_request_id uuid,paused_before_deletion boolean);
      ALTER TABLE clock.tenant_write_clock OWNER TO tenant_owner; ALTER TABLE control.tenant_activity OWNER TO tenant_owner;
      ALTER TABLE clock.tenant_write_clock ENABLE ROW LEVEL SECURITY; ALTER TABLE clock.tenant_write_clock FORCE ROW LEVEL SECURITY;
      ALTER TABLE control.tenant_activity ENABLE ROW LEVEL SECURITY; ALTER TABLE control.tenant_activity FORCE ROW LEVEL SECURITY;
      CREATE POLICY isolation ON clock.tenant_write_clock USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid);
      CREATE POLICY isolation ON control.tenant_activity USING (tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid);
      GRANT USAGE ON SCHEMA clock,control TO serving; GRANT SELECT ON clock.tenant_write_clock,control.tenant_activity TO serving;
      CREATE TABLE public.excluded(marker text); SET search_path=feed,pg_catalog`);
    for (const migration of pgfeed.catalogue.migrations) for (const sql of migration.up) await admin.query(sql);
    for (const sql of pgfeed.provision({namespace:'feed',clockNamespace:'clock',activityNamespace:'control',slot:'d6_slot',publication:'d6_publication',owner:'feed_owner',reader:'feed_login'})) await admin.query(sql);
    config = configFactory.parse({connectionEnv:'PG',namespace:'feed',clockNamespace:'clock',activityNamespace:'control',slot:'d6_slot',publication:'d6_publication',channel:'d6_channel',owner:'feed_owner',statementTimeoutMs:100},{PG:source('feed_login')},{reader:true});
    serving = new Client({connectionString:source('serving')}); await serving.connect();
    store = await pgfeed.create(config,{Client:ProofClient});
    reads=[];seen=new Map();listeners=[];alerts=[];
    const consumerConfig = configFactory.parse({connectionEnv:'PG',channel:'d6_channel',pageSize:1,degradedPages:1,intervalMs:10,heartbeatTimeoutMs:100},{PG:source('serving')});
    consumer = consumerFactory.create({config:consumerConfig,tenants:[A,B],schedule:()=>null,cancel:()=>{},alert:code=>alerts.push(code),
      connect:async()=>{const client=new Client({connectionString:source('serving')});await client.connect();listeners.push(client);return client;},
      check:async tenants=>{for(const tenant of tenants){reads.push(tenant);await serving.query('BEGIN');
        try {await serving.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
          const clock=(await serving.query('SELECT last_stamp::text,last_delete_stamp::text FROM clock.tenant_write_clock')).rows;
          const activity=(await serving.query('SELECT paused,suspended FROM control.tenant_activity')).rows;
          seen.set(tenant,{clock:clock[0]||null,activity:activity[0]||null});await serving.query('COMMIT');}
        catch(error){await serving.query('ROLLBACK');throw error;}}}});
    await consumer.start();
    reader=readerFactory.create({config,store,reconnect:async()=>{store=await pgfeed.create(config,{Client:ProofClient});return store;},schedule:()=>null,cancel:()=>{},alert:code=>alerts.push(code)});
  });
  after(async function () {
    await consumer?.close().catch(()=>{}); await reader?.close().catch(()=>{}); if(!reader)await store?.close().catch(()=>{});
    await serving?.end().catch(()=>{});await admin?.end().catch(()=>{});
    if(container)docker(['rm','--force','--volumes',container]);
  });
  it('uses EXECUTE-only reader authority, emits metadata hints and preserves RLS for tenant reads', async function () {
    await assert.rejects(serving.query("SELECT * FROM pg_logical_slot_peek_binary_changes('d6_slot',NULL,1,'proto_version','1','publication_names','d6_publication')"),error=>error.code==='42501');
    const raw=new Client({connectionString:source('feed_login'),options:'-c statement_timeout=100'});await raw.connect();
    try{await assert.rejects(raw.query("SELECT * FROM pg_logical_slot_peek_binary_changes('d6_slot',NULL,1,'proto_version','1','publication_names','d6_publication')"),error=>error.code==='42501');
      await assert.rejects(raw.query('SET ROLE feed_owner'),error=>error.code==='42501');
      await assert.rejects(raw.query('SELECT * FROM feed.feed_peek(NULL,NULL,NULL)'),error=>error.message==='FEED_BATCH_BOUNDS');
      await assert.rejects(raw.query('SELECT pg_sleep(0.5)'),error=>error.code==='57014');}
    finally{await raw.end();}
    await admin.query('INSERT INTO clock.tenant_write_clock VALUES ($1,1,0),($2,1,0)',[A,B]);
    await admin.query('INSERT INTO control.tenant_activity VALUES ($1,1,false,false,NULL,NULL),($2,1,false,false,NULL,NULL)',[A,B]);
    await admin.query("INSERT INTO public.excluded VALUES ('SYNTHETIC_UNPUBLISHED')");
    await reader.pass(); await sleep(20);await consumer.tick();await consumer.tick();
    assert.ok(consumer.health().hints>=2,'D6_NATIVE_HINTS_DELIVERED');
    assert.equal(seen.get(A).clock.last_stamp,'1');assert.equal(seen.get(B).clock.last_stamp,'1');
    await serving.query('BEGIN');await serving.query("SELECT set_config('app.current_tenant_id',$1,true)",[A]);
    assert.deepEqual((await serving.query('SELECT tenant_id FROM clock.tenant_write_clock')).rows.map(r=>r.tenant_id),[A]);await serving.query('COMMIT');
    assert.equal((await store.peek()).length,0,'D6_NATIVE_ACK_ADVANCED');
  });
  it('duplicates hints after lost acknowledgement without advancing before a committed notification', async function () {
    await admin.query('UPDATE clock.tenant_write_clock SET last_stamp=2 WHERE tenant_id=$1',[A]);
    const before=(await admin.query("SELECT confirmed_flush_lsn::text AS value FROM pg_replication_slots WHERE slot_name='d6_slot'")).rows[0].value;
    const failing=readerFactory.create({config,store:{...store,notify:async()=>{throw new Error('held notification commit');},close:async()=>{}},schedule:()=>null,cancel:()=>{},alert:()=>{}});
    await failing.pass(); assert.equal(failing.health().degraded,true);
    assert.equal((await admin.query("SELECT confirmed_flush_lsn::text AS value FROM pg_replication_slots WHERE slot_name='d6_slot'")).rows[0].value,before,'D6_NO_ACK_BEFORE_NOTIFY');
    const lost=readerFactory.create({config,store:{...store,advance:async()=>{throw new Error('lost ACK before call');},close:async()=>{}},schedule:()=>null,cancel:()=>{},alert:()=>{}});
    await lost.pass();await sleep(20);await consumer.tick();assert.equal(seen.get(A).clock.last_stamp,'2');
    assert.ok((await store.peek()).length>0,'D6_REPLAY_AFTER_LOST_ACK');
    await reader.pass();await sleep(20);await consumer.tick();assert.equal(seen.get(A).clock.last_stamp,'2');assert.equal((await store.peek()).length,0);
  });
  it('recovers lost notifications, reader outage and listener reconnect using paged current truth', async function () {
    // Deliberately do not call reader.pass: reader is down, but writes persist.
    await admin.query('UPDATE clock.tenant_write_clock SET last_stamp=3 WHERE tenant_id=$1',[B]);
    await sleep(120);await consumer.tick();await consumer.tick();assert.equal(seen.get(B).clock.last_stamp,'3','D6_READER_OUTAGE_BACKSTOP');
    assert.equal(consumer.health().degraded,true);assert.ok(alerts.includes('FEED_DEGRADED'));
    // Semantic control: disabling the check leaves the old value, and the same
    // equality oracle is actually red. Restore by running the real backstop.
    await admin.query('UPDATE clock.tenant_write_clock SET last_stamp=4 WHERE tenant_id=$1',[B]);
    assert.throws(()=>assert.equal(seen.get(B).clock.last_stamp,'4'),'D6_BACKSTOP_DISABLED_RED');
    await consumer.tick();await consumer.tick();assert.equal(seen.get(B).clock.last_stamp,'4');
    await listeners.at(-1).end();await reader.pass();await consumer.tick();await consumer.tick();
    assert.ok(consumer.health().reconnects>=2,'D6_LISTENER_RECONNECTED');assert.equal(seen.get(B).clock.last_stamp,'4');
  });
  it('recovers a backend interruption inside notification COMMIT without early acknowledgement', async function () {
    await admin.query('UPDATE clock.tenant_write_clock SET last_stamp=7 WHERE tenant_id=$1',[A]);
    const before=(await admin.query("SELECT confirmed_flush_lsn::text AS value FROM pg_replication_slots WHERE slot_name='d6_slot'")).rows[0].value;
    const hintsBefore=consumer.health().hints;
    killCommit=true;await reader.pass();await sleep(20);
    assert.equal(reader.health().degraded,true);
    assert.equal((await admin.query("SELECT confirmed_flush_lsn::text AS value FROM pg_replication_slots WHERE slot_name='d6_slot'")).rows[0].value,before,'D6_BACKEND_CRASH_NO_ACK');
    assert.equal(consumer.health().hints,hintsBefore,'D6_UNCOMMITTED_NOTIFY_NOT_VISIBLE');
    await reader.pass();await sleep(20);await consumer.tick();await consumer.tick();
    assert.equal(reader.health().degraded,false);assert.equal(seen.get(A).clock.last_stamp,'7');
  });
  it('signals pause/suspend/resume with no data write while another tenant progresses', async function () {
    const before=(await admin.query('SELECT last_stamp::text FROM clock.tenant_write_clock WHERE tenant_id=$1',[A])).rows[0].last_stamp;
    for(const [paused,suspended] of [[true,false],[false,false],[false,true],[false,false]]){
      await admin.query('UPDATE control.tenant_activity SET version=version+1,paused=$2,suspended=$3 WHERE tenant_id=$1',[A,paused,suspended]);
      const hintsBefore=consumer.health().hints;await reader.pass();await sleep(15);
      assert.ok(consumer.health().hints>hintsBefore,'D6_ACTIVITY_HINT_NOT_A_DATA_WRITE');
      await consumer.tick();await consumer.tick();
      assert.deepEqual(seen.get(A).activity,{paused,suspended});assert.equal(seen.get(A).clock.last_stamp,before);
    }
    await admin.query('UPDATE control.tenant_activity SET paused=true,version=version+1 WHERE tenant_id=$1',[A]);
    await admin.query('UPDATE clock.tenant_write_clock SET last_stamp=5 WHERE tenant_id=$1',[B]);
    await reader.pass();await sleep(15);await consumer.tick();await consumer.tick();
    assert.equal(seen.get(A).activity.paused,true);assert.equal(seen.get(B).clock.last_stamp,'5','D6_OTHER_TENANT_PROGRESS');
  });
  it('refuses unsafe wrapper owner/configuration and wrong publication/slot before consuming', async function () {
    await admin.query('ALTER FUNCTION feed.feed_peek(integer,integer,integer) OWNER TO feed_login');
    await assert.rejects(store.peek(),error=>error.code==='FEED_WRAPPER_UNSAFE');
    await admin.query('ALTER FUNCTION feed.feed_peek(integer,integer,integer) OWNER TO feed_owner; GRANT EXECUTE ON FUNCTION feed.feed_peek(integer,integer,integer) TO feed_login');
    await admin.query('ALTER FUNCTION feed.feed_peek(integer,integer,integer) SET search_path=public');
    await assert.rejects(store.peek(),error=>error.code==='FEED_WRAPPER_UNSAFE');
    await admin.query('ALTER FUNCTION feed.feed_peek(integer,integer,integer) SET search_path=pg_catalog');
    await admin.query('ALTER PUBLICATION d6_publication ADD TABLE public.excluded');
    await assert.rejects(store.peek(),error=>error.code==='FEED_PUBLICATION_UNSAFE');
    await admin.query('ALTER PUBLICATION d6_publication DROP TABLE public.excluded');
    const wrong={...config,slot:'missing_slot'};await assert.rejects(pgfeed.create(wrong),error=>['FEED_WRAPPER_UNSAFE','FEED_SLOT_UNSAFE'].includes(error.code));
    assert.equal((await store.peek()).length,0,'D6_RESTORED_PINS_GREEN');
  });
  it('refuses an oversized complete transaction without ACK; backstop still sees its current truth', async function () {
    const before=(await admin.query("SELECT confirmed_flush_lsn::text AS value FROM pg_replication_slots WHERE slot_name='d6_slot'")).rows[0].value;
    await admin.query('BEGIN');
    await admin.query("INSERT INTO clock.tenant_write_clock SELECT ('10000000-0000-4000-8000-'||lpad(to_hex(i),12,'0'))::uuid,i,0 FROM generate_series(1,200) i");
    await admin.query('UPDATE clock.tenant_write_clock SET last_stamp=6 WHERE tenant_id=$1',[B]);await admin.query('COMMIT');
    const small={...config,maxMessages:100},bounded=await pgfeed.create({...config,slot:'d6_slot'}).catch(error=>error);
    assert.equal(bounded.code,'FEED_READER_ALREADY_RUNNING');
    const limitedStore={...store,peek:async()=>{
      const raw=new Client({connectionString:source('feed_login'),options:'-c statement_timeout=100'});await raw.connect();
      try{return (await raw.query('SELECT lsn::text,data FROM feed.feed_peek(1,100,1048576)')).rows;}finally{await raw.end();}}};
    const limited=readerFactory.create({config:small,store:limitedStore,schedule:()=>null,cancel:()=>{},alert:()=>{}});
    await limited.pass();assert.equal(limited.health().degraded,true);
    assert.equal((await admin.query("SELECT confirmed_flush_lsn::text AS value FROM pg_replication_slots WHERE slot_name='d6_slot'")).rows[0].value,before);
    await consumer.tick();await consumer.tick();assert.equal(seen.get(B).clock.last_stamp,'6','D6_OVERSIZE_BACKSTOP');
    const decoded=decode(await store.peek(),config);assert.ok(decoded.messages>1);assert.ok(decoded.hints.has(B));
    await reader.pass();assert.equal((await store.peek()).length,0);
  });
  it('signals settings and policy metadata promptly without plaintext feed grants or a data-clock write', async function () {
    const crypto=require('node:crypto');let settingsStore,settingsReader,settingsConsumer,rt;
    await admin.query(`CREATE SCHEMA settings_meta;CREATE SCHEMA policy_meta;CREATE SCHEMA feed_config;
      CREATE TABLE settings_meta.tenant_settings(tenant_id uuid PRIMARY KEY,version integer NOT NULL,values jsonb NOT NULL);
      CREATE TABLE policy_meta.tenant_operator_policy(tenant_id uuid PRIMARY KEY,generation integer NOT NULL,policy jsonb NOT NULL);
      ALTER TABLE settings_meta.tenant_settings OWNER TO tenant_owner;ALTER TABLE policy_meta.tenant_operator_policy OWNER TO tenant_owner;
      ALTER TABLE settings_meta.tenant_settings ENABLE ROW LEVEL SECURITY;ALTER TABLE settings_meta.tenant_settings FORCE ROW LEVEL SECURITY;
      ALTER TABLE policy_meta.tenant_operator_policy ENABLE ROW LEVEL SECURITY;ALTER TABLE policy_meta.tenant_operator_policy FORCE ROW LEVEL SECURITY;
      CREATE POLICY isolate ON settings_meta.tenant_settings USING(tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid);
      CREATE POLICY isolate ON policy_meta.tenant_operator_policy USING(tenant_id=nullif(current_setting('app.current_tenant_id',true),'')::uuid);
      GRANT USAGE ON SCHEMA settings_meta,policy_meta TO serving;GRANT SELECT ON settings_meta.tenant_settings,policy_meta.tenant_operator_policy TO serving;
      SET search_path=feed_config,pg_catalog`);
    for(const migration of pgfeed.catalogue.migrations)for(const sql of migration.up)await admin.query(sql);
    const doc={connectionEnv:'PG',namespace:'feed_config',clockNamespace:'clock',activityNamespace:'control',settingsNamespace:'settings_meta',policyNamespace:'policy_meta',slot:'d6_config_slot',publication:'d6_config_pub',channel:'d6_config_channel',owner:'feed_owner',statementTimeoutMs:100};
    for(const sql of pgfeed.provision({...doc,reader:'feed_login'}))await admin.query(sql);
    const selected=configFactory.parse(doc,{PG:source('feed_login')},{reader:true});
    const frame=[];
    async function current(tenant){await serving.query('BEGIN');try{await serving.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
      const row=(await serving.query('SELECT s.version,p.generation,s.values,p.policy FROM settings_meta.tenant_settings s JOIN policy_meta.tenant_operator_policy p USING(tenant_id)')).rows[0];
      await serving.query('COMMIT');return row?{tenant,identity:crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex'),row}:null;
    }catch(error){await serving.query('ROLLBACK');throw error;}}
    try{
      await admin.query('INSERT INTO settings_meta.tenant_settings VALUES ($1,1,$2)',[B,{DISPLAY_UNITS:'mg/dl',marker:'SYNTHETIC_PLAINTEXT_NOT_IN_FEED'}]);
      await admin.query('INSERT INTO policy_meta.tenant_operator_policy VALUES ($1,1,$2)',[B,{marker:'SYNTHETIC_POLICY_NOT_IN_FEED'}]);
      assert.equal((await admin.query("SELECT has_column_privilege('feed_owner','settings_meta.tenant_settings','values','SELECT') AS reads")).rows[0].reads,false);
      settingsStore=await pgfeed.create(selected);const raw=await settingsStore.peek();
      assert.equal(raw.some(row=>row.data.includes(Buffer.from('SYNTHETIC_PLAINTEXT_NOT_IN_FEED'))),false);
      assert.equal(decode(raw,selected).hints.get(B),'config');
      rt=await require('../lib/server/realtime/runtime')({tenants:[B],eventDriven:true,recoveryIntervalMs:1000,schedule:()=>null,cancel:()=>{},concurrency:1,
        readCurrent:current,create:ctx=>({acquire:async()=>({checkpoint:6,frame:ctx.row})}),fanout:async row=>frame.push(row.next.frame),
        detect:async tenants=>new Map(await Promise.all(tenants.map(async tenant=>[tenant,{identity:(await current(tenant))?.identity,stamp:6}])))});
      settingsConsumer=consumerFactory.create({config:{...baseConfig(),channel:doc.channel,pageSize:1,degradedPages:1},tenants:[A,B],schedule:()=>null,cancel:()=>{},alert:()=>{},
        connect:async()=>{const client=new Client({connectionString:source('serving')});await client.connect();return client;},check:tenants=>rt.check(tenants.filter(t=>t===B))});
      await settingsConsumer.start();settingsReader=readerFactory.create({config:selected,store:settingsStore,schedule:()=>null,cancel:()=>{},alert:()=>{}});
      await settingsReader.pass();await sleep(20);await settingsConsumer.tick();
      const clockBefore=(await admin.query('SELECT last_stamp::text FROM clock.tenant_write_clock WHERE tenant_id=$1',[B])).rows[0].last_stamp;
      const hintsBefore=settingsConsumer.health().hints,start=Date.now();
      await admin.query('UPDATE settings_meta.tenant_settings SET version=2,values=$2 WHERE tenant_id=$1',[B,{DISPLAY_UNITS:'mmol'}]);
      await settingsReader.pass();await sleep(20);assert.ok(settingsConsumer.health().hints>hintsBefore,'D6_SETTINGS_HINT');await settingsConsumer.tick();
      assert.equal(frame.at(-1).version,2,'D6_SETTINGS_ONLY_FRAME');
      await admin.query('UPDATE policy_meta.tenant_operator_policy SET generation=2 WHERE tenant_id=$1',[B]);
      const policyHints=settingsConsumer.health().hints;await settingsReader.pass();await sleep(20);assert.ok(settingsConsumer.health().hints>policyHints,'D6_POLICY_HINT');await settingsConsumer.tick();assert.equal(frame.at(-1).generation,2,'D6_POLICY_ONLY_FRAME');
      assert.equal((await admin.query('SELECT last_stamp::text FROM clock.tenant_write_clock WHERE tenant_id=$1',[B])).rows[0].last_stamp,clockBefore);
      console.log('D6_CONFIG_SIGNAL_MS',Date.now()-start);
      // Lost config hint is recovered by the same bounded authoritative pages.
      await admin.query('UPDATE policy_meta.tenant_operator_policy SET generation=3 WHERE tenant_id=$1',[B]);await settingsConsumer.tick();await settingsConsumer.tick();assert.equal(frame.at(-1).generation,3);
      await admin.query('GRANT SELECT (values) ON settings_meta.tenant_settings TO feed_owner');await assert.rejects(settingsStore.peek(),error=>error.code==='FEED_METADATA_GRANTS_UNSAFE');await admin.query('REVOKE SELECT (values) ON settings_meta.tenant_settings FROM feed_owner');
      const original='clock.tenant_write_clock,control.tenant_activity,settings_meta.tenant_settings(tenant_id,version),policy_meta.tenant_operator_policy(tenant_id,generation)';
      await admin.query('ALTER PUBLICATION d6_config_pub SET TABLE '+original.replace('tenant_id,version)','tenant_id,version,values)'));
      await assert.rejects(settingsStore.peek(),error=>error.code==='FEED_PUBLICATION_UNSAFE');await admin.query('ALTER PUBLICATION d6_config_pub SET TABLE '+original);
      await admin.query('ALTER PUBLICATION d6_config_pub SET TABLE '+original.replace('tenant_id,version)','tenant_id)'));
      await assert.rejects(settingsStore.peek(),error=>error.code==='FEED_PUBLICATION_UNSAFE');await admin.query('ALTER PUBLICATION d6_config_pub SET TABLE '+original);
      await settingsReader.pass();assert.equal(settingsReader.health().degraded,false);
    }finally{await settingsConsumer?.close();await settingsReader?.close();if(!settingsReader)await settingsStore?.close();await rt?.close();}
    function baseConfig(){return {channel:doc.channel,pageSize:1,degradedPages:1,intervalMs:10,heartbeatTimeoutMs:100};}
  });
  it('boots and gracefully stops the dedicated feed-reader CLI role', async function () {
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
    await reader.close();
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ns-d6-cli-')),file=path.join(dir,'feed.json');
    const document={connectionEnv:'D6_NATIVE_PG',namespace:'feed',clockNamespace:'clock',activityNamespace:'control',slot:'d6_slot',publication:'d6_publication',channel:'d6_channel',owner:'feed_owner',statementTimeoutMs:100};
    fs.writeFileSync(file,JSON.stringify(document));
    const child=spawn(process.execPath,['bin/nightscout.js','multitenant','feed-reader'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MULTITENANT_FEED_CONFIG:file,D6_NATIVE_PG:source('feed_login')},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    try {
      let ready=false;
      for(let i=0;i<100;i++){
        const count=Number((await admin.query("SELECT count(*) FROM pg_stat_activity WHERE application_name='nightscout-feed-reader' AND usename='feed_login'")).rows[0].count);
        if(count && output.includes('feed-reader started')){ready=true;break;}
        if(child.exitCode!==null)break;await sleep(20);
      }
      assert.equal(ready,true,'D6_CLI_READER_STARTED '+output);
      child.kill('SIGTERM');const result=await exited;assert.equal(result.code,0,'D6_CLI_SHUTDOWN '+output);
    } finally {if(child.exitCode===null)child.kill('SIGKILL');await exited;fs.rmSync(dir,{recursive:true,force:true});}
  });

});
