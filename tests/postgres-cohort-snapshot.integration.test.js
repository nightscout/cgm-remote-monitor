'use strict';
// covers: lib/storage/postgres-connection.js, lib/server/serve/operation-cohort.js
// Actual disposable PostgreSQL backends. No serving stack, clinical mutation or
// retained deployment state is used by this constructor/admission instrument.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{Client,Pool}=require('pg');
const connect=require('../lib/storage/postgres-connection'),{run}=require('../lib/migrations/postgres');
const {optInSuite}=require('./support/opt-in');
const IMAGE='postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function latch(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
optInSuite(process.env.NS_COHORT_SNAPSHOT_DOCKER_TEST==='1','NS_COHORT_SNAPSHOT_DOCKER_TEST=1')('native cohort constructor admission cuts',function(){
 this.timeout(60000);
 const container='ns-cohort-snapshot-'+crypto.randomBytes(6).toString('hex'),namespace='snapshot_control';
 let owned=false,adminURI,lowerURI,lifetimeURI,pool,window,releaseWindow,baseline,original;
 const stores=[],q=name=>'"'+name+'"';
 async function open(name='snapshot-native-normal',connectionString=lowerURI){const store=await connect({connectionString,application_name:name,max:1});stores.push(store);return store;}
 before(async function(){
  const password=crypto.randomBytes(24).toString('hex');
  execFileSync('docker',['run','--name',container,'--label','nightscout.test=cohort-constructor','-d','-p','127.0.0.1::5432','-e','POSTGRES_USER=bootstrap','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=snapshot_test',IMAGE],{env:{...process.env,POSTGRES_PASSWORD:password},stdio:'pipe'});owned=true;
  const port=execFileSync('docker',['port',container,'5432/tcp'],{encoding:'utf8'}).trim().split(':').pop();adminURI='postgres://bootstrap:'+password+'@127.0.0.1:'+port+'/snapshot_test';
  let admin;for(let attempt=0;attempt<100;attempt++){try{admin=new Client({connectionString:adminURI});await admin.connect();break;}catch{await admin?.end().catch(()=>{});admin=null;await delay(100);}}
  assert(admin,'owned PostgreSQL ready');
  try{
   await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');await admin.query('REVOKE CREATE ON DATABASE snapshot_test FROM PUBLIC');
   await admin.query('CREATE ROLE snapshot_owner NOLOGIN NOSUPERUSER NOBYPASSRLS');
   const urls={};
   for(const role of ['snapshot_lifetime','snapshot_reader']){const secret=crypto.randomBytes(24).toString('hex');await admin.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+secret+"'");const url=new URL(adminURI);url.username=role;url.password=secret;urls[role]=url.toString();}
   lowerURI=urls.snapshot_reader;lifetimeURI=urls.snapshot_lifetime;
   await admin.query('CREATE SCHEMA '+q(namespace));await run('up',{direct:true,connectionString:adminURI,namespace,catalogue:require('../lib/tenant-lifecycle/postgres-candidate.json')});
   for(const row of(await admin.query('SELECT tablename FROM pg_tables WHERE schemaname=$1',[namespace])).rows)await admin.query('ALTER TABLE '+q(namespace)+'.'+q(row.tablename)+' OWNER TO snapshot_owner');
   for(const row of(await admin.query('SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[namespace])).rows)await admin.query('ALTER FUNCTION '+row.signature+' OWNER TO snapshot_owner');
   await admin.query('ALTER SCHEMA '+q(namespace)+' OWNER TO snapshot_owner');
   await admin.query('GRANT USAGE ON SCHEMA '+q(namespace)+' TO snapshot_lifetime');
   for(const table of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])await admin.query('GRANT SELECT ON '+q(namespace)+'.'+q(table)+' TO snapshot_lifetime');
   await admin.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON '+q(namespace)+'.tenant_lifecycle_operations TO snapshot_lifetime');
   await admin.query('GRANT EXECUTE ON FUNCTION '+q(namespace)+'.tenant_lifecycle_backend_birth() TO snapshot_lifetime');
  }finally{await admin.end();}
  pool=new Pool({connectionString:lifetimeURI,max:2});window=require('../lib/tenant-lifecycle/operation-window').create({namespace,lockRule:'tenant-id-sha256-v1',pool});await window.ready();releaseWindow=connect.installOperationWindow(window);baseline=await open();original=Pool.prototype.connect;
 });
 after(async function(){
  if(original)Pool.prototype.connect=original;
  for(const store of stores.reverse())await store.end();releaseWindow?.();await window?.close();await pool?.end();
  if(owned)execFileSync('docker',['rm','-f','-v',container],{stdio:'pipe'});
 });
 it('waits for every captured real backend while a continuous B-like constructor stream remains independent',async function(){
  const entered=latch(),gate=latch(),opening=[];let candidate,timer;
  Pool.prototype.connect=async function(...args){const client=await original.apply(this,args);if(this.options.application_name==='snapshot-native-held'){entered.resolve();await gate.promise;}else if(this.options.application_name==='snapshot-native-stream')await delay(30);return client;};
  try{
   candidate=open('snapshot-native-held');await entered.promise;const snapshot=connect.cohortSnapshot(window);
   timer=setInterval(()=>opening.push(open('snapshot-native-stream')),3);await delay(15);gate.resolve();await candidate;
   const result=await snapshot;assert.deepEqual(result.datastore,window.datastore);assert.equal(result.backends.length,2,'both actual backends captured before stream starts');assert(opening.length>0);
   assert.throws(()=>connect.cohortDatastore(window),/datastore unavailable/,'later pending resources are still fail-closed');
  }finally{clearInterval(timer);gate.resolve();Pool.prototype.connect=original;await candidate;await Promise.all(opening);}
 });
 it('keeps an unadmitted physical backend refused at a bounded timeout',async function(){
  const entered=latch(),gate=latch();let candidate;
  Pool.prototype.connect=async function(...args){const client=await original.apply(this,args);if(this.options.application_name==='snapshot-native-timeout'){entered.resolve();await gate.promise;}return client;};
  try{candidate=open('snapshot-native-timeout');await entered.promise;await assert.rejects(connect.cohortSnapshot(window,{timeoutMs:20}),{code:'POSTGRES_COHORT_INITIALIZATION_TIMEOUT'});assert.throws(()=>connect.cohortDatastore(window),/datastore unavailable/);}
  finally{gate.resolve();Pool.prototype.connect=original;await candidate;}
 });
 it('refuses a native rejected role and an admitted backend in another database',async function(){
  await assert.rejects(open('snapshot-native-superuser',adminURI),/NOSUPERUSER NOBYPASSRLS/);
  const url=new URL(lowerURI);url.pathname='/postgres';const wrong=await open('snapshot-native-wrong-database',url.toString());
  await assert.rejects(connect.cohortSnapshot(window),/datastore unavailable/);await wrong.end();
  assert.deepEqual((await connect.cohortSnapshot(window)).datastore,window.datastore);
 });
});
