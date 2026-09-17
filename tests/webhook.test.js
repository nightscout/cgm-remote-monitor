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
