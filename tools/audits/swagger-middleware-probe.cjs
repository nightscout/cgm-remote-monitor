'use strict';

// Usage: node --expose-gc tools/audits/swagger-middleware-probe.cjs /path/to/checkout
// Fresh-process comparison of the real docs middleware. Only an ephemeral
// loopback server is used; this does not start Nightscout or access MongoDB.
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.argv[2];
const load = createRequire(path.join(root, 'package.json'));
const express = load('express');
const http = require('node:http');
async function settle() {await new Promise(resolve => setImmediate(resolve)); for(let i=0;i<3;i++) global.gc();}
(async () => {
 if (typeof global.gc !== 'function') throw new Error('Run with --expose-gc');
 await settle();
 const before = process.memoryUsage();
 const app = express();
 const ui = load('swagger-ui-express');
 const v1 = load('./lib/server/swagger.json'), v3 = load('./lib/api3/swagger.json');
 if (load('swagger-ui-express/package.json').version.startsWith('5.')) load('./lib/server/api-docs')(app);
 else for (const [route, schema] of [['/api-docs',v1],['/api3-docs',v3]]) app.use(route,ui.serve,(...args)=>ui.setup(schema)(...args));
 const server = await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try {
 for(let cycle=0;cycle<2;cycle++) for(const route of ['/api-docs/','/api3-docs/']) for(const suffix of ['', 'swagger-ui-init.js']) {
  await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:route+suffix,agent:false},res=>{res.resume();res.on('end',resolve);res.on('error',reject)}).on('error',reject)});
 }
 } finally {
  await new Promise(resolve=>server.close(resolve));
 }
 await settle();
 const after=process.memoryUsage();
 console.log(JSON.stringify({node:process.version,wrapper:load('swagger-ui-express/package.json').version,
  ui:load('swagger-ui-dist/package.json').version,heapDelta:after.heapUsed-before.heapUsed,rssDelta:after.rss-before.rss,
  retainedBrowserBundles:Object.keys(require.cache).filter(x=>/swagger-ui-(bundle|standalone-preset)\.js$/.test(x)).map(x=>path.basename(x))}));
})().catch(e=>{console.error(e);process.exitCode=1});
