'use strict';

var should = require('should');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSbx(mgdl, mills) {
  return {
    lastSGVMgdl: function () { return mgdl; },
    lastSGVMills: function () { return mills; }
  };
}

// Create a fresh plugin instance for each test so internal state is isolated.
function makePlugin() {
  // Clear the require cache so each call returns a brand-new closure.
  delete require.cache[require.resolve('../lib/plugins/webhook')];
  return require('../lib/plugins/webhook')();
}

// ---------------------------------------------------------------------------
// Startup behaviour
// ---------------------------------------------------------------------------

describe('webhook – startup behaviour', function () {

  it('does not send a webhook for the SGV that is already present at startup', function () {
    var plugin = makePlugin();
    var sent = 0;
    plugin.sendWebhook = function () { sent++; };

    plugin.checkNotifications(makeSbx(120, 1000));
    sent.should.equal(0);
  });

  it('sends a webhook for the first NEW SGV after startup', function (done) {
    var plugin = makePlugin();

    // First call – existing reading, should be skipped.
    plugin.checkNotifications(makeSbx(120, 1000));

    plugin.sendWebhook = function (payload, onSuccess) {
      payload.mills.should.equal(2000);
      onSuccess();
      done();
    };

    // Second call – new reading.
    plugin.checkNotifications(makeSbx(130, 2000));
  });

});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('webhook – deduplication', function () {

  it('sends only once for the same SGV timestamp', function () {
    var plugin = makePlugin();
    var sent = 0;

    // Initialise (skip startup SGV).
    plugin.checkNotifications(makeSbx(120, 1000));

    plugin.sendWebhook = function (payload, onSuccess) {
      sent++;
      onSuccess();
    };

    plugin.checkNotifications(makeSbx(130, 2000));
    plugin.checkNotifications(makeSbx(130, 2000));
    plugin.checkNotifications(makeSbx(130, 2000));

    sent.should.equal(1);
  });

  it('does not send a second request while one is still in flight', function () {
    var plugin = makePlugin();
    var sent = 0;

    plugin.checkNotifications(makeSbx(120, 1000));

    // Capture onSuccess but do NOT call it yet – request is in flight.
    var pendingSuccess;
    plugin.sendWebhook = function (payload, onSuccess) {
      sent++;
      pendingSuccess = onSuccess;
    };

    plugin.checkNotifications(makeSbx(130, 2000));
    plugin.checkNotifications(makeSbx(130, 2000)); // should be a no-op

    sent.should.equal(1);

    // Resolve the in-flight request.
    pendingSuccess();
  });

});

// ---------------------------------------------------------------------------
// Retry on failure (at-least-once semantics)
// ---------------------------------------------------------------------------

describe('webhook – retry after failure', function () {

  it('retries the same SGV after a failed request', function () {
    var plugin = makePlugin();
    var attempts = 0;

    plugin.checkNotifications(makeSbx(120, 1000));

    plugin.sendWebhook = function (payload, onSuccess, onFailure) {
      attempts++;
      if (attempts === 1) {
        onFailure(); // Simulate a network error on first attempt.
      } else {
        onSuccess();
      }
    };

    plugin.checkNotifications(makeSbx(130, 2000)); // attempt 1 – fails
    plugin.checkNotifications(makeSbx(130, 2000)); // attempt 2 – succeeds
    plugin.checkNotifications(makeSbx(130, 2000)); // attempt 3 – skipped (already sent)

    attempts.should.equal(2);
  });

  it('does not retry after a successful delivery', function () {
    var plugin = makePlugin();
    var attempts = 0;

    plugin.checkNotifications(makeSbx(120, 1000));

    plugin.sendWebhook = function (payload, onSuccess) {
      attempts++;
      onSuccess();
    };

    plugin.checkNotifications(makeSbx(130, 2000));
    plugin.checkNotifications(makeSbx(130, 2000));

    attempts.should.equal(1);
  });

});

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

describe('webhook – payload', function () {

  it('includes mgdl, mills, iso, and source fields', function (done) {
    var plugin = makePlugin();

    plugin.checkNotifications(makeSbx(120, 1000)); // initialise

    plugin.sendWebhook = function (payload, onSuccess) {
      payload.source.should.equal('nightscout');
      payload.mgdl.should.equal(130);
      payload.mills.should.equal(2000);
      payload.iso.should.equal(new Date(2000).toISOString());
      onSuccess();
      done();
    };

    plugin.checkNotifications(makeSbx(130, 2000));
  });

});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('webhook – edge cases', function () {

  it('does nothing when sbx is null', function () {
    var plugin = makePlugin();
    var sent = 0;
    plugin.sendWebhook = function () { sent++; };
    plugin.checkNotifications(null);
    sent.should.equal(0);
  });

  it('does nothing when mgdl is missing', function () {
    var plugin = makePlugin();
    var sent = 0;
    plugin.sendWebhook = function () { sent++; };
    plugin.checkNotifications(makeSbx(null, 1000));
    sent.should.equal(0);
  });

  it('does nothing when mills is missing', function () {
    var plugin = makePlugin();
    var sent = 0;
    plugin.sendWebhook = function () { sent++; };
    plugin.checkNotifications(makeSbx(120, null));
    sent.should.equal(0);
  });

});

// ---------------------------------------------------------------------------
// Configuration (BF-48): read by lib/server/env.js, same names and defaults
// ---------------------------------------------------------------------------

describe('webhook – configuration', function () {
  var NAMES = ['WEBHOOK_PROTOCOL', 'WEBHOOK_HOST', 'WEBHOOK_PORT', 'WEBHOOK_PATH'];
  var KEYS = [];
  NAMES.forEach(function (name) {
    KEYS.push(name, name.toLowerCase(), 'CUSTOMCONNSTR_' + name);
  });
  var saved;

  beforeEach(function () {
    saved = {};
    KEYS.forEach(function (key) { saved[key] = process.env[key]; delete process.env[key]; });
  });

  afterEach(function () {
    KEYS.forEach(function (key) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  it('defaults to http://localhost:3000/nightscout', function () {
    var env = require('../lib/server/env')();
    env.webhook.should.eql({
      WEBHOOK_PROTOCOL: 'http', WEBHOOK_HOST: 'localhost', WEBHOOK_PORT: '3000', WEBHOOK_PATH: '/nightscout'
    });
    makePlugin().url.should.equal('http://localhost:3000/nightscout');
  });

  it('reads exactly the four upper-case names, and an empty value takes the default', function () {
    process.env.WEBHOOK_PROTOCOL = 'https';
    process.env.WEBHOOK_HOST = '192.0.2.5';
    process.env.WEBHOOK_PORT = '';
    process.env.webhook_path = '/ignored';
    process.env.CUSTOMCONNSTR_WEBHOOK_PATH = '/ignored-too';
    var env = require('../lib/server/env')();
    env.webhook.should.eql({
      WEBHOOK_PROTOCOL: 'https', WEBHOOK_HOST: '192.0.2.5', WEBHOOK_PORT: '3000', WEBHOOK_PATH: '/nightscout'
    });
  });

  it('takes its address from the plugin context that boot passes', function () {
    process.env.WEBHOOK_HOST = 'not-this-one';
    delete require.cache[require.resolve('../lib/plugins/webhook')];
    var plugin = require('../lib/plugins/webhook')({
      webhook: { WEBHOOK_PROTOCOL: 'https', WEBHOOK_HOST: 'display.local', WEBHOOK_PORT: '443', WEBHOOK_PATH: '/bg' }
    });
    plugin.url.should.equal('https://display.local:443/bg');
  });

  it('is wired from env through boot into the plugin', function () {
    var source = require('fs').readFileSync(require.resolve('../lib/server/bootevent'), 'utf8');
    source.should.match(/webhook: env\.webhook/);
    require('fs').readFileSync(require.resolve('../lib/plugins/webhook'), 'utf8').should.not.match(/process\.env/);
  });
});
