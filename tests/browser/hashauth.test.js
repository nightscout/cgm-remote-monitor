'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {withPage} = require('./fixture');
const secret = 'this is my long pass phrase';
const expectedHash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

describe('hashauth in a real browser', function () {
  let server, origin, authorized, requests;
  before(async function () {
    const source = fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/_ns_cache/public/js/bundle.app.js'));
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/bundle.js') {
        response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        response.end(source);
      } else if (url.pathname === '/api/v1/verifyauth') {
        requests.push({method: request.method, query: url.searchParams.get('t'), hash: request.headers['api-secret'] || null});
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({message: authorized ? 'OK' : {message: 'DENIED'}}));
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body><div id="authentication_placeholder"></div><div class="needsadminaccess"></div></body></html>');
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {
    if (server) await new Promise(resolve => server.close(resolve));
  });

  async function loadAuth(page, fallback = false) {
    assert.equal(await page.evaluate(() => document.characterSet), 'UTF-8');
    await page.addScriptTag({url: origin + '/bundle.js'});
    await page.evaluate(fallback => {
      const auth = window.Nightscout.client.hashauth;
      window.authFixture = {reloads: 0, digestCalls: 0};
      const client = {
        headers: () => ({'api-secret': auth.hash() || ''}),
        translate: text => text,
        browserUtils: {reload: () => { window.authFixture.reloads++; }}
      };
      auth.init(client, window.$);
      window.authFixture.client = client;
      if (fallback) {
        Object.defineProperty(window.crypto, 'subtle', {configurable: true, value: undefined});
        window.TextEncoder = undefined;
      } else {
        if (!window.crypto.subtle || !window.TextEncoder) throw new Error('Native crypto fixture unavailable');
        const digest = window.crypto.subtle.digest.bind(window.crypto.subtle);
        window.crypto.subtle.digest = function (...args) {
          window.authFixture.digestCalls++;
          return digest(...args);
        };
      }
    }, fallback);
  }

  async function withAuth(run, {allow = true, fallback = false} = {}) {
    authorized = allow;
    requests = [];
    return withPage(origin, async ({page}) => {
      await page.goto(origin);
      await loadAuth(page, fallback);
      const result = await run(page);
      for (const request of requests) {
        assert.equal(request.method, 'GET');
        assert.match(request.query, /^\d+$/);
      }
      return result;
    });
  }

  async function processSecret(page, store) {
    return page.evaluate(({secret, store}) => new Promise(resolve => {
      const auth = window.Nightscout.client.hashauth;
      auth.processSecret(secret, store, success => resolve({
        success, hash: auth.hash(), stored: localStorage.getItem('apisecrethash'),
        authenticated: auth.isAuthenticated(), digestCalls: window.authFixture.digestCalls
      }));
    }), {secret, store});
  }

  async function remove(page) {
    return page.evaluate(() => {
      const auth = window.Nightscout.client.hashauth;
      auth.removeAuthentication();
      return {hash: auth.hash(), stored: localStorage.getItem('apisecrethash'), authenticated: auth.isAuthenticated(), reloads: window.authFixture.reloads};
    });
  }

  it('reports Unauthorized in inlineCode when not authenticated', async function () {
    await withAuth(async page => {
      const result = await page.evaluate(() => new Promise(resolve => {
        const auth = window.Nightscout.client.hashauth;
        auth.initAuthentication(() => resolve({html: auth.inlineCode(), authenticated: auth.isAuthenticated(), hash: auth.hash()}));
      }));
      assert.match(result.html, /Unauthorized/);
      assert.equal(result.authenticated, false);
      assert.equal(result.hash, null);
      assert.equal(requests.length, 1);
    }, {allow: false});
  });

  it('reports Admin authorized when authenticated', async function () {
    await withAuth(async page => {
      const result = await page.evaluate(() => new Promise(resolve => {
        const auth = window.Nightscout.client.hashauth;
        auth.initAuthentication(() => resolve({html: auth.inlineCode(), authenticated: auth.isAuthenticated()}));
      }));
      assert.match(result.html, /Admin authorized/);
      assert.equal(result.authenticated, true);
      assert.equal(requests.length, 1);
    });
  });

  it('renders authorization subject names as inert text', async function () {
    await withAuth(async page => {
      const payload = '<img src=x onerror="window.__subjectXss = true">';
      for (const subject of [payload, '&lt;img src=x onerror="window.__subjectXss = true"&gt;']) {
        const result = await page.evaluate(subject => {
          const auth = window.Nightscout.client.hashauth;
          const client = window.authFixture.client;
          client.authorized = {sub: subject};
          auth.init(client, window.$);
          const container = document.getElementById('authentication_placeholder');
          container.innerHTML = auth.inlineCode();
          return {images: container.querySelectorAll('#authorizationstatus img').length, text: container.querySelector('#authorizationstatus').textContent, injected: window.__subjectXss};
        }, subject);
        assert.equal(result.images, 0);
        assert.ok(result.text.includes(payload), JSON.stringify(result));
        assert.equal(result.injected, undefined);
      }
      assert.equal(requests.length, 0);
    });
  });

  it('stores sha1 in localStorage when storeapisecret=true, then clears on remove', async function () {
    await withAuth(async page => {
      const result = await processSecret(page, true);
      assert.deepEqual(result, {success: true, hash: expectedHash, stored: expectedHash, authenticated: true, digestCalls: 1});
      assert.deepEqual(await remove(page), {hash: null, stored: null, authenticated: false, reloads: 1});
      assert.deepEqual(requests.map(request => request.hash), [expectedHash]);
    });
  });

  it('stores and removes authentication across two complete cycles', async function () {
    await withAuth(async page => {
      for (let cycle = 1; cycle <= 2; cycle++) {
        assert.deepEqual(await processSecret(page, true), {success: true, hash: expectedHash, stored: expectedHash, authenticated: true, digestCalls: cycle});
        assert.deepEqual(await remove(page), {hash: null, stored: null, authenticated: false, reloads: cycle});
      }
      assert.deepEqual(requests.map(request => request.hash), [expectedHash, expectedHash]);
    });
  });

  it('restores saved authentication after two page reloads', async function () {
    await withAuth(async page => {
      assert.equal((await processSecret(page, true)).stored, expectedHash);
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.reload();
        await loadAuth(page);
        const result = await page.evaluate(() => new Promise(resolve => {
          const auth = window.Nightscout.client.hashauth;
          auth.initAuthentication(() => resolve({
            hash: auth.hash(), stored: localStorage.getItem('apisecrethash'),
            authenticated: auth.isAuthenticated(), digestCalls: window.authFixture.digestCalls
          }));
        }));
        assert.deepEqual(result, {hash: expectedHash, stored: expectedHash, authenticated: true, digestCalls: 0});
      }
      assert.deepEqual(requests.map(request => request.hash), [expectedHash, expectedHash, expectedHash]);
      assert.deepEqual(await remove(page), {hash: null, stored: null, authenticated: false, reloads: 1});
    });
  });

  it('does not store sha1 when storeapisecret=false', async function () {
    await withAuth(async page => {
      assert.deepEqual(await processSecret(page, false), {success: true, hash: expectedHash, stored: null, authenticated: true, digestCalls: 1});
      assert.deepEqual(requests.map(request => request.hash), [expectedHash]);
    });
  });

  it('alerts on short API secret', async function () {
    await withAuth(async page => {
      const dialogs = [];
      page.on('dialog', async dialog => {
        dialogs.push({type: dialog.type(), message: dialog.message()});
        await dialog.dismiss();
      });
      const success = await page.evaluate(() => new Promise(resolve => window.Nightscout.client.hashauth.processSecret('short passp', false, resolve)));
      assert.equal(success, false);
      assert.deepEqual(dialogs, [{type: 'alert', message: 'Too short API secret'}]);
      assert.equal(requests.length, 0);
    });
  });

  it('hashes via JS fallback when subtle crypto and TextEncoder are absent', async function () {
    await withAuth(async page => {
      assert.deepEqual(await page.evaluate(() => [typeof window.crypto.subtle, typeof window.TextEncoder]), ['undefined', 'undefined']);
      assert.deepEqual(await processSecret(page, false), {success: true, hash: expectedHash, stored: null, authenticated: true, digestCalls: 0});
      assert.deepEqual(requests.map(request => request.hash), [expectedHash]);
    }, {fallback: true});
  });
});
