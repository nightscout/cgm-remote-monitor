'use strict';

// Domain rules a written record must satisfy whatever client wrote it, applied
// on the server's write paths when WRITE_VALIDATION is set (lib/server/env.js):
//
// - off (the default): nothing is checked and nothing changes;
// - log: a record that breaks a rule is stored as today, and the server logs
//   which rule it broke (the field names, never the values);
// - reject: a record that breaks a rule is refused with 400 and a message
//   naming the rule, and the spelling of a known `units` value is stored in
//   the form Nightscout and its clients compare against (`mmol`, `mg/dl`).
//
// Only rules that hold for every client belong here: a structural or
// physical fact about the record (targets are numbers, the low target is not
// above the high one, a value is plausible for the units it declares). Ranges
// a controller chooses for itself, such as the temp target limits an AID
// applies, stay with the controller.
//
// The first rules cover Temporary Target treatments. A record labelled
// `mmol` whose targets are mg/dL numbers is read by a client that trusts the
// label as eighteen times too high, and dropped or misdrawn without an error
// anywhere.

// AndroidAPS string-matches API v3 400 bodies: "Bad or missing utcOffset
// field" makes it resend with utcOffset 0, and "cannot be modified by the
// client" marks the record as never uploadable. A refusal message must
// contain neither, so it takes AndroidAPS's ordinary 400 path (logged and
// dropped); tests/write-validation.test.js checks every message.
var MODES = ['off', 'log', 'reject'];

// Above this, a target labelled mmol/L is a mg/dL number (30 mmol/L is
// about 540 mg/dL); below MIN_MGDL a target labelled mg/dL is a mmol/L number
// (20 mg/dL is about 1.1 mmol/L). Neither is a usable glucose target.
var MAX_MMOL = 30;
var MIN_MGDL = 20;

function mode (env) {
  var value = env && env.writeValidation;
  return MODES.indexOf(value) > -1 ? value : 'off';
}

function parseMode (value) {
  if (typeof value !== 'string') return 'off';
  value = value.trim().toLowerCase();
  return MODES.indexOf(value) > -1 ? value : 'off';
}

// The canonical spelling of a glucose units value, or null when it is not one.
function canonicalUnits (units) {
  if (typeof units !== 'string') return null;
  var u = units.trim().toLowerCase();
  if (u === 'mmol' || u === 'mmol/l') return 'mmol';
  if (u === 'mg/dl' || u === 'mgdl') return 'mg/dl';
  return null;
}

function isTemporaryTarget (doc) {
  return !!doc && doc.eventType === 'Temporary Target';
}

function present (doc, field) {
  return Object.prototype.hasOwnProperty.call(doc, field)
    && doc[field] !== undefined && doc[field] !== null && doc[field] !== '';
}

function isFiniteNumber (value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function problem (rule, field, message) {
  return { rule: rule, field: field, message: message };
}

// A cancel is a Temporary Target with duration 0; it carries no targets.
function isCancel (doc) {
  if (present(doc, 'durationInMilliseconds')) return doc.durationInMilliseconds === 0;
  return present(doc, 'duration') && doc.duration === 0;
}

function checkTemporaryTarget (doc) {
  var problems = [];

  ['duration', 'durationInMilliseconds'].forEach(function (field) {
    if (present(doc, field) && !(isFiniteNumber(doc[field]) && doc[field] >= 0)) {
      problems.push(problem('tt-duration', field,
        field + ' must be a number of zero or more'));
    }
  });

  var units = null;
  if (present(doc, 'units')) {
    units = canonicalUnits(doc.units);
    if (!units) {
      problems.push(problem('tt-units', 'units', 'units must be mg/dl or mmol'));
    }
  }

  if (isCancel(doc)) return problems;

  var targetsOk = true;
  ['targetBottom', 'targetTop'].forEach(function (field) {
    if (!(isFiniteNumber(doc[field]) && doc[field] > 0)) {
      targetsOk = false;
      problems.push(problem('tt-target', field,
        field + ' must be a number above zero'));
    }
  });
  if (!targetsOk) return problems;

  if (doc.targetBottom > doc.targetTop) {
    problems.push(problem('tt-order', 'targetBottom',
      'targetBottom must not be above targetTop'));
  }

  ['targetBottom', 'targetTop'].forEach(function (field) {
    if (units === 'mmol' && doc[field] > MAX_MMOL) {
      problems.push(problem('tt-units-plausible', field,
        field + ' is labelled units mmol but is above ' + MAX_MMOL
        + ', so it is a mg/dL value: send units mg/dl, or ' + field + ' in mmol/L'));
    } else if (units === 'mg/dl' && doc[field] < MIN_MGDL) {
      problems.push(problem('tt-units-plausible', field,
        field + ' is labelled units mg/dl but is below ' + MIN_MGDL
        + ', so it is a mmol/L value: send units mmol, or ' + field + ' in mg/dL'));
    }
  });

  return problems;
}

// The rules a treatment breaks, as [{rule, field, message}]; empty when none.
function checkTreatment (doc) {
  if (!isTemporaryTarget(doc)) return [];
  return checkTemporaryTarget(doc);
}

// Store a known units value in its canonical spelling (reject mode only).
function normalizeUnits (doc) {
  if (!isTemporaryTarget(doc) || !present(doc, 'units')) return;
  var units = canonicalUnits(doc.units);
  if (units) doc.units = units;
}

function describe (problems) {
  return problems.map(function (p) { return p.message; }).join('; ');
}

// Rule names and fields only: the values are health data.
function logLine (path, doc, problems) {
  var ref = doc && (doc.identifier || doc._id || doc.created_at || doc.date);
  return 'WRITE_VALIDATION ' + path + ': treatment ' + String(ref) + ' ('
    + doc.eventType + ') breaks ' + problems.map(function (p) {
      return p.rule + ':' + p.field;
    }).join(', ');
}

function ValidationError (problems) {
  var err = new Error('Temporary Target: ' + describe(problems));
  err.name = 'WriteValidationError';
  err.status = 400;
  err.problems = problems;
  return err;
}

// The reply slot for an item a v1 batch refused: the item as sent, without
// `_id` (it was not stored), and `refused`. Old clients read `_id` and skip
// the rest; the WeakSet tells the route which slots are refusals, so a
// client field named `refused` is never counted as one.
var refusals = new WeakSet();

function refusal (doc, problems) {
  var slot = Object.assign({}, doc);
  delete slot._id;
  slot.refused = {
    status: 400,
    message: 'Temporary Target: ' + describe(problems),
    rules: problems.map(function (p) { return { rule: p.rule, field: p.field }; })
  };
  refusals.add(slot);
  return slot;
}

function isRefusal (slot) {
  return !!slot && typeof slot === 'object' && refusals.has(slot);
}

function isValidationError (err) {
  return !!err && err.name === 'WriteValidationError';
}

module.exports = {
  MODES: MODES,
  MAX_MMOL: MAX_MMOL,
  MIN_MGDL: MIN_MGDL,
  mode: mode,
  parseMode: parseMode,
  canonicalUnits: canonicalUnits,
  checkTreatment: checkTreatment,
  normalizeUnits: normalizeUnits,
  describe: describe,
  logLine: logLine,
  ValidationError: ValidationError,
  refusal: refusal,
  isRefusal: isRefusal,
  isValidationError: isValidationError
};
