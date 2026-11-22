'use strict';

// The evaluator's resident clinical window (decision
// stateful-evaluator-resident-window), behind NS_EVALUATOR_RESIDENT_WINDOW=1.
//
// A resident is one tenant's window rows as last read, in the full read's
// order, with what the read saw of the tenant's work row. The next read
// brings it up to date from the writer's window marks
// (lib/writer-driven/window-mark.js) instead of reading every row again:
//
//   plan()    decides, from the work row read in the same snapshot as the
//             rows, between a full read and a tail read per marked domain;
//   apply()   replaces each marked domain's rows at or after its mark with
//             the rows just read, and drops what left the window by time;
//   build()   makes the resident from a full read;
//   compare() counts the differences between a resident and a full read (the
//             self-check);
//   read()    one read: plan, tail or full read through the caller's reader,
//             apply, and the self-check on its schedule.
//
// This module holds no SQL and no clock. A resident is exact or it is not
// used: every doubt is a full read.
const { isDeepStrictEqual } = require('node:util');
const { compareC, TIMED } = require('../writer-driven/window-mark');
const { selectRows } = require('./projection-memory-read');

const INTEGER = /^(0|[1-9][0-9]*)$/;
const sum = values => values.reduce((total, value) => total + (value === null || value === undefined ? 0n : BigInt(value)), 0n);
const full = reason => Object.freeze({ full: true, reason });
const compareRows = (a, b) => compareC(a.domain, b.domain) || compareC(a.id_kind, b.id_kind) || compareC(a.id, b.id);
// A row's stored window time against a bound of its domain's type.
const below = (domain, time, bound) => TIMED[domain].numeric ? BigInt(time) < BigInt(bound) : compareC(time, bound) < 0;

// mark: the tenant's work row as read in this snapshot: observed and completed
// (the six source versions, text or null), version (window_mark_version, text
// or null) and the window marks. membership: clinical-working-set-policy
// membership(policy), null when the policy is not bounded.
function plan ({ resident, tenant, generation, policy, mark, membership }) {
  if (!membership) return full('policy-not-bounded');
  if (!resident) return full('no-resident');
  // A resident belongs to the tenant it was read for, whoever hands it back.
  if (typeof tenant !== 'string' || resident.tenant !== tenant) return full('tenant');
  if (resident.generation !== generation) return full('generation');
  if (resident.policy.devicestatusMs !== policy.devicestatusMs || policy.at < resident.policy.at) return full('policy');
  if (!mark || !Array.isArray(mark.observed) || !Array.isArray(mark.completed) || mark.observed.length !== resident.seen.length ||
      mark.completed.length !== resident.seen.length) return full('no-work-row');
  // A mark that did not maintain the window columns moved work_observed and
  // not the version: what it changed is not known.
  const observed = sum(mark.observed);
  if (typeof mark.version !== 'string' || !INTEGER.test(mark.version) || BigInt(mark.version) !== observed) return full('marks-not-current');
  for (let i = 0; i < resident.seen.length; i++) {
    const seen = resident.seen[i] ?? null, now = mark.observed[i] ?? null, done = mark.completed[i] ?? null;
    if (seen !== null && (now === null || BigInt(now) < BigInt(seen))) return full('work-row-replaced');
    // The marks start afresh once everything observed is completed. They cover
    // this resident only while nothing was completed that it has not read.
    if (done !== null && (seen === null || BigInt(done) > BigInt(seen))) return full('completed-beyond-resident');
  }
  // Everything observed is completed, and this resident read all of it: the
  // marks on the row are already in the resident.
  if (sum(mark.completed) === observed) return Object.freeze({ full: false, from: Object.freeze({}), profile: false, consumed: true });
  if (mark.full !== false) return full('unbounded-change');
  const from = {};
  for (const domain of Object.keys(TIMED)) {
    const value = mark[domain];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' || (TIMED[domain].numeric && !/^-?(0|[1-9][0-9]*)$/.test(value))) return full('mark-invalid');
    from[domain] = value;
  }
  return Object.freeze({ full: false, from: Object.freeze(from), profile: mark.profile === true, consumed: false });
}

// rows: stored rows as read ({ domain, id_kind, doc, ordinal, wt, bytes }),
// wt the stored window time as text (null where the domain has none).
function prepared (row) {
  if (!row || typeof row.domain !== 'string' || (row.id_kind !== 'string' && row.id_kind !== 'objectid') ||
      typeof row.doc?._id !== 'string' || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('RESIDENT_WINDOW_ROW');
  const timed = TIMED[row.domain];
  if (timed && row.wt !== null && (typeof row.wt !== 'string' || (timed.numeric && !/^-?(0|[1-9][0-9]*)$/.test(row.wt)))) throw new Error('RESIDENT_WINDOW_ROW');
  return { domain: row.domain, id_kind: row.id_kind, id: row.doc._id, doc: row.doc, ordinal: row.ordinal ?? null,
    wt: timed ? row.wt : null, bytes: row.bytes };
}
const ordered = rows => rows.every((row, i) => i === 0 || compareRows(rows[i - 1], row) < 0);

// The rows of `rows` that are in the window at policy.at. Rows only leave by
// time: every bound rises with the instant. null when a row cannot be placed.
function members (rows, membership) {
  const undecided = [];
  const state = rows.map(row => {
    const rule = membership[row.domain];
    if (!rule) return true;
    if (row.wt === null) return null;
    if (!below(row.domain, row.wt, String(rule.recent))) return true;
    if (!rule.ast || below(row.domain, row.wt, String(rule.lowest))) return false;
    undecided.push(row);
    return undefined;
  });
  if (state.includes(null)) return null;
  if (!undecided.length) return rows.filter((row, i) => state[i]);
  // Between the lowest event bound and the recent bound the whole filter
  // decides, as it does in PostgreSQL (the policy's event arms).
  const byDomain = new Map();
  for (const row of undecided) { if (!byDomain.has(row.domain)) byDomain.set(row.domain, []); byDomain.get(row.domain).push(row); }
  const selected = new Set();
  for (const [domain, list] of byDomain) for (const row of selectRows(list, membership[domain].ast)) selected.add(row);
  return rows.filter((row, i) => state[i] === true || (state[i] === undefined && selected.has(row)));
}

function finish (rows, { tenant, generation, policy, mark, checkAt }) {
  return Object.freeze({ tenant, rows, generation, policy: Object.freeze({ at: policy.at, devicestatusMs: policy.devicestatusMs }),
    seen: Object.freeze(mark.observed.map(value => value ?? null)), checkAt,
    bytes: rows.reduce((total, row) => total + row.bytes, 0) });
}

// A resident from a full read. null when the rows are not in the order this
// module merges by, or the work row was not read: then every read is full.
function build ({ rows, tenant, generation, policy, mark, membership, checkAt }) {
  if (!membership || !mark || !Array.isArray(mark.observed) || typeof tenant !== 'string') return null;
  const list = rows.map(prepared);
  if (!ordered(list) || list.some(row => membership[row.domain] && row.wt === null)) return null;
  return finish(list, { tenant, generation, policy, mark, checkAt });
}

// The resident brought up to date. delta: the rows read at or after each
// marked domain's mark (and the profile row when marked). null when anything
// does not fit: the caller reads in full.
function apply ({ resident, plan: selected, delta, generation, policy, mark, membership }) {
  if (!resident || !selected || selected.full !== false || !membership) return null;
  const incoming = delta.map(prepared).sort(compareRows);
  for (const row of incoming) {
    if (row.domain === 'profile') { if (!selected.profile) return null; continue; }
    const bound = selected.from[row.domain];
    if (bound === undefined || row.wt === null || below(row.domain, row.wt, bound)) return null;
  }
  const kept = [];
  for (const row of resident.rows) {
    if (row.domain === 'profile') { if (!selected.profile) kept.push(row); continue; }
    const bound = selected.from[row.domain];
    if (bound === undefined) { kept.push(row); continue; }
    if (row.wt === null) return null;
    if (below(row.domain, row.wt, bound)) kept.push(row);
  }
  const merged = [];
  let i = 0, j = 0;
  while (i < kept.length || j < incoming.length) {
    const order = i >= kept.length ? 1 : j >= incoming.length ? -1 : compareRows(kept[i], incoming[j]);
    if (order === 0) return null; // one identity on both sides of its domain's mark
    merged.push(order < 0 ? kept[i++] : incoming[j++]);
  }
  if (!ordered(merged)) return null;
  const rows = members(merged, membership);
  if (!rows) return null;
  return finish(rows, { tenant: resident.tenant, generation, policy, mark, checkAt: resident.checkAt });
}

// The self-check: a resident's rows against a full read's, identity by
// identity in order. A difference is a missing, extra or unequal row.
function compare (residentRows, fullRows) {
  const expected = fullRows.map(prepared);
  let differences = 0, i = 0, j = 0;
  while (i < residentRows.length || j < expected.length) {
    const order = i >= residentRows.length ? 1 : j >= expected.length ? -1 : compareRows(residentRows[i], expected[j]);
    if (order < 0) { differences++; i++; continue; }
    if (order > 0) { differences++; j++; continue; }
    const a = residentRows[i++], b = expected[j++];
    if (a.wt !== b.wt || String(a.ordinal) !== String(b.ordinal) || a.bytes !== b.bytes || !isDeepStrictEqual(a.doc, b.doc)) differences++;
  }
  if (!ordered(expected)) differences++;
  return differences;
}

// One read of a tenant's window with a resident. readRows(selected): the
// window rows of the plan's marked domains at or after their marks, or with
// null every row of the window; both in the caller's one snapshot, which also
// read `mark`. checkMs: how often the result is compared with a full read (0:
// every time). Returns the window rows, the resident for the next read (null
// when none can be kept) and what was done.
async function read ({ resident, tenant, generation, policy, mark, membership, readRows, checkMs, counters, random = Math.random, warn = () => {} }) {
  const count = (key, n = 1) => { if (counters) counters[key] = (counters[key] || 0) + n; };
  const because = reason => { if (counters) counters.reasons[reason] = (counters.reasons[reason] || 0) + 1; };
  const selected = plan({ resident, tenant, generation, policy, mark, membership });
  let next = null, fullRows = null, mode = 'full';
  if (!selected.full) {
    const reads = Object.keys(selected.from).length > 0 || selected.profile;
    const delta = reads ? await readRows(selected) : [];
    next = apply({ resident, plan: selected, delta, generation, policy, mark, membership });
    mode = reads ? 'tail' : 'unchanged';
    if (!next) { mode = 'full'; because('tail-refused'); }
    else if (checkMs === 0 || policy.at >= resident.checkAt) {
      // The self-check: the guard against a missed invalidation. A difference
      // is counted and the tenant is repaired from the full read.
      fullRows = await readRows(null);
      count('checks');
      const differences = compare(next.rows, fullRows);
      if (differences) { count('differences', differences); warn(differences); next = null; mode = 'full'; because('self-check'); }
      else next = Object.freeze({ ...next, checkAt: policy.at + checkMs });
    }
  } else because(selected.reason);
  let rows;
  if (next) rows = next.rows;
  else {
    if (!fullRows) fullRows = await readRows(null);
    // The first check of a resident falls anywhere in the second half of the
    // interval, so the checks of a slice's tenants do not arrive together.
    next = build({ rows: fullRows, tenant, generation, policy, mark, membership, checkAt: policy.at + Math.ceil(checkMs * (0.5 + random() / 2)) });
    rows = next ? next.rows : fullRows.map(prepared);
  }
  count(mode);
  return { rows, resident: next, mode };
}

module.exports = { plan, build, apply, compare, members, compareRows, read };
