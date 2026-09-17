'use strict';

/*
 * lib/client-core/devicestatus/uploader.js
 *
 * Pure classifier: given a single Nightscout devicestatus document,
 * return which uploader produced it. Used by the devicestatus
 * plugin family for routing and by reports / dashboards that want
 * to colour-code the controller in use.
 *
 * Classification rules (first match wins):
 *   - has a `loop` block          → 'loop'
 *   - has an `openaps` block      → 'openaps'      (covers AAPS too;
 *     callers that need AAPS-vs-OpenAPS disambiguation should look
 *     at `device` / `uploader.bundleIdentifier` themselves)
 *   - has only a `pump` block     → 'pump'
 *   - device string starts with   → matches accordingly
 *     'loop://', 'openaps://', 'aaps://'
 *   - otherwise                   → 'unknown'
 *
 * The function is non-throwing and accepts undefined / null.
 */

function classifyUploader (ds) {
  if (!ds || typeof ds !== 'object') return 'unknown';

  if (ds.loop && typeof ds.loop === 'object') return 'loop';
  if (ds.openaps && typeof ds.openaps === 'object') return 'openaps';

  var device = typeof ds.device === 'string' ? ds.device : '';
  if (device.indexOf('loop://') === 0) return 'loop';
  if (device.indexOf('aaps://') === 0) return 'openaps';
  if (device.indexOf('openaps://') === 0) return 'openaps';

  if (ds.pump && typeof ds.pump === 'object') return 'pump';

  return 'unknown';
}

module.exports = classifyUploader;
module.exports.classifyUploader = classifyUploader;
