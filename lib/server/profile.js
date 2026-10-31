'use strict';

const writeStep = require('../storage/write-step');
const writeIntent = require('../storage/write-intent');

const READ_OPTIONS = require('../storage/mongo-read-options');

var find_options = require('./query');
var consts = require('../constants');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var countParam = require('./count');
var reads = require('./storage-reads');
var softDeleted = require('./soft-deleted');
var writeItems = require('./write-items');
var logPrivacy = require('./log-privacy');

function storage (collection, ctx, env) {
   // DEBUG_LOGGING adds the records to the save-error line (BF-193).
   var debug = logPrivacy.debugLogging(env);
   var profileSort = { startDate: -1, _id: -1 };
   var idForms = require('./object-id-forms');

  // Writes go through the write step (lib/storage/write-intent.js), which
  // holds the rules this module applied itself: a create inserts new
  // profiles (a 24-hex _id stored as its ObjectId, created_at when missing,
  // srvCreated) and merges a re-send of a stored _id into the stored profile
  // as a JSON Merge Patch (the write contract's re-send rule, Q1b; a re-send
  // that changes nothing writes nothing); save replaces by _id with carried
  // server dates and removes a string twin after; remove deletes every
  // stored form of the _id. Purification, the startDate check, the update
  // permission's error, the BF-195 announcement after the write and the
  // prune boundary stay here. This storage is built without an env.
  function step ( ) {
    return writeIntent.forCollectionIntent(store, 'profile', 'v1/internal', { env: env, bus: ctx.bus });
  }

  // HTTP callers pass their update permission; trusted in-process callers
  // retain the existing merge behavior when they omit the options.
  function create (objOrArray, fn, options = {}) {
    // Normalize to array (supports both single object and array inputs)
    var docs = Array.isArray(objOrArray) ? objOrArray : [objOrArray];

    if (docs.length === 0) {
      if (typeof fn === 'function') fn(null, []);
      ctx.bus.emit('data-received');
      return Promise.resolve([]);
    }

    try {
      purifyForStorage(ctx, docs);
      docs.forEach(validateStartDate);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, []);
      return Promise.reject(err);
    }

    const promise = runWithCallback(async function () {
      // Every document is checked against the stored profiles before any
      // insert or merge: identical retries and repeated IDs created within
      // this upload need only create access.
      const result = await step().write({ op: 'create', docs: docs, canUpdate: options.canUpdate });
      writeItems.record(docs, result);
      if (result.refusedUpdate) {
        const error = new Error('Missing permission api:profile:update');
        error.code = 'PROFILE_UPDATE_PERMISSION_REQUIRED';
        throw error;
      }
      return docs;
    }, afterWrite(function (err, result) {
      if (err) {
        if (err.code !== 'PROFILE_UPDATE_PERMISSION_REQUIRED') {
          console.log('Error saving profile data', logPrivacy.recordForLog(docs, { collection: 'profile', debug: debug }), err);
        }
        if (typeof fn === 'function') fn(err);
        return;
      }
      if (typeof fn === 'function') fn(null, result);
    }));

    return promise;
  }

  function save (obj, fn) {
    try {
      purifyForStorage(ctx, obj);
      validateStartDate(obj);
    } catch (err) {
      if (typeof fn === 'function') return fn(err, obj);
      return Promise.reject(err);
    }

    // A hex or ObjectId _id names the profile to replace; anything else,
    // including a 12-character string the driver would read as raw bytes,
    // gets a new ObjectId (the step's _id form, now, as before).
    var planned = step().plan({ op: 'update', docs: [obj] });
    if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
      obj.created_at = (new Date( )).toISOString( );
    }
    // Match existing profiles by _id only. The profile editor rewrites created_at on save.
    // A stored profile whose _id is still the hex string is replaced by the
    // ObjectId document and then removed, so the edit leaves one profile
    // rather than adding a copy beside the original. Upserting first means
    // the profile is never absent between the two writes.
    const promise = runWithCallback(async function () {
      await step().write(planned);
      return obj;
    }, afterWrite(fn));

    return promise;
  }

  function list (fn, count) {
    // A supplied `count` that is not a positive whole number of documents is
    // not a limit at all - MongoDB reads `.limit(0)` as "no limit" - so fall
    // back to the endpoint's default rather than to an unbounded read.
    // A count of zero asks for no profiles, and gets none.
    if (countParam.isZeroCount(count)) {
      return runWithCallback(function () { return [ ]; }, fn);
    }
    const limit = count === undefined ? undefined
      : countParam.parseCount(count) || Number(consts.PROFILES_DEFAULT_COUNT);
    return runWithCallback(function () {
      return reads.find(store(), reads.toFilter(softDeleted.visible({ }))
        , { readOptions: READ_OPTIONS, limit: limit, sort: profileSort });
    }, fn);
  }

  function list_query (opts, fn) {

    // `walker: {}` keeps query.js's default `date`/`sgv` numeric reading off
    // profile, which has never had it; the schema still types its fields.
    storage.queryOpts = {
      collection: 'profile'
      , walker: { }
      , dateField: 'startDate'
    };

    // Through the storage interface; count, sort and read options as before
    // (lib/server/storage-reads.js).
    return runWithCallback(function () {
      return reads.list(store(), query_for(opts)
        , { sort: opts && opts.sort && query_sort(opts) || profileSort, count: opts && opts.count
          , readOptions: READ_OPTIONS });
    }, fn);
  }

  function query_for (opts) {
      var asked = opts && opts.find && opts.find._id;
      // find[_id]=<hex> comes back as an ObjectId; also match a profile
      // stored with the same id as a string.
      // Reads leave out deleted records (isValid: false; see soft-deleted).
      return softDeleted.visible(idForms.matchEitherForm(find_options(opts, storage.queryOpts), asked), opts);
  }

  function query_sort (opts) {
    if (opts && opts.sort) {
      var sortKeys = Object.keys(opts.sort);

      for (var i = 0; i < sortKeys.length; i++) {
        if (opts.sort[sortKeys[i]] == '1') {
          opts.sort[sortKeys[i]] = 1;
        }
        else {
          opts.sort[sortKeys[i]] = -1;
        }
      }
      return opts.sort;
    }
  }


  function last (fn) {
    return runWithCallback(function () {
      return reads.find(store(), reads.toFilter(softDeleted.visible({ })), { sort: profileSort, limit: 1 });
    }, fn);
  }

  function remove (_id, fn) {
    // Remove the profile whichever form its _id is stored in, and both forms
    // where an earlier edit left an ObjectId copy beside a string original.
    const promise = runWithCallback(async function () {
      return (await step().write({ op: 'delete', target: { _id: _id } })).adapter;
    }, afterWrite(fn));

    return promise;
  }

  // A callback that announces the write once it has finished, then answers
  // the caller. Announced before, the reload it triggers can read the
  // profiles from before the write (BF-195).
  function afterWrite (fn) {
    return function (err, result) {
      ctx.bus.emit('data-received');
      if (typeof fn === 'function') fn(err, result);
    };
  }

  function prune (keepCount, fn) {
    return runWithCallback(async function () {
      var oldProfileBoundary = await reads.findAll(store(), { }
        , { projection: { _id: 1, startDate: 1 }, sort: profileSort, skip: keepCount, limit: 1 });

      if (oldProfileBoundary.length === 0) {
        return { deletedCount: 0 };
      }

      var pruneFilter = pruneFilterForBoundary(oldProfileBoundary[0]);

      var stat = (await step().write({ op: 'prune', target: { filter: pruneFilter } })).adapter;
      ctx.bus.emit('data-update', {
        type: 'profile'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: pruneFilter
      });
      ctx.bus.emit('data-received');

      return stat;
    }, fn);
  }

  function pruneFilterForBoundary (boundary) {
    if (Object.prototype.hasOwnProperty.call(boundary, 'startDate') && boundary.startDate !== null) {
      return {
        $or: [
          { startDate: { $lt: boundary.startDate } }
          , { startDate: { $eq: boundary.startDate }, _id: { $lte: boundary._id } }
          , { startDate: { $eq: null } }
        ]
      };
    }

    return {
      startDate: { $eq: null }
      , _id: { $lte: boundary._id }
    };
  }

  function validateStartDate (doc) {
    if (!Object.prototype.hasOwnProperty.call(doc, 'startDate')) return;

    var value = doc.startDate;
    if (value === null || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (value instanceof Date && !isNaN(value.getTime())) return;

    throw new TypeError('Profile startDate must be a string, finite number, valid date, or null');
  }

  // Reads and writes go through the storage interface, labelled 'v1/internal'
  // (lib/server/storage-reads.js; writes through lib/storage/write-intent.js). This storage
  // is built without an env; profile writes do not consult one.
  function store () {
    return reads.collection(ctx, undefined, collection, 'profile');
  }

  // The handle tests seed through.
  function api () {
    return writeStep.collection(ctx.store.collection(collection), {name: 'profile',
      source: 'v1/internal', bus: ctx.bus});
  }

  api.list = list;
  api.list_query = list_query;
  api.create = create;
  api.save = save;
  api.remove = remove;
  api.prune = prune;
  api.last = last;
  api.indexedFields = [
    'startDate'
    , 'created_at'
    , 'NSCLIENT_ID'
    , { startDate: -1, _id: -1 }
  ];
  return api;
}

module.exports = storage;
