'use strict';
// covers: lib/storage/postgres-connection.js, lib/server/serve/operation-cohort.js
// Actual disposable PostgreSQL backends. No serving stack, clinical mutation or
// retained deployment state is used by this constructor/admission instrument.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{Client,Pool}=require('pg');
const connect=require('../lib/storage/postgres-connection'),{run}=require('../lib/migrations/postgres');
const {optInSuite}=require('./support/opt-in');
const IMAGE='postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
// Extend the existing fixture reaper with a fixed deadline and exact ownership.
// This is test custody only; no service or application configuration uses it.
function fixtureCustody(container, image, kind, receiptPrefix) {
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {spawn,spawnSync}=require('node:child_process');
 let directory,cidfile,expectedImage,reaper,recorded=false,volumes=[],containerID,cleanupAt;
 const command=(args,env=process.env)=>execFileSync('docker',args,{env,encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
 function absent(args,pattern){const r=spawnSync('docker',args,{encoding:'utf8',timeout:10000});if(r.error)throw r.error;if(r.status===0)return false;assert(pattern.test(r.stderr||r.stdout),'Docker error is not an absence proof');return true;}
 function inspect(){if(absent(['inspect',container],/no such (?:object|container)/i))return null;const row=JSON.parse(command(['inspect',container]))[0];assert.equal(row.Name,'/'+container);assert.equal(row.Image,expectedImage);assert.equal(row.Config.Labels['nightscout.test'],kind);assert.equal(row.Config.Labels['nightscout.test.owner'],container);assert.match(row.Id,/^[a-f0-9]{64}$/);return row;}
 function receipt(name,value){console.log(receiptPrefix.toUpperCase()+'_'+name.toUpperCase()+' '+JSON.stringify(value));if(process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY)fs.writeFileSync(path.join(process.env.NS_OPERATION_WINDOW_RECEIPT_DIRECTORY,receiptPrefix+'-'+name+'.json'),JSON.stringify(value),{flag:'wx',mode:0o600});}
 function capture(){const row=inspect();if(!row)return null;containerID=row.Id;volumes=row.Mounts.filter(v=>v.Type==='volume').map(v=>v.Name);if(!recorded){recorded=true;receipt('custody',{pid:process.pid,container,containerID,image,imageID:expectedImage,volumes,cleanupAt,reaperPid:reaper.pid,reaperBirth:fs.readFileSync('/proc/'+reaper.pid+'/stat','utf8').split(')').at(-1).trim().split(/\s+/)[19],cidfile});}return row;}
 async function start(password,database){
  directory=fs.mkdtempSync(path.join(os.tmpdir(),receiptPrefix+'-'));cidfile=path.join(directory,'container.cid');
  expectedImage=command(['image','inspect','--format','{{.Id}}',image]);
  const now=Math.floor(Date.now()/1000);cleanupAt=process.env.NS_OPERATION_WINDOW_FIXTURE_CLEANUP_AT===undefined?now+240:Number(process.env.NS_OPERATION_WINDOW_FIXTURE_CLEANUP_AT);assert(Number.isSafeInteger(cleanupAt)&&cleanupAt>now&&cleanupAt<=now+240,'finite fixture cleanup deadline required');
  const birth=fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(')').at(-1).trim().split(/\s+/)[19];
  const script=`set -u
: > "$4.ready"
while [ ! -f "$4.done" ] && [ "$(date +%s)" -lt "$3" ]; do
 stat=$(cat "/proc/$1/stat" 2>/dev/null) || break
 read -ra fields <<< "\${stat##*) }"
 [ "\${fields[19]:-}" = "$2" ] || break
 sleep 1
done
[ -f "$4.done" ] && exit 0
if ! row=$(docker inspect --format '{{.Id}} {{.Name}} {{.Image}} {{index .Config.Labels "nightscout.test.owner"}} {{index .Config.Labels "nightscout.test"}}' "$5" 2>"$4.error"); then
 grep -Eqi 'no such (object|container)' "$4.error" && exit 0
 exit 21
fi
read -r id name actual owner kind <<< "$row"
[[ "$id" =~ ^[a-f0-9]{64}$ ]] && [ "$name" = "/$5" ] && [ "$actual" = "$6" ] && [ "$owner" = "$5" ] && [ "$kind" = "$7" ] || exit 22
volumeList=$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$id" 2>"$4.error") || exit 26
printf '%s\n' "$volumeList" > "$4.volumes"
docker rm -f -v "$id" >"$4.reaped" 2>"$4.error" || exit 23
if docker inspect "$id" > /dev/null 2>"$4.error"; then exit 24; fi
grep -Eqi 'no such (object|container)' "$4.error" || exit 25
for volume in $volumeList; do
 [[ "$volume" =~ ^[a-f0-9]{64}$ ]] || exit 27
 if docker volume inspect "$volume" > /dev/null 2>"$4.error"; then exit 28; fi
 grep -qi 'no such volume' "$4.error" || exit 29
done
`;
  reaper=spawn('bash',['-c',script,'reaper',String(process.pid),birth,String(cleanupAt),cidfile,container,expectedImage,kind],{detached:true,stdio:'ignore'});reaper.unref();
  for(let i=0;i<100&&!fs.existsSync(cidfile+'.ready');i++){assert(reaper.exitCode===null,'fixture reaper failed before creation');await new Promise(resolve=>setTimeout(resolve,10));}assert(fs.existsSync(cidfile+'.ready'),'fixture reaper armed before creation');assert(reaper.exitCode===null&&reaper.signalCode===null,'fixture reaper must remain live before creation');
  try{command(['run','--pull','never','--cidfile',cidfile,'--name',container,'--label','nightscout.test='+kind,'--label','nightscout.test.owner='+container,'-d','-p','127.0.0.1::5432','-e','POSTGRES_USER=bootstrap','-e','POSTGRES_PASSWORD','-e','POSTGRES_DB='+database,image],{...process.env,POSTGRES_PASSWORD:password});}
  finally{capture();}
  assert(containerID,'owned container identity required');return containerID;
 }
 async function close(){
  const row=expectedImage?capture():null;
  if(row){command(['rm','-f','-v',row.Id]);assert(absent(['inspect',row.Id],/no such (?:object|container)/i));for(const volume of volumes)assert(absent(['volume','inspect',volume],/no such volume/i));receipt('cleanup',{container,containerID:row.Id,containerAbsent:true,volumes,volumesAbsent:true});}
  if(!row&&recorded){assert(absent(['inspect',containerID],/no such (?:object|container)/i));for(const volume of volumes)assert(absent(['volume','inspect',volume],/no such volume/i));receipt('cleanup',{container,containerID,containerAbsent:true,alreadyAbsent:true,volumes,volumesAbsent:true});}
  if(reaper){fs.writeFileSync(cidfile+'.done','verified cleanup\n',{mode:0o600});if(reaper.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture reaper did not drain')),3000);reaper.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('fixture reaper exit '+code));});});}
 }
 return {start,close};
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
optInSuite(process.env.NS_COHORT_SNAPSHOT_DOCKER_TEST==='1','NS_COHORT_SNAPSHOT_DOCKER_TEST=1')('native generation datastore and pre-start role admission',function(){
 this.timeout(60000);
 const container='ns-cohort-snapshot-'+crypto.randomBytes(6).toString('hex'),namespace='snapshot_control';
 const custody=fixtureCustody(container,IMAGE,'cohort-constructor','cohort');
 let adminURI,lowerURI,lifetimeURI,pool,window,releaseWindow;
 const stores=[],q=name=>'"'+name+'"';
 async function open(name='snapshot-native-normal',connectionString=lowerURI){const store=await connect({connectionString,application_name:name,max:1});stores.push(store);return store;}
 before(async function(){
  const password=crypto.randomBytes(24).toString('hex');
  await custody.start(password,'snapshot_test');
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
   // Every physical lower backend now admits its exact control read surface.
   // The reader needs these same three SELECTs, with no lifetime marker writes.
   for(const role of ['snapshot_lifetime','snapshot_reader']){
    await admin.query('GRANT USAGE ON SCHEMA '+q(namespace)+' TO '+q(role));
    for(const table of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])await admin.query('GRANT SELECT ON '+q(namespace)+'.'+q(table)+' TO '+q(role));
   }
   await admin.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON '+q(namespace)+'.tenant_lifecycle_operations TO snapshot_lifetime');
   await admin.query('GRANT EXECUTE ON FUNCTION '+q(namespace)+'.tenant_lifecycle_backend_birth() TO snapshot_lifetime');
  }finally{await admin.end();}
  pool=new Pool({connectionString:lifetimeURI,max:2});window=require('../lib/tenant-lifecycle/operation-window').create({namespace,lockRule:'tenant-id-sha256-v1',pool});await window.ready();releaseWindow=connect.installOperationWindow(window);await open();
 });
 after(async function(){
  try{
   try{for(const store of stores.reverse())await store.end();}finally{releaseWindow?.();await window?.close();await pool?.end();}
  }finally{await custody.close();}
 });
 it('refuses a native elevated role and a foreign database during role connection startup',async function(){
  await assert.rejects(open('snapshot-native-superuser',adminURI), /NOSUPERUSER NOBYPASSRLS/);
  const url=new URL(lowerURI);url.pathname='/postgres';
  await assert.rejects(open('snapshot-native-wrong-database',url.toString()),{code:'POSTGRES_GENERATION_DATASTORE_MISMATCH'});
 });
 it('admits only the reader control SELECT surface, refuses a revoked read, and restores pre-start admission',async function(){
  const verified=await require('../lib/server/serve/platform-verification-lifecycle').inspect({namespace,poolOptions:{connectionString:lifetimeURI}});
  async function verifyReader() {
   const reader=new Client({connectionString:lowerURI});await reader.connect();
   try { return await verified.controlReads(reader); } finally {await reader.end();}
  }
  assert((await verifyReader()).includes(namespace+'.tenant_lifecycle_windows'));
  const reader=new Client({connectionString:lowerURI});await reader.connect();
  try{
   const row=(await reader.query("SELECT has_schema_privilege(current_user,$1,'USAGE') AS uses_schema,has_table_privilege(current_user,$2,'SELECT') AS reads,has_table_privilege(current_user,$3,'INSERT,UPDATE,DELETE') OR has_any_column_privilege(current_user,$3,'INSERT,UPDATE,REFERENCES') AS writes,pg_has_role(current_user,'snapshot_owner','MEMBER') AS owns",[namespace,namespace+'.schema_migrations',namespace+'.tenant_lifecycle_operations'])).rows[0];
   assert.deepEqual(row,{uses_schema:true,reads:true,writes:false,owns:false});
  }finally{await reader.end();}
  const admin=new Client({connectionString:adminURI});await admin.connect();
  try{
   await admin.query('REVOKE SELECT ON '+q(namespace)+'.schema_migrations FROM snapshot_reader');
   await assert.rejects(verifyReader(),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
  }finally{try{await admin.query('GRANT SELECT ON '+q(namespace)+'.schema_migrations TO snapshot_reader');}finally{await admin.end();}}
  assert((await verifyReader()).includes(namespace+'.tenant_lifecycle_windows'));
 });
});
