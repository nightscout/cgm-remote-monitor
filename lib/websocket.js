'use strict';

var ar2 = require('./plugins/ar2')();

function nsArrayDiff(oldArray, newArray) {
  var seen = {};
  var l = oldArray.length;
  for (var i = 0; i < l; i++) { seen[oldArray[i].x] = true };
  var result = [];
  l = newArray.length;
  for (var i = 0; i < l; i++) { if (!seen.hasOwnProperty(newArray[i].x)) { result.push(newArray[i]); console.log('delta data found'); } };
  return result;
}

function clone(src) {
	function mixin(dest, source, copyFunc) {
		var name, s, i, empty = {};
		for(name in source){
			// the (!(name in empty) || empty[name] !== s) condition avoids copying properties in "source"
			// inherited from Object.prototype.	 For example, if dest has a custom toString() method,
			// don't overwrite it with the toString() method that source inherited from Object.prototype
			s = source[name];
			if(!(name in dest) || (dest[name] !== s && (!(name in empty) || empty[name] !== s))){
				dest[name] = copyFunc ? copyFunc(s) : s;
			}
		}
		return dest;
	}

	if(!src || typeof src != "object" || Object.prototype.toString.call(src) === "[object Function]"){
		// null, undefined, any non-object, or function
		return src;	// anything
	}
	if(src.nodeType && "cloneNode" in src){
		// DOM Node
		return src.cloneNode(true); // Node
	}
	if(src instanceof Date){
		// Date
		return new Date(src.getTime());	// Date
	}
	if(src instanceof RegExp){
		// RegExp
		return new RegExp(src);   // RegExp
	}
	var r, i, l;
	if(src instanceof Array){
		// array
		r = [];
		for(i = 0, l = src.length; i < l; ++i){
			if(i in src){
				r.push(clone(src[i]));
			}
		}
		// we don't clone functions for performance reasons
		//		}else if(d.isFunction(src)){
		//			// function
		//			r = function(){ return src.apply(this, arguments); };
	}else{
		// generic objects
		r = src.constructor ? new src.constructor() : {};
	}
	return mixin(r, src, clone);

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

	  if (patientData.sgvs) {
        var delta = calculateDelta(d);
        if (delta.delta) {
          patientDataUpdate = delta;
          patientDataUpdate.predicted = forecast.predicted;
          console.log('patientData full size', JSON.stringify(patientData).length,'bytes');
          if (delta.sgvs) console.log('patientData update size', JSON.stringify(patientDataUpdate).length,'bytes');
          emitData();
        } else { console.log('delta calculation indicates no new data is present'); }
      }

      patientData = clone(d);
      patientData.predicted = forecast.predicted;
    
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
      
    console.log('patientData.sgvs last record time', patientData.sgvs[patientData.sgvs.length-1].x);
    console.log('d.sgvslast record time', d.sgvs[d.sgvs.length-1].x);
      
	var sgvDelta = nsArrayDiff(patientData.sgvs,d.sgvs);
	
	if (sgvDelta.length > 0) {
      console.log('sgv changes found');
	  changesFound = true;
	  sort(sgvDelta);
	  delta.sgvs = sgvDelta;
	};
    
    var treatmentDelta = nsArrayDiff(patientData.treatments,d.treatments);
	
	if (treatmentDelta.length > 0) {
      console.log('treatment changes found');
	  changesFound = true;
	  sort(treatmentDelta);
	  delta.treatments = treatmentDelta;
	};

    var mbgsDelta = nsArrayDiff(patientData.mbgs,d.mbgs);
	
	if (mbgsDelta.length > 0) {
      console.log('mbgs changes found');
	  changesFound = true;
	  sort(mbgsDelta);
	  delta.mbgs = mbgsDelta;
	};

    var calsDelta = nsArrayDiff(patientData.cals,d.cals);
	
	if (calsDelta.length > 0) {
      console.log('cals changes found');
	  changesFound = true;
	  sort(calsDelta);
	  delta.cals = calsDelta;
	};

    if (JSON.stringify(patientData.devicestatus) != JSON.stringify(d.devicestatus)) {
      console.log('devicestatus changes found');
	  changesFound = true;
	  delta.devicestatus = d.devicestatus;
    };

    if (JSON.stringify(patientData.profiles) != JSON.stringify(d.profiles)) {
      console.log('profile changes found');
	  changesFound = true;
	  delta.profiles = d.profiles;
    };

	if (changesFound) {
	  console.log('changes found');
      return delta;
	}
	return d;
      
  }
  
  start( );
  configure( );
  listeners( );

  return websocket();
}

module.exports = init;
