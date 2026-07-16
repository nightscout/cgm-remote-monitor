'use strict';

const should = require('should');

const allowlists = require('../lib/telemetry/allowlists');
const config = require('../lib/telemetry/config');
const createCounters = require('../lib/telemetry/counters');
const id = require('../lib/telemetry/id');
const payload = require('../lib/telemetry/payload');
const createTelemetry = require('../lib/telemetry');

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
      NIGHTSCOUT_TELEMETRY_ID_ROTATION: 'monthly',
      API_SECRET: 'this is my long pass phrase',
      MONGODB_URI: 'mongodb://localhost/nightscout'
    }, function checkEnv () {
      var env = require('../lib/server/env')();
      env.telemetry.mode.should.equal('aggregate');
      env.telemetry.endpoint.should.equal('https://example.invalid/checkin');
      env.telemetry.preview.should.equal(false);
      env.telemetry.idRotation.should.equal('monthly');
    });
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

  it('filters enabled features and rejects unallowlisted counters', function () {
    allowlists.filterFeatures(['careportal', 'token', 'bridge', 'url']).should.eql(['bridge', 'careportal']);
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

  it('builds a schema-shaped aggregate payload without prohibited fields', function () {
    var env = {
      version: '15.0.8',
      storageURI: 'mongodb+srv://example.mongodb.net/nightscout',
      settings: {
        enable: ['careportal', 'iob', 'token', 'bridge']
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
    built.features.enabled.should.eql(['bridge', 'careportal', 'iob']);
    built.features.used.should.eql({ 'api.v1.entries.read': 4 });
    built.health.http_2xx.should.equal(10);
    built.health.websocket_connections.should.equal(1);

    should.not.exist(built.entries);
    should.not.exist(built.treatments);
    should.not.exist(built.url);
    should.not.exist(built.token);
    should.not.exist(built.logs);
  });

  it('creates a no-network telemetry facade with preview payload', function () {
    var env = {
      version: '15.0.8',
      telemetry: { mode: 'aggregate' },
      settings: { enable: ['careportal'] }
    };
    var telemetry = createTelemetry(env, {});
    telemetry.config.enabled.should.equal(true);
    telemetry.start().should.equal(false);

    telemetry.counters.increment('reports.opened');
    var preview = telemetry.preview({
      now: new Date('2026-07-16T12:00:00Z'),
      installationSecret: 'local random secret'
    });
    preview.enabled.should.equal(true);
    preview.payload.features.used.should.eql({ 'reports.opened': 1 });
  });
});
