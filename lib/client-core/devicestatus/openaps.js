'use strict';

/*
 * lib/client-core/devicestatus/openaps.js
 *
 * Pure reduction over a list of OpenAPS / oref0 / oref1 / AAPS-Android
 * devicestatus records. Extracted from `openaps.analyzeData()` in
 * lib/plugins/openaps.js (Track 2 / Phase 5f, completes the devicestatus
 * extraction matrix begun in Phase 5c).
 *
 * The plugin layer continues to do the sandbox-flavoured filter
 * (`('openaps' in status) && entryMills(status) in [recentMills..now]`)
 * and the `recent = now - warn/2` computation; this module accepts the
 * already-filtered devicestatus list plus the `recent` cutoff moment
 * and reduces them into the property shape the plugin's
 * `updateVisualisation()` and `statusLevel()` callers consume:
 *
 *   { seenDevices, lastEnacted, lastNotEnacted, lastSuggested, lastIOB,
 *     lastMMTune, lastPredBGs, lastLoopMoment, lastEventualBG, status }
 *
 * `moment` must be supplied via `opts.moment` (defaults to the
 * top-level `moment` package). `opts.deviceName` is used to derive
 * the device label from the device URI; defaults to splitting on
 * '://' and '/' (matches lib/utils.js deviceName()).
 *
 * Behaviour preserved exactly from the legacy plugin:
 *   - Mutates input: status.openaps.iob is collapsed from array to
 *     its first element when it arrives as an array, and `.timestamp`
 *     is back-filled from `.time`.
 *   - Mutates lastEnacted / lastNotEnacted / lastSuggested with a
 *     `.moment` field (sandbox consumers read this).
 *   - `lastIOB.moment` is the moment derived from iob.timestamp/mills.
 *   - `seenDevices` is keyed by device URI; per-device `status` is
 *     the latest `momentsToLoopStatus(.., noWarning=true)` result.
 *   - `lastEventualBG` and `lastLoopMoment` follow the
 *     enacted-vs-suggested-most-recent rule.
 *   - Top-level `status` uses momentsToLoopStatus(.., noWarning=false).
 *
 * Note: the legacy plugin intentionally mutated input records (the
 * iob[0] collapse in particular). We preserve that here so plugin
 * downstream code that re-reads `sbx.data.devicestatus` after
 * `setProperties` sees the same shape it always has.
 */

var defaultMoment = require('moment');

function defaultDeviceName (device) {
  var parts = device ? device.split('://') : [];
  var last = parts.length ? parts[parts.length - 1] : 'unknown';
  var firstParts = last.split('/');
  return firstParts.length ? firstParts[0] : last;
}

function toMoments (status, moment) {
  var enacted = false;
  var notEnacted = false;
  if (status.openaps.enacted && status.openaps.enacted.timestamp && (status.openaps.enacted.recieved || status.openaps.enacted.received)) {
    if (status.openaps.enacted.mills) {
      enacted = moment(status.openaps.enacted.mills);
    } else {
      enacted = moment(status.openaps.enacted.timestamp);
    }
  } else if (status.openaps.enacted && status.openaps.enacted.timestamp && !(status.openaps.enacted.recieved || status.openaps.enacted.received)) {
    if (status.openaps.enacted.mills) {
      notEnacted = moment(status.openaps.enacted.mills);
    } else {
      notEnacted = moment(status.openaps.enacted.timestamp);
    }
  }

  var suggested = false;
  if (status.openaps.suggested && status.openaps.suggested.mills) {
    suggested = moment(status.openaps.suggested.mills);
  } else if (status.openaps.suggested && status.openaps.suggested.timestamp) {
    suggested = moment(status.openaps.suggested.timestamp);
  }

  var iob = false;
  if (status.openaps.iob && status.openaps.iob.mills) {
    iob = moment(status.openaps.iob.mills);
  } else if (status.openaps.iob && status.openaps.iob.timestamp) {
    iob = moment(status.openaps.iob.timestamp);
  }

  return {
    when: moment(status.mills)
    , enacted: enacted
    , notEnacted: notEnacted
    , suggested: suggested
    , iob: iob
  };
}

function momentsToLoopStatus (moments, noWarning, recent) {
  var status = {
    symbol: '⚠'
    , code: 'warning'
    , label: 'Warning'
  };

  if (moments.notEnacted && (
      (moments.enacted && moments.notEnacted.isAfter(moments.enacted)) || (!moments.enacted && moments.notEnacted.isAfter(recent)))) {
    status.symbol = 'x';
    status.code = 'notenacted';
    status.label = 'Not Enacted';
  } else if (moments.enacted && moments.enacted.isAfter(recent)) {
    status.symbol = '⌁';
    status.code = 'enacted';
    status.label = 'Enacted';
  } else if (moments.suggested && moments.suggested.isAfter(recent)) {
    status.symbol = '↻';
    status.code = 'looping';
    status.label = 'Looping';
  } else if (moments.when && (noWarning || moments.when.isAfter(recent))) {
    status.symbol = '◉';
    status.code = 'waiting';
    status.label = 'Waiting';
  }

  return status;
}

function normalizeIOB (status) {
  if (status && status.openaps && Array.isArray(status.openaps.iob) && status.openaps.iob.length > 0) {
    status.openaps.iob = status.openaps.iob[0];
    if (status.openaps.iob.time) {
      status.openaps.iob.timestamp = status.openaps.iob.time;
    }
  }
  return status;
}

function selectOpenAPSState (devicestatuses, recent, opts) {
  opts = opts || {};
  var moment = opts.moment || defaultMoment;
  var deviceName = opts.deviceName || defaultDeviceName;

  var result = {
    seenDevices: {}
    , lastEnacted: null
    , lastNotEnacted: null
    , lastSuggested: null
    , lastIOB: null
    , lastMMTune: null
    , lastPredBGs: null
  };

  if (!Array.isArray(devicestatuses)) {
    result.status = momentsToLoopStatus({}, false, recent);
    return result;
  }

  function getDevice (status) {
    var uri = status.device || 'device';
    var device = result.seenDevices[uri];
    if (!device) {
      device = { name: deviceName(uri), uri: uri };
      result.seenDevices[uri] = device;
    }
    return device;
  }

  devicestatuses.forEach(function (status) {
    if (!status || !status.openaps) return;
    normalizeIOB(status);

    var device = getDevice(status);
    var moments = toMoments(status, moment);
    var loopStatus = momentsToLoopStatus(moments, true, recent);

    if (!device.status || moments.when.isAfter(device.status.when)) {
      device.status = loopStatus;
      device.status.when = moments.when;
    }

    var enacted = status.openaps && status.openaps.enacted;
    if (enacted && moments.enacted && (!result.lastEnacted || moments.enacted.isAfter(result.lastEnacted.moment))) {
      if (enacted.mills) {
        enacted.moment = moment(enacted.mills);
      } else {
        enacted.moment = moment(enacted.timestamp);
      }
      result.lastEnacted = enacted;
      if (enacted.predBGs && (!result.lastPredBGs || enacted.moment.isAfter(result.lastPredBGs.moment))) {
        result.lastPredBGs = Array.isArray(enacted.predBGs) ? { values: enacted.predBGs } : enacted.predBGs;
        result.lastPredBGs.moment = enacted.moment;
      }
    }

    if (enacted && moments.notEnacted && (!result.lastNotEnacted || moments.notEnacted.isAfter(result.lastNotEnacted.moment))) {
      if (enacted.mills) {
        enacted.moment = moment(enacted.mills);
      } else {
        enacted.moment = moment(enacted.timestamp);
      }
      result.lastNotEnacted = enacted;
    }

    var suggested = status.openaps && status.openaps.suggested;
    if (suggested && moments.suggested && (!result.lastSuggested || moments.suggested.isAfter(result.lastSuggested.moment))) {
      if (suggested.mills) {
        suggested.moment = moment(suggested.mills);
      } else {
        suggested.moment = moment(suggested.timestamp);
      }
      result.lastSuggested = suggested;
      if (suggested.predBGs && (!result.lastPredBGs || suggested.moment.isAfter(result.lastPredBGs.moment))) {
        result.lastPredBGs = Array.isArray(suggested.predBGs) ? { values: suggested.predBGs } : suggested.predBGs;
        result.lastPredBGs.moment = suggested.moment;
      }
    }

    var iob = status.openaps && status.openaps.iob;
    if (moments.iob && (!result.lastIOB || moment(iob.timestamp).isAfter(result.lastIOB.moment))) {
      iob.moment = moments.iob;
      result.lastIOB = iob;
    }

    if (status.mmtune && status.mmtune.timestamp) {
      status.mmtune.moment = moment(status.mmtune.timestamp);
      if (!device.mmtune || moments.when.isAfter(device.mmtune.moment)) {
        device.mmtune = status.mmtune;
      }
    }
  });

  if (result.lastEnacted && result.lastSuggested) {
    if (result.lastEnacted.moment.isAfter(result.lastSuggested.moment)) {
      result.lastLoopMoment = result.lastEnacted.moment;
      result.lastEventualBG = result.lastEnacted.eventualBG;
    } else {
      result.lastLoopMoment = result.lastSuggested.moment;
      result.lastEventualBG = result.lastSuggested.eventualBG;
    }
  } else if (result.lastEnacted && result.lastEnacted.moment) {
    result.lastLoopMoment = result.lastEnacted.moment;
    result.lastEventualBG = result.lastEnacted.eventualBG;
  } else if (result.lastSuggested && result.lastSuggested.moment) {
    result.lastLoopMoment = result.lastSuggested.moment;
    result.lastEventualBG = result.lastSuggested.eventualBG;
  }

  result.status = momentsToLoopStatus({
    enacted: result.lastEnacted && result.lastEnacted.moment
    , notEnacted: result.lastNotEnacted && result.lastNotEnacted.moment
    , suggested: result.lastSuggested && result.lastSuggested.moment
  }, false, recent);

  return result;
}

module.exports = selectOpenAPSState;
module.exports.selectOpenAPSState = selectOpenAPSState;
module.exports.momentsToLoopStatus = momentsToLoopStatus;
module.exports.toMoments = toMoments;
module.exports.normalizeIOB = normalizeIOB;
