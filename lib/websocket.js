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
  
  function verifyAuthorization(secret) {
    var read, write, write_treatment;
    
    // read now true by default
    read = true;
    write = (secret === env.api_secret);
    write_treatment = !env.treatments_auth || (secret === env.api_secret);
    
    return {
      read: read
      , write: write
      , write_treatment: write_treatment
    };
  }

  function emitData (delta) {
    if (lastData.cals) {
      console.log('running websocket.emitData', ctx.data.lastUpdated);
      io.to('DataReceivers').emit('dataUpdate', delta);
    }
  }

  function listeners ( ) {
    io.sockets.on('connection', function (socket) {
      var socketAuthorization = null;
      var clientType = null;
      
      console.log('Connection from client ID: ', socket.client.id, ' IP: ', socket.request.connection.remoteAddress);

      io.emit('clients', ++watchers);
      socket.on('ack', function(alarmType, silenceTime) {
        //TODO: Announcement hack a1/a2
        var level = alarmType2Level[alarmType] || alarmType;
        ctx.notifications.ack(level, silenceTime, true);
      });

      socket.on('disconnect', function () {
        io.emit('clients', --watchers);
        console.log('Disconnected client ID: ',socket.client.id);
      });


      // dbUpdate message  
      //  {
      //    collection: treatments
      //    _id: 'some mongo record id'
      //    data: {
      //      field_1: new_value,
      //      field_2: another_value
      //    }
      //  }
      socket.on('dbUpdate', function dbUpdate(data, callback) {
        var ObjectID = require('mongodb').ObjectID;
       
        // TODO: this would be better to have somehow integrated/improved
        var supportedCollections = { 
        'treatments' : env.treatments_collection, 
        'entries': env.mongo_collection, 
        'devicestatus': env.devicestatus_collection, 
        'profile': env.profile_collection, 
        'food': env.food_collection
        };

        var collection = supportedCollections[data.collection];
        
        if (!collection) {
          console.log('WS dbUpdate call: ', 'Wrong collection', data);
          return { result: 'Wrong collection' };
        }

        if (!socketAuthorization) {
          console.log('WS dbUpdate call: ', 'Not authorized', data);
          return { result: 'Not authorized' };
        }

        if (data.collection === 'treatments') {
          if (!socketAuthorization.write_treatment) {
            console.log('WS dbUpdate call: ', 'Not permitted', data);
            return { result: 'Not permitted' };
          }
        } else {
          if (!socketAuthorization.write) {
            console.log('WS dbUpdate call: ', 'Not permitted', data);
            return { result: 'Not permitted' };
          }
        }

        if (!data._id) {
          console.log('WS dbUpdate call: ', 'Missing _id', data);
          return { result: 'Missing _id' };
        }

        ctx.store.db.collection(collection).update(
          { '_id': new ObjectID(data._id) },
          { $set: data.data }
        );
          
        //console.log(ret);
        callback( { result: 'success' } );
        ctx.bus.emit('data-received');
      });
      
      // Authorization message
      // {
      //  client: 'web' | 'phone' | 'pump'  
      //  , secret: 'secret_hash'
      // }
      socket.on('authorize', function authorize(message, callback) {
        socketAuthorization = verifyAuthorization(message.secret);
        clientType = message.client;
        if (socketAuthorization.read) {
          socket.join('DataReceivers');
          // send all data upon new connection
          socket.emit('dataUpdate',lastData);
        }
        console.log('Authetication request from client ID: ',socket.client.id);
        if (callback) {
          callback(socketAuthorization);
        }
      });
    });
  }

  websocket.update = function update ( ) {
    console.log('running websocket.update');
    if (lastData.sgvs) {
      var delta = ctx.data.calculateDelta(lastData);
      if (delta.delta) {
        console.log('lastData full size', JSON.stringify(lastData).length,'bytes');
        if (delta.sgvs) { console.log('patientData update size', JSON.stringify(delta).length,'bytes'); }
        emitData(delta);
      } else { console.log('delta calculation indicates no new data is present'); }
    }
    lastData = ctx.data.clone();
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
