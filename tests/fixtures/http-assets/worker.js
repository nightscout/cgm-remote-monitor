'use strict';

// Run each server mode in an owned process so webpack watchers, boot globals and
// environment changes cannot leak into the rest of the Node test suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {once} = require('node:events');
const request = require('supertest');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nightscout-http-assets-'));
const servers = [], compilers = [];
let ctx;
const databaseName = 'nightscout_http_test_' + randomUUID().replace(/-/g, '');

function ready(bus) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {bus.off('data-processed', loaded); reject(new Error('Initial data processing timed out'));}, 15000);
    function loaded() {clearTimeout(timer); resolve();}
    bus.once('data-processed', loaded);
  });
}

async function serve(app) {
  const server = http.createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return request(server);
}

async function cleanup() {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  for (const compiler of compilers) {
    if (compiler.watching) await new Promise(resolve => compiler.watching.close(resolve));
    await new Promise(resolve => compiler.close(resolve));
  }
  if (ctx) {
    ctx.bus.teardown();
    if (ctx.store && ctx.store.client) {
      assert.equal(ctx.store.db.databaseName, databaseName, 'Only delete the owned fixture database');
      await ctx.store.db.dropDatabase();
      await ctx.store.client.close();
    }
  }
  fs.rmSync(directory, {recursive: true, force: true});
}

async function run() {
  // This child intentionally exercises production/development branches. Limit
  // its database to a named loopback test database instead of changing NODE_ENV.
  const safety = require('../../lib/production-safety');
  const mongo = new URL(process.env.CUSTOMCONNSTR_mongo);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(mongo.hostname), 'HTTP fixture requires a loopback database');
  assert.ok(safety.isTestDatabaseName(safety.extractDbName(mongo.href)), 'HTTP fixture requires a named test database');
  mongo.pathname = '/' + databaseName;
  process.env.CUSTOMCONNSTR_mongo = mongo.href;
  const env = require('../../../lib/server/env')();
  assert.equal(env.debug.minify, process.env.DEBUG_MINIFY === 'true');
  env.settings.authDefaultRoles = 'readable';
  ctx = await new Promise(resolve => require('../../../lib/server/bootevent')(env, require('../../../lib/language')()).boot(resolve));
  assert.deepEqual(ctx.bootErrors, []);
  if (ctx.runtimeState !== 'loaded') await ready(ctx.bus);
  await require('../../lib/production-safety').checkProductionSafety(ctx, env);
  ctx.ddata = require('../../../lib/data/ddata')();
  const development = process.env.NODE_ENV === 'development';
  if (development) {
    // Retain the real webpack implementation; capture only our compiler handles
    // so this fixture can close their watchers after the HTTP assertions.
    const webpack = require('webpack');
    require.cache[require.resolve('webpack')].exports = new Proxy(webpack, {
      apply(target, receiver, args) {
        const compiler = Reflect.apply(target, receiver, args);
        compilers.push(compiler);
        return compiler;
      }
    });
  }
  const createApp = require('../../../lib/server/app');
  const app = createApp(env, ctx);
  app.locals.cachebuster = 'http-contract';
  const client = await serve(app);
  const bundlePrefix = development ? '/devbundle' : '/bundle';
  const results = [];
  const sources = [
    ['/css/drawer.css', 'static/css/drawer.css', false],
    ['/js/client.js', 'static/js/client.js', false],
    ['/bundle/js/bundle.app.js', 'node_modules/.cache/_ns_cache/public/js/bundle.app.js', true],
    ['/bundle/js/bundle.clock.js', 'node_modules/.cache/_ns_cache/public/js/bundle.clock.js', true],
    ['/swagger.json', 'lib/server/swagger.json', true],
    ['/swagger.yaml', 'lib/server/swagger.yaml', true]
  ];
  for (const entry of ['app', 'clock', 'reports', 'admin', 'profile', 'food']) {
    sources.push(['/bundle/js/bundle.' + entry + '.js?v=http-contract',
      'node_modules/.cache/_ns_cache/public/js/bundle.' + entry + '.js', true]);
  }
  for (const [url, file, compressed] of sources) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const encoding of ['identity', 'gzip']) {
      const response = await client.get(url).set('Accept-Encoding', encoding).expect(200);
      assert.equal(response.text, source, url + ' preserves source bytes');
      assert.equal(response.headers['content-encoding'], encoding === 'gzip' && compressed ? 'gzip' : undefined, url + ' compression order');
      const head = await client.head(url).set('Accept-Encoding', encoding).expect(200);
      assert.ok(!head.text, 'HEAD must not return a body');
      assert.equal(head.headers['content-type'], response.headers['content-type']);
    }
    if (url.startsWith('/css/') || url.startsWith('/js/') || url.startsWith('/bundle/')) {
      const first = await client.get(url).expect(200);
      assert.equal(first.headers['cache-control'], 'public, max-age=' + (development ? '0' : '604800'));
      assert.ok(first.headers.etag && first.headers['last-modified']);
      await client.get(url).set('If-None-Match', first.headers.etag).expect(304);
      await client.get(url).set('If-Modified-Since', first.headers['last-modified']).expect(304);
    }
    results.push(url);
  }
  for (const url of ['/', '/admin/', '/profile', '/food', '/report/', '/clock/clock-digital', '/api-docs/', '/api3-docs/']) {
    const response = await client.get(url).set('Accept-Encoding', 'gzip').expect(200);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.match(response.text, /<!DOCTYPE html>/i);
    if (!url.includes('api-docs') && !url.includes('api3-docs')) {
      const entries = url.startsWith('/clock/') ? ['clock'] : ['app'];
      const entry = {'/admin/': 'admin', '/profile': 'profile', '/food': 'food', '/report/': 'reports'}[url];
      if (entry) entries.push(entry);
      for (const name of entries) assert.ok(response.text.includes(bundlePrefix + '/js/bundle.' + name + '.js?v=http-contract'), url + ' uses versioned page bundles');
    }
    results.push(url);
  }
  const serviceWorker = await client.get('/sw.js').expect(200);
  assert.match(serviceWorker.headers['content-type'], /javascript/);
  assert.equal(Boolean(serviceWorker.headers['last-modified']), !development);
  await client.get('/robots.txt').expect(200, 'User-agent: *\nDisallow: /');
  const status = await client.get('/api/v1/status.json').expect(200);
  assert.equal(status.body.status, 'ok');
  assert.equal(status.body.runtimeState, 'loaded');
  const statusV2 = await client.get('/api/v2/status.json').expect(200);
  assert.equal(statusV2.body.status, 'ok');
  assert.equal(statusV2.body.runtimeState, 'loaded');
  const versionV3 = await client.get('/api/v3/version').expect(200);
  assert.equal(versionV3.body.status, 200);
  assert.equal(versionV3.body.result.version, env.version);
  for (const url of ['/missing.js', '/missing.css']) {
    const response = await client.get(url).expect(404);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.ok(response.text.includes('Cannot GET ' + url));
  }
  await client.get('/clock/%zz').expect(400);
  results.push('service worker', 'robots', 'loaded API status', '404/400');
  if (development) {
    for (const entry of ['app', 'clock', 'reports', 'admin', 'profile', 'food']) {
      const built = await client.get('/devbundle/js/bundle.' + entry + '.js?v=http-contract').timeout(60000).expect(200);
      assert.match(built.headers['content-type'], /javascript/);
      if (entry === 'app') {
        assert.ok(built.text.includes('Nightscout bundle ready'));
        assert.ok(built.text.includes('webpack-hot-middleware'));
      }
    }
    results.push('actual webpack development middleware');
  } else {
    const content = {
      'custom.js': '// retained comment\nfunction custom ( ) { return  42; }\n',
      'custom.css': '/* retained comment */\n.custom { color: red; margin: 0  1px; }\n',
      'custom.json': '{ "answer": 42, "text": "A & B" }\n'
    };
    for (const [file, text] of Object.entries(content)) fs.writeFileSync(path.join(directory, file), text);
    const custom = await serve(createApp({...env, static_files: directory}, ctx));
    for (const [file, text] of Object.entries(content)) {
      const response = await custom.get('/' + file).set('Accept-Encoding', 'gzip').expect(200);
      assert.equal(response.text, text);
      assert.equal(response.headers['content-encoding'], undefined);
      assert.equal(response.headers['cache-control'], 'public, max-age=604800');
      await custom.get('/' + file).set('If-None-Match', response.headers.etag).expect(304);
      results.push(file);
    }
  }
  return results;
}

run().then(async results => {
  await cleanup();
  process.send({results}, () => process.exit(0));
}).catch(async error => {
  try {await cleanup();} catch (cleanupError) {error.message += '\nCleanup: ' + cleanupError.message;}
  process.send({error: error.stack}, () => process.exit(1));
});
