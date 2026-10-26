'use strict';

const writeStep = require('../storage/write-step');

const READ_OPTIONS = require('../storage/mongo-read-options');

var find_options = require('./query');
var consts = require('../constants');
var runWithCallback = require('../storage/run-with-callback');
var purifyForStorage = require('./storage-purifier');
var countParam = require('./count');
var srvDates = require('./srv-dates');
var isDeepStrictEqual = require('util').isDeepStrictEqual;
var softDeleted = require('./soft-deleted');
var logPrivacy = require('./log-privacy');

function storage (collection, ctx, env) {
   // DEBUG_LOGGING adds the records to the save-error line (BF-193).
   var debug = logPrivacy.debugLogging(env);
   var ObjectID = require('mongodb').ObjectId;
   var profileSort = { startDate: -1, _id: -1 };
   var idForms = require('./object-id-forms');

  // A profile's _id is an ObjectId. A 24-hex string _id is stored as the
  // ObjectId it names, as treatments do, so that save, remove and find[_id] -
  // which all look profiles up by ObjectId - find the profile that was
  // created. The v1 API refuses any other string _id with a 400; storage
  // callers inside the server (the connector's internal output) keep theirs
  // as given.
  //
  // A profile sent with an _id that is already stored, in any form, is a
  // re-send of that profile, and its fields are merged into the stored one
  // (the write contract's re-send rule, decided 2026-10-12): the fields it
  // sends are written, the fields it leaves out are kept, and nothing is
  // stored twice. A re-send that changes nothing writes nothing, so
  // srvModified and API v3 history do not move. The reply carries the stored
  // _id. An explicit replacement is a PUT (save). Before, a re-send failed
  // the whole POST on the duplicate _id (BF-166), and an upper-case re-send
  // of a profile stored with a lower-case string _id was stored again.

  // The key two forms of one id share: the lower-case hex of a 24-hex string
  // or an ObjectId, or any other string as given. Undefined without an id.
  function idKey (id) {
    if (id instanceof ObjectID || idForms.isHexId(id)) return 'h:' + String(id).toLowerCase();
    if (typeof id === 'string' && id !== '') return 's:' + id;
    return undefined;
  }

  // The stored profiles the docs' _ids name, by idKey; of a stored twin (the
  // string and the ObjectId), the ObjectId one. One read, only for a batch
  // that carries _ids.
  async function storedByKey (docs) {
    var forms = [];
    docs.forEach(function (doc) {
      var key = idKey(doc._id);
      if (!key) return;
      if (key[0] === 'h') forms.push.apply(forms, idForms.idForms(doc._id));
      else forms.push(doc._id);
    });
    var byKey = new Map();
    if (forms.length === 0) return byKey;
    var stored = await api().find({ _id: { $in: forms } }).toArray();
    stored.forEach(function (doc) {
      var key = idKey(doc._id);
      if (!byKey.has(key) || typeof doc._id !== 'string') byKey.set(key, doc);
    });
    return byKey;
  }

  // The fields a re-send writes over the stored profile: every field sent
  // except _id and the server's own dates. Empty when each equals the stored
  // value.
  function changedFields (doc, stored) {
    var fields = {};
    var changed = false;
    Object.keys(doc).forEach(function (field) {
      if (field === '_id' || field === 'srvCreated' || field === 'srvModified') return;
      fields[field] = doc[field];
      if (!isDeepStrictEqual(doc[field], stored[field])) changed = true;
    });
    return changed ? fields : null;
  }

  async function mergeInto (stored, doc) {
    doc._id = stored._id;
    var fields = changedFields(doc, stored);
    if (!fields) return;
    srvDates.stampModified(fields);
    await api().updateOne({ _id: stored._id }, { $set: fields });
    Object.assign(stored, fields);
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
      const stored = await storedByKey(docs);
      const toInsert = [];
      const resends = [];
      const batchFirst = new Map();
      let changesExisting = false;
      docs.forEach(function (doc) {
        var key = idKey(doc._id);
        if (key && stored.has(key)) {
          var target = stored.get(key);
          if (changedFields(doc, target)) changesExisting = true;
          resends.push([target, doc]);
          return;
        }
        if (key && batchFirst.has(key)) {
          // The same new _id twice in one batch: the second is a re-send of
          // the first.
          resends.push([batchFirst.get(key), doc]);
          return;
        }
        if (!doc.created_at) {
          doc.created_at = (new Date()).toISOString();
        }
        doc._id = idForms.toStoredId(doc._id);
        if (key) batchFirst.set(key, doc);
        toInsert.push(doc);
      });

      // Check the complete batch before inserts or merges. Identical retries
      // and repeated IDs created within this upload need only create access.
      if (changesExisting && options.canUpdate === false) {
        const error = new Error('Missing permission api:profile:update');
        error.code = 'PROFILE_UPDATE_PERMISSION_REQUIRED';
        throw error;
      }

      if (toInsert.length > 0) {
        // API v3 history reads these (see srv-dates).
        toInsert.forEach(srvDates.stampCreated);
        const result = await api().insertMany(toInsert);
        if (result && result.insertedIds) {
          Object.keys(result.insertedIds).forEach(function (index) {
            if (!toInsert[index]._id) {
              toInsert[index]._id = result.insertedIds[index];
            }
          });
        }
      }
      for (const [target, doc] of resends) {
        await mergeInto(target, doc);
      }
      return docs;
    }, function (err, result) {
      if (err) {
        if (err.code !== 'PROFILE_UPDATE_PERMISSION_REQUIRED') {
          console.log('Error saving profile data', logPrivacy.recordForLog(docs, { collection: 'profile', debug: debug }), err);
        }
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
      return api().find(softDeleted.visible({ }), READ_OPTIONS).limit(limit).sort(profileSort).toArray();
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
        .find(query_for(opts), READ_OPTIONS)
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
