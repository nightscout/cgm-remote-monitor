'use strict';

var _ = require('lodash');
var should = require('should');
var moment = require('moment');
const fs = require('fs');
const language = require('../lib/language')(fs);

var top_ctx = {
  language: language
  , settings: require('../lib/settings')()
};
top_ctx.language.set('en');
var env = require('../env')();
var levels = require('../lib/levels');
var profile = require('../lib/profilefunctions')();
top_ctx.levels = levels;
var pump = require('../lib/plugins/pump')(top_ctx);
var sandbox = require('../lib/sandbox')(top_ctx);

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

var profileData =
{
  'timezone': moment.tz.guess()
};

var statuses2 = [{
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
    reservoir_display_override: '50+U',
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
    reservoir_display_override: '50+U',
    clock: '2015-12-05T19:02:00.000Z'
  }
}];


var now = moment(statuses[1].created_at);

_.forEach(statuses, function updateMills (status) {
  status.mills = moment(status.created_at).valueOf();
});

_.forEach(statuses2, function updateMills (status) {
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
      , language: language
      , levels: levels
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

  it('use reservoir_display_override when available', function (done) {
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.label.should.equal('Pump');
          options.value.should.equal('50+U');
          done();
        }
      }
      , language: language
      , levels: levels
    };

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {devicestatus: statuses2});

    var unmockedOfferProperty = sbx.offerProperty;
    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('pump');
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
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: language
      , levels: levels
    };

    ctx.notifications.initRequests();

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: statuses
    });
    sbx.extendedSettings = { 'enableAlerts': true };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('Pump');
    should.not.exist(highest);

    done();
  });

  it('generate an alert when reservoir is low', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: language
      , levels: levels
    };

    ctx.notifications.initRequests();

    var lowResStatuses = _.cloneDeep(statuses);
    lowResStatuses[1].pump.reservoir = 0.5;

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: lowResStatuses
    });
    sbx.extendedSettings = { 'enableAlerts': true };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('Pump');
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('URGENT: Pump Reservoir Low');

    done();
  });

  it('generate an alert when reservoir is 0', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: language
      , levels: levels
    };

    ctx.notifications.initRequests();

    var lowResStatuses = _.cloneDeep(statuses);
    lowResStatuses[1].pump.reservoir = 0;

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: lowResStatuses
    });
    sbx.extendedSettings = { 'enableAlerts': true };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('Pump');
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('URGENT: Pump Reservoir Low');

    done();
  });


  it('generate an alert when battery is low', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: language
      , levels: levels
    };

    ctx.notifications.initRequests();

    var lowBattStatuses = _.cloneDeep(statuses);
    lowBattStatuses[1].pump.battery.voltage = 1.33;

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: lowBattStatuses
    });
    sbx.extendedSettings = { 'enableAlerts': true };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('Pump');
    highest.level.should.equal(levels.WARN);
    highest.title.should.equal('Warning, Pump Battery Low');

    done();
  });

  it('generate an urgent alarm when battery is really low', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: language
      , levels: levels
    };

    ctx.notifications.initRequests();

    var lowBattStatuses = _.cloneDeep(statuses);
    lowBattStatuses[1].pump.battery.voltage = 1.00;

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: lowBattStatuses
    });
    sbx.extendedSettings = { 'enableAlerts': true };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('Pump');
    highest.level.should.equal(levels.URGENT);
    highest.title.should.equal('URGENT: Pump Battery Low');

    done();
  });

  it('not generate a battery alarm during night when PUMP_WARN_BATT_QUIET_NIGHT is true', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
        , dayStart: 24 // Set to 24 so it always evaluates true in test
        , dayEnd: 21.0
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.label.should.equal('Pump');
          options.value.should.equal('86.4U');
          done();
        }
      }
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: require('../lib/language')()
      , levels: levels
    };

    ctx.notifications.initRequests();

    var lowBattStatuses = _.cloneDeep(statuses);
    lowBattStatuses[1].pump.battery.voltage = 1.00;

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {
      devicestatus: lowBattStatuses
      , profiles: [profileData]
    });
    profile.loadData(_.cloneDeep([profileData]));
    sbx.data.profile = profile;

    sbx.extendedSettings = {
      enableAlerts: true
      , warnBattQuietNight: true
    };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('Pump');
    should.not.exist(highest);

    done();
  });

  it('not generate an alert for a stale pump data, when there is an offline marker', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: language
      , levels: levels
    };

    ctx.notifications.initRequests();

    var sbx = sandbox.clientInit(ctx, now.add(1, 'hours').valueOf(), {
      devicestatus: statuses
      , treatments: [{eventType: 'OpenAPS Offline', mills: now.valueOf(), duration: 60}]
    });
    sbx.extendedSettings = { 'enableAlerts': true };
    pump.setProperties(sbx);
    pump.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('Pump');
    should.not.exist(highest);
    done();
  });

  it('should handle virtAsst requests', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, top_ctx)
      , language: language
      , levels: levels
    };
    
    ctx.language.set('en');
    var sbx = sandbox.clientInit(ctx, now.valueOf(), {devicestatus: statuses});
    pump.setProperties(sbx);

    pump.virtAsst.intentHandlers.length.should.equal(4);

    pump.virtAsst.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('Insulin Remaining');
      response.should.equal('You have 86.4 units remaining');

      pump.virtAsst.intentHandlers[1].intentHandler(function next(title, response) {
        title.should.equal('Pump Battery');
        response.should.equal('Your pump battery is at 1.52 volts');
        
        pump.virtAsst.intentHandlers[2].intentHandler(function next(title, response) {
          title.should.equal('Insulin Remaining');
          response.should.equal('You have 86.4 units remaining');
    
          pump.virtAsst.intentHandlers[3].intentHandler(function next(title, response) {
            title.should.equal('Pump Battery');
            response.should.equal('Your pump battery is at 1.52 volts');
            done();
          }, [], sbx);
          
        }, [], sbx);
          
      }, [], sbx);

    }, [], sbx);

  });

});
