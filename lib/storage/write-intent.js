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
// Slice 1 of the first release (decision Q6 (a), patch class, gate G1): the
// food collection, written by API v1 and by in-process callers, both through
// lib/server/food.js. The rules below are that path's rules as they were in
// lib/server/food.js, moved and not changed, so every write sends MongoDB the
// same operations in the same order and every reply is the same. The
// contract's §3 changes (one natural key per collection, merge on match,
// identifier first) are the second release and are not here.

const { ObjectId } = require('mongodb');
const idForms = require('../server/object-id-forms');
const srvDates = require('../server/srv-dates');
const reads = require('../server/storage-reads');

const OUTCOMES = Object.freeze(['inserted', 'merged', 'replaced', 'unchanged', 'deleted', 'not-found', 'refused']);

// The `_id` a document is written under (rule 1).
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

// The filter that names a document's target (rule 2), in the query-document
// spelling each operation has always used, so the driver receives it as before.
const TARGETS = Object.freeze({
  'id-eq': function idEq (id) { return { _id: { $eq: id } }; },
  'id-plain': function idPlain (id) { return { _id: id }; }
});

// Today's rules, per collection and per write source (the label the storage
// interface carries; API v1 routes and in-process callers share
// 'v1/internal', so the step cannot tell them apart and does not try).
// Collections and sources not listed are not written through this step yet.
const COLLECTION_RULES = Object.freeze({
  food: Object.freeze({
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
  })
});

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

// delete: every stored form of one _id.
async function deleteTarget (storageOf, target, rule) {
  if (rule.target !== 'every-form') throw new TypeError('Unknown delete target rule: ' + rule.target);
  const reply = await storageOf().deleteMany(reads.toFilter({ '_id': idForms.idFilter(target._id) }), { v1: true });
  const deleted = reply && reply.deletedCount > 0;
  return { items: [item(0, deleted ? 'deleted' : 'not-found', target._id, null)], adapter: reply };
}

/**
 * The step over one collection.
 * @param {Object|function} storage the storage interface over the collection
 *   (lib/server/storage-reads.js collection(), an api3 MongoCollection), or
 *   a function that returns it; a function is called once per write, so a
 *   store swapped under a running server (tests do this) is the one written
 * @param {string} name the logical collection name ('food')
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
        result = await replaceDocuments(storageOf, intent.docs, rule);
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

module.exports = { forCollection, COLLECTION_RULES, OUTCOMES };
