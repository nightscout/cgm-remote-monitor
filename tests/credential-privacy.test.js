'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const util = require('node:util');
const privacy = require('../lib/server/log-privacy');
const credentialCache = require('../lib/middleware/credential-cache');
const {productionErrorHandler} = require('../lib/server/error-handler');

const token = 'fixture-token/a+b&c';
const secret = 'fixture-secret-hash';

describe('credential-safe diagnostic logging', function () {
  it('omits queries, fragments and URL userinfo while preserving the resource path', function () {
    assert.equal(privacy.urlForLog('https://user:password@example.test/path?token=x#private'), 'https://example.test/path');
    assert.equal(privacy.urlForLog('/api/v1/entries?%74oken=a&token=b&secret=c'), '/api/v1/entries');
    assert.equal(privacy.urlForLog('//user:password@example.test/path?secret=x'), '/path');
    assert.equal(privacy.urlForLog('https://[invalid?secret=x'), '[invalid URL]');
    assert.equal(privacy.urlForLog('data:text/html,private-data'), 'data:');
    assert.equal(privacy.urlForLog('/api/v2/authorization/request/private-token'), '/api/v2/authorization/request/[REDACTED]');
  });

  it('redacts repeated, encoded and cached credentials without mutating the request or error', function () {
    const req = {query: {token: [token, 'second-token'], secret},
      headers: {'api-secret': secret, authorization: 'Bearer fixture-jwt'}, auth_token: 'cached-jwt'};
    const message = 'Failure ' + token + ' ' + encodeURIComponent(token) + ' ' + secret +
      ' second-token fixture-jwt cached-jwt https://user:pass@example.test/path?other=private-data';
    const error = new Error(message);
    error.code = 'E_STORAGE';
    error.body = 'body is not diagnostic metadata';
    error.config = {headers: {Authorization: 'do-not-log'}};
    const result = privacy.errorForLog(error, req);
    const logged = util.inspect(result);
    for (const value of [token, encodeURIComponent(token), secret, 'second-token', 'fixture-jwt', 'cached-jwt',
      'private-data', 'user:pass', error.body, 'do-not-log']) assert.ok(!logged.includes(value), value);
    assert.equal(result.code, 'E_STORAGE');
    assert.equal(result.message, '[REDACTED]');
    assert.ok(result.stack.includes('credential-privacy.test.js'));
    assert.equal(error.message, message);
    assert.deepEqual(req.query, {token: [token, 'second-token'], secret});
  });

  it('handles malformed Unicode and empty bearer values without breaking error handling', function () {
    const error = new Error('failure \ud800');
    const result = privacy.errorForLog(error, {query: {secret: '\ud800'}, headers: {authorization: 'Bearer '}});
    assert.equal(result.message, '[REDACTED]');
  });

  it('bounds oversized error details without logging a credential prefix', function () {
    const error = new Error('x'.repeat(8190) + token);
    const result = privacy.errorForLog(error, {query: {token}});
    assert.equal(result.message, '[oversized diagnostic omitted]');
    assert.equal(result.stack, '[oversized diagnostic omitted]');
  });

  it('redacts the legacy token-in-path flow in error details as well as the URL', function () {
    const result = privacy.errorForLog(new Error('Bad token ' + token), {
      originalUrl: '/api/v2/authorization/request/' + encodeURIComponent(token)
    });
    assert.equal(result.message, '[REDACTED]');
    assert.ok(!JSON.stringify(result).includes(token));
  });

  it('does not let a punctuation credential defeat URL redaction', function () {
    const result = privacy.errorForLog(new Error('https://user:private-password@example.test/?value=private'), {
      query: {secret: '/'}, headers: {}
    });
    assert.equal(result.message, '[REDACTED]');
    assert.ok(!JSON.stringify(result).includes('private-password'));
  });

  it('drops URL queries embedded in error messages even without a request credential', function () {
    const result = privacy.errorForLog(new Error('GET /path?secret=unknown failed; https://example.test/?token=other#fragment /nested?token=nested-private&next=https://example.test/ mongodb+srv://user:db-password@db.test/private'), {});
    assert.ok(!result.message.includes('unknown'));
    assert.ok(!result.message.includes('other'));
    assert.ok(!result.message.includes('fragment'));
    assert.ok(!result.message.includes('nested-private'));
    assert.ok(!result.message.includes('db-password'));
  });

  it('uses redaction in the default production logger on a real failing GET request', async function () {
    const app = express();
    app.get('/credential-privacy-error', function (req, res, next) {
      const error = new Error('Failed for ' + req.query.token + ' at ' + req.originalUrl);
      error.body = {secret: 'body-private-data'};
      next(error);
    });
    app.use(productionErrorHandler({log: true}));
    const log = console.error;
    const lines = [];
    console.error = function (...args) {
      if (args[0] === 'Unhandled error on' && String(args[2]).startsWith('/credential-privacy-error')) {
        lines.push(util.format(...args));
      } else log(...args);
    };
    try {
      await request(app).get('/credential-privacy-error').query({token, secret}).set('Accept', 'application/json').expect(500);
    } finally { console.error = log; }
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('/credential-privacy-error'));
    for (const value of [token, encodeURIComponent(token), secret, 'body-private-data']) assert.ok(!lines[0].includes(value));
  });

  it('logs only selected CSP diagnostics and leaves the submitted report unchanged', function () {
    const body = {'csp-report': {
      'document-uri': 'https://user:pass@example.test/?token=' + token,
      'blocked-uri': 'https://cdn.test/image?secret=' + secret,
      'source-file': 'https://example.test/app.js?token=' + token,
      referrer: 'https://example.test/?token=' + token,
      'violated-directive': 'img-src https://cdn.test/?secret=' + secret,
      'effective-directive': 'img-src', 'line-number': 12, 'column-number': 3, 'status-code': 200,
      'original-policy': 'policy containing ' + secret, 'script-sample': token, unexpected: {token}
    }};
    const before = JSON.stringify(body);
    assert.deepEqual(privacy.cspReportForLog(body), {
      'document-uri': 'https://example.test/', 'blocked-uri': 'https://cdn.test/image',
      'source-file': 'https://example.test/app.js', referrer: 'https://example.test/',
      'violated-directive': 'img-src', 'effective-directive': 'img-src',
      'line-number': 12, 'column-number': 3, 'status-code': 200
    });
    assert.equal(JSON.stringify(body), before);
    for (const invalid of [null, {}, {'csp-report': []}, {'csp-report': 'private-data'}]) {
      assert.deepEqual(privacy.cspReportForLog(invalid), {});
    }
  });
});

describe('credential-bearing response caching', function () {
  let app;
  before(function () {
    app = express();
    app.use(credentialCache);
    app.get('/api/v2/authorization/request/:accessToken', (req, res) => res.json({ok: true}));
    app.get('/echo', (req, res) => res.json({query: req.query, url: req.originalUrl}));
    app.get('/failure', (req, res) => res.sendStatus(401));
  });

  for (const name of ['token', 'secret']) {
    it('keeps repeated GET ' + name + ' values intact and prevents caching', async function () {
      const query = name === 'token' ? '%74oken=first&token=second' : 'secret=first&secret=second';
      const res = await request(app).get('/echo?' + query).expect(200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(res.body.query[name], ['first', 'second']);
      assert.equal(res.body.url, '/echo?' + query);
    });
  }
  for (const name of ['api-secret', 'Authorization']) {
    it('prevents caching for ' + name + ' header requests', async function () {
      const res = await request(app).get('/echo').set(name, 'fixture-credential').expect(200);
      assert.equal(res.headers['cache-control'], 'no-store');
    });
  }
  it('prevents caching a refused credential-bearing request', async function () {
    const res = await request(app).get('/failure?secret=invalid').expect(401);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
  it('protects the legacy token-in-path authorization endpoint', async function () {
    const res = await request(app).get('/api/v2/authorization/request/fixture-token').expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
  it('leaves cache policy alone for anonymous requests', async function () {
    const res = await request(app).get('/echo').expect(200);
    assert.equal(res.headers['cache-control'], undefined);
  });
});
