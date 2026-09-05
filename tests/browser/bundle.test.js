'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const bundlePath = path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js');

describe('Built application in a real browser', function () {
  let server, origin;
  before(async function () {
    // A missing build is a broken test prerequisite, never an implicit skip.
    const source = fs.readFileSync(bundlePath);
    server = http.createServer((request, response) => {
      if (request.url === '/bundle.js') {
        response.setHeader('Content-Type', 'application/javascript');
        response.end(source);
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head></head><body></body></html>');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  it('executes the actual bundle and preserves every former namespace assertion', async function () {
    await withPage(origin, async ({page}) => {
      await page.goto(origin);
      await page.addScriptTag({url: origin + '/bundle.js'});
      const types = await page.evaluate(() => {
        const ns = window.Nightscout;
        return [typeof ns, typeof ns.client, typeof ns.client.init,
          typeof ns.reportclient, typeof ns.profileclient, typeof ns.units,
          typeof ns.units.mgdlToMMOL, typeof ns.units.mmolToMgdl];
      });
      assert.deepEqual(types, ['object', 'object', 'function', 'function', 'function', 'object', 'function', 'function']);
    });
  });
});
