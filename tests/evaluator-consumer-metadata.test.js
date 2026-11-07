'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const parse=require('../lib/server/serve/evaluator-config');
const link=require('../lib/server/realtime/notification-state-config');
const A='11111111-1111-4111-8111-111111111111';
function config() {return {version:1,datastore:{hostname:'127.0.0.1',port:5432,database:'synthetic_test'},
  postgres:{connectionEnv:'EVALUATOR_PG',namespaces:Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','clock','checkpoint'].map(n=>[n,'metadata_'+n]))},
  consumer:'evaluator-metadata',pageSize:1,maxRows:10,maxBytes:100000,maxTenants:2,recoveryIntervalMs:100,timeIntervalMs:100,
  tenants:[{id:A,revision:'one',settings:{enable:['simplealarms']}}],consumers:{realtime:{
    outbox:{connectionEnv:'OUTBOX_PG',namespace:'metadata_outbox',maxRows:10,maxBytes:100000,maxConnections:2},
    suppression:{connectionEnv:'SUPPRESSION_PG',namespace:'metadata_alarm',maxRows:10,maxBytes:100000,maxConnections:2},
    route:{id:'realtime-metadata',socketPathEnv:'RT_PATH',maxMessageBytes:20000,operationTimeoutMs:100},
    maxPayloadBytes:10000,maxInflight:2,attemptTimeoutMs:100,retryDelayMs:100,pollIntervalMs:100,retryIntervalMs:100}}};}
const env={EVALUATOR_PG:'postgres://synthetic-evaluator:synthetic@127.0.0.1:5432/synthetic_test',
  OUTBOX_PG:'postgres://synthetic-outbox:synthetic@127.0.0.1:5432/synthetic_test',
  SUPPRESSION_PG:'postgres://synthetic-suppression:synthetic@127.0.0.1:5432/synthetic_test',RT_PATH:'/tmp/synthetic-metadata/alarm.sock'};
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
  it('refuses descriptor mismatch at both actual worker URI and API own admitted endpoint without aliasing credentials',function(){
    const d=config();d.datastore.database='other_test';assert.throws(()=>parse.parse(d,env),/invalid/,'METADATA_WORKER_DESCRIPTOR_BINDING');
    assert.throws(()=>link({evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file},{namespace:'metadata_alarm',connectionString:env.EVALUATOR_PG.replace('synthetic_test','other_test')}),/CONFIG_REFUSED/,'METADATA_API_DESCRIPTOR_BINDING');
    const no=config();delete no.datastore;fs.writeFileSync(file,JSON.stringify(no));
    assert.throws(()=>link({evaluatorConfigEnv:'LINKED_EVALUATOR'},{LINKED_EVALUATOR:file},{namespace:'metadata_alarm',connectionString:env.EVALUATOR_PG}),/CONFIG_REFUSED/);
    assert.doesNotThrow(()=>parse.parse(no,env),'unselected worker descriptor remains optional');
  });
  it('validates metadata shape bounds namespaces and reference names without accepting secret capability fields',function(){
    for(const change of [d=>d.datastore.password='forbidden',d=>d.datastore.port=0,d=>d.postgres.connectionEnv='bad reference',
      d=>d.consumers.realtime.outbox.connectionString='forbidden',d=>d.consumers.realtime.route.socketPath='/tmp/forbidden',
      d=>d.consumers.realtime.outbox.namespace=d.postgres.namespaces.entries,d=>d.consumers.realtime.retryIntervalMs=2147483648,
      d=>d.consumers.realtime.suppression.connectionEnv='bad reference']){const d=config();change(d);assert.throws(()=>parse.parseMetadata(d),/invalid/);}
    const descriptor=config();delete descriptor.datastore;assert.doesNotThrow(()=>parse.parseMetadata(descriptor));
  });
});
