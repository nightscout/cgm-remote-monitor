'use strict';

/*
 * lib/client-core/careportal/confirm-text.js
 *
 * Pure builder for the careportal "please verify" confirmation text.
 * Extracted from lib/client/careportal.js (Track 2 / Phase 5a).
 *
 * Signature:
 *   build(data, { translate, units, resolveEventName, MMOL_TO_MGDL, now })
 *
 * - `translate` defaults to identity (i18n is the adapter's job).
 * - `resolveEventName` defaults to identity (adapter wires the lookup).
 * - `now` defaults to `new Date()` for `data.eventTime` fallback.
 *
 * Returns the same `\n`-joined string the original produced; field
 * order, conditional logic and mmol rounding match the source.
 */

var consts = require('../../constants');

function identity(x) { return x; }

function build(data, opts) {
  opts = opts || {};
  var translate = opts.translate || identity;
  var resolveEventName = opts.resolveEventName || identity;
  var units = opts.units;
  var MMOL_TO_MGDL = opts.MMOL_TO_MGDL || consts.MMOL_TO_MGDL;
  var now = opts.now || new Date();

  var text = [
    translate('Please verify that the data entered is correct') + ': '
    , translate('Event Type') + ': ' + translate(resolveEventName(data.eventType))
  ];

  function pushIf(check, valueText) {
    if (check) text.push(valueText);
  }

  if (data.duration === 0 && data.eventType === 'Temporary Target') {
    text[text.length - 1] += ' ' + translate('Cancel');
  }

  pushIf(data.remoteCarbs, translate('Remote Carbs') + ': ' + data.remoteCarbs);
  pushIf(data.remoteAbsorption, translate('Remote Absorption') + ': ' + data.remoteAbsorption);
  pushIf(data.remoteBolus, translate('Remote Bolus') + ': ' + data.remoteBolus);
  pushIf(data.otp, translate('One Time Pascode') + ': ' + data.otp);

  pushIf(data.glucose, translate('Blood Glucose') + ': ' + data.glucose);
  pushIf(data.glucose, translate('Measurement Method') + ': ' + translate(data.glucoseType));

  pushIf(data.reason, translate('Reason') + ': ' + data.reason);

  var targetTop = data.targetTop;
  var targetBottom = data.targetBottom;
  if (units === 'mmol') {
    targetTop = Math.round(data.targetTop / MMOL_TO_MGDL * 10) / 10;
    targetBottom = Math.round(data.targetBottom / MMOL_TO_MGDL * 10) / 10;
  }
  pushIf(data.targetTop, translate('Target Top') + ': ' + targetTop);
  pushIf(data.targetBottom, translate('Target Bottom') + ': ' + targetBottom);

  pushIf(data.carbs, translate('Carbs Given') + ': ' + data.carbs);
  pushIf(data.protein, translate('Protein Given') + ': ' + data.protein);
  pushIf(data.fat, translate('Fat Given') + ': ' + data.fat);
  pushIf(data.sensorCode, translate('Sensor Code') + ': ' + data.sensorCode);
  pushIf(data.transmitterId, translate('Transmitter ID') + ': ' + data.transmitterId);
  pushIf(data.insulin, translate('Insulin Given') + ': ' + data.insulin);
  pushIf(data.eventType === 'Combo Bolus', translate('Combo Bolus') + ': ' + data.splitNow + '% : ' + data.splitExt + '%');
  pushIf(data.duration, translate('Duration') + ': ' + data.duration + ' ' + translate('mins'));
  pushIf(data.percent, translate('Percent') + ': ' + data.percent);
  pushIf('absolute' in data, translate('Basal value') + ': ' + data.absolute);
  pushIf(data.profile, translate('Profile') + ': ' + data.profile);
  pushIf(data.preBolus, translate('Carb Time') + ': ' + data.preBolus + ' ' + translate('mins'));
  pushIf(data.notes, translate('Notes') + ': ' + data.notes);
  pushIf(data.enteredBy, translate('Entered By') + ': ' + data.enteredBy);

  text.push(translate('Event Time') + ': ' + (data.eventTime ? data.eventTime.toLocaleString() : now.toLocaleString()));
  return text.join('\n');
}

module.exports = build;
module.exports.build = build;
