'use strict';

const writeStep = require('../storage/write-step');
const writeIntent = require('../storage/write-intent');

const READ_OPTIONS = require('../storage/mongo-read-options');


var tasks = require('../utils/callback-tasks');
var find_options = require('./query');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var reads = require('./storage-reads');
var softDeleted = require('./soft-deleted');
var writeValidation = require('./write-validation');

function storage (env, ctx) {
  var idForms = require('./object-id-forms');

  // Writes go through the write step (lib/storage/write-intent.js), which
  // holds the rules this module applied itself: WRITE_VALIDATION's check, the
  // `_id` form (REQ-SYNC-072), the record's preparation with the BF-194
  // Temporary Target units, the target (identifier, _id, fallback key), server
  // dates, the string-twin removal and the _id a re-send is answered with
  // (BF-165). Purification, the dedup-field types, the batch's reply slots,
  // the preBolus record's fields and every bus emission stay here.
  function step ( ) {
    return writeIntent.forCollection(store, 'treatments', 'v1/internal', { env: env });
  }

  // eventType must be a string or null before it reaches a selector. An
  // identifier that is not a string is not refused here: the step's
  // identifier-format rule (ID-Q6, BF-215) treats it as absent after the _id
  // step, before any selector is built.
  function validateDedupFields (obj) {
    ['eventType'].forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(obj, field)
        && obj[field] !== null && typeof obj[field] !== 'string') {
        throw new TypeError('Treatment ' + field + ' must be a string');
      }
    });
  }

  // WRITE_VALIDATION (see write-validation), the step's check for this
  // path: [{ index, problems }] for the items a `reject` refuses, before
  // anything is written; log mode logs and refuses nothing.
  function checkDomain (items) {
    return step().check(items);
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

      // One ordered bulk write (the step's batch form): each item's _id
      // form, preparation and target now, before the first await, as
      // before; a write that matches its record by _id removes the string
      // form of that id right after it, not at the end of the batch
      // (BF-130). The step answers each item with the _id it is stored
      // under: the upserted one, or the stored record's (REQ-SYNC-072,
      // BF-165).
      var planned = step().plan({ op: 'create', form: 'batch', docs: objOrArray });

      return runWithCallback(async function () {
        var written;
        try {
          written = await step().write(planned);
        } catch (err) {
          console.error('Problem upserting treatments batch', err);
          throw err;
        }

        // A re-send of a deleted treatment is acknowledged and not written
        // (on-deleted, ID-Q4): it is answered with the stored _id and
        // announced to no one.
        var changed = objOrArray.filter(function (obj, index) {
          return !writeIntent.isNotWritten(written.items[index]);
        });
        if (changed.length > 0) {
          ctx.bus.emit('data-update', {
            type: 'treatments',
            op: 'update',
            changes: ctx.ddata.processRawDataForRuntime(changed)
          });
        }

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
    // The step's single form: the _id form, preparation and target now; then
    // an upserting replace and, in a call of its own, the string-twin removal.
    var planned = step().plan({ op: 'create', form: 'one', docs: [obj] });
    var results = planned.prepared[0];

    (async function () {
      var written;
      try {
        written = await step().write(planned);

        await finishUpsert(null, obj, results, writeIntent.isNotWritten(written.items[0]));
      } catch (err) {
        console.error('Problem upserting treatment', err);
        await finishUpsert(err, obj, results, false);
      }
    })();

    async function finishUpsert(err, obj, results, notWritten) {
      if (!err && notWritten) {
        // A re-send of a deleted treatment (on-deleted, ID-Q4): acknowledged
        // with the stored _id, nothing written, its preBolus record included.
        fn(err, [obj]);
        return;
      }
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

        // Written by its created_at and eventType; a new record gets the
        // upserted _id (the step's preBolus form).
        try {
          await step().write({ op: 'create', form: 'prebolus', docs: [pbTreat] });
        } catch (pbErr) {
          err = pbErr;
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
      var stat = (await step().write({ op: 'delete', target: { filter: stored_query_for(opts) } })).adapter;
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

    // The _id form, preparation and target now, as before; the write (an
    // upserting replace, then the string-twin removal in a call of its own)
    // and the stored _id of a matched record come from the step.
    var planned = step().plan({ op: 'update', docs: [obj] });

    const promise = runWithCallback(async function () {
      var written = await step().write(planned);
      // An edit of a deleted treatment is not applied (ID-Q3,
      // WRITE_DELETED_EDIT=ignore; `refuse` throws DeletedRecordError).
      if (writeIntent.isNotWritten(written.items[0])) return obj;

      ctx.ddata.processRawDataForRuntime(obj);
      ctx.bus.emit('data-update', {
        type: 'treatments',
        op: 'update',
        changes: ctx.ddata.processRawDataForRuntime([obj])
      });

      return obj;
    }, function (err, result) {
      // Announced once the write has finished, successful or not: announced
      // when it started, the reload it triggers could read the treatment
      // from before the edit (BF-221; BF-195 for profiles).
      ctx.bus.emit('data-received');
      if (err) {
        console.error('Problem saving treating', err);
        if (typeof fn === 'function') fn(err, obj);
        return;
      }

      if (typeof fn === 'function') fn(null, result);
    });

    return promise;
  }

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js; writes through lib/storage/write-intent.js).
  function store ( ) {
    return reads.collection(ctx, env, env.treatments_collection, 'treatments');
  }

  // The handle tests seed through; lib/server/aggregate.js counts through store().
  function api ( ) {
    return writeStep.collection(ctx.store.collection(env.treatments_collection), {name: 'treatments',
      source: 'v1/internal', env: env, bus: ctx.bus});
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

module.exports = storage;
