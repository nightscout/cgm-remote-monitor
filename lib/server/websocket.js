'use strict';

const writeValidation = require('./write-validation');
const reads = require('./storage-reads');
const writes = require('./storage-writes');

var idForms = require('./object-id-forms');
var fallbackKey = require('./treatment-fallback-key');
var srvDates = require('./srv-dates');
var softDeleted = require('./soft-deleted');
var mergePatch = require('./merge-patch');
var targetUnits = require('../treatmentTargetUnits');
var validatedUpdate = require('../storage/validated-update');
var times = require('../times');
var calcData = require('../data/calcdelta');
var ObjectID = require('mongodb').ObjectId;
const { clientIPFor } = require('./client-ip');
const { recordForLog, debugLogging: isDebugLogging } = require('./log-privacy');

// The records a client means by an _id. A 24-hex id (or an ObjectId) matches
// the record whichever form its _id is stored in: the ObjectId, or the
// string, as dbAdd and the v1 routes stored it before. Both forms can be
// stored at once (an ObjectId copy left beside a string one by an earlier
// write), so writes by such an id reach every copy (`many`). Any other id,
// such as a custom string, matches exactly one record, as given.
function idMatch (id) {
  if (id instanceof ObjectID || idForms.isHexId(id)) {
    return { filter: { _id: { $in: idForms.idForms(id) } }, many: true };
  }
  return { filter: { _id: id }, many: false };
}

function init (env, ctx, server) {
  const getRemoteIP = clientIPFor(env);
  // DEBUG_LOGGING is the one gate for record payloads in the log (BF-193).
  const debugLogging = isDebugLogging(env);

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

  // The collections API v3 serves: writes to them carry srvModified and
  // srvCreated, which v3 history reads (see srv-dates). activity has no v3
  // endpoint.
  var v3Collections = ['treatments', 'entries', 'devicestatus', 'profile', 'food'];
  function servedByV3 (name) {
    return v3Collections.indexOf(name) !== -1;
  }

  // Socket reads and writes go through the storage interface, labelled
  // 'socket'. `validated` says dbAdd has already applied the domain rules
  // (see lib/storage/write-step.js).
  function socketStore (name, validated) {
    return reads.collection(ctx, env, supportedCollections[name], name
      , validated ? { source: 'socket', validated: true } : { source: 'socket' });
  }

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
      // What this socket authorized with, redacted from refusal payloads.
      var socketCredentials = [];

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

      // A summary of a socket write for the log: the record's values only
      // with DEBUG_LOGGING on. A refusal (`untrusted`) may come from a caller
      // that is not authenticated, so its payload is also redacted and bounded.
      function writeForLog (op, data, untrusted) {
        var envelope = isDocument(data) ? data : null;
        return recordForLog(envelope ? envelope.data : data, {
          op: op
          , collection: envelope ? envelope.collection : undefined
          , client: socket.client.id
          , ref: envelope ? envelope._id : undefined
          , payload: data
          , debug: debugLogging
          , untrusted: untrusted
          , credentials: socketCredentials
        });
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

      // A conditional multi-update may commit an earlier id form before a
      // later form conflicts. The client still receives its existing failure
      // reply, but cached/live state must reflect whatever reached MongoDB.
      async function reconcilePartialWrite (mongoCollection, collection, match, err) {
        if (!mongoCollection || !err || !err.result || !(err.result.modifiedCount > 0)) return;
        try {
          const ids = match.many ? match.filter._id.$in : [match.filter._id];
          // Invalidate first, so an in-flight loader cannot restore an older
          // snapshot and a concurrently deleted form cannot stay in cache.
          ctx.bus.emit('data-update', {type: collection, op: 'remove', changes: ids});
          let changedDuringRead = false;
          const onChange = function (change) {
            if (change && change.type === collection) changedDuringRead = true;
          };
          ctx.bus.on('data-update', onChange);
          let docs;
          try {
            docs = await reads.findAll(mongoCollection, match.filter);
          } finally {
            ctx.bus.removeListener('data-update', onChange);
          }
          // A concurrent writer may have updated the cache after our query's
          // snapshot. Never replace that newer state with an old reread.
          if (changedDuringRead) throw new Error('cache changed during reconciliation');
          if (docs.length) {
            const changes = ctx.ddata.processRawDataForRuntime(docs);
            ctx.bus.emit('data-update', {type: collection, op: 'update', changes: changes});
          }
        } catch {
          console.error('Unable to refresh a partially committed socket update; invalidating cache');
          // Force a full reload of this collection without discarding other
          // cached data. Fall back to the existing global invalidation if the
          // cache is unavailable or does not support this collection.
          try {
            if (!ctx.cache || !ctx.cache.invalidate(collection)) throw new Error('cache unavailable');
          } catch {
            safelyNotify(function () {
              ctx.bus.emit('data-update', {type: collection, op: 'remove', changes: null});
            });
          }
        } finally {
          safelyNotify(function () { ctx.bus.emit('data-received'); });
        }
      }

      function hasValidTreatmentDate (collection, document) {
        if (collection !== 'treatments'
          || !Object.prototype.hasOwnProperty.call(document, 'created_at')) return true;

        try {
          return Number.isFinite(new Date(document.created_at).getTime());
        } catch {
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
          console.log('WS database call: ', 'Invalid request', writeForLog(action, data, true));
          return { result: 'Invalid request' };
        }

        if (typeof data.collection !== 'string'
          || !Object.prototype.hasOwnProperty.call(supportedCollections, data.collection)) {
          console.log('WS dbUpdate/dbAdd call: ', 'Wrong collection', writeForLog(action, data, true));
          return { result: 'Wrong collection' };
        }

        if (!socketAuthorization) {
          console.log('WS dbUpdate/dbAdd call: ', 'Not authorized', writeForLog(action, data, true));
          return { result: 'Not authorized' };
        }

        if (data.collection === 'treatments') {
          if (!socketAuthorization.write_treatment) {
            console.log('WS dbUpdate/dbAdd call: ', 'Not permitted', writeForLog(action, data, true));
            return { result: 'Not permitted' };
          }
        } else {
          if (!socketAuthorization.write) {
            console.log('WS dbUpdate call: ', 'Not permitted', writeForLog(action, data, true));
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
            console.log('WS dbAdd call: ', 'Invalid data', writeForLog(action, data, true));
            return { result: 'Invalid data' };
          }
        }

        if (action === 'dbUpdate' || action === 'dbUpdateUnset') {
          if (!hasSafeIdentifier(data)) {
            console.log('WS database call: ', 'Missing or invalid _id', writeForLog(action, data, true));
            return { result: 'Missing or invalid _id' };
          }
          if (!Object.prototype.hasOwnProperty.call(data, 'data') || !isDocument(data.data)) {
            console.log('WS database call: ', 'Invalid data', writeForLog(action, data, true));
            return { result: 'Invalid data' };
          }
        }

        if (action === 'dbRemove' && !hasSafeIdentifier(data)) {
          console.log('WS database call: ', 'Missing or invalid _id', writeForLog(action, data, true));
          return { result: 'Missing or invalid _id' };
        }

        return null;
      }

      /* Resolve read access for a socket that may never have sent `authorize`.
       *
       * An authorized socket already carries the decision the `authorize`
       * handler made. An anonymous one carries nothing, and asking
       * verifyAuthorization with an empty message resolves exactly the default
       * permissions `authorize` would have resolved for it - the same
       * AUTH_DEFAULT_ROLES shiros the REST surface answers with. So an instance
       * left on the documented `readable` default keeps serving anonymous
       * clients, and one on `denied` refuses them here as it does everywhere
       * else.
       */
      function resolveReadAccess (next) {
        if (socketAuthorization) return next(Boolean(socketAuthorization.read));

        verifyAuthorization({}, remoteIP, function resolved (err, authorization) {
          next(!err && Boolean(authorization && authorization.read));
        });
      }

      socket.on('loadRetro', function loadRetro (opts, callback) {
        var reply = onceReply(callback);

        resolveReadAccess(function withReadAccess (permitted) {
          if (!permitted) {
            console.log(LOG_WS + 'loadRetro: ', 'Not permitted');
            if (reply) reply({ result: 'Not permitted' });
            return;
          }

          if (reply) reply({ result: 'success' });
          //TODO: use opts to only send delta for retro data
          socket.compress(true).emit('retroUpdate', { devicestatus: lastData.devicestatus });
          console.info('sent retroUpdate', opts);
        });
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
        var reply = onceReply(callback);

        var check = checkConditions('dbUpdate', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        // Logged once the write is accepted: a refusal logs its own line.
        console.log(LOG_WS + writeForLog('dbUpdate', data));
        var match = idMatch(data._id);

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
            mongoCollection = socketStore(data.collection);
            var setFields = data.data;
            if (servedByV3(data.collection)) {
              setFields = Object.assign({}, data.data);
              srvDates.stampModified(setFields);
            }
            // data.data is a JSON Merge Patch, as an API v3 PATCH body is
            // (RFC 7386, write-contract Q1b, decided 2026-10-26): a field
            // sent as null is removed, at any depth, and an object merges
            // into the stored object. Each record it names is read and
            // merged on its own; a body without a null or an object member
            // is the plain $set it always was. dbUpdateUnset is unchanged.
            // Reads and writes go through the storage interface.
            //
            // A Temporary Target is stored in mg/dL (BF-194): an update that
            // sends a target, glucose, units or eventType is converted against
            // the records it names, after it is validated as sent, and then
            // carries both targets and the label as they will be stored. When
            // every record gets the same fields (one record, or its twins),
            // they are written as one update, as before.
            var converted = data.collection === 'treatments' && targetUnits.touches(setFields)
              ? await targetUnitsUpdates(mongoCollection, match, setFields) : null;
            if (converted && converted.fields) setFields = converted.fields;
            if (converted && converted.each) {
              for (var c = 0; c < converted.each.length; c += 1) {
                var convertedUpdate = mergePatch.toMongo(mergePatch.update(converted.each[c].stored, converted.each[c].fields));
                if (Object.keys(convertedUpdate).length > 0) {
                  await writes.update(mongoCollection, { _id: converted.each[c].stored._id }, convertedUpdate, { one: true });
                }
              }
            } else if (!mergePatch.differsFromSet(setFields)) {
              await writes.update(mongoCollection, match.filter, { $set: setFields }, { one: !match.many });
            } else {
              var targets = match.many
                ? await reads.findAll(mongoCollection, match.filter)
                : [await reads.findOne(mongoCollection, match.filter)].filter(Boolean);
              for (var t = 0; t < targets.length; t += 1) {
                var parts = mergePatch.update(targets[t], setFields);
                var mergeUpdate = mergePatch.toMongo(parts);
                if (Object.keys(mergeUpdate).length > 0) {
                  await writes.update(mongoCollection, { _id: targets[t]._id }, mergeUpdate, { one: true });
                }
              }
            }
          } catch (err) {
            await reconcilePartialWrite(mongoCollection, data.collection, match, err);
            console.error(err);
            if (reply) reply({ result: 'Unable to process update' });
            return;
          }

          try {
            var results = await reads.findOne(mongoCollection, match.filter);
            console.log('Got results', recordForLog(results, { collection: data.collection, debug: debugLogging }));
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

      // The fields a dbUpdate sets on the Temporary Targets it names, with
      // the targets in mg/dL (lib/treatmentTargetUnits.js): { fields } when
      // they are the same for every record named, { each: [{ stored, fields }] }
      // when they differ, or null when it names no Temporary Target and the
      // update is written as before. WRITE_VALIDATION checks the update as
      // sent; the storage write checks it again as converted.
      async function targetUnitsUpdates (mongoCollection, match, setFields) {
        var stored = match.many
          ? await reads.findAll(mongoCollection, match.filter)
          : [await reads.findOne(mongoCollection, match.filter)].filter(Boolean);
        var anyTarget = false;
        var updates = stored.map(function (doc) {
          var fields = Object.assign({}, setFields);
          if (writeValidation.mode(env) !== 'off' && writeValidation.touchesDomain(setFields)) {
            validatedUpdate.checkedUpdate({ $set: Object.assign({}, fields) }, doc, { env: env, source: 'socket' });
          }
          if (targetUnits.normalizeTargetUnits(fields, doc)) anyTarget = true;
          return { stored: doc, fields: fields };
        });
        if (!anyTarget) return null;
        var first = JSON.stringify(updates[0].fields);
        var uniform = updates.every(function (u) { return JSON.stringify(u.fields) === first; });
        return uniform ? { fields: updates[0].fields } : { each: updates };
      }

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
        var reply = onceReply(callback);

        var check = checkConditions('dbUpdateUnset', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        // Logged once the write is accepted: a refusal logs its own line.
        console.log(LOG_WS + writeForLog('dbUpdateUnset', data));

        var unsetMatch = idMatch(data._id);
        (async function () {
          var mongoCollection;
          try {
            mongoCollection = socketStore(data.collection);
            var unsetUpdate = { $unset: data.data };
            if (servedByV3(data.collection)) {
              // The server's own times cannot be unset; srvModified is set.
              var unsetFields = Object.assign({}, data.data);
              delete unsetFields.srvModified;
              delete unsetFields.srvCreated;
              unsetUpdate = { $set: {} };
              srvDates.stampModified(unsetUpdate.$set);
              if (Object.keys(unsetFields).length > 0) unsetUpdate.$unset = unsetFields;
            }
            await writes.update(mongoCollection, unsetMatch.filter, unsetUpdate, { one: !unsetMatch.many });
          } catch (err) {
            await reconcilePartialWrite(mongoCollection, data.collection, unsetMatch, err);
            console.error(err);
            if (reply) reply({ result: 'Unable to process update' });
            return;
          }

          try {
            var results = await reads.findOne(mongoCollection, unsetMatch.filter);
            console.log('Got results', recordForLog(results, { collection: data.collection, debug: debugLogging }));
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

      // `failed` is an outcome marker in socket batches, not a client field
      // on a validation refusal. Keep v1's existing refusal behavior intact.
      function socketTreatmentRefusal (document, problems) {
        var slot = writeValidation.refusal(document, problems);
        delete slot.failed;
        return slot;
      }

      // A storage error may occur after MongoDB committed the write. Avoid
      // claiming either persistence or a validation refusal until confirmed.
      function unconfirmedTreatmentWrite (document) {
        var slot = Object.assign({}, document);
        delete slot._id;
        delete slot.refused;
        slot.failed = {status: 500, message: 'Treatment write could not be confirmed'};
        return slot;
      }

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
        var reply = onceReply(callback);
        var maxtimediff = times.secs(2).msecs;

        var check = checkConditions('dbAdd', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        // Logged once the write is accepted: a refusal logs its own line.
        console.log(LOG_WS + writeForLog('dbAdd', data));

        // Prepare the batch before writing. Domain refusals keep their input
        // slot, as on v1; valid items still reach the existing persistence path.
        var refusals = [];
        try {
          var documents = Array.isArray(data.data) ? data.data : [data.data];
          documents.forEach(function (document, index) {
            ctx.purifier.purifyObject(document);
            prepareDbAddDocument(data.collection, document);
            if (data.collection === 'treatments') {
              try {
                writeValidation.enforce(env, 'socket', document);
              } catch (err) {
                if (!writeValidation.isValidationError(err)) throw err;
                refusals[index] = socketTreatmentRefusal(document, err.problems);
              }
              // A Temporary Target is stored in mg/dL (BF-194), after validation.
              if (!refusals[index]) targetUnits.normalizeTargetUnits(document);
            }
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
            var orderedTreatments = data.collection === 'treatments' && writeValidation.mode(env) === 'reject';

            for (var processIndex = 0; processIndex < data.data.length; processIndex += 1) {
              if (refusals[processIndex]) {
                results.push(refusals[processIndex]);
                continue;
              }
              var itemData = {
                collection: data.collection,
                data: data.data[processIndex]
              };
              // Keep a pre-write copy: the write path can add server timestamps
              // before an error, but they must not appear as a confirmed write.
              var submitted = orderedTreatments ? Object.assign({}, itemData.data) : null;
              var itemResult;
              try {
                itemResult = await processSingleDbAdd(itemData, maxtimediff);
              } catch (err) {
                if (!orderedTreatments) throw err;
                if (writeValidation.isValidationError(err)) {
                  itemResult = [socketTreatmentRefusal(submitted, err.problems)];
                } else {
                  console.error('Unable to confirm a socket treatment write');
                }
              }
              if (orderedTreatments) {
                if (Array.isArray(itemResult) && itemResult.length === 1 && itemResult[0] != null) {
                  results.push(itemResult[0]);
                } else {
                  results.push(unconfirmedTreatmentWrite(submitted));
                }
              } else if (itemResult && itemResult.length > 0) {
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

        // A socket has no HTTP status: even an entirely refused request needs
        // an explicit refusal object, rather than the ambiguous legacy [].
        if (refusals[0]) {
          if (reply) reply([refusals[0]]);
          return;
        }

        // Single object processing
        processSingleDbAdd(data, maxtimediff)
          .then(function (result) {
            if (reply) reply(result);
          })
          .catch(function (err) {
            console.error(err);
            if (reply) reply([]);
          });
      });

      // A 24-hex _id is stored as the ObjectId it names, as the v1 routes
      // store it, unless the same id is already stored as a string: then the
      // stored value is kept, so the insert collides with that record as a
      // re-sent record always has, instead of adding an ObjectId copy beside
      // it. One read, only for a record that carries a 24-hex _id. Any other
      // _id (a custom string or a number) is kept as given.
      async function storeIdAsObjectId (mongoCollection, document) {
        if (!idForms.isHexId(document._id)) return;
        var stale = await reads.findOne(mongoCollection
          , { _id: { $in: idForms.stringIdForms(document._id) } }
          , { _id: 1 });
        document._id = stale ? stale._id : idForms.toStoredId(document._id);
      }

      // An insert through the interface keeps the document as given
      // (normalize: false), so the _id the driver assigned is on it, as
      // insertedId was.
      async function insertDocument (mongoCollection, doc) {
        await mongoCollection.insertOne(doc, { normalize: false });
        return { insertedId: doc._id };
      }

      async function processSingleDbAdd(data, maxtimediff) {
        var mongoCollection = socketStore(data.collection, true);

        try {
          await storeIdAsObjectId(mongoCollection, data.data);
        } catch (err) {
          console.error(err);
          return [];
        }

        // treatments deduping
        if (data.collection === 'treatments') {
          var query;
          if (data.data.NSCLIENT_ID) {
            query = { NSCLIENT_ID: literal(data.data.NSCLIENT_ID) };
          } else {
            // created_at + eventType, with the client's identity (BF-121; see
            // treatment-fallback-key). Amounts are not added here: a socket
            // re-send after a lost reply may carry an edited amount.
            query = fallbackKey.fallbackQuery(data.data, data.data.created_at);
          }

          // try to find exact match
          try {
            // A deleted record (isValid: false) is not a copy of a new one.
            var exactTreatment = await reads.findOne(mongoCollection, softDeleted.visible(query));
            if (exactTreatment) {
              console.log(LOG_DEDUP + 'Exact match');
              return [visibleWriteResult(exactTreatment, data.data)];
            }
          } catch (err) {
            console.error(err);
            return [];
          }

          var query_similiar = {
            created_at: { $gte: new Date(new Date(data.data.created_at).getTime() - maxtimediff).toISOString(), $lte: new Date(new Date(data.data.created_at).getTime() + maxtimediff).toISOString() }
          };
          // BF-09: what a zero means in the similar match.
          // - percent, absolute, duration: 0 is a value and must be equal. A
          //   zero temp (absolute 0) is the suspend an AID sends, percent 0 is
          //   a 100 % temp (AndroidAPS sends rate - 100), duration 0 is a
          //   cancel or a temp shorter than a minute. Left out, a zero temp
          //   was taken for an earlier temp of the same duration and dropped.
          // - insulin, carbs: 0 means none. It matches a record with none (0
          //   or absent), never one with an amount, so a zero bolus is not
          //   taken for a 1 U bolus. A zero sent as filler (xDrip+ sends both
          //   fields on every record, API v1 storage removes a zero) still
          //   matches the same record stored without it. An amount the write
          //   does not carry, or carries as '', false or null, means none
          //   too (BF-210): a write without insulin is not taken for a stored
          //   bolus.
          // For percent, absolute and duration, '', false and null are not
          // keys, as before.
          ['insulin', 'carbs'].forEach(function (field) {
            var value = data.data[field];
            if (value) {
              query_similiar[field] = literal(value);
            } else {
              query_similiar[field] = { $in: [0, null] };
            }
          });
          ['percent', 'absolute', 'duration'].forEach(function (field) {
            var value = data.data[field];
            if (value || value === 0) {
              query_similiar[field] = literal(value);
            }
          });
          // The client identity rule of the exact match (BF-209; see
          // treatment-fallback-key): a write with a client identity matches
          // only a record with the same one, and a write without one matches
          // only a record without one. An `identifier` the write carries
          // decides on its own: the same one is a re-send, another one is a
          // second record.
          Object.assign(query_similiar, fallbackKey.identityQuery(data.data, { identifier: true }));
          // A similar record is always of the same eventType, whether or not an
          // amount was matched: a Meal Bolus with the same carbs as a Carb
          // Correction a second earlier is a second entry, not a copy (BF-121).
          query_similiar.eventType = literal(data.data.eventType);
          // try to find similiar
          try {
            var similar = await reads.findOne(mongoCollection, softDeleted.visible(query_similiar));
            // if found similiar just update date. next time it will match exactly
            if (similar) {
              console.log(LOG_DEDUP + 'Found similar treatment _id=' + similar._id);
              similar.created_at = data.data.created_at;
              // similar._id is the stored value itself, whichever form it has.
              var similarFields = { created_at: data.data.created_at };
              srvDates.stampModified(similarFields);
              await writes.update(mongoCollection, { '_id': similar._id }, { $set: similarFields }, { one: true });
              similar.srvModified = similarFields.srvModified;
              safelyNotify(function () { ctx.bus.emit('data-received'); });
              return [visibleWriteResult(similar, data.data)];
            }
          } catch (err) {
            // A valid upload can match an invalid stored target, or lose a
            // validation race. Keep this late refusal in the same reply slot
            // as preflight refusals, for both single objects and batches.
            if (writeValidation.isValidationError(err)) {
              return [socketTreatmentRefusal(data.data, err.problems)];
            }
            console.error(err);
            return [];
          }

          // if not found create new record
          console.log(LOG_DEDUP + 'Adding new record');
          try {
            srvDates.stampCreated(data.data);
            var insertResult = await insertDocument(mongoCollection, data.data);
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
            var existingStatus = await reads.findOne(mongoCollection, softDeleted.visible(queryDev));
            if (existingStatus) {
              console.log(LOG_DEDUP + 'Devicestatus exact match');
              return [visibleWriteResult(existingStatus, data.data)];
            }
          } catch (err) {
            console.error(err);
            return [];
          }

          try {
            srvDates.stampCreated(data.data);
            var devicestatusInsertResult = await insertDocument(mongoCollection, data.data);
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
              var existingProfile = await reads.findOne(mongoCollection, profileQuery);
              if (existingProfile) {
                console.log(LOG_DEDUP + 'Profile match on ' + Object.keys(profileQuery).join(',') + '; replacing existing _id=' + existingProfile._id);
                var replacementDoc = Object.assign({}, data.data);
                replacementDoc._id = existingProfile._id;
                srvDates.carry(replacementDoc, existingProfile, srvDates.next());
                await writes.replace(mongoCollection, { _id: existingProfile._id }, replacementDoc);
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
            srvDates.stampCreated(data.data);
            var profileInsertResult = await insertDocument(mongoCollection, data.data);
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
            if (servedByV3(data.collection)) srvDates.stampCreated(data.data);
            var genericInsertResult = await insertDocument(mongoCollection, data.data);
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
        var reply = onceReply(callback);

        var check = checkConditions('dbRemove', data);
        if (check) {
          if (reply) reply(check);
          return;
        }
        // Logged once the write is accepted: a refusal logs its own line.
        console.log(LOG_WS + writeForLog('dbRemove', data));

        var removeMatch = idMatch(data._id);
        (async function () {
          var stat;
          try {
            stat = await writes.remove(socketStore(data.collection), removeMatch.filter, { one: !removeMatch.many });
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
              , changes: idForms.cacheRemoval(data._id, stat.deletedCount)
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
        socketCredentials = [authMessage.secret, authMessage.token];
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
