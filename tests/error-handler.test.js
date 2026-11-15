'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

const finalErrorHandler = require('../lib/server/error-handler');

const KNOWN_KEY = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
const REPO_ROOT = path.resolve(__dirname, '..');

// Nothing in an error response may name a stack frame or a file on the server.
function shouldNotLeak (text) {
  text.should.be.a.String();
  text.should.not.match(/\bstack\b/i);
  text.should.not.containEql('node_modules');
  text.should.not.containEql(REPO_ROOT);
  text.should.not.match(/\bat [^\s]+ \(/); // "at fn (file:line:col)"
  text.should.not.match(/(^|[\s"'(>])\/(home|usr|opt|app|srv|var|tmp)\//);
}

function shouldBeErrorJson (res, status) {
  res.headers['content-type'].should.match(/application\/json/);
  res.body.should.have.property('error');
  res.body.error.status.should.equal(status);
  res.body.error.message.should.be.a.String();
  should.not.exist(res.body.error.stack);
  Object.keys(res.body).should.eql(['error']);
  Object.keys(res.body.error).sort().should.eql(['message', 'status']);
}

describe('final error handler (BF-73)', function () {
  this.timeout(20000);

  describe('full app, NODE_ENV not development', function () {
    const self = this;

    before(function (done) {
      process.env.NODE_ENV.should.not.equal('development');
      delete process.env.API_SECRET;
      process.env.API_SECRET = 'this is my long pass phrase';
      const env = require('../lib/server/env')();
      env.settings.authDefaultRoles = 'denied';
      // Other suites change INSECURE_USE_HTTP in process.env; answer over
      // plain http here rather than redirecting to https.
      env.insecureUseHttp = true;
      require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
        self.ctx = ctx;
        self.app = require('../lib/server/app')(env, ctx);
        done();
      });
    });

    afterEach(function () {
      if (self.restoreRemove) {
        self.restoreRemove();
        self.restoreRemove = null;
      }
    });

    it('answers a malformed JSON body with 400 and no stack, as JSON', async function () {
      const res = await request(self.app)
        .post('/api/v1/treatments')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send('{"eventType": ')
        .expect(400);
      shouldBeErrorJson(res, 400);
      res.body.error.message.should.match(/JSON/);
      shouldNotLeak(res.text);
    });

    it('answers a malformed JSON body with 400 and no stack, as HTML', async function () {
      const res = await request(self.app)
        .post('/api/v1/treatments')
        .set('Accept', 'text/html')
        .set('Content-Type', 'application/json')
        .send('{"eventType": ')
        .expect(400);
      res.headers['content-type'].should.match(/text\/html/);
      shouldNotLeak(res.text);
    });

    it('answers a malformed JSON body with 400 and no stack, as text', async function () {
      const res = await request(self.app)
        .post('/api/v1/treatments')
        .set('Accept', 'text/plain')
        .set('Content-Type', 'application/json')
        .send('{"eventType": ')
        .expect(400);
      res.headers['content-type'].should.match(/text\/plain/);
      shouldNotLeak(res.text);
    });

    it('answers a storage fault with a generic 500, hiding the message and stack', async function () {
      const treatments = self.ctx.treatments;
      const original = treatments.remove;
      self.restoreRemove = function () { treatments.remove = original; };
      treatments.remove = function (query, fn) {
        const err = new Error('driver failure at ' + path.join(REPO_ROOT, 'lib', 'server', 'treatments.js'));
        fn(err);
      };

      const json = await request(self.app)
        .delete('/api/v1/treatments?find[eventType]=bf73-none')
        .set('api-secret', KNOWN_KEY)
        .set('Accept', 'application/json')
        .expect(500);
      shouldBeErrorJson(json, 500);
      json.body.error.message.should.equal('Internal Server Error');
      shouldNotLeak(json.text);

      const html = await request(self.app)
        .delete('/api/v1/treatments?find[eventType]=bf73-none')
        .set('api-secret', KNOWN_KEY)
        .set('Accept', 'text/html')
        .expect(500);
      html.text.should.not.containEql('driver failure');
      shouldNotLeak(html.text);
    });
  });

  describe('handler unit behaviour', function () {
    function appWith (handler, err) {
      const app = express();
      app.get('/boom', function (req, res, next) { next(err); });
      app.use(handler);
      return app;
    }

    it('keeps an exposed 4xx message and status', async function () {
      const err = new Error('request entity too large');
      err.status = 413;
      err.expose = true;
      const res = await request(appWith(finalErrorHandler.productionErrorHandler({ log: false }), err))
        .get('/boom').set('Accept', 'application/json').expect(413);
      res.body.should.eql({ error: { message: 'request entity too large', status: 413 } });
    });

    it('uses the reason phrase for a 4xx that is not marked safe to show', async function () {
      const err = new Error('secret detail ' + __filename);
      err.statusCode = 404;
      const res = await request(appWith(finalErrorHandler.productionErrorHandler({ log: false }), err))
        .get('/boom').set('Accept', 'application/json').expect(404);
      res.body.should.eql({ error: { message: 'Not Found', status: 404 } });
    });

    it('never shows a 5xx message, even one marked safe', async function () {
      const err = new Error('secret detail ' + __filename);
      err.status = 503;
      err.expose = true;
      const res = await request(appWith(finalErrorHandler.productionErrorHandler({ log: false }), err))
        .get('/boom').set('Accept', 'text/plain').expect(503);
      res.text.should.equal('503 Service Unavailable\n');
    });

    it('defaults to 500 for a non-error value or an out-of-range status', async function () {
      const res = await request(appWith(finalErrorHandler.productionErrorHandler({ log: false }), { status: 302 }))
        .get('/boom').set('Accept', 'application/json').expect(500);
      res.body.should.eql({ error: { message: 'Internal Server Error', status: 500 } });
    });

    it('escapes the message in HTML', async function () {
      const err = new Error('<script>x</script>');
      err.status = 400;
      err.expose = true;
      const res = await request(appWith(finalErrorHandler.productionErrorHandler({ log: false }), err))
        .get('/boom').set('Accept', 'text/html').expect(400);
      res.text.should.not.containEql('<script>');
      res.text.should.containEql('&lt;script&gt;');
    });

    it('logs the full error server-side', async function () {
      const logged = [];
      const err = new Error('logged detail');
      await request(appWith(finalErrorHandler.productionErrorHandler({
        log: function (e) { logged.push(e); }
      }), err)).get('/boom').expect(500);
      logged.should.eql([err]);
    });

    it('hands off to express when the response has already started', function () {
      const err = new Error('late');
      let passed;
      const res = { headersSent: true };
      finalErrorHandler.productionErrorHandler({ log: false })(err, {}, res, function (e) { passed = e; });
      passed.should.equal(err);
    });

    it('keeps express errorhandler, with the stack, when NODE_ENV=development', async function () {
      const saved = process.env.NODE_ENV;
      let handler;
      try {
        process.env.NODE_ENV = 'development';
        handler = finalErrorHandler();
      } finally {
        process.env.NODE_ENV = saved;
      }
      const err = new Error('dev detail');
      const res = await request(appWith(handler, err))
        .get('/boom').set('Accept', 'application/json').expect(500);
      res.body.error.message.should.equal('dev detail');
      res.body.error.stack.should.containEql(__filename);
    });

    it('uses the production handler when NODE_ENV is unset', async function () {
      const saved = process.env.NODE_ENV;
      let handler;
      try {
        delete process.env.NODE_ENV;
        handler = finalErrorHandler({ log: false });
      } finally {
        process.env.NODE_ENV = saved;
      }
      const res = await request(appWith(handler, new Error('unset detail')))
        .get('/boom').set('Accept', 'application/json').expect(500);
      res.body.should.eql({ error: { message: 'Internal Server Error', status: 500 } });
    });
  });
});
