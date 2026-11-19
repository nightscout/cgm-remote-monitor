'use strict';
// Actual domain factories and handlers; SQL and HTTP stream ports are synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const http=require('node:http'),{PassThrough}=require('node:stream'),express=require('express'),shiro=require('shiro-trie');
const scope=require('../lib/storage/tenant-scope'),environment=require('../lib/server/tenant-app/environment');
const authentication=require('../lib/api3/tenant-authentication'),postgres=require('../lib/server/serve/postgres-domains');
const domains=['entries','treatments','devicestatus','profile','food','activity'];
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function load(calls,transform=text=>text){
 const file=require.resolve('../lib/server/serve/preview-domains'),out={exports:{}},local=createRequire(file);
 const requireFor=name=>name==='./postgres-domains'?{...postgres,get:logical=>{const selected=postgres.get(logical);return {...selected,factory:options=>{calls.push([logical,options.source]);return selected.factory(options);}};}}:local(name);
 vm.runInThisContext('(function(require,module,exports){'+transform(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(requireFor,out,out.exports);return out.exports;
}
function request(app,tenant,url){
 const req=new http.IncomingMessage(new PassThrough()),res=new http.ServerResponse(req);req.method='GET';req.url=url;req.headers={accept:'application/json','x-tenant':tenant};
 return new Promise((resolve,reject)=>{res.end=function(value){this.finished=true;this.emit('finish');resolve({status:this.statusCode,body:value&&JSON.parse(String(value))});};app(req,res,error=>error?reject(error):resolve({status:404}));});
}
async function criterion(transform){
 const calls=[],factory=load(calls,transform);
 const config={platformVerification:{namespace:'synthetic_verification',role:'api'},domains,bindings:new Map([[A,{}],[B,{}]]),environments:new Map([[A,environment({})],[B,environment({})]]),namespaces:Object.fromEntries(domains.map(n=>[n,'synthetic_'+n])),legacyEnabled:true,contextEnabled:true};
 const connection={withTenant:(tenant,fn)=>scope.withTenant(tenant,fn),transaction:fn=>fn(),withSavepoint:fn=>fn(),async query(sql){await Promise.resolve();if(sql.includes("current_setting('server_version')"))return{rows:[{version:'protocol'}]};if(sql.startsWith('SELECT'))return{rows:[]};throw Error('UNEXPECTED_PROTOCOL_SQL');}};
 const graph=await factory({config,connection,exchange:async()=>null,deferInitialization:true});
 await graph.prepareTenant(A);await graph.prepareTenant(B);
 assert.equal(calls.filter(([,source])=>source==='v1/internal').length,0,'UNUSED_LEGACY_PORTS_MUST_NOT_BE_RETAINED');
 assert.equal(calls.filter(([,source])=>source==='v3').length,0,'UNUSED_V3_PORTS_MUST_NOT_BE_BUILT');
 const app=express();app.use((req,res,next)=>{req.tenantContext={tenant:req.headers['x-tenant']};const rights=shiro.new();rights.add('*');authentication.bind(req,{shiros:[rights]});req.tenantAuthenticate=async()=>authentication.bind(req,{shiros:[rights]});next();});
 app.use('/api/v3',graph.data);app.use(['/api/v1','/api/v2'],graph.legacyRouter);
 const before=calls.length;
 for(const tenant of [A,B,A,B])assert.equal((await request(app,tenant,'/api/v3/entries')).status,200);
 assert.equal(calls.length,before+2,'ADDRESSED_V3_PORTS_MUST_BE_TENANT_LOCAL_AND_REUSED');
 for(const tenant of [A,B,A,B])assert.equal((await scope.withTenant(tenant,()=>request(app,tenant,'/api/v1/food'))).status,200);
 assert.equal(calls.filter(([logical,source])=>logical==='food'&&source==='v1/internal').length,2,'ADDRESSED_LEGACY_PORTS_MUST_BE_TENANT_LOCAL_AND_REUSED');
 assert.equal(calls.filter(([,source])=>source==='v1/internal').length,2,'OTHER_LEGACY_DOMAINS_MUST_STAY_COLD');
}
describe('selected demand-created domain ports',function(){
 let prior;beforeEach(()=>{prior=scope.getTenancyMode();scope.setTenancyMode('multi');});afterEach(()=>scope.setTenancyMode(prior));
 it('builds only actual requested source/domain ports without tenant warmup',()=>criterion());
 it('control: eager construction retains unused ports; selected source keeps the demand graph',async()=>{
  const transform=text=>{const needle='    const storagePorts =';assert(text.includes(needle));return text.replace(needle,'    for (const [key, factory] of factories) ports.set(key, factory());\n'+needle);};
  await assert.rejects(criterion(transform),/UNUSED_LEGACY_PORTS_MUST_NOT_BE_RETAINED/);await criterion();
 });
});
