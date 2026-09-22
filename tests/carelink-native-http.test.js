'use strict';

const assert = require('node:assert/strict');
const https = require('node:https');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');
const { request } = require('../lib/connect/sources/carelink/http');
const ConnectError = require('../lib/connect/errors');

describe('native CareLink safe transport diagnostics', function () {
  let original;
  beforeEach(() => { original = https.request; });
  afterEach(() => { https.request = original; });
  function response(status, body) {
    https.request = (url, options, callback) => {
      const req = new EventEmitter();
      req.end = () => {
        const res = new PassThrough(); res.statusCode = status;
        callback(res); res.end(body);
      };
      return req;
    };
  }
  it('retains HTTP status for non-JSON errors without retaining the response body', async function () {
    response(403, '<html>private-response</html>');
    await assert.rejects(request('https://carelink.minimed.eu/patient/users/me', { operation: 'account_details' }), error => {
      assert.equal(error.code, 'provider_unavailable');
      assert.deepEqual(error.diagnostic, { reason: 'invalid_json', httpStatus: 403, operation: 'account_details' });
      assert.ok(!JSON.stringify(error).includes('private-response')); return true;
    });
  });
  it('retains token rejection status without exposing OAuth details', async function () {
    response(400, JSON.stringify({ error: 'invalid_grant', error_description: 'private-auth-code' }));
    await assert.rejects(request('https://carelink-login.minimed.eu/oauth/token', { operation: 'token_exchange' }), error => {
      assert.equal(error.code, 'reconnect_required');
      assert.deepEqual(error.diagnostic, { reason: 'http_error', httpStatus: 400, operation: 'token_exchange' });
      assert.ok(!JSON.stringify(error).includes('private-auth-code')); return true;
    });
  });
  it('distinguishes a transport timeout without exposing socket errors', async function () {
    https.request = () => {
      const req = new EventEmitter();
      req.end = () => req.emit('timeout');
      req.destroy = err => req.emit('error', err);
      return req;
    };
    await assert.rejects(request('https://carelink-login.minimed.eu/oauth/token', { operation: 'token_exchange' }), error => {
      assert.deepEqual(error.diagnostic, { reason: 'timeout', operation: 'token_exchange' }); return true;
    });
  });
  it('drops unknown diagnostic fields and values rather than echoing arbitrary text', function () {
    assert.equal(ConnectError.safeDiagnostic({ reason: 'private-error', operation: 'private-url', httpStatus: 'private-status', token: 'secret' }), undefined);
  });
  it('still returns successful JSON responses unchanged', async function () {
    response(200, '{"ok":true}');
    assert.deepEqual(await request('https://carelink.minimed.eu/public'), { ok: true });
  });
});
