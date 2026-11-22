'use strict';

// An in-process stand-in for the level window read with a resident
// (lib/storage/postgres-durable-replay.js residentLevelWindow), for the
// evaluator differentials that run without PostgreSQL. It holds one tenant's
// stored rows and work row, applies the writer's window mark as the mark's
// UPDATE does (lib/writer-driven/window-mark.js assignments), and answers
// replay.window through the product's own resident-window read: plan, tail or
// full read, apply, self-check. Rows are read as PostgreSQL returns them: in
// (domain, id kind, _id) order, each a fresh frozen JSON value with its stored
// window time.
//
// select(rows, policy): the window's membership over stored rows (the
// product's clinical-working-set-policy select by default). membership(policy):
// the same rule for rows already read. shape({ rows, policy, state }): the
// remaining fields of the recovered window.
const residentWindow = require('../../../lib/storage/resident-window');
const windowPolicy = require('../../../lib/storage/clinical-working-set-policy');
const { compareC, TIMED } = require('../../../lib/writer-driven/window-mark');
const { decodeDocument } = require('../../../lib/storage/postgres-identity');
const { deepFreeze } = require('../../../lib/data/json-copy');

const SOURCES = 6, CLOCK = 0;
// The stored window time columns (migration 0001 of each windowed table).
function windowTime (domain, doc) {
  const spec = TIMED[domain];
  if (!spec) return null;
  const value = doc[spec.numeric ? 'date' : 'created_at'];
  const list = Array.isArray(value) ? value : [value];
  if (spec.numeric) {
    const numbers = list.filter(v => typeof v === 'number' && Number.isFinite(v)).map(v => BigInt(Math.floor(v)));
    return numbers.length ? String(numbers.reduce((a, b) => (b > a ? b : a))) : null;
  }
  const strings = list.filter(v => typeof v === 'string');
  return strings.length ? strings.reduce((a, b) => (compareC(b, a) > 0 ? b : a)) : null;
}
// Every stored row is in the window: for a differential whose reference
// window applies no policy.
const EVERYTHING = Object.freeze({ entries: { recent: '-9223372036854775808', lowest: '-9223372036854775808', ast: null },
  devicestatus: { recent: '', lowest: '', ast: null }, treatments: { recent: '', lowest: '', ast: null } });

module.exports = function memoryReplay ({ tenant, generation = '1', resident: residentOn = true, checkMs = 0,
  select = (rows, policy) => windowPolicy.select(rows, policy), membership = policy => windowPolicy.membership(policy), shape } = {}) {
  const rows = new Map();
  const work = { observed: Array(SOURCES).fill(null), completed: Array(SOURCES).fill(null), version: null, full: false, profile: false,
    entries: null, devicestatus: null, treatments: null };
  const counters = { full: 0, tail: 0, unchanged: 0, rowsRead: 0, checks: 0, differences: 0, reasons: {} };
  const state = { generation, stamp: 0, calls: 0 };
  let ordinal = 0;
  const sum = values => values.reduce((total, value) => total + (value === null ? 0n : BigInt(value)), 0n);
  const least = (domain, a, b) => a === null ? b : b === null ? a : (TIMED[domain].numeric ? (BigInt(b) < BigInt(a) ? b : a) : (compareC(b, a) < 0 ? b : a));

  // One write transaction: its row changes and its pending mark, together.
  // changes: [{ domain, id_kind, doc }] to store, [{ domain, id_kind, _id, remove: true }] to delete.
  // aware: false is a writer that does not maintain the window columns.
  // exact: false is a writer that notes nothing (an unbounded mark).
  function write (changes, { aware = true, exact = true, at } = {}) {
    const noted = { full: !exact, profile: false, entries: null, devicestatus: null, treatments: null };
    const note = (domain, doc) => {
      if (domain === 'profile') { noted.profile = true; return; }
      if (!TIMED[domain]) return;
      const time = windowTime(domain, doc);
      if (time === null) noted.full = true; else noted[domain] = least(domain, noted[domain], time);
    };
    for (const change of changes) {
      const id = change.remove ? change._id : change.doc._id;
      const k = change.domain + '\u0000' + change.id_kind + '\u0000' + id, old = rows.get(k);
      if (old) note(change.domain, old.doc);
      if (change.remove) { rows.delete(k); continue; }
      const doc = JSON.parse(JSON.stringify(change.doc));
      if (change.ordinal > ordinal) ordinal = change.ordinal;
      rows.set(k, { domain: change.domain, id_kind: change.id_kind, doc, ordinal: change.ordinal ?? old?.ordinal ?? ++ordinal });
      note(change.domain, doc);
    }
    const fresh = sum(work.completed) === sum(work.observed), synchronized = work.version !== null && BigInt(work.version) === sum(work.observed);
    work.observed[CLOCK] = String((work.observed[CLOCK] === null ? 0n : BigInt(work.observed[CLOCK])) + 1n);
    if (at !== undefined) state.stamp = at;
    if (!aware) return;
    work.version = fresh || synchronized ? String(sum(work.observed)) : null;
    work.full = fresh ? noted.full : work.full || noted.full;
    work.profile = fresh ? noted.profile : work.profile || noted.profile;
    for (const domain of Object.keys(TIMED)) work[domain] = fresh ? noted[domain] : least(domain, work[domain], noted[domain]);
  }
  const begin = () => [...work.observed];
  function complete (observed) { work.completed = [...observed]; }

  // The stored rows as a read returns them: fresh frozen values, in read order.
  function stored () {
    return [...rows.values()].map(row => { const text = JSON.stringify(row.doc);
      return { domain: row.domain, id_kind: row.id_kind, id: row.doc._id, doc: deepFreeze(JSON.parse(text)), ordinal: row.ordinal,
        wt: windowTime(row.domain, row.doc), bytes: Buffer.byteLength(text) }; }).sort(residentWindow.compareRows);
  }
  function readRows (policy, selected) {
    let source = stored();
    if (selected) source = source.filter(row => row.domain === 'profile' ? selected.profile
      : selected.from[row.domain] !== undefined && row.wt !== null &&
        (TIMED[row.domain].numeric ? BigInt(row.wt) >= BigInt(selected.from[row.domain]) : compareC(row.wt, selected.from[row.domain]) >= 0));
    const chosen = new Set(select(source, policy));
    const out = source.filter(row => chosen.has(row));
    counters.rowsRead += out.length;
    return out;
  }
  const mark = () => ({ observed: [...work.observed], completed: [...work.completed], version: work.version, full: work.full, profile: work.profile,
    entries: work.entries, devicestatus: work.devicestatus, treatments: work.treatments });

  async function window ({ policy, resident, stored: asStored }) {
    state.calls++;
    let list, next = null, mode = 'full';
    if (residentOn) ({ rows: list, resident: next, mode } = await residentWindow.read({ resident: resident ?? null, tenant, generation: state.generation, policy,
      mark: mark(), membership: membership(policy), checkMs, counters, readRows: selected => readRows(policy, selected) }));
    else list = readRows(policy, null);
    const visible = list.filter(row => row.doc.isValid !== false);
    const base = shape ? shape({ rows: visible, policy, state }) : { checkpoint: state.stamp, progress: 'level-window', signature: { stamp: state.stamp, deleted: 0 },
      generation: state.generation, policy, expiresAt: residentOn ? residentWindow.nextExpiry(visible, policy) : windowPolicy.nextExpiry(visible, policy) };
    return { ...base, rows: asStored === true && residentOn ? visible.map(row => ({ domain: row.domain, id_kind: row.id_kind, doc: row.doc, ordinal: row.ordinal }))
      : visible.map(row => ({ domain: row.domain, document: decodeDocument(row), ordinal: row.ordinal })),
      ...(residentOn ? { rowTextBytes: residentWindow.textBytes(visible), resident: next, residentMode: mode } : {}) };
  }
  return { state, work, counters, write, begin, complete, windowTime,
    replay: { level: true, residentWindow: residentOn, window, async reconcile () { throw new Error('A level component reads its window'); } } };
};
module.exports.windowTime = windowTime;
module.exports.EVERYTHING = EVERYTHING;
