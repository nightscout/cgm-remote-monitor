'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const observer=require('./fixtures/realtime-preview/observe-api-startup');
describe('explicit observational API startup preload fixture',function(){
  let directory,config,owned=[];
  beforeEach(function(){directory=fs.mkdtempSync(path.join(os.tmpdir(),'api-observe-'));fs.chmodSync(directory,0o700);
    config={file:path.join(directory,'stages.json'),maxBytes:5000,sourceHead:'1'.repeat(40),phaseId:'joined-role-recovery'};});
  afterEach(function(){for(const value of owned)value.close();owned=[];fs.rmSync(directory,{recursive:true});});
  it('does no filesystem or product import work when unselected',function(){
    const original=fs.lstatSync;fs.lstatSync=()=>{throw new Error('DISABLED_IO');};
    try{assert.equal(observer.install({},()=>{throw new Error('DISABLED_PRODUCT_IMPORT');}),null);}finally{fs.lstatSync=original;}
    assert.deepEqual(fs.readdirSync(directory),[]);
  });
  it('preserves actual this/argument/result/promise and original error identity while only observing stage disposition',async function(){
    const receiver={},arg={},result={},events=[];
    const fn=observer.wrap(function(actual){assert.equal(this,receiver);assert.equal(actual,arg);return result;},'private-api.boot',(...row)=>events.push(row));
    assert.equal(fn.call(receiver,arg),result);assert.deepEqual(events.map(row=>row.slice(0,2)),[['private-api.boot','enter'],['private-api.boot','ready']]);
    const promise=Promise.resolve(result),asyncFn=observer.wrap(()=>promise,'migrations.run',()=>{});assert.equal(asyncFn(),promise);assert.equal(await promise,result);
    const error=new Error('synthetic-secret-error');const rejected=Promise.reject(error),failing=observer.wrap(()=>rejected,'migrations.run',()=>{});
    assert.equal(failing(),rejected);await assert.rejects(rejected,actual=>actual===error);
    assert.throws(()=>observer.wrap(()=>{throw error;},'private-api.boot',()=>{})(),actual=>actual===error);
    assert.equal(observer.wrap(()=>result,'private-api.boot',()=>{throw new Error('OBSERVER_FAILED');})(),result,'observer failures must not change actual outcome');
  });
  it('writes only fixed stage/name/safe code/head/PID and never secrets from args results messages stack or unknown names/codes',async function(){
    const output=observer.writer(config);owned.push(output);
    const secret='synthetic-credential-DO-NOT-CAPTURE',error=Object.assign(new Error(secret),{name:secret,code:secret});
    await assert.rejects(observer.wrap(async()=>{throw error;},'private-api.boot',output.record)(secret),actual=>actual===error);
    output.record('migrations.run','refused',Object.assign(new Error(secret),{code:'42501'}));
    const result={secret};assert.equal(await observer.wrap(async()=>result,'private-api.boot',output.record)(),result);
    const text=fs.readFileSync(config.file,'utf8'),actual=JSON.parse(text);assert(!text.includes(secret));
    assert.deepEqual(actual,{sourceHead:config.sourceHead,phaseId:config.phaseId,pid:process.pid,events:[{stage:'private-api.boot',status:'enter'},
      {stage:'private-api.boot',status:'refused',name:'UnclassifiedError',code:'UNCLASSIFIED'},
      {stage:'migrations.run',status:'refused',name:'Error',code:'42501'},{stage:'private-api.boot',status:'enter'},{stage:'private-api.boot',status:'ready'}]});
    assert.equal(fs.statSync(config.file).mode&0o777,0o600);
  });
  it('installs migration wrapper before captured domain imports and forwards original boot functions unchanged',async function(){
    const env={NS_RT_API_STARTUP_OBSERVE:'1',NS_RT_API_STARTUP_OBSERVATION_FILE:config.file,NS_RT_API_STARTUP_OBSERVATION_MAX_BYTES:String(config.maxBytes),NS_RT_SOURCE_HEAD:config.sourceHead,NS_RT_NATIVE_PHASE:config.phaseId};
    const result={},migrations={run:async()=>result};let captured;
    const domains={},api={boot:async()=>result};
    const output=observer.install(env,id=>{
      if(id.endsWith('/migrations/postgres'))return migrations;
      if(id.endsWith('/serve/postgres-domains')){captured=migrations.run;domains.readiness=async()=>captured();domains.assertServing=async()=>result;return domains;}
      if(id.endsWith('/realtime/private-api'))return api;throw new Error('UNEXPECTED_IMPORT');
    });owned.push(output);
    assert.equal(await domains.readiness(),result);assert.equal(await domains.assertServing(),result);assert.equal(await api.boot(),result);
    const actual=JSON.parse(fs.readFileSync(config.file));
    assert.deepEqual(actual.events.map(row=>row.stage+':'+row.status),['postgres-domains.readiness:enter','migrations.run:enter','migrations.run:ready',
      'postgres-domains.readiness:ready','postgres-domains.assertServing:enter','postgres-domains.assertServing:ready','private-api.boot:enter','private-api.boot:ready']);
  });
  it('refuses existing or symlink/foreign paths, wrong private directory mode and exceeded bound without touching replacements',function(){
    fs.writeFileSync(config.file,'synthetic-sentinel');assert.throws(()=>observer.writer(config),error=>error.code==='EEXIST');assert.equal(fs.readFileSync(config.file,'utf8'),'synthetic-sentinel');fs.unlinkSync(config.file);
    const target=path.join(directory,'target');fs.writeFileSync(target,'synthetic-target');fs.symlinkSync(target,config.file);
    assert.throws(()=>observer.writer(config));assert.equal(fs.readFileSync(target,'utf8'),'synthetic-target');fs.unlinkSync(config.file);
    fs.chmodSync(directory,0o755);assert.throws(()=>observer.writer(config),/OWNED_PRIVATE_DIRECTORY/);fs.chmodSync(directory,0o700);
    const output=observer.writer(config);owned.push(output);const initial=fs.readFileSync(config.file);config.maxBytes=initial.length;
    assert.throws(()=>output.record('private-api.boot','enter'),/API_OBSERVER_BOUND/);assert.deepEqual(fs.readFileSync(config.file),initial);
    fs.renameSync(config.file,path.join(directory,'original'));fs.writeFileSync(config.file,'replacement');
    assert.throws(()=>output.record('private-api.boot','enter'),/OWNERSHIP_CHANGED/);assert.equal(fs.readFileSync(config.file,'utf8'),'replacement');
  });
});
