'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {getBrowser} = require('./hooks');

const workerSource = fs.readFileSync(path.resolve(__dirname, '../../views/service-worker.js'), 'utf8');
const staticPaths = new Set(Array.from(workerSource.matchAll(/'(\/[^']+)'/g), match => match[1]));
const bundles = new Map(['app', 'clock', 'reports', 'admin', 'profile', 'food'].map(name => {
  const pathname = '/bundle/js/bundle.' + name + '.js';
  return [pathname, 'window.fixtureAsset = {path:' + JSON.stringify(pathname) + ',version:__FIXTURE_VERSION__};'];
}));

describe('Service worker in a real browser', function () {
  this.timeout(45000);
  let server, origin, version, requests, networkDown;
  before(async function () {
    server = http.createServer((request, response) => {
      if (networkDown) {request.socket.destroy(); return;}
      const url = new URL(request.url, 'http://127.0.0.1');
      requests.push(url.pathname + url.search);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self'");
      if (url.pathname === '/harness') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><head><meta charset="utf-8"></head><body>Service worker fixture</body></html>');
      } else if (url.pathname === '/sw.js') {
        response.setHeader('Content-Type', 'application/javascript');
        response.setHeader('Service-Worker-Allowed', '/');
        response.end(workerSource.replace('<%= locals.cachebuster %>', version));
      } else if (bundles.has(url.pathname)) {
        response.setHeader('Content-Type', 'application/javascript');
        response.end(bundles.get(url.pathname).replace('__FIXTURE_VERSION__', JSON.stringify(version)));
      } else if (staticPaths.has(url.pathname)) {
        response.setHeader('Content-Type', 'text/plain'); response.end('fixture asset');
      } else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async function () {if (server) await new Promise(resolve => server.close(resolve));});

  async function withWorker(run) {
    version = 'v1'; requests = []; networkDown = false;
    // This dedicated fixture permits actual workers. Its worker source and all
    // finite HTTP routes are owned by this test; no external asset URLs occur.
    const context = await getBrowser().newContext({serviceWorkers: 'allow'});
    const errors = [], blocked = [], expectedNetworkErrors = [];
    try {
      // Exercise the native worker/network path. Same-origin CSP on both
      // document and worker prevents outside requests without route interception.
      context.on('request', request => {
        if (new URL(request.url()).origin !== origin) blocked.push(request.url());
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(10000);
      await page.goto(origin + '/harness');
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'});
        await navigator.serviceWorker.ready;
      });
      await page.reload();
      assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
      await run({page, context, expectUnavailableAsset() {
        // WebKit reports this diagnostic even when page fetch catches the
        // intentional Response.error() from an uncached, unreachable asset.
        expectedNetworkErrors.push('Response served by service worker is an error');
      }});
      for (const error of errors) {
        const index = expectedNetworkErrors.indexOf(error);
        assert.ok(index >= 0, 'Unexpected browser error: ' + error);
        expectedNetworkErrors.splice(index, 1);
      }
      assert.deepEqual(blocked, []);
    } finally {await context.close();}
  }
  const asset = (name, build = 'v1') => '/bundle/js/bundle.' + name + '.js?v=' + build;

  it('does not prefetch page code and serves a visited page asset during network failure', async function () {
    await withWorker(async ({page, context, expectUnavailableAsset}) => {
      for (const name of ['reports', 'admin', 'profile', 'food']) assert.ok(!requests.includes(asset(name)));
      assert.ok(requests.includes(asset('app')));
      await page.addScriptTag({url: origin + asset('reports')});
      assert.deepEqual(await page.evaluate(() => window.fixtureAsset), {path: '/bundle/js/bundle.reports.js', version: 'v1'});
      assert.ok(await page.evaluate(async url => !!(await (await caches.open('v1')).match(url)), origin + asset('reports')), 'The worker must cache the first page asset before offline mode');
      const count = requests.filter(url => url === asset('reports')).length;
      networkDown = true;
      // WebKit offline emulation also blocks a minimal worker that returns a
      // constant response. All engines exercise real connection failure here;
      // Chromium additionally exercises the browser offline setting.
      if (getBrowser().browserType().name() === 'chromium') await context.setOffline(true);
      await page.evaluate(() => {delete window.fixtureAsset;});
      await page.addScriptTag({url: origin + asset('reports')});
      assert.equal(await page.evaluate(() => window.fixtureAsset.version), 'v1');
      assert.equal(requests.filter(url => url === asset('reports')).length, count);
      expectUnavailableAsset();
      assert.equal(await page.evaluate(async url => {
        try {await fetch(url); return 'unexpected success';} catch (_) {return 'offline';}
      }, origin + asset('admin')), 'offline');
    });
  });

  it('bypasses an older worker for new version URLs and retires old cached code after update', async function () {
    await withWorker(async ({page}) => {
      await page.addScriptTag({url: origin + asset('reports')});
      version = 'v2';
      // Old controller must not return v1 code for the new document's URLs.
      await page.addScriptTag({url: origin + asset('app', 'v2')});
      assert.equal(await page.evaluate(() => window.fixtureAsset.version), 'v2');
      await page.addScriptTag({url: origin + asset('reports', 'v2')});
      assert.equal(await page.evaluate(() => window.fixtureAsset.version), 'v2');
      await page.evaluate(async () => {
        const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once: true}));
        await (await navigator.serviceWorker.getRegistration()).update();
        await changed;
      });
      await page.waitForFunction(async () => {
        const keys = await caches.keys(); return keys.includes('v2') && !keys.includes('v1');
      });
      await page.addScriptTag({url: origin + asset('reports', 'v2')});
      assert.equal(await page.evaluate(() => window.fixtureAsset.version), 'v2');
      const keys = await page.evaluate(async () => (await (await caches.open('v2')).keys()).map(request => request.url));
      assert.ok(keys.includes(origin + asset('reports', 'v2')));
      assert.ok(keys.every(url => !url.includes('?v=v1')));
    });
  });
});
