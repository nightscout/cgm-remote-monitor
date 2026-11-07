'use strict';

// A Temporary Target is stored in mg/dL and labelled `units: 'mg/dl'`
// (BF-194). Called by every treatment write path after its domain validation
// (lib/server/write-validation.js), so WRITE_VALIDATION still judges the
// record as the client sent it:
//
// - API v1 POST and PUT, and the in-process ctx.treatments calls, through
//   prepareData (lib/server/treatments.js);
// - API v3 POST and PUT (lib/api3/generic/create/insert.js,
//   lib/api3/generic/update/replace.js) and PATCH
//   (lib/api3/generic/patch/operation.js);
// - the socket's dbAdd and dbUpdate (lib/server/websocket.js).
//
// The rule, for a Temporary Target that carries targetTop and/or
// targetBottom (a positive number):
//
// 1. labelled mmol (`mmol` or `mmol/L`, any case, trimmed): both targets are
//    multiplied by MMOL_TO_MGDL, as the careportal does
//    (lib/client-core/careportal/normalize-treatment.js). A target above
//    MAX_MMOL (30) is already a mg/dL number, the case write-validation's
//    tt-units-plausible names: the numbers are kept, not multiplied again;
// 2. no label, and a target below MIN_MGDL (20): the targets are mmol/L and
//    are converted, the rule Nightscout applies at read time
//    (lib/data/ddata.js);
// 3. otherwise (a mg/dL label, or no label and targets of 20 or more) the
//    numbers are kept.
//
// The label is then `mg/dl`, the spelling write-validation's canonicalUnits,
// ddata and the careportal use. A glucose value on the same record is in the
// units of its label too: it is converted when it is mmol/L by the same
// tests (labelled mmol and not above 30, or unlabelled and below 20), so the
// mg/dl label stays true for it.
//
// Other event types, and a Temporary Target without targets (a cancel), are
// left as they are. Records already stored are not migrated: a partial update
// is converted only when it sends a target, glucose, units or eventType.

const consts = require('./constants');
const validation = require('./server/write-validation');

const TARGETS = ['targetTop', 'targetBottom'];
const TOUCHES = TARGETS.concat(['units', 'glucose', 'eventType']);

function isMmolLabel (units) {
  if (typeof units !== 'string') return false;
  const u = units.trim().toLowerCase();
  return u === 'mmol' || u === 'mmol/l';
}

function isAbsent (value) {
  return value === undefined || value === null || value === '';
}

// The number a field carries, or null when it carries none.
function carried (value) {
  if (isAbsent(value) || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// How a record's glucose numbers are to be read: 'mmol', 'mg/dl', or null
// when the rule does not apply to the record.
function targetsUnits (record) {
  if (!record || record.eventType !== 'Temporary Target') return null;
  const values = TARGETS.map(field => carried(record[field])).filter(v => v !== null);
  if (values.length === 0) return null;
  if (isMmolLabel(record.units)) {
    return values.every(v => v <= validation.MAX_MMOL) ? 'mmol' : 'mg/dl';
  }
  if (isAbsent(record.units)) {
    return values.some(v => v < validation.MIN_MGDL) ? 'mmol' : 'mg/dl';
  }
  return 'mg/dl';
}

function glucoseIsMmol (record) {
  const g = carried(record.glucose);
  if (g === null) return false;
  if (isMmolLabel(record.units)) return g <= validation.MAX_MMOL;
  if (isAbsent(record.units)) return g < validation.MIN_MGDL;
  return false;
}

function touches (doc) {
  return TOUCHES.some(field => Object.prototype.hasOwnProperty.call(doc, field));
}

/**
 * Store a Temporary Target in mg/dL, labelled mg/dl. Changes `doc` in place.
 * @param {Object} doc - the record to store, or for a partial update the
 *   fields it sets (a field set to null is being removed)
 * @param {Object} [stored] - for a partial update, the stored record it
 *   applies to; `doc` then receives every field the conversion changes
 * @returns {boolean} true when the record is a Temporary Target with targets
 *   and `doc.units` is now 'mg/dl'
 */
function normalizeTargetUnits (doc, stored) {
  if (!doc || typeof doc !== 'object') return false;
  if (stored && !touches(doc)) return false;
  const record = stored ? Object.assign({}, stored, doc) : doc;
  const units = targetsUnits(record);
  if (units === null) return false;

  if (units === 'mmol') {
    TARGETS.forEach(field => {
      const value = carried(record[field]);
      if (value !== null) doc[field] = value * consts.MMOL_TO_MGDL;
    });
  }
  if (glucoseIsMmol(record)) {
    doc.glucose = carried(record.glucose) * consts.MMOL_TO_MGDL;
  }
  doc.units = 'mg/dl';
  return true;
}

module.exports = {
  normalizeTargetUnits,
  touches,
  isMmolLabel
};
