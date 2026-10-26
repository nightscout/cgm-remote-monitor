'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {getBrowser} = require('./hooks');

// The isolated chart fixtures use production main.css, including its local
// font import. Serve only the font resources that stylesheet can request.
const fontDirectory = path.resolve(__dirname, '../../static/font/ubuntu');
const fontStylesheet = path.resolve(__dirname, '../../static/css/ubuntu-font.css');
const fontAssets = new Map([
  ['/css/ubuntu-font.css', [fontStylesheet, 'text/css; charset=utf-8']],
  ...fs.readdirSync(fontDirectory).filter(name => name.endsWith('.woff2'))
    .map(name => ['/font/ubuntu/' + name, [path.join(fontDirectory, name), 'font/woff2']])
]);

exports.serveFontAsset = function (request, response) {
  const asset = fontAssets.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!asset) return false;
  response.setHeader('Content-Type', asset[1]);
  response.end(fs.readFileSync(asset[0]));
  return true;
};

// Allow only the exact origin of a disposable fixture server. A different
// loopback port is still outside the fixture; page content cannot expand it.
function permitted(url, origin) {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  return !parsed.username && !parsed.password && parsed.origin === origin;
}

exports.withPage = async function (origin, run, {expectBlocked = false, hasTouch = false, timezoneId} = {}) {
  const target = new URL(origin);
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.origin, origin);
  const context = await getBrowser().newContext({serviceWorkers: 'block', acceptDownloads: false, hasTouch, timezoneId});
  const blocked = [], errors = [], routed = new Map();
  try {
    // Fulfilled documents have no network address. Chromium's local-network
    // permission is needed for their native WebSocket connection to our
    // loopback fixture; request/WebSocket allow-lists still enforce its origin.
    if (getBrowser().browserType().name() === 'chromium') {
      await context.grantPermissions(['local-network-access'], {origin});
    }
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (!permitted(url, origin)) {
        blocked.push(url);
        return route.abort('blockedbyclient');
      }
      // route.continue() can follow redirects without invoking this handler
      // again. Fixture HTTP responses are finite and redirects are forbidden;
      // fetch one response only, then fulfill it with its actual headers/body.
      const request = route.request();
      const state = {path: new URL(url).pathname, phase: 'fetch', since: Date.now()};
      routed.set(request, state);
      // Keep intercepted fixture requests independent: hosted runs have
      // stalled in fetch before reaching the server when reusing connections.
      const response = await route.fetch({maxRedirects: 0, timeout: 5000,
        headers: {...await request.allHeaders(), connection: 'close'}});
      try {
        const location = response.headers().location;
        if (response.status() >= 300 && response.status() < 400 && location) {
          blocked.push(new URL(location, url).href);
          return await route.abort('blockedbyclient');
        }
        state.phase = 'fulfill';
        await route.fulfill({response});
      } finally {
        state.phase = 'dispose';
        await response.dispose();
        routed.delete(request);
      }
    });
    await context.routeWebSocket(url => !permitted(url.toString(), origin), socket => {
      blocked.push(socket.url());
      socket.close({code: 1008, reason: 'Outside test fixture'});
    });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(5000);
    const result = await run({page, context, blocked, routed});
    assert.deepEqual(errors, [], 'Uncaught browser errors');
    if (!expectBlocked) assert.deepEqual(blocked, [], 'Unexpected request outside test fixture');
    return result;
  } finally {
    await context.close();
  }
};
