'use strict';

var _ = require('lodash');
var should = require('should');
var moment = require('moment');

var env = require('../env')();
var openaps = require('../lib/plugins/openaps')();
var sandbox = require('../lib/sandbox')();
var levels = require('../lib/levels');

var now = moment('2015-12-05T11:05:00-08:00');

var status = {
  mills: now.valueOf(),
  pump: {
    battery: {
      status: 'normal',
      voltage: 1.52
    },
    status: {
      status: 'normal',
      timestamp: '2015-12-05T18:59:37.000Z',
      bolusing: false,
      suspended: false
    },
    reservoir: 86.4,
    clock: '2015-12-05T10:58:47-08:00'
  },
  openaps: {
    suggested: {
      bg: 147,
      temp: 'absolute',
      snoozeBG: 125,
      timestamp: '2015-12-05T19:02:42.000Z',
      rate: 0.75,
      reason: 'Eventual BG 125>120, no temp, setting 0.75U/hr',
      eventualBG: 125,
      duration: 30,
      tick: '+1'
    },
    iob: {
      timestamp: '2015-12-05T19:02:42.000Z',
      bolusiob: 0,
      iob: 0.6068340736133333,
      activity: 0.016131569664902996
    },
    enacted: {
      bg: 147,
      temp: 'absolute',
      snoozeBG: 125,
      recieved: true,
      reason: 'Eventual BG 125>120, no temp, setting 0.75U/hr',
      rate: 0.75,
      eventualBG: 125,
      timestamp: '2015-12-05T19:03:00.000Z',
      duration: 30,
      tick: '+1'
    }
  }
};

describe('openaps', function ( ) {

  it('set the property and update the pill', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.label.should.equal('OpenAPS ⌁');
          options.value.should.equal('2m ago');
          var first = _.first(options.info);
          first.label.should.equal('1m ago');
          first.value.should.equal('Enacted');
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {devicestatus: [status]});

    var unmockedOfferProperty = sbx.offerProperty;
    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('openaps');
      var result = setter();
      should.exist(result);
      result.status.symbol.should.equal('⌁');
      result.status.code.should.equal('enacted');
      should.ok(result.status.when.isSame(now));

      sbx.offerProperty = unmockedOfferProperty;
      unmockedOfferProperty(name, setter);

    };

    openaps.setProperties(sbx);

    openaps.updateVisualisation(sbx);

  });

  it('check the recieved flag to see if it was received', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
    };

    ctx.notifications.initRequests();

    var notStatus = _.cloneDeep(status);
    notStatus.openaps.enacted.recieved = false;
    var sbx = require('../lib/sandbox')().clientInit(ctx, now, {devicestatus: [notStatus]});

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('openaps');
      var result = setter();
      should.exist(result);
      result.status.symbol.should.equal('x');
      result.status.code.should.equal('notenacted');
      should.ok(result.status.when.isSame(now));
      done();
    };

    openaps.setProperties(sbx);

  });

  it('generate an alert for a stuck loop', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
    };

    ctx.notifications.initRequests();

    var sbx = sandbox.clientInit(ctx, now.add(1, 'hours').valueOf(), {devicestatus: [status]});
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    openaps.setProperties(sbx);
    openaps.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('OpenAPS isn\'t looping');
    done();
  });

  it('not generate an alert for a stuck loop, when there is an offline marker', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
    };

    ctx.notifications.initRequests();

    var sbx = sandbox.clientInit(ctx, now.add(1, 'hours').valueOf(), {
      devicestatus: [status]
      , treatments: [{eventType: 'OpenAPS Offline', mills: now.valueOf(), duration: 60}]
    });
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    openaps.setProperties(sbx);
    openaps.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    should.not.exist(highest);
    done();
  });

});
