'use strict';

var ar2 = require('./plugins/ar2')();

function init (server) {

  function websocket ( ) {
    return websocket;
  }

  var FORTY_MINUTES = 2400000;
  
  var lastUpdated = 0;
  var patientData = {};
  var patientDataUpdate = {};

  var io;
  var watchers = 0;

  function start ( ) {
    io = require('socket.io').listen(server, {
      //these only effect the socket.io.js file that is sent to the client, but better than nothing
      'browser client minification': true,
      'browser client etag': true,
      'browser client gzip': false
    });
  }

  function emitData ( ) {
    if (patientData.cal) {
      console.log('running websocket.emitData', lastUpdated, patientDataUpdate.recentsgvs && patientDataUpdate.sgvdataupdate.length);
      io.sockets.emit("sgv", patientDataUpdate);
    }
  }

  function configure ( ) {
    // reduce logging
    io.set('log level', 0);

    //TODO: make websockets support an option
    io.configure(function () {
      io.set('transports', ['xhr-polling']);
    });
  }

  function listeners ( ) {
    io.sockets.on('connection', function (socket) {
      // send all data upon new connection
      io.sockets.socket(socket.id).emit('sgv',patientData);
      io.sockets.emit('clients', ++watchers);
      socket.on('ack', function(alarmType, silenceTime) {
        ackAlarm(alarmType, silenceTime);
        if (alarmType == 'urgent_alarm') {
          //also clean normal alarm so we don't get a double alarm as BG comes back into range
          ackAlarm('alarm', silenceTime);
        }
        io.sockets.emit('clear_alarm', true);
        console.log('alarm cleared');
      });
      socket.on('disconnect', function () {
        io.sockets.emit('clients', --watchers);
      });
    });
  }

  ///////////////////////////////////////////////////
  // data handling functions
  ///////////////////////////////////////////////////

  var Alarm = function(_typeName, _threshold) {
    this.typeName = _typeName;
    this.silenceTime = FORTY_MINUTES;
    this.lastAckTime = 0;
    this.threshold = _threshold;
  };

// list of alarms with their thresholds
  var alarms = {
    'alarm' : new Alarm('Regular', 0.05),
    'urgent_alarm': new Alarm('Urgent', 0.10)
  };

  function ackAlarm(alarmType, silenceTime) {
    var alarm = alarms[alarmType];
    if (!alarm) {
      console.warn('Got an ack for an unknown alarm time');
      return;
    }
    alarm.lastAckTime = new Date().getTime();
    alarm.silenceTime = silenceTime ? silenceTime : FORTY_MINUTES;
    delete alarm.lastEmitTime;
  }

  //should only be used when auto acking the alarms after going back in range or when an error corrects
  //setting the silence time to 1ms so the alarm will be retriggered as soon as the condition changes
  //since this wasn't ack'd by a user action
  function autoAckAlarms() {
    var sendClear = false;
    for (var alarmType in alarms) {
      if (alarms.hasOwnProperty(alarmType)) {
        var alarm = alarms[alarmType];
        if (alarm.lastEmitTime) {
          console.info('auto acking ' + alarmType);
          ackAlarm(alarmType, 1);
          sendClear = true;
        }
      }
    }
    if (sendClear) {
      io.sockets.emit('clear_alarm', true);
      console.info('emitted clear_alarm to all clients');
    }
  }

  function emitAlarm (alarmType) {
    var alarm = alarms[alarmType];
    if (lastUpdated > alarm.lastAckTime + alarm.silenceTime) {
      io.sockets.emit(alarmType);
      alarm.lastEmitTime = lastUpdated;
      console.info('emitted ' + alarmType + ' to all clients');
    } else {
      console.log(alarm.typeName + ' alarm is silenced for ' + Math.floor((alarm.silenceTime - (lastUpdated - alarm.lastAckTime)) / 60000) + ' minutes more');
    }
  }

  websocket.processData = function processData (env, ctx) {

    var d = ctx.data;
    lastUpdated = d.lastUpdated;

    console.log('running websocket.loadData');

    var lastSGV = d.sgvs.length > 0 ? d.sgvs[d.sgvs.length - 1].y : null;

    if (lastSGV) {
      var forecast = ar2.forecast(env, ctx);

      // consolidate and send the data to the client
      if (is_different(d)) {

        patientDataUpdate = {
          'sgvdataupdate': d.recentsgvs
          , 'predicted': forecast.predicted
          , 'mbg': d.mbgs
          , 'treatmentdataupdate': d.recentTreatments
          , 'cal': d.cals
          , 'devicestatusData': d.devicestatus
          };

        patientData = {
          'actual': d.sgvs
          , 'predicted': forecast.predicted
          , 'mbg': d.mbgs
          , 'treatment': d.treatments
          , 'profile': d.profile
          , 'cal': d.cals
          , 'devicestatusData': d.devicestatus
          };

        console.log('patientData total sgv records', patientData.actual.length, ' (', JSON.stringify(patientData).length,'bytes)');
        console.log('patientData update sgv records', patientDataUpdate.sgvdataupdate.length, ' (', JSON.stringify(patientDataUpdate).length,'bytes)');

//        patientData = [d.sgvs, forecast.predicted, d.mbgs, d.treatments, d.profile, d.cals, d.devicestatus];
        emitData();
      }
      
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


  function is_different (data) {
  
  	if (!patientData.actual) return true;
  	
    var old =  {
      sgv: patientData.actual.slice(-1).pop( )
      , mbg: patientData.mbg.slice(-1).pop( )
      , treatment: patientData.treatment.slice(-1).pop( )
      , cal: patientData.cal.slice(-1).pop( )
    };
    var last = {
      sgv: data.sgvs.slice(-1).pop( )
      , mbg: data.mbgs.slice(-1).pop( )
      , treatment: data.treatments.slice(-1).pop( )
      , cal: data.cals.slice(-1).pop( )
    };

    // textual diff of objects
    if (JSON.stringify(old) == JSON.stringify(last)) {
      console.info('data is NOT different, will not send to clients');
      return false;
    }
    return true;
  }

  start( );
  configure( );
  listeners( );

  return websocket();
}

module.exports = init;
