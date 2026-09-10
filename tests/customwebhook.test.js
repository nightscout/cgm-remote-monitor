'use strict';

var should = require('should');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a customwebhook instance from the numbered settings an operator would
// configure. Returns null when nothing usable is configured, same as the module.
function makeWebhooks (settings) {
  return require('../lib/server/customwebhook')({settings: settings || {}});
}

// Replace the outbound request so no test ever touches the network, and record
// what would have been sent.
function capture (customwebhook, err) {
  var sent = [ ];

  customwebhook.sendRequest = function captureRequest (webhook, payload, callback) {
    sent.push({url: webhook.url, target: webhook.target, payload: payload});
    callback(err || null);
  };

  return sent;
}

function urgentEvent ( ) {
  return {
    name: 'simplealarms'
    , level: 'urgent'
    , title: 'Urgent LOW'
    , message: 'BG 51'
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('customwebhook - configuration', function ( ) {

  it('is not created when nothing is configured', function ( ) {
    should.not.exist(makeWebhooks({}));
  });

  it('is not created when there are no settings at all', function ( ) {
    should.not.exist(require('../lib/server/customwebhook')({}));
  });

  it('loads a complete url and event pair', function ( ) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-urgent'
    });

    customwebhook.webhooks.length.should.equal(1);
    customwebhook.webhooks[0].event.should.equal('ns-urgent');
    customwebhook.webhooks[0].url.should.equal('https://example.com/hook');
  });

  it('skips a url configured without an event', function ( ) {
    should.not.exist(makeWebhooks({customWebhookUrl1: 'https://example.com/hook'}));
  });

  it('skips an event configured without a url', function ( ) {
    should.not.exist(makeWebhooks({customWebhookEvent1: 'ns-urgent'}));
  });

  it('skips a malformed url without throwing', function ( ) {
    should.not.exist(makeWebhooks({
      customWebhookUrl1: 'this is not a url'
      , customWebhookEvent1: 'ns-urgent'
    }));
  });

  it('rejects a scheme that is not http or https', function ( ) {
    should.not.exist(makeWebhooks({
      customWebhookUrl1: 'ftp://example.com/hook'
      , customWebhookEvent1: 'ns-urgent'
    }));
  });

  it('keeps the valid entries when another entry is invalid', function ( ) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'nope'
      , customWebhookEvent1: 'ns-urgent'
      , customWebhookUrl2: 'https://good.example.com/hook'
      , customWebhookEvent2: 'ns-urgent'
    });

    customwebhook.webhooks.length.should.equal(1);
    customwebhook.webhooks[0].index.should.equal(2);
  });

  it('supports sparse indexes', function ( ) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://one.example.com/hook'
      , customWebhookEvent1: 'ns-urgent'
      , customWebhookUrl4: 'https://four.example.com/hook'
      , customWebhookEvent4: 'ns-urgent'
    });

    customwebhook.webhooks.length.should.equal(2);
    customwebhook.webhooks[0].index.should.equal(1);
    customwebhook.webhooks[1].index.should.equal(4);
  });

  it('trims surrounding whitespace', function ( ) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: '  https://example.com/hook  '
      , customWebhookEvent1: '  ns-urgent  '
    });

    customwebhook.webhooks[0].url.should.equal('https://example.com/hook');
    customwebhook.webhooks[0].event.should.equal('ns-urgent');
  });

});

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

describe('customwebhook - event matching', function ( ) {

  it('generates the same event names Maker uses', function ( ) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-event'
    });

    customwebhook.eventNames({name: 'simplealarms', level: 'urgent'})
      .should.eql(['ns-event', 'ns-urgent', 'ns-urgent-simplealarms']);
  });

  it('sends one request to the configured destination on a match', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-urgent'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(1);
      sent.length.should.equal(1);
      sent[0].url.should.equal('https://example.com/hook');
      sent[0].payload.event.should.equal('ns-urgent');
      done();
    });
  });

  it('matches the generic ns-event name', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-event'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(1);
      sent.length.should.equal(1);
      done();
    });
  });

  it('matches the level and name qualified event', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-urgent-simplealarms'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err) {
      should.not.exist(err);
      sent.length.should.equal(1);
      done();
    });
  });

  it('sends nothing when the configured event does not match', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-warning'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(0);
      sent.length.should.equal(0);
      done();
    });
  });

  it('delivers to every configured destination that matches', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://one.example.com/hook'
      , customWebhookEvent1: 'ns-urgent'
      , customWebhookUrl2: 'https://two.example.com/hook'
      , customWebhookEvent2: 'ns-event'
      , customWebhookUrl3: 'https://three.example.com/hook'
      , customWebhookEvent3: 'ns-warning'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(2);
      sent.map(function eachSent (item) { return item.url; }).should.eql([
        'https://one.example.com/hook'
        , 'https://two.example.com/hook'
      ]);
      done();
    });
  });

  it('sends a destination only once even when several event names match it', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-event'
      , customWebhookUrl2: 'https://example.com/hook'
      , customWebhookEvent2: 'ns-urgent'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(1);
      sent.length.should.equal(1);
      done();
    });
  });

  it('does not send a request without an event name', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-event'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent({level: 'urgent'}, function sendCallback (err) {
      should.exist(err);
      sent.length.should.equal(0);
      done();
    });
  });

  it('does not send a request without an event level', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-event'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent({name: 'simplealarms'}, function sendCallback (err) {
      should.exist(err);
      sent.length.should.equal(0);
      done();
    });
  });

  it('delivers an allclear only to destinations configured for it', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://clear.example.com/hook'
      , customWebhookEvent1: 'ns-allclear'
      , customWebhookUrl2: 'https://alarm.example.com/hook'
      , customWebhookEvent2: 'ns-event'
    });
    var sent = capture(customwebhook);

    customwebhook.sendAllClear({title: 'All Clear'}, function sendCallback (err, result) {
      should.not.exist(err);
      result.sent.should.equal(1);
      sent.length.should.equal(1);
      sent[0].url.should.equal('https://clear.example.com/hook');
      sent[0].payload.event.should.equal('ns-allclear');
      done();
    });
  });

});

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

describe('customwebhook - payload', function ( ) {

  it('includes the event, level, name, title and message', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-urgent'
    });
    var sent = capture(customwebhook);

    customwebhook.sendEvent(urgentEvent(), function sendCallback ( ) {
      var payload = sent[0].payload;
      payload.source.should.equal('nightscout');
      payload.event.should.equal('ns-urgent');
      payload.level.should.equal('urgent');
      payload.name.should.equal('simplealarms');
      payload.title.should.equal('Urgent LOW');
      payload.message.should.equal('BG 51');
      payload.isAnnouncement.should.equal(false);
      payload.mills.should.be.type('number');
      payload.iso.should.be.type('string');
      done();
    });
  });

  it('marks announcements', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-event'
    });
    var sent = capture(customwebhook);

    var event = urgentEvent();
    event.isAnnouncement = true;

    customwebhook.sendEvent(event, function sendCallback ( ) {
      sent[0].payload.isAnnouncement.should.equal(true);
      done();
    });
  });

});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe('customwebhook - transport', function ( ) {

  it('keeps the parsed target for an https destination', function ( ) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com:8443/hook?token=abc'
      , customWebhookEvent1: 'ns-event'
    });
    var target = customwebhook.webhooks[0].target;

    target.protocol.should.equal('https:');
    target.hostname.should.equal('example.com');
    target.port.should.equal('8443');
    target.pathname.should.equal('/hook');
    target.search.should.equal('?token=abc');
  });

  it('keeps the parsed target for an http destination', function ( ) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'http://192.168.1.5:3000/nightscout'
      , customWebhookEvent1: 'ns-event'
    });
    var target = customwebhook.webhooks[0].target;

    target.protocol.should.equal('http:');
    target.hostname.should.equal('192.168.1.5');
    target.port.should.equal('3000');
  });

  it('reports a network failure through the callback without throwing', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://example.com/hook'
      , customWebhookEvent1: 'ns-urgent'
    });
    capture(customwebhook, 'getaddrinfo ENOTFOUND example.com');

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err, result) {
      should.exist(err);
      result.sent.should.equal(0);
      result.matched.should.equal(1);
      done();
    });
  });

  it('reports a partial failure but still counts the successful send', function (done) {
    var customwebhook = makeWebhooks({
      customWebhookUrl1: 'https://bad.example.com/hook?token=SUPERSECRET'
      , customWebhookEvent1: 'ns-urgent'
      , customWebhookUrl2: 'https://good.example.com/hook'
      , customWebhookEvent2: 'ns-urgent'
    });

    customwebhook.sendRequest = function oneFails (webhook, payload, callback) {
      callback(webhook.url.indexOf('bad') > -1 ? 'unexpected status 500' : null);
    };

    customwebhook.sendEvent(urgentEvent(), function sendCallback (err, result) {
      should.exist(err);
      //the failing destination is identified by origin, without the secret bearing path
      err.indexOf('bad.example.com').should.be.above(-1);
      err.indexOf('SUPERSECRET').should.equal(-1);
      err.indexOf('/hook').should.equal(-1);
      result.sent.should.equal(1);
      result.matched.should.equal(2);
      done();
    });
  });

});
