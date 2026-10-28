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
// and dbRemove of every collection. The rules below are each path's rules as
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

const OUTCOMES = Object.freeze(['inserted', 'merged', 'replaced', 'unchanged', 'deleted', 'not-found', 'refused']);

// The `_id` a document is written under (rule 1). Most forms are pure; one
// reads (`async: true`), and is awaited.
const ID_FORMS = Object.freeze({
  // create: no _id (or an empty one) gets a new ObjectId; a 24-hex string,
  // either case, becomes the ObjectId it names; anything else is kept.
  'stored-or-new': function storedOrNew (id) {
    return idForms.toStoredId(id ? id : new ObjectId());
  },
  // update (v1 PUT, in-process save): whatever new ObjectId(id) makes of it,
  // and a new ObjectId when that throws.
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
async function storedStringOrObjectId (storage, id) {
  if (!idForms.isHexId(id)) return id;
  const stale = await reads.findOne(storage, { _id: { $in: idForms.stringIdForms(id) } }, { _id: 1 });
  return stale ? stale._id : idForms.toStoredId(id);
}

// The filter that names a document's target (rule 2), in the query-document
// spelling each operation has always used, so the driver receives it as before.
const TARGETS = Object.freeze({
  'id-eq': function idEq (id) { return { _id: { $eq: id } }; },
  'id-plain': function idPlain (id) { return { _id: id }; }
});

// A delete's filter and the storage interface's options for it (`one: true`
// is deleteOne), each as the path has always sent them.
const DELETE_TARGETS = Object.freeze({
  // API v1 / in-process: every stored form of the id, always deleteMany.
  'every-form': function everyForm (id) { return { filter: { _id: idForms.idFilter(id) }, opts: { v1: true } }; },
  // The socket (it was websocket.js idMatch, which dbUpdate still uses): an
  // ObjectId or 24-hex id matches each of its stored forms, with deleteMany;
  // any other id is one plain equality, with deleteOne.
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
function socketInsert (dates) {
  return Object.freeze({ id: 'stored-string-or-objectid', target: 'none', write: 'insert-one', dates: dates
    , onDuplicate: 'refused' });
}

// Today's rules, per collection and per write source (the label the storage
// interface carries; API v1 routes and in-process callers share
// 'v1/internal', so the step cannot tell them apart and does not try).
// Collections and sources not listed are not written through this step yet.
const COLLECTION_RULES = Object.freeze({
  // The socket only: dbAdd for these three has its own matching, near match,
  // validation and reply slots, still in websocket.js.
  treatments: Object.freeze({ socket: Object.freeze({ delete: SOCKET_DELETE }) }),
  devicestatus: Object.freeze({ socket: Object.freeze({ delete: SOCKET_DELETE }) }),
  profile: Object.freeze({ socket: Object.freeze({ delete: SOCKET_DELETE }) }),
  entries: Object.freeze({ socket: Object.freeze({ create: socketInsert('stamp-created'), delete: SOCKET_DELETE }) }),
  food: Object.freeze({
    socket: Object.freeze({ create: socketInsert('stamp-created'), delete: SOCKET_DELETE }),
    'v1/internal': Object.freeze({
      // Every write is an upserting replace by _id (onMatch: replace); a
      // record also stored under the string form of a submitted 24-hex _id
      // is removed after the batch's replaces, in the same ordered bulk
      // write (BF-130). srvCreated and identifier are carried from the
      // record replaced; srvModified is new (srv-dates carryForReplace).
      create: Object.freeze({ id: 'stored-or-new', target: 'id-eq', onMatch: 'replaced', twins: 'remove-string-forms', dates: 'carry' }),
      update: Object.freeze({ id: 'objectid-or-new', target: 'id-plain', onMatch: 'replaced', twins: 'remove-string-forms', dates: 'carry' }),
      // Every stored form of the id: the ObjectId and its string spellings.
      delete: Object.freeze({ target: 'every-form' })
    })
  }),
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
  const match = targetOf(target._id);
  const reply = await storageOf().deleteMany(reads.toFilter(match.filter), match.opts);
  const deleted = reply && reply.deletedCount > 0;
  return { items: [item(0, deleted ? 'deleted' : 'not-found', target._id, null)], adapter: reply };
}

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
function forCollection (storage, name, source) {
  const storageOf = typeof storage === 'function' ? storage : function given ( ) { return storage; };
  return {
    /**
     * @param {Object} intent { op: 'create' | 'update' | 'delete',
     *   docs: [doc, ...] (create, update), target: { _id } (delete) }
     * @returns {Promise<Object>} WriteResult: { items: [{ index, outcome,
     *   _id, identifier, reason }], event: null, adapter }. `event` is the
     *   change event of spec §2.4; it is not built yet (D-EVENT is open), so
     *   it is null. `adapter` is the storage interface's own reply, for the
     *   callers whose reply has always been that reply (a v1 delete).
     */
    write: async function write (intent) {
      if (!intent || typeof intent !== 'object') throw new TypeError('write(intent) needs an intent');
      const rule = rulesFor(name, source, intent.op);
      let result;
      if (intent.op === 'create' || intent.op === 'update') {
        if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
        if (rule.write === 'insert-one') result = await insertOneDocument(storageOf, intent.docs, rule);
        else if (rule.write === 'replace-one') result = await replaceOneDocument(storageOf, intent.docs, rule);
        else result = await replaceDocuments(storageOf, intent.docs, rule);
      } else if (intent.op === 'delete') {
        if (!intent.target || !Object.prototype.hasOwnProperty.call(intent.target, '_id')) {
          throw new TypeError('delete needs target._id');
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
