'use strict';

var _ = require('lodash');
var ObjectID = require('mongodb').ObjectID;

function nsArrayDiff(oldArray, newArray) {
  var seen = {};
  var l = oldArray.length;
  for (var i = 0; i < l; i++) { seen[oldArray[i].x] = true }
  var result = [];
  l = newArray.length;
  for (var j = 0; j < l; j++) { if (!seen.hasOwnProperty(newArray[j].x)) { result.push(newArray[j]); console.log('delta data found'); } }
  return result;
}

function sort (values) {
  values.sort(function sorter (a, b) {
    return a.x - b.x;
  });
}

function init (env, ctx, server) {

  function websocket ( ) {
    return websocket;
  }

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
        ctx.notifications.ack(alarmType, silenceTime);
        if (alarmType == 'urgent_alarm') {
          //also clean normal alarm so we don't get a double alarm as BG comes back into range
          ctx.notifications.ack('alarm', silenceTime);
        }
      });
      socket.on('disconnect', function () {
        io.sockets.emit('clients', --watchers);
      });
    });
  }

  websocket.processData = function processData ( ) {

    var d = ctx.data;
    lastUpdated = d.lastUpdated;

    console.log('running websocket.processData');

    var lastSGV = d.sgvs.length > 0 ? d.sgvs[d.sgvs.length - 1].y : null;

    if (lastSGV) {
      if (patientData.sgvs) {
        var delta = calculateDelta(d);
        if (delta.delta) {
          patientDataUpdate = delta;
          console.log('patientData full size', JSON.stringify(patientData).length,'bytes');
          if (delta.sgvs) console.log('patientData update size', JSON.stringify(patientDataUpdate).length,'bytes');
          emitData();
        } else { console.log('delta calculation indicates no new data is present'); }
      }

      //see https://github.com/lodash/lodash/issues/602#issuecomment-47414964
      patientData = _.cloneDeep(d, function (value) {
        if (value instanceof ObjectID) {
          return value.toString();
        }
      });

    }
  };

  websocket.emitNotification = function emitNotification (info) {
    if (info.clear) {
      io.sockets.emit('clear_alarm', true);
      console.info('emitted clear_alarm to all clients');
    } else if (info.type) {
      io.sockets.emit(info.type);
      console.info('emitted ' + info.type + ' to all clients');
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
    }

    var treatmentDelta = nsArrayDiff(patientData.treatments,d.treatments);

    if (treatmentDelta.length > 0) {
      console.log('treatment changes found');
      changesFound = true;
      sort(treatmentDelta);
      delta.treatments = treatmentDelta;
    }

    var mbgsDelta = nsArrayDiff(patientData.mbgs,d.mbgs);

    if (mbgsDelta.length > 0) {
      console.log('mbgs changes found');
      changesFound = true;
      sort(mbgsDelta);
      delta.mbgs = mbgsDelta;
    }

    var calsDelta = nsArrayDiff(patientData.cals,d.cals);

    if (calsDelta.length > 0) {
      console.log('cals changes found');
      changesFound = true;
      sort(calsDelta);
      delta.cals = calsDelta;
    }

    if (JSON.stringify(patientData.devicestatus) != JSON.stringify(d.devicestatus)) {
      console.log('devicestatus changes found');
      changesFound = true;
      delta.devicestatus = d.devicestatus;
    }

    if (JSON.stringify(patientData.profiles) != JSON.stringify(d.profiles)) {
      console.log('profile changes found');
      changesFound = true;
      delta.profiles = d.profiles;
    }

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
