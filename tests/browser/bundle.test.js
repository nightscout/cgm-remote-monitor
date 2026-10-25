'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

const pageExports = {
  app: {}, reports: {reportclient: 'function', report_plugins_preinit: 'function', predictions: 'object'},
  admin: {admin_plugins: 'function'}, profile: {profileclient: 'function'}, food: {foodclient: 'function'}
};

describe('Built page entries in a real browser', function () {
  let server, origin, requests;
  before(async function () {
    const bundles = new Map(Object.keys(pageExports).map(name => ['/bundle.' + name + '.js',
      fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.' + name + '.js'))]));
    server = http.createServer((request, response) => {
      if (bundles.has(request.url)) {
        requests.push(request.url);
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(bundles.get(request.url));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});

  for (const [entry, exports] of Object.entries(pageExports)) {
    it('loads only the shared client and ' + entry + ' exports', async function () {
      requests = [];
      await withPage(origin, async ({page}) => {
        await page.goto(origin);
        await page.addScriptTag({url: origin + '/bundle.app.js'});
        if (entry !== 'app') await page.addScriptTag({url: origin + '/bundle.' + entry + '.js'});
        const result = await page.evaluate(() => {
          const ns = window.Nightscout;
          return {types: Object.fromEntries(Object.entries(ns).map(([name, value]) => [name, typeof value])),
            shared: [typeof ns.client.init, typeof ns.units.mgdlToMMOL, typeof ns.units.mmolToMgdl],
            flot: typeof window.$.plot};
        });
        assert.deepEqual(result.types, {client: 'object', units: 'object', ...exports});
        assert.deepEqual(result.shared, ['function', 'function', 'function']);
        assert.equal(result.flot, entry === 'reports' ? 'function' : 'undefined');
        assert.deepEqual(requests, entry === 'app' ? ['/bundle.app.js'] : ['/bundle.app.js', '/bundle.' + entry + '.js']);
      });
    });
  }
});
