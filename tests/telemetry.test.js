'use strict';

const should = require('should');
const request = require('supertest');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const language = require('../lib/language')();

const allowlists = require('../lib/telemetry/allowlists');
const config = require('../lib/telemetry/config');
const createCounters = require('../lib/telemetry/counters');
const id = require('../lib/telemetry/id');
const payload = require('../lib/telemetry/payload');
const createTelemetry = require('../lib/telemetry');
const routeCounters = require('../lib/telemetry/route-counters');
const schedule = require('../lib/telemetry/schedule');

describe('telemetry', function () {
  function withEnv (values, fn) {
    var keys = Object.keys(values);
    var previous = {};
    keys.forEach(function eachKey (key) {
      previous[key] = process.env[key];
      if (values[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = values[key];
      }
    });
    delete require.cache[require.resolve('../lib/server/env')];
    try {
      return fn();
    } finally {
      keys.forEach(function restoreKey (key) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      });
      delete require.cache[require.resolve('../lib/server/env')];
    }
  }

  function tempStore () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ns-telemetry-test-'));
  }

  it('defaults to disabled config', function () {
    var normalized = config.normalize();
    normalized.mode.should.equal('off');
    normalized.enabled.should.equal(false);
    normalized.preview.should.equal(true);
    normalized.idRotation.should.equal('monthly');
  });

  it('parses telemetry env settings in the Nightscout env module', function () {
    withEnv({
      NIGHTSCOUT_TELEMETRY: 'aggregate',
      NIGHTSCOUT_TELEMETRY_ENDPOINT: 'https://example.invalid/checkin',
      NIGHTSCOUT_TELEMETRY_PREVIEW: 'off',
      NIGHTSCOUT_TELEMETRY_MANUAL_SEND: 'on',
      NIGHTSCOUT_TELEMETRY_SCHEDULED_SEND: 'on',
      NIGHTSCOUT_TELEMETRY_ID_ROTATION: 'monthly',
      NIGHTSCOUT_TELEMETRY_STORE: tempStore(),
      API_SECRET: 'this is my long pass phrase',
      MONGODB_URI: 'mongodb://localhost/nightscout'
    }, function checkEnv () {
      var env = require('../lib/server/env')();
      env.telemetry.mode.should.equal('aggregate');
      env.telemetry.endpoint.should.equal('https://example.invalid/checkin');
      env.telemetry.preview.should.equal(false);
      env.telemetry.manualSend.should.equal(true);
      env.telemetry.scheduledSend.should.equal(true);
      env.telemetry.idRotation.should.equal('monthly');
      env.telemetry.storeDir.should.startWith(os.tmpdir());
      should.not.exist(env.telemetry.secret);
    });
  });

  it('parses an explicit telemetry secret without exposing it in payload', function () {
    withEnv({
      NIGHTSCOUT_TELEMETRY: 'aggregate',
      NIGHTSCOUT_TELEMETRY_SECRET: 'operator-provided-telemetry-secret',
      NIGHTSCOUT_TELEMETRY_STORE: tempStore(),
      API_SECRET: 'this is my long pass phrase',
      MONGODB_URI: 'mongodb://localhost/nightscout'
    }, function checkEnv () {
      var env = require('../lib/server/env')();
      env.telemetry.secret.should.equal('operator-provided-telemetry-secret');
      var telemetry = createTelemetry(env, {});
      var preview = telemetry.preview({ now: new Date('2026-07-16T12:00:00Z') });
      preview.secretSource.should.equal('configured');
      should.not.exist(preview.payload.secret);
      should.not.exist(preview.payload.api_secret);
    });
  });

  it('persists a generated telemetry secret separate from auth material', function () {
    var storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-telemetry-'));
    var env = {
      version: '15.0.8',
      telemetry: {
        mode: 'aggregate',
        storeDir
      },
      settings: { enable: [] }
    };

    var first = createTelemetry(env, {});
    var firstPreview = first.preview({ now: new Date('2026-07-16T12:00:00Z') });
    var second = createTelemetry(env, {});
    var secondPreview = second.preview({ now: new Date('2026-07-16T12:00:00Z') });

    first.secretSource.should.equal('generated');
    second.secretSource.should.equal('generated');
    firstPreview.payload.installation_id.should.equal(secondPreview.payload.installation_id);
    fs.existsSync(path.join(storeDir, 'telemetrySecret')).should.equal(true);
  });

  it('normalizes invalid config to disabled monthly telemetry', function () {
    var normalized = config.normalize({
      mode: 'surprise',
      preview: false,
      idRotation: 'daily'
    });
    normalized.mode.should.equal('off');
    normalized.enabled.should.equal(false);
    normalized.preview.should.equal(false);
    normalized.idRotation.should.equal('monthly');
  });

  it('derives stable monthly installation ids that rotate by month', function () {
    var secret = 'local random secret';
    var julyA = id.monthlyInstallationId(secret, new Date('2026-07-01T00:00:00Z'));
    var julyB = id.monthlyInstallationId(secret, new Date('2026-07-31T23:59:59Z'));
    var august = id.monthlyInstallationId(secret, new Date('2026-08-01T00:00:00Z'));

    julyA.should.equal(julyB);
    julyA.should.not.equal(august);
    julyA.should.startWith('monthly_');
  });

  it('calculates jittered schedule windows without fixed herd times', function () {
    var now = new Date('2026-07-16T12:00:00Z');
    schedule.initialDueAt(now, () => 0).getTime().should.equal(now.getTime() + 5 * schedule.MS.minute);
    schedule.initialDueAt(now, () => 1).getTime().should.equal(now.getTime() + 7 * schedule.MS.day);

    schedule.nextSuccessDueAt(now, () => 0).getTime().should.equal(now.getTime() + 7 * schedule.MS.day);
    schedule.nextSuccessDueAt(now, () => 1).getTime().should.equal(now.getTime() + 8 * schedule.MS.day);

    schedule.nextFailureDueAt(now, () => 0).getTime().should.equal(now.getTime() + 6 * schedule.MS.hour);
    schedule.nextFailureDueAt(now, () => 1).getTime().should.equal(now.getTime() + 24 * schedule.MS.hour);
  });

  it('checks due state only when telemetry is enabled', function () {
    var now = new Date('2026-07-16T12:00:00Z');
    schedule.isDue({}, now, false).should.equal(false);
    schedule.isDue({}, now, true).should.equal(false);
    schedule.isDue({ next_due_at: '2026-07-16T11:00:00.000Z' }, now, true).should.equal(true);
    schedule.isDue({ next_due_at: '2026-07-16T13:00:00.000Z' }, now, true).should.equal(false);
  });

  it('initializes missing schedule state with first-run jitter', function () {
    var now = new Date('2026-07-16T12:00:00Z');
    var initialized = schedule.initializeState({}, now, () => 0);
    initialized.next_due_at.should.equal('2026-07-16T12:05:00.000Z');
    schedule.isDue(initialized, now, true).should.equal(false);
  });

  it('updates next due time after success and failure attempts', function () {
    var now = new Date('2026-07-16T12:00:00Z');
    var success = schedule.afterAttempt({}, now, { sent: true, statusCode: 204 }, () => 0);
    success.last_attempt_at.should.equal('2026-07-16T12:00:00.000Z');
    success.last_success_at.should.equal('2026-07-16T12:00:00.000Z');
    success.last_status.should.equal(204);
    success.next_due_at.should.equal('2026-07-23T12:00:00.000Z');

    var failure = schedule.afterAttempt({}, now, { sent: false, statusCode: 500 }, () => 0);
    failure.last_attempt_at.should.equal('2026-07-16T12:00:00.000Z');
    should.not.exist(failure.last_success_at);
    failure.last_status.should.equal(500);
    failure.next_due_at.should.equal('2026-07-16T18:00:00.000Z');
  });

  it('filters enabled features and rejects unallowlisted counters', function () {
    allowlists.filterFeatures(['careportal', 'token', 'bridge', 'url', 'connect.dexcomshare']).should.eql(['bridge', 'careportal', 'connect.dexcomshare']);
    allowlists.connectFeature('dexcomshare').should.equal('connect.dexcomshare');
    should.not.exist(allowlists.connectFeature('unknownvendor'));
    allowlists.connectCounter('dexcomshare').should.equal('connect.source.dexcomshare.active');
    should.not.exist(allowlists.connectCounter('unknownvendor'));
    allowlists.isAllowedCounter('api.v1.entries.read').should.equal(true);
    allowlists.isAllowedCounter('api.v1.treatments.write').should.equal(false);
    allowlists.isAllowedCounter('plugins.token.active').should.equal(false);
  });

  it('records only allowlisted counters and coarse status classes', function () {
    var counters = createCounters();
    counters.increment('api.v1.entries.read').should.equal(true);
    counters.increment('api.v1.treatments.write').should.equal(false);
    counters.recordStatus(200);
    counters.recordStatus(204);
    counters.recordStatus(404);
    counters.recordStatus(503);
    counters.recordWebsocketConnection();

    var snapshot = counters.snapshot();
    snapshot.used.should.eql({ 'api.v1.entries.read': 1 });
    snapshot.health.http_2xx.should.equal(2);
    snapshot.health.http_4xx.should.equal(1);
    snapshot.health.http_5xx.should.equal(1);
    snapshot.health.websocket_connections.should.equal(1);
  });

  it('persists counters across day boundaries until successful send reset', function () {
    var day = new Date('2026-07-16T12:00:00Z');
    var storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-telemetry-counters-'));
    var env = {
      version: '15.0.8',
      telemetry: {
        mode: 'aggregate',
        storeDir
      },
      settings: { enable: [] }
    };
    var telemetry = createTelemetry(env, {}, {
      dateProvider: function () { return day; }
    });
    telemetry.counters.increment('api.v1.entries.read', 2);
    telemetry.counters.recordStatus(200);

    var reloaded = createTelemetry(env, {}, {
      dateProvider: function () { return day; }
    });
    reloaded.counters.snapshot().used.should.eql({ 'api.v1.entries.read': 2 });
    reloaded.counters.snapshot().health.http_2xx.should.equal(1);

    day = new Date('2026-07-17T00:00:00Z');
    reloaded.counters.increment('reports.opened');
    reloaded.counters.snapshot().used.should.eql({
      'api.v1.entries.read': 2,
      'reports.opened': 1
    });
    reloaded.counters.snapshot().health.http_2xx.should.equal(1);

    reloaded.counters.reset(day);
    reloaded.counters.snapshot().used.should.eql({});
    reloaded.counters.snapshot().health.http_2xx.should.equal(0);
  });

  it('classifies only reviewed route families', function () {
    routeCounters.classify({ method: 'GET', originalUrl: '/api/v1/entries.json?count=10' }).should.equal('api.v1.entries.read');
    routeCounters.classify({ method: 'POST', originalUrl: '/api/v1/entries.json?secret=hidden' }).should.equal('api.v1.entries.write');
    should.not.exist(routeCounters.classify({ method: 'GET', originalUrl: '/api/v1/treatments.json' }));
    routeCounters.classify({ method: 'GET', originalUrl: '/api/v1/profile.json' }).should.equal('api.v1.profile.read');
    should.not.exist(routeCounters.classify({ method: 'POST', originalUrl: '/api/v1/profile.json' }));
    routeCounters.classify({ method: 'GET', originalUrl: '/api/v3/version' }).should.equal('api.v3.version.read');
    routeCounters.classify({ method: 'GET', originalUrl: '/report' }).should.equal('reports.opened');
  });

  it('counts route families and status classes without retaining request metadata', function (done) {
    var telemetry = createTelemetry({
      version: '15.0.8',
      telemetry: { mode: 'aggregate', storeDir: tempStore() },
      settings: { enable: [] }
    }, {});
    var app = express();
    app.use(telemetry.routeCounters());
    app.get('/api/v1/entries.json', function (req, res) {
      res.json({ ok: true });
    });
    app.get('/api/v1/treatments.json', function (req, res) {
      res.json({ ok: true });
    });
    app.get('/fail', function (req, res) {
      res.status(503).json({ ok: false });
    });

    request(app)
      .get('/api/v1/entries.json?find[secret]=hidden')
      .expect(200)
      .end(function (err) {
        if (err) return done(err);
        request(app)
          .get('/api/v1/treatments.json')
          .expect(200)
          .end(function (err) {
            if (err) return done(err);
            request(app)
              .get('/fail?token=hidden')
              .expect(503)
              .end(function (err) {
                if (err) return done(err);
                var snapshot = telemetry.counters.snapshot();
                snapshot.used.should.eql({ 'api.v1.entries.read': 1 });
                snapshot.health.http_2xx.should.equal(2);
                snapshot.health.http_5xx.should.equal(1);
                done();
              });
          });
      });
  });

  it('builds a schema-shaped aggregate payload without prohibited fields', function () {
    var env = {
      version: '15.0.8',
      storageURI: 'mongodb+srv://example.mongodb.net/nightscout',
      extendedSettings: {
        connect: {
          source: 'dexcomshare',
          shareAccountName: 'do-not-send',
          sharePassword: 'do-not-send'
        }
      },
      settings: {
        enable: ['careportal', 'iob', 'token', 'bridge', 'connect']
      }
    };
    var counters = {
      used: {
        'api.v1.entries.read': 4,
        'api.v1.treatments.write': 3
      },
      health: {
        http_2xx: 10,
        http_4xx: 2,
        http_5xx: 0,
        websocket_connections: 1
      }
    };

    var built = payload.build(env, { runtimeState: 'loaded' }, {
      now: new Date('2026-07-16T12:00:00Z'),
      installationSecret: 'local random secret',
      counters: counters,
      uptimeBucket: '1-24h'
    });

    built.schema.should.equal(1);
    built.product.should.equal('cgm-remote-monitor');
    built.release.should.equal('15.x');
    built.reporting_period.should.equal('2026-07-16');
    built.installation_id.should.startWith('monthly_');
    built.runtime.node_major.should.be.a.Number();
    built.runtime.database_family.should.equal('mongodb-atlas');
    built.features.enabled.should.eql(['bridge', 'careportal', 'connect', 'connect.dexcomshare', 'iob']);
    built.features.used.should.eql({ 'api.v1.entries.read': 4 });
    built.health.http_2xx.should.equal(10);
    built.health.websocket_connections.should.equal(1);

    should.not.exist(built.entries);
    should.not.exist(built.treatments);
    should.not.exist(built.url);
    should.not.exist(built.token);
    should.not.exist(built.logs);
    JSON.stringify(built).should.not.containEql('do-not-send');
  });

  it('creates a no-network telemetry facade with preview payload', function () {
    var env = {
      version: '15.0.8',
      telemetry: { mode: 'aggregate', storeDir: tempStore() },
      settings: { enable: ['careportal'] }
    };
    var telemetry = createTelemetry(env, {});
    telemetry.config.enabled.should.equal(true);
    telemetry.start().should.equal(false);

    telemetry.counters.increment('reports.opened');
    var preview = telemetry.preview({
      now: new Date('2026-07-16T12:00:00Z')
    });
    preview.enabled.should.equal(true);
    preview.secretSource.should.equal('generated');
    preview.payload.features.used.should.eql({ 'reports.opened': 1 });
  });

  it('does not send when telemetry is disabled', function (done) {
    var telemetry = createTelemetry({
      version: '15.0.8',
      telemetry: { mode: 'off', endpoint: 'http://127.0.0.1:1/v1/nightscout/checkin', storeDir: tempStore() },
      settings: { enable: [] }
    }, {});

    telemetry.sendOnce(function sent (err, result) {
      should.not.exist(err);
      result.sent.should.equal(false);
      result.reason.should.equal('disabled');
      done();
    });
  });

  it('manually posts the preview-equivalent aggregate payload when enabled', function (done) {
    var received = null;
    var server = http.createServer(function receiver (req, res) {
      req.method.should.equal('POST');
      req.url.should.equal('/v1/nightscout/checkin');
      req.headers['content-type'].should.equal('application/json');
      var chunks = [];
      req.on('data', function chunk (data) {
        chunks.push(data);
      });
      req.on('end', function end () {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.statusCode = 204;
        res.end();
      });
    });

    server.listen(0, '127.0.0.1', function listening () {
      var address = server.address();
      var telemetry = createTelemetry({
        version: '15.0.8',
        telemetry: {
          mode: 'aggregate',
          endpoint: 'http://127.0.0.1:' + address.port + '/v1/nightscout/checkin',
          secret: 'local sender secret',
          storeDir: tempStore()
        },
        settings: { enable: ['careportal'] }
      }, {});

      telemetry.counters.increment('reports.opened');
      telemetry.sendOnce({
        now: new Date('2026-07-16T12:00:00Z')
      }, function sent (err, result) {
        server.close(function closed () {
          should.not.exist(err);
          result.sent.should.equal(true);
          result.statusCode.should.equal(204);
          received.product.should.equal('cgm-remote-monitor');
          received.reporting_period.should.equal('2026-07-16');
          received.features.enabled.should.eql(['careportal']);
          received.features.used.should.eql({ 'reports.opened': 1 });
          should.not.exist(received.url);
          should.not.exist(received.token);
          should.not.exist(received.logs);
          telemetry.counters.snapshot().used.should.eql({});
          done();
        });
      });
    });
  });

  it('persists send schedule state after attempts', function (done) {
    var storeDir = tempStore();
    var now = new Date('2026-07-16T12:00:00Z');
    var server = http.createServer(function receiver (req, res) {
      req.resume();
      res.statusCode = 204;
      res.end();
    });

    server.listen(0, '127.0.0.1', function listening () {
      var address = server.address();
      var env = {
        version: '15.0.8',
        telemetry: {
          mode: 'aggregate',
          endpoint: 'http://127.0.0.1:' + address.port + '/v1/nightscout/checkin',
          secret: 'schedule secret',
          storeDir
        },
        settings: { enable: [] }
      };
      var telemetry = createTelemetry(env, {});
      var initialized = telemetry.schedulePreview({ now, random: () => 0 });
      initialized.due.should.equal(false);
      initialized.next_due_at.should.equal('2026-07-16T12:05:00.000Z');

      telemetry.sendOnce({ now, random: () => 0 }, function sent (err, result) {
        server.close(function closed () {
          should.not.exist(err);
          result.sent.should.equal(true);
          var reloaded = createTelemetry(env, {});
          var persisted = reloaded.schedulePreview({ now: new Date('2026-07-16T12:01:00Z'), random: () => 0 });
          persisted.last_success_at.should.equal('2026-07-16T12:00:00.000Z');
          persisted.last_status.should.equal(204);
          persisted.next_due_at.should.equal('2026-07-23T12:00:00.000Z');
          done();
        });
      });
    });
  });

  it('reports sender failures without throwing', function (done) {
    var telemetry = createTelemetry({
      version: '15.0.8',
      telemetry: {
        mode: 'aggregate',
        endpoint: 'file:///tmp/nope',
        secret: 'local sender secret',
        storeDir: tempStore()
      },
      settings: { enable: [] }
    }, {});

    telemetry.sendOnce(function sent (err, result) {
      should.not.exist(err);
      result.sent.should.equal(false);
      result.error.should.equal('unsupported-protocol');
      done();
    });
  });

  it('does not run scheduled send unless explicitly enabled', function (done) {
    var telemetry = createTelemetry({
      version: '15.0.8',
      telemetry: {
        mode: 'aggregate',
        scheduledSend: false,
        endpoint: 'http://127.0.0.1:1/v1/nightscout/checkin',
        storeDir: tempStore()
      },
      settings: { enable: [] }
    }, {});

    telemetry.runDue(function ran (err, result) {
      should.not.exist(err);
      result.sent.should.equal(false);
      result.reason.should.equal('scheduled-disabled');
      done();
    });
  });

  it('initializes scheduled send without sending before due time', function (done) {
    var now = new Date('2026-07-16T12:00:00Z');
    var telemetry = createTelemetry({
      version: '15.0.8',
      telemetry: {
        mode: 'aggregate',
        scheduledSend: true,
        endpoint: 'http://127.0.0.1:1/v1/nightscout/checkin',
        storeDir: tempStore()
      },
      settings: { enable: [] }
    }, {});

    telemetry.runDue({ now, random: () => 0 }, function ran (err, result) {
      should.not.exist(err);
      result.sent.should.equal(false);
      result.reason.should.equal('not-due');
      result.next_due_at.should.equal('2026-07-16T12:05:00.000Z');
      done();
    });
  });

  it('runs scheduled send when due and records success state', function (done) {
    var now = new Date('2026-07-16T12:00:00Z');
    var storeDir = tempStore();
    var server = http.createServer(function receiver (req, res) {
      req.resume();
      res.statusCode = 204;
      res.end();
    });

    server.listen(0, '127.0.0.1', function listening () {
      var address = server.address();
      var env = {
        version: '15.0.8',
        telemetry: {
          mode: 'aggregate',
          scheduledSend: true,
          endpoint: 'http://127.0.0.1:' + address.port + '/v1/nightscout/checkin',
          secret: 'scheduled secret',
          storeDir
        },
        settings: { enable: [] }
      };
      var telemetry = createTelemetry(env, {});
      telemetry.schedulePreview({ now: new Date('2026-07-16T11:00:00Z'), random: () => 0 });
      telemetry.runDue({ now, random: () => 0 }, function ran (err, result) {
        server.close(function closed () {
          should.not.exist(err);
          result.sent.should.equal(true);
          result.statusCode.should.equal(204);
          var reloaded = createTelemetry(env, {});
          var state = reloaded.schedulePreview({ now: new Date('2026-07-16T12:01:00Z') });
          state.next_due_at.should.equal('2026-07-23T12:00:00.000Z');
          state.last_success_at.should.equal('2026-07-16T12:00:00.000Z');
          done();
        });
      });
    });
  });

  describe('preview endpoint', function () {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    var app;

    before(function (done) {
      withEnv({
        API_SECRET: 'this is my long pass phrase',
        MONGODB_URI: 'mongodb://localhost/nightscout',
        NIGHTSCOUT_TELEMETRY: 'aggregate',
        NIGHTSCOUT_TELEMETRY_STORE: tempStore()
      }, function bootApp () {
        var env = require('../lib/server/env')();
        env.settings.authDefaultRoles = 'denied';
        app = require('express')();
        app.enable('api');
        require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
          app.get('/report', function report (req, res) {
            ctx.telemetry.counters.increment('reports.opened');
            res.status(200).send('report');
          });
          app.use('/api', require('../lib/api/')(env, ctx));
          done();
        });
      });
    });

    it('requires admin authorization', function (done) {
      request(app)
        .get('/api/telemetry/preview.json')
        .expect(401)
        .end(done);
    });

    it('counts report page opens in preview payload', function (done) {
      request(app)
        .get('/report')
        .expect(200)
        .end(function (err) {
          if (err) return done(err);
          request(app)
            .get('/api/telemetry/preview.json')
            .set('api-secret', known)
            .expect(200)
            .end(function (err, res) {
              if (err) return done(err);
              res.body.message.payload.features.used['reports.opened'].should.equal(1);
              done();
            });
        });
    });

    it('returns the exact pending aggregate payload for admins', function (done) {
      request(app)
        .get('/api/telemetry/preview.json')
        .set('api-secret', known)
        .expect(200)
        .end(function (err, res) {
          if (err) {
            done(err);
            return;
          }
          res.body.message.enabled.should.equal(true);
          res.body.message.mode.should.equal('aggregate');
          res.body.message.payload.product.should.equal('cgm-remote-monitor');
          res.body.message.payload.installation_id.should.startWith('monthly_');
          should.not.exist(res.body.message.payload.url);
          should.not.exist(res.body.message.payload.token);
          done();
        });
    });

    describe('manual send endpoint', function () {
        var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

        function bootWithReceiver (manualSend, done) {
          var received = null;
          var receiver = http.createServer(function receive (req, res) {
            var chunks = [];
            req.on('data', function chunk (data) {
              chunks.push(data);
            });
            req.on('end', function end () {
              received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              res.statusCode = 204;
              res.end();
            });
          });

          receiver.listen(0, '127.0.0.1', function listening () {
            var address = receiver.address();
            withEnv({
              API_SECRET: 'this is my long pass phrase',
              MONGODB_URI: 'mongodb://localhost/nightscout',
              NIGHTSCOUT_TELEMETRY: 'aggregate',
              NIGHTSCOUT_TELEMETRY_ENDPOINT: 'http://127.0.0.1:' + address.port + '/v1/nightscout/checkin',
              NIGHTSCOUT_TELEMETRY_SECRET: 'manual endpoint secret',
              NIGHTSCOUT_TELEMETRY_MANUAL_SEND: manualSend ? 'on' : 'off',
              NIGHTSCOUT_TELEMETRY_STORE: tempStore()
            }, function bootApp () {
              var env = require('../lib/server/env')();
              env.settings.authDefaultRoles = 'denied';
              var localApp = require('express')();
              localApp.enable('api');
              require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
                localApp.use(ctx.telemetry.routeCounters());
                localApp.use('/api', require('../lib/api/')(env, ctx));
                done(localApp, receiver, function getReceived () { return received; });
              });
            });
          });
        }

        it('is disabled unless explicitly enabled', function (done) {
          bootWithReceiver(false, function booted (localApp, receiver) {
            request(localApp)
              .post('/api/telemetry/send.json')
              .set('api-secret', known)
              .expect(400)
              .end(function end (err) {
                receiver.close(function closed () {
                  done(err);
                });
              });
          });
        });

        it('posts cgm payload to configured local endpoint when explicitly enabled', function (done) {
          bootWithReceiver(true, function booted (localApp, receiver, getReceived) {
            request(localApp)
              .get('/api/v1/entries.json?count=1')
              .set('api-secret', known)
              .end(function () {
                request(localApp)
                  .post('/api/telemetry/send.json')
                  .set('api-secret', known)
                  .expect(200)
                  .end(function end (err, res) {
                    receiver.close(function closed () {
                      if (err) return done(err);
                      res.body.message.sent.should.equal(true);
                      res.body.message.statusCode.should.equal(204);
                      getReceived().product.should.equal('cgm-remote-monitor');
                      getReceived().features.used['api.v1.entries.read'].should.equal(1);
                      should.not.exist(getReceived().url);
                      should.not.exist(getReceived().token);
                      done();
                    });
                  });
              });
          });
        });
    });
  });
});
