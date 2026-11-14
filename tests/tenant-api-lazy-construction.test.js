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
function contextFixture(mutate=s=>s){const counts={apps:0,routers:0,middleware:0};const observed=Object.assign((...args)=>{counts.apps++;return express(...args);},express);observed.Router=(...args)=>{counts.routers++;return express.Router(...args);};const create=load('../lib/server/tenant-app/rest-context',(name,local)=>name==='express'?observed:name==='../../middleware'?env=>{counts.middleware++;return local(name)(env);}:local(name),mutate);const ctx=create({env:environment(),authorization:require('../lib/server/tenant-app/legacy-authorization')(),collections:{},versionInfo:{name:'synthetic',version:'1',storage:{storage:'PostgreSQL',version:'protocol'}},admitted:{1:[],2:[],3:[]}});return {counts,ctx};}
function dispatch(app,url){return new Promise((resolve,reject)=>{const socket=new PassThrough(),req=new http.IncomingMessage(socket);req.method='GET';req.url=url;req.headers={accept:'application/json'};const res=new http.ServerResponse(req);res.end=function(body){this.finished=true;this.emit('finish');resolve({status:this.statusCode,body:body?JSON.parse(String(body)):null});};app(req,res,error=>error?reject(error):resolve({status:404}));});}
const quiet=async fn=>{const a=console.info,b=console.log;console.info=console.log=()=>{};try{return await fn();}finally{console.info=a;console.log=b;}};
describe('tenant API constructs only selected HTTP route trees',function(){
 it('restores all tenant clocks without tenant v3 apps/Collections; unmatched dispatch allocates no handlers',async function(){
  const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
  try { await quiet(async()=>{
   const f=await require('./fixtures/preview-domain-allocation').fixture();
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
   await Promise.all(f.tenants.map(t=>f.graph.initializeTenant(t)));
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0},'WARMUP_MUST_NOT_CONSTRUCT_V3');
   for(const tenant of f.tenants) assert.equal(f.queries.filter(q=>q.tenant===tenant).length,5,'RESTORE_ALL_FIVE_V3_CLOCKS');
   await f.select(f.tenants[0]);await f.select(f.tenants[0]);
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
   await f.select(f.tenants[1]);await f.select(f.tenants[0],'food');
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
  }); } finally {scope.setTenancyMode(previous);}
 });
 it('preserves storage restore failures and per-tenant clock floors before any v3 selection',async function(){
  const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
  try {await quiet(async()=>{
   const floors=new Map(),fault=new Error('synthetic restore refused');let deny=true;
   const f=await require('./fixtures/preview-domain-allocation').fixture({onQuery:(sql,tenant)=>{
    if(sql.includes('current_setting')) return;
    if(deny) throw fault;
    if(!floors.has(tenant)) floors.set(tenant,Date.now()+100000+floors.size*10000);
    return {rows:[{id_kind:'string',doc:{_id:'synthetic-clock',srvModified:floors.get(tenant)}}]};
   }});
   await assert.rejects(f.graph.initializeTenant(f.tenants[0]),error=>error===fault);
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});deny=false;
   for(const tenant of f.tenants){await f.graph.initializeTenant(tenant);
    const stamp=scope.withTenant(tenant,()=>require('../lib/server/srv-dates').next());
    assert.equal(stamp,floors.get(tenant)+1,'RESTORED_TENANT_CLOCK_FLOOR');
   }
   await assert.rejects(f.graph.initializeTenant('unknown'),/Unknown preview tenant/);
   assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0});
  });}finally{scope.setTenancyMode(previous);}
 });
 it('control: materializing Collections during warmup violates the construction criterion',async function(){
  const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
  try {await quiet(async()=>{
   const f=await require('./fixtures/preview-domain-allocation').fixture({mutate:s=>{
    const anchor='    const initialize =';assert(s.includes(anchor));
    return s.replace(anchor,'    Object.values(collections);\n'+anchor);
   }});await f.graph.initializeTenant(f.tenants[0]);
   assert(f.counts.collections>0);
   assert.throws(()=>assert.deepEqual(f.counts,{apps:0,collections:0,mapped:0},'WARMUP_MUST_NOT_CONSTRUCT_V3'));
  });}finally{scope.setTenancyMode(previous);}
 });
 it('control: eager metadata construction fails the unused-view criterion',function(){const f=contextFixture(source=>{const at=source.lastIndexOf('  return {');assert(at>0);return source.slice(0,at)+'  createLegacy(); createV2(); createV3(); createRoot();\n'+source.slice(at);});assert.throws(()=>assert.deepEqual(f.counts,{apps:0,routers:0,middleware:0}));assert(f.counts.apps>0&&f.counts.middleware>0);});

 it('keeps unused metadata versions absent, reuses only the selected tenant-local view',function(){const f=contextFixture();assert.deepEqual(f.counts,{apps:0,routers:0,middleware:0});const a=f.ctx.v2;assert.equal(f.ctx.v2,a);assert.equal(f.counts.apps,0);assert.equal(f.counts.middleware,0);assert.equal(f.counts.routers,1);const other=contextFixture();assert.notEqual(other.ctx.v2,a);assert.equal(other.counts.routers,1);const legacy=f.ctx.legacy;assert.equal(f.ctx.legacy,legacy);assert.equal(f.counts.apps,1);assert.equal(f.counts.middleware,1);});
 it('keeps warm snapshot wrappers without constructing either legacy HTTP version',async function(){await quiet(async()=>{let v1=0,v2=0;const create=load('../lib/server/tenant-app/legacy-domains',(name,local)=>name==='../../api'?(...args)=>{v1++;return local(name)(...args);}:name==='../../api2'?(...args)=>{v2++;return local(name)(...args);}:local(name));const graph=create({env:environment(),ctx:{storagePorts:{resolve:()=>null},bus:new EventEmitter(),ddata:{},cache:{}},domains:['entries']});assert(graph.context.entries);assert.equal(v1,0);assert.equal(v2,0);const first=graph.v1;assert.equal(graph.v1,first);assert.equal(v1,1);assert.equal(v2,0);const second=graph.v2;assert.equal(graph.v2,second);assert.equal(v1,1);assert.equal(v2,1);});});
 it('constructs only the addressed v3 collection, once per tenant, and preserves actual replies',async function(){const previous=scope.getTenancyMode();scope.setTenancyMode('multi');try{await quiet(async()=>{const mapped=[];const create=load('../lib/server/serve/preview-domains',(name,local)=>name==='../../api3/generic/collection'?function(options){mapped.push(options.colName);return new (local(name))(options);}:local(name));const names=['entries','treatments','devicestatus','profile','food','activity'];const graph=await create({config:{domains:names,legacyEnabled:false,contextEnabled:true,bindings:new Map([[A,{}],[B,{}]]),environments:new Map([[A,environment()],[B,environment({settings:{units:'mmol'}})]]),namespaces:Object.fromEntries(names.map(n=>[n,'synthetic_'+n]))},connection:{withTenant:(t,fn)=>scope.withTenant(t,fn),transaction:fn=>fn(),withSavepoint:fn=>fn(),async query(sql){return {rows:sql.includes("current_setting('server_version')")?[{version:'protocol'}]:[]};}},exchange:async()=>null,deferInitialization:true});await graph.initializeTenant(A);await graph.initializeTenant(B);assert.deepEqual(mapped,[],'WARMUP_MUST_NOT_MAP_HTTP_COLLECTIONS');const app=express();let tenant=A;app.use((req,res,next)=>{req.tenantContext={tenant};const permissions=shiro.new();permissions.add('api:*:read');authentication.bind(req,{shiros:[permissions]});next();});app.use('/api/v3',graph.data);for(let i=0;i<2;i++){const result=await dispatch(app,i===0?'/api/v3/EnTrIeS':'/api/v3/entries');assert.equal(result.status,200);assert.deepEqual(result.body.result,[]);}assert.deepEqual(mapped,['entries']);tenant=B;assert.equal((await dispatch(app,'/api/v3/entries')).status,200);assert.deepEqual(mapped,['entries','entries'],'TENANT_COLLECTION_AND_PRUNING_STATE_STAYS_PRIVATE');assert.equal((await dispatch(app,'/api/v3/food')).status,200);assert.deepEqual(mapped,['entries','entries','food']);});}finally{scope.setTenancyMode(previous);}});
});
