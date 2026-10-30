'use strict';

const writeValidation = require('./write-validation');
const reads = require('./storage-reads');
const writeIntent = require('../storage/write-intent');

var idForms = require('./object-id-forms');
var calcData = require('../data/calcdelta');
var ObjectID = require('mongodb').ObjectId;
const { clientIPFor } = require('./client-ip');
const { recordForLog, debugLogging: isDebugLogging } = require('./log-privacy');

function init (env, ctx, server) {
  const getRemoteIP = clientIPFor(env);
  // DEBUG_LOGGING is the one gate for record payloads in the log (BF-193).
  const debugLogging = isDebugLogging(env);

  function websocket () {
    return websocket;
  }

  //var log_yellow = '\x1B[33m';
  var log_green = '\x1B[32m';
  var log_reset = '\x1B[0m';
  var LOG_WS = log_green + 'WS: ' + log_reset;

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

  // Socket reads and writes go through the storage interface, labelled
  // 'socket'. `validated` says dbAdd has already applied the domain rules
  // (see lib/storage/write-step.js).
  function socketStore (name, validated) {
    return reads.collection(ctx, env, supportedCollections[name], name
      , validated ? { source: 'socket', validated: true } : { source: 'socket' });
  }

  // The write step over one collection, on the same storage
  // (lib/storage/write-intent.js): every socket write goes through it
  // (WC-STEP-PATCH slices 3 and 6). `storage`, when given, is the storage
  // interface the handler already holds, so the step writes through it.
  function socketStep (name, validated, storage) {
    return writeIntent.forCollection(storage || function acquired ( ) { return socketStore(name, validated); }
      , name, 'socket', { env: env });
  }

  // dbAdd of these collections is matched against the stored records (the
  // step's socket-add rules) and answered from what matched; every other
  // collection's is a plain insert (processGenericDbAdd).
  var dedupedOnAdd = ['treatments', 'devicestatus', 'profile'];

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
        if (!mongoCollection || !match || !err || !err.result || !(err.result.modifiedCount > 0)) return;
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

      // decision 4 (ID-FIRST-MATCH): with no _id (absent or null), an edit or
      // remove is addressed by an identifier the step can address by
      // (writeIntent.isAddressableIdentifier). A request that sends an _id is
      // addressed by it alone, as before.
      function addressesByIdentifier (data) {
        return (!Object.prototype.hasOwnProperty.call(data, '_id') || data._id === null)
          && writeIntent.isAddressableIdentifier(data.identifier);
      }

      // What an edit or remove names, for the step: its _id, else its identifier.
      function addressOf (data) {
        return hasSafeIdentifier(data) ? { _id: data._id } : { identifier: data.identifier };
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
          if (!hasSafeIdentifier(data) && !addressesByIdentifier(data)) {
            console.log('WS database call: ', 'Missing or invalid _id', writeForLog(action, data, true));
            return { result: 'Missing or invalid _id' };
          }
          if (!Object.prototype.hasOwnProperty.call(data, 'data') || !isDocument(data.data)) {
            console.log('WS database call: ', 'Invalid data', writeForLog(action, data, true));
            return { result: 'Invalid data' };
          }
        }

        if (action === 'dbRemove' && !hasSafeIdentifier(data) && !addressesByIdentifier(data)) {
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
        // The records data._id names (the step's socket _id match), resolved
        // now; the write, the read-back and a reconciliation use the same.
        // Addressed by identifier (no _id), the step resolves the record when
        // it writes and leaves the match on the plan (null: none named).
        var planned = socketStep(data.collection).plan({ op: 'update', form: 'merge', target: addressOf(data), fields: data.data });

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
            // Through the step: srvModified where API v3 serves the
            // collection, BF-194 for a Temporary Target, and data.data as a
            // JSON Merge Patch (Q1b) of each record the _id names.
            await socketStep(data.collection, false, mongoCollection).write(planned);
          } catch (err) {
            await reconcilePartialWrite(mongoCollection, data.collection, planned.match, err);
            console.error(err);
            if (reply) reply({ result: 'Unable to process update' });
            return;
          }

          try {
            var results = planned.match ? await reads.findOne(mongoCollection, planned.match.filter) : null;
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

        var unsetPlanned = socketStep(data.collection).plan({ op: 'update', form: 'unset', target: addressOf(data), fields: data.data });
        (async function () {
          var mongoCollection;
          try {
            mongoCollection = socketStore(data.collection);
            // Through the step: where API v3 serves the collection the
            // server's own times cannot be unset, and srvModified is set.
            await socketStep(data.collection, false, mongoCollection).write(unsetPlanned);
          } catch (err) {
            await reconcilePartialWrite(mongoCollection, data.collection, unsetPlanned.match, err);
            console.error(err);
            if (reply) reply({ result: 'Unable to process update' });
            return;
          }

          try {
            var results = unsetPlanned.match ? await reads.findOne(mongoCollection, unsetPlanned.match.filter) : null;
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
          var preflight = data.collection === 'treatments' ? socketStep(data.collection, true) : null;
          documents.forEach(function (document, index) {
            ctx.purifier.purifyObject(document);
            prepareDbAddDocument(data.collection, document);
            if (preflight) {
              // The step's check: WRITE_VALIDATION as sent, then BF-194 (a
              // Temporary Target stored in mg/dL) on what it does not refuse.
              preflight.check([document]).forEach(function (refused) {
                refusals[index] = socketTreatmentRefusal(document, refused.problems);
              });
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
                itemResult = await processSingleDbAdd(itemData);
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
        processSingleDbAdd(data)
          .then(function (result) {
            if (reply) reply(result);
          })
          .catch(function (err) {
            console.error(err);
            if (reply) reply([]);
          });
      });

      // dbAdd of a collection with no matching of its own (entries, food,
      // activity): the step applies the socket's _id form, server dates and
      // the plain insert. A record whose _id is already stored is refused
      // and answered with an empty reply; a failed _id read is answered the
      // same, logged as an error; any other storage error as before.
      async function processGenericDbAdd (data) {
        var result;
        try {
          result = await socketStep(data.collection, true).write({ op: 'create', docs: [data.data] });
        } catch (err) {
          if (err instanceof writeIntent.WriteRuleError && err.rule === 'id-form') {
            console.error(err.cause);
            return [];
          }
          if (err != null && err.message) {
            console.warn(data.collection + ' insertion error: ', err.message);
            return [];
          }
          throw err;
        }
        var written = result.items[0];
        if (written.outcome === 'refused') {
          console.warn(data.collection + ' insertion error: ', written.reason);
          return [];
        }
        var genericDoc = data.data;
        genericDoc._id = written._id;
        safelyNotify(function () {
          ctx.bus.emit('data-update', {
            type: data.collection
            , op: 'update'
            , changes: ctx.ddata.processRawDataForRuntime([genericDoc])
          });
        });
        safelyNotify(function () { ctx.bus.emit('data-received'); });
        return [genericDoc];
      }

      // What the socket logs when a matched dbAdd's insert fails, as it did.
      var insertionErrorLog = {
        treatments: function (message) { console.log('treatments data insertion error: ', message); }
        , devicestatus: function (message) { console.log('devicestatus insertion error: ', message); }
        , profile: function (message) { console.warn('profile insertion error: ', message); }
      };

      // dbAdd of treatments, devicestatus and profile, through the step
      // (WC-STEP-PATCH slice 6): the socket's _id form, the exact match, for
      // treatments the +-2 s similar match, else an insert. Answered from the
      // item: an exact match of a treatment or status with the stored record
      // and no event; a similar match with the moved record and data-received
      // only; a replaced profile or a new record with what was written,
      // data-update and data-received. A storage error under a rule is
      // answered as it was: a late WRITE_VALIDATION refusal (similar match) in
      // its slot, anything else with an empty reply; an error with no message
      // from the insert, or one in building a query, is thrown.
      async function processSingleDbAdd (data) {
        if (dedupedOnAdd.indexOf(data.collection) === -1) return processGenericDbAdd(data);

        var result;
        try {
          result = await socketStep(data.collection, true).write({ op: 'create', docs: [data.data] });
        } catch (err) {
          if (!(err instanceof writeIntent.WriteRuleError)) throw err;
          var cause = err.cause;
          if (err.rule === 'insert') {
            if (cause != null && cause.message) {
              insertionErrorLog[data.collection](cause.message);
              return [];
            }
            throw cause;
          }
          if (err.rule === 'similar-match' && writeValidation.isValidationError(cause)) {
            // A valid upload can match an invalid stored target, or lose a
            // validation race. Keep this late refusal in the same reply slot
            // as preflight refusals, for both single objects and batches.
            return [socketTreatmentRefusal(data.data, cause.problems)];
          }
          if (err.rule === 'exact-match' && data.collection === 'profile') {
            console.warn('profile dedup lookup error: ', cause && cause.message ? cause.message : cause);
            return [];
          }
          console.error(cause);
          return [];
        }

        var written = result.items[0];
        if (written.outcome === 'unchanged') {
          return [visibleWriteResult(written.record, data.data)];
        }
        if (written.outcome === 'merged') {
          safelyNotify(function () { ctx.bus.emit('data-received'); });
          return [visibleWriteResult(written.record, data.data)];
        }
        var doc = written.record || data.data;
        if (written.outcome === 'inserted') doc._id = written._id;
        safelyNotify(function () {
          ctx.bus.emit('data-update', {
            type: data.collection
            , op: 'update'
            , changes: ctx.ddata.processRawDataForRuntime([doc])
          });
        });
        safelyNotify(function () { ctx.bus.emit('data-received'); });
        return [doc];
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

        // Through the step: every stored form of an ObjectId or 24-hex _id,
        // one plain match otherwise (the step's socket _id match); stat is the interface's reply.
        (async function () {
          var stat;
          try {
            stat = (await socketStep(data.collection).write({ op: 'delete', target: addressOf(data) })).adapter;
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
              // Removed by identifier, the records are not named: the cache
              // of the collection is dropped and read again.
              , changes: hasSafeIdentifier(data) ? idForms.cacheRemoval(data._id, stat.deletedCount) : undefined
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
