'use strict';
// covers: lib/tenant-registry/ensure-rest.js, lib/tenant-registry/ensure-shape.js, lib/cli/commands/admin.js, lib/server/serve/admin-config.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const admin = require('../lib/cli/commands/admin');
const { createEnsureApi } = require('../lib/tenant-registry/ensure-rest');
const { parse } = require('../lib/server/serve/admin-config');
const fixture = require('./fixtures/tenant-ensure-recording');
const f = fixture();
const result = { id:f.A,operationId:f.OP,outcome:'complete',code:'TENANT_ENSURE_OK',changed:[] };

describe('private ensure REST, closed published shape and actual CLI', function () {
  let server, url, calls, response, logs;
  before(async function () {
    const api = createEnsureApi({service:{ensure:async()=>{calls++;return response;}},log:r=>logs.push(r)});
    server = http.createServer(api); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    url = 'http://127.0.0.1:'+server.address().port;
  });
  after(async function () { if (server) await new Promise(resolve=>server.close(resolve)); });
  beforeEach(function () { calls=0; response={...result}; logs=[]; });
  async function post (body=f.input,method='POST',route='/v1/tenants/'+f.A+'/ensure') {
    const r = await fetch(url+route,{method,headers:{'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
  }
  it('uses one closed published request and response; refuses extra proof/credential fields', async function () {
    assert.deepEqual((await post()).body,result);assert.equal(calls,1);assert.equal(logs[0].operation,'ensure');
    assert.equal((await post({...f.input,proof:true})).status,422);
    assert.equal((await post({...f.input,id:'33333333-3333-4333-8333-333333333333'})).status,422);
    assert.equal((await post(f.input,'GET')).status,405);assert.equal(calls,1);
  });
  it('does not expose provider errors or unknown nested/root response fields', async function () {
    response={...result,provider:'SYNTHETIC_PRIVATE_SENTINEL'};
    const r=await post();assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.body),/SYNTHETIC_PRIVATE/);assert.equal(r.cache,'no-store');
  });
  it('runs the actual CLI child against this private listener without local database/Vault credentials', async function () {
    const child=spawn(process.execPath,[path.resolve(__dirname,'../bin/nightscout.js'),'admin','ensure','--id',f.A,'--operation-id',f.OP,'--host','one.example.test','--url',url,'--json'],
      {env:{PATH:path.dirname(process.execPath),HOME:process.env.HOME,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
    const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    assert.equal(exit,0,stderr);assert.deepEqual(JSON.parse(stdout),result);
  });
  it('CLI refuses raw malformed peer output and keeps failed/unknown outcomes nonzero', async function () {
    let text='',errors='';const io={env:process.env,stdout:{write:s=>{text+=s;}},stderr:{write:s=>{errors+=s;}}};
    response={...result,outcome:'unknown',code:'TENANT_ENSURE_COMMIT_UNKNOWN'};
    const args=['ensure','--id',f.A,'--operation-id',f.OP,'--host','one.example.test','--url',url,'--json'];
    assert.equal(await admin.run(args,io),69);assert.equal(JSON.parse(text).outcome,'unknown');text='';
    response={...result,changed:['SYNTHETIC_PRIVATE_SENTINEL']};
    assert.equal(await admin.run(args,io),69);assert.equal(text,'');assert.doesNotMatch(errors,/SYNTHETIC_PRIVATE_SENTINEL/);
  });
  it('parses explicit separate ensure identity and refuses namespace drift', function () {
    const section={connectionEnv:'ENSURE_PG',ledgerNamespace:'ensure_ledger',namespaces:f.ns,checkpoints:[],operator:{principal:'operator',consumer:'ensure'},vault:{address:'http://127.0.0.1/',mount:'transit',tokenEnv:'ENSURE_VAULT',allowInsecureLoopback:true}};
    const source={ENSURE_PG:'postgres://synthetic:synthetic@localhost/synthetic',ENSURE_VAULT:'synthetic'};
    assert.equal(parse({version:1,maxBytes:65536,timeoutMs:10000,ensure:section},source).ensure.ledgerNamespace,'ensure_ledger');
    const plan=require('./fixtures/multitenant-plan'),layout=plan.layout('ensure_combo');
    const set=plan.documentSet(plan.documents({layout,urls:plan.syntheticUrls(layout),variant:'full'}));
    const entry=set.processes.find(p=>p.roles.includes('admin')),full=entry.files[entry.environment.MULTITENANT_ADMIN_CONFIG];
    for (const other of ['ownership','pools','connectorSources','managementSessions']) {
      const config={version:1,maxBytes:65536,timeoutMs:10000,[other]:full[other]},environment={...entry.environment,...source};
      assert(parse(config,environment)[other],'comparison service must be independently valid');
      assert.throws(()=>parse({...config,ensure:section},environment));
    }
    assert.throws(()=>parse({version:1,maxBytes:65536,timeoutMs:10000,ensure:{...section,ledgerNamespace:f.ns.registry}},source));
  });
});
