'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');

describe('versioned dashboard assets', function () {
  it('uses a new bundle URL after restart and serves that bundle offline from the worker cache', async function () {
    const origin = 'https://nightscout.test';
    const version = 'new-release';
    const html = await ejs.renderFile(path.join(__dirname, '../views/index.html'), {
      settings: {theme: 'modern'}, locals: {bundle: '/bundle', cachebuster: version}, type: 'index', title: ''
    });
    assert.ok(html.includes('/bundle/js/bundle.app.js?v=' + version));
    const worker = ejs.render(fs.readFileSync(path.join(__dirname, '../views/service-worker.js'), 'utf8'), {locals: {cachebuster: version}});
    const handlers = {};
    const entries = new Map();
    let offline = false;
    function key (request) { return new URL(typeof request === 'string' ? request : request.url, origin).href; }
    const cache = {
      match: async request => entries.get(key(request)),
      put: async (request, response) => entries.set(key(request), response)
    };
    vm.runInNewContext(worker, {
      self: {location: {origin}, skipWaiting: () => {}, addEventListener: (name, callback) => { handlers[name] = callback; }},
      caches: {open: async () => cache},
      Request: class { constructor (url) { this.url = new URL(url, origin).href; } },
      fetch: async () => {
        if (offline) throw new Error('No network available');
        return {status: 200, body: 'cached bundle', clone: function () { return this; }};
      },
      URL,
      Response: class { constructor () { this.status = 503; } static error () { return new this(); } },
      console: {log: () => {}, error: () => {}}
    });
    let install;
    handlers.install({waitUntil: task => { install = task; }});
    await install;
    offline = true;
    let response;
    handlers.fetch({
      request: {url: origin + '/bundle/js/bundle.app.js?v=' + version, method: 'GET', headers: {get: () => null}},
      respondWith: task => { response = task; }
    });
    assert.ok(response, 'the worker answers the versioned bundle request');
    assert.strictEqual((await response).body, 'cached bundle');
    // Cut 2's worker caches versioned bundle addresses only: no page requests the
    // unversioned address, and documents are never cached by the worker.
    assert.ok(!entries.has(origin + '/bundle/js/bundle.app.js'), 'no unversioned bundle is downloaded at install');
  });
});
