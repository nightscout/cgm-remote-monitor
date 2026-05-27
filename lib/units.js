'use strict';

var consts = require('./constants');

function mgdlToMMOL(mgdl) {
  return (Math.round((mgdl / consts.MMOL_TO_MGDL) * 10) / 10).toFixed(1);
}

function mmolToMgdl(mmol) {
  return Math.round(mmol * consts.MMOL_TO_MGDL);
}

function normalizeGlucoseUnit (unit) {
  if (!unit) return null;
  var normalized = String(unit).toLowerCase().trim();
  if (['mg', 'mg/dl', 'mgdl', 'mg dl'].indexOf(normalized) !== -1) return 'mgdl';
  if (['mmol', 'mmol/l', 'mmoll', 'mmol l'].indexOf(normalized) !== -1) return 'mmol';
  return null;
}

// Uses value and unit hint to guess the unit. Returns null if no guess can be made.
function guessUnitFromValueAndHint(value, unitHint) {
  if (!value || value <= 0) return null;
  var recognized = normalizeGlucoseUnit(unitHint);
  if (recognized) return recognized;
  if (value >= 40) return 'mgdl';
  if (value <= 25) return 'mmol';
  return null;
}

// Which interpretation is numerically closer to a known mg/dL reference.
function guessUnitByProximity(glucoseValue, refMgdl) {
  return Math.abs(glucoseValue - refMgdl) < Math.abs(mmolToMgdl(glucoseValue) - refMgdl) ? 'mgdl' : 'mmol';
}

function configure() {
  return {
    mgdlToMMOL: mgdlToMMOL
    , mmolToMgdl: mmolToMgdl
    , normalizeGlucoseUnit: normalizeGlucoseUnit
    , guessUnitFromValueAndHint: guessUnitFromValueAndHint
    , guessUnitByProximity: guessUnitByProximity
  };
}

module.exports = configure;