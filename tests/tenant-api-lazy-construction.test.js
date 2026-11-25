'use strict';
// Actual HTTP handlers with in-memory IncomingMessage/ServerResponse; no listener.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module'),{EventEmitter}=require('node:events');
const http=require('node:http'),{PassThrough}=require('node:stream');
const express=require('express'),shiro=require('shiro-trie');
const environment=require('../lib/server/tenant-app/environment'),scope=require('../lib/storage/tenant-scope');
const authentication=require('../lib/api3/tenant-authentication');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function load(relative,replace,mutate=s=>s){const file=require.resolve(relative),local=createRequire(file),out={exports:{}};vm.runInThisContext('(function(require,module,exports){'+mutate(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>replace(name,local),out,out.exports);return out.exports;}
function dispatch(app,url){return new Promise((resolve,reject)=>{const socket=new PassThrough(),req=new http.IncomingMessage(socket);req.method='GET';req.url=url;req.headers={accept:'application/json'};const res=new http.ServerResponse(req);res.end=function(body){this.finished=true;this.emit('finish');resolve({status:this.statusCode,body:body?JSON.parse(String(body)):null});};app(req,res,error=>error?reject(error):resolve({status:404}));});}
const quiet=async fn=>{const a=console.info,b=console.log;console.info=console.log=()=>{};try{return await fn();}finally{console.info=a;console.log=b;}};
describe('tenant API constructs only selected HTTP route trees',function(){
 it('builds disposable tenant services without clinical reads or v3 Collections; unmatched dispatch allocates no handlers',async function(){
  const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
  try { await quiet(async()=>{
   const f=await require('./fixtures/preview-domain-allocation').fixture();
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
   await Promise.all(f.tenants.map(t=>f.graph.prepareTenant(t)));
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0},'SERVICE_MUST_NOT_CONSTRUCT_UNUSED_V3');
   for(const tenant of f.tenants) assert.equal(f.queries.filter(q=>q.tenant===tenant).length,0,'SERVICE_BUILD_MUST_NOT_READ_CLINICAL_DATA');
   await f.select(f.tenants[0]);await f.select(f.tenants[0]);
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
   await f.select(f.tenants[1]);await f.select(f.tenants[0],'food');
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
  }); } finally {scope.setTenancyMode(previous);}
 });
 it('does not touch unavailable clinical storage while preparing a service and refuses unknown tenants',async function(){
  const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
  try {await quiet(async()=>{
   const fault=new Error('synthetic clinical storage unavailable');
   const f=await require('./fixtures/preview-domain-allocation').fixture({onQuery:sql=>{
    if(sql.includes('current_setting')) return;
    throw fault;
   }});
   for(const tenant of f.tenants) await f.graph.prepareTenant(tenant);
   await assert.rejects(f.graph.prepareTenant('unknown'),/Unknown preview tenant/);
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
  });}finally{scope.setTenancyMode(previous);}
 });
 it('control: materializing unused Collections during service construction violates the demand criterion',async function(){
  const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
  try {await quiet(async()=>{
   const f=await require('./fixtures/preview-domain-allocation').fixture({mutate:s=>{
    const anchor='    return { env, storagePorts';assert(s.includes(anchor));
    return s.replace(anchor,'    Object.values(collections);\n'+anchor);
   }});await f.graph.prepareTenant(f.tenants[0]);
   assert(f.counts.collections>0);
   assert.throws(()=>assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0},'SERVICE_MUST_NOT_CONSTRUCT_UNUSED_V3'));
  });}finally{scope.setTenancyMode(previous);}
 });

 it('keeps snapshot wrappers without constructing either legacy HTTP version',async function(){await quiet(async()=>{let v1=0,v2=0;const create=load('../lib/server/tenant-app/legacy-domains',(name,local)=>name==='../../api'?(...args)=>{v1++;return local(name)(...args);}:name==='../../api2'?(...args)=>{v2++;return local(name)(...args);}:local(name));const graph=create({env:environment(),ctx:{storagePorts:{resolve:()=>null},bus:new EventEmitter(),ddata:{},cache:{}},domains:['entries']});assert(graph.context.entries);assert.equal(v1,0);assert.equal(v2,0);const first=graph.v1;assert.equal(graph.v1,first);assert.equal(v1,1);assert.equal(v2,0);const second=graph.v2;assert.equal(graph.v2,second);assert.equal(v1,1);assert.equal(v2,1);});});
 it('constructs only the addressed v3 collection, once per tenant, and preserves actual replies',async function(){const previous=scope.getTenancyMode();scope.setTenancyMode('multi');try{await quiet(async()=>{const mapped=[];const create=load('../lib/server/serve/preview-domains',(name,local)=>name==='../../api3/generic/collection'?function(options){mapped.push(options.colName);return new (local(name))(options);}:local(name));const names=['entries','treatments','devicestatus','profile','food','activity'];const graph=await create({config:{domains:names,legacyEnabled:false,contextEnabled:true,bindings:new Map([[A,{}],[B,{}]]),environments:new Map([[A,environment()],[B,environment({settings:{units:'mmol'}})]]),namespaces:Object.fromEntries(names.map(n=>[n,'synthetic_'+n]))},connection:{withTenant:(t,fn)=>scope.withTenant(t,fn),transaction:fn=>fn(),withSavepoint:fn=>fn(),async query(sql){return {rows:sql.includes("current_setting('server_version')")?[{version:'protocol'}]:[]};}},exchange:async()=>null,deferInitialization:true});await graph.prepareTenant(A);await graph.prepareTenant(B);assert.deepEqual(mapped,[],'SERVICE_MUST_NOT_MAP_UNUSED_HTTP_COLLECTIONS');const app=express();let tenant=A;app.use((req,res,next)=>{req.tenantContext={tenant};const permissions=shiro.new();permissions.add('api:*:read');authentication.bind(req,{shiros:[permissions]});next();});app.use('/api/v3',graph.data);for(let i=0;i<2;i++){const result=await dispatch(app,i===0?'/api/v3/EnTrIeS':'/api/v3/entries');assert.equal(result.status,200);assert.deepEqual(result.body.result,[]);}assert.deepEqual(mapped,['entries']);tenant=B;assert.equal((await dispatch(app,'/api/v3/entries')).status,200);assert.deepEqual(mapped,['entries','entries'],'TENANT_COLLECTION_AND_PRUNING_STATE_STAYS_PRIVATE');assert.equal((await dispatch(app,'/api/v3/food')).status,200);assert.deepEqual(mapped,['entries','entries','food']);});}finally{scope.setTenancyMode(previous);}});
});
