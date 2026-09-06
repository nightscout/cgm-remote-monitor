'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const ejs = require('ejs');
const {withPage} = require('./fixture');

describe('Help tooltips on the application page', function () {
  let server, origin, units, template;
  before(async function () {
    const root=path.resolve(__dirname,'../..'), file=path.join(root,'views/index.html');
    // Keep the real template/styles; boot manually with finite owned socket data.
    template=ejs.render(fs.readFileSync(file,'utf8'),{type:'index',title:'Tooltip fixture',bundle:'/bundle'},{filename:file});
    const css=fs.readFileSync(path.join(root,'static/css/main.css'),'utf8')
      .replace("@import url('https://fonts.googleapis.com/css?family=Ubuntu:400,700');",'');
    const app=express();
    app.get('/',(req,res)=>res.type('html').send('<!doctype html><title>Owned tooltip fixture</title>'));
    app.get('/css/main.css',(req,res)=>res.type('css').send(css));
    app.get('/api/v1/status.json',(req,res)=>{
      const settings=structuredClone(require('../fixtures/default-server-settings'));
      settings.settings.units=units; settings.settings.language='fr';
      res.json(settings);
    });
    app.get('/api/v1/verifyauth',(req,res)=>res.json({message:'OK'}));
    app.get('/api/v1/adminnotifies',(req,res)=>res.json({message:{notifies:[],notifyCount:0}}));
    app.get('/translations/*',(req,res)=>res.json({'Settings':'Réglages','When enabled an alarm may sound.':'Une alarme peut sonner.'}));
    app.use('/bundle',express.static(path.join(root,'node_modules/.cache/_ns_cache/public')));
    app.use(express.static(path.join(root,'static')));
    server=http.createServer(app);server.listen(0,'127.0.0.1');await once(server,'listening');
    origin='http://127.0.0.1:'+server.address().port;
  });
  after(async function(){if(server)await new Promise(resolve=>server.close(resolve));});
  for(const value of ['mg/dl','mmol']) for(const touch of [false,true]) {
    it('opens and dismisses translated drawer help with '+value+(touch?' touch':' keyboard'),async function(){
      units=value;
      await withPage(origin,async({page})=>{
        await page.clock.setFixedTime(new Date('2024-10-26T04:00:00Z'));
        // Parse the trusted repository template with the browser's HTML parser.
        // Remove boot scripts as DOM nodes, not with an HTML-filtering regexp.
        const html=await page.evaluate(source=>{
          const parsed=new DOMParser().parseFromString(source,'text/html');
          for(const script of parsed.querySelectorAll('script'))script.remove();
          return '<!doctype html>'+parsed.documentElement.outerHTML;
        },template);
        await page.route(origin+'/',route=>route.fulfill({contentType:'text/html',body:html}));
        await page.addInitScript(() => {
          window.tooltipEvents = [];
          for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click', 'focusin', 'focusout']) {
            document.addEventListener(type, event => {
              window.tooltipEvents.push({type, pointerType:event.pointerType, target:event.target.id || event.target.className});
              if (window.tooltipEvents.length > 30) window.tooltipEvents.shift();
            }, true);
          }
        });
        await page.goto(origin);
        await page.addScriptTag({url:origin+'/bundle/js/bundle.app.js'});
        await page.evaluate(()=>{
          window.io={connect(){const socket={on(event,callback){if(event==='connect')queueMicrotask(callback);return socket;},
            emit(event,data,callback){if(callback)callback({read:true});return socket;}};return socket;}};
          return new Promise(resolve=>window.Nightscout.client.init(resolve));
        });
        await page.waitForFunction(()=>window.$.active===0 && window.Nightscout.client.hashauth.isAuthenticated());
        await page.evaluate(()=>window.Nightscout.client.dataUpdate({sgvs:[{mgdl:100,mills:Date.now(),direction:'Flat',type:'sgv'}],treatments:[]}));
        for(let cycle=0;cycle<2;cycle++) {
          if(touch)await page.locator('#drawerToggle').tap();
          else {await page.locator('#drawerToggle').focus();await page.keyboard.press('Enter');}
          await page.locator('#drawer').waitFor({state:'visible'});
          const help=page.locator('#drawer .tip').first();
          if(touch)await help.tap();else await help.focus();
          const tooltip=page.locator('.ns-help-tooltip');
          assert.equal(await tooltip.isVisible(),true);
          assert.equal(await tooltip.textContent(),'Une alarme peut sonner.');
          const tipBox=await tooltip.boundingBox(), helpBox=await help.boundingBox();
          const gap=Math.min(Math.abs(tipBox.y-(helpBox.y+helpBox.height)),Math.abs(helpBox.y-(tipBox.y+tipBox.height)));
          assert(gap<=8, 'Tooltip must stay adjacent to its current trigger: '+gap);
          assert.equal(await help.getAttribute('aria-describedby'),null);
          assert.equal(await help.getAttribute('aria-label'),'Une alarme peut sonner.');
          if(page.context().browser().browserType().name()==='chromium') {
            const cdp=await page.context().newCDPSession(page);
            try {
              const dom=await cdp.send('DOM.getDocument');
              const match=await cdp.send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#drawer .tip'});
              const {nodes}=await cdp.send('Accessibility.getPartialAXTree',{nodeId:match.nodeId,fetchRelatives:false});
              assert.equal(nodes[0].ignored,false);
              assert.equal(nodes[0].role.value,'button');
              assert.equal(nodes[0].name.value,'Une alarme peut sonner.');
              assert.equal(nodes[0].description?.value || '', '', 'Help text must not be exposed twice for the focused control');
            } finally {await cdp.detach();}
          }
          if(process.env.NIGHTSCOUT_TOOLTIP_APP_SCREENSHOT && !touch && cycle===0)
            await page.screenshot({path:process.env.NIGHTSCOUT_TOOLTIP_APP_SCREENSHOT});
          if(touch)await tooltip.tap();else await page.keyboard.press('Escape');
          assert.equal(await tooltip.isVisible(),false, JSON.stringify(await page.evaluate(()=>window.tooltipEvents)));
          await page.evaluate(()=>window.Nightscout.client.browserUtils.closeDrawer('#drawer'));
          await page.locator('#drawer').waitFor({state:'hidden'});
        }
        assert.equal(await page.locator('.ns-help-tooltip').count(),1);
      },{hasTouch:touch});
    });
  }
});
