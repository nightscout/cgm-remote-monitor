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
    , insecureUseHttp: options.insecureUseHttp !== undefined
      ? options.insecureUseHttp
      : false
    , secureHstsHeader: options.secureHstsHeader !== undefined
      ? options.secureHstsHeader
      : true
    , secureHstsHeaderIncludeSubdomains: false
    , secureHstsHeaderPreload: false
    , secureCsp: options.secureCsp || false
    , secureCspReportOnly: options.secureCspReportOnly || false
    , allowUnrestrictedFrameEmbedding: options.allowUnrestrictedFrameEmbedding !== undefined
      ? options.allowUnrestrictedFrameEmbedding
      : true
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

function getRobotsOverHttp (app) {
  return request(app)
    .get('/robots.txt')
    .expect(200);
}

function shouldHaveSameOriginFrameProtection (res) {
  res.headers['x-frame-options'].should.equal('SAMEORIGIN');
  res.headers['content-security-policy'].should.containEql("frame-ancestors 'self'");
}

describe('server security headers', function () {
  it('preserves unrestricted cross-origin embedding by default', async function () {
    const res = await getRobots(securityApp());

    should.not.exist(res.headers['x-frame-options']);
    should.not.exist(res.headers['content-security-policy']);
    should.not.exist(res.headers['content-security-policy-report-only']);
    res.headers['strict-transport-security'].should.containEql('max-age=31536000');
  });

  it('enforces same-origin framing when unrestricted embedding is disabled', async function () {
    const res = await getRobots(securityApp({
      allowUnrestrictedFrameEmbedding: false
    }));

    shouldHaveSameOriginFrameProtection(res);
    res.headers['content-security-policy'].should.equal("frame-ancestors 'self'");
    should.not.exist(res.headers['content-security-policy-report-only']);
  });

  it('keeps frame protection when HSTS is disabled', async function () {
    const res = await getRobots(securityApp({
      allowUnrestrictedFrameEmbedding: false
      , secureHstsHeader: false
    }));

    shouldHaveSameOriginFrameProtection(res);
    res.headers['content-security-policy'].should.equal("frame-ancestors 'self'");
    should.not.exist(res.headers['strict-transport-security']);
  });

  it('keeps frame protection while insecure HTTP is allowed', async function () {
    const res = await getRobotsOverHttp(securityApp({
      allowUnrestrictedFrameEmbedding: false
      , insecureUseHttp: true
    }));

    shouldHaveSameOriginFrameProtection(res);
    res.headers['content-security-policy'].should.equal("frame-ancestors 'self'");
    should.not.exist(res.headers['strict-transport-security']);
  });

  it('keeps unrestricted embedding while insecure HTTP is allowed', async function () {
    const res = await getRobotsOverHttp(securityApp({ insecureUseHttp: true }));

    should.not.exist(res.headers['x-frame-options']);
    should.not.exist(res.headers['content-security-policy']);
    should.not.exist(res.headers['content-security-policy-report-only']);
    should.not.exist(res.headers['strict-transport-security']);
  });

  it('allows configured split-view origins under an enforced CSP', async function () {
    const res = await getRobots(securityApp({
      secureCsp: true
      , settings: {
        frameUrl1: 'https://one.example/clock?token=secret'
        , frameUrl2: 'https://two.example:8443/view#clock'
        , frameUrl3: 'https://one.example/another-view'
        , frameUrl4: '/clock/color'
        , frameUrl5: 'javascript:alert(1)'
        , frameUrl6: 'https://good.example;frame-src *'
        , frameUrl7: 'https://good.example@evil.example/clock'
        , frameUrl8: 'https://good.example,https://evil.example'
      }
    }));

    should.not.exist(res.headers['x-frame-options']);
    res.headers['content-security-policy'].should.containEql(
      "frame-src 'self' https://one.example https://two.example:8443"
    );
    res.headers['content-security-policy'].should.not.containEql('frame-ancestors');
    res.headers['content-security-policy'].should.not.containEql('token=secret');
    res.headers['content-security-policy'].should.not.containEql('javascript:');
    res.headers['content-security-policy'].should.not.containEql('good.example');
    res.headers['content-security-policy'].should.not.containEql('evil.example');
    res.headers['content-security-policy'].split('https://one.example').length.should.equal(2);
    should.not.exist(res.headers['content-security-policy-report-only']);
  });

  it('adds same-origin protection to an enforced full CSP', async function () {
    const res = await getRobots(securityApp({
      allowUnrestrictedFrameEmbedding: false
      , secureCsp: true
      , settings: {
        frameUrl1: 'https://one.example/clock'
      }
    }));

    shouldHaveSameOriginFrameProtection(res);
    res.headers['content-security-policy'].should.containEql(
      "frame-src 'self' https://one.example"
    );
    should.not.exist(res.headers['content-security-policy-report-only']);
  });

  it('keeps the full CSP report-only while enforcing same-origin framing', async function () {
    const res = await getRobots(securityApp({
      allowUnrestrictedFrameEmbedding: false
      , secureCsp: true
      , secureCspReportOnly: true
      , settings: {
        frameUrl1: 'https://one.example/clock'
      }
    }));

    shouldHaveSameOriginFrameProtection(res);
    res.headers['content-security-policy'].should.equal("frame-ancestors 'self'");
    res.headers['content-security-policy-report-only'].should.containEql(
      "frame-src 'self' https://one.example"
    );
  });

  it('does not report ancestor violations in unrestricted report-only mode', async function () {
    const res = await getRobots(securityApp({
      secureCsp: true
      , secureCspReportOnly: true
      , settings: {
        frameUrl1: 'https://one.example/clock'
      }
    }));

    should.not.exist(res.headers['x-frame-options']);
    should.not.exist(res.headers['content-security-policy']);
    res.headers['content-security-policy-report-only'].should.containEql(
      "frame-src 'self' https://one.example"
    );
    res.headers['content-security-policy-report-only'].should.not.containEql('frame-ancestors');
  });

  it('applies the full CSP independently of HSTS', async function () {
    const res = await getRobots(securityApp({
      secureCsp: true
      , secureHstsHeader: false
      , settings: {
        frameUrl1: 'https://one.example/clock'
      }
    }));

    should.not.exist(res.headers['x-frame-options']);
    res.headers['content-security-policy'].should.containEql(
      "frame-src 'self' https://one.example"
    );
    res.headers['content-security-policy'].should.not.containEql('frame-ancestors');
    should.not.exist(res.headers['strict-transport-security']);
  });
});
