'use strict';
// covers: lib/client/index.js, lib/client/human-session.js, views/partials/page-scripts.ejs

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const express = require('express');
const {withPage} = require('./fixture');

// The production bundle reads the server-rendered OIDC hint. A page without it
// starts exactly as before OIDC existed: no session probe, status first.
describe('Client OIDC discovery follows the server page hint', function () {
  let server, origin, requests;
  before(async function () {
    const app = express();
    const page = meta => '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="loadingMessageText"></div>' +
      '<div id="centerMessagePanel"></div>' + (meta ? '<meta name="nightscout-human-sessions" content="enabled">' : '') + '</body></html>';
    app.get('/', (request, response) => response.type('html').send(page(false)));
    app.get('/advertised', (request, response) => response.type('html').send(page(true)));
    app.use((request, response, next) => {requests.push(request.path); next();});
    app.get('/api/v2/oidc/session', (request, response) => response.status(404).json({status: 404}));
    app.get('/api/v1/status.json', (request, response) => response.json({runtimeState: 'loaded'}));
    app.use('/bundle', express.static(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public')));
    server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});

  async function start(pathname) {
    requests = [];
    let order;
    await withPage(origin, async ({page}) => {
      await page.goto(origin + pathname);
      await page.addScriptTag({url: origin + '/bundle/js/bundle.app.js'});
      requests = [];
      await page.evaluate(() => new Promise(resolve => {
        const client = window.Nightscout.client;
        client.loadLanguage = (settings, callback) => {if (callback) callback(); resolve();};
        client.init(() => {});
      }));
      order = requests.slice();
    });
    return order;
  }

  it('an unadvertised page requests status without probing the OIDC session', async function () {
    assert.deepEqual(await start('/'), ['/api/v1/status.json']);
  });

  it('an advertised page discovers the OIDC session before requesting status', async function () {
    assert.deepEqual(await start('/advertised'), ['/api/v2/oidc/session', '/api/v1/status.json']);
  });
});
