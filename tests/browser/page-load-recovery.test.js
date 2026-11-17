'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const ejs = require('ejs');
const {withPage} = require('./fixture');

// Exercise the production partial and real bundles. Startup scripts here only
// record execution: full application startup has a separate fixture boundary.
describe('Page download failure recovery', function () {
  let server, origin, missing, requested;
  const entries = ['app', 'reports', 'admin', 'profile', 'food'];
  before(async function () {
    const root = path.resolve(__dirname, '../..');
    const partial = fs.readFileSync(path.join(root, 'views/partials/page-scripts.ejs'), 'utf8');
    const bundles = new Map(entries.map(entry => ['/bundle/js/bundle.' + entry + '.js',
      fs.readFileSync(path.join(root, 'node_modules/.cache/_ns_cache/public/js/bundle.' + entry + '.js'))]));
    server = http.createServer((request, response) => {
      const url = new URL(request.url, origin);
      requested.push(url.pathname);
      if (url.pathname === missing) return response.writeHead(404).end();
      if (bundles.has(url.pathname)) {
        response.setHeader('Content-Type', 'application/javascript');
        return response.end(bundles.get(url.pathname));
      }
      const script = {
        '/socket.io/socket.io.js': 'window.io = {};',
        '/first.js': 'window.startupOrder = [1];',
        '/second.js': 'window.startupOrder.push(2);'
      }[url.pathname];
      if (script) {
        response.setHeader('Content-Type', 'application/javascript');
        return response.end(script);
      }
      const entry = url.pathname.slice(1);
      if (entries.includes(entry)) {
        response.setHeader('Content-Type', 'text/html');
        return response.end('<!doctype html><html><body>' + ejs.render(partial, {
          locals: {bundle: '/bundle', cachebuster: 'recovery'}, pageEntry: entry,
          startupScripts: ['/first.js', '/second.js']
        }) + '</body></html>');
      }
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});
  beforeEach(function () {missing = undefined; requested = [];});

  for (const entry of entries) {
    it('recovers ' + entry + ' from two failed bundle downloads with keyboard reload', async function () {
      await withPage(origin, async ({page}) => {
        for (let cycle = 0; cycle < 2; cycle++) {
          missing = '/bundle/js/bundle.' + entry + '.js'; requested = [];
          await page.goto(origin + '/' + entry);
          const retry = page.getByRole('button', {name: 'Reload page'});
          assert.equal(await page.getByRole('alert').isVisible(), true);
          assert.equal(await retry.evaluate(button => button === document.activeElement), true);
          assert.equal(requested.includes('/first.js'), false);
          assert.equal(await page.evaluate(() => typeof window.startupOrder), 'undefined');
          missing = undefined;
          await Promise.all([page.waitForEvent('load'), retry.press('Enter')]);
          await page.waitForFunction(() => window.startupOrder && window.startupOrder.length === 2);
          assert.deepEqual(await page.evaluate(() => window.startupOrder), [1, 2]);
          assert.equal(await page.getByRole('alert').isVisible(), false);
          assert.equal(new URL(page.url()).pathname, '/' + entry);
        }
      });
    });
  }

  for (const asset of ['/bundle/js/bundle.app.js', '/socket.io/socket.io.js', '/first.js', '/second.js']) {
    it('stops dependent initialization when ' + asset + ' cannot download', async function () {
      missing = asset;
      await withPage(origin, async ({page}) => {
        await page.goto(origin + '/reports');
        await page.getByRole('button', {name: 'Reload page'}).waitFor({state: 'visible'});
        if (asset === '/second.js') {
          assert.deepEqual(await page.evaluate(() => window.startupOrder), [1]);
        } else {
          assert.equal(requested.includes('/second.js'), false);
          assert.equal(await page.evaluate(() => typeof window.startupOrder), 'undefined');
        }
      });
    });
  }
});
