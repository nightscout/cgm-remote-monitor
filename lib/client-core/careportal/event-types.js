'use strict';

/*
 * lib/client-core/careportal/event-types.js
 *
 * Pure builders for the `events` and `inputMatrix` tables that
 * careportal derives from `client.plugins.getAllEventTypes(sbx)`.
 *
 * The DOM-coupled adapter (lib/client/careportal.js) still calls the
 * plugin system to source `allEventTypes`; this module captures the
 * pure shape transforms so they are unit-testable and reusable.
 *
 * - buildEvents(allEventTypes)        → [{ val, name }, ...]
 * - buildInputMatrix(allEventTypes)   → { [val]: { otp, carbs, ... } }
 * - buildSubmitHooks(allEventTypes)   → { [val]: submitHookFn }
 *
 * Pick lists mirror the original lodash _.pick keys exactly.
 */

var INPUT_KEYS = [
  'otp', 'remoteCarbs', 'remoteAbsorption', 'remoteBolus'
  , 'bg', 'insulin', 'carbs', 'protein', 'fat'
  , 'prebolus', 'duration', 'percent', 'absolute'
  , 'profile', 'split', 'sensor', 'reasons', 'targets'
];

function pick(obj, keys) {
  var out = {};
  keys.forEach(function (k) {
    /* eslint-disable security/detect-object-injection */
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      out[k] = obj[k];
    }
    /* eslint-enable security/detect-object-injection */
  });
  return out;
}

function buildEvents(allEventTypes) {
  if (!Array.isArray(allEventTypes)) return [];
  return allEventTypes.map(function (e) { return pick(e, ['val', 'name']); });
}

function buildInputMatrix(allEventTypes) {
  var matrix = {};
  if (!Array.isArray(allEventTypes)) return matrix;
  allEventTypes.forEach(function (e) {
    if (e && e.val) {
      /* eslint-disable-next-line security/detect-object-injection */
      matrix[e.val] = pick(e, INPUT_KEYS);
    }
  });
  return matrix;
}

function buildSubmitHooks(allEventTypes) {
  var hooks = {};
  if (!Array.isArray(allEventTypes)) return hooks;
  allEventTypes.forEach(function (e) {
    if (e && e.val) {
      /* eslint-disable-next-line security/detect-object-injection */
      hooks[e.val] = e.submitHook;
    }
  });
  return hooks;
}

module.exports = {
  INPUT_KEYS: INPUT_KEYS
  , buildEvents: buildEvents
  , buildInputMatrix: buildInputMatrix
  , buildSubmitHooks: buildSubmitHooks
};
