'use strict';

// covers: lib/tenant-registry/rest.js, lib/tenant-registry/openapi.json
// PUT /v1/tenants/{id}/secrets/{ref}
// Write-only connector secret entry on the admin listener (decision connector-secret-entry-admin):
// the value reaches the provisioning library once, and is never in a response or a log line.
const assert = require('node:assert/strict');
const http = require('node:http');
const { createProvisioningApi } = require('../lib/tenant-registry/rest');

describe('tenant secret entry resource', function () {
  const A = '11111111-1111-4111-8111-111111111111', VALUE = 'synthetic-secret-value-0001';
  let server, origin, calls, logs, outcome;
  before(async function () {
    calls = []; logs = [];
    const provisioning = { provision () {}, provisionBatch () {}, get () {}, remove () {},
      async enterSecret (id, ref, value) { calls.push({ id, ref, value }); return outcome(id, ref); } };
    const handler = createProvisioningApi({ provisioning, log: event => logs.push(JSON.stringify(event)) });
    server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(() => new Promise(resolve => server.close(resolve)));
  const put = (path, body, type = 'application/json') => fetch(origin + path, { method: 'PUT', headers: { 'content-type': type }, body })
    .then(async r => ({ status: r.status, text: await r.text() }));

  it('SE_CREATED: 201 with the id, ref and outcome only; the value reaches the library once and is never logged', async function () {
    outcome = (id, ref) => ({ id, ref, outcome: 'created' });
    const r = await put('/v1/tenants/' + A + '/secrets/connector-nightscout-source', JSON.stringify({ value: VALUE }));
    assert.equal(r.status, 201);
    assert.deepEqual(JSON.parse(r.text), { id: A, ref: 'connector-nightscout-source', outcome: 'created' });
    assert.deepEqual(calls, [{ id: A, ref: 'connector-nightscout-source', value: VALUE }]);
    assert.ok(!r.text.includes(VALUE) && !logs.join('\n').includes(VALUE));
    assert.deepEqual(logs, ['{"operation":"secret-entry","outcome":"created"}']);
  });

  it('SE_REFUSED: an existing ref is 409, an inactive tenant 409, an unknown tenant 404, a bad body 422/415, other methods 405', async function () {
    const cases = [['TENANT_SECRET_EXISTS', 409], ['TENANT_SECRET_REQUIRES_ACTIVE', 409], ['TENANT_NOT_FOUND', 404], ['TENANT_SECRET_INVALID', 422]];
    for (const [code, status] of cases) {
      outcome = (id, ref) => ({ id, ref, outcome: 'refused', code });
      const r = await put('/v1/tenants/' + A + '/secrets/connector-x', JSON.stringify({ value: VALUE }));
      assert.equal(r.status, status, code);
      assert.equal(JSON.parse(r.text).code, code);
      assert.ok(!r.text.includes(VALUE));
    }
    const before = calls.length;
    assert.equal((await put('/v1/tenants/' + A + '/secrets/connector-x', JSON.stringify({ value: VALUE, extra: 1 }))).status, 422);
    assert.equal((await put('/v1/tenants/' + A + '/secrets/connector-x', JSON.stringify({ value: 5 }))).status, 422);
    assert.equal((await put('/v1/tenants/' + A + '/secrets/connector-x', VALUE, 'text/plain')).status, 415);
    assert.equal(calls.length, before, 'a malformed body never reaches the library');
    assert.equal((await fetch(origin + '/v1/tenants/' + A + '/secrets/connector-x')).status, 405);
    assert.ok(!logs.join('\n').includes(VALUE));
  });

  it('SE_OPENAPI: the operator description names the write-only resource and no read', function () {
    const path = require('../lib/tenant-registry/openapi.json').paths['/v1/tenants/{id}/secrets/{ref}'];
    assert.deepEqual(Object.keys(path), ['put']);
    assert.deepEqual(Object.keys(path.put.responses['201'].content['application/json'].schema.properties), ['id', 'ref', 'outcome']);
  });
});
