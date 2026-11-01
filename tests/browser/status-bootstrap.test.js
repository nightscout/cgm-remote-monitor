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

// UI-STALE-SECRET-HASH: an API secret hash saved in this browser is sent in
// preference to a ?token= in the page address. When the site no longer accepts
// that hash (its API_SECRET changed, or the hash was saved for another site),
// the page used to stop at the sign-in dialog even though the link's token was
// valid. A refused saved hash is now removed and the page loads again with the
// link's token; without a token the dialog says why it is showing.
describe('a saved API secret the site refuses', function () {
  let server, origin, requests;
  const staleHash = 'stale-fixture-api-secret-hash';
  const goodHash = 'good-fixture-api-secret-hash';
  const token = 'follower-0123456789abcdef';
  const badToken = 'follower-fedcba9876543210';
  before(async function () {
    const bundle = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    server = http.createServer(function (req, res) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/bundle.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(bundle);
      } else if (url.pathname === '/api/v1/status.json') {
        const secret = req.headers['api-secret'];
        requests.push({secret, bearer: req.headers.authorization});
        // The server's order: a secret it accepts wins; a token it accepts
        // signs in; anything else is refused. Anonymous reads are denied.
        const ok = secret === goodHash || secret === token;
        res.statusCode = ok ? 200 : 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(ok ? {runtimeState: 'loaded'} : {status: 401, message: 'Unauthorized'}));
      } else if (url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="loadingMessageText"></div><div id="centerMessagePanel"></div><div id="authentication_placeholder"></div></body></html>');
      } else res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () { if (server) await new Promise(resolve => server.close(resolve)); });

  async function boot ({storedHash, linkToken}) {
    requests = [];
    return withPage(origin, async function ({page}) {
      await page.goto(origin + '/' + (linkToken ? '?token=' + encodeURIComponent(linkToken) : ''));
      await page.addScriptTag({url: origin + '/bundle.js'});
      return page.evaluate(async storedHash => {
        const client = window.Nightscout.client;
        if (storedHash) window.localStorage.setItem('apisecrethash', storedHash);
        const outcome = await new Promise(resolve => {
          client.loadLanguage = function (settings, callback) { callback(); };
          // The production dialog; report once it is open.
          const request = client.hashauth.requestAuthentication;
          client.hashauth.requestAuthentication = function (next) {
            request.call(client.hashauth, next);
            const dialog = document.getElementById('requestauthenticationdialog');
            resolve({prompted: true, dialog: dialog ? dialog.textContent : null});
          };
          client.init(() => resolve({prompted: false}));
        });
        outcome.stored = window.localStorage.getItem('apisecrethash');
        return outcome;
      }, storedHash || null);
    });
  }

  it('loads a valid token link and removes the refused saved hash', async function () {
    const outcome = await boot({storedHash: staleHash, linkToken: token});
    assert.deepEqual(requests, [
      {secret: staleHash, bearer: undefined},
      {secret: token, bearer: 'Bearer ' + token}
    ]);
    assert.equal(outcome.prompted, false);
    assert.equal(outcome.stored, null);
  });

  it('without a token, removes the refused saved hash and says so in the sign-in dialog', async function () {
    const outcome = await boot({storedHash: staleHash});
    assert.deepEqual(requests, [{secret: staleHash, bearer: undefined}, {secret: undefined, bearer: undefined}]);
    assert.equal(outcome.prompted, true);
    assert.equal(outcome.stored, null);
    assert.match(outcome.dialog, /API secret saved in this browser was not accepted/);
  });

  it('still refuses an invalid token after removing the refused saved hash', async function () {
    const outcome = await boot({storedHash: staleHash, linkToken: badToken});
    assert.deepEqual(requests, [
      {secret: staleHash, bearer: undefined},
      {secret: badToken, bearer: 'Bearer ' + badToken}
    ]);
    assert.equal(outcome.prompted, true);
    assert.equal(outcome.stored, null);
  });

  it('keeps a saved hash the site accepts, and sends it in preference to the link token', async function () {
    const outcome = await boot({storedHash: goodHash, linkToken: token});
    assert.deepEqual(requests, [{secret: goodHash, bearer: undefined}]);
    assert.equal(outcome.prompted, false);
    assert.equal(outcome.stored, goodHash);
  });

  it('shows no refused-secret notice when nothing was saved', async function () {
    const outcome = await boot({});
    assert.deepEqual(requests, [{secret: undefined, bearer: undefined}]);
    assert.equal(outcome.prompted, true);
    assert.doesNotMatch(outcome.dialog, /saved in this browser/);
  });
});
