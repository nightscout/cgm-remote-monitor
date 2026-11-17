'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const fixture = require('./fixtures/pgstream-native');
describe('owned native maintained producer fixture', function () {
  let directory;
  beforeEach(function () { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pgstream-fixture-')); });
  afterEach(function () { fs.rmSync(directory, { recursive: true }); });
  it('pins bytes, executable mode and direct file identity with broken/restored controls', function () {
    const file = path.join(directory, 'synthetic-binary'), bytes = 'synthetic binary witness'; fs.writeFileSync(file, bytes, { mode: 0o700 });
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const green = () => assert.equal(fixture.binary(file, hash, hash), file); green();
    fs.appendFileSync(file, 'changed'); assert.throws(() => fixture.binary(file, hash, hash), /BINARY_PIN/); fs.writeFileSync(file, bytes); green();
    fs.chmodSync(file, 0o600); assert.throws(() => fixture.binary(file, hash, hash), /BINARY_PIN/); fs.chmodSync(file, 0o700); green();
    assert.throws(() => fixture.binary(file, '0'.repeat(64), hash), /BINARY_PIN/); green();
    fs.symlinkSync(file, path.join(directory, 'link')); assert.throws(() => fixture.binary(path.join(directory, 'link'), hash, hash), /BINARY_PIN/); green();
    fs.unlinkSync(file); assert.throws(() => fixture.binary(file, hash, hash), /BINARY_MISSING/);
  });
  it('keeps source pin mandatory before any database or initializer work', async function () {
    let calls = 0;
    await assert.rejects(fixture.setup({ admin: { query() { calls++; throw Error('SQL MUST NOT RUN'); } }, source: {} }), /BINARY_PIN/);
    assert.equal(calls, 0);
    assert.deepEqual(Object.keys(fixture.ENV).sort(), ['binary','binding','config','receiverPort','sha256','subscriptionsPort']);
  });
  it('uses explicit caller ports and fixture names, with no port or producer fallback', function () {
    const selected = { receiverPort: 21461, subscriptionsPort: 21462 };
    const config = fixture.configuration({ prefix: 'synthetic_fixture', capability: selected });
    assert.equal(config.receiver.url, 'http://127.0.0.1:21461/'); assert.equal(config.slot, 'synthetic_fixture_pgstream');
    assert.equal(config.streamRole, 'synthetic_fixture_pgstream');
    assert.match(config.generation,/^[a-f0-9]{32}$/);assert.deepEqual(config.recovery,{connectionEnv:'NS_STREAM_RECOVERY_PG',timeoutMs:5000,maxQueued:32}); assert(!Object.hasOwn(config,'binaryEnv'));assert(!Object.hasOwn(config,'configFileEnv'));
    assert.throws(() => fixture.configuration({ prefix: 'bad;sql', capability: selected }), /IDENTIFIER/);
    assert.throws(() => fixture.configuration({ prefix: 'synthetic_fixture' }), /CAPABILITY_REQUIRED/);
  });
  it('delegates exact source routes and the explicit port to the canonical binding', function () {
    const config = { consumer: 'evaluator-fixture', namespaces: { clock: 'synthetic_clock', checkpoint: 'synthetic_checkpoint' },
      trustedWorker: { settings: 'synthetic_settings', operatorPolicy: 'synthetic_policy', activity: 'synthetic_control' },
      pgstream: { slot: 'synthetic_slot', receiver:{url:'http://127.0.0.1:21461/'} } };
    let recorded;
    const value=fixture.wire(config,'postgres://synthetic:synthetic@127.0.0.1:15432/synthetic_test',21462,{wire(...args){recorded=args;return 'canonical-wire';}});
    assert.equal(value,'canonical-wire');assert.equal(recorded[0],config);assert.equal(recorded[2].subscriptionsPort,21462);
    assert.deepEqual(recorded[2].routes,require('../lib/pgstream/evaluator').routes(config));
    assert.throws(()=>fixture.wire(config,'postgres://synthetic@localhost/synthetic_test',21462),/BINDING_REQUIRED/);

  });
});

describe('independently owned native producer fixture lifecycle (inert child ports)',function(){
  const {EventEmitter}=require('node:events');
  let directory;
  beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'external-producer-control-'));});
  afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
  function subject({create=fixture.createProducer,held=false}={}){
    let release;const ready=held?new Promise(resolve=>{release=resolve;}):Promise.resolve();
    const events=[],children=[];let identityChanged=false;
    const io={waitReceiver:async(url,timeout,signal)=>{events.push('receiver-ready-wait');if(held)await Promise.race([ready,new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('PGSTREAM_NATIVE_PRODUCER_START_CANCELLED'),{code:'PGSTREAM_NATIVE_PRODUCER_START_CANCELLED'})),{once:true}))]);},spawn(file,args,options){events.push('producer-spawn');assert.equal(options.detached,false);const child=Object.assign(new EventEmitter(),{pid:43210+children.length,exitCode:null,signalCode:null});children.push(child);return child;},identity:pid=>({pid,birth:identityChanged?'changed':'123',group:41000,uid:1000}),signal(pid,signal){events.push(signal);const child=children.find(row=>row.pid===pid);assert(child);child.signalCode=signal;queueMicrotask(()=>child.emit('exit',null,signal));}};
    return{value:create({binary:'/synthetic/pinned-producer',configFile:'/synthetic/private-wire',receiverURL:'http://127.0.0.1:21572/',timeoutMs:1000,directory:fs.mkdtempSync(path.join(directory,'actor-'))},io),events,children,release:()=>release?.(),change:flag=>{identityChanged=flag;}};
  }
  it('waits only for operational receiver readiness, then starts a driver-owned producer once per explicit action',async()=>{
    const f=subject({held:true}),starting=f.value.start();await Promise.resolve();assert.equal(f.children.length,0,'NO_PRODUCER_BEFORE_RECEIVER_READY');f.release();await starting;assert.equal(f.children.length,1);await f.value.start();assert.equal(f.children.length,1);
    const descriptor=f.value.descriptor();assert.equal(descriptor.configFile,'/synthetic/private-wire');assert.equal(descriptor.receiverURL,'http://127.0.0.1:21572/');
    const child=f.children[0];child.exitCode=1;child.emit('exit',1,null);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.children.length,1,'NO_AUTOMATIC_PROCESS_RETRY');assert.equal(f.value.state().running,false);
    await f.value.start();assert.equal(f.children.length,2,'EXPLICIT_FIXTURE_RESTART');await f.value.close();assert.equal(f.value.state().running,false);
  });
  it('cancels a pending readiness wait during cleanup without spawning a producer',async()=>{
    const f=subject({held:true}),starting=f.value.start();const rejection=assert.rejects(starting,/PGSTREAM_NATIVE_PRODUCER_START_CANCELLED/);await f.value.close();await rejection;assert.equal(f.children.length,0);
  });
  it('refuses a changed producer birth before any signal, then exact restored custody drains it',async()=>{
    const f=subject();await f.value.start();f.change(true);await assert.rejects(f.value.stop(),/EXTERNAL_PRODUCER_BIRTH_CHANGED/);assert(!f.events.includes('SIGTERM'));f.change(false);await f.value.close();assert.deepEqual(f.events.filter(row=>row.startsWith('SIG')),['SIGTERM']);
  });
  it('control: omitted receiver readiness wait is red, restored lifecycle passes',async()=>{
    const Module=require('node:module'),name=require.resolve('./fixtures/pgstream-native'),source=fs.readFileSync(name,'utf8'),needle='await io.waitReceiver(receiverURL,timeoutMs,startAbort.signal);';assert.equal(source.split(needle).length,2);
    const loaded=new Module(name,module);loaded.filename=name;loaded.paths=Module._nodeModulePaths(path.dirname(name));loaded._compile(source.replace(needle,''),name);
    async function criterion(create){const f=subject({create,held:true});const starting=f.value.start();try{await Promise.resolve();assert.equal(f.children.length,0,'NO_PRODUCER_BEFORE_RECEIVER_READY');}finally{f.release();await starting;await f.value.close();}}
    await assert.rejects(criterion(loaded.exports.createProducer),/NO_PRODUCER_BEFORE_RECEIVER_READY/);await criterion(fixture.createProducer);
  });
});

describe('native fixture exact policy resource custody (inert SQL)',function(){
  let directory;
  beforeEach(()=>{directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-policy-custody-'));});
  afterEach(()=>fs.rmSync(directory,{recursive:true,force:true}));
  function subject({realtime=false,partial=false,existing=false,change=source=>source}={}){
    const Module=require('node:module'),filename=require.resolve('./fixtures/pgstream-native'),source=fs.readFileSync(filename,'utf8');
    const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
    // Isolate byte-pin/binding selection only; execute the actual setup/close
    // orchestration with recorded canonical initialization and SQL resources.
    const selection='const selected = capability(source), canonical=binding(source), pgstream = config.pgstream;';
    assert.equal(source.split(selection).length,2);
    loaded._compile(change(source.replace(selection,'const selected = source.selected, canonical=source.canonical, pgstream = config.pgstream;')),filename);
    const file=path.join(directory,'synthetic-producer');fs.writeFileSync(file,'synthetic byte-pinned producer',{mode:0o700});
    const selected={binary:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),receiverPort:21461,subscriptionsPort:21462};
    const config={consumer:'evaluator-synthetic',namespaces:{checkpoint:'synthetic_eval',clock:'synthetic_clock'},trustedWorker:{settings:'synthetic_settings',operatorPolicy:'synthetic_policy',activity:'synthetic_control'},pgstream:fixture.configuration({prefix:'synthetic_fixture',capability:selected})};
    const resources=[{namespace:'synthetic_eval',relation:'tenant_consumer_checkpoint',name:'pgstream_evaluator_metadata'},...(realtime?[
      {namespace:'synthetic_eval',relation:'tenant_consumer_checkpoint',name:'pgstream_realtime_output'},
      {namespace:'synthetic_rt',relation:'tenant_consumer_checkpoint',name:'pgstream_realtime_metadata'},
      {namespace:'synthetic_rt',relation:'tenant_consumer_checkpoint',name:'pgstream_realtime_delivery_update'}]:[])];
    const key=row=>JSON.stringify(row),policies=new Map(),calls=[];let schema=false,role=false,slot=false;
    const unrelated={namespace:'synthetic_eval',relation:'tenant_consumer_checkpoint',name:'peer_policy'};policies.set(key(unrelated),unrelated);
    if(existing)policies.set(key(resources[0]),resources[0]);
    const admin={async query(sql,values){
      calls.push({sql,values});
      if(sql.includes('AS schema_exists'))return{rows:[{schema_exists:schema,role_exists:role,slot_exists:slot,wal_level:'logical'}]};
      if(sql.includes('native-fixture-policy-resources'))return{rows:JSON.parse(values[0]).filter(row=>policies.has(key(row)))};
      if(sql.startsWith('CREATE ROLE ')){role=true;return{rows:[]};}
      if(sql.includes('AS schema_owned'))return{rows:[{schema_owned:schema}]};
      if(sql.startsWith('SELECT active FROM pg_replication_slots'))return{rows:slot?[{active:false}]:[]};
      if(sql.startsWith('SELECT pg_drop_replication_slot')){slot=false;return{rows:[]};}
      if(sql.startsWith('DROP POLICY ')){
        const m=/^DROP POLICY "([^"]+)" ON "([^"]+)"\."([^"]+)"$/.exec(sql);assert(m,'EXACT_POLICY_DROP');
        const resource={namespace:m[2],relation:m[3],name:m[1]};assert(policies.has(key(resource)),'DROP_ONLY_PRESENT_OWNED_POLICY');policies.delete(key(resource));return{rows:[]};
      }
      if(sql.startsWith('DROP SCHEMA pgstream'))schema=false;
      if(sql.startsWith('DROP ROLE '))role=false;
      return{rows:[]};
    }};
    const canonical={async init(){calls.push({init:true});schema=true;slot=true;for(const row of partial?resources.slice(0,1):resources)policies.set(key(row),row);if(partial)throw Error('SYNTHETIC_PARTIAL_INIT');},wire(){return{synthetic:true};}};
    const setup=()=>loaded.exports.setup({admin,adminURI:'postgres://synthetic@127.0.0.1/synthetic',directory,config,evaluatorRole:'synthetic_evaluator',...(realtime?{realtimeRole:'synthetic_realtime',realtimeConfig:{namespaces:{checkpoint:'synthetic_rt'},consumer:'realtime-synthetic'}}:{}),source:{selected,canonical}});
    return{setup,calls,resources,policies,key,unrelated,state:()=>({schema,role,slot})};
  }
  it('retires evaluator and realtime policies after slot shutdown and can initialize another cold source',async()=>{
    for(const realtime of [false,true]){
      const f=subject({realtime}),first=await f.setup();await first.close();
      assert.deepEqual(f.state(),{schema:false,role:false,slot:false});
      assert.deepEqual([...f.policies.values()],[f.unrelated],'PEER_POLICY_UNCHANGED');
      const drops=f.calls.filter(row=>row.sql?.startsWith('DROP POLICY '));assert.equal(drops.length,realtime?4:1,'ALL_OWNED_POLICIES_RETIRED');
      const slot=f.calls.findIndex(row=>row.sql?.startsWith('SELECT pg_drop_replication_slot')),policy=f.calls.findIndex(row=>row.sql?.startsWith('DROP POLICY ')),schema=f.calls.findIndex(row=>row.sql?.startsWith('DROP SCHEMA pgstream'));
      assert(slot<policy&&policy<schema,'POLICY_CLEANUP_AFTER_SLOT_AND_BEFORE_SCHEMA');
      const next=await f.setup();await next.close();assert.equal(f.calls.filter(row=>row.init).length,2);
    }
  });
  it('refuses an unexpected initial canonical policy before mutation and preserves its owner',async()=>{
    const f=subject({existing:true});await assert.rejects(f.setup(),/POLICY_ALREADY_EXISTS/);
    assert.equal(f.calls.filter(row=>row.init).length,0);assert(!f.calls.some(row=>row.sql?.startsWith('CREATE ROLE ')||row.sql?.startsWith('DROP ')));
    assert(f.policies.has(f.key(f.resources[0])));assert(f.policies.has(f.key(f.unrelated)));
  });
  it('cleans only policies created by a partial owned initialization',async()=>{
    const f=subject({realtime:true,partial:true});await assert.rejects(f.setup(),/SYNTHETIC_PARTIAL_INIT/);
    assert.deepEqual(f.state(),{schema:false,role:false,slot:false});assert.deepEqual([...f.policies.values()],[f.unrelated]);
    assert.equal(f.calls.filter(row=>row.sql?.startsWith('DROP POLICY ')).length,1,'ONLY_CREATED_POLICY_DROPPED');
  });
  it('control: omitted owned policy retirement leaves the next source unsafe; restoration retires it',async()=>{
    const needle="await admin.query('DROP POLICY ' + q(policy.name) + ' ON ' + q(policy.namespace) + '.' + q(policy.relation));";
    async function criterion(change){const f=subject({realtime:true,change}),value=await f.setup();await value.close();assert.deepEqual([...f.policies.values()],[f.unrelated],'OWNED_POLICY_RESOURCE_LEAK');}
    await assert.rejects(criterion(source=>{assert.equal(source.split(needle).length,2);return source.replace(needle,'');}),/OWNED_POLICY_RESOURCE_LEAK/);
    await criterion(source=>source);
  });
});
