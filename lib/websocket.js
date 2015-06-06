'use strict';

var ar2 = require('./plugins/ar2')();

Array.prototype.nsDiff = function(a) {
  var seen = {};
  var l = this.length;
  for (var i = 0; i < l; i++) { seen[this[i].x] = true };
  var result = [];
  l = a.length;
  for (var i = 0; i < l; i++) { if (!seen.hasOwnProperty(a[i].x)) result.push(a[i])};
  return result;
}

function uniq(a) {
  var seen = {};
  return a.filter(function(item) {
    return seen.hasOwnProperty(item.x) ? false : (seen[item.x] = true);
  });
}


function sort (values) {
  values.sort(function sorter (a, b) {
    return a.x - b.x;
  });
}

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
    if (patientData.cals) {
      console.log('running websocket.emitData', lastUpdated, patientDataUpdate.recentsgvs && patientDataUpdate.sgvdataupdate.length);
      io.sockets.emit('dataUpdate', patientDataUpdate);
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
      io.sockets.socket(socket.id).emit('dataUpdate',patientData);
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

	  if (!patientData.sgvs) {
	    console.log('First data load, setting patientData');
        patientData = d;
        patientData.predicted = forecast.predicted;
      } else {
        var delta = calculateDelta(d);
        if (delta.delta) {
          patientDataUpdate = delta;
          patientDataUpdate.predicted = forecast.predicted;
          console.log('patientData total sgv records', patientData.sgvs.length, ' (', JSON.stringify(patientData).length,'bytes)');
          if (delta.sgvs) console.log('patientData update sgv records', patientDataUpdate.sgvs.length, ' (', JSON.stringify(patientDataUpdate).length,'bytes)');
          emitData();
        } else {
          console.log('Delta calculation did not find new data');
        }
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

  function calculateDelta(d) {
  
    var delta = {'delta': true};
    var changesFound = false;
    
    // if there's no updates done so far, just return the full set
  	if (!patientData.sgvs) return d;
      
	var sgvDelta = patientData.sgvs.nsDiff(d.sgvs);
	
	if (sgvDelta.length > 0) {
	  changesFound = true;
	  sort(sgvDelta);
	  delta.sgvs = sgvDelta;
	};
    
    var treatmentDelta = patientData.treatments.nsDiff(d.treatments);
	
	if (treatmentDelta.length > 0) {
	  changesFound = true;
	  sort(treatmentDelta);
	  delta.treatments = treatmentDelta;
	};

    var mbgsDelta = patientData.mbgs.nsDiff(d.mbgs);
	
	if (mbgsDelta.length > 0) {
	  changesFound = true;
	  sort(mbgsDelta);
	  delta.mbgs = mbgsDelta;
	};

    var calsDelta = patientData.cals.nsDiff(d.cals);
	
	if (calsDelta.length > 0) {
	  changesFound = true;
	  sort(calsDelta);
	  delta.cals = calsDelta;
	};

    if (JSON.stringify(patientData.devicestatus) != JSON.stringify(d.devicestatus)) {
	  changesFound = true;
	  delta.devicestatus = d.devicestatus;
    };

    if (JSON.stringify(patientData.profile) != JSON.stringify(d.profile)) {
	  changesFound = true;
	  delta.profile = d.profile;
    };

	if (changesFound) return delta;
	
	return d;
      
  }
  
  start( );
  configure( );
  listeners( );

  return websocket();
}

module.exports = init;
