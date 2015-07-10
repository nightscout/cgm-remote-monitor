var should = require('should');
var Stream = require('stream');

describe('boluswizardpreview', function ( ) {

  var boluswizardpreview = require('../lib/plugins/boluswizardpreview')();
  var ar2 = require('../lib/plugins/ar2')();
  var iob = require('../lib/plugins/iob')();
  var delta = require('../lib/plugins/delta')();

  var env = require('../env')();
  env.testMode = true;
  var ctx = {};
  ctx.data = require('../lib/data')(env, ctx);
  ctx.notifications = require('../lib/notifications')(env, ctx);

  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    iob.setProperties(sbx);
    ar2.setProperties(sbx);
    delta.setProperties(sbx);
    boluswizardpreview.setProperties(sbx);
    sbx.offerProperty('direction', function setFakeDirection() {
      return {value: 'FortyFiveUp', label: '↗', entity: '&#8599;'};
    });

    return sbx;
  }

  var now = Date.now();
  var before = now - (5 * 60 * 1000);

  var profile = {
    dia: 3
    , sens: 90
    , target_high: 120
    , target_low: 100
  };

  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: before, y: 95}, {mills: now, y: 100}];
    ctx.data.treatments = [];
    ctx.data.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);

    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('trigger a warning when going out of range', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: before, y: 175}, {mills: now, y: 180}];
    ctx.data.treatments = [];
    ctx.data.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(ctx.notifications.levels.WARN);
    highest.title.should.equal('Warning, Check BG, time to bolus?');
    highest.message.should.equal('BG Now: 180 +5 ↗ mg/dl\nBG 15m: 187 mg/dl\nBWP: 0.66U\nIOB: 0U');
    done();
  });

  it('trigger an urgent alarms when going too high', function (done) {
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: before, y: 295}, {mills: now, y: 300}];
    ctx.data.treatments = [];
    ctx.data.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(ctx.notifications.levels.URGENT);

    done();
  });

  it('request a snooze when there is enough IOB', function (done) {

    ctx.notifications.resetStateForTests();
    ctx.notifications.initRequests();
    ctx.data.sgvs = [{mills: before, y: 295}, {mills: now, y: 300}];
    ctx.data.treatments = [{mills: before, insulin: '5.0'}];
    ctx.data.profiles = [profile];

    var sbx = prepareSandbox();

    //start fresh to we don't pick up other notifications
    ctx.bus = new Stream;
    //if notification doesn't get called test will time out
    ctx.bus.on('notification', function callback (notify) {
      notify.clear.should.equal(true);
      if (notify.clear) {
        done();
      }
    });

    ar2.checkNotifications(sbx);
    boluswizardpreview.checkNotifications(sbx);
    ctx.notifications.process();

  });

  it('set a pill to the BWP with infos', function (done) {
    var pluginBase = {
      updatePillText: function mockedUpdatePillText (plugin, options) {
        options.label.should.equal('BWP');
        options.value.should.equal('0.50U');
        done();
      }
    };

    var app = { };
    var clientSettings = {};

    var loadedProfile = require('../lib/profilefunctions')();
    loadedProfile.loadData([profile]);

    var data = {
      sgvs: [{mills: before, y: 295}, {mills: now, y: 300}]
      , treatments: [{mills: before, insulin: '1.5'}]
      , profile: loadedProfile
    };

    var sbx = require('../lib/sandbox')().clientInit(app, clientSettings, Date.now(), pluginBase, data);

    iob.setProperties(sbx);
    boluswizardpreview.setProperties(sbx);
    boluswizardpreview.updateVisualisation(sbx);

    ctx.notifications.resetStateForTests();
    ctx.notifications.initRequests();
    ctx.data.profiles = [profile];

  });

});