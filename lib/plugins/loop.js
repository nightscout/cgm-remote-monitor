'use strict';

var _ = require('lodash');
var moment = require('moment');
var times = require('../times');
var levels = require('../levels');

// var ALL_STATUS_FIELDS = ['status-symbol', 'status-label', 'iob', 'freq', 'rssi']; Unused variable

function init(ctx) {
  var timeago = require('./timeago')(ctx);

  var loop = {
    name: 'loop'
    , label: 'Loop'
    , pluginType: 'pill-status'
  };

  var firstPrefs = true;

  loop.getPrefs = function getPrefs(sbx) {

    var prefs = {
      warn: sbx.extendedSettings.warn ? sbx.extendedSettings.warn : 30
      , urgent: sbx.extendedSettings.urgent ? sbx.extendedSettings.urgent : 60
      , enableAlerts: sbx.extendedSettings.enableAlerts
    };

    if (firstPrefs) {
      firstPrefs = false;
      console.info(' Prefs:', prefs);
    }

    return prefs;
  };

  loop.setProperties = function setProperties (sbx) {
    sbx.offerProperty('loop', function setLoop ( ) {
      return loop.analyzeData(sbx);
    });
  };

  loop.analyzeData = function analyzeData (sbx) {
    var recentHours = 6;
    var recentMills = sbx.time - times.hours(recentHours).msecs;

    var recentData = _.chain(sbx.data.devicestatus)
      .filter(function (status) {
        return ('loop' in status) && sbx.entryMills(status) <= sbx.time && sbx.entryMills(status) >= recentMills;
      }).value( );

    var prefs = loop.getPrefs(sbx);
    var recent = moment(sbx.time).subtract(prefs.warn / 2, 'minutes');

    function getDisplayForStatus (status)  {

      var desc = {
        symbol: '⚠'
        , code: 'warning'
        , label: 'Warning'
      };

      if (!status) {
        return desc;
      }

      if (status.failureReason || (status.enacted && !status.enacted.received)) {
        desc.symbol = 'x';
        desc.code = 'error';
        desc.label = 'Error';
      } else if (status.enacted && moment(status.timestamp).isAfter(recent)) {
        desc.symbol = '⌁';
        desc.code = 'enacted';
        desc.label = 'Enacted';
      } else if (status.recommendedTempBasal && moment(status.recommendedTempBasal.timestamp).isAfter(recent)) {
        desc.symbol = '⏀';
        desc.code = 'recommendation';
        desc.label = 'Recomendation';
      } else if (status.moment && status.moment.isAfter(recent)) {
        desc.symbol = '↻';
        desc.code = 'looping';
        desc.label = 'Looping';
      }
      return desc;
    }

    var result = {
      lastLoop: null
      , lastEnacted: null
      , lastPredicted: null
      , lastOkMoment: null
    };

    function assignLastEnacted (loopStatus) {
      var enacted = loopStatus.enacted;
      if (enacted && enacted.timestamp) {
        enacted.moment = moment(enacted.timestamp);
        if (!result.lastEnacted || enacted.moment.isAfter(result.lastEnacted.moment)) {
          result.lastEnacted = enacted;
        }
      }
    }

    function assignLastPredicted (loopStatus) {
      if (loopStatus.predicted && loopStatus.predicted.startDate) {
        result.lastPredicted = loopStatus.predicted;
      }
    }

    function assignLastLoop (loopStatus) {
      if (!result.lastLoop || loopStatus.moment.isAfter(result.lastLoop.moment)) {
        result.lastLoop = loopStatus;
      }
    }

    function assignLastOkMoment (loopStatus) {
      if (!loopStatus.failureReason && (!result.lastOkMoment || loopStatus.moment.isAfter(result.lastOkMoment))) {
        result.lastOkMoment = loopStatus.moment;
      }
    }

    _.forEach(recentData, function eachStatus (status) {
      if (status && status.loop && status.loop.timestamp) {
        var loopStatus = status.loop;
        loopStatus.moment = moment(loopStatus.timestamp);
        assignLastEnacted(loopStatus);
        assignLastLoop(loopStatus);
        assignLastPredicted(loopStatus);
        assignLastOkMoment(loopStatus);
      }
    });

    result.display = getDisplayForStatus(result.lastLoop);

    return result;
  };

  loop.checkNotifications = function checkNotifications(sbx) {
    var prefs = loop.getPrefs(sbx);

    if (!prefs.enableAlerts) { return; }

    var prop = sbx.properties.loop;

    if (!prop.lastLoop) {
      console.info('Loop hasn\'t reported a loop yet');
      return;
    }

    var now = moment();
    var level = statusLevel(prop, prefs, sbx);
    if (level >= levels.WARN) {
      sbx.notifications.requestNotify({
        level: level
        , title: 'Loop isn\'t looping'
        , message: 'Last Loop: ' + formatAgo(prop.lastLoop.moment, now.valueOf())
        , pushoverSound: 'echo'
        , group: 'Loop'
        , plugin: loop
        , debug: prop
      });
    }
  };

  loop.updateVisualisation = function updateVisualisation (sbx) {
    var prop = sbx.properties.loop;

    var prefs = loop.getPrefs(sbx);

    function valueString (prefix, value) {
      return (value != null) ? prefix + value : '';
    }

    var events = [ ];

    function addRecommendedTempBasal() {
      if (prop.lastLoop && prop.lastLoop.recommendedTempBasal) {

        var recommendedTempBasal = prop.lastLoop.recommendedTempBasal;

        var valueParts = [
          'Suggested Temp: ' + recommendedTempBasal.rate + 'U/hour for ' +
          recommendedTempBasal.duration + 'm'
        ];

        valueParts = concatIOB(valueParts);
        valueParts = concatCOB(valueParts);

        events.push({
          time: moment(recommendedTempBasal.timestamp)
          , value: valueParts.join('')
        });
      }
    }

    function addLastEnacted() {
      if (prop.lastEnacted) {
        var canceled = prop.lastEnacted.rate === 0 && prop.lastEnacted.duration === 0;

        var valueParts = [
          , '<b>Temp Basal' + (canceled ? ' Canceled' : ' Started') + '</b>'
          , canceled ? '' : ' ' + prop.lastEnacted.rate.toFixed(2) + 'U/hour for ' + prop.lastEnacted.duration + 'm'
          , valueString(', ', prop.lastEnacted.reason)
        ];

        valueParts = concatIOB(valueParts);
        valueParts = concatCOB(valueParts);

        events.push({
          time: prop.lastEnacted.moment
          , value: valueParts.join('')
        });
      }
    }

    function concatIOB (valueParts) {
      if (prop.lastLoop && prop.lastLoop.iob) {
        var iob = prop.lastLoop.iob;
        valueParts = valueParts.concat([
          ', IOB: '
          , sbx.roundInsulinForDisplayFormat(iob.iob) + 'U'
          , iob.basaliob ? ', Basal IOB ' + sbx.roundInsulinForDisplayFormat(iob.basaliob) + 'U' : ''
        ]);
      }

      return valueParts;
    }

    function concatCOB (valueParts) {
      if (prop.lastLoop && prop.lastLoop.cob) {
        var cob = prop.lastLoop.cob;
        var cob = prop.lastLoop.cob.cob;
        cob = Math.round(cob); 
        valueParts = valueParts.concat([
          ', COB: '
          , cob + 'g'
        ]);
      }

      return valueParts;
    }

    function getForecastPoints ( ) {
      var points = [ ];

      function toPoints (startTime, offset) {
        return  function toPoint (value, index) {
          return {
            mgdl: value
            , color: '#ff00ff'
            , mills: startTime.valueOf() + times.mins(5 * index).msecs + offset
            , noFade: true
          };
        };
      }

      if (prop.lastPredicted) {
        var predicted = prop.lastPredicted;
        var startTime = moment(predicted.startDate);
        if (predicted.values) {
          points = points.concat(_.map(predicted.values, toPoints(startTime, 0)));
        }
        // if (prop.lastPredBGs.IOB) {
        //   points = points.concat(_.map(prop.lastPredBGs.IOB, toPoints(moment, 3000)));
        // }
        // if (prop.lastPredBGs.COB) {
        //   points = points.concat(_.map(prop.lastPredBGs.COB, toPoints(moment, 7000)));
        // }
      }

      return points;
    }

    if ('error' === prop.display.code) {
      events.push({
        time: prop.lastLoop.moment
        , value: valueString('Error: ', prop.lastLoop.failureReason)
      });
      addRecommendedTempBasal();
    } else if ('enacted' === prop.display.code) {
      addLastEnacted();
    } else if ('looping' === prop.display.code) {
      addLastEnacted();
    } else {
      addRecommendedTempBasal();
    }

    var sorted = _.sortBy(events, function toMill(event) {
      return event.time.valueOf();
    }).reverse();

    var info = _.map(sorted, function eventToInfo (event) {
      return {
        label: timeAt(false, sbx) + timeFormat(event.time, sbx)
        , value: event.value
      };
    });

    var loopName = 'Loop';

    if (prop.lastLoop && prop.lastLoop.name) {
      loopName = prop.lastLoop.name;
    }

    var label = loopName + ' ' + prop.display.symbol;

    var lastLoopMoment = prop.lastLoop ? prop.lastLoop.moment : null;

    sbx.pluginBase.updatePillText(loop, {
      value: timeFormat(lastLoopMoment, sbx)
      , label: label
      , info: info
      , pillClass: statusClass(prop, prefs, sbx)
    });

    var forecastPoints = getForecastPoints();
    if (forecastPoints && forecastPoints.length > 0) {
      sbx.pluginBase.addForecastPoints(forecastPoints, {type: 'loop', label: 'Loop Forecasts'});
    }
  };

  function alexaForecastHandler (next, slots, sbx) {
    if (sbx.properties.loop.lastLoop.predicted) {
      var forecast = sbx.properties.loop.lastLoop.predicted.values;
      var max = forecast[0];
      var min = forecast[0];
      var maxForecastIndex = Math.min(6, forecast.length);

      var startPrediction = moment(sbx.properties.loop.lastLoop.predicted.startDate);
      var endPrediction = startPrediction.clone().add(maxForecastIndex * 5, 'minutes');
      if (endPrediction.valueOf() < sbx.time) {
        next('Loop Forecast', 'Unable to forecast with the data that is available');
      } else {
        for (var i = 1, len = forecast.slice(0, maxForecastIndex).length; i < len; i++) {
          if (forecast[i] > max) {
            max = forecast[i];
          }
          if (forecast[i] < min) {
            min = forecast[i];
          }
        }
        var value = '';
        if (min === max) {
          value = 'around ' + max;
        } else {
          value = 'between ' + min + ' and ' + max;
        }
        var response = 'According to the loop forecast you are expected to be ' + value + ' over the next ' + moment(endPrediction).from(moment(sbx.time));
        next('Loop Forecast', response);
      }
    } else {
      next('Loop forecast', 'Loop plugin does not seem to be enabled');
    }
  }

  function alexaLastLoopHandler(next, slots, sbx) {
    console.log(JSON.stringify(sbx.properties.loop.lastLoop));
    var response = 'The last successful loop was ' + moment(sbx.properties.loop.lastOkMoment).from(moment(sbx.time));
    next('Last loop', response);
  }

  loop.alexa = {
    intentHandlers: [{
      intent: 'MetricNow'
      , routableSlot: 'metric'
      , slots: ['loop forecast', 'forecast']
      , intentHandler: alexaForecastHandler
    }, {
      intent: 'LastLoop'
      , intentHandler: alexaLastLoopHandler
    }]
  };

  function statusClass (prop, prefs, sbx) {
    var level = statusLevel(prop, prefs, sbx);
    var cls = 'current';

    if (level === levels.WARN) {
      cls = 'warn';
    } else if (level === levels.URGENT) {
      cls = 'urgent';
    }

    return cls;
  }

  function statusLevel (prop, prefs, sbx) {
    var level = levels.NONE;
    var now = moment(sbx.time);

    if (prop.lastOkMoment) {
      var urgentTime = prop.lastOkMoment.clone().add(prefs.urgent, 'minutes');
      var warningTime = prop.lastOkMoment.clone().add(prefs.warn, 'minutes');

      if (urgentTime.isBefore(now)) {
        level = levels.URGENT;
      } else if (warningTime.isBefore(now)) {
        level = levels.WARN;
      }
    }

    return level;
  }

  function timeFormat (m, sbx) {

    var when;
    if (m && sbx.data.inRetroMode) {
      when = m.format('LT');
    } else if (m) {
      when = formatAgo(m, sbx.time);
    } else {
      when = 'unknown';
    }

    return when;
  }

  function formatAgo (m, nowMills) {
    var ago = timeago.calcDisplay({mills: m.valueOf()}, nowMills);
    return (ago.value ? ago.value : '') + ago.shortLabel + (ago.shortLabel.length === 1 ? ' ago' : '');
  }

  function timeAt (prefix, sbx) {
    return sbx.data.inRetroMode ? (prefix ? ' ' : '') + '@ ' : (prefix ? ', ' : '');
  }

  return loop;

}


module.exports = init;
