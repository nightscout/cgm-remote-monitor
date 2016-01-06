'use strict';

var _ = require('lodash');
var should = require('should');
var moment = require('moment');

var env = require('../env')();
var pump = require('../lib/plugins/pump')();
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

describe('pump', function ( ) {

  it('set the property and update the pill', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.label.should.equal('Res');
          options.value.should.equal('86.4U');
          var first = _.first(options.info);
          first.label.should.equal('Battery');
          first.value.should.equal('1.52v');
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {devicestatus: [status]});

    var unmockedOfferProperty = sbx.offerProperty;
    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('pump');
      var result = setter();
      should.exist(result);
      result.status.level.should.equal(levels.NONE);
      result.status.voltage.should.equal(1.52);
      result.status.reservoir.should.equal(86.4);

      sbx.offerProperty = unmockedOfferProperty;
      unmockedOfferProperty(name, setter);

    };

    pump.setProperties(sbx);

    pump.updateVisualisation(sbx);

  });

  it('not generate an alert when pump is ok', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
    };

    ctx.notifications.initRequests();

    var sbx = sandbox.clientInit(ctx, now.add(1, 'hours').valueOf(), {
      devicestatus: [status]
    });
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    should.not.exist(highest);

    done();
  });

  it('generate an alert when battery is low', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
    };

    ctx.notifications.initRequests();

    var lowBattStatus = _.cloneDeep(status);
    lowBattStatus.pump.battery.voltage = 1.33;

    var sbx = sandbox.clientInit(ctx, now.add(1, 'hours').valueOf(), {
      devicestatus: [lowBattStatus]
    });
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Warning, Pump Battery Low');

    done();
  });

  it('generate an urgent alarm when battery is really low', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
    };

    ctx.notifications.initRequests();

    var lowBattStatus = _.cloneDeep(status);
    lowBattStatus.pump.battery.voltage = 1.00;

    var sbx = sandbox.clientInit(ctx, now.add(1, 'hours').valueOf(), {
      devicestatus: [lowBattStatus]
    });
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('URGENT: Pump Battery Low');

    done();
  });

});
