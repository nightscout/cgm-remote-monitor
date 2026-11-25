'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const shiro = require('shiro-trie');
const scope = require('../lib/storage/tenant-scope');
const authentication = require('../lib/api3/tenant-authentication');
const environment = require('../lib/server/tenant-app/environment');
const preview = require('../lib/server/serve/preview-domains');
const writeClock = require('../lib/storage/postgres-write-clock');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];

// Emit request bytes outside dispatch, as IncomingMessage stream events can do.
function post (app, tenant) {
  const req = new http.IncomingMessage(new PassThrough());
  const body = JSON.stringify([{ type: 'sgv', sgv: 123, date: 1700000000000 }]);
  req.method = 'POST'; req.url = '/api/v1/entries';
  req.headers = { accept: 'application/json', 'x-test-tenant': tenant,
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  const pending = new Promise((resolve, reject) => {
    const res = new http.ServerResponse(req);
    res.end = function (value) {
      this.finished = true; this.emit('finish');
      resolve({ status: this.statusCode, body: value && JSON.parse(String(value)) });
    };
    app(req, res, error => error ? reject(error) : resolve({ status: 404 }));
  });
  setImmediate(() => { req.push(body); req.push(null); });
  return pending;
}
async function fixture ({ loseScope = false, uncertain = false } = {}) {
  const operations = new AsyncLocalStorage(), sql = [];
  let recording = false;
  const connection = {
    withTenant: (tenant, fn) => scope.withTenant(tenant, fn),
    withSavepoint: fn => fn(),
    async transaction (fn) {
      const result = await fn();
      if (uncertain && scope.currentTenant() === A) throw new Error('synthetic commit acknowledgement lost');
      return result;
    },
    async query (text) {
      if (text.includes("current_setting('server_version')")) return { rows: [{ version: 'recording' }] };
      if (recording) {
        sql.push({ tenant: scope.requireTenant(), operation: operations.getStore(), text });
        assert.equal(operations.getStore(), scope.currentTenant(), 'OPERATION_CONTEXT_REQUIRED');
      }
      await new Promise(resolve => setImmediate(resolve));
      if (text.startsWith('WITH locked')) return { rows: [{ matched: 0, modified: 0, over_cap: false, unsortable: false }] };
      if (text.startsWith('SELECT last_stamp')) return { rows: [{ last_stamp: 1 }] };
      if (text.startsWith('UPDATE "test_clock"')) return { rows: [], rowCount: 1 };
      return { rows: [] };
    }
  };
  const graph = await preview({ config: { domains, legacyEnabled: true,
    namespaces: Object.fromEntries(domains.map(domain => [domain, 'test_' + domain])), bindings: new Map([[A, {}], [B, {}]]),
    environments: new Map([A, B].map(tenant => [tenant, environment()])) },
  connection: writeClock(connection, 'test_clock'), exchange: async () => null });
  recording = true;
  const app = express();
  app.use((req, res, next) => {
    const tenant = req.headers['x-test-tenant'];
    scope.withTenant(tenant, () => operations.run(loseScope ? undefined : tenant, () => {
      req.tenantAuthenticate = async () => {
        req.tenantContext = { tenant };
        const rights = shiro.new(); rights.add('api:entries:create'); rights.add('api:entries:read');
        authentication.bind(req, { shiros: [rights] });
      };
      next();
    }));
  });
  app.use('/api/v1', graph.legacyRouter);
  app.use((error, req, res, next) => { void error; void req; void next; res.status(503).json({ error: 'TEST_REFUSED' }); });
  return { app, sql };
}
describe('stored v1 entries retain the current request context', function () {
  let old;
  before(() => { old = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(() => scope.setTenancyMode(old));
  it('retains tenant and operation scope through delayed parsing, actual writes and clock-floor update', async function () {
    const f = await fixture();
    const replies = await Promise.all([post(f.app, A), post(f.app, B)]);
    assert.deepEqual(replies.map(r => r.status), [200, 200]);
    for (const tenant of [A, B]) {
      const statements = f.sql.filter(row => row.tenant === tenant);
      assert(statements.some(row => row.text.startsWith('INSERT INTO "test_entries"')), 'STORED_WRITE_REQUIRED');
      assert(statements.some(row => row.text.startsWith('UPDATE "test_clock"')), 'CLOCK_UPDATE_REQUIRED');
      assert(statements.every(row => row.operation === tenant), 'CURRENT_OPERATION_REQUIRED');
    }
  });
  it('control: a missing operation context refuses before clinical writes', async function () {
    const f = await fixture({ loseScope: true });
    assert.notEqual((await post(f.app, A)).status, 200);
    assert(!f.sql.some(row => row.text.startsWith('INSERT INTO')));
    assert(f.sql.length > 0, 'control reached the clock boundary');
  });
  it('does not return success when commit acknowledgement is uncertain', async function () {
    const f = await fixture({ uncertain: true });
    assert.notEqual((await post(f.app, A)).status, 200);
    assert.equal(f.sql.filter(row => row.tenant === A && row.text.startsWith('INSERT INTO "test_entries"')).length, 1, 'uncertain write is attempted once without retry');
    assert.equal((await post(f.app, B)).status, 200, 'another tenant remains writable');
  });
});
