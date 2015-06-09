'use strict';

var ar2 = require('./plugins/ar2')();

var THIRTY_MINUTES = 30 * 60 * 1000;

var Alarm = function(_typeName, _threshold) {
  this.typeName = _typeName;
  this.silenceTime = THIRTY_MINUTES;
  this.lastAckTime = 0;
  this.threshold = _threshold;
};

// list of alarms with their thresholds
var alarms = {
  'alarm' : new Alarm('Regular', 0.05),
  'urgent_alarm': new Alarm('Urgent', 0.10)
};

function init (env, ctx) {
  function notifications () {
    return notifications;
  }

  //should only be used when auto acking the alarms after going back in range or when an error corrects
  //setting the silence time to 1ms so the alarm will be retriggered as soon as the condition changes
  //since this wasn't ack'd by a user action
  function autoAckAlarms() {
    var sendClear = false;
    for (var type in alarms) {
      if (alarms.hasOwnProperty(type)) {
        var alarm = alarms[type];
        if (alarm.lastEmitTime) {
          console.info('auto acking ' + type);
          notifications.ack(type, 1);
          sendClear = true;
        }
      }
    }
    if (sendClear) {
      ctx.bus.emit('notification', {clear: true});
      console.info('emitted notification clear');
    }
  }

  function emitAlarm (type) {
    var alarm = alarms[type];
    if (ctx.data.lastUpdated > alarm.lastAckTime + alarm.silenceTime) {
      ctx.bus.emit('notification', {type: type});
      alarm.lastEmitTime = ctx.data.lastUpdated;
      console.info('emitted notification:' + type);
    } else {
      console.log(alarm.typeName + ' alarm is silenced for ' + Math.floor((alarm.silenceTime - (ctx.data.lastUpdated - alarm.lastAckTime)) / 60000) + ' minutes more');
    }
  }

  notifications.processData = function processData ( ) {
    var d = ctx.data;

    console.log('running notifications.processData');

    var lastSGV = d.sgvs.length > 0 ? d.sgvs[d.sgvs.length - 1].y : null;

    if (lastSGV) {
      var forecast = ar2.forecast(env, ctx);

      var emitAlarmType = null;

      if (env.alarm_types.indexOf('simple') > -1) {
        if (lastSGV > env.thresholds.bg_high) {
          emitAlarmType = 'urgent_alarm';
          console.info(lastSGV + ' > ' + env.thresholds.bg_high + ' will emmit ' + emitAlarmType);
        } else if (lastSGV > env.thresholds.bg_target_top) {
          emitAlarmType = 'alarm';
          console.info(lastSGV + ' > ' + env.thresholds.bg_target_top + ' will emmit ' + emitAlarmType);
        } else if (lastSGV < env.thresholds.bg_low) {
          emitAlarmType = 'urgent_alarm';
          console.info(lastSGV + ' < ' + env.thresholds.bg_low + ' will emmit ' + emitAlarmType);
        } else if (lastSGV < env.thresholds.bg_target_bottom) {
          emitAlarmType = 'alarm';
          console.info(lastSGV + ' < ' + env.thresholds.bg_target_bottom + ' will emmit ' + emitAlarmType);
        }
      }

      if (!emitAlarmType && env.alarm_types.indexOf('predict') > -1) {
        if (forecast.avgLoss > alarms['urgent_alarm'].threshold) {
          emitAlarmType = 'urgent_alarm';
          console.info('Avg Loss:' + forecast.avgLoss + ' > ' + alarms['urgent_alarm'].threshold + ' will emmit ' + emitAlarmType);
        } else if (forecast.avgLoss > alarms['alarm'].threshold) {
          emitAlarmType = 'alarm';
          console.info('Avg Loss:' + forecast.avgLoss + ' > ' + alarms['alarm'].threshold + ' will emmit ' + emitAlarmType);
        }
      }

      if (d.sgvs.length > 0 && d.sgvs[d.sgvs.length - 1].y < 39) {
        emitAlarmType = 'urgent_alarm';
      }

      if (emitAlarmType) {
        emitAlarm(emitAlarmType);
      } else {
        autoAckAlarms();
      }
    }
  };

  notifications.ack = function ack (type, time) {
    var alarm = alarms[type];
    if (alarm) {
      console.info('Got an ack for: ', alarm, 'time: ' + time);
    } else {
      console.warn('Got an ack for an unknown alarm time');
      return;
    }
    alarm.lastAckTime = new Date().getTime();
    alarm.silenceTime = time ? time : THIRTY_MINUTES;
    delete alarm.lastEmitTime;

  };

  return notifications();
}

module.exports = init;