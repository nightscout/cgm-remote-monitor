'use strict';

// The clinical tables a tenant restore reconciles (logical-restore.js), one per
// domain, each named after its domain in that domain's namespace. The restore
// census (lib/server/serve/operation-cohort.js) treats a database identity that
// holds any privilege on one of these tables as a clinical actor.
const HISTORY = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'settings']);
const CLINICAL = Object.freeze([...HISTORY, 'activity']);

module.exports = { HISTORY, CLINICAL };
