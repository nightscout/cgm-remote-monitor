'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {once} = require('node:events');
const {withPage} = require('./fixture');

describe('Native help tooltip candidate', function () {
  let server, origin;
  before(async function () {
    const source = fs.readFileSync(path.resolve(__dirname, '../../lib/client/help-tooltips.js'), 'utf8');
    const css = fs.readFileSync(path.resolve(__dirname, '../../static/css/help-tooltips.css'), 'utf8');
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><html><head><style>' + css + '</style></head><body>' +
        '<button class="tip" id="toolbar" original-title="Toolbar help" aria-describedby="existing">Tool</button>' +
        '<div id="drawer"><a class="tip" id="help" original-title="Translated help">?</a></div>' +
        '<button id="outside" style="display:block;margin-top:120px">Outside</button><p id="existing">Existing description</p>' +
        '<script>const module={exports:{}};' + source + ';window.install=module.exports;</script></body></html>');
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if(server) await new Promise(resolve=>server.close(resolve));});
  async function fixture(run, touch=false) {
    await withPage(origin, async ({page}) => {
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
      await page.evaluate(touch => {window.controller=window.install(document,{touch});},touch);
      await run(page);
    },{hasTouch:touch});
  }
  it('shows on keyboard focus, preserves description and dismisses on Escape twice', async function () {
    await fixture(async page => {
      for(let cycle=0;cycle<2;cycle++) {
        await page.locator('#outside').focus();
        await page.locator('#toolbar').focus();
        assert.equal(await page.locator('[role=tooltip]').isVisible(),true);
        assert.equal(await page.locator('#toolbar').getAttribute('aria-describedby'),'existing ns-help-tooltip');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[role=tooltip]').isVisible(),false);
        assert.equal(await page.locator('#toolbar').getAttribute('aria-describedby'),'existing');
      }
    });
  });
  it('renders translated titles as text and follows hover onto the tooltip', async function () {
    await fixture(async page => {
      await page.locator('#help').evaluate(el=>el.setAttribute('original-title','Aide <img src=x onerror=alert(1)> & texte'));
      await page.locator('#help').hover();
      assert.equal(await page.locator('[role=tooltip]').textContent(),'Aide <img src=x onerror=alert(1)> & texte');
      assert.equal(await page.locator('[role=tooltip] img').count(),0);
      await page.locator('[role=tooltip]').hover();
      assert.equal(await page.locator('[role=tooltip]').isVisible(),true);
      await page.locator('#outside').hover();
      assert.equal(await page.locator('[role=tooltip]').isVisible(),false);
    });
  });
  it('supports touch drawer taps, repeated dismissal and keeps toolbar activation intact', async function () {
    await fixture(async page => {
      await page.evaluate(()=>{window.clicks=0;document.querySelector('#toolbar').onclick=()=>window.clicks++;});
      for(let cycle=0;cycle<2;cycle++) {
        await page.locator('#help').tap();
        assert.equal(await page.locator('[role=tooltip]').isVisible(),true);
        await page.locator('#outside').tap();
        assert.equal(await page.locator('[role=tooltip]').isVisible(),false);
      }
      await page.locator('#help').tap();
      await page.locator('[role=tooltip]').tap();
      assert.equal(await page.locator('[role=tooltip]').isVisible(),false, JSON.stringify(await page.evaluate(()=>window.tooltipEvents)));
      await page.locator('#toolbar').tap();
      assert.equal(await page.evaluate(()=>window.clicks),1);
      assert.equal(await page.locator('[role=tooltip]').isVisible(),false);
    },true);
  });
  it('dismisses a tooltip click regardless of reported pointer type twice', async function () {
    await fixture(async page => {
      for(let cycle=0;cycle<2;cycle++) {
        await page.locator('#help').tap();
        assert.equal(await page.locator('[role=tooltip]').isVisible(),true);
        await page.locator('[role=tooltip]').click();
        assert.equal(await page.locator('[role=tooltip]').isVisible(),false);
      }
    },true);
  });
  it('keeps keyboard-focused help visible through native scrolling twice', async function () {
    await fixture(async page => {
      await page.locator('#drawer').evaluate(el=>el.style.marginTop='1600px');
      for(let cycle=0;cycle<2;cycle++) {
        await page.locator('#outside').focus();
        await page.locator('#help').focus();
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        assert.equal(await page.locator('[role=tooltip]').isVisible(),true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('[role=tooltip]').isVisible(),false);
      }
    });
  });
  it('avoids repeating a help label as its description and preserves existing descriptions twice', async function () {
    await fixture(async page => {
      const help=page.locator('#help');
      await help.evaluate(el=>el.setAttribute('aria-describedby','existing'));
      for(let cycle=0;cycle<2;cycle++) {
        await page.locator('#outside').focus();
        await help.focus();
        assert.equal(await help.getAttribute('aria-label'),'Translated help');
        assert.equal(await help.getAttribute('aria-describedby'),'existing');
        assert.equal(await page.locator('[role=tooltip]').textContent(),'Translated help');
        await page.keyboard.press('Escape');
        assert.equal(await help.getAttribute('aria-describedby'),'existing');
      }
    });
  });
  it('makes drawer help keyboard-operable with a translated accessible name', async function () {
    await fixture(async page => {
      await page.locator('#help').evaluate(el=>el.setAttribute('original-title','Aide traduite'));
      await page.locator('#help').focus();
      assert.equal(await page.locator('#help').getAttribute('role'),'button');
      assert.equal(await page.locator('#help').getAttribute('tabindex'),'0');
      assert.equal(await page.locator('#help').getAttribute('aria-label'),'Aide traduite');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Space');
      assert.equal(await page.locator('[role=tooltip]').isVisible(),true);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('[role=tooltip]').isVisible(),true);
    });
  });
  it('fits a narrow viewport, flips above a low trigger and dismisses on resize', async function () {
    await fixture(async page => {
      await page.setViewportSize({width:200,height:240});
      await page.locator('#help').evaluate(el=>{
        el.style.cssText='position:fixed;right:0;bottom:0';
        el.setAttribute('original-title','A longer translated explanation that should wrap within this narrow screen.');
      });
      await page.locator('#help').hover();
      const tip=await page.locator('[role=tooltip]').boundingBox();
      const trigger=await page.locator('#help').boundingBox();
      assert(tip.x>=0 && tip.x+tip.width<=200);
      assert(tip.y>=0 && tip.y+tip.height<=trigger.y);
      if(process.env.NIGHTSCOUT_TOOLTIP_SCREENSHOT) await page.screenshot({path:process.env.NIGHTSCOUT_TOOLTIP_SCREENSHOT});
      await page.setViewportSize({width:240,height:240});
      await page.waitForFunction(()=>document.querySelector('[role=tooltip]').hidden);
    });
  });
  it('initializes once, restores descriptions on destroy and can initialize again', async function () {
    await fixture(async page => {
      for(let cycle=0;cycle<2;cycle++) {
        assert.equal(await page.evaluate(()=>window.install(document)===window.controller),true);
        assert.equal(await page.locator('[role=tooltip]').count(),1);
        await page.locator('#toolbar').focus();
        await page.evaluate(()=>window.controller.destroy());
        assert.equal(await page.locator('[role=tooltip]').count(),0);
        assert.equal(await page.locator('#toolbar').getAttribute('aria-describedby'),'existing');
        await page.locator('#outside').focus();
        await page.evaluate(()=>{window.controller=window.install(document);});
      }
    });
  });
});
