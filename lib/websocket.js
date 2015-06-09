'use strict';

var _ = require('lodash');
var utils = require('./utils')();

function init (env, ctx, server) {

  function websocket ( ) {
    return websocket;
  }

  var io;
  var watchers = 0;
  var lastData = {};

  function start ( ) {
    io = require('socket.io')({
      'transports': ['xhr-polling'], 'log level': 0
    }).listen(server, {
      //these only effect the socket.io.js file that is sent to the client, but better than nothing
      'browser client minification': true,
      'browser client etag': true,
      'browser client gzip': false
    });
  }

  function emitData (delta) {
    if (lastData.cals) {
      console.log('running websocket.emitData', ctx.data.lastUpdated, delta.recentsgvs && delta.sgvdataupdate.length);
      io.emit('dataUpdate', delta);
    }
  }

  function listeners ( ) {
    io.sockets.on('connection', function (socket) {
      // send all data upon new connection
      socket.emit('dataUpdate',lastData);
      io.emit('clients', ++watchers);
      socket.on('ack', function(alarmType, silenceTime) {
        ctx.notifications.ack(alarmType, silenceTime);
        if (alarmType == 'urgent_alarm') {
          //also clean normal alarm so we don't get a double alarm as BG comes back into range
          ctx.notifications.ack('alarm', silenceTime);
        }
      });
      socket.on('disconnect', function () {
        io.emit('clients', --watchers);
      });
    });
  }

  websocket.processData = function processData ( ) {
    console.log('running websocket.processData');
    var lastSGV = ctx.data.sgvs.length > 0 ? ctx.data.sgvs[ctx.data.sgvs.length - 1].y : null;
    if (lastSGV) {
      if (lastData.sgvs) {
        var delta = ctx.data.calculateDelta(lastData);
        if (delta.delta) {
          console.log('lastData full size', JSON.stringify(lastData).length,'bytes');
          if (delta.sgvs) console.log('patientData update size', JSON.stringify(delta).length,'bytes');
          emitData(delta);
        } else { console.log('delta calculation indicates no new data is present'); }
      }
      lastData = ctx.data.clone();
    }
  };

  websocket.emitNotification = function emitNotification (info) {
    if (info.clear) {
      io.emit('clear_alarm', true);
      console.info('emitted clear_alarm to all clients');
    } else if (info.type) {
      io.emit(info.type);
      console.info('emitted ' + info.type + ' to all clients');
    }
  };

  start( );
  listeners( );

  return websocket();
}

module.exports = init;
