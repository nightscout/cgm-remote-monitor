'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Module=require('node:module');
function isolated(relative,mocks) {
  const filename=path.resolve(__dirname,'../lib/'+relative),loaded=new Module(filename,module);
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  const original=loaded.require.bind(loaded);
  loaded.require=name=>Object.hasOwn(mocks,name)?mocks[name]:original(name);
  loaded._compile(fs.readFileSync(filename,'utf8'),filename);return loaded.exports;
}
const parse=require('../lib/server/serve/evaluator-config');
const link=require('../lib/server/realtime/notification-state-config');
const A='11111111-1111-4111-8111-111111111111';
function config() {return {version:1,datastore:{hostname:'127.0.0.1',port:5432,database:'synthetic_test'},
  postgres:{connectionEnv:'EVALUATOR_PG',namespaces:Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','clock','checkpoint'].map(n=>[n,'metadata_'+n]))},
  consumer:'evaluator-metadata',pageSize:1,maxRows:10,maxBytes:100000,maxTenants:2,timeIntervalMs:100,
  registry:{namespace:'metadata_registry',refreshMs:500},
  tenantSettings:{connectionEnv:'SETTINGS_PG',namespaces:{settings:'metadata_display_settings',operatorPolicy:'metadata_policy'}},
  activity:{connectionEnv:'ACTIVITY_PG',namespace:'metadata_control'},
  trustedWorker:{activity:'metadata_control',clock:'metadata_clock',settings:'metadata_display_settings',operatorPolicy:'metadata_policy'},
  pgstream:{receiver:{url:'http://127.0.0.1:'+19913+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:16777216,timeoutMs:5000},slot:'metadata_pgstream',streamRole:'metadata_stream',
    bounds:{stepMs:5000,recoveryMs:30000,pendingMs:30000}},consumers:{realtime:{
    outbox:{connectionEnv:'OUTBOX_PG',namespace:'metadata_outbox',maxRows:10,maxBytes:100000,maxConnections:2},
    suppression:{connectionEnv:'SUPPRESSION_PG',namespace:'metadata_alarm',maxRows:10,maxBytes:100000,maxConnections:2},
    route:{id:'realtime-metadata',maxMessageBytes:20000,operationTimeoutMs:100},
    maxPayloadBytes:10000,maxInflight:2,attemptTimeoutMs:100,retryDelayMs:100,pollIntervalMs:100,retryIntervalMs:100}}};}
const env={SETTINGS_PG:'postgres://metadata-settings:synthetic@127.0.0.1:5432/synthetic_test',ACTIVITY_PG:'postgres://metadata-activity:synthetic@127.0.0.1:5432/synthetic_test',PGSTREAM_BINARY:'/usr/local/bin/pgstream',PGSTREAM_CONFIG:'/tmp/synthetic-pgstream.json',EVALUATOR_PG:'postgres://synthetic-evaluator:synthetic@127.0.0.1:5432/synthetic_test',
  OUTBOX_PG:'postgres://synthetic-outbox:synthetic@127.0.0.1:5432/synthetic_test',
  SUPPRESSION_PG:'postgres://synthetic-suppression:synthetic@127.0.0.1:5432/synthetic_test',NS_REALTIME_INTERNAL_SOCKET:'/tmp/synthetic-metadata/alarm.sock'};
describe('selected API evaluator metadata without worker credentials',function(){
  let dir,file;
  beforeEach(function(){dir=fs.mkdtempSync(path.join(os.tmpdir(),'metadata-'));file=path.join(dir,'evaluator.json');fs.writeFileSync(file,JSON.stringify(config()));});
  afterEach(function(){fs.rmSync(dir,{recursive:true,force:true});});
 it('uses the application default for an omitted evaluator working-set limit and preserves explicit limits',()=>{
  const document=config();
  const original=parse.parseMetadata(document);
  delete document.maxTenants;
  document.registry.maxTenants=16;
  assert.equal(parse.parseMetadata(document).maxTenants,10000);
  assert.equal(original.maxTenants,2);
  document.maxTenants=null;
  assert.throws(()=>parse.parseMetadata(document));
 });
  it('links samefile with no worker credential or route environment and shares exact worker tenant identity',async function(){
    const value=config(),worker=parse.parse(value,env),metadata=parse.parseMetadata(value);
    const effective=version=>require('../lib/tenant-settings/component').resolveEffectiveSettings({version,values:{enable:['simplealarms'],SHOW_SECONDS:version>1}},{generation:1,deployment:{},overrides:{}});
    let current=effective(1);const identity=()=>parse.applySettings(parse.registryEntry(A),current).identity;
    assert.equal(metadata.registry.namespace,worker.registry.namespace);assert.equal(worker.tenants.size,0,'worker roster is admitted registry state');
    assert.equal(Object.hasOwn(metadata,'connectionString'),false);assert.equal(Object.hasOwn(metadata.consumers.realtime.outbox,'connectionString'),false);
    assert.equal(Object.hasOwn(metadata.consumers.realtime.route,'socketPath'),false);
    const apiOnly={LINKED_EVALUATOR:file,SETTINGS_PG:env.SETTINGS_PG};
    const metadataPort=isolated('server/serve/evaluator-config.js',{'../../tenant-settings/effective-postgres':async()=>({read:async()=>current,close:async()=>{}})});
    const metadataLink=isolated('server/realtime/notification-state-config.js',{'../serve/evaluator-config':metadataPort});
    const selected=metadataLink({evaluatorConfigEnv:'LINKED_EVALUATOR'},apiOnly,{namespace:'metadata_alarm',connectionString:'postgres://synthetic-ack:synthetic@127.0.0.1:5432/synthetic_test'});
    const admission={namespace:'metadata_registry',allows:async tenant=>tenant===A};
    const before=identity();assert.equal((await selected.readCurrent(A,admission)).identity,before,'METADATA_API_NO_WORKER_CREDENTIALS');
    assert.throws(()=>parse.parse(value,apiOnly),/invalid/,'full worker still requires actual credential resolution');
    const d=config();current=effective(2);assert.notEqual((await selected.readCurrent(A,admission)).identity,before,'current committed settings change presentation identity without editing a static roster');
    // Keep the separately checked datastore descriptor valid: this is the infrastructure-restart boundary.
    d.pgstream.slot='metadata_other_stream';fs.writeFileSync(file,JSON.stringify(d));await assert.rejects(selected.readCurrent(A,admission),/restart/);
  });
  it('resolves the realtime peer address only for the worker and preserves API metadata separation',function(){
    const value=config(),{NS_REALTIME_INTERNAL_SOCKET:shouldNotUseSocket,...network}=env;
    const source={...network,NS_REALTIME_INTERNAL_URL:'http://realtime-internal.nightscout.svc.cluster.local:1402'};
    const worker=parse.parse(value,source),metadata=parse.parseMetadata(value);
    assert.equal(worker.consumers.realtime.route.url,'http://realtime-internal.nightscout.svc.cluster.local:1402/');
    assert.equal(worker.consumers.realtime.route.trust,'network');
    assert.equal(Object.hasOwn(metadata.consumers.realtime.route,'url'),false,'API metadata does not resolve worker endpoints');
    for(const retired of [{socketPathEnv:'RT_PATH'},{endpoint:{urlEnv:'PRIVATE_ALARM',trust:'network'}}]){
      const old=structuredClone(value);Object.assign(old.consumers.realtime.route,retired);assert.throws(()=>parse.parseMetadata(old),/invalid/,'per-contract endpoint keys are retired');
    }
    assert.throws(()=>parse.parse(value,{...source,NS_REALTIME_INTERNAL_SOCKET:'/tmp/synthetic-metadata/alarm.sock'}),error=>error instanceof require('../lib/server/internal-api/listener-config').InternalListenerConfigError && /exclusive/.test(error.message),'required pgstream and consumer peers use the same exclusive listener resolver');
    const {NS_REALTIME_INTERNAL_SOCKET:shouldOmitSocket,...defaults}=env;
    assert.equal(parse.parse(value,{...defaults,XDG_RUNTIME_DIR:'/run/user/1000'}).consumers.realtime.route.socketPath,'/run/user/1000/nightscout/realtime.sock','default peer socket');
  });
  it('resolves the pgstream worker output peer through the default listener resolver',function(){
    const value=config();delete value.tenants;value.registry={namespace:'metadata_registry',refreshMs:500};
    value.tenantSettings={connectionEnv:'SETTINGS_PG',namespaces:{settings:'metadata_display_settings',operatorPolicy:'metadata_policy'}};
    value.activity={connectionEnv:'ACTIVITY_PG',namespace:'metadata_control'};
    value.trustedWorker={activity:'metadata_control',clock:'metadata_clock',settings:'metadata_display_settings',operatorPolicy:'metadata_policy'};
    value.pgstream={receiver:{url:'http://127.0.0.1:'+19913+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:16777216,timeoutMs:5000},slot:'metadata_pgstream',streamRole:'metadata_stream',
      bounds:{stepMs:5000,recoveryMs:30000,pendingMs:30000}};
    const source={...env,SETTINGS_PG:'postgres://metadata-settings:synthetic@127.0.0.1:5432/synthetic_test',ACTIVITY_PG:'postgres://metadata-activity:synthetic@127.0.0.1:5432/synthetic_test',
      PGSTREAM_BINARY:'/usr/local/bin/pgstream',PGSTREAM_CONFIG:'/tmp/synthetic-pgstream.json'};
    const worker=parse.parse(value,source);
    assert.equal(worker.pgstream.outputPeer.socketPath,env.NS_REALTIME_INTERNAL_SOCKET,'PGSTREAM_WORKER_DEFAULT_PEER_RESOLVED');
    assert.equal(Object.hasOwn(parse.parseMetadata(value).pgstream,'outputPeer'),false,'metadata never resolves worker peer');
  });
  it('refuses descriptor mismatch at both actual worker URI and API own admitted endpoint without aliasing credentials',function(){
    const d=config();d.datastore.database='other_test';assert.throws(()=>parse.parse(d,env),/invalid/,'METADATA_WORKER_DESCRIPTOR_BINDING');
    assert.throws(()=>link({evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file,SETTINGS_PG:env.SETTINGS_PG},{namespace:'metadata_alarm',connectionString:env.EVALUATOR_PG.replace('synthetic_test','other_test')}),/CONFIG_REFUSED/,'METADATA_API_DESCRIPTOR_BINDING');
    const no=config();delete no.datastore;fs.writeFileSync(file,JSON.stringify(no));
    assert.throws(()=>link({evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file,SETTINGS_PG:env.SETTINGS_PG},{namespace:'metadata_alarm',connectionString:env.EVALUATOR_PG}),/CONFIG_REFUSED/);
    assert.doesNotThrow(()=>parse.parse(no,env),'unselected worker descriptor remains optional');
  });
  it('reads current registry evaluator metadata only through the same admitted registry capability',async function(){
    const value=config();delete value.tenants;value.registry={namespace:'metadata_registry',refreshMs:500};
    value.tenantSettings={connectionEnv:'SETTINGS_PG',namespaces:{settings:'metadata_display_settings',operatorPolicy:'metadata_policy'}};
    fs.writeFileSync(file,JSON.stringify(value));
    const metadata=parse.loadMetadata({MULTITENANT_EVALUATOR_CONFIG:file,SETTINGS_PG:'postgres://metadata-settings:synthetic@127.0.0.1:5432/synthetic_test'});
    const state=require('../lib/tenant-settings/component').resolveEffectiveSettings({version:1,values:{}},{generation:1,deployment:{},overrides:{}});
    let active=true,reads=0,admits=0;
    const reader={matches:()=>true,read:async tenant=>{assert.equal(tenant,A);reads++;return state;}};
    const admission={namespace:'metadata_registry',allows:async tenant=>{admits++;return active&&tenant===A;}};
    const current=await metadata.readCurrent(A,reader,admission);
    assert(current,'REGISTRY_ACK_METADATA_CURRENT_REQUIRED');
    assert.equal(current.tenant,A);assert.equal(current.identity,parse.applySettings(parse.registryEntry(A),state).identity);
    assert.equal(metadata.tenants.size,0,'no caller-injected static roster or materialized cache');
    assert.equal(reads,1);assert.equal(admits,2,'admission brackets current settings read');
    active=false;assert.equal(await metadata.readCurrent(A,reader,admission),null);assert.equal(reads,1);
    active=true;assert.equal(await metadata.readCurrent('22222222-2222-4222-8222-222222222222',reader,admission),null);assert.equal(reads,1);
    assert.equal(await metadata.readCurrent(A,reader),null,'registry metadata without its owned admission refuses');
    assert.equal(await metadata.readCurrent(A,reader,{...admission,namespace:'foreign_registry'}),null);assert.equal(reads,1);
  });
  it('refuses registry removal during the metadata read and rechecks the linked configuration',async function(){
    const value=config();delete value.tenants;value.registry={namespace:'metadata_registry',refreshMs:500};
    value.tenantSettings={connectionEnv:'SETTINGS_PG',namespaces:{settings:'metadata_display_settings',operatorPolicy:'metadata_policy'}};fs.writeFileSync(file,JSON.stringify(value));
    const metadata=parse.loadMetadata({MULTITENANT_EVALUATOR_CONFIG:file,SETTINGS_PG:'postgres://metadata-settings:synthetic@127.0.0.1:5432/synthetic_test'});
    const state=require('../lib/tenant-settings/component').resolveEffectiveSettings({version:1,values:{}},{generation:1,deployment:{},overrides:{}});
    let active=true;
    const admission={namespace:'metadata_registry',allows:async()=>active};
    const reader={matches:()=>true,read:async()=>{active=false;return state;}};
    assert.equal(await metadata.readCurrent(A,reader,admission),null,'removed while reading settings must not publish metadata');
    const changed=structuredClone(value);changed.registry.namespace='different_registry';fs.writeFileSync(file,JSON.stringify(changed));
    await assert.rejects(metadata.readCurrent(A,reader,admission),/restart/,'linked registry substitution is infrastructure change');
  });
  it('opens only the existing per-operation metadata reader after admission and always awaits its close',async function(){
    const value=config();delete value.tenants;value.registry={namespace:'metadata_registry',refreshMs:500};
    value.tenantSettings={connectionEnv:'SETTINGS_PG',namespaces:{settings:'metadata_display_settings',operatorPolicy:'metadata_policy'}};
    fs.writeFileSync(file,JSON.stringify(value));
    const source={MULTITENANT_EVALUATOR_CONFIG:file,SETTINGS_PG:'postgres://metadata-settings:synthetic@127.0.0.1:5432/synthetic_test'};
    const state=require('../lib/tenant-settings/component').resolveEffectiveSettings({version:1,values:{}},{generation:1,deployment:{},overrides:{}});
    const calls={open:0,read:0,close:0};let fail=false,closed=false,active=true;
    const loaded=isolated('server/serve/evaluator-config.js',{'../../tenant-settings/effective-postgres':async options=>{
      calls.open++;assert.equal(options.connectionString,source.SETTINGS_PG);assert.deepEqual(options.namespaces,value.tenantSettings.namespaces);
      return {read:async tenant=>{calls.read++;assert.equal(tenant,A);if(fail)throw Error('synthetic metadata read failure');return state;},
        close:async()=>{await new Promise(resolve=>setImmediate(resolve));closed=true;calls.close++;}};
    }}).loadMetadata(source);
    const admission={namespace:'metadata_registry',allows:async tenant=>active&&tenant===A};
    for(const [tenant,capability] of [[A,undefined],[A,{...admission,namespace:'foreign_registry'}],['22222222-2222-4222-8222-222222222222',admission]])
      assert.equal(await loaded.readCurrent(tenant,undefined,capability),null);
    active=false;assert.equal(await loaded.readCurrent(A,undefined,admission),null);
    assert.deepEqual(calls,{open:0,read:0,close:0},'refused tenants never open a metadata DB resource');
    active=true;assert((await loaded.readCurrent(A,undefined,admission)).identity);assert.equal(closed,true);
    closed=false;fail=true;await assert.rejects(loaded.readCurrent(A,undefined,admission),/synthetic metadata read failure/);
    assert.equal(closed,true,'failure waits for reader closure');assert.deepEqual(calls,{open:2,read:2,close:2});
  });
  for (const partitioned of [false,true]) it('carries registry admission through linked metadata into the actual private ACK transaction '+(partitioned?'with static partition catalogue and no workers':'with default ledger')+' (SQL protocol only)',async function(){
    const scope=require('../lib/storage/tenant-scope'),previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    try {
      const value=config();delete value.tenants;value.registry={namespace:'metadata_registry',refreshMs:500};
      value.tenantSettings={connectionEnv:'SETTINGS_PG',namespaces:{settings:'metadata_display_settings',operatorPolicy:'metadata_policy'}};
      if(partitioned)value.consumers.realtime.partitionMetadata={checkpointNamespace:value.postgres.namespaces.checkpoint,membershipNamespace:'metadata_membership',lifecycleNamespace:'metadata_lifetime'};
      fs.writeFileSync(file,JSON.stringify(value));
      const state=require('../lib/tenant-settings/component').resolveEffectiveSettings({version:1,values:{}},{generation:1,deployment:{},overrides:{}});
      let active=true,afterRead=()=>{},reads=0,currentSettings=state;
      const metadata=isolated('server/serve/evaluator-config.js',{'../../tenant-settings/effective-postgres':async()=>({
        read:async()=>{reads++;const snapshot=currentSettings;afterRead();return snapshot;},close:async()=>{}})});
      const selected=isolated('server/realtime/notification-state-config.js',{'../serve/evaluator-config':metadata})(
        {evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file,SETTINGS_PG:env.EVALUATOR_PG},
        {namespace:'metadata_alarm',connectionString:env.SUPPRESSION_PG});
      const a=require('./fixtures/tenant-alarm-protocol')(),n=require('./fixtures/tenant-notifications')();
      if(partitioned)n.unsafe({ledger:parse.parseMetadata(value).consumers.realtime.expectedCatalogue.migrations.map(({name,checksum})=>({name,checksum}))});
      const db={transaction:fn=>n.connection.transaction(()=>a.db.transaction(fn)),async query(sql,args){
        assert(!/pool_membership|pool_desired|tenant_consumer_checkpoint/.test(sql),'ACK_NEVER_READS_LIVE_WORKERS_OR_ASSIGNMENTS');
        if(sql.startsWith('SELECT c.anonymous_roles'))return {rows:[{anonymous_roles:['denied']}]};
        if(sql.includes('notification-ack-time'))return a.db.query(sql,args);
        if(sql.includes('notification-')||sql.includes('tenant_notification_state')){
          const result=await n.connection.query(sql,args);
          if(sql.includes('notification-readiness-table'))for(const row of result.rows){row.inserts=false;row.any_writes=false;row.columns.forEach(column=>{column.inserts=false;column.updates=false;});}
          return result;
        }
        return a.db.query(sql,args);
      }};
      const token=Symbol(),admission=require('../lib/server/realtime/registry-admission').create({
        resolver:{resolve:async()=>A},active:async tenant=>active&&tenant===A});
      const make=namespace=>require('../lib/server/realtime/private-api').operations({token,alarmConnection:db,admission,
        authority:{authorizeWrite:async op=>({tenant:op.tenant,principal:{kind:'root'}})},executeWrite:async()=>{throw Error('unexpected clinical write');},
        config:{registry:{namespace},bindings:new Map([[A,true]]),namespaces:{authorization:'metadata_authorization'},
          socketForwarding:{alarm:{namespace:'alarm_protocol'},consumerState:selected}}});
      const call=ops=>ops.executeSocketMutation({transport:token},{host:'a.example.test',envelope:{tenant:A,namespace:'/alarm',event:'ack',credential:{secret:'synthetic'},args:[2,'default',1000]}});
      await assert.rejects(call(make('foreign_registry')),/SOCKET_FORWARD_UNAVAILABLE/);
      assert.equal(reads,0);assert.deepEqual(a.rows(),[]);
      afterRead=()=>{active=false;};await assert.rejects(call(make('metadata_registry')),/SOCKET_FORWARD_UNAVAILABLE/);
      assert.deepEqual(a.rows(),[],'registry removal during settings read rolls back ACK');
      active=true;afterRead=()=>{currentSettings=require('../lib/tenant-settings/component').resolveEffectiveSettings({version:2,values:{SHOW_SECONDS:true}},{generation:1,deployment:{},overrides:{}});};
      await assert.rejects(call(make('metadata_registry')),/SOCKET_FORWARD_UNAVAILABLE/);
      assert.deepEqual(a.rows(),[],'settings identity change between ACK admission and recheck rolls back');
      currentSettings=state;afterRead=()=>{};const before=reads;
      await call(make('metadata_registry'));
      assert.equal(reads-before,2,'current metadata is rechecked inside the ACK boundary');
      assert.equal(a.calls.at(-1),'COMMIT');assert.equal(a.rows().length,2,'actual writer protocol commits both suppression levels');
      if(partitioned){
        const before=structuredClone(a.rows());n.unsafe({});
        await assert.rejects(call(make('metadata_registry')),/SOCKET_FORWARD_UNAVAILABLE/,'selected static metadata refuses the old ledger');
        const ledger=parse.parseMetadata(value).consumers.realtime.expectedCatalogue.migrations.map(({name,checksum})=>({name,checksum}));ledger.at(-1).checksum='f'.repeat(64);n.unsafe({ledger});
        await assert.rejects(call(make('metadata_registry')),/SOCKET_FORWARD_UNAVAILABLE/,'selected static metadata refuses a wrong added migration');assert.deepEqual(a.rows(),before);
      }
      // This is not a native PostgreSQL, producer clear or client delivery claim.
    } finally {scope.setTenancyMode(previous);}
  });
  it('validates metadata shape bounds namespaces and reference names without accepting secret capability fields',function(){
    for(const change of [d=>d.datastore.password='forbidden',d=>d.datastore.port=0,d=>d.postgres.connectionEnv='bad reference',
      d=>d.consumers.realtime.outbox.connectionString='forbidden',d=>d.consumers.realtime.route.socketPath='/tmp/forbidden',
      d=>d.consumers.realtime.outbox.namespace=d.postgres.namespaces.entries,d=>d.consumers.realtime.retryIntervalMs=2147483648,
      d=>d.consumers.realtime.suppression.connectionEnv='bad reference']){const d=config();change(d);assert.throws(()=>parse.parseMetadata(d),/invalid/);}
    const descriptor=config();delete descriptor.datastore;assert.doesNotThrow(()=>parse.parseMetadata(descriptor));
  });

  it('keeps default consumer metadata and socket projection unchanged',function(){
    const value=config(),parsed=parse.parseMetadata(value);assert.deepEqual(parsed.consumers,value.consumers);
    const projected=link({evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file,SETTINGS_PG:env.SETTINGS_PG},{namespace:'metadata_alarm',connectionString:env.SUPPRESSION_PG});
    const {readCurrent,...shape}=projected;assert.equal(typeof readCurrent,'function');
    assert.deepEqual(shape,{namespace:'metadata_outbox',consumer:'realtime-metadata',maxRows:10,maxBytes:100000,maxPayloadBytes:10000});
  });
  it('derives only a static catalogue and rejects namespace collisions, raw catalogues and dynamic authority',function(){
    const value=config();value.consumers.realtime.partitionMetadata={checkpointNamespace:value.postgres.namespaces.checkpoint,membershipNamespace:'metadata_membership',lifecycleNamespace:'metadata_lifetime'};
    const expected=require('../lib/tenant-notifications/partition-candidate').build({...value.consumers.realtime.partitionMetadata,consumer:value.consumers.realtime.route.id,evaluatorConsumer:value.consumer+'-completed'}).catalogue;
    assert.deepEqual(parse.parseMetadata(value).consumers.realtime.expectedCatalogue,expected);
    assert.deepEqual(parse.parse(value,env).consumers.realtime.expectedCatalogue,expected);
    const collisions=[...Object.values(value.postgres.namespaces).filter(x=>x!==value.postgres.namespaces.checkpoint),value.registry.namespace,value.activity.namespace,...Object.values(value.tenantSettings.namespaces),value.consumers.realtime.outbox.namespace,value.consumers.realtime.suppression.namespace];
    for(const field of ['membershipNamespace','lifecycleNamespace'])for(const name of collisions){const bad=structuredClone(value);bad.consumers.realtime.partitionMetadata[field]=name;assert.throws(()=>parse.parseMetadata(bad),/invalid/);}
    for(const mutate of [d=>d.consumers.realtime.partitionMetadata.checkpointNamespace='foreign_checkpoint',d=>d.consumers.realtime.partitionMetadata.lifecycleNamespace='metadata_membership',d=>d.consumer='not-an-evaluator',d=>d.consumers.realtime.expectedCatalogue=expected,...['ordinal','memberId','lease','revision','catalogue','sql','consumer'].map(key=>d=>d.consumers.realtime.partitionMetadata[key]='forbidden')]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>parse.parseMetadata(bad),/invalid/);}
    for(const field of ['consumer','route']){const changed=structuredClone(value);if(field==='consumer')changed.consumer='evaluator-other';else changed.consumers.realtime.route.id='realtime-other';assert.notDeepEqual(parse.parseMetadata(changed).consumers.realtime.expectedCatalogue,expected);}
  });
  it('binds static namespace changes to infrastructure restart before any worker lookup',async function(){
    const value=config();value.consumers.realtime.partitionMetadata={checkpointNamespace:value.postgres.namespaces.checkpoint,membershipNamespace:'metadata_membership',lifecycleNamespace:'metadata_lifetime'};fs.writeFileSync(file,JSON.stringify(value));
    const metadata=parse.loadMetadata({MULTITENANT_EVALUATOR_CONFIG:file,SETTINGS_PG:env.SETTINGS_PG});
    value.consumers.realtime.partitionMetadata.membershipNamespace='replacement_membership';fs.writeFileSync(file,JSON.stringify(value));
    await assert.rejects(metadata.readCurrent(A),/restart/);
  });
});
