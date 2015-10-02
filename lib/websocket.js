var async = require('async');

function websocket (env, server, entries, treatments, profiles, devicestatus) {
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
    calData = [],
    profileData = [],
    patientData = [],
    devicestatusData = {};

  function start ( ) {
    io = require('socket.io').listen(server, {
        //these only effect the socket.io.js file that is sent to the client, but better than nothing
        'browser client minification': true,
        'browser client etag': true,
        'browser client gzip': false
    });
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
      io.sockets.emit("sgv", patientData);
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
        io.sockets.emit("sgv", patientData);
        io.sockets.emit("clients", ++watchers);
        socket.on('ack', function(alarmType, silenceTime) {
            ackAlarm(alarmType, silenceTime);
            if (alarmType == "urgent_alarm") {
              //also clean normal alarm so we don't get a double alarm as BG comes back into range
              ackAlarm("alarm", silenceTime);
            }
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
                console.info("auto acking " + alarmType);
                ackAlarm(alarmType, 1);
                sendClear = true;
            }
        }
    }
    if (sendClear) {
        io.sockets.emit("clear_alarm", true);
        console.info("emitted clear_alarm to all clients");
    }
}

function emitAlarm(alarmType) {
    var alarm = alarms[alarmType];
    if (now > alarm.lastAckTime + alarm.silenceTime) {
        io.sockets.emit(alarmType);
        alarm.lastEmitTime = now;
        console.info("emitted " + alarmType + " to all clients");
    } else {
        console.log(alarm.typeName + " alarm is silenced for " + Math.floor((alarm.silenceTime - (now - alarm.lastAckTime)) / 60000) + " minutes more");
    }
}

function update() {

    console.log('running update');
    now = Date.now();

    cgmData = [];
    treatmentData = [];
    mbgData = [];
    profileData = [];
    devicestatusData = {};
    var earliest_data = now - TWO_DAYS;

    async.parallel({
        entries: function(callback) {
            var q = { find: {"date": {"$gte": earliest_data}} };
            entries.list(q, function (err, results) {
                if (!err && results) {
                    results.forEach(function (element) {
                        if (element) {
                            if (element.mbg) {
                                mbgData.push({
                                    y: element.mbg
                                    , x: element.date
                                    , d: element.dateString
                                    , device: element.device
                                });
                            } else if (element.sgv) {
                                cgmData.push({
                                    y: element.sgv
                                    , x: element.date
                                    , d: element.dateString
                                    , device: element.device
                                    , direction: directionToChar(element.direction)
                                    , filtered: element.filtered
                                    , unfiltered: element.unfiltered
                                    , noise: element.noise
                                    , rssi: element.rssi
                                });
                            }
                        }
                    });
                }
                callback();
            })
        }
        , cal: function(callback) {
            var cq = { count: 1, find: {"type": "cal"} };
            entries.list(cq, function (err, results) {
                if (!err && results) {
                    results.forEach(function (element) {
                        if (element) {
                            calData.push({
                                x: element.date
                                , d: element.dateString
                                , scale: element.scale
                                , intercept: element.intercept
                                , slope: element.slope
                            });
                        }
                    });
                }
                callback();
            });
        }
        , treatments: function(callback) {
            var tq = { find: {"created_at": {"$gte": new Date(earliest_data).toISOString()}} };
            treatments.list(tq, function (err, results) {
                treatmentData = results.map(function (treatment) {
                    var timestamp = new Date(treatment.timestamp || treatment.created_at);
                    treatment.x = timestamp.getTime();
                    return treatment;
                });
                callback();
            });
        }
        , profile: function(callback) {
            profiles.list(function (err, results) {
                if (!err && results) {
                    // There should be only one document in the profile collection with a DIA.  If there are multiple, use the last one.
                    results.forEach(function (element, index, array) {
                        if (element) {
                            if (element.dia) {
                                profileData[0] = element;
                            }
                        }
                    });
                }
                callback();
            });
        }
        , devicestatus: function(callback) {
            devicestatus.last(function (err, result) {
                if (!err && result) {
                    devicestatusData = {
                        uploaderBattery: result.uploaderBattery
                    };
                }
                callback();
            })
        }
    }, loadData);

    return update;
}

function loadData() {

    console.log('running loadData');

    var actual = [],
        actualCurrent,
        treatment = [],
        mbg = [],
        cal = [],
        errorCode;

    if (cgmData) {
        actual = cgmData.slice();
        actual.sort(function(a, b) {
            return a.x - b.x;
        });

        actualCurrent = actual.length > 0 ? actual[actual.length - 1].y : null;
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

    if (calData) {
        cal = calData.slice(calData.length-200, calData.length);
        cal.sort(function(a, b) {
            return a.x - b.x;
        });
    }

    if (profileData) {
        var profile = profileData;
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
        var shouldEmit = is_different(actual, predicted, mbg, treatment, cal, devicestatusData);
        patientData = [actual, predicted, mbg, treatment, profile, cal, devicestatusData];
        console.log('patientData', patientData.length);
        if (shouldEmit) {
          emitData( );
        }

        var emitAlarmType = null;

        if (env.alarm_types.indexOf("simple") > -1) {
            var lastBG = actual[actualLength].y;

            if (lastBG > env.thresholds.bg_high) {
                emitAlarmType = 'urgent_alarm';
                console.info(lastBG + " > " + env.thresholds.bg_high + " will emmit " + emitAlarmType);
            } else if (lastBG > env.thresholds.bg_target_top) {
                emitAlarmType = 'alarm';
                console.info(lastBG + " > " + env.thresholds.bg_target_top + " will emmit " + emitAlarmType);
            } else if (lastBG < env.thresholds.bg_low) {
                emitAlarmType = 'urgent_alarm';
                console.info(lastBG + " < " + env.thresholds.bg_low + " will emmit " + emitAlarmType);
            } else if (lastBG < env.thresholds.bg_target_bottom) {
                emitAlarmType = 'alarm';
                console.info(lastBG + " < " + env.thresholds.bg_target_bottom + " will emmit " + emitAlarmType);
            }
        }

        if (!emitAlarmType && env.alarm_types.indexOf("predict") > -1) {
            // compute current loss
            var avgLoss = 0;
            var size = Math.min(predicted.length - 1, 6);
            for (var j = 0; j <= size; j++) {
                avgLoss += 1 / size * Math.pow(log10(predicted[j].y / 120), 2);
            }

            if (avgLoss > alarms['urgent_alarm'].threshold) {
                emitAlarmType = 'urgent_alarm';
                console.info(avgLoss + " < " + alarms['urgent_alarm'].threshold + " will emmit " + emitAlarmType);
            } else if (avgLoss > alarms['alarm'].threshold) {
                emitAlarmType = 'alarm';
                console.info(avgLoss + " < " + alarms['alarm'].threshold + " will emmit " + emitAlarmType);
            }
        }

        if (errorCode) {
            emitAlarmType = 'urgent_alarm';
        }

        if (emitAlarmType) {
            emitAlarm(emitAlarmType);
        } else {
            autoAckAlarms();
        }
    }
}

  function is_different (actual, predicted, mbg, treatment, cal) {
    if (patientData && patientData.length < 3) {
      return true;
    }
    var old =  {
        actual: patientData[0].slice(-1).pop( )
      , predicted: patientData[1].slice(-1).pop( )
      , mbg: patientData[2].slice(-1).pop( )
      , treatment: patientData[3].slice(-1).pop( )
      , cal: patientData[4].slice(-1).pop( )
    };
    var last = {
        actual: actual.slice(-1).pop( )
      , predicted: predicted.slice(-1).pop( )
      , mbg: mbg.slice(-1).pop( )
      , treatment: treatment.slice(-1).pop( )
      , cal: cal.slice(-1).pop( )
    };

    // textual diff of objects
    if (JSON.stringify(old) == JSON.stringify(last)) {
      console.info("data isn't different, will not send to clients");
      return false;
    }
    return true;
  }

  start( );
  configure( );
  listeners( );
  setInterval(kickstart(update), ONE_MINUTE);

  return io;
}

///////////////////////////////////////////////////
// helper functions
///////////////////////////////////////////////////

function log10(val) { return Math.log(val) / Math.LN10; }

module.exports = websocket;
