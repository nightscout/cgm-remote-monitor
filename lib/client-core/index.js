'use strict';

/*
 * lib/client-core/index.js
 *
 * Aggregator for the pure, DOM-free client logic. Files under
 * `lib/client-core/` MUST NOT require jQuery, jsdom, window,
 * document, or any DOM APIs. They take plain values in and return
 * plain values out, so they can be unit-tested with vanilla mocha
 * (see tests/client-core/).
 *
 * See docs/proposals/testing-modernization-proposal.md (Track 2)
 * and the session plan for the full extraction list.
 */

module.exports = {
  careportal: {
    validate: require('./careportal/validate'),
    resolveEventName: require('./careportal/resolve-event-name'),
    buildConfirmText: require('./careportal/confirm-text'),
    normalizeTreatment: require('./careportal/normalize-treatment'),
    eventTypes: require('./careportal/event-types')
  },
  profileEditor: {
    buildDefaultProfile: require('./profile-editor/default-profile'),
    timeUtils: require('./profile-editor/time-utils'),
    migrate: require('./profile-editor/migrate'),
    records: require('./profile-editor/records'),
    profiles: require('./profile-editor/profiles'),
    ranges: require('./profile-editor/ranges')
  },
  devicestatus: {
    classifyUploader: require('./devicestatus/uploader'),
    selectLoopState: require('./devicestatus/loop'),
    selectLatestPumpStatus: require('./devicestatus/pump'),
    selectOpenAPSState: require('./devicestatus/openaps')
  }
};
