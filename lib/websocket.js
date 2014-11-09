
function websocket (env, server, entries, treatments) {
"use strict";
// CONSTANTS
var ONE_HOUR = 3600000,
    ONE_MINUTE = 60000,
    FIVE_MINUTES = 300000,
    FORTY_MINUTES = 2400000,
    TWO_DAYS = 172800000;

var dir2Char = {
  'NONE': '&#8700;',
  'DoubleUp': '&#8648;',
  'SingleUp': '&#8593;',
  'FortyFiveUp': '&#8599;',
  'Flat': '&#8594;',
  'FortyFiveDown': '&#8600;',
  'SingleDown': '&#8595;',
  'DoubleDown': '&#8650;',
  'NOT COMPUTABLE': '-',
  'RATE OUT OF RANGE': '&#8622;'
};

  var io;
  var watchers = 0;
  var now = new Date().getTime();

  var cgmData = [],
    treatmentData = [],
    mbgData = [],
    patientData = [];

  function start ( ) {
    io = require('socket.io').listen(server);
  }
  // get data from database and setup to update every minute
  function kickstart (fn) {
    //TODO: test server to see how data is stored (timestamps, entry values, etc)
    //TODO: check server settings to configure alerts, entry units, etc
    console.log(now, new Date(now), fn.name);
    fn( );
    return fn;
  }

  function emitData ( ) {
    console.log('running emitData', now, patientData && patientData.length);
    if (patientData.length > 0) {
      io.sockets.emit("now", now);
      io.sockets.emit("sgv", patientData);
    }
  }

  function configure ( ) {
    // reduce logging
    io.set('log level', 0);

    //Try for Websockets (Azure Supports if it's on) then fallback
    io.configure(function () {
        io.set('transports', ['websocket','xhr-polling']);
    });
  }

  function listeners ( ) {
    io.sockets.on('connection', function (socket) {
        io.sockets.emit("now", now);
        io.sockets.emit("sgv", patientData);
        io.sockets.emit("clients", ++watchers);
        socket.on('ack', function(alarmType, _silenceTime) {
            alarms[alarmType].lastAckTime = new Date().getTime();
            alarms[alarmType].silenceTime = _silenceTime ? _silenceTime : FORTY_MINUTES;
            io.sockets.emit("clear_alarm", true);
            console.log("alarm cleared");
        });
        socket.on('disconnect', function () {
            io.sockets.emit("clients", --watchers);
        });
    });
  }

///////////////////////////////////////////////////
// data handling functions
///////////////////////////////////////////////////

function directionToChar(direction) {
  return dir2Char[direction] || '-';
}

var Alarm = function(_typeName, _threshold) {
    this.typeName = _typeName;
    this.silenceTime = FORTY_MINUTES;
    this.lastAckTime = 0;
    this.threshold = _threshold;
};

// list of alarms with their thresholds
var alarms = {
    "alarm" : new Alarm("Regular", 0.05),
    "urgent_alarm": new Alarm("Urgent", 0.10)
};

function update() {

    console.log('running update');
    now = Date.now();

    cgmData = [];
    treatmentData = [];
    mbgData = [];
    var earliest_data = now - TWO_DAYS;
    var q = { find: {"date": {"$gte": earliest_data}} };
    entries.list(q, function (err, results) {
      results.forEach(function(element, index, array) {
          if (element) {
              if (element.mbg) {
                  var obj = {};
                  obj.y = element.mbg;
                  obj.x = element.date;
                  obj.d = element.dateString;
                  mbgData.push(obj);
              } else if (element.sgv) {
                  var obj = {};
                  obj.y = element.sgv;
                  obj.x = element.date;
                  obj.d = element.dateString;
                  obj.direction = directionToChar(element.direction);
                  cgmData.push(obj);
              }
          }
      });
      treatments.list(function (err, results) {
          treatmentData = results.map(function(treatment) {
              var timestamp = new Date(treatment.timestamp || treatment.created_at);
              treatment.x = timestamp.getTime();
              return treatment;
          });
          // all done, do loadData
          loadData( );
      });
    });

    return update;
}

function emitAlarm(alarmType) {
    var alarm = alarms[alarmType];
    if (now > alarm.lastAckTime + alarm.silenceTime) {
        io.sockets.emit(alarmType);
    } else {
        console.log(alarm.typeName + " alarm is silenced for " + Math.floor((alarm.silenceTime - (now - alarm.lastAckTime)) / 60000) + " minutes more");
    }
}

function loadData() {

    console.log('running loadData');

    var actual = [],
        actualCurrent,
        treatment = [],
        mbg = [],
        errorCode;

    if (cgmData) {
        actual = cgmData.slice();
        actual.sort(function(a, b) {
            return a.x - b.x;
        });

        actualCurrent = actual.length > 0 ? actual[actual.length - 1].y : null;

        // sgv less than or equal to 10 means error code
        // or warm up period code, so ignore
        actual = actual.filter(function (a) {
            return a.y > 10;
        })
    }

    if (treatmentData) {
        treatment = treatmentData.slice();
        treatment.sort(function(a, b) {
            return a.x - b.x;
        });
    }

    if (mbgData) {
        mbg = mbgData.slice();
        mbg.sort(function(a, b) {
            return a.x - b.x;
        });
    }

    if (actualCurrent && actualCurrent < 39) errorCode = actualCurrent;

    var actualLength = actual.length - 1;

    if (actualLength > 1) {
        // predict using AR model
        var predicted = [];
        var lastValidReadingTime = actual[actualLength].x;
        var elapsedMins = (actual[actualLength].x - actual[actualLength - 1].x) / ONE_MINUTE;
        var BG_REF = 140;
        var BG_MIN = 36;
        var BG_MAX = 400;
        var y = Math.log(actual[actualLength].y / BG_REF);
        if (elapsedMins < 5.1) {
            y = [Math.log(actual[actualLength - 1].y / BG_REF), y];
        } else {
            y = [y, y];
        }
        var n = Math.ceil(12 * (1 / 2 + (now - lastValidReadingTime) / ONE_HOUR));
        var AR = [-0.723, 1.716];
        var dt = actual[actualLength].x;
        for (var i = 0; i <= n; i++) {
            y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
            dt = dt + FIVE_MINUTES;
            predicted[i] = {
                x: dt,
                y: Math.max(BG_MIN, Math.min(BG_MAX, Math.round(BG_REF * Math.exp(y[1]))))
            };
        }

        //TODO: need to consider when data being sent has less than the 2 day minimum

        // consolidate and send the data to the client
        var shouldEmit = is_different(actual, predicted, mbg, treatment, errorCode);
        patientData = [actual, predicted, mbg, treatment, errorCode];
        console.log('patientData', patientData.length);
        if (shouldEmit) {
          emitData( );
        }

        // compute current loss
        var avgLoss = 0;
        var size = Math.min(predicted.length - 1, 6);
        for (var j = 0; j <= size; j++) {
            avgLoss += 1 / size * Math.pow(log10(predicted[j].y / 120), 2);
        }

        if (avgLoss > alarms['urgent_alarm'].threshold) {
            emitAlarm('urgent_alarm');
        } else if (avgLoss > alarms['alarm'].threshold) {
            emitAlarm('alarm');
        } else if (errorCode) {
            emitAlarm('urgent_alarm');
        }
    }
}
  function is_different (actual, predicted, mbg, treatment, errorCode) {
    if (patientData && patientData.length < 3) {
      return true;
    }
    var old =  {
        actual: patientData[0].slice(-1).pop( )
      , predicted: patientData[1].slice(-1).pop( )
      , mbg: patientData[2].slice(-1).pop( )
      , treatment: patientData[3].slice(-1).pop( )
      , errorCode: patientData.length >= 5 ? patientData[4] : 0
    };
    var last = {
        actual: actual.slice(-1).pop( )
      , predicted: predicted.slice(-1).pop( )
      , mbg: mbg.slice(-1).pop( )
      , treatment: treatment.slice(-1).pop( )
      , errorCode: errorCode
    };

    // textual diff of objects
    if (JSON.stringify(old) == JSON.stringify(last)) {
      return false;
    }
    return true;
  }

  start( );
  configure( );
  listeners( );
  setInterval(kickstart(update), ONE_MINUTE);
  setInterval(kickstart(emitData), ONE_MINUTE);

  return io;
}

///////////////////////////////////////////////////
// helper functions
///////////////////////////////////////////////////

function log10(val) { return Math.log(val) / Math.LN10; }

module.exports = websocket;
