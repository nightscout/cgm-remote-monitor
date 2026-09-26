'use strict';

// BF-125: IFTTT Maker event names must not depend on the site's LANGUAGE.
// A site set to Russian or German used to trigger ns-осторожно / ns-warnung
// instead of ns-warning, so applets keyed on the documented names never fired.
// These tests drive the real lib/plugins/maker.js against a local HTTP stub
// (https.get is redirected to 127.0.0.1; nothing reaches IFTTT).

var should = require('should');
var fs = require('fs');
var http = require('http');
var https = require('https');

var levels = require('../lib/levels');

describe('BF-125 maker event names use untranslated level keys', function () {
  var stub, port, hits, stubMode, realGet, realTranslate, realNow, offset;

  before(function (done) {
    realGet = https.get;
    realTranslate = levels.translate;
    realNow = Date.now;
    stub = http.createServer(function (req, res) {
      // /trigger/<event>/with/key/<key>?value1=...
      var q = req.url.indexOf('?');
      var parts = (q < 0 ? req.url : req.url.slice(0, q)).split('/');
      hits.push({ event: decodeURIComponent(parts[2]), key: parts[5], query: q < 0 ? '' : req.url.slice(q) });
      if (stubMode === 'fail') { req.socket.destroy(); return; }
      res.end('ok');
    });
    stub.listen(0, '127.0.0.1', function () {
      port = stub.address().port;
      https.get = function (url, cb) {
        var u = String(url);
        if (u.indexOf('https://maker.ifttt.com/') !== 0) { throw new Error('test refused a non-maker URL: ' + u); }
        return http.get(u.replace('https://maker.ifttt.com/', 'http://127.0.0.1:' + port + '/'), cb);
      };
      done();
    });
  });

  after(function (done) {
    https.get = realGet;
    levels.translate = realTranslate;
    Date.now = realNow;
    stub.close(done);
  });

  beforeEach(function () {
    hits = [];
    stubMode = 'ok';
    offset = 0;
    Date.now = function () { return realNow() + offset; };
  });

  afterEach(function () {
    levels.translate = realTranslate;
    Date.now = realNow;
  });

  // wire language, levels, maker and pushnotify the way lib/server/bootevent.js does
  function build (lang) {
    var language = require('../lib/language')();
    language.set(lang);
    language.loadLocalization(fs);
    levels.translate = language.translate;
    var env = require('../lib/server/env')();
    env.extendedSettings = { maker: { key: 'test-key' } };
    var ctx = { levels: levels, language: language };
    ctx.notifications = require('../lib/notifications')(env, ctx);
    ctx.maker = require('../lib/plugins/maker')(env);
    ctx.pushnotify = require('../lib/server/pushnotify')(env, ctx);
    return ctx;
  }

  // shaped like a simplealarms notification: translated title, English eventName
  function alarm (level, eventName) {
    return {
      level: level
      , title: levels.toDisplay(level) + ' LOW'
      , message: 'BG Now: 55'
      , eventName: eventName
      , group: 'default'
      , plugin: { name: 'simplealarms' }
    };
  }

  function emitAndCollect (ctx, notify, cb) {
    var before = hits.length;
    ctx.pushnotify.emitNotification(notify);
    setTimeout(function () { cb(hits.slice(before)); }, 300);
  }

  ['en', 'ru', 'de'].forEach(function (lang) {
    it('a WARN alarm on a "' + lang + '" site triggers ns-event, ns-warning, ns-warning-low', function (done) {
      var ctx = build(lang);
      var notify = alarm(levels.WARN, 'low');
      emitAndCollect(ctx, notify, function (sent) {
        sent.map(function (h) { return h.event; }).should.eql(['ns-event', 'ns-warning', 'ns-warning-low']);
        done();
      });
    });

    it('an URGENT alarm on a "' + lang + '" site triggers ns-event, ns-urgent, ns-urgent-high', function (done) {
      var ctx = build(lang);
      emitAndCollect(ctx, alarm(levels.URGENT, 'high'), function (sent) {
        sent.map(function (h) { return h.event; }).should.eql(['ns-event', 'ns-urgent', 'ns-urgent-high']);
        done();
      });
    });
  });

  it('keeps the translated title in value1 (the text people read)', function (done) {
    var ctx = build('ru');
    var notify = alarm(levels.WARN, 'low');
    notify.title.should.equal('Осторожно LOW');
    emitAndCollect(ctx, notify, function (sent) {
      sent.length.should.equal(3);
      sent.forEach(function (h) {
        decodeURIComponent(h.query).should.startWith('?value1=Осторожно LOW');
      });
      done();
    });
  });

  it('levels.toKey is untranslated while toDisplay/toLowerCase stay translated', function () {
    build('de');
    levels.toKey(levels.URGENT).should.equal('urgent');
    levels.toKey(levels.WARN).should.equal('warning');
    levels.toKey(levels.INFO).should.equal('info');
    levels.toKey(levels.LOW).should.equal('low');
    levels.toKey(levels.LOWEST).should.equal('lowest');
    levels.toKey(levels.NONE).should.equal('none');
    levels.toKey(42).should.equal('unknown');
    levels.toKey(undefined).should.equal('unknown');
    levels.toKey(null).should.equal('unknown');
    levels.toDisplay(levels.WARN).should.equal('Warnung');
    levels.toLowerCase(levels.URGENT).should.equal('akut');
  });

  it('levels.toKey equals the English toLowerCase for every level (the contract English sites send)', function () {
    build('en');
    [2, 1, 0, -1, -2, -3, 42].forEach(function (level) {
      levels.toKey(level).should.equal(levels.toLowerCase(level));
    });
  });

  // Dedup (second half of BF-125). A send that reports success holds the
  // alarm's key for 15 minutes; a failed send keeps the 30-second key, so the
  // alarm is retried at the next check after 30 s. This is the behaviour of
  // 15.0.8 and is kept: these tests pin it, they do not change it.
  it('a successful maker send suppresses the same alarm for 15 minutes', function (done) {
    var ctx = build('ru');
    emitAndCollect(ctx, alarm(levels.WARN, 'low'), function (first) {
      first.length.should.equal(3);
      offset = 45 * 1000;
      emitAndCollect(ctx, alarm(levels.WARN, 'low'), function (second) {
        second.length.should.equal(0);
        offset = 16 * 60 * 1000;
        emitAndCollect(ctx, alarm(levels.WARN, 'low'), function (third) {
          third.length.should.equal(3);
          done();
        });
      });
    });
  });

  it('a failing maker endpoint: the alarm is retried after 30 s, not held for 15 minutes', function (done) {
    var ctx = build('ru');
    stubMode = 'fail';
    emitAndCollect(ctx, alarm(levels.WARN, 'low'), function (first) {
      // async.series stops at the first error: only ns-event was attempted
      first.map(function (h) { return h.event; }).should.eql(['ns-event']);
      offset = 10 * 1000;
      emitAndCollect(ctx, alarm(levels.WARN, 'low'), function (within) {
        within.length.should.equal(0);
        offset = 45 * 1000;
        stubMode = 'ok';
        emitAndCollect(ctx, alarm(levels.WARN, 'low'), function (retry) {
          retry.map(function (h) { return h.event; }).should.eql(['ns-event', 'ns-warning', 'ns-warning-low']);
          should.exist(retry);
          done();
        });
      });
    });
  });
});
