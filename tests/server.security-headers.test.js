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
    , trustProxy: '127.0.0.1,::1'
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
  for (const options of [
    {}, {secureHstsHeader: false}, {insecureUseHttp: true},
    {secureCsp: true}, {secureCsp: true, secureCspReportOnly: true}
  ]) {
    it('sets no-referrer independently of CSP and TLS configuration ' + JSON.stringify(options), async function () {
      const res = await getRobots(securityApp(options));
      res.headers['referrer-policy'].should.equal('no-referrer');
    });
  }

  it('protects HTTPS redirects before other middleware runs', async function () {
    const res = await request(securityApp()).get('/robots.txt?token=fixture-redirect-token').expect(307);
    res.headers['referrer-policy'].should.equal('no-referrer');
    res.headers['cache-control'].should.equal('no-store');
    res.headers.location.should.containEql('token=fixture-redirect-token');
  });

  it('keeps public static caching but prevents caching credential-bearing static requests', async function () {
    const app = securityApp({insecureUseHttp: true});
    const anonymous = await request(app).get('/css/sgv.css').expect(200);
    anonymous.headers['cache-control'].should.containEql('public, max-age=');
    const credential = await request(app).get('/css/sgv.css?token=fixture-static-token').expect(200);
    credential.headers['cache-control'].should.equal('no-store');
  });

  it('redacts credential URLs in real CSP reports without logging arbitrary report fields', async function () {
    const app = securityApp({insecureUseHttp: true, secureCsp: true});
    const log = console.log;
    const captured = [];
    console.log = function (...args) {
      if (args[0] === 'CSP Violation: ') captured.push(args);
      else log(...args);
    };
    try {
      await request(app).post('/report-violation?token=fixture-report-token')
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify({'csp-report': {
          'document-uri': 'https://example.test/?token=fixture-report-token',
          'blocked-uri': 'https://cdn.test/image?secret=fixture-report-secret',
          'violated-directive': 'img-src', 'line-number': 8,
          'script-sample': 'fixture-report-token', unexpected: 'fixture-report-secret'
        }})).expect(204).expect('Cache-Control', 'no-store');
    } finally { console.log = log; }
    captured.length.should.equal(1);
    captured[0][1].should.eql({
      'document-uri': 'https://example.test/', 'blocked-uri': 'https://cdn.test/image',
      'violated-directive': 'img-src', 'line-number': 8
    });
    JSON.stringify(captured).should.not.containEql('fixture-report-token');
    JSON.stringify(captured).should.not.containEql('fixture-report-secret');
  });

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
  for (const insecureUseHttp of [false, true]) {
    for (const secureHstsHeader of [false, true]) {
      for (const allowUnrestrictedFrameEmbedding of [false, true]) {
        for (const cspMode of ['off', 'enforced', 'report-only']) {
          it(`keeps explicit policies for HTTP=${insecureUseHttp}, HSTS=${secureHstsHeader}, embedding=${allowUnrestrictedFrameEmbedding}, CSP=${cspMode}`, async function () {
            for (let cycle = 0; cycle < 2; cycle++) {
              const app = securityApp({insecureUseHttp, secureHstsHeader, allowUnrestrictedFrameEmbedding,
                secureCsp: cspMode !== 'off', secureCspReportOnly: cspMode === 'report-only'});
              const res = await (insecureUseHttp ? getRobotsOverHttp(app) : getRobots(app));
              for (const name of ['cross-origin-embedder-policy', 'cross-origin-opener-policy',
                'cross-origin-resource-policy', 'origin-agent-cluster']) should.not.exist(res.headers[name]);
              for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
                const value = res.headers[name] || '';
                value.should.not.containEql('upgrade-insecure-requests');
                value.should.not.containEql('script-src-attr');
              }
              const hstsBundleEnabled = !insecureUseHttp && secureHstsHeader;
              const retainedHeaders = {
                'x-content-type-options': 'nosniff', 'x-dns-prefetch-control': 'off',
                'x-download-options': 'noopen', 'x-permitted-cross-domain-policies': 'none',
                'x-xss-protection': '0'
              };
              for (const [name, value] of Object.entries(retainedHeaders)) {
                if (hstsBundleEnabled) res.headers[name].should.equal(value);
                else should.not.exist(res.headers[name]);
              }
              if (hstsBundleEnabled) should.not.exist(res.headers['x-powered-by']);
              // EXPECTATION CHANGED at the cut 5 merge: this branch sent
              // Referrer-Policy only with the HSTS bundle or CSP. dev sends it on
              // every response, independently of CSP and TLS settings (see the
              // 'sets no-referrer independently' test above), and dev's
              // behaviour is kept.
              res.headers['referrer-policy'].should.equal('no-referrer');
              if (insecureUseHttp || !secureHstsHeader) should.not.exist(res.headers['strict-transport-security']);
              else res.headers['strict-transport-security'].should.equal('max-age=31536000');
              if (allowUnrestrictedFrameEmbedding) should.not.exist(res.headers['x-frame-options']);
              else res.headers['x-frame-options'].should.equal('SAMEORIGIN');
              if (cspMode === 'enforced') res.headers['content-security-policy'].should.containEql("script-src 'self' 'unsafe-inline'");
              if (cspMode === 'report-only') res.headers['content-security-policy-report-only'].should.containEql("script-src 'self' 'unsafe-inline'");
            }
          });
        }
      }
    }
  }

});
