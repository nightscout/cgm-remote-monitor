'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');

describe('status bootstrap credentials in the production browser bundle', function () {
  let server, origin, requests;
  before(async function () {
    const bundle = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    server = http.createServer(function (req, res) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/bundle.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(bundle);
      } else if (url.pathname === '/api/v1/status.json') {
        requests.push({url: req.url, secret: req.headers['api-secret'], bearer: req.headers.authorization});
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({runtimeState: 'loaded'}));
      } else if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="loadingMessageText"></div></body></html>');
      } else res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () { if (server) await new Promise(resolve => server.close(resolve)); });

  const hash = 'status-fixture-api-secret-hash';
  const token = 'status-fixture-subject-token';
  const jwt = 'eyJmaXh0dXJlIjp0cnVlfQ.eyJzdWIiOiJ0ZXN0In0.fixture';
  const cases = [
    {name: 'anonymous', options: {}, expected: {}},
    {name: 'in-memory API secret', options: {hash}, expected: {secret: hash}},
    {name: 'stored API secret', options: {storedHash: hash}, expected: {secret: hash}},
    {name: 'shared subject token', options: {token}, expected: {secret: token, bearer: 'Bearer ' + token}},
    {name: 'shared JWT', options: {token: jwt}, expected: {secret: jwt, bearer: 'Bearer ' + jwt}},
    {name: 'existing JWT session', options: {jwt, hash}, expected: {bearer: 'Bearer ' + jwt}},
    {name: 'stored secret with a shared link', options: {storedHash: hash, token}, expected: {secret: hash}}
  ];
  for (const {name, options, expected} of cases) {
    it('keeps ' + name + ' credentials out of the status URL', async function () {
      requests = [];
      await withPage(origin, async function ({page}) {
        await page.goto(origin + '/' + (options.token ? '?token=' + encodeURIComponent(options.token) : ''));
        await page.addScriptTag({url: origin + '/bundle.js'});
        await page.evaluate(async options => {
          const client = window.Nightscout.client;
          client.hashauth.apisecrethash = options.hash || null;
          if (options.storedHash) window.localStorage.setItem('apisecrethash', JSON.stringify(options.storedHash));
          if (options.jwt) client.authorized = {token: options.jwt};
          await new Promise(resolve => {
            client.loadLanguage = function (settings, callback) { callback(); };
            client.init(resolve);
          });
        }, options);
      });
      assert.equal(requests.length, 1);
      const sent = requests[0];
      const url = new URL(sent.url, origin);
      assert.deepEqual([...url.searchParams.keys()], ['t']);
      for (const value of [hash, token, jwt]) assert.ok(!sent.url.includes(value));
      assert.equal(sent.secret, expected.secret);
      assert.equal(sent.bearer, expected.bearer);
    });
  }
});
