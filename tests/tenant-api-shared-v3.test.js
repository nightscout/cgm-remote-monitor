'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const shiro = require('shiro-trie');
const Collection = require('../lib/api3/generic/collection');
const authentication = require('../lib/api3/tenant-authentication');
const sharedV3 = require('../lib/server/tenant-app/shared-v3-routes');

function dispatch (app, tenant, url, permission = 'api:*:read') {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(new PassThrough());
    req.method = 'GET'; req.url = url; req.headers = { accept: 'application/json', 'last-modified': 'Thu, 01 Jan 1970 00:00:00 GMT' };
    req.tenantContext = { tenant };
    const permissions = shiro.new(); permissions.add(permission);
    authentication.bind(req, { shiros: [permissions] });
    const res = new http.ServerResponse(req);
    res.end = function (body) {
      this.finished = true; this.emit('finish');
      resolve({ status: this.statusCode, body: body ? JSON.parse(String(body)) : null });
    };
    app(req, res, error => error ? reject(error) : resolve({ status: 404 }));
  });
}

function fixture ({ wrongBinding = false } = {}) {
  const bindings = new Map();
  const router = sharedV3({ names: ['food'], resolve: (req, logical) => {
    assert.equal(logical, 'food');
    return bindings.get(wrongBinding ? 'a' : req.tenantContext.tenant);
  } });
  const calls = [], release = {}, entered = {};
  for (const tenant of ['a', 'b']) {
    const app = router.settings();
    app.set('API3_MAX_LIMIT', tenant === 'a' ? 1 : 2);
    const storage = { async findMany (options) {
      calls.push({ tenant, limit: options.limit });
      if (entered[tenant]) entered[tenant]();
      await new Promise(resolve => { release[tenant] = resolve; });
      return [{ _id: tenant, marker: tenant, srvModified: 1 }];
    } };
    const ctx = { bus: new EventEmitter(), purifier: {} }, env = { apiV3DataWarnings: false };
    const col = new Collection({ ctx, env, app, colName: 'food', storage, intentFactory: () => null });
    bindings.set(tenant, { ctx, env, app, col });
  }
  const app = express(); app.use(router.router);
  return { app, router, calls, release, entered, bindings };
}

async function selected (f, tenant, url) {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.entered[tenant] = entered;
  const result = dispatch(f.app, tenant, url);
  await ready;
  return { result };
}

describe('shared multitenant v3 routes', function () {
  it('uses a fixed route tree and settings scaffold for ten thousand tenant bindings', function () {
    const file = require.resolve('../lib/server/tenant-app/shared-v3-routes');
    const local = createRequire(file), result = { exports: {} }, counts = { apps: 0, routers: 0 };
    const observed = Object.assign((...args) => { counts.apps++; return express(...args); }, express);
    observed.Router = (...args) => { counts.routers++; return express.Router(...args); };
    vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
      name => name === 'express' ? observed : local(name), result, result.exports);
    const shared = result.exports({ names: ['entries', 'food'], resolve: () => { throw new Error('unused'); } });
    const routeCount = shared.router.stack.length;
    for (let i = 0; i < 10000; i++) {
      const settings = shared.settings();
      settings.set('tenant-marker', i);
      assert.equal(settings.get('tenant-marker'), i);
    }
    assert.deepEqual(counts, { apps: 1, routers: 1 });
    assert.equal(routeCount, 16);
    assert.equal(shared.router.stack.length, routeCount);
    assert.equal(shared.settings().get('tenant-marker'), undefined);
  });

  it('keeps concrete tenant storage, settings and pruning state across overlapping requests', async function () {
    const f = fixture();
    const a = await selected(f, 'a', '/FoOd?limit=1');
    const b = await selected(f, 'b', '/food?limit=2');
    assert.deepEqual(f.calls, [{ tenant: 'a', limit: 1 }, { tenant: 'b', limit: 2 }]);
    f.release.b(); const resultB = await b.result;
    f.release.a(); const resultA = await a.result;
    assert.equal(resultA.body.result[0].marker, 'a');
    assert.equal(resultB.body.result[0].marker, 'b');
    const ca = f.bindings.get('a').col, cb = f.bindings.get('b').col;
    assert.notEqual(ca, cb); ca.nextAutoPrune = new Date(123);
    assert.notEqual(cb.nextAutoPrune.getTime(), 123);
    assert.equal(f.router.router.stack.length, 8);
  });

  it('rejects another tenant limit and denies unauthorized requests before storage', async function () {
    const f = fixture();
    const limit = await dispatch(f.app, 'a', '/food?limit=2');
    assert.equal(limit.status, 400);
    const log = console.error; console.error = () => {};
    try { assert.equal((await dispatch(f.app, 'b', '/food', 'api:entries:read')).status, 403); }
    finally { console.error = log; }
    assert.deepEqual(f.calls, []);
  });

  it('preserves history precedence, timestamp parameters and identifier reads', async function () {
    const f = fixture();
    for (const tenant of ['a', 'b']) {
      const storage = f.bindings.get(tenant).col.storage;
      storage.findMany = async options => {
        assert.equal(options.onlyValid, false);
        return [{ identifier: tenant, marker: tenant, srvModified: 1000 }];
      };
      storage.findOne = async identifier => [{ identifier, marker: tenant, srvModified: 1000 }];
    }
    for (const tenant of ['a', 'b']) {
      for (const url of ['/food/history', '/food/history/1700000000000']) {
        const result = await dispatch(f.app, tenant, url);
        assert.equal(result.status, 200);
        assert.equal(result.body.result[0].marker, tenant);
      }
      const result = await dispatch(f.app, tenant, '/food/selected-id');
      assert.equal(result.status, 200);
      assert.equal(result.body.result.identifier, 'selected-id');
      assert.equal(result.body.result.marker, tenant);
    }
  });

  it('preserves selected collection error hooks and forwards binding failures', async function () {
    const f = fixture();
    for (const tenant of ['a', 'b']) {
      const col = f.bindings.get(tenant).col;
      col.storage.findMany = async () => { throw new Error('synthetic failure'); };
      col.storageError = (error, res) => { res.status(503).json({ tenant, message: error.message }); return true; };
    }
    const log = console.error; console.error = () => {};
    try {
      assert.equal((await dispatch(f.app, 'a', '/food')).body.tenant, 'a');
      assert.equal((await dispatch(f.app, 'b', '/food')).body.tenant, 'b');
    } finally { console.error = log; }
    await assert.rejects(dispatch(f.app, 'unknown', '/food'), TypeError);
  });

  it('control: binding every request to one tenant fails the independent response oracle', async function () {
    const f = fixture({ wrongBinding: true });
    // This deliberately broken selection enters a's storage for b's request.
    let entered;
    const ready = new Promise(resolve => { entered = resolve; }); f.entered.a = entered;
    const pending = dispatch(f.app, 'b', '/food'); await ready;
    f.release.a(); const result = await pending;
    assert.equal(f.calls[0].tenant, 'a', 'BROKEN_BINDING_WAS_EXERCISED');
    assert.throws(() => assert.equal(result.body.result[0].marker, 'b', 'TENANT_RESPONSE_BINDING'));
  });
});
