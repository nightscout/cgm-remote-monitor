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

      const remoteIP = getRemoteIP(socket.request);
      console.log(LOG_WS + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      io.emit('clients', ++watchers);
      socket.on('disconnect', function onDisconnect () {
        io.emit('clients', --watchers);
        console.log(LOG_WS + 'Disconnected client ID: ', socket.client.id);
      });

      function isDocument (value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      }

      function onceReply (callback) {
        if (typeof callback !== 'function') return null;

        var replied = false;
        return function replyOnce (result) {
          if (replied) return;
          replied = true;
          callback(result);
        };
      }

      function safelyNotify (notify) {
        try {
          notify();
        } catch (err) {
          console.error(err);
        }
      }

      function hasValidTreatmentDate (collection, document) {
        if (collection !== 'treatments'
          || !Object.prototype.hasOwnProperty.call(document, 'created_at')) return true;

        try {
          return Number.isFinite(new Date(document.created_at).getTime());
        } catch (err) {
          return false;
        }
      }

      function hasSafeIdentifier (data) {
        if (!Object.prototype.hasOwnProperty.call(data, '_id') || data._id === null) return false;
        return typeof data._id === 'string' || typeof data._id === 'number' || data._id instanceof ObjectID;
      }

      function hasSafeDedupFields (collection, document) {
        var fields = {
          treatments: ['NSCLIENT_ID', 'created_at', 'eventType', 'insulin', 'carbs', 'percent', 'absolute', 'duration']
          , devicestatus: ['NSCLIENT_ID', 'created_at']
          , profile: ['NSCLIENT_ID', 'startDate']
        }[collection] || [];

        if (Object.prototype.hasOwnProperty.call(document, '_id')
          && document._id !== null
          && typeof document._id !== 'string'
          && typeof document._id !== 'number'
          && !(document._id instanceof ObjectID)) {
          return false;
        }

        return fields.every(function (field) {
          var value = document[field];
          return !Object.prototype.hasOwnProperty.call(document, field)
            || value === null
            || typeof value !== 'object';
        }) && hasValidTreatmentDate(collection, document);
      }

      function literal (value) {
        return { $eq: value };
      }

      function visibleWriteResult (storedDocument, submittedDocument) {
        if (socketAuthorization.read) return storedDocument;

        // Keep a deduplication response within the caller's permissions.
        // Without read access, return only the submitted fields plus the
        // record id needed by legacy sync clients.
        var visible = Object.assign({}, submittedDocument);
        if (storedDocument && Object.prototype.hasOwnProperty.call(storedDocument, '_id')) {
          visible._id = storedDocument._id;
        }
        return visible;
      }

      function prepareDbAddDocument (collection, document) {
        if (collection === 'treatments' && !('eventType' in document)) {
          document.eventType = '<none>';
        }
        if (!('created_at' in document)) {
          document.created_at = new Date().toISOString();
        }
      }

      function checkConditions (action, data) {
        if (!isDocument(data)) {
          console.log('WS database call: ', 'Invalid request', data);
          return { result: 'Invalid request' };
        }

        if (typeof data.collection !== 'string'
          || !Object.prototype.hasOwnProperty.call(supportedCollections, data.collection)) {
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

        if (action === 'dbAdd') {
          var documents = Array.isArray(data.data) ? data.data : [data.data];
          if (!Object.prototype.hasOwnProperty.call(data, 'data')
            || !documents.every(isDocument)
            || !documents.every(function (document) {
              return hasSafeDedupFields(data.collection, document);
            })) {
            console.log('WS dbAdd call: ', 'Invalid data', data);
            return { result: 'Invalid data' };
          }
        }

        if (action === 'dbUpdate' || action === 'dbUpdateUnset') {
          if (!hasSafeIdentifier(data)) {
            console.log('WS database call: ', 'Missing or invalid _id', data);
            return { result: 'Missing or invalid _id' };
          }
          if (!Object.prototype.hasOwnProperty.call(data, 'data') || !isDocument(data.data)) {
            console.log('WS database call: ', 'Invalid data', data);
            return { result: 'Invalid data' };
          }
        }

        if (action === 'dbRemove' && !hasSafeIdentifier(data)) {
          console.log('WS database call: ', 'Missing or invalid _id', data);
          return { result: 'Missing or invalid _id' };
        }

        return null;
      }

      socket.on('loadRetro', function loadRetro (opts, callback) {
        var reply = onceReply(callback);
        if (reply) reply({ result: 'success' });
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
        var reply = onceReply(callback);

        var check = checkConditions('dbUpdate', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        var collection = supportedCollections[data.collection];
        var id = safeObjectID(data._id);

        // Sanitize free-text fields before persisting the $set update -
        // mirrors the purification applied on dbAdd / REST writes.
        try {
          ctx.purifier.purifyObject(data.data);
        } catch (err) {
          console.error(err);
          if (reply) reply({ result: 'Unable to process update' });
          return;
        }

        (async function () {
          var mongoCollection;
          try {
            mongoCollection = ctx.store.collection(collection);
            await mongoCollection.updateOne({ '_id': id }, { $set: data.data });
          } catch (err) {
            console.error(err);
            if (reply) reply({ result: 'Unable to process update' });
            return;
          }

          try {
            var results = await mongoCollection.findOne({ '_id': id });
            console.log('Got results', results);
            if (results !== null) {
              safelyNotify(function () {
                ctx.bus.emit('data-update', {
                  type: data.collection
                  , op: 'update'
                  , changes: ctx.ddata.processRawDataForRuntime([results])
                });
              });
            }
          } catch (err) {
            console.error(err);
          }

          safelyNotify(function () { ctx.bus.emit('data-received'); });
          if (reply) reply({ result: 'success' });
        })();
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
        var reply = onceReply(callback);

        var check = checkConditions('dbUpdateUnset', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        var collection = supportedCollections[data.collection];

        var objId = safeObjectID(data._id);
        (async function () {
          var mongoCollection;
          try {
            mongoCollection = ctx.store.collection(collection);
            await mongoCollection.updateOne({ '_id': objId }, { $unset: data.data });
          } catch (err) {
            console.error(err);
            if (reply) reply({ result: 'Unable to process update' });
            return;
          }

          try {
            var results = await mongoCollection.findOne({ '_id': objId });
            console.log('Got results', results);
            if (results !== null) {
              safelyNotify(function () {
                ctx.bus.emit('data-update', {
                  type: data.collection
                  , op: 'update'
                  , changes: ctx.ddata.processRawDataForRuntime([results])
                });
              });
            }
          } catch (err) {
            console.error(err);
          }

          safelyNotify(function () { ctx.bus.emit('data-received'); });
          if (reply) reply({ result: 'success' });
        })();
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
        var reply = onceReply(callback);
        var maxtimediff = times.secs(2).msecs;

        var check = checkConditions('dbAdd', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        var collection = supportedCollections[data.collection];

        // Validate and purify the whole batch before starting any write so an
        // invalid later item cannot leave a partial batch.
        try {
          var documents = Array.isArray(data.data) ? data.data : [data.data];
          documents.forEach(function (document) {
            ctx.purifier.purifyObject(document);
            prepareDbAddDocument(data.collection, document);
          });
        } catch (err) {
          console.error(err);
          if (reply) reply([]);
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

            if (reply) reply(results);
          })().catch(function (err) {
            console.error(err);
            if (reply) reply([]);
          });
          return;
        }

        // Single object processing
        processSingleDbAdd(data, collection, maxtimediff)
          .then(function (result) {
            if (reply) reply(result);
          })
          .catch(function (err) {
            console.error(err);
            if (reply) reply([]);
          });
      });

      async function processSingleDbAdd(data, collection, maxtimediff) {
        var mongoCollection = ctx.store.collection(collection);

        // treatments deduping
        if (data.collection === 'treatments') {
          var query;
          if (data.data.NSCLIENT_ID) {
            query = { NSCLIENT_ID: literal(data.data.NSCLIENT_ID) };
          } else {
            query = {
              created_at: literal(data.data.created_at)
              , eventType: literal(data.data.eventType)
            };
          }

          // try to find exact match
          try {
            var exactTreatment = await mongoCollection.findOne(query);
            if (exactTreatment) {
              console.log(LOG_DEDUP + 'Exact match');
              return [visibleWriteResult(exactTreatment, data.data)];
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
            query_similiar.insulin = literal(data.data.insulin);
            selected = true;
          }
          if (data.data.carbs) {
            query_similiar.carbs = literal(data.data.carbs);
            selected = true;
          }
          if (data.data.percent) {
            query_similiar.percent = literal(data.data.percent);
            selected = true;
          }
          if (data.data.absolute) {
            query_similiar.absolute = literal(data.data.absolute);
            selected = true;
          }
          if (data.data.duration) {
            query_similiar.duration = literal(data.data.duration);
            selected = true;
          }
          if (data.data.NSCLIENT_ID) {
            query_similiar.NSCLIENT_ID = literal(data.data.NSCLIENT_ID);
            selected = true;
          }
          // if none assigned add at least eventType
          if (!selected) {
            query_similiar.eventType = literal(data.data.eventType);
          }
          // try to find similiar
          try {
            var similar = await mongoCollection.findOne(query_similiar);
            // if found similiar just update date. next time it will match exactly
            if (similar) {
              console.log(LOG_DEDUP + 'Found similar treatment _id=' + similar._id);
              similar.created_at = data.data.created_at;
              var objId = safeObjectID(similar._id);
              await mongoCollection.updateOne({ '_id': objId }, { $set: { created_at: data.data.created_at } });
              safelyNotify(function () { ctx.bus.emit('data-received'); });
              return [visibleWriteResult(similar, data.data)];
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
            safelyNotify(function () {
              ctx.bus.emit('data-update', {
                type: data.collection
                , op: 'update'
                , changes: ctx.ddata.processRawDataForRuntime([doc])
              });
            });
            safelyNotify(function () { ctx.bus.emit('data-received'); });
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
            queryDev = { NSCLIENT_ID: literal(data.data.NSCLIENT_ID) };
          } else {
            queryDev = {
              created_at: literal(data.data.created_at)
            };
          }

          // try to find exact match
          try {
            var existingStatus = await mongoCollection.findOne(queryDev);
            if (existingStatus) {
              console.log(LOG_DEDUP + 'Devicestatus exact match');
              return [visibleWriteResult(existingStatus, data.data)];
            }
          } catch (err) {
            console.error(err);
            return [];
          }

          try {
            var devicestatusInsertResult = await mongoCollection.insertOne(data.data);
            var devicestatusDoc = data.data;
            devicestatusDoc._id = devicestatusInsertResult.insertedId;
            safelyNotify(function () {
              ctx.bus.emit('data-update', {
                type: 'devicestatus'
                , op: 'update'
                , changes: ctx.ddata.processRawDataForRuntime([devicestatusDoc])
              });
            });
            safelyNotify(function () { ctx.bus.emit('data-received'); });
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
            profileQuery = { NSCLIENT_ID: literal(data.data.NSCLIENT_ID) };
          } else if (data.data.startDate) {
            profileQuery = { startDate: literal(data.data.startDate) };
          }

          if (profileQuery) {
            try {
              var existingProfile = await mongoCollection.findOne(profileQuery);
              if (existingProfile) {
                console.log(LOG_DEDUP + 'Profile match on ' + Object.keys(profileQuery).join(',') + '; replacing existing _id=' + existingProfile._id);
                var replacementDoc = Object.assign({}, data.data);
                replacementDoc._id = existingProfile._id;
                await mongoCollection.replaceOne({ _id: existingProfile._id }, replacementDoc);
                safelyNotify(function () {
                  ctx.bus.emit('data-update', {
                    type: 'profile'
                    , op: 'update'
                    , changes: ctx.ddata.processRawDataForRuntime([replacementDoc])
                  });
                });
                safelyNotify(function () { ctx.bus.emit('data-received'); });
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
            safelyNotify(function () {
              ctx.bus.emit('data-update', {
                type: 'profile'
                , op: 'update'
                , changes: ctx.ddata.processRawDataForRuntime([profileDoc])
              });
            });
            safelyNotify(function () { ctx.bus.emit('data-received'); });
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
            safelyNotify(function () {
              ctx.bus.emit('data-update', {
                type: data.collection
                , op: 'update'
                , changes: ctx.ddata.processRawDataForRuntime([genericDoc])
              });
            });
            safelyNotify(function () { ctx.bus.emit('data-received'); });
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
        var reply = onceReply(callback);

        var check = checkConditions('dbRemove', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        var collection = supportedCollections[data.collection];

        var objId = safeObjectID(data._id);
        (async function () {
          var stat;
          try {
            stat = await ctx.store.collection(collection).deleteOne({ '_id': objId });
          } catch (err) {
            console.error(err);
            if (reply) reply({ result: 'Unable to process removal' });
            return;
          }

          safelyNotify(function () {
            ctx.bus.emit('data-update', {
              type: data.collection
              , op: 'remove'
              , count: stat.deletedCount
              , changes: data._id
            });
          });
          safelyNotify(function () { ctx.bus.emit('data-received'); });
          if (reply) reply({ result: 'success' });
        })();
      });

      // Authorization message
      // {
      //  client: 'web' | 'phone' | 'pump'
      //  , secret: 'secret_hash'
      //  [, history : history_in_hours ]
      //  [, status : true ]
      // }
      socket.on('authorize', function authorize (message, callback) {
        var authMessage = isDocument(message) ? message : {};
        var reply = onceReply(callback);
        const remoteIP = getRemoteIP(socket.request);
        verifyAuthorization(authMessage, remoteIP, function verified (err, authorization) {

          if (err) {
            console.log('Websocket authorization failed:', err);
            socket.disconnect();
            return;
          }

          socket.emit('connected');

          socketAuthorization = authorization;
          if (socketAuthorization.read) {
            socket.join('DataReceivers');

            if (lastData && lastData.dataWithRecentStatuses) {
              let data = lastData.dataWithRecentStatuses();

              if (authMessage.status) {
                data.status = status(data.profiles);
              }

              socket.emit('dataUpdate', data);
            }
          }
          if (reply) reply(socketAuthorization);
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
      } // else { console.log('delta calculation indicates no new data is present'); }
    }
    lastData = ctx.ddata.clone();
  }

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
