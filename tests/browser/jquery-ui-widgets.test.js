'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

describe('Selected jQuery UI widgets and themes', function () {
  let server, origin;
  before(async function () {
    const app = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/app.js') {res.writeHead(200, {'Content-Type': 'application/javascript'}).end(app); return;}
      const theme = /^\/css\/(ui-darkness|ui-lightness)\/jquery-ui.min.css$/.exec(url.pathname);
      if (theme) {
        res.writeHead(200, {'Content-Type': 'text/css'}).end(fs.readFileSync(path.resolve(__dirname, '../../static/css', theme[1], 'jquery-ui.min.css'))); return;
      }
      const image = /^\/css\/(ui-darkness|ui-lightness)\/images\/([a-zA-Z0-9_.-]+\.png)$/.exec(url.pathname);
      if (image) {
        const file = path.resolve(__dirname, '../../static/css', image[1], 'images', image[2]);
        if (fs.existsSync(file)) {res.writeHead(200, {'Content-Type': 'image/png'}).end(fs.readFileSync(file)); return;}
      }
      if (url.pathname === '/') {
        const selected = url.searchParams.get('theme') === 'ui-lightness' ? 'ui-lightness' : 'ui-darkness';
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end('<!doctype html><html><head><link rel="stylesheet" href="/css/' + selected + '/jquery-ui.min.css"></head><body><button id="opener">Open</button><div id="editor" title="Owned editor">Owned content</div></body></html>'); return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});

  for (const theme of ['ui-darkness', 'ui-lightness']) {
    it(theme + ': keeps padded buttons, focus and dialog drag/resize through two openings', async function () {
      await withPage(origin, async ({page}) => {
        await page.goto(origin + '/?theme=' + theme);
        await page.addScriptTag({url: origin + '/app.js'});
        await page.evaluate(() => {
          document.querySelector('#opener').addEventListener('click', () => window.$('#editor').dialog({width: 360,
            buttons: [{text: 'Enregistrer', click: function () {window.$(this).dialog('close');}}]}));
        });
        for (let cycle = 0; cycle < 2; cycle++) {
          await page.locator('#opener').focus(); await page.locator('#opener').press('Enter');
          const dialog = page.getByRole('dialog');
          await dialog.waitFor({state: 'visible'});
          const button = dialog.getByRole('button', {name: 'Enregistrer', exact: true});
          const sizes = await button.evaluate(node => {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let text;
            while ((text = walker.nextNode()) && !text.textContent.trim()) { /* Find actual label text. */ }
            const range = document.createRange(); range.selectNodeContents(text);
            const label = range.getBoundingClientRect(), rect = node.getBoundingClientRect();
            return {extraWidth: rect.width - label.width, extraHeight: rect.height - label.height};
          });
          assert.ok(sizes.extraWidth >= 20, 'Button horizontal padding: ' + JSON.stringify(sizes));
          assert.ok(sizes.extraHeight >= 8, 'Button vertical padding: ' + JSON.stringify(sizes));
          if (process.env.NIGHTSCOUT_UI_SCREENSHOT_DIR && cycle === 0) {
            await page.screenshot({path: path.join(process.env.NIGHTSCOUT_UI_SCREENSHOT_DIR, theme + '.png')});
          }
          // New UI button markup must retain the legacy theme palette.
          await page.mouse.move(0, 0);
          await page.locator('#opener').focus();
          const palette = await button.evaluate(node => {const css = getComputedStyle(node); return {background: css.backgroundColor, color: css.color};});
          assert.deepEqual(palette, theme === 'ui-darkness'
            ? {background: 'rgb(85, 85, 85)', color: 'rgb(238, 238, 238)'}
            : {background: 'rgb(246, 246, 246)', color: 'rgb(28, 148, 196)'});
          const before = await dialog.boundingBox();
          const title = await dialog.locator('.ui-dialog-titlebar').boundingBox();
          await page.mouse.move(title.x + 30, title.y + 10); await page.mouse.down();
          await page.mouse.move(title.x + 70, title.y + 30, {steps: 10}); await page.mouse.up();
          const moved = await dialog.boundingBox();
          assert.ok(Math.abs(moved.x - before.x - 40) <= 2 && Math.abs(moved.y - before.y - 20) <= 2, 'Dialog follows dragging');
          const resize = await dialog.locator('.ui-resizable-se').boundingBox();
          await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2); await page.mouse.down();
          await page.mouse.move(resize.x + resize.width / 2 + 40, resize.y + resize.height / 2 + 30, {steps: 10}); await page.mouse.up();
          const resized = await dialog.boundingBox();
          assert.ok(resized.width >= moved.width + 35 && resized.height >= moved.height + 25, 'Dialog remains resizable');
          await button.click(); await dialog.waitFor({state: 'hidden'});
          assert.equal(await page.evaluate(() => document.activeElement.id), 'opener');
        }
      });
    });
  }
});
