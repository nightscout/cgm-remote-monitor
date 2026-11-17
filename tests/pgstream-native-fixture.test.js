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
