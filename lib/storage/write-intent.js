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
// callers; slice 6 the rest of the socket: the dbAdd of treatments,
// devicestatus and profile (exact and similar match, WRITE_VALIDATION's
// preflight, BF-194) and dbUpdate and dbUpdateUnset of every collection. The
// rules below are each path's rules as
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
const softDeleted = require('../server/soft-deleted');
const v1Writes = require('../server/storage-writes');
const validatedUpdate = require('./validated-update');
const v3Utils = require('../api3/storage/mongoCollection/utils');
const writeSettings = require('../server/write-settings');

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

// The records a client of the socket means by an _id (it was websocket.js
// idMatch; slice 6 retired it, Q-I): dbRemove, dbUpdate and dbUpdateUnset
// share it. A 24-hex id (or an ObjectId) matches the record whichever form its
// _id is stored in: the ObjectId, or the string, as dbAdd and the v1 routes
// stored it before. Both forms can be stored at once (an ObjectId copy left
// beside a string one by an earlier write), so writes by such an id reach
// every copy (`many`). Any other id, such as a custom string, matches exactly
// one record, as given.
function socketIdMatch (id) {
  if (id instanceof ObjectId || idForms.isHexId(id)) {
    return { filter: { _id: { $in: idForms.idForms(id) } }, many: true };
  }
  return { filter: { _id: id }, many: false };
}

// ---------------------------------------------------------------------------
// identifier-match (ID-FIRST-MATCH rule 2; design note 2026-10-29 §1.1): the
// stored records a client `identifier` names. Every path that matches on an
// identifier builds its query from this one rule. What a path adds beside
// `identifier`, which record it takes when several match, and what a match
// gives are data in its rule entry (`identifier: { also, pick }`), each as
// that path's code had it at 9919f8ef: slice 1 changes no outcome, and the
// driver receives the same query documents in the same order.

// What is matched beside `identifier`. Each takes the query value the path
// has always used (`{ $eq: X }`, `{ $in: [...] }`).
const IDENTIFIER_ALSO = Object.freeze({
  // identifier alone.
  none: function none ( ) { return [ ]; },
  // Under UUID_HANDLING, also a record stored with the value as its _id
  // (15.0.6 and earlier stored a client UUID there): v1 / in-process
  // treatments and entries.
  'uuid-id': function uuidId (condition, env) { return env && env.uuidHandling ? [{ _id: condition }] : [ ]; },
  // API v3: also a record with no identifier of its own whose _id is the
  // value, in either stored form (the records a v3 read shows with it).
  'shown-id': function shownId (condition) { return v3Utils.shownIdClauses(condition.$eq); }
});

// Which record a path takes when an identifier names several; a path's code
// checks that its rule names a pick it applies.
const IDENTIFIER_PICKS = Object.freeze([
  // Each path's pick before ID-Q5 (P1). Kept as vocabulary so a path's rule
  // can be put back to it (the slice 5 red control):
  // the record the upserting write reaches (MongoDB's first): v1 / in-process
  // treatments and entries
  'driver-first',
  // of the records read, the last: the treatments batch reply, the entries reply
  'last-read',
  // the first by _id ascending: v1 / in-process device status
  'first-by-id',
  // the first by identifier -1, _id -1 (find.js findOneFilter): API v3 create,
  // PUT and PATCH
  'v3-order',
  // P4 (ID-Q5, ID-Q10; p4Pick): the newest by _id whose time key equals the
  // write's, else the newest by _id. The socket's dbUpdate and dbUpdateUnset
  // by identifier, and since slice 5 every create or re-send matched by
  // identifier: v1 / in-process treatments (and their save), entries and
  // device status, and API v3's identifying read; and API v3 PUT and PATCH
  // /{identifier} (V3_ADDRESS_IDENTIFIER)
  'p4',
  // every record: the socket's dbRemove by identifier, as API v3 DELETE
  'every'
]);

// P4's time key per collection (ID-Q5): the field that tells two records with
// one identifier apart, compared with the write's. Settings has none, so P4
// takes the newest there. API v1 food overwrites created_at with the server
// time before the write, so food re-sent over v1 falls back to the newest.
const P4_TIME_KEYS = Object.freeze({
  treatments: Object.freeze(['created_at'])
  , devicestatus: Object.freeze(['created_at'])
  , food: Object.freeze(['created_at'])
  , activity: Object.freeze(['created_at'])
  , entries: Object.freeze(['sysTime', 'date'])
  , profile: Object.freeze(['startDate'])
  , settings: Object.freeze([ ])
});

// A time as milliseconds: a number as it is, a Date, or a string Date.parse
// reads; NaN for anything else.
function timeValue (value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value.trim() !== '') return Date.parse(value);
  return NaN;
}

// Two values of one time key name the same moment: equal as stored, or as
// instants (one moment spelled with another offset or precision).
function sameTime (a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  if (a === b) return true;
  const x = timeValue(a);
  return Number.isFinite(x) && x === timeValue(b);
}

// An _id as it may be logged: an ObjectId or 24-hex string as it is, any other
// value only by its kind, since under UUID_HANDLING a string _id can be the
// identifier itself.
function loggedId (id) {
  return id instanceof ObjectId || idForms.isHexId(id) ? String(id) : 'a ' + typeof id + ' _id';
}

// P4 (ID-Q5, ID-Q10): of `stored`, the records one identifier names, newest
// _id first, the one a write lands on: the first whose time key (`timeKeys`)
// equals the write's (`fields`), else the first (the newest). Null when there
// is none. When there is more than one, the pick is logged with `label` (the
// collection and path), the count and the picked _id; never the identifier.
function p4Pick (stored, fields, timeKeys, label) {
  if (!stored || stored.length === 0) return null;
  const write = fields || { };
  const timed = stored.find(function sameTimeKey (doc) {
    return (timeKeys || [ ]).some(function (key) { return sameTime(write[key], doc[key]); });
  });
  const picked = timed || stored[0];
  if (stored.length > 1) {
    console.warn(LOG_DEDUP + label + ': identifier names ' + stored.length + ' records; the write lands on '
      + loggedId(picked._id) + (timed ? ' (same time)' : ' (newest)'));
  }
  return picked;
}

// Of the records identifier-match read for several identifiers, the ones
// `value` names under the rule's `also` (the read's clauses, in JavaScript),
// in the order read.
function namedBy (stored, value, also, env) {
  return stored.filter(function names (doc) {
    if (doc.identifier === value) return true;
    return also === 'uuid-id' && Boolean(env && env.uuidHandling) && doc._id === value;
  });
}

// ---------------------------------------------------------------------------
// identifier-format (ID-VALIDATE; ID-Q6, ID-PLACEHOLDER-LIST, BF-215, BF-216):
// which `identifier` values are identifiers. One check, used wherever a write
// carries an identifier and wherever the socket addresses a record by one.
//
// An identifier is any string of 1 to 256 characters (MongoDB's index key
// limit), with no character restriction. Every other value is treated as
// absent: a placeholder (the list below, compared without regard to case), an
// empty or whitespace-only string, a string over 256 characters, JSON null, and
// any value that is not a string (a number, boolean, object or array: BF-215,
// which answered 500 on v1 treatments). Treated as absent means it is not
// matched on and not stored: the field is removed from the document, and a
// warning is logged naming the path, the collection and the value's class,
// never the value. So two apps that both send the same placeholder no longer
// land in one record (BF-216). Under WRITE_IDENTIFIER=strict a path that can
// refuse one document refuses it instead (IDENTIFIER_STRICT).
//
// The check runs right after each path's `_id` step, so a placeholder `_id`
// that UUID_HANDLING moves into `identifier` is caught as well.
const IDENTIFIER_MAX_LENGTH = 256;
const PLACEHOLDER_IDENTIFIERS = Object.freeze(['undefined', 'null', 'invalid', 'nan', 'unknown']);

// The class of an `identifier` value: 'valid', or why it is treated as absent.
function identifierClass (value) {
  if (value === null) return 'null';
  if (typeof value !== 'string') return 'not-a-string';
  if (value.trim() === '') return 'blank';
  if (value.length > IDENTIFIER_MAX_LENGTH) return 'over-length';
  if (PLACEHOLDER_IDENTIFIERS.indexOf(value.toLowerCase()) !== -1) return 'placeholder';
  return 'valid';
}

function isValidIdentifier (value) {
  return identifierClass(value) === 'valid';
}

// What WRITE_IDENTIFIER=strict does on each path. 'refuse': the path refuses
// that document (API v3 400; the socket's per-document refusal slot, as
// WRITE_VALIDATION=reject has it). 'absent': strict is not enforced there yet
// and the value is treated as absent, as under lenient.
// ID-STRICT-V1 (decided by the maintainer, 2026-10-30): strict refusal on API
// v1 and in-process comes with ID-BATCH's per-item batch replies. Until then
// those paths treat the value as absent under strict too.
const IDENTIFIER_STRICT = Object.freeze({ v3: 'refuse', socket: 'refuse', 'v1/internal': 'absent' });

const IDENTIFIER_PROBLEMS = Object.freeze({
  null: 'identifier is null'
  , 'not-a-string': 'identifier is not a string'
  , blank: 'identifier is empty'
  , 'over-length': 'identifier is longer than ' + IDENTIFIER_MAX_LENGTH + ' characters'
  , placeholder: 'identifier is a placeholder'
});

// The identifier-format rule over documents about to be written from `source`
// into `name`: each document whose `identifier` is not valid loses the field
// (lenient, and strict where IDENTIFIER_STRICT says 'absent'), or, under strict
// where the path refuses, is left as it is and returned in
// [{ index, problems }] for the path to refuse. A document with no
// `identifier` field is left alone.
function applyIdentifierFormat (docs, env, name, source, absentOnly) {
  const strict = !absentOnly && writeSettings.identifierMode(env) === 'strict' && IDENTIFIER_STRICT[source] === 'refuse';
  const refused = [ ];
  (docs || [ ]).forEach(function check (doc, index) {
    if (!doc || typeof doc !== 'object' || !Object.prototype.hasOwnProperty.call(doc, 'identifier')) return;
    const kind = identifierClass(doc.identifier);
    if (kind === 'valid') return;
    const detail = kind === 'not-a-string' ? kind + ' (' + (Array.isArray(doc.identifier) ? 'array' : typeof doc.identifier) + ')' : kind;
    if (strict) {
      console.warn('WRITE_IDENTIFIER ' + source + ' ' + name + ': refused, identifier ' + detail);
      refused.push({ index: index, problems: [{ rule: 'identifier-format', field: 'identifier'
        , message: IDENTIFIER_PROBLEMS[kind] }] });
      return;
    }
    console.warn('WRITE_IDENTIFIER ' + source + ' ' + name + ': identifier treated as absent, ' + detail);
    delete doc.identifier;
  });
  return refused;
}

// The rule inside the step, after a path's `_id` step: always treats an
// invalid identifier as absent. Strict refusal happens earlier, where the route
// can still refuse the document (forCollection's identifiers()), so a document
// reaching this point under strict was not refused by its path.
function identifiersAbsent (docs, scope) {
  if (!scope) throw new TypeError('identifier-format needs the write scope');
  applyIdentifierFormat(docs, scope.env, scope.name, scope.source, true);
}

// ---------------------------------------------------------------------------
// identifier-held (ID-RULE1-EDIT, decided by the maintainer 2026-10-30): an
// edit that names record X by its _id and carries an `identifier` another
// stored record Y holds is refused, 409, and nothing is written. "Held" counts
// soft-deleted records, as the planned unique index does. It applies whatever
// WRITE_IDENTIFIER is (identifier-format has run: only a valid identifier is
// checked). An edit carrying X's own identifier, or none, and a write with no
// _id (a create), are not checked. A path's rule names it
// (`identifierHeld: 'refuse'`); 'ignore' (or no entry) leaves the edit as it
// was. The answer never names the identifier or Y's _id.
const IDENTIFIER_HELD = Object.freeze(['ignore', 'refuse']);
const IDENTIFIER_HELD_MESSAGE = 'identifier is held by another record';

class IdentifierConflictError extends Error {
  constructor ( ) {
    super(IDENTIFIER_HELD_MESSAGE);
    this.name = 'IdentifierConflictError';
    this.status = 409;
  }
}

function isIdentifierConflict (err) {
  return Boolean(err) && err.name === 'IdentifierConflictError';
}

// The path's rule checks identifier-held.
function refusesHeld (rule) {
  const held = rule && rule.identifierHeld;
  if (held === undefined) return false;
  if (IDENTIFIER_HELD.indexOf(held) === -1) throw new TypeError('Unknown identifier-held rule: ' + held);
  return held === 'refuse';
}

// An _id the edit names, as sent: present and not empty.
function namesId (submitted) {
  return submitted !== undefined && submitted !== null && submitted !== '';
}

// One read: a record other than X (`exceptId`, every stored form of it; none
// given for API v3, whose addressed record is known not to hold `value`)
// whose `identifier` is `value`, soft-deleted ones included.
async function identifierHeldElsewhere (storage, value, exceptId) {
  const query = { identifier: { $eq: value } };
  if (exceptId !== undefined) {
    query._id = (exceptId instanceof ObjectId || idForms.isHexId(exceptId)) ? { $nin: idForms.idForms(exceptId) }
      : { $ne: exceptId };
  }
  return Boolean(await reads.findOne(storage, query, { _id: 1 }));
}

// identifier-held over the edits of one write, before it writes: each
// { value, submitted, id, stored } (the identifier the edit carries after
// identifier-format, the _id as sent, the _id written, and the record that
// _id names as read for the server dates: null when there is none,
// undefined when it was not read). The read runs only for an edit with an _id
// and a valid identifier that is not the stored record's own; where the
// record was not read before the write (activity, the socket), for every edit
// with an _id and a valid identifier, and the read itself leaves X out.
// Throws IdentifierConflictError for the first held one; nothing is written.
async function refuseHeldIdentifiers (storage, rule, edits) {
  if (!refusesHeld(rule)) return;
  for (const edit of edits) {
    if (!namesId(edit.submitted) || !isValidIdentifier(edit.value)) continue;
    if (edit.stored && edit.stored.identifier === edit.value) continue;
    // Every stored form of X is excluded, so a string-_id twin of X that
    // holds the identifier is not another record.
    if (await identifierHeldElsewhere(storage, edit.value, edit.id)) throw new IdentifierConflictError();
  }
}

// ---------------------------------------------------------------------------
// on-deleted (ID-FIRST-MATCH slice 3; ID-Q4 and ID-Q3, decided 2026-10-29 and
// 2026-10-30): what a write does when the record its match reaches is
// soft-deleted (`isValid: false`). It depends on the key that matched:
//   identifier  identifier-match (the identifier, and the forms IDENTIFIER_ALSO
//               adds; on API v3 the identifier the client sent)
//   identity    another identity field equal to the write's (IDENTITY_FIELDS:
//               _id, NSCLIENT_ID, syncIdentifier, id, uuid), alone or as part
//               of a key, and the socket's similar match when a sent
//               identity decides it (#8877)
//   computed    API v3 only: identifier-match on the identifier API v3
//               computed for a record sent without one (from device, date and
//               eventType; lib/api3/shared/operationTools.js
//               calculateIdentifier). Its action is per collection
//               (V3_COMPUTED_IDENTIFIER)
//   time        a time key alone (treatments' fallback key without a client
//               identity, entries' sysTime + type, device status created_at,
//               API v3's fallback fields)
// and on the action the path's rule (`deleted`) names for that key:
//   acknowledged  a create (re-send) writes nothing; the reply names the
//                 stored record ('unchanged', reason DELETED_REASON); no
//                 event. The record stays deleted.
//   edit          an edit writes nothing, and WRITE_DELETED_EDIT decides the
//                 answer: `ignore` as acknowledged, `refuse` DeletedRecordError
//                 (410). The record stays deleted.
//   hidden        the deleted record is not a match: the write matches a live
//                 record or stores a new one beside it.
//   revive        the deleted record is matched and written, which brings it
//                 back (every v1, in-process and API v3 key before slice 3).
// A deliberate restore is a separate item; no action here restores a record.
const IDENTITY_FIELDS = Object.freeze(['_id', 'NSCLIENT_ID', 'syncIdentifier', 'id', 'uuid']);
const DELETED_ACTIONS = Object.freeze(['acknowledged', 'edit', 'hidden', 'revive']);
// API v3's computed identifier, per collection (maintainer, 2026-10-30): on
// entries, profile, food, settings and device status it counts as an identity,
// so a re-create after a delete is acknowledged and the record stays deleted.
// Treatments keep today's revive in 16.0.0: AndroidAPS stalls its upload queue
// without bound on a 410, and a treatment it re-creates after a delete would
// otherwise never be stored again; an upstream ask to AndroidAPS follows.
const V3_COMPUTED_IDENTIFIER = Object.freeze({
  treatments: 'revive',
  entries: 'acknowledged',
  profile: 'acknowledged',
  food: 'acknowledged',
  settings: 'acknowledged',
  devicestatus: 'acknowledged'
});

const ON_DELETED = Object.freeze({
  // A re-send (create): stays deleted on an identity key; a time key stores a new record (ID-Q4).
  // API v3's computed identifier: by collection (V3_COMPUTED_IDENTIFIER).
  'stays-deleted': Object.freeze({ identifier: 'acknowledged', identity: 'acknowledged', computed: 'by-collection', time: 'hidden' }),
  // An edit (v1 PUT, in-process save, socket dbUpdate / dbUpdateUnset): not applied (ID-Q3).
  'stays-deleted-edit': Object.freeze({ identifier: 'edit', identity: 'edit', computed: 'edit', time: 'hidden' }),
  // Before slice 3, and still the rule where it is kept: every key reaches the deleted record and revives it.
  revive: Object.freeze({ identifier: 'revive', identity: 'revive', computed: 'revive', time: 'revive' }),
  // Before slice 3 on the socket's treatments and device status dbAdd: no key sees a deleted record.
  hidden: Object.freeze({ identifier: 'hidden', identity: 'hidden', computed: 'hidden', time: 'hidden' }),
  // release-2: Q-R — the socket's profile dbAdd matches a soft-deleted profile and revives it.
  matched: Object.freeze({ identifier: 'revive', identity: 'revive', computed: 'revive', time: 'revive' })
});
const DELETED_REASON = 'deleted';
const DELETED_READ_CHUNK = 500;
const DELETED_RECORD_MESSAGE = 'record is deleted';

class DeletedRecordError extends Error {
  constructor ( ) {
    super(DELETED_RECORD_MESSAGE);
    this.name = 'DeletedRecordError';
    this.status = 410;
  }
}

function isDeletedRecord (err) {
  return Boolean(err) && err.name === 'DeletedRecordError';
}

// A write item on-deleted answered without a write (acknowledged, or an edit
// not applied): a route sends no event for it.
function isNotWritten (written) {
  return Boolean(written) && written.reason === DELETED_REASON;
}

// The action a path's rule names for a key kind; 'by-collection' is the
// collection's entry in V3_COMPUTED_IDENTIFIER.
function deletedAction (rule, kind, name) {
  const entry = ON_DELETED[rule && rule.deleted];
  if (!entry) throw new TypeError('Unknown on-deleted rule: ' + (rule && rule.deleted));
  let action = entry[kind];
  if (action === 'by-collection') action = V3_COMPUTED_IDENTIFIER[name];
  if (DELETED_ACTIONS.indexOf(action) === -1) throw new TypeError('Unknown on-deleted key: ' + kind + ' (' + name + ')');
  return action;
}

// A condition that names one value: a plain value or { $eq }.
function isEquality (cond) {
  if (cond === undefined) return false;
  if (cond === null || typeof cond !== 'object' || cond instanceof ObjectId || cond instanceof Date) return true;
  return Object.prototype.hasOwnProperty.call(cond, '$eq');
}

// The kind of key a match filter is (above): identifier, identity or time.
function keyKind (filter) {
  if (!filter || typeof filter !== 'object') return 'time';
  const kinds = [ ];
  if (Array.isArray(filter.$or)) kinds.push.apply(kinds, filter.$or.map(keyKind));
  if (Array.isArray(filter.$and)) kinds.push.apply(kinds, filter.$and.map(keyKind));
  if (isEquality(filter.identifier)) kinds.push('identifier');
  if (IDENTITY_FIELDS.some(function (field) { return isEquality(filter[field]); })) kinds.push('identity');
  if (kinds.indexOf('identifier') > -1) return 'identifier';
  if (kinds.indexOf('identity') > -1) return 'identity';
  return 'time';
}

// ---------------------------------------------------------------------------
// Merge on match (ID-FIRST-MATCH slice 4, ID-Q8: one rule). A re-send (a
// create) that matches a stored record is merged into it as a JSON Merge Patch
// (RFC 7386, lib/server/merge-patch.js): a member it sends replaces the stored
// one, an object merges member by member, an array is a value, a null removes
// the member, and a member it leaves out is kept. Only PUT and save replace
// (`onMatch: 'replaced'` on update rules). The rule's `onMatch` says which: a
// create rule with `onMatch: 'merged'` writes the merge, one with 'replaced'
// the whole document, as before this slice.
//
// MERGES names how a rule merges (a rule's `merge`, 'rfc7386' when it names
// none): which top-level members are taken whole as sent instead of merged.
const MERGES = Object.freeze({
  rfc7386: Object.freeze({ whole: Object.freeze([ ]) }),
  // ID-Q7: a matched profile re-send replaces `store` as a whole (a profile
  // left out of it is gone), and its other fields merge.
  'rfc7386-store-whole': Object.freeze({ whole: Object.freeze(['store']) })
});

function mergeRule (rule) {
  const merge = MERGES[(rule && rule.merge) || 'rfc7386'];
  if (!merge) throw new TypeError('Unknown merge rule: ' + rule.merge);
  return merge;
}

// The update that merges `doc` into the stored record: { set, unset, changed }
// (merge-patch update()). `_id` is never written. A stored record that is
// soft-deleted is reached here only where the path's rule still revives it
// (on-deleted 'revive': the socket's profile, Q-R; API v3's computed
// identifier on treatments revives too, but treatments replace); the merge brings it back as the replace did, by
// removing `isValid` unless the re-send sends one.
function mergeParts (rule, stored, doc, skip) {
  const parts = mergePatch.update(stored, doc, { skip: ['_id'].concat(skip || [ ]), whole: mergeRule(rule).whole });
  if (softDeleted.isDeleted(stored) && !Object.prototype.hasOwnProperty.call(doc, 'isValid')) {
    parts.unset.isValid = '';
    parts.changed = true;
  }
  return parts;
}

// The record as the merge leaves it, from a copy of the stored one.
function mergedRecord (stored, parts) {
  return mergePatch.assignInto(Object.assign({ }, stored), parts);
}

function storedIdKey (id) {
  return (typeof id === 'string' ? 's:' : 'o:') + String(id);
}

// Merge on match over writes by target (v1 / in-process food and activity;
// treatments go through it with onMatch 'replaced' and get no merge). `found[i]` is the record item i's target names now, as the
// server-date read answered it (_id, srvCreated, identifier and the target's
// fields), or null. Answers, per item, the merge update, or null where nothing
// matched (that document is stored as sent). The stored record is read whole
// (one read per write) only for the items whose merge needs it: a re-send
// with a null or object member (RFC 7386), or one whose key the rule still
// revives on (the merge must see `isValid`).
async function mergesOnMatch (storage, rule, docs, found, kinds) {
  const merges = docs.map(function ( ) { return null; });
  if (rule.onMatch !== 'merged' || !found) return merges;
  const whole = [ ];
  docs.forEach(function (doc, index) {
    if (!found[index]) return;
    const kind = kinds ? kinds[index] : undefined;
    const revives = rule.deleted === undefined || (kind !== undefined && deletedAction(rule, kind) === 'revive');
    if (revives || mergePatch.differsFromSet(doc)) whole.push(found[index]._id);
  });
  const byId = new Map();
  if (whole.length > 0) {
    (await reads.findAll(storage, { _id: { $in: whole } })).forEach(function (stored) {
      byId.set(storedIdKey(stored._id), stored);
    });
  }
  docs.forEach(function (doc, index) {
    if (!found[index]) return;
    merges[index] = mergeParts(rule, byId.get(storedIdKey(found[index]._id)) || found[index], doc);
  });
  return merges;
}

// One storage operation of a v1 bulk write: the document stored as sent (an
// upserting replace), or, where it matched, the merge (an upserting update;
// should the record be gone by the time it is written, the update inserts the
// document's fields, as the replace would have).
function bulkOp (filter, doc, merge) {
  if (!merge) return { filter: filter, doc: doc };
  const op = { filter: filter, doc: merge.set, merge: true };
  if (Object.keys(merge.unset).length > 0) op.unset = merge.unset;
  if (doc._id !== undefined) op.setOnInsert = { _id: doc._id };
  return op;
}

// An edit of a deleted record: not applied. `ignore` answers it as an
// unchanged write naming the stored record; `refuse` throws, before anything
// is written.
function deletedEdit (env, index, stored, identifier) {
  if (writeSettings.deletedEditMode(env) === 'refuse') throw new DeletedRecordError();
  return item(index, 'unchanged', stored._id, identifier === undefined ? stored.identifier : identifier, DELETED_REASON);
}

// on-deleted's read: for each filter given (the others are undefined), the
// soft-deleted record the write by that filter reaches. One read per 500
// filters (the chunk srv-dates carryForReplace reads by), which asks for
// deleted records only (`isValid: false`), so a write that reaches none costs
// that read alone. When one comes back, each filter it
// may answer is read as the write reads it (the first record the filter names),
// and only a deleted first record counts: a live record the filter reaches
// first is written, as before.
async function deletedReached (storage, filters) {
  const asked = [ ];
  filters.forEach(function (filter, index) { if (filter) asked.push(index); });
  const reached = new Map();
  if (asked.length === 0) return reached;
  let found = [ ];
  for (let start = 0; start < asked.length; start += DELETED_READ_CHUNK) {
    const chunk = asked.slice(start, start + DELETED_READ_CHUNK);
    found = found.concat((await reads.findAll(storage
      , { $and: [anyOf(chunk.map(function (index) { return filters[index]; })), { isValid: false }] }))
      .filter(softDeleted.isDeleted));
  }
  if (found.length === 0) return reached;
  for (const index of asked) {
    const maybe = found.some(function (doc) { return srvDates.matches(doc, filters[index]) !== false; });
    if (!maybe) continue;
    const first = await reads.findOne(storage, filters[index]);
    if (softDeleted.isDeleted(first)) reached.set(index, first);
  }
  return reached;
}

// The clauses for the records an identifier names: `{ identifier: condition }`
// first, then the path's `also`.
function identifierMatch (condition, also, env) {
  const alsoOf = IDENTIFIER_ALSO[also];
  if (!alsoOf) throw new TypeError('Unknown identifier-match rule: ' + also);
  return [{ identifier: condition }].concat(alsoOf(condition, env));
}

// One clause as it is, several as $or: the spelling v1 treatments, entries
// and device status have always sent.
function anyOf (clauses) {
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

// A path's identifier rule, refused unless it names a pick the path's code
// applies (`pick`, or one of several), so the table cannot name a pick the
// write does not make.
function identifierRule (rule, key, pick) {
  const spec = rule && rule.identifier;
  const named = spec && spec[key === 'reply' ? 'replyPick' : 'pick'];
  const applied = [ ].concat(pick);
  if (!spec || IDENTIFIER_PICKS.indexOf(named) === -1 || applied.indexOf(named) === -1) {
    throw new TypeError('No identifier-match rule with pick ' + applied.join(' or ') + (key === 'reply' ? ' for the reply' : ''));
  }
  return { also: key === 'reply' ? spec.replyAlso : spec.also, pick: named };
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
  // The socket (socketIdMatch): an ObjectId or 24-hex id matches each of its
  // stored forms, with deleteMany; any other id is one plain equality, with
  // deleteOne.
  'id-match': function idMatch (id) {
    const match = socketIdMatch(id);
    return { filter: match.filter, opts: { one: !match.many, v1: true } };
  }
});

// The socket's rules for one collection's dbRemove: by _id (socketIdMatch);
// with no _id, by identifier, every record identifier-match finds (decision 4,
// ID-Q10).
const SOCKET_DELETE = Object.freeze({ target: 'id-match', identifier: Object.freeze({ also: 'none', pick: 'every' }) });

// The socket's dbAdd of a collection with no matching of its own: one
// insertOne of the document as given (the interface's normalize: false), no
// target, server dates when API v3 serves the collection. A document whose
// _id is already stored is not written: the duplicate-key error is the
// outcome `refused`, which the socket answers with an empty reply, as it did.
// release-2: Q-E — a socket re-send of a stored _id is `refused` (empty reply); v1 replaces, v3 answers 400.
// release-2: Q5 (a) — activity's socket insert has no server dates (dates: 'none'); kept until release 2.
// ID-FIRST-MATCH slice 6 (design note 2026-10-29 §1.2, §3): identifier first
// where it is new. `identifier` on these create rules is identifier-match
// (`also: 'none'`, the identifier alone) with the P4 pick (ID-Q5): a write
// that carries a valid identifier lands on the stored record it names, before
// the path's other keys, and never creates a second record with it. A live
// match merges (RFC 7386; ID-Q2, ID-Q8, ID-Q7); a deleted one is acknowledged
// and stays deleted (ID-Q4, the rule's `deleted`). The red control for slice 6
// is this one value set to undefined: every entry below that names it then
// matches as before the slice.
const IDENTIFIER_FIRST = Object.freeze({ also: 'none', pick: 'p4' });
// Slice 6a: activity (decision 4, moved to 6a on 2026-10-30), its own value
// so the slice reverts and red-controls on its own: the socket dbAdd and the
// v1 / in-process create match a stored identifier first, as food's do
// (merged, no server dates; a deleted record acknowledged; P4 by created_at).
const ACTIVITY_IDENTIFIER_FIRST = Object.freeze({ also: 'none', pick: 'p4' });

// An identifier-first rule with path-specific additions; undefined when the
// slice's value is off.
function identifierFirstRule (first, extra) {
  return first ? Object.freeze(Object.assign({ }, first, extra)) : undefined;
}

// The record identifier-first lands on for one document: of the records
// identifier-match names (soft-deleted ones included), newest _id first, the
// P4 pick by the collection's time keys. Null when the rule has no identifier
// entry, the document carries no valid identifier, or nothing is stored.
async function identifierFirstMatch (storage, doc, rule, name, label) {
  if (!rule.identifier || !doc || !isValidIdentifier(doc.identifier)) return null;
  const match = identifierRule(rule, 'match', 'p4');
  const stored = await reads.findAll(storage, anyOf(identifierMatch({ $eq: doc.identifier }, match.also))
    , { sort: { _id: -1 } });
  return p4Pick(stored, doc, P4_TIME_KEYS[name] || [ ], label);
}

// The same over a batch, in one read: per document index, the record P4
// picks, for the documents that carry a valid identifier stored.
async function identifierFirstMatches (storage, docs, rule, name, label) {
  const picked = new Map();
  if (!rule.identifier) return picked;
  const match = identifierRule(rule, 'match', 'p4');
  const values = [ ];
  docs.forEach(function (doc) {
    if (doc && isValidIdentifier(doc.identifier) && values.indexOf(doc.identifier) === -1) values.push(doc.identifier);
  });
  if (values.length === 0) return picked;
  const stored = await reads.findAll(storage, anyOf(identifierMatch({ $in: values }, match.also)), { sort: { _id: -1 } });
  docs.forEach(function (doc, index) {
    if (!doc || !isValidIdentifier(doc.identifier)) return;
    const one = p4Pick(namedBy(stored, doc.identifier, match.also), doc, P4_TIME_KEYS[name] || [ ], label);
    if (one) picked.set(index, one);
  });
  return picked;
}

// The record and the write share a time key (P4_TIME_KEYS).
function sameTimeKey (name, stored, doc) {
  return (P4_TIME_KEYS[name] || [ ]).some(function (key) { return sameTime(doc[key], stored[key]); });
}

// `first`: the slice's identifier-first value (slice 6 or 6a). With it, a
// dbAdd carrying a stored identifier is matched (insertOneDocument).
function socketInsert (dates, first) {
  const rule = { id: 'stored-string-or-objectid', target: 'none', write: 'insert-one', dates: dates
    , onDuplicate: 'refused' };
  const identifier = identifierFirstRule(first);
  if (identifier) Object.assign(rule, { identifier: identifier, onMatch: 'merged', deleted: 'stays-deleted' });
  return Object.freeze(rule);
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
  // Of several records the identifier names, the rule's pick: 'driver-first'
  // writes by this filter; 'p4' narrows it to one _id when the write runs
  // (pickTreatmentTargets).
  'treatment-key': function treatmentKey (doc, env, time, rule) {
    if (doc.identifier) {
      var identifierValue = doc.identifier;
      delete doc._id;
      return anyOf(identifierMatch(literal(identifierValue), identifierRule(rule, 'target', ['driver-first', 'p4']).also, env));
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
  // The socket's dbAdd preflight of one treatment (it was websocket.js dbAdd),
  // run as each document of a request is prepared, before anything is
  // written: WRITE_VALIDATION on the document as sent (enforce logs, and in
  // reject mode throws the refusal); then, on a document it does not refuse,
  // the BF-194 step (a Temporary Target stored in mg/dL), so a later reply
  // slot shows the record as it is stored. Any other error is thrown, as it
  // was.
  // release-2: Q-F — the socket's above-interface check lives here; its below-interface half (write-step.js
  // validateSocket, skipped for a validated dbAdd, and the conditional update) stays below the interface.
  'treatment-domain-socket': function treatmentDomainSocket (items, env) {
    var refused = [];
    items.forEach(function (document, index) {
      try {
        writeValidation.enforce(env, 'socket', document);
      } catch (err) {
        if (!writeValidation.isValidationError(err)) throw err;
        refused.push({ index: index, problems: err.problems });
        return;
      }
      // A Temporary Target is stored in mg/dL (BF-194), after validation.
      targetUnits.normalizeTargetUnits(document);
    });
    return refused;
  },
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

// identifier-match on v1 / in-process treatments (treatment-key): the
// identifier, under UUID_HANDLING also a record stored with it as its _id; of
// several, the one P4 picks by created_at (ID-Q5; it was the one the upserting
// write reaches), which the reply names; a write with an identifier never
// falls back to the fallback key. A batch's reply reads the other stored _ids
// by identifier alone, the last read taking it.
const TREATMENT_IDENTIFIER = Object.freeze({ also: 'uuid-id', pick: 'p4', replyAlso: 'none', replyPick: 'last-read' });

// release-2: Q-B — a single treatment removes its string twin in a call of its own, a batch inside the bulk write.
// on-deleted (slice 3, ID-Q4): a re-send that reaches a deleted treatment by its
// identifier, _id or client identity is acknowledged and the treatment stays
// deleted; one that reaches it by the fallback key alone stores a new record.
// merge on match (slice 4) does not apply to treatments: a re-send that matches
// a stored treatment is `replaced` by it (srvModified advances), as before
// (decided 2026-10-30). Loop ends an override by re-sending it whole without
// durationType, which only a replace removes (REQ-SYNC-072).
const TREATMENT_ONE = Object.freeze({ id: 'treatment-uuid', prepare: 'treatment', target: 'treatment-key'
  , keyTime: 'prepared', write: 'replace-one', twins: 'remove-string-forms-after', dates: 'carry'
  , onMatch: 'replaced', reply: 'stored-id', identifier: TREATMENT_IDENTIFIER, deleted: 'stays-deleted' });

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
    // Q-E settled for this path (2026-10-30): a matched treatment is `replaced` (srvModified advances), as
    // TREATMENT_ONE says.
    batch: Object.freeze({ id: 'treatment-uuid', prepare: 'treatment', target: 'treatment-key'
      , keyTime: 'prepared', write: 'bulk', twins: 'remove-string-forms-each', dates: 'carry'
      , onMatch: 'replaced', reply: 'stored-ids-batch', identifier: TREATMENT_IDENTIFIER, deleted: 'stays-deleted' }),
    one: TREATMENT_ONE,
    // release-2: Q-H — the preBolus record is a create that replaces by created_at + eventType.
    prebolus: Object.freeze({ id: 'none', prepare: 'none', target: 'time-and-type', keyTime: 'doc'
      , write: 'replace-one', twins: 'none', dates: 'carry', onMatch: 'replaced', reply: 'upserted-id' })
  }) }),
  // save (v1 PUT, in-process): one document, as a create's single form, its
  // fallback key timed by the document's own created_at. An edit of a deleted
  // treatment is not applied (ID-Q3, WRITE_DELETED_EDIT).
  update: Object.freeze(Object.assign({ }, TREATMENT_ONE, { keyTime: 'doc', onMatch: 'replaced', deleted: 'stays-deleted-edit' })),
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

// The stored entries an identifier names (identifier-match, the rule's
// `also`: under UUID_HANDLING also an entry stored with the value as its _id,
// 15.0.6 and earlier, as for v1 treatments).
function entryIdentifierQuery (condition, env, rule, key, pick) {
  return anyOf(identifierMatch(condition, identifierRule(rule, key, pick).also, env));
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
function planEntries (rule, docs, env, scope) {
  const insertOnly = new Set();
  const kinds = [ ];
  const ops = docs.map(function plan (doc) {
    entryIdForm(doc, env);
    identifiersAbsent([doc], scope);

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
    // The kind of key (on-deleted): sysTime + type is a time key; a sent _id
    // an identity; a generated _id reaches nothing.
    kinds.push(rule.deleted === undefined || insertOnly.has(doc) ? undefined : keyKind(query));

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
    // stores it again, where on-deleted lets the write reach it ('revive').
    if (!Object.prototype.hasOwnProperty.call(doc, 'isValid')) {
      update.$unset = { isValid: '' };
    }
    return { updateOne: { filter: query, update: update, upsert: true } };
  });
  return { planned: true, rule: rule, docs: docs, ops: ops, insertOnly: insertOnly, env: env
    , source: scope && scope.source, picked: new Map(), kinds: kinds, skipped: new Map() };
}

// ID-SIMPLE-MATCH: an entry that carries an identifier already stored, or
// one an earlier entry in this batch carries, updates that entry instead of
// matching by sysTime + type. One read per batch, only for a batch that
// carries identifiers. When the identifier names more than one stored entry,
// the rule's pick 'p4' (ID-Q5) narrows the update to the one P4 picks, by its
// _id, and the reply names it (plan.picked); 'driver-first' updates by the
// identifier, reaching the one MongoDB finds first.
async function matchStoredEntryIdentifiers (storageOf, plan) {
  const docs = plan.docs;
  const ops = plan.ops;
  const env = plan.env;
  var identifiers = [];
  docs.forEach(function (doc) {
    if (hasEntryIdentifier(doc) && identifiers.indexOf(doc.identifier) === -1) identifiers.push(doc.identifier);
  });
  if (identifiers.length === 0) return;

  const p4 = plan.rule.identifier.pick === 'p4';
  const timeKeys = P4_TIME_KEYS.entries;
  const projection = { _id: 1, identifier: 1 };
  if (p4) timeKeys.forEach(function (key) { projection[key] = 1; });
  var stored = await reads.findAll(storageOf()
    , entryIdentifierQuery({ $in: identifiers }, env, plan.rule, 'target', ['driver-first', 'p4'])
    , p4 ? { projection: projection, sort: { _id: -1 } } : { projection: projection });
  var known = {};
  stored.forEach(function (entry) {
    if (typeof entry.identifier === 'string') known[entry.identifier] = true;
    if (env.uuidHandling && typeof entry._id === 'string') known[entry._id] = true;
  });

  docs.forEach(function (doc, index) {
    if (!hasEntryIdentifier(doc)) return;
    if (Object.prototype.hasOwnProperty.call(known, doc.identifier)) {
      const named = p4 ? namedBy(stored, doc.identifier, plan.rule.identifier.also, env) : [ ];
      if (named.length > 1) {
        const picked = p4Pick(named, doc, timeKeys, 'entries ' + plan.source + ' re-send');
        ops[index].updateOne.filter = { _id: { $eq: picked._id } };
        plan.picked.set(index, picked._id);
      } else {
        ops[index].updateOne.filter = entryIdentifierQuery({ $eq: doc.identifier }, env, plan.rule, 'target', ['driver-first', 'p4']);
      }
      plan.insertOnly.delete(doc);
      if (plan.rule.deleted !== undefined) plan.kinds[index] = 'identifier';
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
    if (!plan.insertOnly.has(doc) && !plan.skipped.has(index) && mergePatch.differsFromSet(doc)) candidates.push(index);
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
  var stored = await reads.findAll(storageOf(), { $or: ops.filter(function (op, index) { return !plan.skipped.has(index); })
    .map(function (op) { return op.updateOne.filter; }) });
  stored.forEach(function (entry) { register({ doc: entry }); });

  var candidate = new Set(candidates);
  ops.forEach(function (op, index) {
    if (plan.skipped.has(index)) return;
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
    if (plan.skipped.has(index)) return;
    if (Object.prototype.hasOwnProperty.call(upsertedIds, index)) return;
    if (plan.picked.has(index)) {
      docs[index]._id = plan.picked.get(index);
    } else if (filter.sysTime && filter.type) {
      matched.push(index);
    } else if (filter.identifier || filter.$or) {
      byIdentifier.push(index);
    }
  });

  if (byIdentifier.length > 0) {
    var identified = await reads.findAll(storageOf()
      , entryIdentifierQuery({ $in: byIdentifier.map(function (index) { return docs[index].identifier; }) }, env
        , plan.rule, 'reply', 'last-read')
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
  await entriesOnDeleted(storageOf(), plan);
  await mergeMatchedEntries(storageOf, plan);
  // The operations written, and for each the document's index.
  const written = [ ];
  const ops = [ ];
  plan.ops.forEach(function toInterface (op, index) {
    if (plan.skipped.has(index)) return;
    const changes = op.updateOne.update;
    if (Object.keys(changes).some(key => ['$set', '$setOnInsert', '$unset'].indexOf(key) === -1)) {
      throw new TypeError('Unsupported bulk update for the storage interface');
    }
    written.push(index);
    ops.push({ filter: reads.toFilter(op.updateOne.filter), doc: changes.$set
      , setOnInsert: changes.$setOnInsert, unset: changes.$unset });
  });
  // Past a taken _id (BF-220): the operations' indexes are mapped back to the
  // batch's through `written`, since an entry skipped above has no operation.
  const bulk = ops.length === 0 ? null : await bulkPastTakenIds(storageOf, ops, written);
  const reply = bulk && bulk.reply;
  const refused = new Set();
  if (bulk) bulk.refused.forEach(function (at) { refused.add(written[at]); });

  const docs = plan.docs;
  const upserted = { };
  Object.keys((reply && reply.upsertedIds) || {}).forEach(function (at) {
    const index = written[at];
    upserted[index] = reply.upsertedIds[at];
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
    if (plan.skipped.has(index)) return plan.skipped.get(index);
    if (refused.has(index)) return item(index, 'refused', null, doc.identifier, 'duplicate _id');
    return item(index, Object.prototype.hasOwnProperty.call(upserted, index) ? 'inserted' : plan.rule.onMatch
      , doc._id, doc.identifier);
  }), adapter: reply, readBackError: readBackError };
}

// on-deleted over an entries batch, once each target is resolved (identifier,
// else sysTime + type): an entry whose target reaches a deleted entry by its
// identifier (or a sent _id) is not written and is answered with the stored
// _id (acknowledged, ID-Q4); one that reaches it by sysTime + type alone is
// matched against live entries only, so it is stored beside the deleted one
// (it was revived on purpose, by the $unset of isValid, before slice 3).
async function entriesOnDeleted (storage, plan) {
  if (plan.rule.deleted === undefined) return;
  const actions = plan.kinds.map(function (kind) { return kind === undefined ? undefined : deletedAction(plan.rule, kind); });
  const reached = await deletedReached(storage, plan.ops.map(function (op, index) {
    return actions[index] === undefined || actions[index] === 'revive' ? undefined : op.updateOne.filter;
  }));
  reached.forEach(function (stored, index) {
    if (actions[index] === 'hidden') {
      plan.ops[index].updateOne.filter = softDeleted.visible(plan.ops[index].updateOne.filter);
      return;
    }
    plan.docs[index]._id = stored._id;
    plan.skipped.set(index, item(index, 'unchanged', stored._id, stored.identifier, DELETED_REASON));
  });
}

// The entries batch's ordered bulk write, continued past an entry whose _id
// is taken (BF-220, ID-BATCH (v)). An entry sent with an _id that another
// stored entry holds, or that an earlier entry of the batch took, cannot be
// inserted: MongoDB refuses it with a duplicate key on _id, and an ordered
// write stops there. That entry is refused and the write resumes, still in
// order, with the entry after it; any other error stops the batch as before.
// Resolves to { reply: the adapter's reply with upsertedIds by operation index
// and the counts summed, refused: Set of operation indexes }. `batchIndexes`
// (optional) gives each operation's index in the batch, for the log line: an
// entry acknowledged without a write (on-deleted) has no operation.
async function bulkPastTakenIds (storageOf, ops, batchIndexes) {
  const reply = { upsertedIds: {}, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  const refused = new Set();
  function keep (part, offset) {
    if (!part) return;
    Object.keys(part.upsertedIds || {}).forEach(function (index) {
      reply.upsertedIds[Number(index) + offset] = part.upsertedIds[index];
    });
    ['matchedCount', 'modifiedCount', 'upsertedCount'].forEach(function (count) {
      reply[count] += part[count] || 0;
    });
  }
  let start = 0;
  while (start < ops.length) {
    const part = start === 0 ? ops : ops.slice(start);
    try {
      keep(await storageOf().bulkUpsert(part, { mode: 'merge', ordered: true, v1: true }), start);
      break;
    } catch (err) {
      const at = takenIdAt(err);
      if (at < 0) throw err;
      keep(err.result, start);
      console.warn('API v1 refused entry ' + (batchIndexes ? batchIndexes[start + at] : start + at) + ' of the batch: its _id is in use by another record (409)');
      refused.add(start + at);
      start += at + 1;
    }
  }
  return { reply: reply, refused: refused };
}

// The index of the operation an ordered bulk write stopped at with a
// duplicate key on _id, or -1 for any other error.
function takenIdAt (err) {
  const writeErrors = [].concat((err && err.writeErrors) || []);
  if (writeErrors.length !== 1) return -1;
  const writeError = writeErrors[0];
  if (writeError.code !== 11000) return -1;
  if (!/ index: _id_ /.test(String(writeError.errmsg || ''))) return -1;
  return typeof writeError.index === 'number' ? writeError.index : -1;
}

const ENTRIES_V1 = Object.freeze({
  // Every write is an upserting update in one ordered bulk write: target
  // identifier (when stored) else sysTime + type; a match is merged.
  // Q-E settled for this path by ID-Q8 (slice 4): a matched entry is `merged`, by the one RFC 7386 rule
  // (lib/server/merge-patch.js: $set, plus the Merge Patch for nulls and objects).
  // release-2: Q-K — the synchronous rules run in plan(), at the moment entries.js ran them.
  // identifier-match: the identifier (when stored), under UUID_HANDLING also an
  // entry stored with it as its _id; of several, the one P4 picks by sysTime or
  // date (ID-Q5; it was the one the update reaches), which the reply names.
  // The reply reads the other matched records, an identifier over an _id, the
  // last read taking it.
  // on-deleted (slice 3, ID-Q4): an entry re-sent with the identifier of a
  // deleted entry is acknowledged and stays deleted; one that matches a
  // deleted entry by sysTime + type alone is stored as a new entry.
  create: Object.freeze({ plan: 'entries', write: 'entries-merge-bulk', onMatch: 'merged'
    , identifier: Object.freeze({ also: 'uuid-id', pick: 'p4', replyAlso: 'uuid-id', replyPick: 'last-read' })
    , deleted: 'stays-deleted' }),
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
// whose identifier is stored is answered with the stored _id and not written;
// a repeat within the batch takes the first's _id once it is stored. Of
// several stored statuses with the identifier, the reply names the one the
// rule's pick names: 'p4' (ID-Q5) by created_at, else the newest;
// 'first-by-id' the first by _id. One read, only for a batch that carries
// identifiers.
async function withoutStoredStatusIdentifiers (storageOf, statuses, rule, scope) {
  var identifiers = [];
  statuses.forEach(function (obj) {
    if (hasStatusIdentifier(obj) && identifiers.indexOf(obj.identifier) === -1) identifiers.push(obj.identifier);
  });
  if (identifiers.length === 0) return { insert: statuses, repeats: [], known: [], identified: [] };

  var match = identifierRule(rule, 'target', ['first-by-id', 'p4']);
  var p4 = match.pick === 'p4';
  var projection = { _id: 1, identifier: 1 };
  if (p4) P4_TIME_KEYS.devicestatus.forEach(function (key) { projection[key] = 1; });
  var stored = await reads.findAll(storageOf(), anyOf(identifierMatch({ $in: identifiers }, match.also))
    , { projection: projection, sort: { _id: p4 ? -1 : 1 } });
  var storedAs = {};
  stored.forEach(function (doc) {
    if (!Object.prototype.hasOwnProperty.call(storedAs, doc.identifier)) storedAs[doc.identifier] = doc._id;
  });
  function storedIdFor (obj) {
    if (!p4) return storedAs[obj.identifier];
    return p4Pick(namedBy(stored, obj.identifier, match.also), obj, P4_TIME_KEYS.devicestatus
      , 'devicestatus ' + ((scope && scope.source) || 'v1/internal') + ' re-send')._id;
  }

  var firstInBatch = {};
  var insert = [];
  var repeats = [];
  var known = [];
  var identified = [];
  statuses.forEach(function (obj) {
    if (!hasStatusIdentifier(obj)) {
      insert.push(obj);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(storedAs, obj.identifier)) {
      obj._id = storedIdFor(obj);
      known.push(obj);
      identified.push(obj);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(firstInBatch, obj.identifier)) {
      repeats.push({ status: obj, first: firstInBatch[obj.identifier] });
      return;
    }
    firstInBatch[obj.identifier] = obj;
    insert.push(obj);
  });
  return { insert: insert, repeats: repeats, known: known, identified: identified };
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
async function writeStatuses (storageOf, statuses, rule, scope) {
  identifiersAbsent(statuses, scope);
  var toInsert;
  var repeats;
  var known = [];
  var identified;
  try {
    var split = await withoutStoredStatusIdentifiers(storageOf, statuses, rule, scope);
    repeats = split.repeats;
    known = split.known;
    identified = split.identified;
    toInsert = await withoutStoredStatusIds(storageOf, split.insert, known);
  } catch (err) {
    throw new WriteRuleError('status-match', err);
  }
  // merge on match (ID-Q2): a status whose identifier is stored is merged into
  // the stored status, which it names; a status that is soft-deleted stays as
  // it is and is answered as already stored.
  var merged = rule.onMatch === 'merged' ? await mergeStatuses(storageOf, identified, rule) : [];

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
    if (merged.some(function (m) { return m.status === obj; })) return item(index, 'merged', obj._id, obj.identifier);
    if (known.indexOf(obj) !== -1 || raced.indexOf(obj) !== -1) {
      return item(index, 'refused', obj._id, obj.identifier, 'already stored');
    }
    return item(index, 'refused', obj._id, obj.identifier, 'repeated in the batch');
  });
  return { items: items, adapter: insertResult, inserted: toInsert
    , merged: merged.map(function (m) { return m.record; }) };
}

// The identifier re-sends of a devicestatus batch, merged in order into the
// stored statuses they name (one read of those statuses, one update each):
// RFC 7386, srvCreated kept, srvModified new. Answers [{ status, record }],
// record the stored status as merged, for the module to announce.
async function mergeStatuses (storageOf, identified, rule) {
  if (identified.length === 0) return [];
  var current = new Map();
  try {
    (await reads.findAll(storageOf(), { _id: { $in: identified.map(function (obj) { return obj._id; }) } }))
      .forEach(function (stored) { current.set(storedIdKey(stored._id), stored); });
  } catch (err) {
    throw new WriteRuleError('status-match', err);
  }
  var merged = [];
  for (const obj of identified) {
    var stored = current.get(storedIdKey(obj._id));
    if (!stored || softDeleted.isDeleted(stored)) continue;
    var parts = mergeParts(rule, stored, obj, ['srvCreated', 'srvModified']);
    srvDates.stampModified(parts.set);
    await storageOf().updateMany(reads.toFilter({ _id: stored._id }), { set: parts.set
      , unset: Object.keys(parts.unset).length > 0 ? parts.unset : undefined }, { one: true, v1: true });
    var record = mergedRecord(stored, parts);
    current.set(storedIdKey(stored._id), record);
    merged.push({ status: obj, record: record });
  }
  return merged;
}

const DEVICESTATUS_V1 = Object.freeze({
  // release-2: Q-L — no natural key on v1: a status with a stored one's created_at and device is a second record.
  // release-2: Q-J — a re-send by a stored _id is not written and is answered `refused` ('already stored').
  // release-2: Q-O — devicestatus inserts unordered, profile ordered; each kept.
  // identifier-match: the identifier alone; of several, the one P4 picks by
  // created_at (ID-Q5; it was the first by _id), whose _id the reply names.
  // merge on match (slice 4, ID-Q2): a status whose identifier is stored is
  // `merged` into it (it was answered `refused`, 'already stored', and not
  // written); a soft-deleted one is still not written.
  create: Object.freeze({ write: 'statuses', dates: 'stamp-created', onMatch: 'merged'
    , identifier: Object.freeze({ also: 'none', pick: 'p4' }) }),
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
// and the server's dates, as a JSON Merge Patch, with the rule's merge (ID-Q7:
// `store` whole). Null when nothing changes.
function changedProfileFields (rule, doc, stored) {
  var parts = mergeParts(rule, stored, doc, ['srvCreated', 'srvModified']);
  return parts.changed ? parts : null;
}

async function mergeProfileInto (storageOf, rule, stored, doc) {
  doc._id = stored._id;
  var parts = changedProfileFields(rule, doc, stored);
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
async function writeProfiles (storageOf, docs, rule, intent, scope) {
  identifiersAbsent(docs, scope);
  // identifier first (slice 6), before the _id: the stored profile P4 picks
  // (startDate, else the newest). At another startDate (decisions, slice 6
  // profile-copy rule, maintainer 2026-10-30) the document is a new profile
  // and the copied identifier is dropped, with a warning naming no value.
  const named = await identifierFirstMatches(storageOf(), docs, rule, scope.name, 'profile ' + scope.source + ' create');
  named.forEach(function (target, index) {
    if (sameTimeKey(scope.name, target, docs[index])) return;
    if (rule.identifier.otherTime !== 'new-record') throw new TypeError('No profile identifier rule ' + rule.identifier.otherTime);
    console.warn(LOG_DEDUP + 'profile ' + scope.source + ' create: the identifier names a profile with another startDate;'
      + ' stored as a new profile without it');
    delete docs[index].identifier;
    named.delete(index);
  });
  const stored = await storedProfilesByKey(storageOf, docs);
  const toInsert = [];
  const resends = [];
  const batchFirst = new Map();
  const changing = new Set();
  const outcomes = new Array(docs.length);
  const acknowledged = new Map();
  docs.forEach(function (doc, index) {
    var key = profileIdKey(doc._id);
    if (named.has(index) || (key && stored.has(key))) {
      var target = named.has(index) ? named.get(index) : stored.get(key);
      // on-deleted (ID-Q4): a re-send by the identifier or _id of a deleted
      // profile is acknowledged and writes nothing; the profile stays deleted.
      if (softDeleted.isDeleted(target) && deletedAction(rule, named.has(index) ? 'identifier' : 'identity') === 'acknowledged') {
        doc._id = target._id;
        acknowledged.set(index, item(index, 'unchanged', target._id, target.identifier, DELETED_REASON));
        return;
      }
      if (changedProfileFields(rule, doc, target)) changing.add(index);
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
    outcomes[index] = (await mergeProfileInto(storageOf, rule, target, doc)) ? 'merged' : 'unchanged';
  }
  return { items: docs.map(function outcome (doc, index) {
    if (acknowledged.has(index)) return acknowledged.get(index);
    return item(index, outcomes[index] || 'inserted', doc._id, doc.identifier);
  }), adapter: adapter };
}

const PROFILE_V1 = Object.freeze({
  // release-2: Q-J — an identical re-send writes nothing and is answered `unchanged`.
  // release-2: Q-P — the update permission travels in the intent (canUpdate), checked before any write.
  // on-deleted (slice 3, ID-Q4): a re-send by the _id of a deleted profile is acknowledged.
  // merge on match: a re-send by a stored _id is merged (Q1b), with `store` replaced whole (ID-Q7, slice 4).
  // identifier first (slice 6): at the write's startDate a re-send; at another, a new profile without the
  // identifier (otherTime: 'new-record').
  create: Object.freeze({ write: 'profiles', dates: 'stamp-created', deleted: 'stays-deleted'
    , merge: 'rfc7386-store-whole', identifier: identifierFirstRule(IDENTIFIER_FIRST, { otherTime: 'new-record' }) }),
  // save (v1 PUT, in-process): a hex or ObjectId _id names the profile to
  // replace; anything else gets a new ObjectId. An upserting replace by
  // plain _id, then, for a hex or ObjectId _id, the removal of its string
  // forms in a call of its own. Carried server dates.
  // release-2: Q-B — save removes the string twin in a call of its own, as activity and treatments save do.
  update: Object.freeze({ id: 'hex-or-new', prepare: 'none', target: 'id-plain', keyTime: 'doc'
    , write: 'replace-one', twins: 'remove-string-forms-after', dates: 'carry', onMatch: 'replaced', reply: 'none'
    , identifierHeld: 'refuse', deleted: 'stays-deleted-edit' }),
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
// that collection's cache and it reloads from MongoDB (a `remove` with no
// changes, lib/server/cache.js; all three caches before BF-211). So the step
// keeps v3 on the identifier methods: a second method family beside the
// filter one v1 uses (write-contract Q-A, maintainer 2026-10-29).
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
    const storedId = storedIdOf(intent);
    const matchedCount = storedId === undefined ? await storage.replaceOne(intent.target.identifier, doc)
      : await storage.replaceOne(intent.target.identifier, doc, storedId);
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
    const storedId = storedIdOf(intent);
    const result = storedId === undefined ? await storage.updateOne(intent.target.identifier, parts.set, parts.unset)
      : await storage.updateOne(intent.target.identifier, parts.set, parts.unset, storedId);
    return { items: [item(0, result && result.updated ? 'merged' : 'not-found', null, intent.target.identifier)]
      , adapter: result, patched: mergePatch.assignInto(Object.assign({}, stored), parts) };
  },
  // a POST that matched a stored record (the deduplicating write; slice 4,
  // ID-Q8): what the create rule's onMatch names for the key that matched
  // (v3ResendAction). 'merged': the body, stamped as PUT stamps it (srvCreated
  // carried, srvModified new), merged into the stored record as a JSON Merge
  // Patch (RFC 7386, the rule's merge), one updateOne by identifier; `patched`
  // is the record as it now is, and `adapter` the count updated (the route's
  // matchedCount). 'replaced': the body replaces the record (v3-replace), as
  // every POST did before this slice.
  'v3-resend': async function v3Resend (storage, intent, rule, env, name) {
    const action = v3ResendAction(rule, intent, intent.target.stored);
    const stamped = Object.freeze({ stamps: rule.resendStamps });
    if (action === 'replaced') return V3_WRITES['v3-replace'](storage, intent, stamped, env);
    if (action !== 'merged') throw new TypeError('No API v3 re-send write for ' + action + ' on ' + name);
    const doc = oneV3Doc(intent);
    stampV3(stamped, doc, intent, env);
    const stored = intent.target.stored;
    const parts = mergeParts(rule, stored, doc);
    const storedId = storedIdOf(intent);
    const result = storedId === undefined ? await storage.updateOne(intent.target.identifier, parts.set, parts.unset)
      : await storage.updateOne(intent.target.identifier, parts.set, parts.unset, storedId);
    const updated = result ? result.updated : 0;
    return { items: [item(0, updated ? 'merged' : 'not-found', null, doc.identifier)], adapter: updated
      , patched: mergedRecord(stored, parts) };
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

// identifier-match on API v3: the identifier, and a record with no identifier
// of its own whose _id it is; the first by identifier -1, _id -1, and of
// several records that store the identifier, the one P4 picks (ID-Q5; it was
// the newest).
const V3_IDENTIFIER = Object.freeze({ also: 'shown-id', pick: 'p4' });

// API v3 create's identifying read (it was lib/api3/generic/create/
// operation.js:47-49 at 9919f8ef, moved and not changed): identifier-match
// for the document's identifier, then a record with no identifier whose
// fallback fields all equal the document's (utils.fallbackClause), in one
// findOneFilter of the storage, which takes the first by identifier -1, _id
// -1. Answers the stored record, or null; storage answering nothing is an
// error, as it was.
// Under the pick 'p4' (ID-Q5), when that record stores the document's
// identifier, a second read takes every record that stores it; of more than
// one, the answer is the one P4 picks by the collection's time key, shown as
// API v3 shows a record, and it carries its _id under STORED_ID, so the write
// that follows (v3-replace, v3-merge) lands on it and not on the record
// API v3's own order names.
const STORED_ID = Symbol('write-intent stored _id');

// identifier-match on API v3 PUT and PATCH /{identifier}: the route's
// identifier, and a record with no identifier of its own whose _id it is (the
// read utils.identifyingFilter built for them); the first by identifier -1,
// _id -1, and of several records that store the identifier, the one P4 picks
// (ID-Q5, ID-Q10; it was the newest). A rule of its own, so PUT and PATCH can
// be put back to 'v3-order' apart from create.
const V3_ADDRESS_IDENTIFIER = Object.freeze({ also: 'shown-id', pick: 'p4' });

// P4 among every record that stores `identifier`, read newest _id first:
// the one P4 picks by the collection's time key, shown as API v3 shows a
// record and carrying its _id under STORED_ID; null when fewer than two
// records store it. `label` names the path in the log line.
async function v3P4Pick (storage, identifier, doc, name, label) {
  const named = await reads.findAll(storage, { identifier: { $eq: identifier } }, { sort: { _id: -1 } });
  if (named.length < 2) return null;
  const picked = p4Pick(named, doc, P4_TIME_KEYS[name] || [ ], name + ' ' + label);
  const shown = Object.assign({ }, picked);
  v3Utils.normalizeDoc(shown);
  Object.defineProperty(shown, STORED_ID, { value: picked._id });
  return shown;
}

const V3_MATCHES = Object.freeze({
  'v3-identifying': async function v3Identifying (storage, intent, rule, env, name) {
    const doc = oneV3Doc(intent);
    const match = identifierRule(rule, 'target', ['v3-order', 'p4']);
    const clauses = doc.identifier ? identifierMatch({ $eq: doc.identifier }, match.also, env) : [ ];
    const fallback = v3Utils.fallbackClause(doc, intent.fallbackFields);
    if (fallback) clauses.push(fallback);
    const result = await storage.findOneFilter(clauses.length > 0 ? { $or: clauses } : null, { });
    if (!result) throw new Error('empty result');
    let found = result.length > 0 ? result[0] : null;
    // on-deleted (ID-Q4): a deleted record reached through the fallback
    // fields alone (a time key) is not a match; the read is made again with
    // the fallback clause limited to live records. A deleted record reached
    // by the identifier stays the answer, and the module asks onDeleted().
    if (found && softDeleted.isDeleted(found) && rule.deleted !== undefined
      && deletedAction(rule, v3KeyKind(intent, found), name) === 'hidden') {
      const live = clauses.slice(0, clauses.length - (fallback ? 1 : 0));
      if (fallback) live.push(softDeleted.visible(fallback));
      const again = live.length > 0 ? await storage.findOneFilter({ $or: live }, { }) : [ ];
      if (!again) throw new Error('empty result');
      found = again.length > 0 ? again[0] : null;
    }
    if (match.pick !== 'p4' || !found || !doc.identifier || found.identifier !== doc.identifier) return found;
    return (await v3P4Pick(storage, doc.identifier, doc, name, 'v3 re-send')) || found;
  },
  // API v3 PUT and PATCH /{identifier} (they were lib/api3/generic/update/
  // operation.js and patch/operation.js's own findOneFilter of
  // identifyingFilter(identifier)): the record the route's identifier names,
  // or null. Under 'v3-order' that read, as it was. Under 'p4' the same
  // filter and order read the first two records: only when both store the
  // identifier does a second read take every record that stores it, and P4
  // picks among them by the body's time key (a PATCH that sends none takes
  // the newest), so a single holder costs no read more than before.
  'v3-addressed': async function v3Addressed (storage, intent, rule, env, name) {
    const doc = oneV3Doc(intent);
    const identifier = intent.target && intent.target.identifier;
    const match = identifierRule(rule, 'target', ['v3-order', 'p4']);
    const clauses = identifier ? identifierMatch({ $eq: identifier }, match.also, env) : [ ];
    const filter = clauses.length > 0 ? { $or: clauses } : null;
    if (match.pick !== 'p4') {
      const result = await storage.findOneFilter(filter, { });
      if (!result) throw new Error('empty result');
      return result.length > 0 ? result[0] : null;
    }
    const result = await storage.findOneFilter(filter, { }, { normalize: false, limit: 2 });
    if (!result) throw new Error('empty result');
    const found = result.length > 0 ? result[0] : null;
    if (found && found.identifier === identifier && result.length > 1 && result[1].identifier === identifier) {
      const picked = await v3P4Pick(storage, identifier, doc, name, 'v3 ' + (intent.op === 'patch' ? 'PATCH' : 'PUT'));
      if (picked) return picked;
    }
    if (found) v3Utils.normalizeDoc(found);
    return found;
  }
});

// The key an API v3 create's identifying read reached a record by
// (on-deleted): the identifier the client sent ('identifier'), the one API v3
// computed for a document sent without one ('computed'; the module says which,
// intent.computedIdentifier), the _id a record without an identifier is shown
// under counting as the identifier it was matched by, else the fallback
// fields, a time key.
function v3KeyKind (intent, stored) {
  const doc = oneV3Doc(intent);
  const shown = stored && stored.identifier;
  const sent = doc && doc.identifier;
  if (sent && shown && (shown === sent
    || (idForms.isHexId(shown) && idForms.isHexId(sent) && shown.toLowerCase() === sent.toLowerCase()))) {
    return intent.computedIdentifier === true ? 'computed' : 'identifier';
  }
  return 'time';
}

// What a POST that matched `stored` does (the create rule's onMatch): 'merged'
// (ID-Q8), 'replaced', or 'acknowledged' (nothing written; the route answers
// as for a deleted record). A rule's `onTimeMatch` names it instead for a match
// on the fallback fields alone (a time key): device status keeps the replace
// there, which ID-NATURAL-KEY decides (ID-Q2).
function v3ResendAction (rule, intent, stored) {
  if (rule.onTimeMatch !== undefined && v3KeyKind(intent, stored) === 'time') return rule.onTimeMatch;
  if (['merged', 'replaced', 'acknowledged'].indexOf(rule.onMatch) === -1) {
    throw new TypeError('Unknown API v3 onMatch: ' + rule.onMatch);
  }
  return rule.onMatch;
}

// The _id a v3 write is to land on (STORED_ID), when the identifying read
// named one of several records sharing an identifier; else undefined, and the
// write goes by identifier as before.
function storedIdOf (intent) {
  const stored = intent && intent.target && intent.target.stored;
  return stored ? stored[STORED_ID] : undefined;
}

// The API v3 rules of one collection. `units` names the BF-194 rule:
// treatments store a Temporary Target in mg/dL ('temporary-target-mgdl'),
// every other collection has none. `resend` adds to the create rule's
// re-send entries (onMatch, onTimeMatch, merge).
function v3Rules (units, resend) {
  const tt = units === 'temporary-target-mgdl';
  const updateStamps = Object.freeze(['dates-replaced', 'subject', 'duration'].concat(tt ? ['units'] : [ ]));
  return Object.freeze({
    // match: the identifying read of a POST (V3_MATCHES), before the module
    // chooses insert, the deduplicating replace or the acknowledgement.
    // deleted (slice 3, ID-Q4): a POST whose identifier (as the client sent it)
    // names a deleted record is acknowledged and the record stays deleted (it
    // was replaced, which revived it); the fallback fields never reach a
    // deleted record. One matched by the identifier API v3 computed does what
    // V3_COMPUTED_IDENTIFIER names for the collection.
    // merge on match (slice 4, ID-Q8): a POST that matched a live record is
    // `merged` into it (it was replaced; the immutable-field 400 stays), stamped
    // as PUT stamps (resendStamps). Treatments keep the replace (V3_TREATMENTS).
    create: Object.freeze(Object.assign({ write: 'v3-insert'
      , stamps: Object.freeze((tt ? ['units'] : [ ]).concat(['dates-created', 'subject']))
      , match: 'v3-identifying', identifier: V3_IDENTIFIER, deleted: 'stays-deleted'
      , onMatch: 'merged', resendStamps: updateStamps }, resend)),
    // match on update and patch: the read of PUT and PATCH /{identifier}
    // (V3_MATCHES 'v3-addressed'). A deduplicated POST's update was matched by
    // create's read; its write goes the same way.
    update: Object.freeze({ write: 'v3-replace', stamps: updateStamps
      , match: 'v3-addressed', identifier: V3_ADDRESS_IDENTIFIER }),
    // identifierHeld on patch only: a PUT stores the route's identifier,
    // which is the addressed record's own (or, for a record shown by its _id,
    // that _id), so a PUT never carries another record's identifier.
    patch: Object.freeze({ write: 'v3-merge'
      , stamps: Object.freeze(['dates-modified', 'modified-by', 'duration-patch'].concat(tt ? ['units-patch'] : [ ]))
      , match: 'v3-addressed', identifier: V3_ADDRESS_IDENTIFIER, identifierHeld: 'refuse' }),
    // release-2: Q-S — a v3 delete marks or removes EVERY stored form of the record, a v3 PUT/PATCH writes ONE
    // (modify.js writeFilter); kept as it is.
    delete: Object.freeze({ forms: Object.freeze({
      mark: Object.freeze({ write: 'v3-mark-deleted' }),
      permanent: Object.freeze({ write: 'v3-delete-every-form' })
    }) })
  });
}

// A POST that matched a stored treatment replaces it, as before slice 4, as
// on API v1 (TREATMENT_ONE); a record the rule revives (the computed
// identifier) is brought back by the replace.
const V3_TREATMENTS = v3Rules('temporary-target-mgdl', { onMatch: 'replaced' });
const V3_OTHER = v3Rules('none');
// ID-Q7: a matched profile POST replaces `store` whole.
const V3_PROFILE = v3Rules('none', { merge: 'rfc7386-store-whole' });
// ID-Q2: a status matched by its identifier (sent, or computed by API v3) is
// merged (it was acknowledged, not written, since #8859); one matched by the
// created_at + device fallback alone is replaced, as before, until
// ID-NATURAL-KEY decides it.
const V3_DEVICESTATUS = v3Rules('none', { onTimeMatch: 'replaced' });

// ---------------------------------------------------------------------------
// The socket's dbAdd of treatments, devicestatus and profile, and its dbUpdate
// and dbUpdateUnset of every collection (slice 6; they were
// lib/server/websocket.js's own code at 795a0751, moved and not changed). A
// silently wrong match here is a lost or a duplicated treatment, so every rule
// below is today's, in today's order, and tests/websocket.dedupe-gate.test.js
// pins each one. The reply, the emissions and visibleWriteResult (what a
// caller without read access may see) stay in websocket.js.

const LOG_DEDUP = '\x1B[35m' + 'DEDUPE: ' + '\x1B[0m';

// The stored record a re-sent one is (the exact match, rule 2), per
// collection: a query document, or null when the record names none.
const SOCKET_EXACT = Object.freeze({
  // NSCLIENT_ID; else created_at + eventType, with the client's identity
  // (BF-121; see treatment-fallback-key). Amounts are not added here: a
  // socket re-send after a lost reply may carry an edited amount.
  treatment: function treatment (doc) {
    if (doc.NSCLIENT_ID) {
      return { NSCLIENT_ID: literal(doc.NSCLIENT_ID) };
    }
    return fallbackKey.fallbackQuery(doc, doc.created_at);
  },
  // NSCLIENT_ID, else created_at exactly: a status has no similar match.
  devicestatus: function devicestatus (doc) {
    if (doc.NSCLIENT_ID) {
      return { NSCLIENT_ID: literal(doc.NSCLIENT_ID) };
    }
    return {
      created_at: literal(doc.created_at)
    };
  },
  // NSCLIENT_ID, else startDate; a profile with neither is always new.
  profile: function profile (doc) {
    if (doc.NSCLIENT_ID) {
      return { NSCLIENT_ID: literal(doc.NSCLIENT_ID) };
    } else if (doc.startDate) {
      return { startDate: literal(doc.startDate) };
    }
    return null;
  }
});

// The similar match of a treatment (rule 2, the socket only): a stored record
// of the same eventType within `maxtimediff` ms either side, inclusive, as an
// ISO string compare.
// BF-209 (#8877): the client identity rule is ported here from websocket.js
// as dev applies it. BF-210 was withdrawn: the amount rule is as before.
function similarTreatmentQuery (doc, maxtimediff) {
  var query_similiar = {
    created_at: { $gte: new Date(new Date(doc.created_at).getTime() - maxtimediff).toISOString(), $lte: new Date(new Date(doc.created_at).getTime() + maxtimediff).toISOString() }
  };
  // BF-09: what a zero means in the similar match.
  // - percent, absolute, duration: 0 is a value and must be equal. A
  //   zero temp (absolute 0) is the suspend an AID sends, percent 0 is
  //   a 100 % temp (AndroidAPS sends rate - 100), duration 0 is a
  //   cancel or a temp shorter than a minute. Left out, a zero temp
  //   was taken for an earlier temp of the same duration and dropped.
  // - insulin, carbs: 0 means none. It matches a record with none (0
  //   or absent), never one with an amount, so a zero bolus is not
  //   taken for a 1 U bolus. A zero sent as filler (xDrip+ sends both
  //   fields on every record, API v1 storage removes a zero) still
  //   matches the same record stored without it.
  // A field the write does not carry, or carries as '', false or
  // null, is not a key, for all five fields: a re-send with fewer
  // fields (carbs only, say) is still taken for the stored entry, so
  // it is not counted twice.
  ['insulin', 'carbs'].forEach(function (field) {
    var value = doc[field];
    if (value) {
      query_similiar[field] = literal(value);
    } else if (value === 0) {
      query_similiar[field] = { $in: [0, null] };
    }
  });
  ['percent', 'absolute', 'duration'].forEach(function (field) {
    var value = doc[field];
    if (value || value === 0) {
      query_similiar[field] = literal(value);
    }
  });
  // The client identity rule of the exact match (BF-209; see
  // treatment-fallback-key): a write with a client identity matches
  // only a record with the same one, and a write without one matches
  // only a record without one. An `identifier` the write carries
  // decides on its own: the same one is a re-send, another one is a
  // second record.
  Object.assign(query_similiar, fallbackKey.identityQuery(doc, { identifier: true }));
  // A similar record is always of the same eventType, whether or not an
  // amount was matched: a Meal Bolus with the same carbs as a Carb
  // Correction a second earlier is a second entry, not a copy (BF-121).
  query_similiar.eventType = literal(doc.eventType);
  return query_similiar;
}

// A result item that carries the record the reply is built from.
function withRecord (entry, record) {
  entry.record = record;
  return entry;
}

// A new record: server dates, then one insertOne of the document as given
// (normalize: false), so the driver's _id is on it. Any error is the
// `insert` rule's.
async function insertSocketRecord (storage, doc, rule) {
  if (rule.dates !== 'stamp-created') throw new TypeError('No server-date rule ' + rule.dates + ' for a socket dbAdd');
  try {
    srvDates.stampCreated(doc);
    await storage.insertOne(doc, { normalize: false });
  } catch (err) {
    throw new WriteRuleError('insert', err);
  }
  return { items: [item(0, 'inserted', doc._id, doc.identifier)], adapter: null };
}

// The socket's dbAdd of a collection that matches (the `socket-add` write),
// in today's order: the `_id` form (the socket's, one read for a 24-hex _id),
// the exact match, for treatments the similar match, else an insert.
//   - an exact match of a treatment or a status is `unchanged`: nothing is
//     written, and the item carries the stored record;
//   - an exact match of a profile is `merged` (slice 4, ID-Q8; it was
//     `replaced`): the document, with the stored _id and srvCreated and a new
//     srvModified, is merged into it (RFC 7386, `store` whole: ID-Q7); the
//     item carries that document as the reply (`record`, what a replace
//     answered) and the record as merged (`stored`), which the socket
//     announces;
//   - a similar match is `merged`: only created_at and srvModified are
//     written, and the item carries the stored record with those two set.
// A storage error under a rule is a WriteRuleError naming it (`id-form`,
// `exact-match`, `similar-match`, `insert`), with the storage error as its
// cause, so websocket.js answers each as it did; an error in building a
// query is thrown as it is, as it was.
// release-2: Q-E — a socket re-send is `unchanged` (treatments, devicestatus); the profile's is settled by ID-Q8
// (slice 4): `merged`.
// release-2: Q-R — the profile match sees a soft-deleted profile (`deleted: 'matched'`), so a re-send revives it.
async function writeSocketAdd (storageOf, docs, rule, scope) {
  if (docs.length !== 1) throw new TypeError('This create writes one document, not ' + docs.length);
  const doc = docs[0];
  const matchOf = SOCKET_EXACT[rule.match];
  if (!matchOf) throw new TypeError('No socket match rule ' + rule.match);
  if (rule.id !== 'stored-string-or-objectid') throw new TypeError('No _id rule ' + rule.id + ' for a socket dbAdd');
  const storage = storageOf();

  try {
    const formed = await storedStringOrObjectId(storage, doc._id);
    if (formed !== doc._id) doc._id = formed;
  } catch (err) {
    throw new WriteRuleError('id-form', err);
  }
  identifiersAbsent([doc], scope);

  // identifier first (slice 6): before NSCLIENT_ID and the collection's keys.
  // A rule with `otherTime: 'fall-through'` (the socket profile) takes the
  // pick only when it has the write's time key; otherwise today's order runs
  // (a profile at another startDate is open, question C, 2026-10-31).
  try {
    var named = await identifierFirstMatch(storage, doc, rule, scope.name, scope.name + ' socket dbAdd');
  } catch (err) {
    throw new WriteRuleError('exact-match', err);
  }
  if (named && (rule.identifier.otherTime !== 'fall-through' || sameTimeKey(scope.name, named, doc))) {
    const namedAction = softDeleted.isDeleted(named) ? deletedAction(rule, 'identifier') : null;
    if (namedAction === 'acknowledged') {
      console.log(LOG_DEDUP + 'Identifier match (deleted; acknowledged, stays deleted)');
      return { items: [withRecord(item(0, 'unchanged', named._id, named.identifier, DELETED_REASON), named)]
        , adapter: null };
    }
    if (namedAction === null || namedAction === 'revive') {
      if (rule.onIdentifier !== 'merged') throw new TypeError('No socket identifier outcome ' + rule.onIdentifier);
      try {
        console.log(LOG_DEDUP + 'Identifier match; merging into existing _id=' + loggedId(named._id));
        var resent = Object.assign({}, doc);
        resent._id = named._id;
        srvDates.carry(resent, named, srvDates.next());
        var namedParts = mergeParts(rule, named, resent);
        await v1Writes.update(storage, { _id: named._id }, mergePatch.toMongo(namedParts), { one: true });
        var namedMerged = withRecord(item(0, 'merged', named._id, named.identifier), resent);
        namedMerged.stored = mergedRecord(named, namedParts);
        return { items: [namedMerged], adapter: null };
      } catch (err) {
        throw new WriteRuleError('exact-match', err);
      }
    }
  }

  const query = matchOf(doc);
  // on-deleted: whether the exact match sees deleted records ('revive'), and
  // what it answers when only a deleted one has the key ('acknowledged').
  const exactAction = query ? deletedAction(rule, keyKind(query)) : null;
  const exactQuery = exactAction === 'revive' ? query : softDeleted.visible(query);
  if (query && (rule.onExact === 'replaced' || rule.onExact === 'merged')) {
    try {
      var existingProfile = await reads.findOne(storage, exactQuery);
      if (existingProfile) {
        console.log(LOG_DEDUP + 'Profile match on ' + Object.keys(query).join(',') + '; '
          + (rule.onExact === 'merged' ? 'merging into' : 'replacing') + ' existing _id=' + existingProfile._id);
        var replacementDoc = Object.assign({}, doc);
        replacementDoc._id = existingProfile._id;
        srvDates.carry(replacementDoc, existingProfile, srvDates.next());
        if (rule.onExact === 'merged') {
          var parts = mergeParts(rule, existingProfile, replacementDoc);
          await v1Writes.update(storage, { _id: existingProfile._id }, mergePatch.toMongo(parts), { one: true });
          var merged = withRecord(item(0, 'merged', replacementDoc._id, replacementDoc.identifier), replacementDoc);
          merged.stored = mergedRecord(existingProfile, parts);
          return { items: [merged], adapter: null };
        }
        await v1Writes.replace(storage, { _id: existingProfile._id }, replacementDoc);
        return { items: [withRecord(item(0, 'replaced', replacementDoc._id, replacementDoc.identifier), replacementDoc)]
          , adapter: null };
      }
    } catch (err) {
      throw new WriteRuleError('exact-match', err);
    }
  } else if (query) {
    try {
      // A live record first; a deleted one is a match only on an identity
      // (NSCLIENT_ID, or the fallback key with a client identity: ID-Q4).
      var exact = await reads.findOne(storage, exactQuery);
      if (exact) {
        console.log(LOG_DEDUP + rule.exactLog);
        return { items: [withRecord(item(0, 'unchanged', exact._id, exact.identifier), exact)], adapter: null };
      }
      var exactDeleted = exactAction === 'acknowledged' ? await reads.findOne(storage, { $and: [query, { isValid: false }] }) : null;
      if (exactDeleted) {
        console.log(LOG_DEDUP + rule.exactLog + ' (deleted; acknowledged, stays deleted)');
        return { items: [withRecord(item(0, 'unchanged', exactDeleted._id, exactDeleted.identifier, DELETED_REASON)
          , exactDeleted)], adapter: null };
      }
    } catch (err) {
      throw new WriteRuleError('exact-match', err);
    }
  }

  if (rule.near !== undefined) {
    var query_similiar = similarTreatmentQuery(doc, rule.near);
    try {
      var similar = await reads.findOne(storage, softDeleted.visible(query_similiar));
      // on-deleted (ID-Q4): when a sent identity decides the similar match
      // (an identifier, #8877, or a client identity) and only a deleted record
      // in the window has it, the re-send is acknowledged and the record
      // stays deleted. It is not identifier-match (the socket has none before
      // slice 6), so it is an identity key here.
      var similarAction = deletedAction(rule, keyKind(query_similiar) === 'time' ? 'time' : 'identity');
      var similarDeleted = !similar && similarAction === 'acknowledged'
        ? await reads.findOne(storage, { $and: [query_similiar, { isValid: false }] }) : null;
      if (similarDeleted) {
        console.log(LOG_DEDUP + 'Found similar treatment _id=' + similarDeleted._id + ' (deleted; acknowledged, stays deleted)');
        return { items: [withRecord(item(0, 'unchanged', similarDeleted._id, similarDeleted.identifier, DELETED_REASON)
          , similarDeleted)], adapter: null };
      }
      // if found similiar just update date. next time it will match exactly
      if (similar) {
        console.log(LOG_DEDUP + 'Found similar treatment _id=' + similar._id);
        similar.created_at = doc.created_at;
        // similar._id is the stored value itself, whichever form it has.
        var similarFields = { created_at: doc.created_at };
        srvDates.stampModified(similarFields);
        // release-2: Q-Q — under WRITE_VALIDATION=reject the conditional update below the interface also stores
        // the derived duration fields, which the reply (this record) does not carry.
        await v1Writes.update(storage, { '_id': similar._id }, { $set: similarFields }, { one: true });
        similar.srvModified = similarFields.srvModified;
        return { items: [withRecord(item(0, 'merged', similar._id, similar.identifier), similar)], adapter: null };
      }
    } catch (err) {
      throw new WriteRuleError('similar-match', err);
    }
    // if not found create new record
    console.log(LOG_DEDUP + 'Adding new record');
  }

  return insertSocketRecord(storage, doc, rule);
}

// The socket's dbAdd rules of a collection that matches.
function socketAdd (match, extra) {
  return Object.freeze(Object.assign({ id: 'stored-string-or-objectid', write: 'socket-add', match: match
    , dates: 'stamp-created' }, extra));
}

const SOCKET_ADD = Object.freeze({
  // The +-2 s similar match (Q4 (a)), inclusive at both edges.
  // on-deleted (slice 3, ID-Q4): a deleted record is acknowledged when an
  // identity reaches it (NSCLIENT_ID; a client identity or identifier in the
  // similar match), and hidden from a time key (the fallback key alone,
  // device status created_at), so that re-send is stored as a new record.
  // Treatments have no identifier-first entry yet: merge or replace on an
  // identifier match is open (question B, 2026-10-31).
  treatments: socketAdd('treatment', { onExact: 'unchanged', deleted: 'stays-deleted', exactLog: 'Exact match', near: 2000 }),
  // identifier first (slice 6): a stored identifier merges (ID-Q2; the
  // exact match below still answers unchanged), a deleted one is acknowledged.
  devicestatus: socketAdd('devicestatus', { onExact: 'unchanged', deleted: 'stays-deleted', exactLog: 'Devicestatus exact match'
    , identifier: identifierFirstRule(IDENTIFIER_FIRST), onIdentifier: 'merged' }),
  // AAPS V1 sync only sends dbAdd, never dbUpdate, for profile.
  // merge on match (slice 4, ID-Q8, ID-Q7): an exact match is merged, `store` whole.
  // identifier first (slice 6) only at the write's startDate (otherTime:
  // 'fall-through'); a deleted profile it reaches revives, as Q-R keeps.
  profile: socketAdd('profile', { onExact: 'merged', merge: 'rfc7386-store-whole', deleted: 'matched'
    , identifier: identifierFirstRule(IDENTIFIER_FIRST, { otherTime: 'fall-through' }), onIdentifier: 'merged' })
});

// dbUpdate and dbUpdateUnset name the records by `_id`, through the socket's
// _id match (socketIdMatch): plan() resolves it synchronously, at the moment
// the handler did, and websocket.js reads the record it announces, and
// reconciles a partial write, by the same match.
// With no _id and an identifier (decision 4), the match is resolved when the
// write runs (identifierEditMatch, one read) and left on the plan, for the
// handler's read-back.
function planSocketUpdate (rule, intent, scope) {
  if (intent.target && !Object.prototype.hasOwnProperty.call(intent.target, '_id')
    && Object.prototype.hasOwnProperty.call(intent.target, 'identifier')) {
    identifierRule(rule, 'target', 'p4');
    return { planned: true, rule: rule, target: intent.target, fields: intent.fields, match: null
      , identifier: intent.target.identifier, name: scope && scope.name, env: scope && scope.env };
  }
  if (!intent.target || !Object.prototype.hasOwnProperty.call(intent.target, '_id')) {
    throw new TypeError('update needs target._id');
  }
  return { planned: true, rule: rule, target: intent.target, fields: intent.fields
    , match: socketIdMatch(intent.target._id), env: scope && scope.env };
}

// on-deleted for a socket edit (ID-Q3), once its records are named: when the
// first record the edit reaches is soft-deleted, the edit is not applied
// (WRITE_DELETED_EDIT: an unchanged item, or DeletedRecordError). Addressed
// by identifier it is an identifier key, by _id an identity. Null when the
// edit goes ahead.
async function socketEditOnDeleted (storage, plan) {
  const rule = plan.rule;
  if (rule.deleted === undefined) return null;
  const byId = plan.target && Object.prototype.hasOwnProperty.call(plan.target, '_id');
  if (deletedAction(rule, byId ? 'identity' : 'identifier') !== 'edit') return null;
  const stored = (await deletedReached(storage, [plan.match.filter])).get(0);
  return stored ? deletedEdit(plan.env, 0, stored, stored.identifier) : null;
}

// An edit addressed by an identifier (ID-Q10) lands on the record P4 names:
// of the records identifier-match finds, soft-deleted ones included as an
// edit by _id reaches them, the newest by _id whose time key (the rule's
// timeKeys) equals the edit's, else the newest by _id. Every stored form of
// that record is written, as an edit by its _id would be. When the identifier
// names more than one record, the pick is logged. Null when it names none.
async function identifierEditMatch (storage, plan) {
  const match = identifierRule(plan.rule, 'target', 'p4');
  const stored = await reads.findAll(storage, anyOf(identifierMatch({ $eq: plan.identifier }, match.also))
    , { sort: { _id: -1 } });
  const picked = p4Pick(stored, plan.fields, plan.rule.identifier.timeKeys, plan.name + ' socket edit');
  return picked ? socketIdMatch(picked._id) : null;
}

// The socket's dbRemove addressed by an identifier (decision 4, ID-Q10): every
// record identifier-match finds, as API v3 DELETE reaches every record that
// shares one. Their _ids are read first, under the same filter, and the
// delete is limited to them, so `removed` names exactly the records the
// caller announces to the cache (a cache is never dropped for this). None
// found: nothing is deleted and `removed` is empty.
async function deleteByIdentifier (storageOf, target, rule) {
  const match = identifierRule(rule, 'target', 'every');
  const storage = storageOf();
  const filter = anyOf(identifierMatch({ $eq: target.identifier }, match.also));
  const found = await reads.findAll(storage, filter, { projection: { _id: 1 } });
  const ids = found.map(function (doc) { return doc._id; });
  if (ids.length === 0) {
    return { items: [item(0, 'not-found', undefined, target.identifier)], adapter: { deletedCount: 0 }, removed: [ ] };
  }
  const reply = await storage.deleteMany(reads.toFilter({ $and: [filter, { _id: { $in: ids } }] }), { v1: true });
  const deleted = reply && reply.deletedCount > 0;
  return { items: [item(0, deleted ? 'deleted' : 'not-found', undefined, target.identifier)], adapter: reply
    , removed: ids };
}

// The fields a dbUpdate sets on the Temporary Targets it names, with
// the targets in mg/dL (lib/treatmentTargetUnits.js): { fields } when
// they are the same for every record named, { each: [{ stored, fields }] }
// when they differ, or null when it names no Temporary Target and the
// update is written as before. WRITE_VALIDATION checks the update as
// sent; the storage write checks it again as converted.
async function targetUnitsUpdates (storage, match, setFields, env) {
  var stored = match.many
    ? await reads.findAll(storage, match.filter)
    : [await reads.findOne(storage, match.filter)].filter(Boolean);
  var anyTarget = false;
  var updates = stored.map(function (doc) {
    var fields = Object.assign({}, setFields);
    if (writeValidation.mode(env) !== 'off' && writeValidation.touchesDomain(setFields)) {
      validatedUpdate.checkedUpdate({ $set: Object.assign({}, fields) }, doc, { env: env, source: 'socket' });
    }
    if (targetUnits.normalizeTargetUnits(fields, doc)) anyTarget = true;
    return { stored: doc, fields: fields };
  });
  if (!anyTarget) return null;
  var first = JSON.stringify(updates[0].fields);
  var uniform = updates.every(function (u) { return JSON.stringify(u.fields) === first; });
  return uniform ? { fields: updates[0].fields } : { each: updates };
}

// dbUpdate (the `socket-merge` write): data.data is a JSON Merge Patch, as an
// API v3 PATCH body is (RFC 7386, write-contract Q1b, decided 2026-10-26): a
// field sent as null is removed, at any depth, and an object merges into the
// stored object. Each record it names is read and merged on its own; a body
// without a null or an object member is the plain $set it always was.
// srvModified is stamped where API v3 serves the collection.
//
// A Temporary Target is stored in mg/dL (BF-194): an update that sends a
// target, glucose, units or eventType is converted against the records it
// names, after it is validated as sent, and then carries both targets and
// the label as they will be stored. When every record gets the same fields
// (one record, or its twins), they are written as one update, as before.
// The outcome is `merged` when a record matched, else `not-found`; the socket
// answers success either way.
// release-2 (no id yet): an update by a 24-hex _id reaches every stored form (twins), while websocket.js
// reads back and announces one of them.
async function writeSocketMerge (storageOf, plan, env) {
  const rule = plan.rule;
  if (rule.dates !== 'stamp-modified' && rule.dates !== 'none') {
    throw new TypeError('No server-date rule ' + rule.dates + ' for a socket dbUpdate');
  }
  const storage = storageOf();
  if (!plan.match) {
    plan.match = await identifierEditMatch(storage, plan);
    if (!plan.match) return { items: [item(0, 'not-found', undefined, plan.identifier)], adapter: null };
  }
  const notApplied = await socketEditOnDeleted(storage, plan);
  if (notApplied) return { items: [notApplied], adapter: null };
  // identifier-held (ID-RULE1-EDIT): an edit by _id that sets an identifier
  // another record holds. No record is read before this write, so the read
  // excludes the one the _id names.
  if (plan.target && Object.prototype.hasOwnProperty.call(plan.target, '_id') && plan.fields) {
    await refuseHeldIdentifiers(storage, rule, [{ value: plan.fields.identifier, submitted: plan.target._id
      , id: plan.target._id }]);
  }
  const match = plan.match;
  var matched;
  var setFields = plan.fields;
  if (rule.dates === 'stamp-modified') {
    setFields = Object.assign({}, plan.fields);
    srvDates.stampModified(setFields);
  }
  var converted = rule.units === 'temporary-target-mgdl' && targetUnits.touches(setFields)
    ? await targetUnitsUpdates(storage, match, setFields, env) : null;
  if (converted && converted.fields) setFields = converted.fields;
  if (converted && converted.each) {
    matched = true;
    for (var c = 0; c < converted.each.length; c += 1) {
      var convertedUpdate = mergePatch.toMongo(mergePatch.update(converted.each[c].stored, converted.each[c].fields));
      if (Object.keys(convertedUpdate).length > 0) {
        await v1Writes.update(storage, { _id: converted.each[c].stored._id }, convertedUpdate, { one: true });
      }
    }
  } else if (!mergePatch.differsFromSet(setFields)) {
    var reply = await v1Writes.update(storage, match.filter, { $set: setFields }, { one: !match.many });
    matched = Boolean(reply) && reply.matchedCount > 0;
  } else {
    var targets = match.many
      ? await reads.findAll(storage, match.filter)
      : [await reads.findOne(storage, match.filter)].filter(Boolean);
    matched = targets.length > 0;
    for (var t = 0; t < targets.length; t += 1) {
      var parts = mergePatch.update(targets[t], setFields);
      var mergeUpdate = mergePatch.toMongo(parts);
      if (Object.keys(mergeUpdate).length > 0) {
        await v1Writes.update(storage, { _id: targets[t]._id }, mergeUpdate, { one: true });
      }
    }
  }
  return { items: [item(0, matched ? 'merged' : 'not-found', plan.target._id, plan.identifier)], adapter: null };
}

// dbUpdateUnset (the `socket-unset` write): the fields named are removed.
// Where API v3 serves the collection the server's own times cannot be unset,
// and srvModified is set.
async function writeSocketUnset (storageOf, plan) {
  const rule = plan.rule;
  if (rule.dates !== 'stamp-modified' && rule.dates !== 'none') {
    throw new TypeError('No server-date rule ' + rule.dates + ' for a socket dbUpdateUnset');
  }
  const storage = storageOf();
  if (!plan.match) {
    plan.match = await identifierEditMatch(storage, plan);
    if (!plan.match) return { items: [item(0, 'not-found', undefined, plan.identifier)], adapter: null };
  }
  const notApplied = await socketEditOnDeleted(storage, plan);
  if (notApplied) return { items: [notApplied], adapter: null };
  const match = plan.match;
  var unsetUpdate = { $unset: plan.fields };
  if (rule.dates === 'stamp-modified') {
    var unsetFields = Object.assign({}, plan.fields);
    delete unsetFields.srvModified;
    delete unsetFields.srvCreated;
    unsetUpdate = { $set: {} };
    srvDates.stampModified(unsetUpdate.$set);
    if (Object.keys(unsetFields).length > 0) unsetUpdate.$unset = unsetFields;
  }
  var reply = await v1Writes.update(storage, match.filter, unsetUpdate, { one: !match.many });
  var matched = Boolean(reply) && reply.matchedCount > 0;
  return { items: [item(0, matched ? 'merged' : 'not-found', plan.target._id, plan.identifier)], adapter: reply };
}

// The socket's dbUpdate (form `merge`) and dbUpdateUnset (form `unset`) of
// one collection. `dates` is 'stamp-modified' where API v3 serves the
// collection, 'none' for activity; `units` names the BF-194 rule
// (treatments only).
// With no _id, both are addressed by identifier (decision 4): identifier-match
// alone, the record P4 names, by the collection's time keys (`timeKeys`).
// An edit of a soft-deleted record is not applied (on-deleted, ID-Q3).
// release-2: Q5 (a) — activity's socket updates carry no srvModified (dates: 'none').
function socketUpdate (dates, units, timeKeys) {
  const identifier = Object.freeze({ also: 'none', pick: 'p4', timeKeys: Object.freeze(timeKeys) });
  return Object.freeze({ forms: Object.freeze({
    merge: Object.freeze({ plan: 'socket-update', write: 'socket-merge', target: 'id-match', dates: dates, units: units
      , identifier: identifier, identifierHeld: 'refuse', deleted: 'stays-deleted-edit' }),
    unset: Object.freeze({ plan: 'socket-update', write: 'socket-unset', target: 'id-match', dates: dates
      , identifier: identifier, deleted: 'stays-deleted-edit' })
  }) });
}

// Today's rules, per collection and per write source (the label the storage
// interface carries; API v1 routes and in-process callers share
// 'v1/internal', so the step cannot tell them apart and does not try).
// Collections and sources not listed are not written through this step yet.
// release-2: Q-C — API v1 and in-process callers share the source label 'v1/internal'; the step cannot tell
// them apart, and every v1 rule below applies to both.
const COLLECTION_RULES = Object.freeze({
  // The socket's dbAdd of these three matches (SOCKET_ADD); its reply slots
  // and emissions stay in websocket.js. Treatments carry the dbAdd preflight.
  treatments: Object.freeze({ socket: Object.freeze({ check: 'treatment-domain-socket', create: SOCKET_ADD.treatments
    , update: socketUpdate('stamp-modified', 'temporary-target-mgdl', P4_TIME_KEYS.treatments), delete: SOCKET_DELETE })
    , 'v1/internal': TREATMENTS_V1, v3: V3_TREATMENTS }),
  devicestatus: Object.freeze({ socket: Object.freeze({ create: SOCKET_ADD.devicestatus
    , update: socketUpdate('stamp-modified', 'none', P4_TIME_KEYS.devicestatus), delete: SOCKET_DELETE })
    , 'v1/internal': DEVICESTATUS_V1, v3: V3_DEVICESTATUS }),
  profile: Object.freeze({ socket: Object.freeze({ create: SOCKET_ADD.profile
    , update: socketUpdate('stamp-modified', 'none', P4_TIME_KEYS.profile), delete: SOCKET_DELETE })
    , 'v1/internal': PROFILE_V1, v3: V3_PROFILE }),
  entries: Object.freeze({ socket: Object.freeze({ create: socketInsert('stamp-created', IDENTIFIER_FIRST)
    , update: socketUpdate('stamp-modified', 'none', P4_TIME_KEYS.entries), delete: SOCKET_DELETE })
    , 'v1/internal': ENTRIES_V1, v3: V3_OTHER }),
  food: Object.freeze({
    socket: Object.freeze({ create: socketInsert('stamp-created', IDENTIFIER_FIRST), update: socketUpdate('stamp-modified', 'none', P4_TIME_KEYS.food)
      , delete: SOCKET_DELETE }),
    'v1/internal': Object.freeze({
      // Every write is an upserting replace by _id (onMatch: replace); a
      // record also stored under the string form of a submitted 24-hex _id
      // is removed after the batch's replaces, in the same ordered bulk
      // write (BF-130). srvCreated and identifier are carried from the
      // record replaced; srvModified is new (srv-dates carryForReplace).
      // release-2: Q-B — food removes string twins once, after all replaces, in the same bulk write.
      // Q-E settled for this path by ID-Q8 (slice 4): a re-send by a stored _id is `merged`
      // (RFC 7386; srvModified advances); only PUT and save replace.
      // on-deleted (slice 3): a re-send by the _id of a deleted record is
      // acknowledged (ID-Q4); an edit of one is not applied (ID-Q3).
      // identifier first (slice 6): a stored identifier decides before the _id.
      create: Object.freeze({ id: 'stored-or-new', target: 'id-eq', onMatch: 'merged', twins: 'remove-string-forms', dates: 'carry'
        , deleted: 'stays-deleted', identifier: identifierFirstRule(IDENTIFIER_FIRST) }),
      update: Object.freeze({ id: 'objectid-or-new', target: 'id-plain', onMatch: 'replaced', twins: 'remove-string-forms', dates: 'carry'
        , identifierHeld: 'refuse', deleted: 'stays-deleted-edit' }),
      // Every stored form of the id: the ObjectId and its string spellings.
      delete: Object.freeze({ target: 'every-form' })
    }),
    v3: V3_OTHER
  }),
  // API v3 only.
  settings: Object.freeze({ v3: V3_OTHER }),
  activity: Object.freeze({
    socket: Object.freeze({ create: socketInsert('none', ACTIVITY_IDENTIFIER_FIRST), update: socketUpdate('none', 'none', P4_TIME_KEYS.activity), delete: SOCKET_DELETE }),
    'v1/internal': Object.freeze({
      // create is food's create without server dates: activity has no API v3
      // endpoint and has never been stamped (write-contract Q5 (a) gives it
      // dates in the second release, not here). A re-send by a stored _id is
      // `merged` (ID-Q8, slice 4).
      // identifier first (slice 6a): a stored identifier decides before the _id.
      create: Object.freeze({ id: 'stored-or-new', target: 'id-eq', onMatch: 'merged', twins: 'remove-string-forms', dates: 'none'
        , deleted: 'stays-deleted', identifier: identifierFirstRule(ACTIVITY_IDENTIFIER_FIRST) }),
      // update (v1 PUT, in-process save) writes ONE document: an upserting
      // replaceOne by plain _id equality, then, in a separate call and only
      // when the submitted _id was 24-hex, the removal of its string forms
      // (write-contract Q-B keeps both timings as they are).
      // release-2: Q-B — activity save removes its twin in a call of its own; activity create, after the batch.
      // release-2: Q5 (a) — activity has no server dates on any v1 write.
      update: Object.freeze({ id: 'objectid-or-new', target: 'id-plain', onMatch: 'replaced', twins: 'remove-string-forms-after', dates: 'none', write: 'replace-one'
        , identifierHeld: 'refuse', deleted: 'stays-deleted-edit' }),
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
async function replaceDocuments (storageOf, docs, rule, scope) {
  const submitted = [];
  const sent = [];
  const targets = docs.map(function target (doc) {
    submitted.push(doc._id);
    doc._id = ID_FORMS[rule.id](doc._id);
    identifiersAbsent([doc], scope);
    sent.push(doc.identifier);
    return { filter: TARGETS[rule.target](doc._id), doc: doc };
  });

  // The storage interface is acquired here, after every document has its
  // _id: a caller that cannot reach storage still gets its documents' ids
  // assigned and a rejected promise, as before.
  const storage = storageOf();
  // identifier first (slice 6 food, 6a activity), before the _id: a document
  // carrying a stored identifier is written to the record P4 picks, by its
  // _id, so the rules below (on-deleted, merge on match) apply to it as to a
  // re-send by that _id. An identifier that names nothing leaves the _id.
  const named = await identifierFirstMatches(storage, docs, rule, scope.name, scope.name + ' ' + scope.source + ' create');
  named.forEach(function (stored, index) {
    docs[index]._id = stored._id;
    targets[index].filter = TARGETS[rule.target](stored._id);
  });
  // on-deleted: a document whose _id names a deleted record is not written
  // (a create acknowledged, ID-Q4; an edit not applied, ID-Q3), and the
  // string forms of its _id are left as they are.
  const skipped = await documentsOnDeleted(storage, rule, targets.map(function (t) { return t.filter; }), docs
    , scope && scope.env);
  const writing = targets.filter(function (t, index) { return !skipped.has(index); });
  // A document identifier-first sent to another record does not remove the
  // string forms of the _id it carried: that is not the record written.
  const stale = rule.twins === 'remove-string-forms'
    ? idForms.staleStringForms(submitted.filter(function (id, index) {
      return !skipped.has(index) && !(named.has(index) && String(named.get(index)._id).toLowerCase() !== String(id).toLowerCase());
    })) : [];

  // Server dates right before the write, from the documents the filters name
  // now (rule 4).
  let found;
  if (rule.dates === 'carry') found = await srvDates.carryForReplace(reads.documents(storage), writing);
  else if (rule.dates !== 'none') throw new TypeError('No server-date rule ' + rule.dates + ' for a batch replace');
  // merge on match (ID-Q8): a create whose _id names a stored record is merged
  // into it; activity, with no server dates, reads the records for it here.
  if (rule.onMatch === 'merged' && found === undefined) found = await srvDates.findForReplace(reads.documents(storage), writing);
  // identifier-held (ID-RULE1-EDIT): before any write of the batch, against
  // the records the server-date read found.
  const edits = [ ];
  docs.forEach(function edit (doc, index) {
    if (skipped.has(index)) return;
    edits.push({ value: sent[index], submitted: submitted[index], id: doc._id, stored: found ? found[edits.length] : undefined });
  });
  await refuseHeldIdentifiers(storage, rule, edits);

  const merges = await mergesOnMatch(storage, rule, writing.map(function (t) { return t.doc; }), found
    , writing.map(function (t) { return rule.deleted === undefined ? undefined : keyKind(t.filter); }));
  const ops = writing.map(function op (t, at) { return bulkOp(reads.toFilter(t.filter), t.doc, merges[at]); });
  if (stale.length > 0) ops.push({ remove: reads.toFilter({ _id: { $in: stale } }) });
  const reply = ops.length === 0 ? null : await storage.bulkUpsert(ops, { mode: 'replace', ordered: true, v1: true });

  // upsertedIds are keyed by the operation; each written document's index.
  const upserted = { };
  const writtenIndex = docs.map(function (doc, index) { return index; })
    .filter(function (index) { return !skipped.has(index); });
  Object.keys((reply && reply.upsertedIds) || { }).forEach(function (at) {
    if (writtenIndex[at] !== undefined) upserted[writtenIndex[at]] = reply.upsertedIds[at];
  });
  const items = docs.map(function outcome (doc, index) {
    if (skipped.has(index)) return skipped.get(index);
    if (Object.prototype.hasOwnProperty.call(upserted, index)) {
      return item(index, 'inserted', upserted[index], doc.identifier);
    }
    return item(index, rule.onMatch, doc._id, doc.identifier);
  });
  return { items: items, adapter: reply };
}

// on-deleted over documents written by their _id (food and activity create
// and save): each filter names a record by _id, an identity, so a deleted one
// is acknowledged (a create) or not edited (an edit). Answers the items of the
// documents not written, by index. A rule with no `deleted` reads nothing.
async function documentsOnDeleted (storage, rule, filters, docs, env) {
  const skipped = new Map();
  if (rule.deleted === undefined) return skipped;
  const actions = filters.map(function (filter) { return deletedAction(rule, keyKind(filter)); });
  const reached = await deletedReached(storage, filters.map(function (filter, index) {
    return actions[index] === 'revive' ? undefined : filter;
  }));
  reached.forEach(function (stored, index) {
    if (actions[index] === 'hidden') throw new TypeError('A write by _id has no time key to hide a deleted record from');
    skipped.set(index, actions[index] === 'edit' ? deletedEdit(env, index, stored, stored.identifier)
      : item(index, 'unchanged', stored._id, stored.identifier, DELETED_REASON));
    docs[index]._id = stored._id;
  });
  return skipped;
}

// update of ONE document (the `replace-one` write): an upserting replace by
// its target, then the removal of its string twins in a call of its own,
// directly after the write it belongs to. The document is the caller's own
// object and is written in place, as above.
async function replaceOneDocument (storageOf, docs, rule, scope) {
  if (docs.length !== 1) throw new TypeError('This update writes one document, not ' + docs.length);
  if (rule.dates !== 'none') throw new TypeError('No server-date rule ' + rule.dates + ' for a replace-one write');
  const doc = docs[0];
  const submitted = doc._id;
  const stale = rule.twins === 'remove-string-forms-after' ? idForms.staleStringForms([doc._id]) : [];
  doc._id = ID_FORMS[rule.id](doc._id);
  identifiersAbsent([doc], scope);
  const filter = TARGETS[rule.target](doc._id);

  const storage = storageOf();
  // on-deleted (ID-Q3): an edit of a deleted record is not applied.
  const skipped = await documentsOnDeleted(storage, rule, [filter], docs, scope && scope.env);
  if (skipped.has(0)) return { items: [skipped.get(0)], adapter: null };
  // identifier-held (ID-RULE1-EDIT): no record is read before this write, so
  // the read excludes the record the _id names.
  await refuseHeldIdentifiers(storage, rule, [{ value: doc.identifier, submitted: submitted, id: doc._id }]);
  const reply = await storage.replaceFiltered(reads.toFilter(filter), doc, { upsert: true, v1: true });
  if (stale.length > 0) await storage.deleteMany(reads.toFilter({ _id: { $in: stale } }), { v1: true });

  const inserted = reply && reply.upsertedId !== undefined && reply.upsertedId !== null;
  return { items: [inserted ? item(0, 'inserted', reply.upsertedId, doc.identifier)
    : item(0, rule.onMatch, doc._id, doc.identifier)], adapter: reply };
}

// create of ONE document by a plain insert (the `insert-one` write): no target
// is resolved, so the outcome is `inserted`, or `refused` when its _id is
// already stored. Any other storage error is the caller's, as before.
async function insertOneDocument (storageOf, docs, rule, scope) {
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
  identifiersAbsent([doc], scope);
  if (rule.dates !== 'stamp-created' && rule.dates !== 'none') {
    throw new TypeError('No server-date rule ' + rule.dates + ' for an insert-one write');
  }
  // identifier first (slice 6, 6a): a stored identifier is a re-send.
  const matched = await identifierFirstMatch(storage, doc, rule, scope.name, scope.name + ' socket dbAdd');
  if (matched) return socketInsertMatched(storage, doc, rule, matched);
  if (rule.dates === 'stamp-created') srvDates.stampCreated(doc);

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

// A socket dbAdd identifier-first landed on `stored`: a deleted record is
// acknowledged (nothing written, no event; the reply names it); a live one is
// merged (RFC 7386; `_id` and the server's dates are not taken from the
// write; srvModified is new where the collection has server dates). The item
// carries the record as merged, which the socket answers and announces.
async function socketInsertMatched (storage, doc, rule, stored) {
  if (softDeleted.isDeleted(stored)) {
    const action = deletedAction(rule, 'identifier');
    if (action === 'acknowledged') {
      console.log(LOG_DEDUP + 'Identifier match (deleted; acknowledged, stays deleted)');
      return { items: [withRecord(item(0, 'unchanged', stored._id, stored.identifier, DELETED_REASON), stored)], adapter: null };
    }
    if (action !== 'revive') throw new TypeError('No socket dbAdd for on-deleted ' + action);
  }
  if (rule.onMatch !== 'merged') throw new TypeError('No socket dbAdd match outcome ' + rule.onMatch);
  const parts = mergeParts(rule, stored, doc, ['srvCreated', 'srvModified']);
  if (rule.dates === 'stamp-created') srvDates.stampModified(parts.set);
  console.log(LOG_DEDUP + 'Identifier match; merging into existing _id=' + loggedId(stored._id));
  const update = mergePatch.toMongo(parts);
  if (Object.keys(update).length > 0) await v1Writes.update(storage, { _id: stored._id }, update, { one: true });
  const merged = withRecord(item(0, 'merged', stored._id, stored.identifier), mergedRecord(stored, parts));
  merged.stored = merged.record;
  return { items: [merged], adapter: null };
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
function planDocuments (rule, docs, env, scope) {
  const idForm = DOC_ID_FORMS[rule.id];
  const prepare = PREPARE[rule.prepare];
  const targetOf = DOC_TARGETS[rule.target];
  const timeOf = KEY_TIME[rule.keyTime];
  if (!idForm || !prepare || !targetOf || !timeOf) throw new TypeError('Incomplete document rules');
  const targets = [ ];
  const prepared = [ ];
  const stale = [ ];
  const identified = [ ];
  const sentIds = [ ];
  const kinds = [ ];
  docs.forEach(function plan (doc) {
    const submitted = doc._id;
    sentIds.push(submitted);
    idForm(doc, env);
    identifiersAbsent([doc], scope);
    const results = prepare(doc);
    const filter = targetOf(doc, env, timeOf(doc, results), rule);
    targets.push(filter);
    prepared.push(results);
    stale.push(rule.twins !== 'none' && filter && filter._id ? idForms.staleStringForms([submitted]) : [ ]);
    // The identifier a treatment-key target matched on, for P4 at write time.
    identified.push(rule.target === 'treatment-key' && doc.identifier ? doc.identifier : undefined);
    // The kind of key the target is (on-deleted), as planned: P4 may later
    // narrow an identifier target to one _id, and it stays an identifier match.
    kinds.push(rule.deleted === undefined ? undefined : keyKind(filter));
  });
  return { planned: true, rule: rule, docs: docs, targets: targets, prepared: prepared, stale: stale
    , identified: identified, picked: new Map(), env: env, source: scope && scope.source, submitted: sentIds
    , kinds: kinds };
}

// on-deleted over a planned write of documents (v1 / in-process treatments,
// profile save): each target whose key the rule does not leave as it is
// ('revive') is read for a deleted record it reaches (deletedReached). Of those,
// a time key's target then names live records only ('hidden': the write
// matches a live record or stores a new one); a document matched on an
// identity key is not written ('acknowledged'; an edit, 'edit'). Answers the
// items of the documents not written, by index.
async function plannedOnDeleted (storage, plan) {
  const skipped = new Map();
  if (plan.rule.deleted === undefined) return skipped;
  const actions = plan.kinds.map(function (kind) { return deletedAction(plan.rule, kind); });
  const reached = await deletedReached(storage, plan.targets.map(function (target, index) {
    return actions[index] === 'revive' ? undefined : target;
  }));
  reached.forEach(function (stored, index) {
    const doc = plan.docs[index];
    if (actions[index] === 'hidden') {
      plan.targets[index] = softDeleted.visible(plan.targets[index]);
      return;
    }
    if (actions[index] === 'edit') {
      skipped.set(index, deletedEdit(plan.env, index, stored, stored.identifier));
    } else {
      skipped.set(index, item(index, 'unchanged', stored._id, stored.identifier, DELETED_REASON));
    }
    doc._id = stored._id;
  });
  return skipped;
}

// P4 on v1 / in-process treatments (ID-Q5): when a document's identifier
// names more than one stored record, its target becomes the record P4 picks
// by created_at, by _id, and the reply names it (plan.picked). One read per
// write, only when a document is matched by identifier and the rule's pick is
// 'p4'; under 'driver-first' the write goes by the identifier filter and
// reaches the record MongoDB finds first.
async function pickTreatmentTargets (storageOf, plan) {
  const rule = plan.rule;
  if (!rule.identifier || !plan.identified) return;
  const match = identifierRule(rule, 'target', ['driver-first', 'p4']);
  if (match.pick !== 'p4') return;
  const values = [ ];
  plan.identified.forEach(function (value) { if (value !== undefined && values.indexOf(value) === -1) values.push(value); });
  if (values.length === 0) return;
  const timeKeys = P4_TIME_KEYS.treatments;
  const projection = { _id: 1, identifier: 1 };
  timeKeys.forEach(function (key) { projection[key] = 1; });
  const stored = await reads.findAll(storageOf(), anyOf(identifierMatch({ $in: values }, match.also, plan.env))
    , { projection: projection, sort: { _id: -1 } });
  plan.identified.forEach(function (value, index) {
    if (value === undefined) return;
    const named = namedBy(stored, value, match.also, plan.env);
    if (named.length < 2) return;
    const picked = p4Pick(named, plan.docs[index], timeKeys, 'treatments ' + plan.source + ' re-send');
    plan.targets[index] = { _id: literal(picked._id) };
    plan.picked.set(index, picked._id);
  });
}

// A planned batch as one ordered bulk write: each document an upserting
// replace by its target, followed directly by the removal of its string twins
// (BF-130: a later item matched by its fallback key could otherwise land on
// the string copy and be removed with it). Server dates right before it.
async function writePlannedBatch (storageOf, plan) {
  const docs = plan.docs;
  await pickTreatmentTargets(storageOf, plan);
  // on-deleted: a document whose match reaches a deleted record on an
  // identity key is not written (ID-Q4).
  const skipped = await plannedOnDeleted(storageOf(), plan);
  const ops = [ ];
  const opItem = [ ];
  docs.forEach(function op (doc, index) {
    if (skipped.has(index)) return;
    ops.push({ filter: plan.targets[index], doc: doc });
    opItem.push(index);
    if (plan.stale[index].length > 0) {
      ops.push({ remove: { _id: { $in: plan.stale[index] } } });
      opItem.push(null);
    }
  });
  const storage = storageOf();
  if (plan.rule.dates !== 'carry') throw new TypeError('No server-date rule ' + plan.rule.dates + ' for a planned batch');
  const writes = ops.filter(function replaces (op) { return !op.remove; });
  const found = await srvDates.carryForReplace(reads.documents(storage), writes
    .map(function target (op) { return { filter: op.filter, doc: op.doc }; }));
  // merge on match (ID-Q8): a document whose target matched is merged into it.
  const writeIndex = opItem.filter(function (at) { return at !== null; });
  const merges = await mergesOnMatch(storage, plan.rule, writes.map(function (op) { return op.doc; }), found
    , writeIndex.map(function (at) { return plan.kinds[at]; }));
  let at = 0;
  const reply = ops.length === 0 ? null : await storage.bulkUpsert(ops.map(function toInterface (op) {
    if (op.remove) return { remove: reads.toFilter(op.remove) };
    return bulkOp(reads.toFilter(op.filter), op.doc, merges[at++]);
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
  // A document P4 sent to one of several records is answered with that one.
  plan.picked.forEach(function (id, index) { if (!inserted.has(index)) docs[index]._id = id; });
  await REPLIES[plan.rule.reply](storageOf, plan, reply);
  return { items: docs.map(function outcome (doc, index) {
    if (skipped.has(index)) return skipped.get(index);
    return item(index, inserted.has(index) ? 'inserted' : plan.rule.onMatch, doc._id, doc.identifier);
  }), adapter: reply };
}

// A planned single document: an upserting replace by its target, then the
// removal of its string twins in a call of its own. Server dates right before.
async function writePlannedOne (storageOf, plan) {
  if (plan.docs.length !== 1) throw new TypeError('This write is of one document, not ' + plan.docs.length);
  if (plan.rule.dates !== 'carry') throw new TypeError('No server-date rule ' + plan.rule.dates + ' for a planned write');
  const doc = plan.docs[0];
  await pickTreatmentTargets(storageOf, plan);
  // on-deleted: a re-send that reaches a deleted record on an identity key is
  // acknowledged (ID-Q4), an edit not applied (ID-Q3); nothing is written.
  const skipped = await plannedOnDeleted(storageOf(), plan);
  if (skipped.has(0)) return { items: [skipped.get(0)], adapter: null };
  const query = plan.targets[0];
  const storage = storageOf();
  const sent = doc.identifier;
  const found = await srvDates.carryForReplace(reads.documents(storage), [{ filter: query, doc: doc }]);
  // identifier-held (ID-RULE1-EDIT), against the record the server-date read
  // found, before the write.
  await refuseHeldIdentifiers(storage, plan.rule, [{ value: sent, submitted: plan.submitted && plan.submitted[0]
    , id: doc._id, stored: found ? found[0] : undefined }]);
  // merge on match (ID-Q8): a create whose target matched is merged into the
  // stored record; a save, or a target that matched nothing, stores the
  // document as sent (an upserting replace).
  const merge = (await mergesOnMatch(storage, plan.rule, [doc], found, plan.kinds))[0];
  const reply = merge ? await mergeOne(storage, query, doc, merge)
    : await storage.replaceFiltered(reads.toFilter(query), doc, { upsert: true, v1: true });
  if (plan.stale[0].length > 0) {
    await storageOf().deleteMany(reads.toFilter({ _id: { $in: plan.stale[0] } }), { v1: true });
  }
  await REPLIES[plan.rule.reply](storageOf, plan, reply);
  const inserted = Boolean(reply) && reply.upsertedCount == 1;
  return { items: [item(0, inserted ? 'inserted' : plan.rule.onMatch, doc._id, doc.identifier)], adapter: reply };
}

// The merge of one matched document (writePlannedOne): an update of the record
// the target names. Should it be gone by then, the document is stored as sent,
// as the replace would have stored it.
async function mergeOne (storage, query, doc, merge) {
  const reply = await storage.updateMany(reads.toFilter(query), { set: merge.set
    , unset: Object.keys(merge.unset).length > 0 ? merge.unset : undefined }, { one: true, v1: true });
  if (reply && reply.matchedCount > 0) return reply;
  return storage.replaceFiltered(reads.toFilter(query), doc, { upsert: true, v1: true });
}

const PLANS = Object.freeze({ documents: planDocuments, entries: planEntries });

// The plan of an intent: the socket's updates name their records by _id; every
// other plan is of documents.
function planOf (rule, intent, env, scope) {
  if (rule.plan === 'socket-update') return planSocketUpdate(rule, intent, scope);
  if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
  return PLANS[rule.plan || 'documents'](rule, intent.docs, env, scope);
}

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
      const match = identifierRule(plan.rule, 'reply', 'last-read');
      try {
        const existing = await reads.findAll(storageOf(), anyOf(identifierMatch({ $in: identifiers }, match.also))
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
  // Where a write comes from, for the rules that name it (identifier-format).
  const scope = Object.freeze({ env: env, name: name, source: source });
  return {
    /**
     * identifier-format (ID-Q6) at the moment a route can still refuse a
     * document: each document's invalid `identifier` is removed (lenient), or,
     * under WRITE_IDENTIFIER=strict on a path that refuses
     * (IDENTIFIER_STRICT), the document is returned for the route to refuse.
     * The step applies the same rule again after its `_id` step, so a route
     * that does not call this still never matches on or stores one.
     * @param {Object[]} docs
     * @returns {{ index: number, problems: Object[] }[]} the documents to refuse
     */
    identifiers: function identifiers (docs) {
      return applyIdentifierFormat(docs, env, name, source, false);
    },
    /**
     * Run the synchronous rules of a create or update now (see
     * planDocuments); write() takes what this returns.
     * @param {Object} intent { op, form, docs }
     * @returns {Object} the planned intent; throws as the rules throw
     */
    plan: function plan (intent) {
      return planOf(ruleOf(name, source, intent), intent, env, scope);
    },
    /**
     * The stored record a create would match, or a PUT or PATCH
     * /{identifier} addresses (API v3's identifying reads, V3_MATCHES), or
     * null; it writes nothing.
     * @param {Object} intent { op: 'create', docs: [doc], fallbackFields } or
     *   { op: 'update' | 'patch', docs: [doc], target: { identifier } }
     */
    match: async function match (intent) {
      const rule = ruleOf(name, source, intent);
      const matchOf = V3_MATCHES[rule.match];
      if (!matchOf) throw new TypeError('No match rule for ' + intent.op + ' on ' + name + ' from ' + source);
      return matchOf(storageOf(), intent, rule, env, name);
    },
    /**
     * on-deleted for the record a create's match() answered: the action the
     * path's rule names for the key that reached it ('acknowledged': answer
     * without a write, the record stays deleted; 'revive': write it), or null
     * when the record is not deleted or the rule has no on-deleted entry.
     * @param {Object} intent { op: 'create', docs: [doc], computedIdentifier }
     *   (computedIdentifier: true when API v3 computed the document's
     *   identifier because none was sent)
     * @param {Object} stored the record match() answered
     */
    onDeleted: function onDeleted (intent, stored) {
      const rule = ruleOf(name, source, intent);
      if (rule.deleted === undefined || !softDeleted.isDeleted(stored)) return null;
      return deletedAction(rule, v3KeyKind(intent, stored), name);
    },
    /**
     * merge on match for the record a POST's match() answered (a live one):
     * 'merged', 'replaced' or 'acknowledged' (v3ResendAction). The route
     * acknowledges on 'acknowledged' and otherwise sends the deduplicating
     * write: write({ op: 'create', docs: [doc], target: { identifier, stored } }).
     * @param {Object} intent { op: 'create', docs: [doc], computedIdentifier }
     * @param {Object} stored the record match() answered
     */
    resendAction: function resendAction (intent, stored) {
      return v3ResendAction(ruleOf(name, source, intent), intent, stored);
    },
    /**
     * identifier-held (ID-RULE1-EDIT) for an API v3 PATCH, before the route's
     * own checks of the body: true when the body's `identifier` is valid,
     * differs from the addressed record's, and another record holds it (the
     * route answers 409 and writes nothing). One read, only in that case.
     * @param {Object} intent { op: 'patch', docs: [doc], target: { stored } }
     */
    identifierHeld: async function identifierHeld (intent) {
      const rule = ruleOf(name, source, intent);
      if (!refusesHeld(rule)) return false;
      const doc = oneV3Doc(intent);
      if (!Object.prototype.hasOwnProperty.call(doc, 'identifier') || !isValidIdentifier(doc.identifier)) return false;
      const stored = intent.target && intent.target.stored;
      if (!stored || stored.identifier === doc.identifier) return false;
      return identifierHeldElsewhere(storageOf(), doc.identifier);
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
        planned = planOf(rule, intent, env, scope);
      }
      if (planned) {
        if (rule.write === 'bulk') result = await writePlannedBatch(storageOf, planned);
        else if (rule.write === 'socket-merge') result = await writeSocketMerge(storageOf, planned, env);
        else if (rule.write === 'socket-unset') result = await writeSocketUnset(storageOf, planned);
        else if (rule.write === 'replace-one') result = await writePlannedOne(storageOf, planned);
        else if (rule.write === 'entries-merge-bulk') result = await writePlannedEntries(storageOf, planned);
        else throw new TypeError('No planned write ' + rule.write);
        const written = { items: result.items, event: null, adapter: result.adapter, prepared: planned.prepared };
        if (result.readBackError !== undefined) written.readBackError = result.readBackError;
        return written;
      }
      // An API v3 create that names the stored record it matched is the POST's
      // deduplicating write (v3-resend).
      const v3Write = source === 'v3' && intent.op === 'create' && intent.target && intent.target.stored ? 'v3-resend' : rule.write;
      if (Object.prototype.hasOwnProperty.call(V3_WRITES, v3Write)) {
        result = await V3_WRITES[v3Write](storageOf(), intent, rule, env, name);
        const written = { items: result.items, event: null, adapter: result.adapter };
        if (result.patched !== undefined) written.patched = result.patched;
        return written;
      }
      if ((intent.op === 'create') && (rule.write === 'statuses' || rule.write === 'profiles')) {
        if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
        result = rule.write === 'statuses' ? await writeStatuses(storageOf, intent.docs, rule, scope)
          : await writeProfiles(storageOf, intent.docs, rule, intent, scope);
        const written = { items: result.items, event: null, adapter: result.adapter };
        if (result.inserted !== undefined) written.inserted = result.inserted;
        if (result.merged !== undefined) written.merged = result.merged;
        if (result.refusedUpdate) written.refusedUpdate = true;
        return written;
      }
      if (intent.op === 'create' || intent.op === 'update') {
        if (!Array.isArray(intent.docs)) throw new TypeError(intent.op + ' needs docs');
        if (rule.write === 'insert-one') result = await insertOneDocument(storageOf, intent.docs, rule, scope);
        else if (rule.write === 'socket-add') result = await writeSocketAdd(storageOf, intent.docs, rule, scope);
        else if (rule.write === 'replace-one') result = await replaceOneDocument(storageOf, intent.docs, rule, scope);
        else result = await replaceDocuments(storageOf, intent.docs, rule, scope);
      } else if (intent.op === 'delete' || intent.op === 'prune') {
        const key = rule.target === 'query' ? 'filter' : '_id';
        const byIdentifier = Boolean(rule.identifier) && Boolean(intent.target)
          && !Object.prototype.hasOwnProperty.call(intent.target, key)
          && Object.prototype.hasOwnProperty.call(intent.target, 'identifier');
        if (!byIdentifier && (!intent.target || !Object.prototype.hasOwnProperty.call(intent.target, key))) {
          throw new TypeError('delete needs target.' + key);
        }
        result = byIdentifier ? await deleteByIdentifier(storageOf, intent.target, rule)
          : await deleteTarget(storageOf, intent.target, rule);
        if (result.removed !== undefined) {
          return { items: result.items, event: null, adapter: result.adapter, removed: result.removed };
        }
      } else {
        throw new TypeError('Unsupported write intent: ' + intent.op);
      }
      return { items: result.items, event: null, adapter: result.adapter };
    }
  };
}

module.exports = { forCollection, COLLECTION_RULES, OUTCOMES, WriteRuleError, identifierMatch, identifierClass
  , isValidIdentifier, PLACEHOLDER_IDENTIFIERS, IDENTIFIER_MAX_LENGTH, p4Pick, P4_TIME_KEYS, STORED_ID
  , IDENTIFIER_HELD, IDENTIFIER_HELD_MESSAGE, IdentifierConflictError, isIdentifierConflict
  , MERGES, ON_DELETED, V3_COMPUTED_IDENTIFIER, IDENTITY_FIELDS, DELETED_REASON, DELETED_RECORD_MESSAGE, DeletedRecordError, isDeletedRecord, keyKind
  , isNotWritten };
