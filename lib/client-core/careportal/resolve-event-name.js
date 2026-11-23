'use strict';

/*
 * lib/client-core/careportal/resolve-event-name.js
 *
 * Pure helper extracted from lib/client/careportal.js. Maps a
 * treatment eventType `value` (e.g. "Snack Bolus") through an array
 * of `{ val, name }` records produced from plugins.getAllEventTypes,
 * returning the first matching `name` or the input value if no match.
 *
 * Original implementation looped via _.each and mutated a local
 * variable; this is the same control flow without the lodash dep.
 */

function resolveEventName(value, events) {
  if (!Array.isArray(events)) return value;
  for (var i = 0; i < events.length; i++) {
    if (events[i] && events[i].val === value) {
      return events[i].name;
    }
  }
  return value;
}

module.exports = resolveEventName;
module.exports.resolveEventName = resolveEventName;
