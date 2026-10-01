'use strict';

/*
 * lib/client-core/devicestatus/loop.js
 *
 * Pure reduction over a list of Loop-emitted devicestatus records.
 * Extracted from `loop.analyzeData()` in lib/plugins/loop.js
 * (Track 2 / Phase 5b).
 *
 * The plugin layer continues to do the sandbox-flavoured filter
 * (`('loop' in status) && entryMills(status) in [recentMills..now]`)
 * and `recent = now - warn/2` computation; this module accepts the
 * already-filtered devicestatus list and reduces it into the
 * { lastLoop, lastEnacted, lastPredicted, lastOverride, lastOkMoment,
 * display } shape the sandbox property consumers expect.
 *
 * `moment` must be supplied via `opts.moment` (defaults to the
 * top-level `moment` package). This keeps the module loadable in
 * environments that vendor moment differently.
 *
 * Behaviour preserved exactly:
 *   - mutates `status.loop.moment` (sandbox consumers read this)
 *   - mutates `enacted.moment` and `override.moment`
 *   - lastOkMoment is the latest moment among non-failureReason
 *     statuses
 *   - display symbol logic matches getDisplayForStatus() in the
 *     legacy plugin (warning / error / enacted / recommendation /
 *     looping)
 */

var defaultMoment = require('moment');

function buildDisplay (status, recent, moment) {
  moment = moment || defaultMoment;
  var desc = { symbol: '⚠', code: 'warning', label: 'Warning' };
  if (!status) return desc;

  if (status.failureReason || (status.enacted && !status.enacted.received)) {
    return { symbol: 'x', code: 'error', label: 'Error' };
  }
  if (status.enacted && moment(status.timestamp).isAfter(recent)) {
    return { symbol: '⌁', code: 'enacted', label: 'Enacted' };
  }
  if (status.recommendedTempBasal && moment(status.recommendedTempBasal.timestamp).isAfter(recent)) {
    return { symbol: '⏀', code: 'recommendation', label: 'Recomendation' };
  }
  if (status.moment && status.moment.isAfter(recent)) {
    return { symbol: '↻', code: 'looping', label: 'Looping' };
  }
  return desc;
}

function selectLoopState (devicestatuses, recent, opts) {
  opts = opts || {};
  var moment = opts.moment || defaultMoment;

  var result = {
    lastLoop: null
    , lastEnacted: null
    , lastPredicted: null
    , lastOverride: null
    , lastOkMoment: null
  };

  if (!Array.isArray(devicestatuses)) {
    result.display = buildDisplay(null, recent, moment);
    return result;
  }

  devicestatuses.forEach(function (status) {
    if (!status || !status.loop || !status.loop.timestamp) return;

    var loopStatus = status.loop;
    loopStatus.moment = moment(loopStatus.timestamp);

    var enacted = loopStatus.enacted;
    if (enacted && enacted.timestamp) {
      enacted.moment = moment(enacted.timestamp);
      if (!result.lastEnacted || enacted.moment.isAfter(result.lastEnacted.moment)) {
        result.lastEnacted = enacted;
      }
    }

    if (!result.lastLoop || loopStatus.moment.isAfter(result.lastLoop.moment)) {
      result.lastLoop = loopStatus;
    }

    if (loopStatus.predicted && loopStatus.predicted.startDate) {
      result.lastPredicted = loopStatus.predicted;
    }

    var override = status.override;
    if (override && override.timestamp) {
      override.moment = moment(override.timestamp);
      if (!result.lastOverride || override.moment.isAfter(result.lastOverride.moment)) {
        result.lastOverride = override;
      }
    }

    if (!loopStatus.failureReason && (!result.lastOkMoment || loopStatus.moment.isAfter(result.lastOkMoment))) {
      result.lastOkMoment = loopStatus.moment;
    }
  });

  result.display = buildDisplay(result.lastLoop, recent, moment);
  return result;
}

module.exports = selectLoopState;
module.exports.selectLoopState = selectLoopState;
module.exports.buildDisplay = buildDisplay;
