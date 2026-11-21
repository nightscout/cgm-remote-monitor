'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const express = require('express'), shiro = require('shiro-trie');
const environment = require('../lib/server/tenant-app/environment');
const authentication = require('../lib/api3/tenant-authentication');
const create = require('../lib/server/tenant-app/shared-rest-context');
const versionInfo = { name: 'synthetic', version: 'test', storage: { storage: 'PostgreSQL', version: 'protocol' } };
const admitted = { 1: ['entries', 'food'], 2: ['entries', 'food'], 3: ['entries', 'food'] };

function dispatch (router, context, url, { body, grant = '*', tenant = context.tenant } = {}) {
  const socket = new PassThrough(), req = new http.IncomingMessage(socket), res = new http.ServerResponse(req);
  req.method = 'GET'; req.url = url; req.headers = { accept: 'application/json' }; req.tenantContext = { tenant };
  if (body) Object.assign(req.headers, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  const trie = shiro.new(); if (grant) trie.add(grant);
  req.tenantAuthenticate = async () => { await new Promise(resolve => setImmediate(resolve)); authentication.bind(req, { shiros: [trie] }); };
  // v3 metadata reaches its shared router after outer request authentication.
  authentication.bind(req, { shiros: [trie] });
  const app = express();
  app.use((req, res, next) => router(req, res, next));
  return new Promise((resolve, reject) => {
    res.end = function (data) { this.finished = true; this.emit('finish'); resolve({ status: this.statusCode, body: data ? JSON.parse(String(data)) : null }); };
    app(req, res, error => error ? reject(error) : resolve({ status: 404 }));
    // Deliberately originate the body events outside the router's ALS scope.
    if (body) setImmediate(() => { req.push(body); req.push(null); });
  });
}
function fixture (factory = create) {
  const shared = factory({ versionInfo, admitted });
  const make = (tenant, units, name, stamp) => {
    const context = { tenant, env: environment({ settings: { units, customTitle: tenant } }), collections: {
      [name]: { colName: name, storage: { async getLastModified () { await new Promise(resolve => setImmediate(resolve)); return { srvModified: stamp }; } } }
    }, statusAuthorization: async () => { await new Promise(resolve => setImmediate(resolve)); return tenant; } };
    return { ...context, routes: shared.forContext(context) };
  };
  return { shared, a: make('A', 'mg/dl', 'entries', 11), b: make('B', 'mmol', 'food', 22) };
}

describe('shared metadata REST composition', function () {
  it('keeps asynchronous status environments, credentials and parser continuations private', async function () {
    const { a, b } = fixture();
    const replies = await Promise.all([dispatch(a.routes.legacy, a, '/status.json', { body: '{}' }), dispatch(b.routes.legacy, b, '/status.json', { body: '{}' })]);
    for (const [i, context] of [a, b].entries()) {
      assert.equal(replies[i].status, 200);
      assert.equal(replies[i].body.settings.customTitle, context.tenant);
      assert.equal(replies[i].body.settings.units, context.env.settings.units);
      assert.equal(replies[i].body.authorized, context.tenant);
    }
    const denied = await dispatch(a.routes.legacy, a, '/status', { grant: '' });
    assert.equal(denied.status, 401);
    assert.equal((await dispatch(b.routes.legacy, b, '/status')).body.authorized, 'B');
  });
  it('selects each current collection catalogue and lastModified port after asynchronous work', async function () {
    const { a, b } = fixture();
    const permissions = await Promise.all([dispatch(a.routes.v2, a, '/authorization/permissions'), dispatch(b.routes.v2, b, '/authorization/permissions')]);
    assert(permissions[0].body.includes('api:entries:read')); assert(!permissions[0].body.includes('api:food:read'));
    assert(permissions[1].body.includes('api:food:read')); assert(!permissions[1].body.includes('api:entries:read'));
    const statuses = await Promise.all([dispatch(a.routes.v3, a, '/status'), dispatch(b.routes.v3, b, '/status')]);
    assert.deepEqual(Object.keys(statuses[0].body.result.apiPermissions), ['entries']);
    assert.deepEqual(Object.keys(statuses[1].body.result.apiPermissions), ['food']);
    const last = await Promise.all([dispatch(a.routes.v3, a, '/lastModified'), dispatch(b.routes.v3, b, '/lastModified')]);
    assert.deepEqual(last[0].body.result.collections, { entries: 11 });
    assert.deepEqual(last[1].body.result.collections, { food: 22 });
    const version = await dispatch(a.routes.v3, a, '/version.json'); assert.equal(version.body.result.version, 'test');
    const versions = await dispatch(a.routes.root, a, '/versions', { grant: 'api:entries:read' });
    assert(versions.body.every(version => version.collections.join() === 'entries'));
  });
  it('refuses a missing or different tenant binding without entering a metadata handler', async function () {
    const { a } = fixture();
    await assert.rejects(dispatch(a.routes.legacy, a, '/status', { tenant: 'B' }), /binding mismatch/);
    await assert.rejects(dispatch(a.routes.v3, a, '/status', { tenant: null }), /binding mismatch/);
  });
  it('constructs a fixed router/app set independent of tenant contexts and dispatched requests', async function () {
    const file = require.resolve('../lib/server/tenant-app/shared-rest-context'), local = createRequire(file), counts = { apps: 0, routers: 0 };
    const observed = Object.assign((...args) => { counts.apps++; return express(...args); }, express);
    observed.Router = (...args) => { counts.routers++; return express.Router(...args); };
    const out = { exports: {} };
    vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(name => name === 'express' ? observed : local(name), out, out.exports);
    const { shared, a, b } = fixture(out.exports), initial = { ...counts };
    assert(initial.routers > 0);
    for (let i = 0; i < 100; i++) shared.forContext({ tenant: String(i), env: environment(), collections: {} });
    await Promise.all([dispatch(a.routes.legacy, a, '/status'), dispatch(b.routes.v3, b, '/status')]);
    assert.deepEqual(counts, initial, 'METADATA_ROUTE_GRAPHS_MUST_BE_SHARED');
  });
  it('control: a misbound status authority fails the tenant isolation oracle', async function () {
    const file = require.resolve('../lib/server/tenant-app/shared-rest-context'), local = createRequire(file), out = { exports: {} };
    const original = fs.readFileSync(file, 'utf8'), anchor = 'authorizeStatus: req => current().statusAuthorization(req)';
    assert(original.includes(anchor));
    const broken = original.replace(anchor, "authorizeStatus: async () => 'B'");
    vm.runInThisContext('(function(require,module,exports){' + broken + '\n})', { filename: file })(local, out, out.exports);
    const { a } = fixture(out.exports), wrong = await dispatch(a.routes.legacy, a, '/status');
    assert.equal(wrong.body.authorized, 'B', 'CONTROL_MUST_CHANGE_ACTUAL_REPLY');
    assert.throws(() => assert.equal(wrong.body.authorized, a.tenant, 'STATUS_TENANT_ISOLATION'), /STATUS_TENANT_ISOLATION/);
  });
});
