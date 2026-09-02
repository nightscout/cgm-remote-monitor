'use strict';

const request = require('supertest');
const should = require('should');

const createApp = require('../lib/server/app');

function securityApp (options) {
  options = options || {};

  const settings = require('../lib/settings')();
  Object.assign(settings, options.settings);

  const env = {
    name: 'security-header-test'
    , version: '1.0.0'
    , insecureUseHttp: false
    , secureHstsHeader: options.secureHstsHeader !== undefined
      ? options.secureHstsHeader
      : true
    , secureHstsHeaderIncludeSubdomains: false
    , secureHstsHeaderPreload: false
    , secureCsp: options.secureCsp || false
    , secureCspReportOnly: options.secureCspReportOnly || false
    , settings: settings
    , static_files: '/static'
  };

  // A boot error returns before APIs and storage are initialized, while retaining
  // the security middleware and simple routes needed for these focused tests.
  return createApp(env, { bootErrors: [{ desc: 'test', err: 'test' }] });
}

function getRobots (app) {
  return request(app)
    .get('/robots.txt')
    .set('x-forwarded-proto', 'https')
    .expect(200);
}

describe('server security headers', function () {
  it('denies cross-origin framing when CSP is disabled', async function () {
    const res = await getRobots(securityApp());

    res.headers['x-frame-options'].should.equal('SAMEORIGIN');
    should.not.exist(res.headers['content-security-policy']);
    should.not.exist(res.headers['content-security-policy-report-only']);
  });

  it('keeps frame protection when HSTS is disabled', async function () {
    const res = await getRobots(securityApp({ secureHstsHeader: false }));

    res.headers['x-frame-options'].should.equal('SAMEORIGIN');
    should.not.exist(res.headers['strict-transport-security']);
  });

  it('keeps frame protection when enforcing the configured CSP', async function () {
    const res = await getRobots(securityApp({
      secureCsp: true
      , settings: {
        frameUrl1: 'https://one.example'
        , frameUrl2: 'https://two.example'
      }
    }));

    res.headers['x-frame-options'].should.equal('SAMEORIGIN');
    res.headers['content-security-policy'].should.containEql(
      "frame-ancestors 'self' https://one.example https://two.example"
    );
    should.not.exist(res.headers['content-security-policy-report-only']);
  });

  it('keeps frame protection while CSP is report-only', async function () {
    const res = await getRobots(securityApp({
      secureCsp: true
      , secureCspReportOnly: true
    }));

    res.headers['x-frame-options'].should.equal('SAMEORIGIN');
    should.not.exist(res.headers['content-security-policy']);
    res.headers['content-security-policy-report-only'].should.containEql(
      "frame-ancestors 'self'"
    );
  });
});
