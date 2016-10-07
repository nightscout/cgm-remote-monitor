var should = require('should');
var Stream = require('stream');
var levels = require('../lib/levels');

describe('boluswizardpreview', function ( ) {

  var boluswizardpreview = require('../lib/plugins/boluswizardpreview')();
  var ar2 = require('../lib/plugins/ar2')();
  var iob = require('../lib/plugins/iob')();
  var bgnow = require('../lib/plugins/bgnow')();

  var env = require('../env')();
  env.testMode = true;
  var ctx = {};
  ctx.ddata = require('../lib/data/ddata')();
  ctx.notifications = require('../lib/notifications')(env, ctx);

  function prepareSandbox ( ) {
    var sbx = require('../lib/sandbox')().serverInit(env, ctx);
    bgnow.setProperties(sbx);
    ar2.setProperties(sbx);
    iob.setProperties(sbx);
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

  it('should calculate IOB results correctly with 0 IOB', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 100}, {mills: now, mgdl: 100}];
    ctx.ddata.treatments = [];
    ctx.ddata.profiles = [profile];

    var sbx = prepareSandbox();
    var results = boluswizardpreview.calc(sbx);
    
    results.effect.should.equal(0);
    results.effectDisplay.should.equal(0);
    results.outcome.should.equal(100);
    results.outcomeDisplay.should.equal(100);
    results.bolusEstimate.should.equal(0);
    results.displayLine.should.equal('BWP: 0U');
    
    done();
  });

  it('should calculate IOB results correctly with 1.0 U IOB', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 100}, {mills: now, mgdl: 100}];
    ctx.ddata.treatments = [{mills: now, insulin: '1.0'}];
    
    var profile = {
      dia: 3
      , sens: 50
      , target_high: 100
      , target_low: 50
    };

    ctx.ddata.profiles = [profile];

    var sbx = prepareSandbox();
    var results = boluswizardpreview.calc(sbx);

    Math.round(results.effect).should.equal(50);
    results.effectDisplay.should.equal(50);
    Math.round(results.outcome).should.equal(50);
    results.outcomeDisplay.should.equal(50);
    results.bolusEstimate.should.equal(0);
    results.displayLine.should.equal('BWP: 0U');
    
    done();
  });

  it('should calculate IOB results correctly with 1.0 U IOB resulting in going low', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 100}, {mills: now, mgdl: 100}];
    ctx.ddata.treatments = [{mills: now, insulin: '1.0'}];
    
    var profile = {
      dia: 3
      , sens: 50
      , target_high: 200
      , target_low: 100
      , basal: 1
    };

    
    ctx.ddata.profiles = [profile];

    var sbx = prepareSandbox();
    var results = boluswizardpreview.calc(sbx);
    
    Math.round(results.effect).should.equal(50);
    results.effectDisplay.should.equal(50);
    Math.round(results.outcome).should.equal(50);
    results.outcomeDisplay.should.equal(50);
    Math.round(results.bolusEstimate).should.equal(-1);
    results.displayLine.should.equal('BWP: -1.00U');
    results.tempBasalAdjustment.thirtymin.should.equal(-100);
    results.tempBasalAdjustment.onehour.should.equal(0);
    
    done();
  });

 it('should calculate IOB results correctly with 1.0 U IOB resulting in going low in MMOL', function (done) {

    // boilerplate for client sandbox running in mmol

    var profileData = {
      dia: 3
      , units: 'mmol'
      , sens: 10
      , target_high: 10
      , target_low: 5.6
      , basal: 1
    };

    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
    };
    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 100}]};
    data.treatments = [{mills: now, insulin: '1.0'}];
    data.devicestatus = [];
    data.profile = require('../lib/profilefunctions')([profileData]);
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    var iob = require('../lib/plugins/iob')();
    sbx.properties.iob = iob.calcTotal(data.treatments, data.devicestatus, data.profile, now);

    var results = boluswizardpreview.calc(sbx);
    
    results.effect.should.equal(10);
    results.outcome.should.equal(-4.4);
    results.bolusEstimate.should.equal(-1);
    results.displayLine.should.equal('BWP: -1.00U');
    results.tempBasalAdjustment.thirtymin.should.equal(-100);
    results.tempBasalAdjustment.onehour.should.equal(0);
    
    done();
  });


 it('should calculate IOB results correctly with 0.45 U IOB resulting in going low in MMOL', function (done) {

    // boilerplate for client sandbox running in mmol

    var profileData = {
      dia: 3
      , units: 'mmol'
      , sens: 9
      , target_high: 6
      , target_low: 5
      , basal: 0.125
    };

    var sandbox = require('../lib/sandbox')();
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
    };
    var data = {sgvs: [{mills: before, mgdl: 175}, {mills: now, mgdl: 153}]};
    data.treatments = [{mills: now, insulin: '0.45'}];
    data.devicestatus = [];
    data.profile = require('../lib/profilefunctions')([profileData]);
    var sbx = sandbox.clientInit(ctx, Date.now(), data);
    var iob = require('../lib/plugins/iob')();
    sbx.properties.iob = iob.calcTotal(data.treatments, data.devicestatus, data.profile, now);

    var results = boluswizardpreview.calc(sbx);
    
    results.effect.should.equal(4.05);
    results.outcome.should.equal(4.45);
    Math.round(results.bolusEstimate*100).should.equal(-6);
    results.displayLine.should.equal('BWP: -0.07U');
    results.tempBasalAdjustment.thirtymin.should.equal(2);
    results.tempBasalAdjustment.onehour.should.equal(51);
    
    done();
  });


  it('Not trigger an alarm when in range', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 95}, {mills: now, mgdl: 100}];
    ctx.ddata.treatments = [];
    ctx.ddata.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);

    should.not.exist(ctx.notifications.findHighestAlarm());

    done();
  });

  it('trigger a warning when going out of range', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 175}, {mills: now, mgdl: 180}];
    ctx.ddata.treatments = [];
    ctx.ddata.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Warning, Check BG, time to bolus?');
    highest.message.should.equal('BG Now: 180 +5 ↗ mg/dl\nBG 15m: 187 mg/dl\nBWP: 0.66U');
    done();
  });

  it('trigger an urgent alarms when going too high', function (done) {
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 295}, {mills: now, mgdl: 300}];
    ctx.ddata.treatments = [];
    ctx.ddata.profiles = [profile];

    var sbx = prepareSandbox();
    boluswizardpreview.checkNotifications(sbx);
    ctx.notifications.findHighestAlarm().level.should.equal(levels.URGENT);

    done();
  });

  it('request a snooze when there is enough IOB', function (done) {

    ctx.notifications.resetStateForTests();
    ctx.notifications.initRequests();
    ctx.ddata.sgvs = [{mills: before, mgdl: 295}, {mills: now, mgdl: 300}];
    ctx.ddata.treatments = [{mills: before, insulin: '5.0'}];
    ctx.ddata.profiles = [profile];

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
    var ctx = {
      settings: {}
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.label.should.equal('BWP');
          options.value.should.equal('0.50U');
          done();
        }
      }
    };

    var loadedProfile = require('../lib/profilefunctions')();
    loadedProfile.loadData([profile]);

    var data = {
      sgvs: [{mills: before, mgdl: 295}, {mills: now, mgdl: 300}]
      , treatments: [{mills: before, insulin: '1.5'}]
      , devicestatus: []
      , profile: loadedProfile
    };

    var sbx = require('../lib/sandbox')().clientInit(ctx, Date.now(), data);

    iob.setProperties(sbx);
    boluswizardpreview.setProperties(sbx);
    boluswizardpreview.updateVisualisation(sbx);
  });

});
