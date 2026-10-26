'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const createApp = require('../../lib/server/app');
const {getBrowser} = require('./hooks');

function listen(app) {
  return new Promise(resolve => {const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
}
function close(server) {return server ? new Promise(resolve=>server.close(resolve)) : Promise.resolve();}

describe('Actual server security headers in browser frames', function () {
  for (const mode of ['off','enforced','report-only']) {
    it('preserves cross-origin embedding and inline controls with CSP '+mode+' twice', async function () {
      const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nightscout-helmet-'));
      let child,parent,context;
      try {
        await fs.writeFile(path.join(dir,'probe.html'),'<button id="control" onclick="this.textContent=Number(this.textContent)+1">0</button>');
        const env={name:'owned-helmet',version:'fixture',trustProxy:'127.0.0.1,::1',insecureUseHttp:false,
          secureHstsHeader:true,secureHstsHeaderIncludeSubdomains:false,secureHstsHeaderPreload:false,
          secureCsp:mode!=='off',secureCspReportOnly:mode==='report-only',allowUnrestrictedFrameEmbedding:true,
          static_files:dir,settings:require('../../lib/settings')()};
        child=await listen(createApp(env,{bootErrors:[{desc:'fixture',err:'fixture'}]}));
        const childOrigin='http://127.0.0.1:'+child.address().port;
        const parentApp=express();
        parentApp.get('/',(req,res)=>res.send('<iframe src="'+childOrigin+'/probe.html"></iframe>'));
        parent=await listen(parentApp);
        const parentOrigin='http://127.0.0.1:'+parent.address().port;
        context=await getBrowser().newContext({extraHTTPHeaders:{'x-forwarded-proto':'https'}});
        const blocked=[];
        await context.route('**/*',route=>{
          if (![parentOrigin,childOrigin].includes(new URL(route.request().url()).origin)) {
            blocked.push(route.request().url());return route.abort();
          }
          return route.continue();
        });
        const page=await context.newPage();
        for(let cycle=0;cycle<2;cycle++) {
          await page.goto(parentOrigin);
          const control=page.frameLocator('iframe').locator('#control');
          await control.click();await control.click();
          assert.equal(await control.textContent(),'2');
        }
        assert.deepEqual(blocked,[]);
      } finally {
        if(context)await context.close();
        await close(parent);await close(child);
        await fs.rm(dir,{recursive:true,force:true});
      }
    });
  }
});
