'use strict';

// Request-body size policy. Entries, treatments and device status share one
// JSON limit, UPLOAD_BODY_LIMIT (default 50mb). Synthetic data only.

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();
// Loaded lazily so the behavioural cases also run against a tree without it.
const bodyLimits = (env) => require('../lib/middleware/body-limits')(env);

const known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
const KB = 1024;

// An array of synthetic device-status-shaped documents whose JSON is about
// `bytes` long.
function payload (bytes, base) {
  const docs = [];
  const each = 16 * KB;
  const count = Math.max(1, Math.round(bytes / each));
  for (let i = 0; i < count; i++) {
    docs.push(Object.assign({
      device: 'synthetic://body-limit'
      , created_at: new Date(Date.UTC(2019, 0, 1, 0, 0, i)).toISOString()
      , padding: 'x'.repeat(each - 200)
    }, base));
  }
  return docs;
}

const DATA_ROUTES = [
  ['/api/v1/devicestatus/', {}]
  , ['/api/v1/entries/', { type: 'sgv', sgv: 100 }]
  , ['/api/v1/treatments/', { eventType: 'Note' }]
];

function post (app, path, body) {
  return request(app).post(path).set('api-secret', known).send(body);
}

describe('Request body limits', function () {
  this.timeout(60000);
  const self = {};
  const api = require('../lib/api/');

  function buildApp (limit) {
    const env = Object.assign(Object.create(Object.getPrototypeOf(self.env)), self.env, { uploadBodyLimit: limit });
    const app = require('express')();
    require('../lib/middleware/configure-request')(app);
    app.enable('api');
    const saved = self.ctx.wares;
    self.ctx.wares = require('../lib/middleware/')(env);
    try {
      app.use('/api/v1', api(env, self.ctx));
    } finally {
      self.ctx.wares = saved;
    }
    return app;
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      done();
    });
  });

  describe('the setting', function () {
    it('defaults to 50mb', function () {
      bodyLimits({}).upload.should.equal(50 * 1024 * 1024);
    });
    it('reads env.uploadBodyLimit in the body-parser byte format', function () {
      bodyLimits({ uploadBodyLimit: '256kb' }).upload.should.equal(256 * KB);
      bodyLimits({ uploadBodyLimit: '2MB' }).upload.should.equal(2 * 1024 * 1024);
      bodyLimits({ uploadBodyLimit: '1048576' }).upload.should.equal(1048576);
    });
    it('falls back to the default for a value it cannot read, never to no limit', function () {
      for (const bad of ['', 'lots', '-1mb', '0', 'Infinity', '10tb']) {
        bodyLimits({ uploadBodyLimit: bad }).upload.should.equal(50 * 1024 * 1024, bad);
      }
    });
    it('falls back to the process environment for an env built without it (multitenant)', function () {
      const saved = process.env.UPLOAD_BODY_LIMIT;
      process.env.UPLOAD_BODY_LIMIT = '3mb';
      try {
        bodyLimits({}).upload.should.equal(3 * 1024 * 1024);
        bodyLimits({ uploadBodyLimit: '1mb' }).upload.should.equal(1024 * 1024);
      } finally {
        if (saved === undefined) delete process.env.UPLOAD_BODY_LIMIT; else process.env.UPLOAD_BODY_LIMIT = saved;
      }
    });
  });

  describe('with the default limit', function () {
    before(function () { self.app = buildApp(undefined); });

    DATA_ROUTES.forEach(function ([path, base]) {
      it('admits a 2 MB body on ' + path, async function () {
        const res = await post(self.app, path, payload(2048 * KB, base));
        res.status.should.not.equal(413, path + ' refused a 2 MB body for size');
      });
    });

    it('stores a 2 MB device-status batch', async function () {
      const res = await post(self.app, '/api/v1/devicestatus/', payload(2048 * KB, {}));
      res.status.should.equal(200);
    });
  });

  describe('with UPLOAD_BODY_LIMIT=256kb', function () {
    before(function () { self.app = buildApp('256kb'); });

    DATA_ROUTES.forEach(function ([path, base]) {
      it('admits 160 KB and refuses 512 KB with 413 on ' + path, async function () {
        const small = await post(self.app, path, payload(160 * KB, base));
        small.status.should.not.equal(413, path + ' refused 160 KB under a 256 KB limit');
        const large = await post(self.app, path, payload(512 * KB, base));
        large.status.should.equal(413, path + ' admitted 512 KB over a 256 KB limit');
      });
    });
  });

  after(function () {
    should.exist(self.ctx);
  });
});
