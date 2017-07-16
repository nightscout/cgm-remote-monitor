'use strict';

var _ = require('lodash');
var should = require('should');
var moment = require('moment');

var env = require('../env')();
var pump = require('../lib/plugins/pump')();
var sandbox = require('../lib/sandbox')();
var levels = require('../lib/levels');

var statuses = [{
  created_at: '2015-12-05T17:35:00.000Z'
  , device: 'openaps://farawaypi'
  , pump: {
    battery: {
      status: 'normal',
      voltage: 1.52
    },
    status: {
      status: 'normal',
      bolusing: false,
      suspended: false
    },
    reservoir: 86.4,
    clock: '2015-12-05T17:32:00.000Z'
  }
}, {
  created_at: '2015-12-05T19:05:00.000Z'
  , device: 'openaps://abusypi'
  , pump: {
    battery: {
      status: 'normal',
      voltage: 1.52
    },
    status: {
      status: 'normal',
      bolusing: false,
      suspended: false
    },
    reservoir: 86.4,
    clock: '2015-12-05T19:02:00.000Z'
  }
}];

var now = moment(statuses[1].created_at);

_.forEach(statuses, function updateMills (status) {
  status.mills = moment(status.created_at).valueOf();
});

describe('pump', function ( ) {

  it('set the property and update the pill', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.label.should.equal('Pump');
          options.value.should.equal('86.4U');
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {devicestatus: statuses});

    var unmockedOfferProperty = sbx.offerProperty;
    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('pump');
      var result = setter();
      should.exist(result);
      result.data.level.should.equal(levels.NONE);
      result.data.battery.value.should.equal(1.52);
      result.data.reservoir.value.should.equal(86.4);

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

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: statuses
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

    var lowBattStatuses = _.cloneDeep(statuses);
    lowBattStatuses[1].pump.battery.voltage = 1.33;

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: lowBattStatuses
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

    var lowBattStatuses = _.cloneDeep(statuses);
    lowBattStatuses[1].pump.battery.voltage = 1.00;

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: lowBattStatuses
    });
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('URGENT: Pump Battery Low');

    done();
  });

  it('not generate an alert for a stale pump data, when there is an offline marker', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
    };

    ctx.notifications.initRequests();

    var sbx = sandbox.clientInit(ctx, now.add(1, 'hours').valueOf(), {
      devicestatus: statuses
      , treatments: [{eventType: 'OpenAPS Offline', mills: now.valueOf(), duration: 60}]
    });
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm();
    should.not.exist(highest);
    done();
  });

});
