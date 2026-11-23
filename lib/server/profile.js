'use strict';

var find_options = require('./query');
var consts = require('../constants');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var countParam = require('./count');
var srvDates = require('./srv-dates');
var softDeleted = require('./soft-deleted');

function storage (collection, ctx) {
   var ObjectID = require('mongodb').ObjectId;
   var profileSort = { startDate: -1, _id: -1 };
   var idForms = require('./object-id-forms');

  // A profile's _id is an ObjectId. Store a 24-hex string _id as the ObjectId
  // it names, as treatments do, so that save, remove and find[_id] - which all
  // look profiles up by ObjectId - find the profile that was created. The
  // v1 API refuses any other string _id with a 400; storage callers inside the
  // server (the connector's internal output) keep theirs as given.
  //
  // `storedAsString` holds the ids already stored as strings. Those keep the
  // string form, so re-sending a stored profile still collides with it on
  // insert, as it always has, instead of adding an ObjectId copy beside it.
  function normalizeProfileId (doc, storedAsString) {
    if (idForms.isHexId(doc._id) && !storedAsString.has(doc._id)) {
      doc._id = idForms.toStoredId(doc._id);
    }
  }

  async function idsStoredAsString (docs) {
    var hexIds = docs
      .map(function (doc) { return doc._id; })
      .filter(idForms.isHexId);
    if (hexIds.length === 0) return new Set();
    var stored = await api()
      .find({ _id: { $in: hexIds } }, { projection: { _id: 1 } })
      .toArray();
    return new Set(stored.map(function (doc) { return doc._id; }));
  }

  function create (objOrArray, fn) {
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

    // Add created_at to each document
    docs.forEach(function(doc) {
      if (!doc.created_at) {
        doc.created_at = (new Date()).toISOString();
      }
    });

    const promise = runWithCallback(async function () {
      const storedAsString = await idsStoredAsString(docs);
      docs.forEach(function (doc) { normalizeProfileId(doc, storedAsString); });
      // API v3 history reads these (see srv-dates).
      docs.forEach(srvDates.stampCreated);
      const result = await api().insertMany(docs);
      if (result && result.insertedIds) {
        Object.keys(result.insertedIds).forEach(function (index) {
          if (!docs[index]._id) {
            docs[index]._id = result.insertedIds[index];
          }
        });
      }
      return docs;
    }, function (err, result) {
      if (err) {
        console.log('Error saving profile data', docs, err);
        if (typeof fn === 'function') fn(err);
        return;
      }
      if (typeof fn === 'function') fn(null, result);
    });

    ctx.bus.emit('data-received');
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
    // gets a new ObjectId.
    var submittedId = obj._id;
    if (obj._id instanceof ObjectID || idForms.isHexId(obj._id)) {
      obj._id = new ObjectID(obj._id);
    } else {
      obj._id = new ObjectID();
      submittedId = undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(obj, 'created_at')) {
      obj.created_at = (new Date( )).toISOString( );
    }
    // Match existing profiles by _id only. The profile editor rewrites created_at on save.
    // A stored profile whose _id is still the hex string is replaced by the
    // ObjectId document and then removed, so the edit leaves one profile
    // rather than adding a copy beside the original. Upserting first means
    // the profile is never absent between the two writes.
    const promise = runWithCallback(async function () {
      await srvDates.carryForReplace(api(), [{ filter: { _id: obj._id }, doc: obj }]);
      await api().replaceOne({ _id: obj._id }, obj, { upsert: true });
      if (submittedId !== undefined) {
        await api().deleteMany({ _id: { $in: idForms.stringIdForms(submittedId) } });
      }
      return obj;
    }, fn);

    ctx.bus.emit('data-received');
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
      return api().find(softDeleted.visible({ })).limit(limit).sort(profileSort).toArray();
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

    function limit () {
        return countParam.applyCount(this, opts);
    }

    return runWithCallback(function () {
      return limit.call(api()
        .find(query_for(opts))
        .sort(opts && opts.sort && query_sort(opts) || profileSort), opts)
        .toArray();
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
      return api().find(softDeleted.visible({ })).sort(profileSort).limit(1).toArray();
    }, fn);
  }

  function remove (_id, fn) {
    // Remove the profile whichever form its _id is stored in, and both forms
    // where an earlier edit left an ObjectId copy beside a string original.
    var filter = idForms.idFilter(_id);
    const promise = runWithCallback(function () {
      return api().deleteMany({ '_id': filter });
    }, fn);

    ctx.bus.emit('data-received');
    return promise;
  }

  function prune (keepCount, fn) {
    return runWithCallback(async function () {
      var oldProfileBoundary = await api()
        .find({}, { projection: { _id: 1, startDate: 1 } })
        .sort(profileSort)
        .skip(keepCount)
        .limit(1)
        .toArray();

      if (oldProfileBoundary.length === 0) {
        return { deletedCount: 0 };
      }

      var pruneFilter = pruneFilterForBoundary(oldProfileBoundary[0]);

      var stat = await api().deleteMany(pruneFilter);
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

  function api () {
    return ctx.store.collection(collection);
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
