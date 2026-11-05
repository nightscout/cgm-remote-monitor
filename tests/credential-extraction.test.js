'use strict';

const assert = require('node:assert/strict');
const extract = require('../lib/authorization/credential-extraction');

describe('Tenant version-aware credential extraction', function () {
  function request (headers = {}, query = {}, body) {
    return { rawHeaders: Object.entries(headers).flat(), header: key => headers[key.toLowerCase()], query, body };
  }

  it('retains legacy bearer/query/body precedence and consumes only selected body credentials', function () {
    const body = [{ token: 'body-token', secret: 'body-secret', extension: { retained: true } }];
    const req = request({ authorization: 'Bearer jwt', 'api-secret': 'header-secret' }, { token: 'query-token', secret: 'query-secret' }, body);
    assert.deepEqual(extract(req, { version: 1 }), { token: 'jwt', apiSecret: 'query-secret', presented: true, invalid: false });
    assert.equal(body[0].token, 'body-token');
    assert.equal(body[0].secret, 'body-secret');
    assert.deepEqual(extract(request({}, {}, body), { version: 2 }),
      { token: 'body-token', apiSecret: 'body-secret', presented: true, invalid: false });
    assert.deepEqual(body, [{ extension: { retained: true } }]);
  });

  it('does not consume later array credentials or invent an anonymous fallback', function () {
    const req = request({}, {}, [{ value: 1 }, { token: 'not-first' }]);
    assert.equal(extract(req, { version: 1 }).presented, false);
    for (const token of ['', [], {}, ['a', 'b']]) {
      assert.equal(extract(request({}, { token }), { version: 1 }).invalid, true);
    }
    assert.equal(extract(request({ authorization: 'bearer token' }), { version: 1 }).invalid, true);
    assert.equal(extract(request({ authorization: 'bearer token' }), { version: 3 }).invalid, false);
  });

  it('refuses duplicate headers and legacy carriers on API3', function () {
    const req = request({ authorization: 'Bearer one' });
    req.rawHeaders.push('Authorization', 'Bearer two');
    assert.equal(extract(req, { version: 3 }).invalid, true);
    assert.equal(extract(request({}, { token: 'legacy' }), { version: 3 }).invalid, true);
    assert.equal(extract(request({}, {}, { secret: 'legacy' }), { version: 3 }).invalid, true);
    assert.equal(extract(request({ 'api-secret': 'root' }), { version: 3 }).apiSecret, 'root');
  });
});
