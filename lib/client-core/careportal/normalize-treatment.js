'use strict';

/*
 * lib/client-core/careportal/normalize-treatment.js
 *
 * Pure normalization for careportal treatment data. Extracted from
 * the gatherData() closure in lib/client/careportal.js (Track 2 /
 * Phase 5a). The DOM-coupled adapter still reads the form values via
 * jQuery and assembles them into a `raw` object — this module then:
 *
 *   - finds the matching reason in inputMatrix and adds reasonDisplay
 *   - upconverts mmol target values to mg/dL (validate + send always
 *     work in mg/dL)
 *   - sets data.absolute when explicitly provided (supports temp-to-0)
 *   - resolves data.created_at from eventTime (or now)
 *   - drops profile when the event type doesn't support it
 *   - normalises Temp Basal and Temporary Target Cancel event names
 *   - copies splitNow/splitExt for Combo Bolus
 *   - strips empty / null / undefined fields from the result
 *
 * Behavior matches the original gatherData() exactly (same field
 * order, same special cases) so the legacy careportal.test.js and
 * the bundle pathway continue to behave identically.
 *
 * Signature:
 *   normalize(raw, opts)
 *     raw  — plain object with the fields read from the form
 *            (eventType, reason, glucose, targets, carbs, etc.) plus
 *            optional eventTime (Date), absolute (string), splitNow/
 *            splitExt (string).
 *     opts — { units, MMOL_TO_MGDL, inputMatrix, now }
 *
 * Returns a new plain object (does not mutate `raw`).
 */

var consts = require('../../constants');

function normalize(raw, opts) {
  opts = opts || {};
  var units = opts.units;
  var MMOL_TO_MGDL = opts.MMOL_TO_MGDL || consts.MMOL_TO_MGDL;
  var inputMatrix = opts.inputMatrix || {};
  var now = opts.now || new Date();

  // Shallow copy to avoid mutating the adapter's bag
  var data = {};
  Object.keys(raw).forEach(function (k) { data[k] = raw[k]; });

  // preBolus → integer or removed
  data.preBolus = parseInt(data.preBolus);
  if (isNaN(data.preBolus)) delete data.preBolus;

  // Reason lookup → reasonDisplay
  var reasons = [];
  if (Object.prototype.hasOwnProperty.call(inputMatrix, raw.eventType)) {
    /* eslint-disable-next-line security/detect-object-injection */
    reasons = inputMatrix[raw.eventType].reasons || [];
  }
  for (var i = 0; i < reasons.length; i++) {
    if (reasons[i] && reasons[i].name === raw.reason) {
      data.reasonDisplay = reasons[i].displayName;
      break;
    }
  }

  // mmol target → mg/dL (downstream code always assumes mg/dL)
  if (units === 'mmol') {
    if (data.targetTop !== '' && data.targetTop != null) data.targetTop = data.targetTop * MMOL_TO_MGDL;
    if (data.targetBottom !== '' && data.targetBottom != null) data.targetBottom = data.targetBottom * MMOL_TO_MGDL;
  }

  // absolute: only set when adapter explicitly passes a non-empty numeric string.
  // The adapter is responsible for reading $('#absolute').val() and forwarding
  // it via raw.absoluteRaw; this keeps the "0 is valid" case alive.
  if (raw.absoluteRaw !== undefined) {
    if (raw.absoluteRaw !== '' && !isNaN(raw.absoluteRaw)) {
      data.absolute = Number(raw.absoluteRaw);
    }
    delete data.absoluteRaw;
  }

  // created_at always present
  data.created_at = data.eventTime ? data.eventTime.toISOString() : now.toISOString();

  // profile is meaningless for event types that don't accept it
  if (inputMatrix[data.eventType] && !inputMatrix[data.eventType].profile) {
    delete data.profile;
  }

  // eventType fixups
  if (typeof data.eventType === 'string') {
    if (data.eventType.indexOf('Temp Basal') > -1) {
      data.eventType = 'Temp Basal';
    }
    if (data.eventType.indexOf('Temporary Target Cancel') > -1) {
      data.duration = 0;
      data.eventType = 'Temporary Target';
      data.targetBottom = '';
      data.targetTop = '';
    }
    if (data.eventType.indexOf('Combo Bolus') > -1) {
      data.splitNow = parseInt(raw.splitNowRaw) || 0;
      data.splitExt = parseInt(raw.splitExtRaw) || 0;
    }
  }
  delete data.splitNowRaw;
  delete data.splitExtRaw;

  // Strip empty / null fields — same predicate the original used.
  var cleaned = {};
  Object.keys(data).forEach(function (key) {
    /* eslint-disable security/detect-object-injection */
    if (data[key] !== '' && data[key] !== null) {
      cleaned[key] = data[key];
    }
    /* eslint-enable security/detect-object-injection */
  });

  return cleaned;
}

module.exports = normalize;
module.exports.normalize = normalize;
