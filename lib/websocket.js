'use strict';

var levels = require('./levels');

function init (env, ctx, server) {

  function websocket ( ) {
    return websocket;
  }

  var io;
  var watchers = 0;
  var lastData = {};

  var alarmType2Level = {
    urgent_alarm: levels.URGENT
    , alarm: levels.WARN
  };

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
      console.log('running websocket.emitData', ctx.data.lastUpdated);
      io.emit('dataUpdate', delta);
    }
  }

  function listeners ( ) {
    io.sockets.on('connection', function (socket) {
      // send all data upon new connection
      socket.emit('dataUpdate',lastData);
      io.emit('clients', ++watchers);
      socket.on('ack', function(alarmType, silenceTime) {
        //TODO: Announcement hack a1/a2
        var level = alarmType2Level[alarmType] || alarmType;
        ctx.notifications.ack(level, silenceTime, true);
      });
      socket.on('disconnect', function () {
        io.emit('clients', --watchers);
      });
    });
  }

  websocket.update = function update ( ) {
    console.log('running websocket.update');
    var sgvMgdl = ctx.data.sgvs.length > 0 ? ctx.data.sgvs[ctx.data.sgvs.length - 1].mgdl : null;
    if (sgvMgdl) {
      if (lastData.sgvs) {
        var delta = ctx.data.calculateDelta(lastData);
        if (delta.delta) {
          console.log('lastData full size', JSON.stringify(lastData).length,'bytes');
          if (delta.sgvs) { console.log('patientData update size', JSON.stringify(delta).length,'bytes'); }
          emitData(delta);
        } else { console.log('delta calculation indicates no new data is present'); }
      }
      lastData = ctx.data.clone();
    }
  };

  websocket.emitNotification = function emitNotification (notify) {
    if (notify.clear) {
      io.emit('clear_alarm', true);
      console.info('emitted clear_alarm to all clients');
    } else if (notify.level === levels.WARN) {
      io.emit('alarm', notify);
      console.info('emitted alarm to all clients');
    } else if (notify.level === levels.URGENT) {
      io.emit('urgent_alarm', notify);
      console.info('emitted urgent_alarm to all clients');
    } else if (notify.isAnnouncement) {
      io.emit('announcement', notify);
      console.info('emitted announcement to all clients');
    }
  };

  start( );
  listeners( );

  return websocket();
}

module.exports = init;
