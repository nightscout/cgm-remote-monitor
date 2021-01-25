'use strict';

var times = require('../times');
var calcData = require('../data/calcdelta');
var ObjectID = require('mongodb').ObjectID;

function init (env, ctx, server) {

  function websocket () {
    return websocket;
  }

  var levels = ctx.levels;

  //var log_yellow = '\x1B[33m';
  var log_green = '\x1B[32m';
  var log_magenta = '\x1B[35m';
  var log_reset = '\x1B[0m';
  var LOG_WS = log_green + 'WS: ' + log_reset;
  var LOG_DEDUP = log_magenta + 'DEDUPE: ' + log_reset;

  var io;
  var watchers = 0;
  var lastData = {};
  var lastProfileSwitch = null;

  // TODO: this would be better to have somehow integrated/improved
  var supportedCollections = {
    'treatments': env.treatments_collection
    , 'entries': env.entries_collection
    , 'devicestatus': env.devicestatus_collection
    , 'profile': env.profile_collection
    , 'food': env.food_collection
    , 'activity': env.activity_collection
  };

  // This is little ugly copy but I was unable to pass testa after making module from status and share with /api/v1/status
  function status () {
    var versionNum = 0;
    var verParse = /(\d+)\.(\d+)\.(\d+)*/.exec(env.version);
    if (verParse) {
      versionNum = 10000 * parseInt(verParse[1]) + 100 * parseInt(verParse[2]) + 1 * parseInt(verParse[3]);
    }
    var apiEnabled = env.api_secret ? true : false;

    var activeProfile = ctx.ddata.lastProfileFromSwitch;

    var info = {
      status: 'ok'
      , name: env.name
      , version: env.version
      , versionNum: versionNum
      , serverTime: new Date().toISOString()
      , apiEnabled: apiEnabled
      , careportalEnabled: apiEnabled && env.settings.enable.indexOf('careportal') > -1
      , boluscalcEnabled: apiEnabled && env.settings.enable.indexOf('boluscalc') > -1
      , settings: env.settings
      , extendedSettings: ctx.plugins && ctx.plugins.extendedClientSettings ? ctx.plugins.extendedClientSettings(env.extendedSettings) : {}
    };

    if (activeProfile) {
      info.activeProfile = activeProfile;
    }
    return info;
  }

  function start () {
    io = require('socket.io')({
      'transports': ['xhr-polling']
      , 'log level': 0
    }).listen(server, {
      //these only effect the socket.io.js file that is sent to the client, but better than nothing
      'browser client minification': true
      , 'browser client etag': true
      , 'browser client gzip': false
    });

    ctx.bus.on('teardown', function serverTeardown () {
      Object.keys(io.sockets.sockets).forEach(function(s) {
        io.sockets.sockets[s].disconnect(true);
      });
      io.close();
    });
  }

  function verifyAuthorization (message, ip, callback) {
    ctx.authorization.resolve({ api_secret: message.secret, token: message.token, ip: ip }, function resolved (err, result) {

      if (err) {
        return callback(err, {
          read: false
          , write: false
          , write_treatment: false
          , error: true
        });
      }

      return callback(null, {
        read: ctx.authorization.checkMultiple('api:*:read', result.shiros)
        , write: ctx.authorization.checkMultiple('api:*:create,update,delete', result.shiros)
        , write_treatment: ctx.authorization.checkMultiple('api:treatments:create,update,delete', result.shiros)
      });
    });
  }

  function emitData (delta) {
    if (lastData.cals) {
      // console.log(LOG_WS + 'running websocket.emitData', ctx.ddata.lastUpdated);
      if (lastProfileSwitch !== ctx.ddata.lastProfileFromSwitch) {
        // console.log(LOG_WS + 'profile switch detected OLD: ' + lastProfileSwitch + ' NEW: ' + ctx.ddata.lastProfileFromSwitch);
        delta.status = status(ctx.ddata.profiles);
        lastProfileSwitch = ctx.ddata.lastProfileFromSwitch;
      }
      io.to('DataReceivers').emit('dataUpdate', delta);
    }
  }

  function listeners () {
    io.sockets.on('connection', function onConnection (socket) {
      var socketAuthorization = null;
      var clientType = null;
      var timeDiff;
      var history;

      var remoteIP = socket.request.headers['x-forwarded-for'] || socket.request.connection.remoteAddress;
      console.log(LOG_WS + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      io.emit('clients', ++watchers);
      socket.on('ack', function onAck (level, group, silenceTime) {
        ctx.notifications.ack(level, group, silenceTime, true);
      });

      socket.on('disconnect', function onDisconnect () {
        io.emit('clients', --watchers);
        console.log(LOG_WS + 'Disconnected client ID: ', socket.client.id);
      });

      function checkConditions (action, data) {
        var collection = supportedCollections[data.collection];
        if (!collection) {
          console.log('WS dbUpdate/dbAdd call: ', 'Wrong collection', data);
          return { result: 'Wrong collection' };
        }

        if (!socketAuthorization) {
          console.log('WS dbUpdate/dbAdd call: ', 'Not authorized', data);
          return { result: 'Not authorized' };
        }

        if (data.collection === 'treatments') {
          if (!socketAuthorization.write_treatment) {
            console.log('WS dbUpdate/dbAdd call: ', 'Not permitted', data);
            return { result: 'Not permitted' };
          }
        } else {
          if (!socketAuthorization.write) {
            console.log('WS dbUpdate call: ', 'Not permitted', data);
            return { result: 'Not permitted' };
          }
        }

        if (action === 'dbUpdate' && !data._id) {
          console.log('WS dbUpdate/dbAddnot sure abou documentati call: ', 'Missing _id', data);
          return { result: 'Missing _id' };
        }

        return null;
      }

      socket.on('loadRetro', function loadRetro (opts, callback) {
        if (callback) {
          callback({ result: 'success' });
        }
        //TODO: use opts to only send delta for retro data
        socket.emit('retroUpdate', { devicestatus: lastData.devicestatus });
        console.info('sent retroUpdate', opts);
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
      socket.on('dbUpdate', function dbUpdate (data, callback) {
        console.log(LOG_WS + 'dbUpdate client ID: ', socket.client.id, ' data: ', data);
        var collection = supportedCollections[data.collection];

        var check = checkConditions('dbUpdate', data);
        if (check) {
          if (callback) {
            callback(check);
          }
          return;
        }
        var id;
        try {
          id = new ObjectID(data._id);
        } catch (err) {
          console.error(err);
          id = new ObjectID();
        }

        ctx.store.collection(collection).update({ '_id': id }
          , { $set: data.data }
          , function(err, results) {

            if (!err) {
              ctx.store.collection(collection).findOne({ '_id': id }
                , function(err, results) {
                  console.log('Got results', results);
                  if (!err) {
                    ctx.bus.emit('data-update', {
                      type: data.collection
                      , op: 'update'
                      , changes: ctx.ddata.processRawDataForRuntime([results])
                    });
                  }
                });
            }
          }
        );

        if (callback) {
          callback({ result: 'success' });
        }
        ctx.bus.emit('data-received');
      });

      // dbUpdateUnset message
      //  {
      //    collection: treatments
      //    _id: 'some mongo record id'
      //    data: {
      //      field_1: 1,
      //      field_2: 1
      //    }
      //  }
      socket.on('dbUpdateUnset', function dbUpdateUnset (data, callback) {
        console.log(LOG_WS + 'dbUpdateUnset client ID: ', socket.client.id, ' data: ', data);
        var collection = supportedCollections[data.collection];

        var check = checkConditions('dbUpdate', data);
        if (check) {
          if (callback) {
            callback(check);
          }
          return;
        }

        var objId = new ObjectID(data._id);
        ctx.store.collection(collection).update(
          { '_id': objId },
          { $unset: data.data }
          , function(err, results) {

            if (!err) {
              ctx.store.collection(collection).findOne({ '_id': objId }
                , function(err, results) {
                  console.log('Got results', results);
                  if (!err) {
                    ctx.bus.emit('data-update', {
                      type: data.collection
                      , op: 'update'
                      , changes: ctx.ddata.processRawDataForRuntime([results])
                    });
                  }
                });
            }
        });

        if (callback) {
          callback({ result: 'success' });
        }
        ctx.bus.emit('data-received');
      });

      // dbAdd message
      //  {
      //    collection: treatments
      //    data: {
      //      field_1: new_value,
      //      field_2: another_value
      //    }
      //  }
      socket.on('dbAdd', function dbAdd (data, callback) {
        console.log(LOG_WS + 'dbAdd client ID: ', socket.client.id, ' data: ', data);
        var collection = supportedCollections[data.collection];
        var maxtimediff = times.mins(1).msecs;

        var check = checkConditions('dbAdd', data);
        if (check) {
          if (callback) {
            callback(check);
          }
          return;
        }

        if (data.collection === 'treatments' && !('eventType' in data.data)) {
          data.data.eventType = '<none>';
        }
        if (!('created_at' in data.data)) {
          data.data.created_at = new Date().toISOString();
        }

        // treatments deduping
        if (data.collection === 'treatments') {
          var query;
          if (data.data.NSCLIENT_ID) {
            query = { NSCLIENT_ID: data.data.NSCLIENT_ID };
          } else {
            query = {
              created_at: data.data.created_at
              , eventType: data.data.eventType
            };
          }

          // try to find exact match
          ctx.store.collection(collection).find(query).toArray(function findResult (err, array) {
            if (err || array.length > 0) {
              console.log(LOG_DEDUP + 'Exact match');
              if (callback) {
                callback([array[0]]);
              }
              return;
            }

            var selected = false;
            var query_similiar = {
              created_at: { $gte: new Date(new Date(data.data.created_at).getTime() - maxtimediff).toISOString(), $lte: new Date(new Date(data.data.created_at).getTime() + maxtimediff).toISOString() }
            };
            if (data.data.insulin) {
              query_similiar.insulin = data.data.insulin;
              selected = true;
            }
            if (data.data.carbs) {
              query_similiar.carbs = data.data.carbs;
              selected = true;
            }
            if (data.data.percent) {
              query_similiar.percent = data.data.percent;
              selected = true;
            }
            if (data.data.absolute) {
              query_similiar.absolute = data.data.absolute;
              selected = true;
            }
            if (data.data.duration) {
              query_similiar.duration = data.data.duration;
              selected = true;
            }
            if (data.data.NSCLIENT_ID) {
              query_similiar.NSCLIENT_ID = data.data.NSCLIENT_ID;
              selected = true;
            }
            // if none assigned add at least eventType
            if (!selected) {
              query_similiar.eventType = data.data.eventType;
            }
            // try to find similiar
            ctx.store.collection(collection).find(query_similiar).toArray(function findSimiliarResult (err, array) {
              // if found similiar just update date. next time it will match exactly
              if (err || array.length > 0) {
                console.log(LOG_DEDUP + 'Found similiar', array[0]);
                array[0].created_at = data.data.created_at;
                var objId = new ObjectID(array[0]._id);
                ctx.store.collection(collection).update({ '_id': objId }, { $set: { created_at: data.data.created_at } });
                if (callback) {
                  callback([array[0]]);
                }
                ctx.bus.emit('data-received');
                return;
              }
              // if not found create new record
              console.log(LOG_DEDUP + 'Adding new record');
              ctx.store.collection(collection).insert(data.data, function insertResult (err, doc) {
                if (err != null && err.message) {
                  console.log('treatments data insertion error: ', err.message);
                  return;
                }

                ctx.bus.emit('data-update', {
                  type: data.collection
                  , op: 'update'
                  , changes: ctx.ddata.processRawDataForRuntime(doc.ops)
                });

                if (callback) {
                  callback(doc.ops);
                }
                ctx.bus.emit('data-received');
              });
            });
          });
          // devicestatus deduping
        } else if (data.collection === 'devicestatus') {
          var queryDev;
          if (data.data.NSCLIENT_ID) {
            queryDev = { NSCLIENT_ID: data.data.NSCLIENT_ID };
          } else {
            queryDev = {
              created_at: data.data.created_at
            };
          }

          // try to find exact match
          ctx.store.collection(collection).find(queryDev).toArray(function findResult (err, array) {
            if (err || array.length > 0) {
              console.log(LOG_DEDUP + 'Devicestatus exact match');
              if (callback) {
                callback([array[0]]);
              }
              return;
            }
          });
          ctx.store.collection(collection).insert(data.data, function insertResult (err, doc) {
            if (err != null && err.message) {
              console.log('devicestatus insertion error: ', err.message);
              return;
            }

            ctx.bus.emit('data-update', {
              type: 'devicestatus'
              , op: 'update'
              , changes: ctx.ddata.processRawDataForRuntime(doc.ops)
            });

            if (callback) {
              callback(doc.ops);
            }
            ctx.bus.emit('data-received');
          });
        } else {
          ctx.store.collection(collection).insert(data.data, function insertResult (err, doc) {
            if (err != null && err.message) {
              console.log(data.collection + ' insertion error: ', err.message);
              return;
            }
            
            ctx.bus.emit('data-update', {
              type: data.collection
              , op: 'update'
              , changes: ctx.ddata.processRawDataForRuntime(doc.ops)
            });

            if (callback) {
              callback(doc.ops);
            }
            ctx.bus.emit('data-received');
          });
        }
      });
      // dbRemove message
      //  {
      //    collection: treatments
      //    _id: 'some mongo record id'
      //  }
      socket.on('dbRemove', function dbRemove (data, callback) {
        console.log(LOG_WS + 'dbRemove client ID: ', socket.client.id, ' data: ', data);
        var collection = supportedCollections[data.collection];

        var check = checkConditions('dbUpdate', data);
        if (check) {
          if (callback) {
            callback(check);
          }
          return;
        }

        var objId = new ObjectID(data._id);
        ctx.store.collection(collection).remove({ '_id': objId }
          , function(err, stat) {

            if (!err) {
              ctx.bus.emit('data-update', {
                type: data.collection
                , op: 'remove'
                , count: stat.result.n
                , changes: data._id
              });

            }
          });

        if (callback) {
          callback({ result: 'success' });
        }
        ctx.bus.emit('data-received');
      });

      // Authorization message
      // {
      //  client: 'web' | 'phone' | 'pump'
      //  , secret: 'secret_hash'
      //  [, history : history_in_hours ]
      //  [, status : true ]
      // }
      socket.on('authorize', function authorize (message, callback) {
        const remoteIP = socket.request.connection.remoteAddress;
        verifyAuthorization(message, remoteIP, function verified (err, authorization) {
          socketAuthorization = authorization;
          clientType = message.client;
          history = message.history || 48; //default history is 48 hours

          if (socketAuthorization.read) {
            socket.join('DataReceivers');

            if (lastData && lastData.dataWithRecentStatuses) {
              let data = lastData.dataWithRecentStatuses();

              if (message.status) {
                data.status = status(data.profiles);
              }

              socket.emit('dataUpdate', data);
            }
          }
          // console.log(LOG_WS + 'Authetication ID: ', socket.client.id, ' client: ', clientType, ' history: ' + history);
          if (callback) {
            callback(socketAuthorization);
          }
        });
      });

      // Pind message
      // {
      //  mills: <local_time_in_milliseconds>
      // }
      socket.on('nsping', function ping (message, callback) {
        var clientTime = message.mills;
        timeDiff = new Date().getTime() - clientTime;
        // console.log(LOG_WS + 'Ping from client ID: ',socket.client.id, ' client: ', clientType, ' timeDiff: ', (timeDiff/1000).toFixed(1) + 'sec');
        if (callback) {
          callback({ result: 'pong', mills: new Date().getTime(), authorization: socketAuthorization });
        }
      });
    });
  }

  websocket.update = function update () {
    // console.log(LOG_WS + 'running websocket.update');
    if (lastData.sgvs) {
      var delta = calcData(lastData, ctx.ddata);
      if (delta.delta) {
        // console.log('lastData full size', JSON.stringify(lastData).length,'bytes');
        // if (delta.sgvs) { console.log('patientData update size', JSON.stringify(delta).length,'bytes'); }
        emitData(delta);
      }; // else { console.log('delta calculation indicates no new data is present'); }
    }
    lastData = ctx.ddata.clone();
  };

  websocket.emitNotification = function emitNotification (notify) {
    if (notify.clear) {
      io.emit('clear_alarm', notify);
      console.info(LOG_WS + 'emitted clear_alarm to all clients');
    } else if (notify.level === levels.WARN) {
      io.emit('alarm', notify);
      console.info(LOG_WS + 'emitted alarm to all clients');
    } else if (notify.level === levels.URGENT) {
      io.emit('urgent_alarm', notify);
      console.info(LOG_WS + 'emitted urgent_alarm to all clients');
    } else if (notify.isAnnouncement) {
      io.emit('announcement', notify);
      console.info(LOG_WS + 'emitted announcement to all clients');
    } else {
      io.emit('notification', notify);
      console.info(LOG_WS + 'emitted notification to all clients');
    }
  };

  start();
  listeners();

  if (ctx.storageSocket) {
    ctx.storageSocket.init(io);
  }

  return websocket();
}

module.exports = init;
