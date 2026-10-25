'use strict';

const assert = require('assert');
const path = require('path');
const vm = require('vm');
const {spawnSync} = require('child_process');
const request = require('supertest');
const createApp = require('../lib/server/app');

function app() {
  return createApp({name: 'cachebuster-test', version: '1.0.0', insecureUseHttp: true,
    settings: require('../lib/settings')(), static_files: '/static'},
  {bootErrors: [{desc: 'fixture', err: 'fixture'}]});
}

function cacheName(script) {
  const match = script.match(/var CACHE = '([^']+)'/);
  assert.ok(match, 'service worker includes its cache name');
  return match[1];
}

describe('native cachebuster compatibility', function () {
  let priorMode;
  beforeEach(function () { priorMode = process.env.NODE_ENV; });
  afterEach(function () {
    if (priorMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorMode;
  });

  it('keeps the same URL-safe cache name within an app and rotates it for a new app', async function () {
    process.env.NODE_ENV = 'production';
    const first = app(), second = app();
    assert.match(first.locals.cachebuster, /^[a-zA-Z0-9_-]{16}$/);
    assert.notStrictEqual(first.locals.cachebuster, second.locals.cachebuster);
    const one = await request(first).get('/sw.js').expect(200).expect('Content-Type', /javascript/);
    const two = await request(first).get('/sw.js').expect(200);
    const next = await request(second).get('/sw.js').expect(200);
    assert.strictEqual(cacheName(one.text), first.locals.cachebuster);
    assert.strictEqual(cacheName(two.text), cacheName(one.text));
    assert.strictEqual(cacheName(next.text), second.locals.cachebuster);
    assert.ok(one.headers['last-modified']);
  });

  it('preserves the development sentinel and no Last-Modified header', async function () {
    process.env.NODE_ENV = 'development';
    const development = app();
    assert.strictEqual(development.locals.cachebuster, 'developmentMode');
    const result = await request(development).get('/sw.js').expect(200);
    assert.strictEqual(cacheName(result.text), 'developmentMode');
    assert.strictEqual(result.headers['last-modified'], undefined);
  });

  it('removes legacy caches on worker activation while retaining the new cache', async function () {
    process.env.NODE_ENV = 'production';
    const current = app();
    const response = await request(current).get('/sw.js').expect(200);
    const handlers = {}, removed = [];
    const legacy = 'AbCDefG123456789';
    vm.runInNewContext(response.text, {
      self: {addEventListener(name, handler) { handlers[name] = handler; }},
      caches: {
        keys: async () => [legacy, current.locals.cachebuster],
        delete: async name => { removed.push(name); return true; }
      }
    });
    let completion;
    handlers.activate({waitUntil(promise) { completion = promise; }});
    await completion;
    assert.deepStrictEqual(removed, [legacy]);
  });

  it('keeps development worker requests on the network', async function () {
    process.env.NODE_ENV = 'development';
    const response = await request(app()).get('/sw.js').expect(200);
    const handlers = {};
    let fetched, completion;
    const resource = {url: 'https://fixture.example/images/launch.png', method: 'GET'};
    vm.runInNewContext(response.text, {
      self: {location: {origin: 'https://fixture.example'}, addEventListener(name, handler) { handlers[name] = handler; }},
      fetch: async request => { fetched = request; return 'network'; },
      caches: {open() { throw new Error('Development worker accessed the cache'); }}
    });
    handlers.fetch({request: resource, respondWith(promise) { completion = promise; }});
    assert.strictEqual(await completion, 'network');
    assert.strictEqual(fetched, resource);
  });

  it('prints exactly one 16-character token from the command-line generator', function () {
    const script = path.resolve(__dirname, '../bin/generateCacheBuster.js');
    const first = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 5000});
    const second = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 5000});
    for (const result of [first, second]) {
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stderr, '');
      assert.match(result.stdout, /^[a-zA-Z0-9_-]{16}\n$/);
    }
    assert.notStrictEqual(first.stdout, second.stdout);
  });
});
