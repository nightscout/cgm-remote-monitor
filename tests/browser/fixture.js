'use strict';

const assert = require('node:assert/strict');
const {getBrowser} = require('./hooks');

// Allow only the exact origin of a disposable fixture server. A different
// loopback port is still outside the fixture; page content cannot expand it.
function permitted(url, origin) {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  return !parsed.username && !parsed.password && parsed.origin === origin;
}

exports.withPage = async function (origin, run, {expectBlocked = false, hasTouch = false} = {}) {
  const target = new URL(origin);
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.origin, origin);
  const context = await getBrowser().newContext({serviceWorkers: 'block', acceptDownloads: false, hasTouch});
  const blocked = [], errors = [];
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
      const response = await route.fetch({maxRedirects: 0, timeout: 5000});
      try {
        const location = response.headers().location;
        if (response.status() >= 300 && response.status() < 400 && location) {
          blocked.push(new URL(location, url).href);
          return await route.abort('blockedbyclient');
        }
        await route.fulfill({response});
      } finally {
        await response.dispose();
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
    const result = await run({page, context, blocked});
    assert.deepEqual(errors, [], 'Uncaught browser errors');
    if (!expectBlocked) assert.deepEqual(blocked, [], 'Unexpected request outside test fixture');
    return result;
  } finally {
    await context.close();
  }
};
