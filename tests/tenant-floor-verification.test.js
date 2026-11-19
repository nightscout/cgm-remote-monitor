'use strict';
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const route = require('../lib/server/serve/platform-verification-admin').api;
const tenant = '11111111-1111-4111-8111-111111111111';
async function call ({ method = 'POST', body = '{}', service, admitted = () => true } = {}) {
  const req = Readable.from([Buffer.from(body)]); req.method = method; req.url = '/v1/platform-verification/tenants/' + tenant; req.headers = { 'content-type': 'application/json' };
  const result = {}, res = { writeHead (status, headers) { result.status = status; result.headers = headers; }, end (bytes) { result.body = JSON.parse(bytes); } };
  await route({ service, admitted, fallback: () => assert.fail('Known private tenant endpoint') })(req, res);
  return result;
}
describe('private admin tenant floor operation', function () {
  it('verifies exactly the addressed tenant with a bounded empty body', async function () {
    const calls = [], service = { async verifyTenant (id) { calls.push(id); return { status: 'verified' }; } };
    assert.equal((await call({ service })).status, 200); assert.deepEqual(calls, [tenant]);
    for (const [body, status] of [['{', 400], ['{"skip":true}', 422], [' '.repeat(129), 413]]) assert.equal((await call({ service, body })).status, status);
    assert.deepEqual(calls, [tenant]);
    assert.equal((await call({ service, method: 'GET' })).status, 405);
    assert.equal((await call({ service, admitted: () => false })).status, 503);
  });
  it('reports fixed floor failures without driver detail or caller data', async function () {
    const result = await call({ service: { async verifyTenant () { throw Object.assign(new Error('private detail'), { code: 'TENANT_FLOOR_VERIFICATION_FAILED' }); } } });
    assert.equal(result.status, 503); assert.deepEqual(result.body, { error: 'TENANT_FLOOR_VERIFICATION_FAILED' });
    assert(!JSON.stringify(result).includes('private detail'));
  });
});
