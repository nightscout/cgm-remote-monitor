'use strict';

const writeStep = require('../storage/write-step');

const READ_OPTIONS = require('../storage/mongo-read-options');


var tasks = require('../utils/callback-tasks');
var moment = require('moment');
var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var reads = require('./storage-reads');
var writes = require('./storage-writes');
var srvDates = require('./srv-dates');
var softDeleted = require('./soft-deleted');
var writeValidation = require('./write-validation');
var targetUnits = require('../treatmentTargetUnits');

function storage (env, ctx) {
  var idForms = require('./object-id-forms');
  var fallbackKey = require('./treatment-fallback-key');

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

  // WRITE_VALIDATION (see write-validation): the rules are checked on the
  // record after prepareData's coercion and its removal of `units` from a
  // treatment without a glucose value, before the Temporary Target units
  // step (lib/treatmentTargetUnits.js) converts and labels it. Returns the
  // items a `reject` refuses, as [{ index, problems }], before anything is
  // written.
  function checkDomain (items) {
    var mode = writeValidation.mode(env);
    var refused = [];
    if (mode === 'off') return refused;
    items.forEach(function (obj, index) {
      if (mode === 'reject') writeValidation.normalizeUnits(obj);
      var stored = Object.assign({}, obj);
      prepareData(stored, { targetUnits: false });
      var problems = writeValidation.candidate(stored).problems;
      if (problems.length === 0) return;
      console.warn(writeValidation.logLine(mode === 'reject' ? 'API v1 refused' : 'API v1', obj, problems));
      if (mode === 'reject') refused.push({ index: index, problems: problems });
    });
    return refused;
  }

  // A batch with refused items stores the others. The reply keeps one slot
  // per submitted item, in order: clients such as NightscoutKit require as
  // many objects as they sent and read `_id` by position. A refused item's
  // slot is the item as sent, with no `_id` and a `refused` member (see
  // write-validation.refusal). Every item refused: a 400, as for one.
  function create (objOrArray, fn) {
    var items = Array.isArray(objOrArray) ? objOrArray : [objOrArray];
    var refused;

    try {
      purifyForStorage(ctx, objOrArray);
      items.forEach(validateDedupFields);
      refused = checkDomain(items);
      if (refused.length > 0 && refused.length === items.length) {
        throw writeValidation.ValidationError([].concat.apply([], refused.map(function (r) {
          return r.problems;
        })));
      }
    } catch (err) {
      if (typeof fn === 'function') return fn(err, []);
      return Promise.reject(err);
    }

    if (refused.length === 0) return createChecked(objOrArray, fn);

    var refusedAt = {};
    refused.forEach(function (r) { refusedAt[r.index] = r.problems; });
    var accepted = items.filter(function (obj, index) { return !refusedAt[index]; });

    return createChecked(accepted, function (err, result) {
      var reply = (result || []).slice();
      refused.forEach(function (r) {
        reply.splice(r.index, 0, writeValidation.refusal(items[r.index], r.problems));
      });
      if (typeof fn === 'function') fn(err, reply);
    });
  }

  function createChecked (objOrArray, fn) {

    function done (err, result) {
      ctx.bus.emit('data-received');
      if (typeof fn === 'function') fn(err, result);
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
      // because preBolus creates additional treatment records (stored, but
      // not in the reply: one slot per sent item, see upsert)
      if (hasPreBolus) {
        var allDocs = [];
        var errs = [];
        tasks.eachSeries(objOrArray, function (obj, callback) {
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
      var itemFilter = [];
      objOrArray.forEach(function(obj, item) {
        var submittedId = obj._id;
        normalizeTreatmentId(obj);
        var results = prepareData(obj);
        var filter = upsertQueryFor(obj, results);
        itemFilter.push(filter);
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
          // srvModified on every item, srvCreated kept from the record each
          // item replaces (API v3 history reads them; see srv-dates).
          await srvDates.carryForReplace(reads.documents(store()), bulkOps.filter(function (op) {
            return op.replaceOne;
          }).map(function (op) {
            return { filter: op.replaceOne.filter, doc: op.replaceOne.replacement };
          }));
          bulkResult = await writes.bulk(store(), bulkOps, { ordered: true });
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
            var existing = await reads.findAll(store(), { identifier: { $in: identifiers } }
              , { readOptions: READ_OPTIONS });
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
          } catch {
            // Preserve existing behavior: still report success even if the id lookup fails.
          }
        }

        // A re-send matched by the fallback key (created_at + eventType, see
        // treatment-fallback-key) kept the stored _id; answer with it too, as
        // for an insert or an identifier match (BF-165). The replacement
        // still satisfies the filter it was written by.
        for (var item = 0; item < objOrArray.length; item++) {
          if (objOrArray[item]._id) continue;
          try {
            var matched = await reads.findOne(store(), itemFilter[item], { _id: 1 });
            if (matched) objOrArray[item]._id = matched._id;
          } catch {
            // As above: the write succeeded, so the reply still reports it.
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
        await srvDates.carryForReplace(reads.documents(store()), [{ filter: query, doc: obj }]);
        var updateResults = await writes.replace(store(), query, obj, { upsert: true });
        if (stale.length > 0) {
          await writes.remove(store(), { _id: { $in: stale } });
        }

        if (updateResults) {
          if (updateResults.upsertedCount == 1) {
            obj._id = updateResults.upsertedId;
          } else if (updateResults.matchedCount >= 1 && !obj._id) {
            // REQ-SYNC-072: On update by identifier, or by the fallback key
            // (BF-165), fetch the existing _id
            try {
              var existing = await reads.findOne(store(), query);
              if (existing) {
                obj._id = existing._id;
              }
            } catch {
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
          await srvDates.carryForReplace(reads.documents(store()), [{ filter: pbQuery, doc: pbTreat }]);
          updateResults = await writes.replace(store(), pbQuery, pbTreat, { upsert: true });
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

        // The derived record is stored and announced, but the reply keeps
        // one slot per sent item: a client that requires as many items back
        // as it sent fails a longer reply and sends the batch again, and one
        // that takes its bookmark from the newest record in the reply moves
        // it past records it has not sent (BF-219, ID-BATCH (iv)).
        fn(err, [obj]);
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
    // Through the storage interface; count, sort and read options as before
    // (lib/server/storage-reads.js).
    return runWithCallback(function () {
      return reads.list(store(), query_for(opts)
        , { sort: opts && opts.sort || {created_at: -1}, count: opts && opts.count, readOptions: READ_OPTIONS });
    }, fn);
  }

  // Reads leave out deleted records (isValid: false; see soft-deleted).
  function query_for (opts) {
    return softDeleted.visible(stored_query_for(opts), opts);
  }

  // Every stored record the query names, deleted or not: what DELETE removes.
  function stored_query_for (opts) {
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
    // The id as asked: query_for rewrites opts.find._id into a filter.
    var asked = opts && opts.find ? opts.find._id : undefined;
    return runWithCallback(async function () {
      var stat = await writes.remove(store(), stored_query_for(opts));
      //TODO: this is triggering a read from Mongo, we can do better
      //console.log('Treatment removed', opts); // , stat);

      ctx.bus.emit('data-update', {
        type: 'treatments',
        op: 'remove',
        count: stat.deletedCount,
        changes: idForms.cacheRemoval(asked, stat.deletedCount)
      });

      ctx.bus.emit('data-received');
      return stat;
    }, fn);
  }

  function save (obj, fn) {
    try {
      purifyForStorage(ctx, obj);
      validateDedupFields(obj);
      var refused = checkDomain([obj]);
      if (refused.length > 0) throw writeValidation.ValidationError(refused[0].problems);
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
      await srvDates.carryForReplace(reads.documents(store()), [{ filter: query, doc: obj }]);
      var updateResults = await writes.replace(store(), query, obj, { upsert: true });
      if (stale.length > 0) {
        await writes.remove(store(), { _id: { $in: stale } });
      }

      if (updateResults && updateResults.upsertedCount == 1) {
        obj._id = updateResults.upsertedId;
      } else if (updateResults && updateResults.matchedCount >= 1 && !obj._id) {
        // REQ-SYNC-072: On update by identifier, or by the fallback key
        // (BF-165), fetch the existing _id
        try {
          var existing = await reads.findOne(store(), query);
          if (existing) {
            obj._id = existing._id;
          }
        } catch {
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

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js, lib/server/storage-writes.js).
  function store ( ) {
    return reads.collection(ctx, env, env.treatments_collection, 'treatments');
  }

  // The handle tests seed through; lib/server/aggregate.js counts through store().
  function api ( ) {
    return writeStep.collection(ctx.store.collection(env.treatments_collection), {name: 'treatments',
      source: 'v1/internal', env: env, bus: ctx.bus});
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
    // 3. Last resort: time + eventType, with the client's identity, or for a
    // write without one its carbs and insulin (BF-121; see treatment-fallback-key)
    return fallbackKey.fallbackQuery(obj, results.created_at, { withAmounts: true });
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
  api.aggregate = require('./aggregate')(api, store);

  return api;
}

// opts.targetUnits false: leave a Temporary Target's targets and label as
// sent, as write validation checks them.
function prepareData(obj, opts) {

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

  // A Temporary Target in mg/dL, labelled mg/dl (BF-194); the label is kept
  // below although the record has no glucose value.
  var labelled = !(opts && opts.targetUnits === false) && targetUnits.normalizeTargetUnits(obj);

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
    if (!labelled) delete obj.units;
  }

  return results;
}

module.exports = storage;
