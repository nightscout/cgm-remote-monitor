'use strict';

var times = require('../times');
var calcData = require('../data/calcdelta');
var ObjectID = require('mongodb').ObjectId;
const forwarded = require('forwarded-for');

function getRemoteIP (req) {
  const address = forwarded(req, req.headers);
  return address.ip;
}

// Only coerce canonical 24-char hex strings to ObjectId.
// Preserve custom string ids and existing ObjectId instances.
function safeObjectID (id) {
  if (id instanceof ObjectID) {
    return id;
  }

  if (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) {
    return new ObjectID(id);
  }

  return id;
}

function init (env, ctx, server) {

  function websocket () {
    return websocket;
  }

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
    const vString = '' + env.version;
    const verParse = vString.split('.');
    if (verParse) {
      versionNum = 10000 * Number(verParse[0]) + 100 * Number(verParse[1]) + 1 * Number(verParse[2]);
    }

    var apiEnabled = env.enclave.isApiKeySet();

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
      'log level': 0
    }).listen(server, {
      //these only effect the socket.io.js file that is sent to the client, but better than nothing
      // compat with v2 client
      allowEIO3: true
      , 'browser client minification': true
      , 'browser client etag': true
      , 'browser client gzip': false
      , 'perMessageDeflate': {
        threshold: 512
      }
      , transports: ["polling", "websocket"]
      , httpCompression: {
        threshold: 512
      }
    });

    ctx.bus.on('teardown', function serverTeardown () {
      Object.keys(io.sockets.sockets).forEach(function(s) {
        io.sockets.sockets[s].disconnect(true);
      });
      io.close();
    });
        
    ctx.bus.on('data-processed', function() {
      update();
    });

  }

  function verifyAuthorization (message, ip, callback) {

    if (!message) message = {};

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
      io.to('DataReceivers').compress(true).emit('dataUpdate', delta);
    }
  }

  function listeners () {
    io.sockets.on('connection', function onConnection (socket) {
      var socketAuthorization = null;
      var clientType = null;
      var timeDiff;
      var history;

      const remoteIP = getRemoteIP(socket.request);
      console.log(LOG_WS + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      io.emit('clients', ++watchers);
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
        socket.compress(true).emit('retroUpdate', { devicestatus: lastData.devicestatus });
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
        var id = safeObjectID(data._id);

        (async function () {
          try {
            var mongoCollection = ctx.store.collection(collection);
            await mongoCollection.updateOne({ '_id': id }, { $set: data.data });
            var results = await mongoCollection.findOne({ '_id': id });
            console.log('Got results', results);
            if (results !== null) {
              ctx.bus.emit('data-update', {
                type: data.collection
                , op: 'update'
                , changes: ctx.ddata.processRawDataForRuntime([results])
              });
            }
          } catch (err) {
            console.error(err);
          }
        })();

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

        var objId = safeObjectID(data._id);
        (async function () {
          try {
            var mongoCollection = ctx.store.collection(collection);
            await mongoCollection.updateOne({ '_id': objId }, { $unset: data.data });
            var results = await mongoCollection.findOne({ '_id': objId });
            console.log('Got results', results);
            if (results !== null) {
              ctx.bus.emit('data-update', {
                type: data.collection
                , op: 'update'
                , changes: ctx.ddata.processRawDataForRuntime([results])
              });
            }
          } catch (err) {
            console.error(err);
          }
        })();

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
      // NOTE: data.data can be a single object OR an array of objects
      // Array support added for MongoDB 5.x migration (insertOne -> handles arrays via iteration)
      socket.on('dbAdd', function dbAdd (data, callback) {
        console.log(LOG_WS + 'dbAdd client ID: ', socket.client.id, ' data: ', data);
        var collection = supportedCollections[data.collection];
        var maxtimediff = times.secs(2).msecs;

        var check = checkConditions('dbAdd', data);
        if (check) {
          if (callback) {
            callback(check);
          }
          return;
        }

        // Handle array input: process each item sequentially
        if (Array.isArray(data.data)) {
          console.log(LOG_WS + 'dbAdd received array with ' + data.data.length + ' items');
          (async function () {
            var results = [];

            for (var processIndex = 0; processIndex < data.data.length; processIndex += 1) {
              var itemData = {
                collection: data.collection,
                data: data.data[processIndex]
              };
              var itemResult = await processSingleDbAdd(itemData, collection, maxtimediff);
              if (itemResult && itemResult.length > 0) {
                results = results.concat(itemResult);
              }
            }

            if (callback) {
              callback(results);
            }
          })().catch(function (err) {
            console.error(err);
            if (callback) {
              callback([]);
            }
          });
          return;
        }

        // Single object processing
        processSingleDbAdd(data, collection, maxtimediff)
          .then(function (result) {
            if (callback) {
              callback(result);
            }
          })
          .catch(function (err) {
            console.error(err);
            if (callback) {
              callback([]);
            }
          });
      });

      async function processSingleDbAdd(data, collection, maxtimediff) {
        var mongoCollection = ctx.store.collection(collection);

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
          try {
            var array = await mongoCollection.find(query).toArray();
            if (array.length > 0) {
              console.log(LOG_DEDUP + 'Exact match');
              return [array[0]];
            }
          } catch (err) {
            console.error(err);
            return [];
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
          try {
            var similar = await mongoCollection.find(query_similiar).toArray();
            // if found similiar just update date. next time it will match exactly
            if (similar.length > 0) {
              console.log(LOG_DEDUP + 'Found similiar', similar[0]);
              similar[0].created_at = data.data.created_at;
              var objId = safeObjectID(similar[0]._id);
              await mongoCollection.updateOne({ '_id': objId }, { $set: { created_at: data.data.created_at } });
              ctx.bus.emit('data-received');
              return [similar[0]];
            }
          } catch (err) {
            console.error(err);
            return [];
          }

          // if not found create new record
          console.log(LOG_DEDUP + 'Adding new record');
          try {
            var insertResult = await mongoCollection.insertOne(data.data);
            var doc = data.data;
            doc._id = insertResult.insertedId;
            ctx.bus.emit('data-update', {
              type: data.collection
              , op: 'update'
              , changes: ctx.ddata.processRawDataForRuntime([doc])
            });
            ctx.bus.emit('data-received');
            return [doc];
          } catch (err) {
            if (err != null && err.message) {
              console.log('treatments data insertion error: ', err.message);
              return [];
            }
            throw err;
          }
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
          try {
            var existingStatus = await mongoCollection.find(queryDev).toArray();
            if (existingStatus.length > 0) {
              console.log(LOG_DEDUP + 'Devicestatus exact match');
              return [existingStatus[0]];
            }
          } catch (err) {
            console.error(err);
            return [];
          }

          try {
            var devicestatusInsertResult = await mongoCollection.insertOne(data.data);
            var devicestatusDoc = data.data;
            devicestatusDoc._id = devicestatusInsertResult.insertedId;
            ctx.bus.emit('data-update', {
              type: 'devicestatus'
              , op: 'update'
              , changes: ctx.ddata.processRawDataForRuntime([devicestatusDoc])
            });
            ctx.bus.emit('data-received');
            return [devicestatusDoc];
          } catch (err) {
            if (err != null && err.message) {
              console.log('devicestatus insertion error: ', err.message);
              return [];
            }
            throw err;
          }
          // profile deduping (AAPS V1 sync only sends dbAdd, never dbUpdate, for profile)
        } else if (data.collection === 'profile') {
          var profileQuery = null;
          if (data.data.NSCLIENT_ID) {
            profileQuery = { NSCLIENT_ID: data.data.NSCLIENT_ID };
          } else if (data.data.startDate) {
            profileQuery = { startDate: data.data.startDate };
          }

          if (profileQuery) {
            try {
              var existingProfile = await mongoCollection.findOne(profileQuery);
              if (existingProfile) {
                console.log(LOG_DEDUP + 'Profile match on ' + Object.keys(profileQuery).join(',') + '; replacing existing _id=' + existingProfile._id);
                var replacementDoc = Object.assign({}, data.data);
                replacementDoc._id = existingProfile._id;
                await mongoCollection.replaceOne({ _id: existingProfile._id }, replacementDoc);
                ctx.bus.emit('data-update', {
                  type: 'profile'
                  , op: 'update'
                  , changes: ctx.ddata.processRawDataForRuntime([replacementDoc])
                });
                ctx.bus.emit('data-received');
                return [replacementDoc];
              }
            } catch (err) {
              console.warn('profile dedup lookup error: ', err && err.message ? err.message : err);
              return [];
            }
          }

          try {
            var profileInsertResult = await mongoCollection.insertOne(data.data);
            var profileDoc = data.data;
            profileDoc._id = profileInsertResult.insertedId;
            ctx.bus.emit('data-update', {
              type: 'profile'
              , op: 'update'
              , changes: ctx.ddata.processRawDataForRuntime([profileDoc])
            });
            ctx.bus.emit('data-received');
            return [profileDoc];
          } catch (err) {
            if (err != null && err.message) {
              console.warn('profile insertion error: ', err.message);
              return [];
            }
            throw err;
          }
        } else {
          try {
            var genericInsertResult = await mongoCollection.insertOne(data.data);
            var genericDoc = data.data;
            genericDoc._id = genericInsertResult.insertedId;
            ctx.bus.emit('data-update', {
              type: data.collection
              , op: 'update'
              , changes: ctx.ddata.processRawDataForRuntime([genericDoc])
            });
            ctx.bus.emit('data-received');
            return [genericDoc];
          } catch (err) {
            if (err != null && err.message) {
              console.warn(data.collection + ' insertion error: ', err.message);
              return [];
            }
            throw err;
          }
        }
      }

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

        var objId = safeObjectID(data._id);
        (async function () {
          try {
            var stat = await ctx.store.collection(collection).deleteOne({ '_id': objId });
            ctx.bus.emit('data-update', {
              type: data.collection
              , op: 'remove'
              , count: stat.deletedCount
              , changes: data._id
            });
          } catch (err) {
            console.error(err);
          }
        })();

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
        const remoteIP = getRemoteIP(socket.request);
        verifyAuthorization(message, remoteIP, function verified (err, authorization) {

          if (err) {
            console.log('Websocket authorization failed:', err);
            socket.disconnect();
            return;
          }

          socket.emit('connected');

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
    });
  }

  function update () {
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

  start();
  listeners();

  if (ctx.storageSocket) {
    ctx.storageSocket.init(io);
  }

  if (ctx.alarmSocket) {
    ctx.alarmSocket.init(io);
  }

  return websocket();
}

module.exports = init;
