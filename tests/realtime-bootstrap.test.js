'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const fixture=require('./fixtures/realtime-preview/bootstrap');
const plan=fixture.plan;
const sourceDir=path.resolve(__dirname,'..');
function bounds(){return {timeoutMs:1000,recoveryIntervalMs:100,timeIntervalMs:100,pollIntervalMs:100,retryIntervalMs:100,retryDelayMs:10,
  attemptTimeoutMs:2000,maxRows:100,maxBytes:100000,pageSize:10,maxMessageBytes:30000,maxPayloadBytes:10000,maxConnections:2,maxInflight:2,maxSockets:10,
  snoozeMs:1000,settleMs:100,observationMs:100,credentialLifetimeSeconds:3600};}
describe('parent-owned realtime bootstrap source contract',function(){
  let dir,input;
  beforeEach(function(){dir=fs.mkdtempSync(path.join(os.tmpdir(),'rt-b-'));fs.chmodSync(dir,0o700);
    const pins=require('./fixtures/realtime-preview/early').plan.pins;
    const resource=(kind,port,database)=>({kind,host:'127.0.0.1',port,database,containerId:'synthetic-owned-'+kind,image:kind+'@'+pins[kind],labelKey:'synthetic-owner',labelValue:'synthetic-phase',mounts:[]});
    input={sourceDir,captureDir:dir,onObservation(){},env:{NS_TEST_POSTGRES_ADMIN_URI:'postgres://synthetic-admin:synthetic@127.0.0.1:15432/bootstrap_test',
      CUSTOMCONNSTR_mongo:'mongodb://127.0.0.1:27017/synthetic',NS_RT_BOOTSTRAP_VAULT_ADDRESS:'http://127.0.0.1:18200',NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN:'synthetic-vault-root',
      NS_RT_BOOTSTRAP_OPTIONS_JSON:JSON.stringify(bounds()),NS_RT_BOOTSTRAP_UI_JSON:JSON.stringify({bundleDirectory:'/tmp/synthetic-bundle',expectedBundleSha256:'0'.repeat(64),settings:{units:'mg/dl'}})},
      resources:[resource('postgres',15432,'bootstrap_test'),resource('mongo',27017),resource('vault',18200),{kind:'private-directory',path:dir,mode:0o700,ownerUid:process.getuid()}]};});
  afterEach(function(){fs.rmSync(dir,{recursive:true,force:true});});
  it('refuses execution without explicit grant before loading or opening any service capability',async function(){
    await assert.rejects(fixture(input),/EXPLICIT_PARENT_BOOTSTRAP_REQUIRED/);
    assert.equal(plan.parse(input).options.maxRows,100);
  });
  it('refuses resource endpoint image ownership bounds and directory mismatches instead of discovering replacement services',function(){
    for(const mutate of [x=>x.resources[0].port++,x=>x.resources[0].image='postgres:latest',x=>x.resources[0].database='other_test',
      x=>x.resources.push({...x.resources[0]}),x=>x.resources[1].host='192.0.2.1',x=>delete x.env.NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN,
      x=>x.resources[3].ownerUid++,x=>x.env.NS_RT_BOOTSTRAP_OPTIONS_JSON='{}',x=>x.env.NS_RT_BOOTSTRAP_UI_JSON='{}']) {
      const changed={...input,env:{...input.env},resources:structuredClone(input.resources)};mutate(changed);assert.throws(()=>plan.parse(changed),/INPUT_REFUSED/);
    }
    assert.throws(()=>require('../lib/tenant-resolution')({aliases:[{host:'127.0.0.1',tenant:plan.A}]}),error=>error.code==='TENANT_HOST_INVALID','BOOTSTRAP_NUMERIC_HOST_REFUSED');
    fs.chmodSync(dir,0o755);assert.throws(()=>plan.parse(input),/INPUT_REFUSED/);
  });
  it('feeds actual API RT and evaluator parsers with one metadata-linked config and no worker credentials in API',function(){
    const selected=plan.parse(input),layout=plan.layout('0123456789abcdef'),paths=Object.fromEntries(['api','realtime','evaluator','admission'].map(n=>[n,path.join(dir,n+'.json')]));
    const publicKeys=[plan.A,plan.B].map(tenant=>({tenant,kid:'key1',publicKey:Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url').toString('base64')}));
    const docs=plan.documents({selected,layout,publicKeys,paths});for(const name of ['api','realtime','evaluator','admission'])fs.writeFileSync(paths[name],JSON.stringify(docs[name]));
    const url=name=>'postgres://synthetic-'+name+':synthetic@127.0.0.1:15432/bootstrap_test';
    const common={RT_BOOTSTRAP_API_SOCKET:path.join(dir,'api.sock'),RT_BOOTSTRAP_ALARM_SOCKET:path.join(dir,'alarm.sock'),RT_BOOTSTRAP_ADMISSION:paths.admission};
    const api={...common,MULTITENANT_PREVIEW_CONFIG:paths.api,MULTITENANT_EVALUATOR_CONFIG:paths.evaluator,RT_BOOTSTRAP_API_PG:url('api'),
      RT_BOOTSTRAP_READINESS_PG:url('readiness'),RT_BOOTSTRAP_ALARM_PG:url('alarm'),RT_BOOTSTRAP_VAULT_0:'synthetic-a',RT_BOOTSTRAP_VAULT_1:'synthetic-b'};
    const worker={...common,MULTITENANT_EVALUATOR_CONFIG:paths.evaluator,RT_BOOTSTRAP_EVAL_PG:url('evaluator'),RT_BOOTSTRAP_OUTBOX_PG:url('outbox'),RT_BOOTSTRAP_SUPPRESSION_PG:url('suppression')};
    const realtime={...common,MULTITENANT_REALTIME_CONFIG:paths.realtime,RT_BOOTSTRAP_RT_PG:url('realtime')};
    const accepted=require('../lib/server/serve/preview-config').load(api);
    const evaluated=require('../lib/server/serve/evaluator-config').load(worker);
    const delivered=require('../lib/server/realtime/config').load(realtime);
    assert.equal(accepted.socketForwarding.consumerState.consumer,evaluated.consumers.realtime.route.id,'BOOTSTRAP_SAME_CONSUMER_LOCK_BINDING');
    assert.equal(delivered.tenants.get(plan.A).identity,evaluated.tenants.get(plan.A).identity,'BOOTSTRAP_SHARED_EFFECTIVE_IDENTITY');
    assert.equal(delivered.tenants.get(plan.A).identity,delivered.tenants.get(plan.B).identity,'equal config prevents isolation test being masked by identity mismatch');
    assert.notEqual(evaluated.namespaces.checkpoint,delivered.namespaces.checkpoint);
    assert.equal(Object.keys(api).some(key=>/EVAL_PG|OUTBOX_PG|SUPPRESSION_PG/.test(key)),false,'BOOTSTRAP_API_NO_WORKER_CREDENTIALS');
    assert.equal(Object.keys(realtime).some(key=>/VAULT|SIGN|DECRYPT|SECRET/.test(key)),false);
    assert.deepEqual(Object.keys(require('./fixtures/realtime-preview/bootstrap-grants').catalogues()).sort(),Object.keys(layout.namespaces).sort());
  });
});
