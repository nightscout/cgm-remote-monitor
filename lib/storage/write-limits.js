'use strict';

// The fixed cap shared by API v1, the socket, API v3, autoPrune and storage.
// It is not a setting and changes only after a measurement.
const RESOLVE_CAP = 1000;

module.exports = Object.freeze({ RESOLVE_CAP });
