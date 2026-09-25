'use strict';


var async = require('async');
var moment = require('moment');
var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var countParam = require('./count');

function storage (env, ctx) {
  var idForms = require('./object-id-forms');

  function literal (value) {
    return { $eq: value };
  }

  function validateDedupFields (obj) {
    ['identifier', 'eventType'].forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(obj, field)
        && obj[field] !== null && typeof obj[field] !== 'string') {
        throw new TypeError('Treatment ' + field + ' must be a string');
      }
    });
  }

  function create (objOrArray, fn) {

    function done (err, result) {
      ctx.bus.emit('data-received');
      if (typeof fn === 'function') fn(err, result);
    }

    try {
      purifyForStorage(ctx, objOrArray);
      (Array.isArray(objOrArray) ? objOrArray : [objOrArray]).forEach(validateDedupFields);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, []);
      return Promise.reject(err);
    }

    if (Array.isArray(objOrArray)) {
      if (objOrArray.length === 0) {
        return done(null, []);
      }

      // Check if any docs have preBolus (need special handling with upsert)
      // Don't call prepareData yet - that happens in upsert or before bulkWrite
      var hasPreBolus = objOrArray.some(function(obj) {
        // preBolus may be a string from API, so check truthiness and non-zero
        var preBolus = Number(obj.preBolus);
        return preBolus && preBolus !== 0;
      });

      // If any preBolus docs exist, fall back to sequential processing
      // because preBolus creates additional treatment records
      if (hasPreBolus) {
        var allDocs = [];
        var errs = [];
        async.eachSeries(objOrArray, function (obj, callback) {
          upsert(obj, function upserted (err, docs) {
            allDocs = allDocs.concat(docs);
            errs.push(err);
            callback(err, docs);
          });
        }, function () {
          errs = errs.filter(Boolean);
          done(errs.length > 0 ? errs : null, allDocs);
        });
        return;
      }

      // Build bulkWrite operations for regular docs (no preBolus)
      // Prepare data and build bulk ops together
      // A write that matches its record by _id removes the string form of
      // that id right after it, not at the end of the batch: a later item
      // matched by created_at and eventType could otherwise land on the
      // string copy and be deleted with it (BF-130). opItem maps each
      // operation back to its item, for the upserted ids below.
      var bulkOps = [];
      var opItem = [];
      objOrArray.forEach(function(obj, item) {
        var submittedId = obj._id;
        normalizeTreatmentId(obj);
        var results = prepareData(obj);
        var filter = upsertQueryFor(obj, results);
        bulkOps.push({
          replaceOne: {
            filter: filter,
            replacement: obj,
            upsert: true
          }
        });
        opItem.push(item);
        if (filter._id) {
          var before = bulkOps.length;
          idForms.withStaleStringsRemoved(bulkOps, [submittedId]);
          if (bulkOps.length > before) opItem.push(null);
        }
      });

      return runWithCallback(async function () {
        var bulkResult;

        try {
          bulkResult = await api().bulkWrite(bulkOps, { ordered: true });
        } catch (err) {
          console.error('Problem upserting treatments batch', err);
          throw err;
        }

        // Assign _ids from upserted results
        if (bulkResult && bulkResult.upsertedIds) {
          Object.keys(bulkResult.upsertedIds).forEach(function(index) {
            var item = opItem[index];
            if (item !== null && item !== undefined) objOrArray[item]._id = bulkResult.upsertedIds[index];
          });
        }
        
        // REQ-SYNC-072: For docs that were updated (not inserted) via identifier,
        // fetch their _id from the database (only identifier field, not others)
        var docsNeedingId = objOrArray.filter(function(obj) {
          return !obj._id && obj.identifier;
        });

        if (docsNeedingId.length > 0) {
          var identifiers = docsNeedingId.map(function(obj) { return obj.identifier; });

          try {
            var existing = await api().find({ identifier: { $in: identifiers } }).toArray();
            if (existing) {
              var idMap = new Map();
              existing.forEach(function(doc) {
                if (doc.identifier) idMap.set(doc.identifier, doc._id);
              });
              docsNeedingId.forEach(function(obj) {
                if (obj.identifier && idMap.has(obj.identifier)) {
                  obj._id = idMap.get(obj.identifier);
                }
              });
            }
          } catch (findErr) {
            // Preserve existing behavior: still report success even if the id lookup fails.
          }
        }

        ctx.bus.emit('data-update', {
          type: 'treatments',
          op: 'update',
          changes: ctx.ddata.processRawDataForRuntime(objOrArray)
        });

        return objOrArray;
      }, function (err, result) {
        if (err) {
          done(err, []);
          return;
        }
        done(null, result);
      });
    } else {
      upsert(objOrArray, function upserted (err, docs) {
        done(err, docs);
      });
    }


  }

  function upsert (obj, fn) {
    var submittedId = obj._id;
    normalizeTreatmentId(obj);

    var results = prepareData(obj);
    var query = upsertQueryFor(obj, results);
    var stale = staleFormsFor(submittedId, query);

    (async function () {
      try {
        var updateResults = await api().replaceOne(query, obj, {upsert: true});
        if (stale.length > 0) {
          await api().deleteMany({ _id: { $in: stale } });
        }

        if (updateResults) {
          if (updateResults.upsertedCount == 1) {
            obj._id = updateResults.upsertedId;
          } else if (updateResults.matchedCount >= 1 && obj.identifier && !obj._id) {
            // REQ-SYNC-072: On update by identifier, fetch the existing _id
            try {
              var existing = await api().findOne(query);
              if (existing) {
                obj._id = existing._id;
              }
            } catch (findErr) {
              // Preserve existing behavior: update success does not fail if the lookup fails.
            }
          }
        }

        await finishUpsert(null, obj, results);
      } catch (err) {
        console.error('Problem upserting treatment', err);
        await finishUpsert(err, obj, results);
      }
    })();

    async function finishUpsert(err, obj, results) {
      // TODO document this feature
      if (!err && obj.preBolus) {
        //create a new object to insert copying only the needed fields
        var pbTreat = {
          created_at: (new Date(new Date(results.created_at).getTime() + (obj.preBolus * 60000))).toISOString(),
          eventType: obj.eventType,
          carbs: results.preBolusCarbs
        };

        if (obj.notes) {
          pbTreat.notes = obj.notes;
        }

        var pbQuery = {
          created_at: literal(pbTreat.created_at),
          eventType: literal(pbTreat.eventType)
        };
        var updateResults;
        try {
          updateResults = await api().replaceOne(pbQuery, pbTreat, {upsert: true});
        } catch (pbErr) {
          err = pbErr;
        }

        if (updateResults) {
          if (updateResults.upsertedCount == 1) {
            pbTreat._id = updateResults.upsertedId;
          }
        }

        var treatments = [obj, pbTreat].filter(Boolean);

        ctx.bus.emit('data-update', {
          type: 'treatments',
          op: 'update',
          changes: ctx.ddata.processRawDataForRuntime(treatments)
        });

        fn(err, treatments);
      } else {

        ctx.bus.emit('data-update', {
          type: 'treatments',
          op: 'update',
          changes: ctx.ddata.processRawDataForRuntime([obj])
        });

        fn(err, [obj]);
      }
    }
  }

  function list (opts, fn) {

    function limit ( ) {
      return countParam.applyCount(this, opts);
    }

    return runWithCallback(function () {
      return limit.call(api()
        .find(query_for(opts))
        .sort(opts && opts.sort || {created_at: -1}), opts)
        .toArray();
    }, fn);
  }

  function query_for (opts) {
    // Build queryOpts inside function to access env.uuidHandling
    var queryOpts = {
      collection: 'treatments'
      , walker: {
        notes: find_options.parseRegEx
        , eventType: find_options.parseRegEx
        , enteredBy: find_options.parseRegEx
      }
      , dateField: 'created_at'
      , uuidHandling: env.uuidHandling
    };
    var asked = opts && opts.find && opts.find._id;
    // find[_id]=<hex> (also used by DELETE /treatments/:id) comes back as an
    // ObjectId; also match a treatment stored with the same id as a string,
    // as 15.0.6 and earlier stored a 24-hex _id.
    return idForms.matchEitherForm(find_options(opts, queryOpts), asked);
  }

  function remove (opts, fn) {
    return runWithCallback(async function () {
      var stat = await api().deleteMany(query_for(opts), {});
      //TODO: this is triggering a read from Mongo, we can do better
      //console.log('Treatment removed', opts); // , stat);

      ctx.bus.emit('data-update', {
        type: 'treatments',
        op: 'remove',
        count: stat.deletedCount,
        changes: opts.find._id
      });

      ctx.bus.emit('data-received');
      return stat;
    }, fn);
  }

  function save (obj, fn) {
    try {
      purifyForStorage(ctx, obj);
      validateDedupFields(obj);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, obj);
      return Promise.reject(err);
    }

    var submittedId = obj._id;
    normalizeTreatmentId(obj);
    prepareData(obj);

    var query = upsertQueryFor(obj, { created_at: obj.created_at });
    var stale = staleFormsFor(submittedId, query);

    const promise = runWithCallback(async function () {
      var updateResults = await api().replaceOne(query, obj, {upsert: true});
      if (stale.length > 0) {
        await api().deleteMany({ _id: { $in: stale } });
      }

      if (updateResults && updateResults.upsertedCount == 1) {
        obj._id = updateResults.upsertedId;
      } else if (updateResults && updateResults.matchedCount >= 1 && obj.identifier && !obj._id) {
        // REQ-SYNC-072: On update by identifier, fetch the existing _id
        try {
          var existing = await api().findOne(query);
          if (existing) {
            obj._id = existing._id;
          }
        } catch (findErr) {
          // Preserve existing behavior: update success does not fail if the lookup fails.
        }
      }

      ctx.ddata.processRawDataForRuntime(obj);
      ctx.bus.emit('data-update', {
        type: 'treatments',
        op: 'update',
        changes: ctx.ddata.processRawDataForRuntime([obj])
      });

      return obj;
    }, function (err, result) {
      if (err) {
        console.error('Problem saving treating', err);
        if (typeof fn === 'function') fn(err, obj);
        return;
      }

      if (typeof fn === 'function') fn(null, result);
    });

    ctx.bus.emit('data-received');
    return promise;
  }

  function api ( ) {
    return ctx.store.collection(env.treatments_collection);
  }

  // 15.0.6 and earlier stored a 24-hex _id as the string itself. When a write
  // matches its record by _id, the ObjectId filter cannot see such a record,
  // so after the upsert delete the string form of the same id: the write
  // leaves one record rather than a copy beside the original. `submittedId`
  // is the _id as the client sent it, so an upper-case string is matched too.
  function staleFormsFor (submittedId, query) {
    return query && query._id ? idForms.staleStringForms([submittedId]) : [];
  }

  /**
   * Build upsert query - REQ-SYNC-072: identifier-first lookup
   * Priority: identifier > _id > time+type
   * 
   * IMPORTANT: When returning identifier-based query, also removes _id from obj
   * because MongoDB doesn't allow changing _id on upsert update.
   */
  function upsertQueryFor (obj, results) {
    // 1. Prefer identifier for dedup (AAPS, Loop UUID _id normalized)
    if (obj.identifier) {
      // Remove _id from replacement - MongoDB will use existing _id on update,
      // or generate new one on insert
      var identifierValue = obj.identifier;
      delete obj._id;
      // Use $or to match both new docs (identifier field) and legacy docs (UUID in _id)
      if (env.uuidHandling) {
        return { $or: [
          { identifier: literal(identifierValue) }
          , { _id: literal(identifierValue) }
        ] };
      }
      return { identifier: literal(identifierValue) };
    }
    // 2. Fall back to _id if present and valid
    if (Object.prototype.hasOwnProperty.call(obj, '_id') && obj._id !== null && obj._id !== '') {
      return { _id: literal(obj._id) };
    }
    // 3. Last resort: time + eventType
    return {
      created_at: literal(results.created_at)
      , eventType: literal(obj.eventType)
    };
  }

  /**
   * Normalize treatment ID - REQ-SYNC-072: Server-Controlled ID
   * 
   * Scope: ONLY handles UUID values in _id field
   * - Loop overrides: UUID in _id → moved to identifier
   * 
   * Does NOT touch other client fields (syncIdentifier, uuid, etc.)
   * Those fields are preserved as-is and used for dedup in upsertQueryFor().
   * 
   * Note: _id handling is done here to properly handle update vs insert
   */
  function normalizeTreatmentId (obj) {
    idForms.dropEmptyId(obj);
    // REQ-SYNC-072: Only handle UUID values in _id field
    // Scope: ONLY the _id field when value is a valid UUID
    // Does NOT touch syncIdentifier, uuid, or other client fields
    if (typeof obj._id === 'string' && !idForms.isHexId(obj._id)) {
      // Non-ObjectId string in _id (UUID format)
      // Only move to identifier when UUID_HANDLING is enabled
      if (env.uuidHandling && !obj.identifier) {
        obj.identifier = obj._id;
      }
      // Always delete invalid _id so server generates ObjectId
      delete obj._id;
    } else if (Object.prototype.hasOwnProperty.call(obj, '_id') && obj._id !== null && obj._id !== '') {
      // Convert valid ObjectId strings to ObjectId objects
      obj._id = idForms.toStoredId(obj._id);
    }
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.indexedFields = [
    'created_at'
    , 'eventType'
    , 'insulin'
    , 'carbs'
    , 'glucose'
    , 'enteredBy'
    , 'boluscalc.foods._id'
    , 'notes'
    , 'NSCLIENT_ID'
    , 'percent'
    , 'absolute'
    , 'duration'
    , 'identifier'  // REQ-SYNC-072: Client sync identity (UUID from _id field)
    , { 'eventType' : 1, 'duration' : 1, 'created_at' : 1 }
    , { 'eventType' : 1, 'created_at' : -1, 'identifier' : -1, 'date' : -1 }
  ];

  api.remove = remove;
  api.save = save;
  api.aggregate = require('./aggregate')({ }, api);

  return api;
}

function prepareData(obj) {

  // Convert all dates to UTC dates

  // TODO remove this -> must not create new date if missing
  const d = moment(obj.created_at).isValid() ? moment.parseZone(obj.created_at) : moment();
  obj.created_at = d.toISOString();

  var results = {
    created_at: obj.created_at
    , preBolusCarbs: ''
  };

  const offset = d.utcOffset();
  obj.utcOffset = offset;
  results.offset = offset;

  obj.glucose = Number(obj.glucose);
  obj.targetTop = Number(obj.targetTop);
  obj.targetBottom = Number(obj.targetBottom);
  obj.carbs = Number(obj.carbs);
  obj.insulin = Number(obj.insulin);
  obj.duration = Number(obj.duration);
  obj.percent = Number(obj.percent);
  obj.absolute = Number(obj.absolute);
  obj.relative = Number(obj.relative);
  obj.preBolus = Number(obj.preBolus);

  //NOTE: the eventTime is sent by the client, but deleted, we only store created_at
  var eventTime;
  if (obj.eventTime) {
    eventTime = new Date(obj.eventTime).toISOString();
    results.created_at = eventTime;
  }

  obj.created_at = results.created_at;
  if (obj.preBolus && obj.preBolus !== 0 && obj.carbs) {
    results.preBolusCarbs = obj.carbs;
    delete obj.carbs;
  }

  if (obj.eventType === 'Announcement') {
    obj.isAnnouncement = true;
  }

  // clean data
  delete obj.eventTime;

  function deleteIfEmpty (field) {
    if (!obj[field] || obj[field] === 0) {
      delete obj[field];
    }
  }

  function deleteIfNaN (field) {
    if (isNaN(obj[field])) {
      delete obj[field];
    }
  }

  deleteIfEmpty('targetTop');
  deleteIfEmpty('targetBottom');
  deleteIfEmpty('carbs');
  deleteIfEmpty('insulin');
  deleteIfEmpty('percent');
  deleteIfEmpty('relative');
  deleteIfEmpty('notes');
  deleteIfEmpty('preBolus');

  deleteIfNaN('absolute');
  deleteIfNaN('duration');

  if (obj.glucose === 0 || isNaN(obj.glucose)) {
    delete obj.glucose;
    delete obj.glucoseType;
    delete obj.units;
  }

  return results;
}

module.exports = storage;
