'use strict';
// Actual provisioning/Vault, PostgreSQL registry, shipping clinical evaluator,
// typed completed-output consumer, startup and dynamic runtime seams. Own container/ports;
// no existing database, Vault or real data is selected.
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const scope=require('../lib/storage/tenant-scope');
const registryFactory=require('../lib/server/serve/registry-tenant-set');
const provisioning=require('../lib/tenant-registry/provision');
const IMAGE=process.env.NS_MULTITENANT_PGSTREAM_POSTGRES_IMAGE||'postgres@sha256:5db6dac2ef5dcff512f4f00a009c3c332b9f2f28f24277175bf3e4a3d02ef83a';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const suite=require('./support/opt-in').optInSuite(process.env.NS_TENANT_LIVE_ADD_TEST==='1','NS_TENANT_LIVE_ADD_TEST=1; owned PostgreSQL and Vault');
suite('live tenant admission with actual clinical and frame computation',function(){
  this.timeout(60000);
  let container,clinical,registry,provisioner,watcher,evaluator,realtime,startup,prior,saved,checkpoints,activityStore,eligibility,completed,trusted;
  const existing=randomUUID(),added=randomUUID(),frames=new Map(),evaluations=new Map(),timeline=[];
  let failWarm=false,rollbackCount=0;const held=new Map();
  const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const wait=async check=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const value=await check();if(value)return value;await sleep(20);}throw new Error('LIVE_NATIVE_WAIT_EXPIRED '+JSON.stringify({evaluator:evaluator?.health(),realtime:realtime?.health(),evaluations:[...evaluations.keys()],frames:[...frames.keys()]}));};
  const q=(sql,values)=>registry.admin.query(sql,values);
  async function seed(tenant,value){const at=Date.now();return clinical.persistDomains({entries:[0,1,2].map(i=>({_id:'synthetic-live-'+i,type:'sgv',sgv:value,date:at-(2-i)*60000,dateString:new Date(at-(2-i)*60000).toISOString(),direction:'Flat'}))},tenant);}
  before(async function(){
    prior=scope.getTenancyMode();scope.setTenancyMode('multi');saved={};
    for(const name of ['NS_TEST_POSTGRES_ADMIN_URI','NS_TEST_VAULT_ADDR','NS_TEST_VAULT_TOKEN','NS_VAULT_DOCKER_TEST'])saved[name]=process.env[name];
    delete process.env.NS_TEST_VAULT_ADDR;delete process.env.NS_TEST_VAULT_TOKEN;process.env.NS_VAULT_DOCKER_TEST='1';
    container='ns-live-add-test-'+process.pid+'-'+Date.now();
    docker(['run','--detach','--name',container,'-p','127.0.0.1::5432','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=live_add_test',IMAGE,'-c','log_min_messages=warning']);
    const port=docker(['port',container,'5432/tcp']).split(':').at(-1);
    process.env.NS_TEST_POSTGRES_ADMIN_URI='postgres://postgres:synthetic@127.0.0.1:'+port+'/live_add_test';
    await wait(async()=>{const client=new Client({connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI});try{await client.connect();await client.end();return true;}catch{await client.end().catch(()=>{});return false;}});
    clinical=require('./fixtures/tenant-projection-evaluator')();await clinical.open();
    clinical.env=require('../lib/server/tenant-app/environment')({settings:{enable:['bgnow','simplealarms','timeago'],alarmUrgentHigh:true,thresholds:{bgHigh:200,bgTargetTop:180,bgTargetBottom:80,bgLow:55}}});
    registry=await require('./fixtures/tenant-registry-lab').createLab();
    await require('../lib/migrations/postgres').run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:clinical.replayNamespace,catalogue:require('../migrations/candidates/postgres-evaluator-work-v2.json')});
    const typed=require('../lib/pgstream/checkpoint');
    await clinical.admin.query('GRANT UPDATE('+typed.WORK_COLUMNS.join(',')+') ON "'+clinical.replayNamespace+'".tenant_consumer_checkpoint TO "'+clinical.readerRole+'"');
    completed=typed.create({typed:true,connection:clinical.reader,namespace:clinical.replayNamespace,consumer:'evaluator-live',maxBytes:8388608,timeIntervalMs:1000});
    await completed.own(()=>{});
    // Typed receipt/admission SQL deliberately owns an independent transaction.
    // Match the maintained producer's exact completed-consumer policy; tenant
    // clinical rows retain their existing tenant-bound policy.
    const outputTable='"'+clinical.replayNamespace+'".tenant_consumer_checkpoint';
    await clinical.admin.query("CREATE POLICY live_typed_output ON "+outputTable+' TO "'+clinical.readerRole+'"'+" USING (consumer='"+completed.consumer+"') WITH CHECK (consumer='"+completed.consumer+"')");
    checkpoints=[{namespace:clinical.replayNamespace,consumer:'clinical-view',digest:clinical.consumer().digest},{namespace:clinical.replayNamespace,consumer:completed.consumer,digest:completed.digest}];
    const namespaces={...registry.namespaces,clock:clinical.namespaces.clock};
    for(const sql of provisioning.provisionerGrants({namespaces,role:registry.roles.provisioner,checkpoints}))await q(sql);
    provisioner=provisioning.createProvisioning(registry.provisioningOptions({namespaces,checkpoints}));
    await provisioner.provision({id:existing,hosts:['existing-'+existing+'.example.test']});await seed(existing,240);
    watcher=await registryFactory.open({settings:{namespace:registry.namespaces.registry,refreshMs:250},connectionString:registry.urls.realtime,maxTenants:20,
      build:tenant=>({tenant,identity:'a'.repeat(64),env:clinical.env})});
    for(const sql of require('../lib/tenant-activity/postgres').grants({namespace:registry.namespaces.control,reader:registry.roles.realtime}))await q(sql);
    activityStore=await require('../lib/tenant-activity/postgres').create({connectionString:registry.urls.realtime,namespace:registry.namespaces.control,capability:'reader'});
    eligibility=require('../lib/tenant-activity/eligibility').create({read:activityStore.read});
    const current=async tenant=>watcher.isActive(tenant) && (await eligibility.check('read',tenant)).eligible?watcher.tenants.get(tenant):null;
    const generations=new Map();
    startup=require('../lib/server/serve/tenant-startup').create(watcher.tenants.keys(),undefined,async tenant=>{
      const row=await clinical.reader.withTenant(tenant,()=>clinical.reader.query('SELECT count(*)::int AS count FROM "'+clinical.replayNamespace+'".tenant_consumer_checkpoint WHERE tenant_id=$1',[tenant]));
      assert.equal(row.rows[0].count,2,'LIVE_NATIVE_CHECKPOINTS_PROVISIONED');
      const window=(await q('SELECT generation::text,phase FROM "'+registry.namespaces.control+'".tenant_lifecycle_windows WHERE tenant_id=$1',[tenant])).rows[0];assert.equal(window.phase,'active');generations.set(tenant,window.generation);
      await scope.withTenant(tenant,()=>completed.admit([tenant]));
    },{dynamic:true,maxTenants:20,readiness:'all'});await startup.warm();
    evaluator=await require('../lib/server/serve/evaluator-runtime')({tenants:[...watcher.tenants.keys()],dynamic:true,maxTenants:20,activity:eligibility,externalRecovery:true,recoveryIntervalMs:1000,timeIntervalMs:1000,
      readCurrent:current,create:async ctx=>{await startup.ensure(ctx.tenant);const instance=clinical.evaluator(ctx.tenant,{includeFrame:true});return {...instance,evaluate:async args=>{const result=await instance.evaluate(args);await scope.withTenant(ctx.tenant,async()=>{await completed.observe(ctx.tenant,'clock',String(result.checkpoint));await completed.complete(ctx.tenant,{observed:await completed.begin(ctx.tenant),identity:ctx.identity,restoreGeneration:generations.get(ctx.tenant),result});});evaluations.set(ctx.tenant,result);realtime?.wake(ctx.tenant);timeline.push({tenant:ctx.tenant,at:Date.now()});return result;}};}});
    const trustedNamespaces={clock:clinical.namespaces.clock,activity:registry.namespaces.control,settings:registry.namespaces.settings,operatorPolicy:registry.namespaces.operatorPolicy};
    for(const sql of require('../lib/trusted-worker/postgres').grants({namespaces:trustedNamespaces,roles:[clinical.readerRole]}))await q(sql);
    trusted=require('../lib/trusted-worker/postgres').create({connection:clinical.reader,namespaces:trustedNamespaces,eventDriven:true});
    await trusted.verify();
    const rtConfig={consumer:'live-realtime',maxRows:10000,maxBytes:4194304,namespaces:{clock:clinical.namespaces.clock,checkpoint:clinical.replayNamespace},completedOutput:{namespace:clinical.replayNamespace,consumer:'evaluator-live'}};
    realtime=await require('../lib/server/realtime/runtime')({tenants:[...watcher.tenants.keys()],dynamic:true,maxTenants:20,eventDriven:true,readCurrent:current,detect:require('../lib/pgstream/realtime-output').detector({config:rtConfig,connection:clinical.reader,trusted,readAll:async ids=>new Map(await Promise.all(ids.map(async tenant=>[tenant,await current(tenant)]))),owner:()=>{}}),create:ctx=>require('../lib/pgstream/realtime-output').projection({config:rtConfig,connection:clinical.reader,current:ctx,operationWindow:{currentGeneration:tenant=>generations.get(tenant)}}),fanout:async row=>frames.set(row.tenant,row.next.frame)});
    await watcher.follow({prepare:async tenant=>{await held.get(tenant);if(!(await eligibility.check('evaluator',tenant)).eligible)throw Object.assign(new Error('deferred'),{code:'TENANT_ACTIVITY_DEFERRED'});startup.addTenant(tenant);try{if(failWarm){failWarm=false;throw new Error('synthetic failed warm');}await startup.ensure(tenant);evaluator.addTenant(tenant);realtime.addTenant(tenant);
      return async()=>{rollbackCount++;await evaluator.removeTenant(tenant);await realtime.removeTenant(tenant);await startup.removeTenant(tenant);};}
      catch(error){await startup.removeTenant(tenant);throw error;}},activate:tenant=>{evaluator.acquire(tenant).catch(()=>{});realtime.wake(tenant);},
      remove:async tenant=>{await evaluator.removeTenant(tenant);await realtime.removeTenant(tenant);await startup.removeTenant(tenant);}});
  });
  after(async function(){
    await watcher?.close().catch(()=>{});await activityStore?.close().catch(()=>{});await evaluator?.close().catch(()=>{});await realtime?.close().catch(()=>{});startup?.close();await provisioner?.close().catch(()=>{});
    await trusted?.close().catch(()=>{});await completed?.close().catch(()=>{});await registry?.close().catch(()=>{});await clinical?.close().catch(()=>{});scope.setTenancyMode(prior);
    for(const [name,value]of Object.entries(saved||{})){if(value===undefined)delete process.env[name];else process.env[name]=value;}
    if(container)try{docker(['rm','--force','--volumes',container]);}catch{/* owned container may already have exited */}
  });
  it('provisions while running, retries failed warm, then computes first clinical alarm/frame without restarting the existing tenant',async function(){
    const runtimeId=evaluator.last(existing).runtimeId;
    const start=Date.now();failWarm=true;await provisioner.provision({id:added,hosts:['new-'+added+'.example.test']});await seed(added,300);
    await watcher.poll();await watcher.drained();assert.equal(watcher.isActive(added),false);assert.equal(evaluator.last(added),null);
    await evaluator.tick(existing);assert.equal(evaluator.last(existing).runtimeId,runtimeId,'LIVE_EXISTING_RUNTIME_NOT_RESTARTED');
    await sleep(260);await watcher.poll();await watcher.drained();
    await wait(()=>evaluations.get(added)&&frames.get(added));
    assert.equal(watcher.isActive(added),true,'LIVE_NATIVE_ADMITTED_WITHOUT_RESTART');
    assert.equal(evaluations.get(added).properties.bgnow.mean,300,'LIVE_NATIVE_FIRST_EVALUATION');
    assert.ok(evaluations.get(added).emitted.some(row=>row.level!=='None'),'LIVE_NATIVE_FIRST_ALARM');
    assert.ok(frames.get(added).sgvs.some(row=>row.mgdl===300),'LIVE_NATIVE_FIRST_FRAME');
    assert.equal(evaluator.last(existing).runtimeId,runtimeId);assert.equal(evaluations.get(existing).properties.bgnow.mean,240);
    assert.ok(evaluations.get(existing).emitted.some(row=>row.level!=='None'),'LIVE_EXISTING_ALARM_CONTINUES');
    const progressBefore=evaluator.health().tenants.find(row=>row.tenant===existing).cycles;await evaluator.tick(existing);assert.ok(evaluator.health().tenants.find(row=>row.tenant===existing).cycles>progressBefore,'LIVE_EXISTING_EVALUATION_PROGRESS');
    console.log('LIVE_ADD_NATIVE_MS',Date.now()-start);
  });
  it('defers paused/suspended new tenants and admits them on resume without a registry revision or data write',async function(){
    for(const flag of ['paused','suspended']){
      const tenant=randomUUID();let release;held.set(tenant,new Promise(resolve=>{release=resolve;}));
      await provisioner.provision({id:tenant,hosts:['activity-'+tenant+'.example.test']});
      await q('UPDATE "'+registry.namespaces.control+'".tenant_activity SET '+flag+'=true,version=version+1 WHERE tenant_id=$1',[tenant]);
      release();held.delete(tenant);await watcher.poll();await watcher.drained();
      assert.equal(watcher.isActive(tenant),false,'LIVE_ACTIVITY_NO_ADMISSION');assert.equal(evaluator.last(tenant),null);assert.equal(realtime.last(tenant),null);
      const revision=watcher.revision();await q('UPDATE "'+registry.namespaces.control+'".tenant_activity SET '+flag+'=false,version=version+1 WHERE tenant_id=$1',[tenant]);
      await sleep(270);await watcher.poll();await watcher.drained();await wait(()=>evaluator.last(tenant)&&frames.get(tenant));
      assert.equal(watcher.revision(),revision,'LIVE_RESUME_NO_REGISTRY_REVISION');assert.equal(watcher.isActive(tenant),true,'LIVE_RESUME_ADMITS');
    }
  });
  it('handles an addition burst and removes only the selected tenant with no late output resurrection',async function(){
    const burst=[randomUUID(),randomUUID(),randomUUID()];
    for(const tenant of burst){await provisioner.provision({id:tenant,hosts:['burst-'+tenant+'.example.test']});await seed(tenant,130);}
    await watcher.poll();await watcher.drained();await wait(()=>burst.every(t=>evaluator.last(t)&&frames.get(t)));
    await q('UPDATE "'+registry.namespaces.registry+'".tenant_registry SET state=\'removed\' WHERE tenant_id=$1',[added]);
    await watcher.poll();assert.equal(watcher.isActive(added),false,'LIVE_REMOVE_HIDDEN_BEFORE_DRAIN');await watcher.drained();assert.equal(evaluator.last(added),null);assert.equal(realtime.last(added),null);
    await evaluator.tick(existing);assert.ok(evaluator.last(existing));assert.ok(burst.every(t=>evaluator.last(t)));
    assert.equal(rollbackCount,0,'no successful tenant was rolled back');
  });
});
