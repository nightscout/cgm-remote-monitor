'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../views/service-worker.js'), 'utf8');
const origin = 'https://nightscout.test';
const pagesFor = version => ['reports', 'admin', 'profile', 'food'].map(name => '/bundle/js/bundle.' + name + '.js?v=' + version);
const pages = pagesFor('v1');
const urlOf = input => typeof input === 'string' ? new URL(input, origin).href : input.url;

function worker(version = 'v1', stores = new Map()) {
  const listeners = {}, requests = [];
  const state = {stores, requests, offline: false, cacheError: null, putGate: null,
    response: request => new Response(version + ':' + new URL(request.url).pathname + new URL(request.url).search)};
  const caches = {
    async open(name) {
      if (state.cacheError === 'open') throw new Error('Cache unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(input) {return store.get(urlOf(input))?.clone();},
        async put(input, response) {
          if (state.putGate) await state.putGate;
          if (state.cacheError === 'put') throw new Error('Quota exhausted');
          store.set(urlOf(input), response.clone());
        }
      };
    },
    async keys() {return Array.from(stores.keys());},
    async delete(name) {return stores.delete(name);}
  };
  class WorkerRequest extends Request {
    constructor(input, options) {super(typeof input === 'string' ? new URL(input, origin) : input, options);}
  }
  vm.runInNewContext(source.replace('<%= locals.cachebuster %>', version), {
    self: {location: {origin}, skipWaiting() {}, addEventListener(name, handler) {listeners[name] = handler;}},
    caches, Request: WorkerRequest, Response, URL, console: {log() {}},
    fetch: async input => {
      const request = input instanceof Request ? input : new WorkerRequest(input);
      requests.push(request.url);
      if (state.offline) throw new Error('Offline');
      return state.response(request);
    }
  });
  state.fetch = (input, options) => {
    let result;
    listeners.fetch({request: new WorkerRequest(input, options), respondWith(value) {result = value;}});
    return result;
  };
  for (const name of ['install', 'activate']) state[name] = () => {
    let result;
    listeners[name]({waitUntil(value) {result = value;}});
    return result;
  };
  return state;
}

describe('Service worker asset cache contracts', function () {
  it('precaches shared/clock assets but loads each page bundle only on demand', async function () {
    const state = worker();
    await state.install();
    assert.ok(state.requests.includes(origin + '/bundle/js/bundle.app.js?v=v1'));
    assert.ok(state.requests.includes(origin + '/bundle/js/bundle.clock.js?v=v1'));
    assert.ok(pages.every(page => !state.requests.includes(origin + page)));
    for (const page of pages) {
      const count = state.requests.length;
      const first = await state.fetch(page);
      assert.equal(await first.text(), 'v1:' + page);
      state.offline = true;
      assert.equal(await (await state.fetch(page)).text(), 'v1:' + page);
      assert.equal(state.requests.length, count + 1);
      state.offline = false;
    }
  });

  it('keeps installation pending until cache writes finish', async function () {
    const state = worker();
    let release, installed = false;
    state.putGate = new Promise(resolve => {release = resolve;});
    const finished = state.install().then(() => {installed = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(state.requests.length > 0);
    assert.equal(installed, false);
    release(); await finished;
    assert.equal(installed, true);
  });

  it('does not cache failed responses and recovers on a later successful request', async function () {
    const state = worker();
    state.response = () => new Response('Missing', {status: 404});
    await state.install();
    assert.equal(state.stores.get('v1').size, 0);
    assert.equal((await state.fetch(pages[0])).status, 404);
    state.response = () => new Response('Recovered');
    assert.equal(await (await state.fetch(pages[0])).text(), 'Recovered');
    state.offline = true;
    assert.equal(await (await state.fetch(pages[0])).text(), 'Recovered');
  });

  for (const failure of ['open', 'put']) {
    it('serves successful network responses when cache ' + failure + ' fails', async function () {
      const state = worker(); state.cacheError = failure;
      await state.install();
      assert.equal(await (await state.fetch(pages[0])).text(), 'v1:' + pages[0]);
      state.offline = true;
      assert.equal((await state.fetch(pages[0])).type, 'error');
    });
  }

  it('bypasses API, query-string, external, non-GET and development requests', async function () {
    const state = worker();
    for (const [url, options] of [['/api/v1/status.json'], [pages[0] + '?v=2'],
      ['https://nightscout.test.example/bundle/js/bundle.reports.js'], [pages[0], {method: 'POST'}]]) {
      await state.fetch(url, options);
    }
    assert.equal(state.requests.length, 4);
    assert.equal(state.stores.size, 0);
    const development = worker('developmentMode');
    await development.fetch(pages[0]); await development.fetch(pages[0]);
    assert.equal(development.requests.length, 2);
    assert.equal(development.stores.size, 0);
  });

  it('retires the old build cache and fetches current page code after activation', async function () {
    const old = worker('old');
    await old.install(); await old.fetch(pagesFor('old')[0]);
    const current = worker('current', old.stores);
    await current.install(); await current.activate();
    assert.deepEqual(Array.from(current.stores.keys()), ['current']);
    assert.equal(await (await current.fetch(pagesFor('current')[0])).text(), 'current:' + pagesFor('current')[0]);
    assert.equal(current.requests.filter(url => url === origin + pagesFor('current')[0]).length, 1);
  });

  it('an older worker bypasses its cache for a newer page asset version', async function () {
    const state = worker('old');
    await state.fetch(pagesFor('old')[0]);
    state.response = () => new Response('New deployment');
    assert.equal(await (await state.fetch(pagesFor('new')[0])).text(), 'New deployment');
    assert.equal(state.stores.get('old').has(origin + pagesFor('new')[0]), false);
    assert.equal(state.requests.length, 2);
  });

  it('slices full cached ranges and forwards uncached partial responses without recaching', async function () {
    const state = worker(); state.response = () => new Response('abcdef', {headers: {'Content-Type': 'application/javascript'}});
    await state.fetch(pages[0]);
    for (const [range, body, contentRange] of [['bytes=0-0', 'a', 'bytes 0-0/6'], ['bytes=2-4', 'cde', 'bytes 2-4/6'], ['bytes=4-99', 'ef', 'bytes 4-5/6']]) {
      const response = await state.fetch(pages[0], {headers: {range}});
      assert.equal(response.status, 206); assert.equal(await response.text(), body);
      assert.equal(response.headers.get('Content-Range'), contentRange);
      assert.equal(response.headers.get('Content-Type'), 'application/javascript');
    }
    assert.equal((await state.fetch(pages[0], {headers: {range: 'bytes=9-'}})).status, 416);
    state.response = () => new Response('xyz', {status: 206, headers: {'Content-Range': 'bytes 3-5/6'}});
    assert.equal(await (await state.fetch(pages[1], {headers: {range: 'bytes=3-5'}})).text(), 'xyz');
    assert.equal(state.stores.get('v1').has(origin + pages[1]), false);
  });
});
