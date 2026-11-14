'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const express = require('express');
const shiro = require('shiro-trie');
const create = require('../lib/server/tenant-app/shared-legacy-routes');
const environment = require('../lib/server/tenant-app/environment');
const authentication = require('../lib/api3/tenant-authentication');
function request (app, tenant, path, body) {
  // Emit the body outside the selected route's AsyncLocalStorage scope.
  const socket = new PassThrough(), req = new http.IncomingMessage(socket);
  req.method = body ? 'POST' : 'GET'; req.url = path;
  req.headers = { accept: 'application/json', 'x-tenant': tenant };
  if (body) { req.headers['content-type'] = 'application/json'; req.headers['content-length'] = Buffer.byteLength(body); }
  const pending = new Promise((resolve, reject) => {
    const res = new http.ServerResponse(req);
    res.end = function (value) { this.finished = true; this.emit('finish'); resolve({status:this.statusCode, body:value && JSON.parse(String(value))}); };
    app(req, res, error => error ? reject(error) : resolve({status:404}));
  });
  if (body) setImmediate(() => { req.push(body); req.push(null); });
  return pending;
}
function fixture (implementation = create, disableB = false) {
  const shared = implementation({ domains: ['entries', 'food', 'activity', 'treatments'] });
  const states = new Map();
  for (const tenant of ['A', 'B']) {
    const calls = [];
    const env = environment({ settings: { enable: disableB && tenant === 'B' ? [] : ['careportal'] } });
    env.settings.obscureDeviceProvenance = tenant;
    const ctx = { cache: {}, ddata: { sgvs: [] }, bus: {emit () {}}, purifier: {purifyObject () {}} };
    ctx.entries = { list (opts, cb) { setImmediate(() => cb(null, [{ _id:tenant, sgv:123, date:1, device:'original' }])); } };
    ctx.food = { list (cb) { setImmediate(() => cb(null, [{ _id:tenant }])); }, create (records, cb) { calls.push(records); setImmediate(() => cb(null, records)); } };
    ctx.activity = {}; ctx.treatments = {}; ctx.sbx = { properties: { marker: tenant } };
    states.set(tenant, {tenant,env,ctx,calls});
  }
  const app = express();
  app.use((req,res,next) => {
    const state = states.get(req.headers['x-tenant']); req.tenantContext = {tenant:state.tenant};
    req.tenantAuthenticate = async () => { await Promise.resolve(); const rights=shiro.new();rights.add('api:*');authentication.bind(req,{shiros:[rights]}); };
    next();
  });
  for (const version of [1,2]) app.use('/api/v'+version, (req,res,next) => shared.dispatch(states.get(req.tenantContext.tenant),req,res,next));
  return {app,states,shared};
}
describe('shared legacy route composition', function () {
  it('keeps captured entries storage, async replies and presentation settings request-local across versions', async function () {
    const {app}=fixture();
    const results=await Promise.all(Array.from({length:16},(_,i)=>request(app,i%2?'B':'A','/api/v'+(i%3?1:2)+'/entries/current')));
    for(let i=0;i<results.length;i++){assert.equal(results[i].status,200);assert.equal(results[i].body[0]._id,i%2?'B':'A');assert.equal(results[i].body[0].device,i%2?'B':'A');}
  });
  it('rebinds parser continuations and keeps writes in the selected wrapper', async function () {
    const {app,states}=fixture();
    const replies=await Promise.all(['A','B'].map(t=>request(app,t,'/api/v1/food',JSON.stringify({name:t,carbs:10}))));
    for(let i=0;i<2;i++){const t=i?'B':'A';assert.equal(replies[i].status,200);assert.equal(states.get(t).calls[0][0].name,t);}
  });
  it('shares derived v2 routes while retaining each request sandbox', async function () {
    const {app}=fixture();
    const replies=await Promise.all(['A','B'].map(t=>request(app,t,'/api/v2/properties')));
    assert.deepEqual(replies.map(r=>r.body),[{marker:'A'},{marker:'B'}]);
  });
  it('keeps careportal-disabled write routes absent', async function () {
    const {app}=fixture(create,true);
    assert.equal((await request(app,'B','/api/v1/treatments',JSON.stringify({eventType:'Note'}))).status,404);
  });
  it('does not construct more Express trees when additional tenants select existing capabilities', async function () {
    const entry = require.cache[require.resolve('express')], original = entry.exports;
    let apps = 0, routers = 0;
    const observed = Object.assign((...args) => { apps++; return original(...args); }, original);
    observed.Router = (...args) => { routers++; return original.Router(...args); };
    entry.exports = observed;
    try {
      const {app} = fixture();
      await request(app,'A','/api/v1/food');
      const first = {apps,routers}; assert(apps > 0 && routers > 0);
      for(let i=0;i<20;i++) await request(app,i%2?'B':'A','/api/v2/food');
      assert.deepEqual({apps,routers},first,'ROUTE_CONSTRUCTION_MUST_NOT_SCALE_WITH_TENANTS');
    } finally { entry.exports = original; }
  });
  it('control: retaining the first request context is detected by tenant response isolation', async function () {
    const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
    const file=require.resolve('../lib/server/tenant-app/shared-legacy-routes'),out={exports:{}};
    const source=fs.readFileSync(file,'utf8').replace('  function selected () {','  let first;\n  function selected () {').replace('    return value;','    return first || (first = value);');
    assert.notEqual(source,fs.readFileSync(file,'utf8'));
    vm.runInThisContext('(function(require,module,exports){'+source+'\n})',{filename:file})(createRequire(file),out,out.exports);
    const {app}=fixture(out.exports);await request(app,'A','/api/v1/food');
    const wrong=await request(app,'B','/api/v1/food');assert.equal(wrong.body[0]._id,'A');
    assert.throws(()=>assert.equal(wrong.body[0]._id,'B','TENANT_RESPONSE_ISOLATION'));
  });
  it('refuses a mismatched request before selecting handlers', function () {
    const {shared,states}=fixture();let error;
    shared.dispatch(states.get('A'),{tenantContext:{tenant:'B'}},{},e=>{error=e;});assert.match(error.message,/binding refused/);
  });
});
