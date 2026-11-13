'use strict';

// The clinical tables a tenant restore reconciles (logical-restore.js), one per
// domain, each named after its domain in that domain's namespace. The restore
// census (lib/server/serve/operation-cohort.js) treats a database identity that
// holds any privilege on one of these tables as a clinical actor.
const HISTORY = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'settings']);
const CLINICAL = Object.freeze([...HISTORY, 'activity']);
// The counters a restore advances beside the clinical tables: the per-domain
// insertion order (tenant-insertion-sql.js) and the tenant write clock
// (postgres-write-clock). The census refuses a non-participant identity that can
// WRITE either (16.0.0 decision restore-census-counter-writers); reading them is
// not refused.
const COUNTERS = Object.freeze(['tenant_insertion_ordinal', 'tenant_write_clock']);

module.exports = { HISTORY, CLINICAL, COUNTERS };
