'use strict';

// ID-BATCH: per-item results in API v1 batch replies (design note
// docs/30-design/platform/id-batch-design-note-2026-10-30.md in the alignment
// repository, rules R1-R6; reply rules (ii)-(vi), ID-STRICT-V1 and the
// taken-_id row decided by the maintainer on 2026-10-30).
//
// R1: one slot per submitted item, in order. A route plans the batch here
// (which items it refuses before the write), writes the rest, and builds the
// reply from one result per submitted index: the refusal, or the document
// the write step stored together with the step's own item for it
// (lib/server/write-items.js). Never from the array the storage answered,
// which holds only the items that reached the write.
//
// Without the opt-in the slots are what each route answered before: the
// stored document, or a refused slot (`refused: { status, message, rules }`,
// lib/server/write-validation.js). What the decisions add to that default:
//   - ID-STRICT-V1: under WRITE_IDENTIFIER=strict an item whose identifier
//     is invalid is refused in its slot (400), the rest written.
// (The preBolus record left out of the reply, BF-219, and a taken _id
// refused 409 in its slot, BF-220, were already built into the storage
// modules before ID-BATCH.)
//
// The opt-in, decision (ii): the request header
//   Nightscout-Write-Results: items
// or the query parameter ?results=items. The reply is then
//   { items: [{ index, outcome, _id, identifier, reason?, status?, warnings }],
//     documents: [ ...the slots... ] }
// and, only for a request that asks:
//   - R2: a non-hex _id refuses its item, not the whole batch;
//   - (iii): a profile re-send that needs api:profile:update the token lacks
//     is refused 403 in its slot and the permitted items are stored
//     (lib/api/profile);
//   - (vi): a re-send the step recognised and did not write (a deleted
//     record's re-send, a device status already stored or repeated in the
//     batch) has the outcome `acknowledged`;
//   - R6: a Warning: 299 header counting refused, acknowledged and
//     ignored-identifier items.
// R3, status: 200 when any item is not refused; 400 when every item is
// refused, except that a batch whose every refusal is a taken _id (409)
// answers 200 (decided 2026-10-30: such an item can never be stored, and a
// client re-sends a refused batch). R4: a failure the step cannot attribute
// stays a whole-request 5xx, which the routes send before reaching here.

var writeIntent = require('../../storage/write-intent');
var writeSettings = require('../../server/write-settings');
var writeValidation = require('../../server/write-validation');
var writeItems = require('../../server/write-items');
var objectIdValidation = require('./objectid-validation');

var HEADER = 'nightscout-write-results';
var QUERY = 'results';
var SHAPE = 'items';

// The opt-in a request made: null (none), { optIn: true, via }, or
// { error } for a value other than `items` (answered 400 before any write).
function requested (req) {
  var header = req.get ? req.get(HEADER) : req.headers && req.headers[HEADER];
  var query = req.query && req.query[QUERY];
  var via = header !== undefined && header !== '' ? 'header' : typeof query === 'string' && query !== '' ? 'query' : null;
  if (!via) return null;
  var value = String(via === 'header' ? header : query).trim().toLowerCase();
  if (value !== SHAPE) {
    return { error: 'Nightscout-Write-Results (or ?results=) must be "' + SHAPE + '"' };
  }
  return { optIn: true, via: via };
}

function sendRequestError (res, wanted) {
  res.status(400).json({ status: 400, message: 'Invalid write-results request', description: wanted.error });
}

// The wording of write-intent.js's IDENTIFIER_PROBLEMS, which the socket and
// API v3 refusals carry (a test holds the two equal).
var IDENTIFIER_PROBLEMS = Object.freeze({
  null: 'identifier is null'
  , 'not-a-string': 'identifier is not a string'
  , blank: 'identifier is empty'
  , 'over-length': 'identifier is longer than ' + writeIntent.IDENTIFIER_MAX_LENGTH + ' characters'
  , placeholder: 'identifier is a placeholder'
});

function identifierRefusal (doc, kind) {
  return writeValidation.refusal(doc, [{ rule: 'identifier-format', field: 'identifier', message: IDENTIFIER_PROBLEMS[kind] }]
    , 'identifier');
}

function objectIdRefusal (doc) {
  return writeValidation.refusedSlot(doc, { status: 400, message: 'Invalid _id format'
    , rules: [{ rule: 'objectid-format', field: '_id' }] });
}

/**
 * Plan a v1 batch: which items are refused before the write, and which are
 * written. Call after the route's own preparation (purification, defaults),
 * so a refused slot is the item as the route would have written it.
 * @param {Object[]} docs the submitted items, in order
 * @param {Object} opts
 * @param {Object} opts.env the server env (WRITE_IDENTIFIER)
 * @param {boolean} opts.optIn the request asked for per-item results
 * @param {boolean} [opts.objectId] the route refuses a non-hex _id (per item
 *   under the opt-in; without it the route keeps its whole-batch 400)
 * @param {function} [opts.domain] the step's domain check, [{ index, problems }]
 *   (treatments, under the opt-in)
 * @returns {Object} the plan
 */
function plan (docs, opts) {
  var refusals = new Map();
  var ignored = new Set();
  var strict = writeSettings.identifierMode(opts.env) === 'strict';
  docs.forEach(function each (doc, index) {
    if (opts.optIn && opts.objectId && !objectIdValidation.isValidObjectId(doc._id)) {
      refusals.set(index, objectIdRefusal(doc));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(doc, 'identifier')) {
      var kind = writeIntent.identifierClass(doc.identifier);
      if (kind === 'valid') return;
      // ID-STRICT-V1: strict refuses on v1; otherwise the step treats the
      // value as absent, which the opt-in counts.
      if (strict) refusals.set(index, identifierRefusal(doc, kind));
      else ignored.add(index);
    }
  });
  if (opts.optIn && typeof opts.domain === 'function') {
    var at = [];
    var checked = docs.filter(function (doc, index) {
      if (refusals.has(index)) return false;
      at.push(index);
      return true;
    });
    opts.domain(checked).forEach(function each (r) {
      refusals.set(at[r.index], writeValidation.refusal(checked[r.index], r.problems));
    });
  }
  var accepted = [];
  var positions = [];
  docs.forEach(function each (doc, index) {
    if (refusals.has(index)) return;
    positions.push(index);
    accepted.push(doc);
  });
  return { n: docs.length, docs: docs, refusals: refusals, ignored: ignored, accepted: accepted, positions: positions };
}

// The step's item words for a re-send it recognised and did not write.
var ACKNOWLEDGED = ['already stored', 'repeated in the batch'];

function itemOf (index, slot, doc) {
  var refused = slot && slot.refused ? slot.refused : null;
  var stepItem = writeItems.of(doc);
  if (refused) {
    return { index: index, outcome: 'refused', _id: null
      , identifier: doc && typeof doc.identifier === 'string' ? doc.identifier : null
      , reason: refused.message, status: refused.status, warnings: [] };
  }
  var outcome = stepItem ? stepItem.outcome : null;
  var reason = stepItem ? stepItem.reason : 'the write step reported no item';
  if (stepItem && ((outcome === 'refused' && ACKNOWLEDGED.indexOf(stepItem.reason) !== -1) || writeIntent.isNotWritten(stepItem))) {
    outcome = 'acknowledged';
  }
  var entry = { index: index, outcome: outcome, _id: slot && slot._id !== undefined && slot._id !== null ? slot._id : null
    , identifier: slot && typeof slot.identifier === 'string' ? slot.identifier : null, warnings: [] };
  if (reason !== undefined) entry.reason = reason;
  if (outcome === 'acknowledged') entry.warnings.push('acknowledged, not applied');
  return entry;
}

/**
 * Build the reply from one result per submitted index.
 * @param {Object} batch what plan() returned
 * @param {Object[]} written the storage's answer for batch.accepted, slot for
 *   slot (an empty array when nothing reached the write)
 * @param {Object} opts
 * @param {boolean} opts.optIn
 * @param {string} opts.noun the collection's word in the default Warning
 * @param {function} [opts.defaultWarning] (refusedCount, n, slots) -> the
 *   route's own Warning text before ID-BATCH, or undefined
 * @returns {{ status: number, slots: Object[], items: Object[]|null, warning: string|null,
 *   refused: number, allRefused: boolean, body: * }}
 */
function build (batch, written, opts) {
  var slots = [];
  var items = [];
  var counts = { refused: 0, conflicts: 0, acknowledged: 0, ignored: 0 };
  for (var index = 0; index < batch.n; index++) {
    var slot;
    var doc = batch.docs[index];
    if (batch.refusals.has(index)) {
      slot = batch.refusals.get(index);
    } else {
      slot = written[batch.positions.indexOf(index)];
    }
    slots.push(slot);
    var refused = slot && slot.refused ? slot.refused : null;
    if (refused) {
      counts.refused++;
      if (refused.status === 409) counts.conflicts++;
    }
    if (opts.optIn) {
      var entry = itemOf(index, slot, doc);
      if (entry.outcome === 'acknowledged') counts.acknowledged++;
      if (batch.ignored.has(index)) {
        entry.warnings.push('identifier ignored');
        counts.ignored++;
      }
      items.push(entry);
    }
  }
  var allRefused = batch.n > 0 && counts.refused === batch.n;
  var status = allRefused && counts.conflicts !== batch.n ? 400 : 200;
  var warning = null;
  if (opts.optIn) {
    var parts = [];
    if (counts.refused) parts.push(counts.refused + ' of ' + batch.n + ' items refused');
    if (counts.acknowledged) parts.push(counts.acknowledged + ' acknowledged, not applied');
    if (counts.ignored) parts.push(counts.ignored + ' identifier ignored');
    if (parts.length) warning = '299 - "' + parts.join(', ') + '"';
  } else if (counts.refused) {
    var own = opts.defaultWarning ? opts.defaultWarning(counts.refused, batch.n, slots) : undefined;
    warning = own !== undefined ? own
      : '299 - "' + counts.refused + ' of ' + batch.n + ' ' + opts.noun + ' refused; see the refused member of each"';
  }
  return { status: status, slots: slots, items: opts.optIn ? items : null, warning: warning
    , refused: counts.refused, allRefused: allRefused
    , body: opts.optIn ? { items: items, documents: slots } : slots };
}

/**
 * Send what build() made. A default batch whose every item is refused
 * (status 400) is answered as a single refusal is: the status and the
 * refusals' messages, not the slots (lib/api/treatments did so before).
 */
function send (res, reply, opts) {
  if (reply.warning) res.set('Warning', reply.warning);
  if (reply.status === 400 && !(opts && opts.optIn)) {
    var messages = [];
    reply.slots.forEach(function (slot) {
      var m = slot && slot.refused && slot.refused.message;
      if (m && messages.indexOf(m) === -1) messages.push(m);
    });
    return res.sendJSONStatus(res, 400, messages.join('; '));
  }
  res.status(reply.status).json(reply.body);
}

module.exports = {
  HEADER: HEADER
  , QUERY: QUERY
  , IDENTIFIER_PROBLEMS: IDENTIFIER_PROBLEMS
  , requested: requested
  , sendRequestError: sendRequestError
  , plan: plan
  , build: build
  , send: send
};
