'use strict';

// Resident window marks (decision stateful-evaluator-resident-window), behind
// the temporary switch NS_EVALUATOR_RESIDENT_WINDOW=1.
//
// The writer's pending mark (lib/writer-driven mark, one UPDATE in the
// writer's transaction) also records what the transaction changed in the
// evaluator's clinical window: per time-bounded domain the lowest stored
// window time it touched (LEAST), whether it touched a profile, and whether
// its effect is unbounded (anything this module was not told exactly).
//
// Nothing here is a hint and nothing is a cursor: the marks sit on the
// evaluator's completed-work row beside work_observed, and are only ever read
// together with it. Their life follows the existing version fence:
//
//   - window_mark_version is the sum of work_observed after the last mark
//     that maintained these columns. A mark that did not (a writer without
//     the switch, a control observation) moves work_observed and not the
//     version, so the row reads as unsynchronized and the evaluator takes a
//     full read.
//   - A mark that finds everything observed already completed
//     (sum(work_completed) = sum(work_observed)) starts afresh: earlier marks
//     were consumed by the completion that covered their versions. Otherwise
//     it accumulates. So a write committed while a cycle runs keeps its mark:
//     its version is above what that cycle completes.
//
// The evaluator never writes these columns.
const { AsyncLocalStorage } = require('node:async_hooks');

const SWITCH = 'NS_EVALUATOR_RESIDENT_WINDOW';
function enabled (source = process.env) {
  const raw = source?.[SWITCH];
  if (raw === undefined || raw === '' || raw === '0') return false;
  if (raw !== '1') throw new TypeError('invalid ' + SWITCH + ': 0 or 1 is required');
  return true;
}

// The stored window time of each time-bounded domain (migration 0001 of each
// table; lib/storage/clinical-working-set-policy.js RANGE).
const TIMED = Object.freeze({
  entries: Object.freeze({ column: '"date"', numeric: true }),
  devicestatus: Object.freeze({ column: 'created_at', numeric: false }),
  treatments: Object.freeze({ column: 'created_at', numeric: false })
});
// Domains whose rows are never in the clinical window (its filters select none).
const OUTSIDE = new Set(['food', 'activity']);
const COLUMNS = Object.freeze(['window_mark_version', 'window_mark_full', 'window_mark_profile',
  'window_mark_entries', 'window_mark_devicestatus', 'window_mark_treatments']);

// COLLATE "C": UTF-8 byte order, which is code point order.
function compareC (a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    if (x < 0xD800 && y < 0xD800) return x - y;
    return a.codePointAt(i) - b.codePointAt(i);
  }
  return a.length - b.length;
}

// What one write transaction changed, noted by the storage writer as it goes.
// A transaction that notes nothing, or anything inexact, is unbounded.
const notes = new AsyncLocalStorage();
const empty = () => ({ touched: false, full: false, profile: false, entries: null, devicestatus: null, treatments: null });
async function collect (fn) {
  const state = empty();
  const value = await notes.run(state, fn);
  return { value, window: state };
}
// value: the row's stored window time as PostgreSQL returned it (bigint text
// for entries, text otherwise); null or undefined when the row has none or it
// is not known, which is unbounded.
function note (domain, value) {
  const state = notes.getStore();
  if (!state) return;
  state.touched = true;
  if (OUTSIDE.has(domain)) return;
  if (domain === 'profile') { state.profile = true; return; }
  const spec = TIMED[domain];
  if (!spec || value === null || value === undefined) { state.full = true; return; }
  if (spec.numeric) {
    if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(value)) { state.full = true; return; }
    if (state[domain] === null || BigInt(value) < BigInt(state[domain])) state[domain] = value;
  } else {
    if (typeof value !== 'string') { state.full = true; return; }
    if (state[domain] === null || compareC(value, state[domain]) < 0) state[domain] = value;
  }
}
function unbounded () {
  const state = notes.getStore();
  if (state) { state.touched = true; state.full = true; }
}
// A statement that ran and changed no row.
function touch () {
  const state = notes.getStore();
  if (state) state.touched = true;
}

// The mark's parameters ($5..$9). No notes, or an inexact one: unbounded.
function values (window) {
  if (!window || window.touched !== true || window.full) return [true, false, null, null, null];
  return [false, window.profile === true, window.entries, window.devicestatus, window.treatments];
}

// The SET clauses appended to the pending mark for source index i (1-based).
// Every right-hand side reads the row as it was before this UPDATE.
// The sum of a work row's six source versions (the arrays' cardinality is
// fixed by the catalogue), as plain arithmetic: the mark runs on every write.
const total = column => '(' + [1, 2, 3, 4, 5, 6].map(i => 'COALESCE(' + column + '[' + i + '],0)').join('+') + ')';
function assignments (i) {
  const old = 'COALESCE(work_observed[' + i + '],0)';
  const next = 'GREATEST(' + old + '+1,$3::bigint)';
  const fresh = '(' + total('work_completed') + '=' + total('work_observed') + ')';
  const text = (column, n) => column + '=CASE WHEN ' + fresh + ' THEN $' + n + '::text ELSE LEAST(' + column + ',$' + n + '::text COLLATE "C") END';
  return ',window_mark_version=CASE WHEN ' + fresh + ' OR window_mark_version=' + total('work_observed') +
      ' THEN ' + total('work_observed') + '-' + old + '+' + next + ' END' +
    ',window_mark_full=CASE WHEN ' + fresh + ' THEN $5::boolean ELSE window_mark_full OR $5::boolean END' +
    ',window_mark_profile=CASE WHEN ' + fresh + ' THEN $6::boolean ELSE window_mark_profile OR $6::boolean END' +
    ',window_mark_entries=CASE WHEN ' + fresh + ' THEN $7::bigint ELSE LEAST(window_mark_entries,$7::bigint) END,' +
    text('window_mark_devicestatus', 8) + ',' + text('window_mark_treatments', 9);
}

module.exports = { SWITCH, TIMED, COLUMNS, enabled, compareC, collect, note, unbounded, touch, values, assignments, total };
