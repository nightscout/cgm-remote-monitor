'use strict';

// write(intent): the write step above the storage interface (WC-STEP-PATCH;
// write-contract spec 2026-10-07 §2).
//
// A caller says what it wants written -- create these documents, replace
// these, delete this one -- and the step applies the collection's write rules
// in the spec's order (§2.3: `_id` form, target, outcome, server dates,
// adapter write with the string-twin removal) and answers one item per
// document: WriteResult.items[].
//
// Two layers, two names. This file is the INTENT layer: it calls the storage
// interface (lib/api3/storage/mongoCollection, through
// lib/server/storage-reads.js), never the driver. lib/storage/write-step.js is
// the persistence boundary BELOW that interface: every driver call the
// interface makes crosses it and it emits `storage-write-committed` once per
// driver call. This layer emits nothing and does not touch that event.
//
// The first release (decision Q6 (a), patch class, gate G1) moves one path at
// a time: slice 1 the food collection and slice 2 the activity collection,
// each written by API v1 and by in-process callers through its
// lib/server/<collection>.js module; slice 3 the socket's collection-generic
// writes (lib/server/websocket.js): the dbAdd of entries, food and activity,
// and dbRemove of every collection; slice 4 API v3's generic create, update,
// patch and delete (lib/api3/generic), every v3 collection; slice 5
// treatments, entries, devicestatus and profile from API v1 and in-process
// callers. The rules below are each path's rules as
// they were in that module, moved and not changed, so every write sends
// MongoDB the same operations in the same order and every reply is the same.
// Where two paths did a thing differently (activity has no server dates; its
// save removes a string twin in a call of its own, food's in the same bulk
// write) the difference is kept, as data in the rule table. The contract's §3
// changes (one natural key per collection, merge on match, identifier first)
// are the second release and are not here.

const { ObjectId } = require('mongodb');
const idForms = require('../server/object-id-forms');
const srvDates = require('../server/srv-dates');
const reads = require('../server/storage-reads');
const fallbackKey = require('../server/treatment-fallback-key');
const writeValidation = require('../server/write-validation');
const targetUnits = require('../treatmentTargetUnits');
const treatmentDuration = require('../treatmentDuration');
const READ_OPTIONS = require('./mongo-read-options');
const moment = require('moment');
const mergePatch = require('../server/merge-patch');

const OUTCOMES = Object.freeze(['inserted', 'merged', 'replaced', 'unchanged', 'deleted', 'not-found', 'refused']);

// The `_id` a document is written under (rule 1). Most forms are pure; one
// reads (`async: true`), and is awaited.
const ID_FORMS = Object.freeze({
  // create: no _id (or an empty one) gets a new ObjectId; a 24-hex string,
  // either case, becomes the ObjectId it names; anything else is kept.
  // release-2: Q-D — create keeps a custom _id, update/save replaces it with a new ObjectId; both kept per op.
  'stored-or-new': function storedOrNew (id) {
    return idForms.toStoredId(id ? id : new ObjectId());
  },
  // update (v1 PUT, in-process save): whatever new ObjectId(id) makes of it,
  // and a new ObjectId when that throws.
  // release-2: Q-D — a save of a non-hex _id inserts a new record (in-process only); kept as it is.
  'objectid-or-new': function objectIdOrNew (id) {
    try {
      return new ObjectId(id);
    } catch {
      return new ObjectId();
    }
  }
});

// The socket's form (it was websocket.js storeIdAsObjectId): a 24-hex _id is
// stored as the ObjectId it names unless the same id is already stored as a
// string; then that stored value is kept, so the insert collides with the
// stored record, as a re-sent record always has, instead of adding an
// ObjectId copy beside it. One read, only for a 24-hex _id. Any other _id (a
// custom string, a number, none) is kept as given: the driver gives a
// document without one a new ObjectId.
// release-2: Q-E — the socket keeps a stored string _id so a re-send collides (refused) rather than replacing.
async function storedStringOrObjectId (storage, id) {
  if (!idForms.isHexId(id)) return id;
  const stale = await reads.findOne(storage, { _id: { $in: idForms.stringIdForms(id) } }, { _id: 1 });
  return stale ? stale._id : idForms.toStoredId(id);
}

// The filter that names a document's target (rule 2), in the query-document
// spelling each operation has always used, so the driver receives it as before.
const TARGETS = Object.freeze({
  // release-2: Q-H — food/activity create targets {_id: {$eq}}, save plain {_id}; both spellings kept.
  'id-eq': function idEq (id) { return { _id: { $eq: id } }; },
  'id-plain': function idPlain (id) { return { _id: id }; }
});

// A delete's filter and the storage interface's options for it (`one: true`
// is deleteOne), each as the path has always sent them.
const DELETE_TARGETS = Object.freeze({
  // API v1 / in-process: every stored form of the id, always deleteMany.
  // release-2: Q-C — the v1 delete rule applies to v1 and in-process alike: one label, 'v1/internal'.
  'every-form': function everyForm (id) { return { filter: { _id: idForms.idFilter(id) }, opts: { v1: true } }; },
  // API v1 DELETE by query: the query document as the module built it.
  query: function query (filter) { return { filter: filter, opts: { v1: true } }; },
  // The socket (it was websocket.js idMatch, which dbUpdate still uses): an
  // ObjectId or 24-hex id matches each of its stored forms, with deleteMany;
  // any other id is one plain equality, with deleteOne.
  // release-2: Q-I — duplicates websocket.js idMatch, which dbUpdate still uses, until slice 6 retires it.
  'id-match': function idMatch (id) {
    if (id instanceof ObjectId || idForms.isHexId(id)) {
      return { filter: { _id: { $in: idForms.idForms(id) } }, opts: { one: false, v1: true } };
    }
    return { filter: { _id: id }, opts: { one: true, v1: true } };
  }
});

// The socket's rules for one collection's dbRemove.
const SOCKET_DELETE = Object.freeze({ target: 'id-match' });

// The socket's dbAdd of a collection with no matching of its own: one
// insertOne of the document as given (the interface's normalize: false), no
// target, server dates when API v3 serves the collection. A document whose
// _id is already stored is not written: the duplicate-key error is the
// outcome `refused`, which the socket answers with an empty reply, as it did.
// release-2: Q-E — a socket re-send of a stored _id is `refused` (empty reply); v1 replaces, v3 answers 400.
// release-2: Q5 (a) — activity's socket insert has no server dates (dates: 'none'); kept until release 2.
function socketInsert (dates) {
  return Object.freeze({ id: 'stored-string-or-objectid', target: 'none', write: 'insert-one', dates: dates
    , onDuplicate: 'refused' });
}

// ---------------------------------------------------------------------------
// Treatments from API v1 and in-process callers (slice 5; they were
// lib/server/treatments.js's own code at db3b9e4e, moved and not changed).
// Insulin and carb records from AID apps: a write that lands on the wrong
// record, or a re-send stored twice, is a dosing-history error, so every rule
// below is today's, in today's order.

function literal (value) {
  return { $eq: value };
}

// The record as stored (it was treatments.js prepareData): dates to UTC with
// the offset kept, numbers coerced, empty fields removed. The BF-194 step
// (lib/treatmentTargetUnits.js: a Temporary Target stored in mg/dL, labelled
// mg/dl) runs after the coercion and before the removal of `units` from a
// record without a glucose value, which keeps the label it set. `units:
// 'none'` leaves a Temporary Target's targets and label as sent: WRITE_VALIDATION
// judges those. Returns { created_at, preBolusCarbs, offset }. Throws as it
// always has (an eventTime that is not a date), synchronously, from plan().
function prepareTreatment (obj, units) {

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
  var labelled = units === 'temporary-target-mgdl' && targetUnits.normalizeTargetUnits(obj);

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

// How a record is prepared before its target is resolved.
const PREPARE = Object.freeze({
  none: function none ( ) { return undefined; },
  'treatment': function treatment (doc) { return prepareTreatment(doc, 'temporary-target-mgdl'); }
});

// The `_id` form of a whole document (rule 1), for the paths whose form also
// moves the value elsewhere. `env` is the server's.
const DOC_ID_FORMS = Object.freeze({
  none: function none ( ) { },
  // It was treatments.js normalizeTreatmentId (REQ-SYNC-072): an empty _id is
  // dropped; a string _id that is not 24-hex is removed (and, under
  // UUID_HANDLING, becomes the identifier when there is none); any other _id
  // is stored as the ObjectId a 24-hex string names, or as given.
  // It was profile.js save: a hex or ObjectId _id is the ObjectId it names;
  // anything else, including a 12-character string the driver would read as
  // raw bytes, gets a new ObjectId.
  // release-2: Q-D — profile save, like food/activity save, gives a non-hex _id a new ObjectId.
  'hex-or-new': function hexOrNew (doc) {
    if (doc._id instanceof ObjectId || idForms.isHexId(doc._id)) {
      doc._id = new ObjectId(doc._id);
    } else {
      doc._id = new ObjectId();
    }
  },
  // release-2: Q-N — shared by treatments and entries, whose normalizeTreatmentId and normalizeEntryId were
  // identical at db3b9e4e; reused, not unified (no behaviour of either changed).
  'treatment-uuid': function treatmentUuid (doc, env) {
    idForms.dropEmptyId(doc);
    if (typeof doc._id === 'string' && !idForms.isHexId(doc._id)) {
      if (env.uuidHandling && !doc.identifier) {
        doc.identifier = doc._id;
      }
      delete doc._id;
    } else if (Object.prototype.hasOwnProperty.call(doc, '_id') && doc._id !== null && doc._id !== '') {
      doc._id = idForms.toStoredId(doc._id);
    }
  }
});

// The filter a whole document is written by (rule 2), from the document and
// what its preparation returned.
const DOC_TARGETS = Object.freeze({
  // It was treatments.js upsertQueryFor (REQ-SYNC-072): identifier first (and
  // the document's _id is removed, so the stored record keeps its own), under
  // UUID_HANDLING also a record stored with the identifier as its _id; else
  // the _id; else the fallback key, created_at + eventType with the client's
  // identity or, without one, the carbs and insulin (BF-121,
  // treatment-fallback-key). `time` is the created_at the fallback key uses.
  'treatment-key': function treatmentKey (doc, env, time) {
    if (doc.identifier) {
      var identifierValue = doc.identifier;
      delete doc._id;
      if (env.uuidHandling) {
        return { $or: [
          { identifier: literal(identifierValue) }
          , { _id: literal(identifierValue) }
        ] };
      }
      return { identifier: literal(identifierValue) };
    }
    if (Object.prototype.hasOwnProperty.call(doc, '_id') && doc._id !== null && doc._id !== '') {
      return { _id: literal(doc._id) };
    }
    return fallbackKey.fallbackQuery(doc, time, { withAmounts: true });
  },
  // By plain _id equality (profile save).
  'id-plain': function idPlain (doc) { return { _id: doc._id }; },
  // The preBolus record's: its created_at and eventType.
  'time-and-type': function timeAndType (doc) {
    return { created_at: literal(doc.created_at), eventType: literal(doc.eventType) };
  }
});

// Which created_at the fallback key uses: the one preparation returned (a
// create) or the document's own after preparation (save). The two are equal;
// each path's spelling is kept.
// release-2: Q-M — two spellings of one value (create: prepared, save: the document's); kept per path.
const KEY_TIME = Object.freeze({
  prepared: function prepared (doc, results) { return results.created_at; },
  doc: function ofDoc (doc) { return doc.created_at; }
});

// WRITE_VALIDATION (lib/server/write-validation.js) on a path, by mode from
// the server's env: off checks nothing; log stores the record and logs the
// rules it breaks; reject also refuses it. It was treatments.js checkDomain:
// the rules are checked on a copy of the record after preparation's coercion
// and its removal of `units` from a treatment without a glucose value, before
// the BF-194 step (`units: 'none'`); in reject mode the sent `units` is first
// stored in its canonical spelling. Returns [{ index, problems }], the items
// a reject refuses, before anything is written.
// release-2: Q-F — WRITE_VALIDATION's v1 check moved here; its socket half and the conditional update stay
// below the interface (write-step.js, validated-update.js).
const CHECKS = Object.freeze({
  'treatment-domain-v1': function treatmentDomainV1 (items, env) {
    var mode = writeValidation.mode(env);
    var refused = [];
    if (mode === 'off') return refused;
    items.forEach(function (obj, index) {
      if (mode === 'reject') writeValidation.normalizeUnits(obj);
      var stored = Object.assign({}, obj);
      prepareTreatment(stored, 'none');
      var problems = writeValidation.candidate(stored).problems;
      if (problems.length === 0) return;
      console.warn(writeValidation.logLine(mode === 'reject' ? 'API v1 refused' : 'API v1', obj, problems));
      if (mode === 'reject') refused.push({ index: index, problems: problems });
    });
    return refused;
  }
});

// release-2: Q-B — a single treatment removes its string twin in a call of its own, a batch inside the bulk write.
const TREATMENT_ONE = Object.freeze({ id: 'treatment-uuid', prepare: 'treatment', target: 'treatment-key'
  , keyTime: 'prepared', write: 'replace-one', twins: 'remove-string-forms-after', dates: 'carry'
  , onMatch: 'replaced', reply: 'stored-id' });

const TREATMENTS_V1 = Object.freeze({
  check: 'treatment-domain-v1',
  // A create comes in three forms, each written as it was: a batch (an
  // array with no preBolus) is one ordered bulk write in which a write that
  // matched by _id is followed directly by the removal of that id's string
  // forms (BF-130); one document (a single object, or each item of a batch
  // that carries a preBolus) is an upserting replace, then the removal in a
  // call of its own; the preBolus record a document derives is an upserting
  // replace by its created_at and eventType, with no _id rule and no twins.
  // A record that matched is answered with the stored _id (REQ-SYNC-072 by
  // identifier, BF-165 by the fallback key).
  create: Object.freeze({ forms: Object.freeze({
    // release-2: Q-B — the twin removal directly after its write, inside the one bulk write (BF-130).
    // release-2: Q-E — a matched treatment is `replaced` (srvModified advances), as today.
    batch: Object.freeze({ id: 'treatment-uuid', prepare: 'treatment', target: 'treatment-key'
      , keyTime: 'prepared', write: 'bulk', twins: 'remove-string-forms-each', dates: 'carry'
      , onMatch: 'replaced', reply: 'stored-ids-batch' }),
    one: TREATMENT_ONE,
    // release-2: Q-H — the preBolus record is a create that replaces by created_at + eventType.
    prebolus: Object.freeze({ id: 'none', prepare: 'none', target: 'time-and-type', keyTime: 'doc'
      , write: 'replace-one', twins: 'none', dates: 'carry', onMatch: 'replaced', reply: 'upserted-id' })
  }) }),
  // save (v1 PUT, in-process): one document, as a create's single form, its
  // fallback key timed by the document's own created_at.
  update: Object.freeze(Object.assign({ }, TREATMENT_ONE, { keyTime: 'doc' })),
  // DELETE by query: every stored record the query names (the module's
  // stored_query_for, which also widens a 24-hex _id to both forms).
  delete: Object.freeze({ target: 'query' })
});

// ---------------------------------------------------------------------------
// Entries from API v1 and in-process callers (slice 5; they were
// lib/server/entries.js's own code at db3b9e4e, moved and not changed). CGM
// readings: one reading per sysTime and type, unless its identifier is
// already stored (ID-SIMPLE-MATCH); a re-send is merged into the stored
// reading as a JSON Merge Patch (Q1b).

// A client identifier an entry can be matched on: a non-empty string. Any
// other value is stored as sent and the entry is matched by time.
function hasEntryIdentifier (doc) {
  return typeof doc.identifier === 'string' && doc.identifier !== '';
}

// The stored entries an identifier names. Under UUID_HANDLING this also
// matches an entry stored with the value as its _id (15.0.6 and earlier),
// as for v1 treatments.
function entryIdentifierQuery (condition, env) {
  if (env.uuidHandling) {
    return { $or: [{ identifier: condition }, { _id: condition }] };
  }
  return { identifier: condition };
}

// It was entries.js normalizeEntryId (REQ-SYNC-072): the treatments rule,
// for entries (a non-hex string _id moves to identifier under
// UUID_HANDLING and is removed; a 24-hex one is stored as its ObjectId).
function entryIdForm (doc, env) {
  DOC_ID_FORMS['treatment-uuid'](doc, env);
}

// It was entries.js upsertQueryFor (GAP-SYNC-045): a non-hex string _id is
// removed; the target is sysTime + type, or, without both, the _id, made a
// new ObjectId when it is not one (an insert-only selector).
function entryKey (doc) {
  if (doc._id && typeof doc._id === 'string' && !idForms.isHexId(doc._id)) {
    delete doc._id;
  }
  if (doc.sysTime && doc.type) {
    return { sysTime: { $eq: doc.sysTime }, type: { $eq: doc.type } };
  }
  if (!(doc._id instanceof ObjectId)) {
    doc._id = new ObjectId();
  }
  return { _id: { $eq: doc._id } };
}

// The entries plan: every rule the module ran synchronously, in its order,
// per document: the _id form, the sysTime (dates to UTC, offset kept), the
// target, srvModified now, and the upsert ($set the fields, $setOnInsert the
// _id and srvCreated, $unset isValid when the entry does not send it).
function planEntries (rule, docs, env) {
  const insertOnly = new Set();
  const ops = docs.map(function plan (doc) {
    entryIdForm(doc, env);

    var _sysTime;
    if (doc.dateString) { _sysTime = moment.parseZone(doc.dateString); }
    if (!_sysTime && doc.date) { _sysTime = moment(doc.date); }
    if (!_sysTime) _sysTime = moment();

    doc.utcOffset = _sysTime.utcOffset();
    doc.sysTime = _sysTime.toISOString();
    if (doc.dateString) doc.dateString = doc.sysTime;

    var sentId = doc._id;
    var query = entryKey(doc);
    // A selector on an _id the server just generated can only insert.
    if (query._id && doc._id !== sentId) insertOnly.add(doc);

    // An _id is set only when the upsert inserts: a stored entry keeps its
    // own. srvModified on every write, srvCreated only on insert.
    srvDates.stampModified(doc);
    var update = { $set: doc };
    if (Object.prototype.hasOwnProperty.call(doc, '_id')) {
      var fields = Object.assign({}, doc);
      delete fields._id;
      update = { $set: fields, $setOnInsert: { _id: doc._id } };
    }
    update.$setOnInsert = Object.assign({}, update.$setOnInsert, { srvCreated: doc.srvModified });
    // An entry sent again for a reading that was deleted (isValid: false)
    // stores it again.
    if (!Object.prototype.hasOwnProperty.call(doc, 'isValid')) {
      update.$unset = { isValid: '' };
    }
    return { updateOne: { filter: query, update: update, upsert: true } };
  });
  return { planned: true, rule: rule, docs: docs, ops: ops, insertOnly: insertOnly, env: env };
}

// ID-SIMPLE-MATCH: an entry that carries an identifier already stored, or
// one an earlier entry in this batch carries, updates that entry instead of
// matching by sysTime + type. One read per batch, only for a batch that
// carries identifiers.
async function matchStoredEntryIdentifiers (storageOf, plan) {
  const docs = plan.docs;
  const ops = plan.ops;
  const env = plan.env;
  var identifiers = [];
  docs.forEach(function (doc) {
    if (hasEntryIdentifier(doc) && identifiers.indexOf(doc.identifier) === -1) identifiers.push(doc.identifier);
  });
  if (identifiers.length === 0) return;

  var stored = await reads.findAll(storageOf()
    , entryIdentifierQuery({ $in: identifiers }, env)
    , { projection: { _id: 1, identifier: 1 } });
  var known = {};
  stored.forEach(function (entry) {
    if (typeof entry.identifier === 'string') known[entry.identifier] = true;
    if (env.uuidHandling && typeof entry._id === 'string') known[entry._id] = true;
  });

  docs.forEach(function (doc, index) {
    if (!hasEntryIdentifier(doc)) return;
    if (Object.prototype.hasOwnProperty.call(known, doc.identifier)) {
      ops[index].updateOne.filter = entryIdentifierQuery({ $eq: doc.identifier }, env);
      plan.insertOnly.delete(doc);
    }
    known[doc.identifier] = true;
  });
}

// Q1b: an entry re-sent for a reading already stored (or written earlier in
// the batch) is merged into it as a JSON Merge Patch: a null removes the
// field, an object merges. Only a batch with a null or object member reads
// first, and only matching operations change.
async function mergeMatchedEntries (storageOf, plan) {
  const docs = plan.docs;
  const ops = plan.ops;
  const env = plan.env;
  var candidates = [];
  docs.forEach(function (doc, index) {
    if (!plan.insertOnly.has(doc) && mergePatch.differsFromSet(doc)) candidates.push(index);
  });
  if (candidates.length === 0) return;

  function keyOf (filter) {
    if (filter.sysTime && filter.type) return 't:' + filter.sysTime.$eq + '\u0000' + filter.type.$eq;
    if (filter.identifier) return 'd:' + filter.identifier.$eq;
    if (filter.$or) return 'd:' + filter.$or[0].identifier.$eq;
    return 'i:' + String(filter._id.$eq);
  }
  function keysOf (entry) {
    var keys = ['t:' + entry.sysTime + '\u0000' + entry.type];
    if (entry._id !== undefined) keys.push('i:' + String(entry._id));
    if (typeof entry.identifier === 'string') keys.push('d:' + entry.identifier);
    if (env.uuidHandling && typeof entry._id === 'string') keys.push('d:' + entry._id);
    return keys;
  }

  var state = new Map();
  function register (box) {
    keysOf(box.doc).forEach(function (key) {
      if (!state.has(key)) state.set(key, box);
    });
  }
  var stored = await reads.findAll(storageOf(), { $or: ops.map(function (op) { return op.updateOne.filter; }) });
  stored.forEach(function (entry) { register({ doc: entry }); });

  var candidate = new Set(candidates);
  ops.forEach(function (op, index) {
    var key = keyOf(op.updateOne.filter);
    var box = state.get(key);
    var fields = op.updateOne.update.$set;
    if (!box) {
      box = { doc: Object.assign({}, op.updateOne.update.$setOnInsert, fields) };
      state.set(key, box);
      register(box);
      return;
    }
    if (!candidate.has(index)) {
      box.doc = Object.assign({}, box.doc, fields);
      register(box);
      return;
    }
    var parts = mergePatch.update(box.doc, fields);
    var update = mergePatch.toMongo(parts);
    update.$setOnInsert = op.updateOne.update.$setOnInsert;
    if (op.updateOne.update.$unset) {
      update.$unset = Object.assign({}, op.updateOne.update.$unset, update.$unset);
    }
    op.updateOne.update = update;
    box.doc = mergePatch.assignInto(Object.assign({}, box.doc), parts);
    register(box);
  });
}

// An entry that updated a stored one is answered with the stored entry's
// _id: by identifier, then by sysTime + type. One read each, only when
// needed.
async function assignStoredEntryIds (storageOf, plan, upsertedIds) {
  const docs = plan.docs;
  const ops = plan.ops;
  const env = plan.env;
  var matched = [];
  var byIdentifier = [];
  ops.forEach(function (op, index) {
    var filter = op.updateOne.filter;
    if (Object.prototype.hasOwnProperty.call(upsertedIds, index)) return;
    if (filter.sysTime && filter.type) {
      matched.push(index);
    } else if (filter.identifier || filter.$or) {
      byIdentifier.push(index);
    }
  });

  if (byIdentifier.length > 0) {
    var identified = await reads.findAll(storageOf()
      , entryIdentifierQuery({ $in: byIdentifier.map(function (index) { return docs[index].identifier; }) }, env)
      , { projection: { _id: 1, identifier: 1 } });
    var byValue = {};
    identified.forEach(function (entry) {
      if (env.uuidHandling && typeof entry._id === 'string') byValue[entry._id] = entry._id;
    });
    identified.forEach(function (entry) {
      if (typeof entry.identifier === 'string') byValue[entry.identifier] = entry._id;
    });
    byIdentifier.forEach(function (index) {
      var id = byValue[docs[index].identifier];
      if (id !== undefined) docs[index]._id = id;
    });
  }

  if (matched.length === 0) return;

  var key = function (sysTime, type) { return sysTime + '\u0000' + type; };
  var stored = await reads.findAll(storageOf()
    , { $or: matched.map(function (index) { return ops[index].updateOne.filter; }) }
    , { projection: { _id: 1, sysTime: 1, type: 1 } });
  var byKey = {};
  stored.forEach(function (entry) { byKey[key(entry.sysTime, entry.type)] = entry._id; });
  matched.forEach(function (index) {
    var filter = ops[index].updateOne.filter;
    var id = byKey[key(filter.sysTime.$eq, filter.type.$eq)];
    if (id !== undefined) docs[index]._id = id;
  });
}

// The entries write: the target resolved (identifier, else sysTime + type),
// the merge computed against it, one ordered bulk write of upserting
// updates; then the new entries' _id and srvCreated, and the stored _id of
// the ones that matched. A failed read-back leaves the _id as sent; its
// error is `readBackError`, for the module to log as it did.
async function writePlannedEntries (storageOf, plan) {
  await matchStoredEntryIdentifiers(storageOf, plan);
  await mergeMatchedEntries(storageOf, plan);
  const ops = plan.ops.map(function toInterface (op) {
    const changes = op.updateOne.update;
    if (Object.keys(changes).some(key => ['$set', '$setOnInsert', '$unset'].indexOf(key) === -1)) {
      throw new TypeError('Unsupported bulk update for the storage interface');
    }
    return { filter: reads.toFilter(op.updateOne.filter), doc: changes.$set
      , setOnInsert: changes.$setOnInsert, unset: changes.$unset };
  });
  const reply = await storageOf().bulkUpsert(ops, { mode: 'merge', ordered: true, v1: true });

  const docs = plan.docs;
  const upserted = (reply && reply.upsertedIds) || {};
  Object.keys(upserted).forEach(function (index) {
    docs[index]._id = upserted[index];
    docs[index].srvCreated = docs[index].srvModified;
  });

  let readBackError;
  try {
    await assignStoredEntryIds(storageOf, plan, upserted);
  } catch (err) {
    readBackError = err;
  }
  return { items: docs.map(function outcome (doc, index) {
    return item(index, Object.prototype.hasOwnProperty.call(upserted, index) ? 'inserted' : plan.rule.onMatch
      , doc._id, doc.identifier);
  }), adapter: reply, readBackError: readBackError };
}

const ENTRIES_V1 = Object.freeze({
  // Every write is an upserting update in one ordered bulk write: target
  // identifier (when stored) else sysTime + type; a match is merged.
  // release-2: Q-E — a matched entry is `merged` ($set, plus the Merge Patch for nulls and objects).
  // release-2: Q-K — the synchronous rules run in plan(), at the moment entries.js ran them.
  create: Object.freeze({ plan: 'entries', write: 'entries-merge-bulk', onMatch: 'merged' }),
  delete: Object.freeze({ target: 'query' })
});

// ---------------------------------------------------------------------------
// Devicestatus from API v1 and in-process callers (slice 5; it was
// lib/server/devicestatus.js's own code at db3b9e4e, moved and not changed).
// A status is a snapshot: a re-sent one is acknowledged with the stored _id
// and not written again. Statuses are only ever inserted on this path, so a
// status with the created_at and device of a stored one is a second record,
// as it is today.

function hasStatusIdentifier (obj) {
  return typeof obj.identifier === 'string' && obj.identifier !== '';
}

// ID-SIMPLE-MATCH, devicestatus option (b) (decided 2026-10-26): a status
// whose identifier is stored is answered with the stored _id (the first by
// _id) and not written; a repeat within the batch takes the first's _id once
// it is stored. One read, only for a batch that carries identifiers.
async function withoutStoredStatusIdentifiers (storageOf, statuses) {
  var identifiers = [];
  statuses.forEach(function (obj) {
    if (hasStatusIdentifier(obj) && identifiers.indexOf(obj.identifier) === -1) identifiers.push(obj.identifier);
  });
  if (identifiers.length === 0) return { insert: statuses, repeats: [], known: [] };

  var stored = await reads.findAll(storageOf(), { identifier: { $in: identifiers } }
    , { projection: { _id: 1, identifier: 1 }, sort: { _id: 1 } });
  var storedAs = {};
  stored.forEach(function (doc) {
    if (!Object.prototype.hasOwnProperty.call(storedAs, doc.identifier)) storedAs[doc.identifier] = doc._id;
  });

  var firstInBatch = {};
  var insert = [];
  var repeats = [];
  var known = [];
  statuses.forEach(function (obj) {
    if (!hasStatusIdentifier(obj)) {
      insert.push(obj);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(storedAs, obj.identifier)) {
      obj._id = storedAs[obj.identifier];
      known.push(obj);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(firstInBatch, obj.identifier)) {
      repeats.push({ status: obj, first: firstInBatch[obj.identifier] });
      return;
    }
    firstInBatch[obj.identifier] = obj;
    insert.push(obj);
  });
  return { insert: insert, repeats: repeats, known: known };
}

// The `_id` rule: a 24-hex _id is stored as the ObjectId it names; one
// already stored, in either form, names a status that is there, which is
// answered with its stored _id (the ObjectId form of a twin) and not written;
// the same new id twice in a batch stores the first. One read, only for a
// batch that carries 24-hex _ids. Returns the statuses to insert.
async function withoutStoredStatusIds (storageOf, statuses, known) {
  var hexIds = statuses.map(function (obj) { return obj._id; }).filter(idForms.isHexId);
  if (hexIds.length === 0) return statuses;

  var forms = [];
  hexIds.forEach(function (id) { forms.push.apply(forms, idForms.idForms(id)); });
  var stored = await reads.findAll(storageOf(), { _id: { $in: forms } }, { projection: { _id: 1 } });
  var storedAs = {};
  stored.forEach(function (doc) {
    var key = String(doc._id);
    if (!Object.prototype.hasOwnProperty.call(storedAs, key) || typeof doc._id !== 'string') {
      storedAs[key] = doc._id;
    }
  });

  var seen = {};
  return statuses.filter(function (obj) {
    if (!idForms.isHexId(obj._id)) return true;
    var kept = idForms.stringIdForms(obj._id).filter(function (form) {
      return Object.prototype.hasOwnProperty.call(storedAs, form);
    });
    var hex = obj._id.toLowerCase();
    if (kept.length > 0) {
      obj._id = storedAs[kept[0]];
      known.push(obj);
      return false;
    }
    obj._id = idForms.toStoredId(obj._id);
    if (seen[hex]) return false;
    seen[hex] = true;
    return true;
  });
}

// The devicestatus write: the identifier rule, then the _id rule, then
// srvCreated/srvModified on what is new and one unordered insertMany, so a
// status another request stored meanwhile under the same _id does not stop
// the rest. A duplicate-key error on statuses sent with an _id is that
// race: they are dropped from what was inserted; any other error is the
// caller's. A failed read is a WriteRuleError ('status-match'), so the
// module logs it as it did. `inserted` is what the module announces.
async function writeStatuses (storageOf, statuses, rule) {
  var toInsert;
  var repeats;
  var known = [];
  try {
    var split = await withoutStoredStatusIdentifiers(storageOf, statuses);
    repeats = split.repeats;
    known = split.known;
    toInsert = await withoutStoredStatusIds(storageOf, split.insert, known);
  } catch (err) {
    throw new WriteRuleError('status-match', err);
  }

  var raced = [];
  var insertResult;
  if (toInsert.length > 0) {
    if (rule.dates === 'stamp-created') toInsert.forEach(srvDates.stampCreated);
    else throw new TypeError('No server-date rule ' + rule.dates + ' for devicestatus');
    var sentIds = toInsert.map(function (obj) { return obj._id !== undefined; });
    try {
      insertResult = await storageOf().insertMany(toInsert, { ordered: false });
    } catch (err) {
      var writeErrors = [].concat(err.writeErrors || []);
      var alreadyStored = writeErrors.length > 0 && writeErrors.every(function (writeError) {
        return writeError.code === 11000 && sentIds[writeError.index];
      });
      if (!alreadyStored) throw err;
      var storedAt = writeErrors.map(function (writeError) { return writeError.index; });
      raced = toInsert.filter(function (obj, index) { return storedAt.indexOf(index) !== -1; });
      toInsert = toInsert.filter(function (obj, index) { return storedAt.indexOf(index) === -1; });
      insertResult = null;
    }

    if (insertResult && insertResult.insertedIds) {
      Object.keys(insertResult.insertedIds).forEach(function (index) {
        toInsert[index]._id = insertResult.insertedIds[index];
      });
    }
  }

  repeats.forEach(function (repeat) {
    repeat.status._id = repeat.first._id;
  });

  var items = statuses.map(function outcome (obj, index) {
    if (toInsert.indexOf(obj) !== -1) return item(index, 'inserted', obj._id, obj.identifier);
    if (known.indexOf(obj) !== -1 || raced.indexOf(obj) !== -1) {
      return item(index, 'refused', obj._id, obj.identifier, 'already stored');
    }
    return item(index, 'refused', obj._id, obj.identifier, 'repeated in the batch');
  });
  return { items: items, adapter: insertResult, inserted: toInsert };
}

const DEVICESTATUS_V1 = Object.freeze({
  // release-2: Q-L — no natural key on v1: a status with a stored one's created_at and device is a second record.
  // release-2: Q-J — a re-send that is not written is answered `refused` ('already stored').
  // release-2: Q-O — devicestatus inserts unordered, profile ordered; each kept.
  create: Object.freeze({ write: 'statuses', dates: 'stamp-created' }),
  delete: Object.freeze({ target: 'query' })
});

// ---------------------------------------------------------------------------
// Profile from API v1 and in-process callers (slice 5; it was
// lib/server/profile.js's own code at db3b9e4e, moved and not changed). A
// profile sent with an _id already stored is a re-send, merged into the
// stored profile as a JSON Merge Patch (Q1b); a create is an insert; save
// is a replace by _id.

// The key two forms of one id share: the lower-case hex of a 24-hex string
// or an ObjectId, or any other string as given. Undefined without an id.
function profileIdKey (id) {
  if (id instanceof ObjectId || idForms.isHexId(id)) return 'h:' + String(id).toLowerCase();
  if (typeof id === 'string' && id !== '') return 's:' + id;
  return undefined;
}

// The stored profiles the docs' _ids name, by key; of a stored twin, the
// ObjectId one. One read, only for a batch that carries _ids.
async function storedProfilesByKey (storageOf, docs) {
  var forms = [];
  docs.forEach(function (doc) {
    var key = profileIdKey(doc._id);
    if (!key) return;
    if (key[0] === 'h') forms.push.apply(forms, idForms.idForms(doc._id));
    else forms.push(doc._id);
  });
  var byKey = new Map();
  if (forms.length === 0) return byKey;
  var stored = await reads.findAll(storageOf(), { _id: { $in: forms } });
  stored.forEach(function (doc) {
    var key = profileIdKey(doc._id);
    if (!byKey.has(key) || typeof doc._id !== 'string') byKey.set(key, doc);
  });
  return byKey;
}

// What a re-send changes in the stored profile: every field sent except _id
// and the server's dates, as a JSON Merge Patch. Null when nothing changes.
function changedProfileFields (doc, stored) {
  var parts = mergePatch.update(stored, doc, { skip: ['_id', 'srvCreated', 'srvModified'] });
  return parts.changed ? parts : null;
}

async function mergeProfileInto (storageOf, stored, doc) {
  doc._id = stored._id;
  var parts = changedProfileFields(doc, stored);
  if (!parts) return false;
  srvDates.stampModified(parts.set);
  var changes = mergePatch.toMongo(parts);
  await storageOf().updateMany(reads.toFilter({ _id: stored._id }), { set: changes.$set, unset: changes.$unset }
    , { one: true, v1: true });
  mergePatch.assignInto(stored, parts);
  return true;
}

// The profile create: classify every document against the stored profiles
// (a re-send of a stored one, a repeat of a new _id in the batch, or new),
// and, when a re-send would change a stored profile and the caller may not
// update (intent.canUpdate === false), write nothing and answer those
// re-sends `refused`. Otherwise insert the new profiles (created_at when
// missing, the _id form, srvCreated), then merge each re-send in order.
async function writeProfiles (storageOf, docs, rule, intent) {
  const stored = await storedProfilesByKey(storageOf, docs);
  const toInsert = [];
  const resends = [];
  const batchFirst = new Map();
  const changing = new Set();
  docs.forEach(function (doc, index) {
    var key = profileIdKey(doc._id);
    if (key && stored.has(key)) {
      var target = stored.get(key);
      if (changedProfileFields(doc, target)) changing.add(index);
      resends.push([target, doc, index]);
      return;
    }
    if (key && batchFirst.has(key)) {
      resends.push([batchFirst.get(key), doc, index]);
      return;
    }
    if (!doc.created_at) {
      doc.created_at = (new Date()).toISOString();
    }
    doc._id = idForms.toStoredId(doc._id);
    if (key) batchFirst.set(key, doc);
    toInsert.push(doc);
  });

  if (changing.size > 0 && intent.canUpdate === false) {
    return { items: docs.map(function refused (doc, index) {
      return changing.has(index) ? item(index, 'refused', doc._id, doc.identifier, 'update permission')
        : item(index, 'refused', doc._id, doc.identifier, 'batch refused');
    }), adapter: null, refusedUpdate: true };
  }

  const outcomes = new Array(docs.length);
  let adapter = null;
  if (toInsert.length > 0) {
    if (rule.dates === 'stamp-created') toInsert.forEach(srvDates.stampCreated);
    else throw new TypeError('No server-date rule ' + rule.dates + ' for profile');
    adapter = await storageOf().insertMany(toInsert);
    if (adapter && adapter.insertedIds) {
      Object.keys(adapter.insertedIds).forEach(function (index) {
        if (!toInsert[index]._id) {
          toInsert[index]._id = adapter.insertedIds[index];
        }
      });
    }
  }
  for (const [target, doc, index] of resends) {
    outcomes[index] = (await mergeProfileInto(storageOf, target, doc)) ? 'merged' : 'unchanged';
  }
  return { items: docs.map(function outcome (doc, index) {
    return item(index, outcomes[index] || 'inserted', doc._id, doc.identifier);
  }), adapter: adapter };
}

const PROFILE_V1 = Object.freeze({
  // release-2: Q-J — an identical re-send writes nothing and is answered `unchanged`.
  // release-2: Q-P — the update permission travels in the intent (canUpdate), checked before any write.
  create: Object.freeze({ write: 'profiles', dates: 'stamp-created' }),
  // save (v1 PUT, in-process): a hex or ObjectId _id names the profile to
  // replace; anything else gets a new ObjectId. An upserting replace by
  // plain _id, then, for a hex or ObjectId _id, the removal of its string
  // forms in a call of its own. Carried server dates.
  // release-2: Q-B — save removes the string twin in a call of its own, as activity and treatments save do.
  update: Object.freeze({ id: 'hex-or-new', prepare: 'none', target: 'id-plain', keyTime: 'doc'
    , write: 'replace-one', twins: 'remove-string-forms-after', dates: 'carry', onMatch: 'replaced', reply: 'none' }),
  // remove(_id): every stored form; prune: the boundary query.
  delete: Object.freeze({ target: 'every-form' }),
  prune: Object.freeze({ target: 'query' })
});

// ---------------------------------------------------------------------------
// API v3's generic create, update (PUT), patch and delete (slice 4; they were
// lib/api3/generic/create/insert.js, update/replace.js, patch/operation.js and
// delete/operation.js's own code at db3b9e4e, moved and not changed). One code
// path serves every API v3 collection.
//
// v3 writes BY IDENTIFIER through the cached storage
// (lib/api3/storage/mongoCachedCollection): insertOne, replaceOne(identifier),
// updateOne(identifier), updateEveryForm, deleteEveryForm. The wrapper then
// tells the in-memory cache about the record written and only that one
// (`data-update` `update` with it, or `remove` with its _id). Its query-based
// methods (replaceFiltered, updateMany, deleteMany, bulkUpsert, insertMany)
// cannot know which records they touched, so after one the wrapper empties
// all three caches and they reload from MongoDB (a `remove` with no changes,
// lib/server/cache.js). So the step keeps v3 on the identifier methods: a
// second method family beside the filter one v1 uses (write-contract Q-A,
// maintainer 2026-10-29).
//
// What stays in the v3 modules: the permission checks, input validation (the
// immutable-field check, update/validate.js, which compares with the stored
// record), the read that finds the stored record (permission and validation
// sit between it and the write), the HTTP reply, the storage-socket
// emissions, autoPrune and data-received. What stays below the interface:
// which stored copy an identifier write lands on (modify.js writeFilter: the
// document with the identifier first, of two copies stored by _id the
// ObjectId one), since the step can only name the identifier to the
// identifier methods.
// release-2: Q-A — two method families under the step (filter for v1, identifier for v3); kept until a catch-up
// by srvModified watermark can replace the cache flush a filter write causes.

// The fields v3 sets on a document before it is written, each operation's in
// the order it set them, so the stored document's fields come in the same
// order as before. `intent.by` is the authenticated subject's name, when there
// is one; `intent.target.stored` the stored record the module read.
const V3_STAMPS = Object.freeze({
  // BF-194: a Temporary Target is stored in mg/dL, labelled mg/dl, after
  // validation.
  units: function units (doc) { targetUnits.normalizeTargetUnits(doc); },
  // PATCH: a patch that sends a target, glucose, units or eventType carries
  // both targets and the label as they will be stored; other patches leave
  // the stored record as it is.
  'units-patch': function unitsPatch (doc, intent) { targetUnits.normalizeTargetUnits(doc, intent.target.stored); },
  // One clock for every writer, so history never sees two writes with the
  // same srvModified (lib/server/srv-dates.js).
  'dates-created': function datesCreated (doc) {
    doc.srvModified = new Date(srvDates.next()).getTime();
    doc.srvCreated = doc.srvModified;
  },
  // PUT, and a POST deduplicated into a stored record: srvCreated carried.
  'dates-replaced': function datesReplaced (doc, intent) {
    doc.srvModified = new Date(srvDates.next()).getTime();
    doc.srvCreated = intent.target.stored.srvCreated || doc.srvModified;
  },
  'dates-modified': function datesModified (doc) { doc.srvModified = new Date(srvDates.next()).getTime(); },
  subject: function subject (doc, intent) { if (intent.by) doc.subject = intent.by; },
  'modified-by': function modifiedBy (doc, intent) { if (intent.by) doc.modifiedBy = intent.by; },
  // endmills from a duration (lib/treatmentDuration.js), on every collection
  // as before.
  duration: function duration (doc) { treatmentDuration.normalizeTreatmentDuration(doc); },
  // PATCH: in reject mode only when the patch touches the domain fields, so
  // a notes-only patch of an old target is not turned into a domain edit at
  // the conditional boundary and refused.
  'duration-patch': function durationPatch (doc, intent, env) {
    if (writeValidation.mode(env) !== 'reject' || writeValidation.touchesDomain(doc)) {
      treatmentDuration.normalizeTreatmentDuration(doc, intent.target.stored);
    }
  }
});

function stampV3 (rule, doc, intent, env) {
  (rule.stamps || [ ]).forEach(function stamp (name) {
    const stampOf = V3_STAMPS[name];
    if (!stampOf) throw new TypeError('Unknown API v3 stamp: ' + name);
    stampOf(doc, intent, env);
  });
}

function oneV3Doc (intent) {
  if (!Array.isArray(intent.docs) || intent.docs.length !== 1) throw new TypeError(intent.op + ' writes one document');
  return intent.docs[0];
}

// Each write is one identifier method of the cached storage. Every rule runs
// before its first await, so srvModified is issued in the same tick as the
// write starts, as before. The document is the module's own object, written
// in place: its srvModified (and the cached insert's removal of _id) is what
// the module answers with.
const V3_WRITES = Object.freeze({
  // create: an insert; answered with the identifier storage reports.
  'v3-insert': async function v3Insert (storage, intent, rule, env) {
    const doc = oneV3Doc(intent);
    stampV3(rule, doc, intent, env);
    const identifier = await storage.insertOne(doc);
    return { items: [item(0, 'inserted', null, identifier)], adapter: identifier };
  },
  // update (PUT, a deduplicated POST): replaceOne by the stored record's
  // identifier, an upsert; matchedCount 0 means the record was gone.
  'v3-replace': async function v3Replace (storage, intent, rule, env) {
    const doc = oneV3Doc(intent);
    stampV3(rule, doc, intent, env);
    const matchedCount = await storage.replaceOne(intent.target.identifier, doc);
    return { items: [item(0, matchedCount ? 'replaced' : 'inserted', null, doc.identifier)], adapter: matchedCount };
  },
  // patch: the body as a JSON Merge Patch of the stored record (Q1b: a null
  // removes the field, an object merges, anything else replaces), one
  // updateOne by identifier; `patched` is the record as it now is.
  'v3-merge': async function v3Merge (storage, intent, rule, env) {
    const doc = oneV3Doc(intent);
    stampV3(rule, doc, intent, env);
    const stored = intent.target.stored;
    const parts = mergePatch.update(stored, doc);
    const result = await storage.updateOne(intent.target.identifier, parts.set, parts.unset);
    return { items: [item(0, result && result.updated ? 'merged' : 'not-found', null, intent.target.identifier)]
      , adapter: result, patched: mergePatch.assignInto(Object.assign({}, stored), parts) };
  },
  // delete: every stored form marked isValid: false, with a new srvModified.
  'v3-mark-deleted': async function v3MarkDeleted (storage, intent) {
    const setFields = { 'isValid': false, 'srvModified': srvDates.next() };
    V3_STAMPS['modified-by'](setFields, intent);
    const result = await storage.updateEveryForm(intent.target.identifier, setFields);
    return { items: [item(0, result && result.updated ? 'deleted' : 'not-found', null, intent.target.identifier)]
      , adapter: result };
  },
  // delete ?permanent=true: every stored form removed.
  'v3-delete-every-form': async function v3DeleteEveryForm (storage, intent) {
    const result = await storage.deleteEveryForm(intent.target.identifier);
    return { items: [item(0, result && result.deleted ? 'deleted' : 'not-found', null, intent.target.identifier)]
      , adapter: result };
  }
});

// The API v3 rules of one collection. `units` names the BF-194 rule:
// treatments store a Temporary Target in mg/dL ('temporary-target-mgdl'),
// every other collection has none.
function v3Rules (units) {
  const tt = units === 'temporary-target-mgdl';
  return Object.freeze({
    create: Object.freeze({ write: 'v3-insert'
      , stamps: Object.freeze((tt ? ['units'] : [ ]).concat(['dates-created', 'subject'])) }),
    update: Object.freeze({ write: 'v3-replace'
      , stamps: Object.freeze(['dates-replaced', 'subject', 'duration'].concat(tt ? ['units'] : [ ])) }),
    patch: Object.freeze({ write: 'v3-merge'
      , stamps: Object.freeze(['dates-modified', 'modified-by', 'duration-patch'].concat(tt ? ['units-patch'] : [ ])) }),
    // release-2: Q-S — a v3 delete marks or removes EVERY stored form of the record, a v3 PUT/PATCH writes ONE
    // (modify.js writeFilter); kept as it is.
    delete: Object.freeze({ forms: Object.freeze({
      mark: Object.freeze({ write: 'v3-mark-deleted' }),
      permanent: Object.freeze({ write: 'v3-delete-every-form' })
    }) })
  });
}

const V3_TREATMENTS = v3Rules('temporary-target-mgdl');
const V3_OTHER = v3Rules('none');

// Today's rules, per collection and per write source (the label the storage
// interface carries; API v1 routes and in-process callers share
// 'v1/internal', so the step cannot tell them apart and does not try).
// Collections and sources not listed are not written through this step yet.
// release-2: Q-C — API v1 and in-process callers share the source label 'v1/internal'; the step cannot tell
// them apart, and every v1 rule below applies to both.
const COLLECTION_RULES = Object.freeze({
  // The socket only: dbAdd for these three has its own matching, near match,
  // validation and reply slots, still in websocket.js.
  treatments: Object.freeze({ socket: Object.freeze({ delete: SOCKET_DELETE }), 'v1/internal': TREATMENTS_V1, v3: V3_TREATMENTS }),
  devicestatus: Object.freeze({ socket: Object.freeze({ delete: SOCKET_DELETE }), 'v1/internal': DEVICESTATUS_V1, v3: V3_OTHER }),
  profile: Object.freeze({ socket: Object.freeze({ delete: SOCKET_DELETE }), 'v1/internal': PROFILE_V1, v3: V3_OTHER }),
  entries: Object.freeze({ socket: Object.freeze({ create: socketInsert('stamp-created'), delete: SOCKET_DELETE })
    , 'v1/internal': ENTRIES_V1, v3: V3_OTHER }),
  food: Object.freeze({
    socket: Object.freeze({ create: socketInsert('stamp-created'), delete: SOCKET_DELETE }),
    'v1/internal': Object.freeze({
      // Every write is an upserting replace by _id (onMatch: replace); a
      // record also stored under the string form of a submitted 24-hex _id
      // is removed after the batch's replaces, in the same ordered bulk
      // write (BF-130). srvCreated and identifier are carried from the
      // record replaced; srvModified is new (srv-dates carryForReplace).
      // release-2: Q-B — food removes string twins once, after all replaces, in the same bulk write.
      // release-2: Q-E — a re-send is `replaced` (srvModified advances), not `unchanged`.
      create: Object.freeze({ id: 'stored-or-new', target: 'id-eq', onMatch: 'replaced', twins: 'remove-string-forms', dates: 'carry' }),
      update: Object.freeze({ id: 'objectid-or-new', target: 'id-plain', onMatch: 'replaced', twins: 'remove-string-forms', dates: 'carry' }),
      // Every stored form of the id: the ObjectId and its string spellings.
      delete: Object.freeze({ target: 'every-form' })
    }),
    v3: V3_OTHER
  }),
  // API v3 only.
  settings: Object.freeze({ v3: V3_OTHER }),
  activity: Object.freeze({
    socket: Object.freeze({ create: socketInsert('none'), delete: SOCKET_DELETE }),
    'v1/internal': Object.freeze({
      // create is food's create without server dates: activity has no API v3
      // endpoint and has never been stamped (write-contract Q5 (a) gives it
      // dates in the second release, not here).
      create: Object.freeze({ id: 'stored-or-new', target: 'id-eq', onMatch: 'replaced', twins: 'remove-string-forms', dates: 'none' }),
      // update (v1 PUT, in-process save) writes ONE document: an upserting
      // replaceOne by plain _id equality, then, in a separate call and only
      // when the submitted _id was 24-hex, the removal of its string forms
      // (write-contract Q-B keeps both timings as they are).
      // release-2: Q-B — activity save removes its twin in a call of its own; activity create, after the batch.
      // release-2: Q5 (a) — activity has no server dates on any v1 write.
      update: Object.freeze({ id: 'objectid-or-new', target: 'id-plain', onMatch: 'replaced', twins: 'remove-string-forms-after', dates: 'none', write: 'replace-one' }),
      delete: Object.freeze({ target: 'every-form' })
    })
  })
});

// A rule that could not be applied because storage failed under it (the read
// of the socket's `_id` form). Its `rule` names it and `cause` is the storage
// error, so a caller can answer as it did when the rule was its own code.
class WriteRuleError extends Error {
  constructor (rule, cause) {
    super('Write rule ' + rule + ' failed: ' + (cause && cause.message));
    this.name = 'WriteRuleError';
    this.rule = rule;
    this.cause = cause;
  }
}

function isDuplicateKey (err) {
  return Boolean(err) && err.code === 11000;
}

function rulesFor (name, source, op) {
  const collection = COLLECTION_RULES[name];
  const bySource = collection && collection[source];
  const rule = bySource && bySource[op];
  if (!rule) {
    throw new TypeError('No write rules for ' + op + ' on ' + name + ' from ' + source);
  }
  return rule;
}

// The rule of an intent: a collection whose op comes in forms (treatments'
// create) names it in intent.form.
function ruleOf (name, source, intent) {
  const rule = rulesFor(name, source, intent.op);
  if (!rule.forms) return rule;
  const form = rule.forms[intent.form];
  if (!form) throw new TypeError('No write rules for ' + intent.op + ' form ' + intent.form + ' on ' + name + ' from ' + source);
  return form;
}

function item (index, outcome, _id, identifier, reason) {
  if (OUTCOMES.indexOf(outcome) === -1) throw new TypeError('Unknown write outcome: ' + outcome);
  const result = { index: index, outcome: outcome, _id: _id
    , identifier: identifier === undefined ? null : identifier };
  if (reason !== undefined) result.reason = reason;
  return result;
}

// create / update: whole documents, each an upserting replace by its _id.
// The documents are the caller's own objects and are written in place: their
// _id, srvCreated, srvModified (and a carried identifier) are what the caller
// answers with, as before.
async function replaceDocuments (storageOf, docs, rule) {
  const submitted = [];
  const targets = docs.map(function target (doc) {
    submitted.push(doc._id);
    doc._id = ID_FORMS[rule.id](doc._id);
    return { filter: TARGETS[rule.target](doc._id), doc: doc };
  });
  const stale = rule.twins === 'remove-string-forms' ? idForms.staleStringForms(submitted) : [];

  // Server dates right before the write, from the documents the filters name
  // now (rule 4).
  // The storage interface is acquired here, after every document has its
  // _id: a caller that cannot reach storage still gets its documents' ids
  // assigned and a rejected promise, as before.
  const storage = storageOf();
  if (rule.dates === 'carry') await srvDates.carryForReplace(reads.documents(storage), targets);
  else if (rule.dates !== 'none') throw new TypeError('No server-date rule ' + rule.dates + ' for a batch replace');

  const ops = targets.map(function op (t) { return { filter: reads.toFilter(t.filter), doc: t.doc }; });
  if (stale.length > 0) ops.push({ remove: reads.toFilter({ _id: { $in: stale } }) });
  const reply = await storage.bulkUpsert(ops, { mode: 'replace', ordered: true, v1: true });

  const upserted = (reply && reply.upsertedIds) || { };
  const items = docs.map(function outcome (doc, index) {
    if (Object.prototype.hasOwnProperty.call(upserted, index)) {
      return item(index, 'inserted', upserted[index], doc.identifier);
    }
    return item(index, rule.onMatch, doc._id, doc.identifier);
  });
  return { items: items, adapter: reply };
}

// update of ONE document (the `replace-one` write): an upserting replace by
// its target, then the removal of its string twins in a call of its own,
// directly after the write it belongs to. The document is the caller's own
// object and is written in place, as above.
async function replaceOneDocument (storageOf, docs, rule) {
  if (docs.length !== 1) throw new TypeError('This update writes one document, not ' + docs.length);
  if (rule.dates !== 'none') throw new TypeError('No server-date rule ' + rule.dates + ' for a replace-one write');
  const doc = docs[0];
  const stale = rule.twins === 'remove-string-forms-after' ? idForms.staleStringForms([doc._id]) : [];
  doc._id = ID_FORMS[rule.id](doc._id);
  const filter = TARGETS[rule.target](doc._id);

  const storage = storageOf();
  const reply = await storage.replaceFiltered(reads.toFilter(filter), doc, { upsert: true, v1: true });
  if (stale.length > 0) await storage.deleteMany(reads.toFilter({ _id: { $in: stale } }), { v1: true });

  const inserted = reply && reply.upsertedId !== undefined && reply.upsertedId !== null;
  return { items: [inserted ? item(0, 'inserted', reply.upsertedId, doc.identifier)
    : item(0, rule.onMatch, doc._id, doc.identifier)], adapter: reply };
}

// create of ONE document by a plain insert (the `insert-one` write): no target
// is resolved, so the outcome is `inserted`, or `refused` when its _id is
// already stored. Any other storage error is the caller's, as before.
async function insertOneDocument (storageOf, docs, rule) {
  if (docs.length !== 1) throw new TypeError('This create writes one document, not ' + docs.length);
  if (rule.target !== 'none') throw new TypeError('No target rule ' + rule.target + ' for an insert-one write');
  const doc = docs[0];
  const storage = storageOf();
  if (rule.id === 'stored-string-or-objectid') {
    try {
      // Assigned only when the form differs: a document sent without an _id
      // must not gain an `_id: undefined` key before the driver gives it one.
      const formed = await storedStringOrObjectId(storage, doc._id);
      if (formed !== doc._id) doc._id = formed;
    } catch (err) {
      throw new WriteRuleError('id-form', err);
    }
  } else {
    throw new TypeError('No _id rule ' + rule.id + ' for an insert-one write');
  }
  if (rule.dates === 'stamp-created') srvDates.stampCreated(doc);
  else if (rule.dates !== 'none') throw new TypeError('No server-date rule ' + rule.dates + ' for an insert-one write');

  try {
    await storage.insertOne(doc, { normalize: false });
  } catch (err) {
    if (rule.onDuplicate === 'refused' && isDuplicateKey(err)) {
      return { items: [item(0, 'refused', doc._id, doc.identifier, err.message)], adapter: null };
    }
    throw err;
  }
  return { items: [item(0, 'inserted', doc._id, doc.identifier)], adapter: null };
}

// delete: one _id, matched as the rule says.
async function deleteTarget (storageOf, target, rule) {
  const targetOf = DELETE_TARGETS[rule.target];
  if (!targetOf) throw new TypeError('Unknown delete target rule: ' + rule.target);
  const byQuery = rule.target === 'query';
  const match = targetOf(byQuery ? target.filter : target._id);
  const reply = await storageOf().deleteMany(reads.toFilter(match.filter), match.opts);
  const deleted = reply && reply.deletedCount > 0;
  return { items: [item(0, deleted ? 'deleted' : 'not-found', byQuery ? null : target._id, null)], adapter: reply };
}

// A planned write: the rules a module ran synchronously before its first
// await, in the same order and at the same moment, so an error they throw (an
// eventTime that is not a date) is thrown to the caller as it was: for each
// document its `_id` form, its preparation, its target, and the string forms
// of its submitted _id that the write removes (only when the target is the
// _id). write() takes the plan; a module that had nothing synchronous to keep
// may pass the intent itself.
function planDocuments (rule, docs, env) {
  const idForm = DOC_ID_FORMS[rule.id];
  const prepare = PREPARE[rule.prepare];
  const targetOf = DOC_TARGETS[rule.target];
  const timeOf = KEY_TIME[rule.keyTime];
  if (!idForm || !prepare || !targetOf || !timeOf) throw new TypeError('Incomplete document rules');
  const targets = [ ];
  const prepared = [ ];
  const stale = [ ];
  docs.forEach(function plan (doc) {
    const submitted = doc._id;
    idForm(doc, env);
    const results = prepare(doc);
    const filter = targetOf(doc, env, timeOf(doc, results));
    targets.push(filter);
    prepared.push(results);
    stale.push(rule.twins !== 'none' && filter && filter._id ? idForms.staleStringForms([submitted]) : [ ]);
  });
  return { planned: true, rule: rule, docs: docs, targets: targets, prepared: prepared, stale: stale };
}

// A planned batch as one ordered bulk write: each document an upserting
// replace by its target, followed directly by the removal of its string twins
// (BF-130: a later item matched by its fallback key could otherwise land on
// the string copy and be removed with it). Server dates right before it.
async function writePlannedBatch (storageOf, plan) {
  const docs = plan.docs;
  const ops = [ ];
  const opItem = [ ];
  docs.forEach(function op (doc, index) {
    ops.push({ filter: plan.targets[index], doc: doc });
    opItem.push(index);
    if (plan.stale[index].length > 0) {
      ops.push({ remove: { _id: { $in: plan.stale[index] } } });
      opItem.push(null);
    }
  });
  const storage = storageOf();
  if (plan.rule.dates !== 'carry') throw new TypeError('No server-date rule ' + plan.rule.dates + ' for a planned batch');
  await srvDates.carryForReplace(reads.documents(storage), ops.filter(function replaces (op) { return !op.remove; })
    .map(function target (op) { return { filter: op.filter, doc: op.doc }; }));
  const reply = await storage.bulkUpsert(ops.map(function toInterface (op) {
    if (op.remove) return { remove: reads.toFilter(op.remove) };
    return { filter: reads.toFilter(op.filter), doc: op.doc };
  }), { mode: 'replace', ordered: true, v1: true });

  const inserted = new Set();
  if (reply && reply.upsertedIds) {
    Object.keys(reply.upsertedIds).forEach(function assign (index) {
      const at = opItem[index];
      if (at !== null && at !== undefined) {
        docs[at]._id = reply.upsertedIds[index];
        inserted.add(at);
      }
    });
  }
  await REPLIES[plan.rule.reply](storageOf, plan, reply);
  return { items: docs.map(function outcome (doc, index) {
    return item(index, inserted.has(index) ? 'inserted' : plan.rule.onMatch, doc._id, doc.identifier);
  }), adapter: reply };
}

// A planned single document: an upserting replace by its target, then the
// removal of its string twins in a call of its own. Server dates right before.
async function writePlannedOne (storageOf, plan) {
  if (plan.docs.length !== 1) throw new TypeError('This write is of one document, not ' + plan.docs.length);
  if (plan.rule.dates !== 'carry') throw new TypeError('No server-date rule ' + plan.rule.dates + ' for a planned write');
  const doc = plan.docs[0];
  const query = plan.targets[0];
  const storage = storageOf();
  await srvDates.carryForReplace(reads.documents(storage), [{ filter: query, doc: doc }]);
  const reply = await storage.replaceFiltered(reads.toFilter(query), doc, { upsert: true, v1: true });
  if (plan.stale[0].length > 0) {
    await storageOf().deleteMany(reads.toFilter({ _id: { $in: plan.stale[0] } }), { v1: true });
  }
  await REPLIES[plan.rule.reply](storageOf, plan, reply);
  const inserted = Boolean(reply) && reply.upsertedCount == 1;
  return { items: [item(0, inserted ? 'inserted' : plan.rule.onMatch, doc._id, doc.identifier)], adapter: reply };
}

const PLANS = Object.freeze({ documents: planDocuments, entries: planEntries });

// The _id a written document is answered with. A failed read-back leaves the
// _id as it is: the write succeeded, so the reply still reports it.
const REPLIES = Object.freeze({
  // The _id as written (profile save).
  none: async function none ( ) { },
  // The upserted _id only (the preBolus record).
  'upserted-id': async function upsertedId (storageOf, plan, reply) {
    if (reply && reply.upsertedCount == 1) plan.docs[0]._id = reply.upsertedId;
  },
  // One document: the upserted _id, or, when it matched a stored record by
  // its identifier (REQ-SYNC-072) or its fallback key (BF-165), that
  // record's _id, read back by the same target.
  'stored-id': async function storedId (storageOf, plan, reply) {
    const doc = plan.docs[0];
    if (reply && reply.upsertedCount == 1) {
      doc._id = reply.upsertedId;
    } else if (reply && reply.matchedCount >= 1 && !doc._id) {
      try {
        const existing = await reads.findOne(storageOf(), plan.targets[0]);
        if (existing) doc._id = existing._id;
      } catch {
        // as above
      }
    }
  },
  // A batch (the upserted _ids are already assigned): the documents matched
  // by identifier get the stored _id in one read (REQ-SYNC-072); any still
  // without one, the record its target names now (BF-165).
  'stored-ids-batch': async function storedIdsBatch (storageOf, plan) {
    const docs = plan.docs;
    const docsNeedingId = docs.filter(function needs (obj) { return !obj._id && obj.identifier; });
    if (docsNeedingId.length > 0) {
      const identifiers = docsNeedingId.map(function identifier (obj) { return obj.identifier; });
      try {
        const existing = await reads.findAll(storageOf(), { identifier: { $in: identifiers } }
          , { readOptions: READ_OPTIONS });
        if (existing) {
          const idMap = new Map();
          existing.forEach(function byIdentifier (doc) {
            if (doc.identifier) idMap.set(doc.identifier, doc._id);
          });
          docsNeedingId.forEach(function assign (obj) {
            if (obj.identifier && idMap.has(obj.identifier)) obj._id = idMap.get(obj.identifier);
          });
        }
      } catch {
        // as above
      }
    }
    for (let index = 0; index < docs.length; index++) {
      if (docs[index]._id) continue;
      try {
        const matched = await reads.findOne(storageOf(), plan.targets[index], { _id: 1 });
        if (matched) docs[index]._id = matched._id;
      } catch {
        // as above
      }
    }
  }
});

/**
 * The step over one collection.
 * @param {Object|function} storage the storage interface over the collection
 *   (lib/server/storage-reads.js collection(), an api3 MongoCollection), or
 *   a function that returns it; a function is called once per write, so a
 *   store swapped under a running server (tests do this) is the one written
 * @param {string} name the logical collection name ('food', 'activity', ...)
 * @param {string} source the write source the storage is labelled with
 *   (MongoCollection.SOURCES)
 * @returns {{ write: function(Object): Promise<Object> }}
 */
function forCollection (storage, name, source, options) {
  const storageOf = typeof storage === 'function' ? storage : function given ( ) { return storage; };
  // The server's env, for the rules that read it (UUID_HANDLING,
  // WRITE_VALIDATION).
  const env = (options && options.env) || { };
  return {
    /**
     * Run the synchronous rules of a create or update now (see
     * planDocuments); write() takes what this returns.
     * @param {Object} intent { op, form, docs }
     * @returns {Object} the planned intent; throws as the rules throw
     */
    plan: function plan (intent) {
      const rule = ruleOf(name, source, intent);
      if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
      return PLANS[rule.plan || 'documents'](rule, intent.docs, env);
    },
    /**
     * The path's WRITE_VALIDATION rule over documents about to be created or
     * updated: [{ index, problems }] for each one it refuses (none unless
     * WRITE_VALIDATION=reject), logging each it would (log, reject).
     * @param {Object[]} docs
     */
    check: function check (docs) {
      const collection = COLLECTION_RULES[name];
      const rules = collection && collection[source];
      const checkOf = rules && CHECKS[rules.check];
      if (!checkOf) throw new TypeError('No write check for ' + name + ' from ' + source);
      return checkOf(docs, env);
    },
    /**
     * @param {Object} intent { op: 'create' | 'update' | 'delete', form
     *   (where the collection's op has forms), docs: [doc, ...] (create,
     *   update), target: { _id } or { filter } (delete) }, or what plan()
     *   returned
     * @returns {Promise<Object>} WriteResult: { items: [{ index, outcome,
     *   _id, identifier, reason }], event: null, adapter, prepared }.
     *   `event` is the change event of spec §2.4; it is not built yet
     *   (D-EVENT is open), so it is null. `adapter` is the storage
     *   interface's own reply, for the callers whose reply has always been
     *   that reply (a v1 delete). `prepared` is, for a planned write, what
     *   each document's preparation returned.
     */
    write: async function write (intent) {
      if (!intent || typeof intent !== 'object') throw new TypeError('write(intent) needs an intent');
      let result;
      let planned = intent.planned === true ? intent : null;
      const rule = planned ? planned.rule : ruleOf(name, source, intent);
      if (!planned && (rule.prepare !== undefined || rule.plan !== undefined)) {
        if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
        planned = PLANS[rule.plan || 'documents'](rule, intent.docs, env);
      }
      if (planned) {
        if (rule.write === 'bulk') result = await writePlannedBatch(storageOf, planned);
        else if (rule.write === 'replace-one') result = await writePlannedOne(storageOf, planned);
        else if (rule.write === 'entries-merge-bulk') result = await writePlannedEntries(storageOf, planned);
        else throw new TypeError('No planned write ' + rule.write);
        const written = { items: result.items, event: null, adapter: result.adapter, prepared: planned.prepared };
        if (result.readBackError !== undefined) written.readBackError = result.readBackError;
        return written;
      }
      if (Object.prototype.hasOwnProperty.call(V3_WRITES, rule.write)) {
        result = await V3_WRITES[rule.write](storageOf(), intent, rule, env);
        const written = { items: result.items, event: null, adapter: result.adapter };
        if (result.patched !== undefined) written.patched = result.patched;
        return written;
      }
      if ((intent.op === 'create') && (rule.write === 'statuses' || rule.write === 'profiles')) {
        if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
        result = rule.write === 'statuses' ? await writeStatuses(storageOf, intent.docs, rule)
          : await writeProfiles(storageOf, intent.docs, rule, intent);
        const written = { items: result.items, event: null, adapter: result.adapter };
        if (result.inserted !== undefined) written.inserted = result.inserted;
        if (result.refusedUpdate) written.refusedUpdate = true;
        return written;
      }
      if (intent.op === 'create' || intent.op === 'update') {
        if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
        if (rule.write === 'insert-one') result = await insertOneDocument(storageOf, intent.docs, rule);
        else if (rule.write === 'replace-one') result = await replaceOneDocument(storageOf, intent.docs, rule);
        else result = await replaceDocuments(storageOf, intent.docs, rule);
      } else if (intent.op === 'delete' || intent.op === 'prune') {
        const key = rule.target === 'query' ? 'filter' : '_id';
        if (!intent.target || !Object.prototype.hasOwnProperty.call(intent.target, key)) {
          throw new TypeError('delete needs target.' + key);
        }
        result = await deleteTarget(storageOf, intent.target, rule);
      } else {
        throw new TypeError('Unsupported write intent: ' + intent.op);
      }
      return { items: result.items, event: null, adapter: result.adapter };
    }
  };
}

module.exports = { forCollection, COLLECTION_RULES, OUTCOMES, WriteRuleError };
