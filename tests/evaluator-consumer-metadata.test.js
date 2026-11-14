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
  consumer:'evaluator-metadata',pageSize:1,maxRows:10,maxBytes:100000,maxTenants:2,recoveryIntervalMs:100,timeIntervalMs:100,
  tenants:[{id:A,revision:'one',settings:{enable:['simplealarms']}}],consumers:{realtime:{
    outbox:{connectionEnv:'OUTBOX_PG',namespace:'metadata_outbox',maxRows:10,maxBytes:100000,maxConnections:2},
    suppression:{connectionEnv:'SUPPRESSION_PG',namespace:'metadata_alarm',maxRows:10,maxBytes:100000,maxConnections:2},
    route:{id:'realtime-metadata',maxMessageBytes:20000,operationTimeoutMs:100},
    maxPayloadBytes:10000,maxInflight:2,attemptTimeoutMs:100,retryDelayMs:100,pollIntervalMs:100,retryIntervalMs:100}}};}
const env={EVALUATOR_PG:'postgres://synthetic-evaluator:synthetic@127.0.0.1:5432/synthetic_test',
  OUTBOX_PG:'postgres://synthetic-outbox:synthetic@127.0.0.1:5432/synthetic_test',
  SUPPRESSION_PG:'postgres://synthetic-suppression:synthetic@127.0.0.1:5432/synthetic_test',NS_REALTIME_INTERNAL_SOCKET:'/tmp/synthetic-metadata/alarm.sock'};
describe('selected API evaluator metadata without worker credentials',function(){
  let dir,file;
  beforeEach(function(){dir=fs.mkdtempSync(path.join(os.tmpdir(),'metadata-'));file=path.join(dir,'evaluator.json');fs.writeFileSync(file,JSON.stringify(config()));});
  afterEach(function(){fs.rmSync(dir,{recursive:true,force:true});});
  it('links samefile with no worker credential or route environment and shares exact worker tenant identity',async function(){
    const value=config(),worker=parse.parse(value,env),metadata=parse.parseMetadata(value);
    assert.equal(metadata.tenants.get(A).identity,worker.tenants.get(A).identity);
    assert.equal(Object.hasOwn(metadata,'connectionString'),false);assert.equal(Object.hasOwn(metadata.consumers.realtime.outbox,'connectionString'),false);
    assert.equal(Object.hasOwn(metadata.consumers.realtime.route,'socketPath'),false);
    const apiOnly={LINKED_EVALUATOR:file};
    const selected=link({evaluatorConfigEnv:'LINKED_EVALUATOR'},apiOnly,{namespace:'metadata_alarm',connectionString:'postgres://synthetic-ack:synthetic@127.0.0.1:5432/synthetic_test'});
    assert.equal((await selected.readCurrent(A)).identity,worker.tenants.get(A).identity,'METADATA_API_NO_WORKER_CREDENTIALS');
    assert.throws(()=>parse.parse(value,apiOnly),/invalid/,'full worker still requires actual credential resolution');
    const d=config();d.tenants[0].revision='two';fs.writeFileSync(file,JSON.stringify(d));assert.notEqual((await selected.readCurrent(A)).identity,worker.tenants.get(A).identity);
    d.datastore.database='other_test';fs.writeFileSync(file,JSON.stringify(d));await assert.rejects(selected.readCurrent(A),/restart/);
  });
  it('resolves the realtime peer address only for the worker and preserves API metadata separation',function(){
    const value=config(),{NS_REALTIME_INTERNAL_SOCKET:unused,...network}=env;
    const source={...network,NS_REALTIME_INTERNAL_URL:'http://realtime-internal.nightscout.svc.cluster.local:1402'};
    const worker=parse.parse(value,source),metadata=parse.parseMetadata(value);
    assert.equal(worker.consumers.realtime.route.url,'http://realtime-internal.nightscout.svc.cluster.local:1402/');
    assert.equal(worker.consumers.realtime.route.trust,'network');
    assert.equal(Object.hasOwn(metadata.consumers.realtime.route,'url'),false,'API metadata does not resolve worker endpoints');
    for(const retired of [{socketPathEnv:'RT_PATH'},{endpoint:{urlEnv:'PRIVATE_ALARM',trust:'network'}}]){
      const old=structuredClone(value);Object.assign(old.consumers.realtime.route,retired);assert.throws(()=>parse.parseMetadata(old),/invalid/,'per-contract endpoint keys are retired');
    }
    assert.throws(()=>parse.parse(value,{...source,NS_REALTIME_INTERNAL_SOCKET:'/tmp/synthetic-metadata/alarm.sock'}),/invalid/,'URL and socket peer addresses are exclusive');
    const {NS_REALTIME_INTERNAL_SOCKET:omitted,...defaults}=env;
    assert.equal(parse.parse(value,{...defaults,XDG_RUNTIME_DIR:'/run/user/1000'}).consumers.realtime.route.socketPath,'/run/user/1000/nightscout/realtime.sock','default peer socket');
  });
  it('refuses descriptor mismatch at both actual worker URI and API own admitted endpoint without aliasing credentials',function(){
    const d=config();d.datastore.database='other_test';assert.throws(()=>parse.parse(d,env),/invalid/,'METADATA_WORKER_DESCRIPTOR_BINDING');
    assert.throws(()=>link({evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file},{namespace:'metadata_alarm',connectionString:env.EVALUATOR_PG.replace('synthetic_test','other_test')}),/CONFIG_REFUSED/,'METADATA_API_DESCRIPTOR_BINDING');
    const no=config();delete no.datastore;fs.writeFileSync(file,JSON.stringify(no));
    assert.throws(()=>link({evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file},{namespace:'metadata_alarm',connectionString:env.EVALUATOR_PG}),/CONFIG_REFUSED/);
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
  it('carries registry admission through linked metadata into the actual private ACK transaction (SQL protocol only)',async function(){
    const scope=require('../lib/storage/tenant-scope'),previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    try {
      const value=config();delete value.tenants;value.registry={namespace:'metadata_registry',refreshMs:500};
      value.tenantSettings={connectionEnv:'SETTINGS_PG',namespaces:{settings:'metadata_display_settings',operatorPolicy:'metadata_policy'}};
      fs.writeFileSync(file,JSON.stringify(value));
      const state=require('../lib/tenant-settings/component').resolveEffectiveSettings({version:1,values:{}},{generation:1,deployment:{},overrides:{}});
      let active=true,afterRead=()=>{},reads=0,currentSettings=state;
      const metadata=isolated('server/serve/evaluator-config.js',{'../../tenant-settings/effective-postgres':async()=>({
        read:async()=>{reads++;const snapshot=currentSettings;afterRead();return snapshot;},close:async()=>{}})});
      const selected=isolated('server/realtime/notification-state-config.js',{'../serve/evaluator-config':metadata})(
        {evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file,SETTINGS_PG:env.EVALUATOR_PG},
        {namespace:'metadata_alarm',connectionString:env.SUPPRESSION_PG});
      const a=require('./fixtures/tenant-alarm-protocol')(),n=require('./fixtures/tenant-notifications')();
      const db={transaction:fn=>n.connection.transaction(()=>a.db.transaction(fn)),async query(sql,args){
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
});
