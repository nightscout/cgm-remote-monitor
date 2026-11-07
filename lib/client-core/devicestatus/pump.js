'use strict';

/*
 * lib/client-core/devicestatus/pump.js
 *
 * Pure helper: given a list of pump-bearing devicestatus records
 * (plus an entryMills accessor), pick the one with the latest
 * `pump.clock` timestamp (falling back to the record's own mills
 * when no pump.clock is set). Extracted from the inner setPump()
 * closure in lib/plugins/pump.js (Track 2 / Phase 5b).
 *
 * The plugin still owns the sandbox-flavoured filter
 * (`('pump' in status) && entryMills(status) in [recentMills..now]`)
 * and the per-field rendering — this module only owns the
 * "latest by pump clock, fallback to mills" selection rule.
 *
 * Returns null when the input list is empty (the legacy plugin
 * substitutes an empty object at the call site; this module
 * stays honest about absence).
 */

var defaultMoment = require('moment');

function selectLatestPumpStatus (devicestatuses, opts) {
  opts = opts || {};
  var moment = opts.moment || defaultMoment;

  if (!Array.isArray(devicestatuses) || devicestatuses.length === 0) return null;

  var best = null;
  devicestatuses.forEach(function (status) {
    if (!status) return;
    var clockMills = (status.pump && status.pump.clock)
      ? moment(status.pump.clock).valueOf()
      : status.mills;
    status.clockMills = clockMills;
    if (!best || clockMills > best.clockMills) best = status;
  });
  return best;
}

module.exports = selectLatestPumpStatus;
module.exports.selectLatestPumpStatus = selectLatestPumpStatus;
