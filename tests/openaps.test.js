'use strict';

var _ = require('lodash');
var should = require('should');
var moment = require('moment');

var ctx = {
  language: require('../lib/language')()
};
var env = require('../env')();
var openaps = require('../lib/plugins/openaps')(ctx);
var sandbox = require('../lib/sandbox')();
var levels = require('../lib/levels');

var statuses = [{
  created_at: '2015-12-05T19:05:00.000Z',
  device: 'openaps://abusypi'
  , pump: {
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
  mmtune: {
    scanDetails: [
      ['916.640',4,-64]
      , ['916.660',5,-55]
      , ['916.680',5,-59]
    ]
    , setFreq: 916.66
    , timestamp:' 2015-12-05T18:59:37.000Z'
    , usedDefault: false
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
      tick: '+1',
      predBGs: {
        IOB: [100, 100, 100, 100]
        , aCOB: [100, 100, 100, 100]
        , COB: [100, 100, 100, 100]
      }
    }
  }
}
, {
  created_at: '2015-12-05T18:05:00.000Z',
  device: 'openaps://awaitingpi'
  , pump: {
    battery: {
      status: 'normal',
      voltage: 1.52
    },
    status: {
      status: 'normal',
      timestamp: '2015-12-05T16:59:37.000Z',
      bolusing: false,
      suspended: false
    },
    reservoir: 86.4,
    clock: '2015-12-05T08:58:47-08:00'
  },
  openaps: {
    suggested: {
      bg: 147,
      temp: 'absolute',
      snoozeBG: 125,
      timestamp: '2015-12-05T16:02:42.000Z',
      rate: 0.75,
      reason: 'Eventual BG 125>120, no temp, setting 0.75U/hr',
      eventualBG: 125,
      duration: 30,
      tick: '+1'
    },
    iob: {
      timestamp: '2015-12-05T16:02:42.000Z',
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
      timestamp: '2015-12-05T16:03:00.000Z',
      duration: 30,
      tick: '+1'
    }
  }
}
,{
    "_id": {
        "$oid": "59aef8cb444d1500109fc8fd"
    },
    "device": "openaps://edi1",
    "openaps": {
        "iob": {
            "iob": 1.016,
            "activity": 0.0143,
            "bolussnooze": 0,
            "basaliob": 0.893,
            "netbasalinsulin": 0.7,
            "hightempinsulin": 2.5,
            "microBolusInsulin": 1.7,
            "microBolusIOB": 0.933,
            "lastBolusTime": 1504638182000,
            "timestamp": "2017-09-05T19:18:31.000Z"
        },
        "suggested": {
            "insulinReq": -0.06,
            "bg": 117,
            "reservoir": "104.5",
            "temp": "absolute",
            "snoozeBG": 80,
            "rate": 0.75,
            "minPredBG": 78,
            "IOB": 1.016,
            "reason": "COB: 0, Dev: -6, BGI: -2.22, ISF: 31, Target: 80, minPredBG 78, IOBpredBG 78; Eventual BG 80 >= 80,  insulinReq -0.06. temp 0.2<0.75U/hr. ",
            "COB": 0,
            "eventualBG": 80,
            "duration": 30,
            "tick": -3,
            "deliverAt": "2017-09-05T19:18:43.563Z",
            "timestamp": "2017-09-05T19:18:43.000Z"
        },
        "enacted": {
            "insulinReq": -0.06,
            "received": true,
            "bg": 117,
            "reservoir": "104.5",
            "temp": "absolute",
            "snoozeBG": 80,
            "timestamp": "2017-09-05T19:18:49.000Z",
            "predBGs": {
                "IOB": [
                    117,
                    114,
                    111,
                    108,
                    106,
                    104,
                    102,
                    100,
                    98,
                    97,
                    96,
                    95,
                    94,
                    93,
                    92,
                    91,
                    90,
                    89,
                    88,
                    87,
                    86,
                    86,
                    85,
                    84,
                    83,
                    83,
                    82,
                    81,
                    81,
                    81,
                    80,
                    80,
                    79,
                    79,
                    79,
                    79,
                    78
                ]
            },
            "minPredBG": 78,
            "deliverAt": "2017-09-05T19:18:43.563Z",
            "duration": 30,
            "rate": 0.75,
            "COB": 0,
            "eventualBG": 80,
            "reason": "COB: 0, Dev: -6, BGI: -2.22, ISF: 31, Target: 80, minPredBG 78, IOBpredBG 78; Eventual BG 80 >= 80,  insulinReq -0.06. temp 0.2<0.75U/hr. ",
            "tick": -3,
            "IOB": 1.016
        }
    },
    "pump": {
        "clock": "2017-09-05T21:18:31+02:00",
        "battery": {
            "status": "normal",
            "voltage": 1.55
        },
        "reservoir": 104.5,
        "status": {
            "status": "normal",
            "bolusing": false,
            "suspended": false,
            "timestamp": "2017-09-05T19:18:29.000Z"
        }
    },
    "uploader": {
        "batteryVoltage": 4131,
        "battery": 95
    },
    "created_at": "2017-09-05T19:19:39.899Z"
}];

var now = moment(statuses[0].created_at);

_.forEach(statuses, function updateMills (status) {
  status.mills = moment(status.created_at).valueOf();
});

describe('openaps', function ( ) {

  it('set the property and update the pill and add forecast points', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.label.should.equal('OpenAPS ⌁');
          options.value.should.equal('2m ago');
          var first = _.first(options.info);
          first.label.should.equal('1m ago');
          first.value.should.equal('abusypi ⌁ Enacted @ -55dB');
          var last = _.last(options.info);
          last.label.should.equal('1h ago');
          last.value.should.equal('awaitingpi ◉ Waiting');
        }
        , addForecastPoints: function mockAddForecastPoints (points) {
          points.length.should.equal(12);
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {devicestatus: statuses});

    var unmockedOfferProperty = sbx.offerProperty;
    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('openaps');
      var result = setter();
      should.exist(result);

      result.status.symbol.should.equal('⌁');
      result.status.code.should.equal('enacted');

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

    var notStatuses = _.cloneDeep(statuses);
    notStatuses[0].openaps.enacted.recieved = false;
    var sbx = require('../lib/sandbox')().clientInit(ctx, now, {devicestatus: notStatuses});

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('openaps');
      var result = setter();
      should.exist(result);
      result.status.symbol.should.equal('x');
      result.status.code.should.equal('notenacted');
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

    var sbx = sandbox.clientInit(ctx, now.clone().add(1, 'hours').valueOf(), {devicestatus: statuses});
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    openaps.setProperties(sbx);
    openaps.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('OpenAPS');
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

    var sbx = sandbox.clientInit(ctx, now.clone().add(1, 'hours').valueOf(), {
      devicestatus: statuses
      , treatments: [{eventType: 'OpenAPS Offline', mills: now.valueOf(), duration: 60}]
    });
    sbx.extendedSettings = { 'enableAlerts': 'TRUE' };
    openaps.setProperties(sbx);
    openaps.checkNotifications(sbx);

    var highest = ctx.notifications.findHighestAlarm('OpenAPS');
    should.not.exist(highest);
    done();
  });

  it('should handle alexa requests', function (done) {
    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , notifications: require('../lib/notifications')(env, ctx)
      , language: require('../lib/language')()
    };

    var sbx = sandbox.clientInit(ctx, now.valueOf(), {devicestatus: statuses});
    openaps.setProperties(sbx);

    openaps.alexa.intentHandlers.length.should.equal(2);

    openaps.alexa.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('Loop Forecast');
      response.should.equal('The OpenAPS Eventual BG is 125');

      openaps.alexa.intentHandlers[1].intentHandler(function next(title, response) {
        title.should.equal('Last loop');
        response.should.equal('The last successful loop was 2 minutes ago');
        done();
      }, [], sbx);

    }, [], sbx);

  });

});
