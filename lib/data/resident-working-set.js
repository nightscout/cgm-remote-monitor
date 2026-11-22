'use strict';

// Resident working set (multitenant level evaluator only; temporary switch
// NS_EVAL_RESIDENT_WORKING_SET, off by default). The prepared working set of
// a resident tenant is kept between cycles (views/index.js keepOrLoad), and
// every plugin output, alarm and browser frame is as with the switch off.
//
//   time-only   a cycle on the same input, inside the input's window (before
//               its next expiry, clinical-working-set-policy nextExpiry) and
//               away from every wall-clock edge, is handed a copy of the
//               resident set: no read, no load.
//   statuses    an acquisition gives the shipping loader only the device
//               statuses that are new or changed (by the identity of their
//               retained source), and places what it prepares among the
//               prepared statuses already resident: insert, replace, remove,
//               in the loader's order. Readings and treatments are prepared
//               by the loader from the whole window on every acquisition: a
//               treatment takes its glucose from the readings either side of
//               it and its duration from its neighbours, so one change moves
//               others.
//
// The plugins write into what they are given (the audit is in the lane
// handoff: device statuses at several depths, readings, temp basals), so the
// resident set is frozen; a cycle is handed its own copy of what they write
// and shares the rest (handOut below), or gets a whole copy of its own
// (working-set.js copy).
//
// A full rebuild (the loader over every status) happens whenever the resident
// statuses cannot be placed exactly: no resident, another restore generation
// or settings (a new views instance), a status without a retained source,
// or one the loader's order is not total for. A resident status within the
// margin of the cache's wall-clock retention is prepared again by the loader.

const cache = require('../server/cache');
const windowPolicy = require('../storage/clinical-working-set-policy');
const { deepFreeze } = require('./json-copy');

const SWITCH = 'NS_EVAL_RESIDENT_WORKING_SET';
// What this process's views did with their resident sets (views/index.js):
// cycles handed a copy without a read, loads that placed the changed
// statuses, loads that prepared every status, and loads that kept nothing;
// resident sets handed out shared or as a whole copy, and plugin passes that
// wrote into what was shared.
const counters = { reused: 0, placed: 0, rebuilt: 0, plain: 0, statusesPrepared: 0, statusesResident: 0, shared: 0, whole: 0, tripped: 0 };

function parse (value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  if (text === '' || text === '0' || text === 'off') return false;
  if (text === '1' || text === 'on') return true;
  throw new TypeError(SWITCH + ' is 1 or 0');
}

// ---- How long an input's window holds. The reads of the same rows answer
// the same from the input's instant until a row next leaves a window by time
// (clinical-working-set-policy expiryInstants: readings 2 days, statuses the
// look-back, treatments 60 h and the 62 day and 372 day lookups; no read
// gains a row as time passes). That schedule is exact only for canonical
// window times; any other value keeps the read's own comparison, which this
// module does not restate, so such an input does not reside.
const WINDOWED = Object.freeze(['entries', 'treatments', 'devicestatus']);
// Per look-back, each retained document's instants, computed once: a number
// for one, a list for several, false when its window time is not canonical.
const EXPIRY = new Map();
function canonicalTime (domain, doc) {
  if (domain === 'entries') return Number.isSafeInteger(doc.date);
  const value = doc.created_at;
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function instantsOf (domain, doc, devicestatusMs) {
  if (!canonicalTime(domain, doc)) return false;
  const instants = windowPolicy.expiryInstants({ domain, doc }, devicestatusMs);
  return instants.length === 1 ? instants[0] : instants;
}

/**
 * The first instant after the policy's at which the window changes by time.
 * @param {Object} groups { entries, treatments, devicestatus }: retained rows ({ doc }), frozen
 * @param {Object} policy clinical-working-set-policy create(env, at)
 * @returns {number|null} an instant, Infinity for never, null when a window time is not canonical
 */
function until (groups, policy) {
  let known = EXPIRY.get(policy.devicestatusMs);
  if (!known) EXPIRY.set(policy.devicestatusMs, known = new WeakMap());
  let next = Infinity;
  for (const domain of WINDOWED) {
    for (const row of groups[domain] || []) {
      let instants = known.get(row.doc);
      if (instants === undefined) known.set(row.doc, instants = instantsOf(domain, row.doc, policy.devicestatusMs));
      if (instants === false) return null;
      if (typeof instants === 'number') { if (instants > policy.at && instants < next) next = instants; continue; }
      for (const instant of instants) {
        if (instant <= policy.at) continue;
        if (instant < next) next = instant;
        break;
      }
    }
  }
  return next;
}

// ---- Owning a loaded working set: frozen in place, no copy. Exact for plain
// data only (as working-set.js keep); false for anything else.
function freezePlain (value) {
  if (value === null || typeof value !== 'object') return typeof value !== 'function' && typeof value !== 'symbol';
  if (Object.isFrozen(value)) return true; // a retained source's child, or already visited
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  if (Object.getOwnPropertyNames(value).length !== keys.length + (array ? 1 : 0) || Object.getOwnPropertySymbols(value).length) return false;
  if (array && keys.length !== value.length) return false;
  Object.freeze(value);
  for (let i = 0; i < keys.length; i++) if (!freezePlain(value[keys[i]])) return false;
  return true;
}

/**
 * The data members of a working set, frozen in place; null when it holds
 * anything not plain (some of it is then frozen: the caller loads afresh).
 * @param {Object} ddata a lib/data/ddata.js working set
 * @returns {Object|null}
 */
function own (ddata) {
  const data = {};
  for (const key of Object.keys(ddata)) {
    if (typeof ddata[key] === 'function') continue;
    if (!freezePlain(ddata[key])) return null;
    data[key] = ddata[key];
  }
  return Object.freeze(data);
}

// ---- Handing out a resident set: shared, but for what the plugin pass writes.
//
// The plugin pass (views/index.js run: sandbox serverInit, setProperties,
// checkNotifications, process) writes into three members of the working set
// it is given (the audit in the INC-A lane handoff, and the write sites):
//
//   devicestatus         the status (pump.js clockMills, data), its parts
//                        (upbat.js uploader.*, loop.js loop.moment and
//                        override.moment, openaps.js openaps.iob), their parts
//                        (enacted.moment, suggested.moment, iob.moment) and a
//                        prediction held by one of those (predBGs.moment)
//   sgvs                 each reading (sandbox.js scaleEntry: scaled)
//   tempbasalTreatments  each temp basal (profilefunctions.js addDuration: endmills)
//
// A cycle is handed its own copy of those, to those depths, and its own
// top-level lists; everything else is the resident set's frozen data, shared.
// A write into what is shared throws in strict code (every module of the
// plugin pass is strict; tests/evaluator-resident-working-set.test.js), which
// views/index.js notices even where lib/plugins/index.js catches it: the
// cycle then runs again on a whole copy and that views instance shares
// nothing afterwards.
const STATUS_OBJECT_DEPTH = 4; // status 1, status.openaps 2, .suggested 3, .predBGs 4
const STATUS_ARRAY_DEPTH = 3; // status.openaps.iob as oref0 uploads it: a list
const COPIED = Object.freeze({ devicestatus: 'status', sgvs: 'record', tempbasalTreatments: 'record' });

function shallow (value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice();
  // Own enumerable members, each defined as data ('__proto__' included).
  if (Object.getPrototypeOf(value) !== null) return { ...value };
  const out = Object.create(null);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === '__proto__') Object.defineProperty(out, key, { value: value[key], enumerable: true, writable: true, configurable: true });
    else out[key] = value[key];
  }
  return out;
}

// A status with its own objects to STATUS_OBJECT_DEPTH and lists to
// STATUS_ARRAY_DEPTH.
const statusOwns = (value, depth) => value !== null && typeof value === 'object' &&
  depth <= (Array.isArray(value) ? STATUS_ARRAY_DEPTH : STATUS_OBJECT_DEPTH);
function statusCopy (value, depth) {
  if (!statusOwns(value, depth)) return value;
  const array = Array.isArray(value);
  const out = shallow(value);
  const keys = array ? null : Object.keys(out);
  const n = array ? out.length : keys.length;
  for (let i = 0; i < n; i++) {
    const key = array ? i : keys[i], member = value[key];
    if (member !== null && typeof member === 'object') {
      const copied = statusCopy(member, depth + 1);
      if (copied !== member) out[key] = copied; // never '__proto__' by assignment: own() admits it only as data, shallow defined it
    }
  }
  return out;
}

// Every resident object statusCopy copies.
function statusParts (value, depth, each) {
  if (!statusOwns(value, depth)) return;
  each(value);
  const members = Array.isArray(value) ? value : Object.values(value);
  for (let i = 0; i < members.length; i++) statusParts(members[i], depth + 1, each);
}

// Statuses whose whole content a successful check below has walked. Such a
// status is frozen, so what it holds is what it held then: nothing made
// since, and nothing copied then that it did not hold as its own part. It
// comes back only from the resident statuses (place, below), which the
// loader is never given, so nothing a later load makes can hold a part of it.
const walked = new WeakSet();

/**
 * Whether a resident set can be handed out shared: every object a cycle gets
 * a copy of is held in one place only, so a write to the copy is seen wherever
 * a write to the original would be. Everything is walked but the content of
 * statuses walked before.
 * @param {Object} data from own()
 * @returns {boolean}
 */
function shareable (data) {
  const held = new Map(); // resident object a cycle gets a copy of -> references found
  const expect = value => { if (value !== null && typeof value === 'object') held.set(value, 0); };
  const known = new Set(), fresh = [];
  for (const key of Object.keys(data)) {
    const list = data[key];
    if (!Array.isArray(list)) { if (COPIED[key]) return false; continue; }
    expect(list);
    if (COPIED[key] === 'record') for (const record of list) expect(record);
    if (COPIED[key] !== 'status') continue;
    for (const status of list) {
      if (status === null || typeof status !== 'object') continue;
      if (walked.has(status)) { held.set(status, 0); known.add(status); continue; }
      statusParts(status, 1, expect);
      fresh.push(status);
    }
  }
  const visited = new Set();
  const stack = [data];
  while (stack.length) {
    const value = stack.pop();
    const members = Array.isArray(value) ? value : Object.values(value);
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      if (member === null || typeof member !== 'object') continue;
      const references = held.get(member);
      if (references !== undefined) { if (references) return false; held.set(member, 1); }
      if (!visited.has(member)) { visited.add(member); if (!known.has(member)) stack.push(member); }
    }
  }
  for (const status of fresh) walked.add(status);
  return true;
}

/**
 * A working set for one cycle from a shareable resident set.
 * @param {Object} data from own(), shareable
 * @param {Function} createData () -> a fresh ddata
 * @returns {Object} ddata
 */
function handOut (data, createData) {
  const ddata = createData();
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (!Array.isArray(value)) ddata[key] = value;
    else if (COPIED[key] === 'status') ddata[key] = value.map(status => statusCopy(status, 1));
    else if (COPIED[key] === 'record') ddata[key] = value.map(shallow);
    else ddata[key] = value.slice();
  }
  return ddata;
}

// A write refused by a frozen object, as V8 words it in strict code.
const FROZEN_WRITE = /^(Cannot assign to read only property|Cannot add property|Cannot delete property|Cannot define property|Cannot redefine property)/;
const frozenWrite = error => error instanceof TypeError && FROZEN_WRITE.test(error.message);
// The plugin pass is synchronous: one slot, cleared before and read after it.
const trip = { error: null };

// ---- Device statuses: the delta step.

// dataloader.js byMillsThenId (mergeProcessSort's order).
function byMillsThenId (a, b) {
  const byMills = a.mills - b.mills;
  if (byMills) return byMills;
  const aId = String(a._id), bId = String(b._id);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}
// The order above is total, whatever order the cache held the statuses in,
// only over finite times and distinct string ids.
const ordinary = status => status !== null && typeof status === 'object' && typeof status._id === 'string' && status._id !== '' &&
  typeof status.mills === 'number' && Number.isFinite(status.mills);

/**
 * Which statuses of a read the loader must prepare, given the resident ones.
 * @param {Object} o { docs: the device-status answer, memo: Map(source -> prepared status),
 *   documentSources, t: the wall clock, period: the cache's retention, margin, edges: [] to add to }
 * @returns {{fresh: Array, resident: Array}|null} null: prepare every status
 */
function plan ({ docs, memo, documentSources, t, period, margin, edges }) {
  if (!memo || !memo.size || !Array.isArray(docs) || !documentSources) return null;
  const fresh = [], resident = [], found = [];
  for (const doc of docs) {
    const source = documentSources.get(doc);
    if (!source) return null;
    const prepared = memo.get(source);
    if (!prepared) { fresh.push(doc); continue; }
    // The cache's retention (cache.js mergeCacheArrays), by the wall clock:
    // a status within the margin of it is left to the loader's own cache.
    const edge = cache.objectAge(prepared) + period;
    if (!Number.isFinite(edge)) return null;
    if (Math.abs(edge - t) <= margin) { fresh.push(doc); continue; }
    found.push(edge);
    if (edge > t) resident.push({ source, prepared });
  }
  if (edges) for (const edge of found) edges.push(edge);
  return { fresh, resident };
}

/**
 * The status list after a load of the planned statuses: the resident ones
 * and what the loader prepared, in the loader's order.
 * @param {Object} o { plan, loaded: the loader's ddata.devicestatus, documentSources }
 * @returns {{list: Array, memo: Map}|null} null: not placeable exactly
 */
function place ({ plan: planned, loaded, documentSources }) {
  const prepared = new Map();
  for (const status of loaded) {
    if (!ordinary(status) || prepared.has(status._id)) return null;
    prepared.set(status._id, status);
  }
  const memo = new Map(), list = [], ids = new Set();
  for (const { source, prepared: status } of planned.resident) {
    if (ids.has(status._id)) return null;
    ids.add(status._id); memo.set(source, status); list.push(status);
  }
  for (const doc of planned.fresh) {
    const source = documentSources.get(doc);
    const status = prepared.get(String(source._id));
    if (!status) continue; // the loader's cache did not retain it
    if (ids.has(status._id)) return null;
    prepared.delete(status._id);
    ids.add(status._id); memo.set(source, deepFreeze(status)); list.push(status);
  }
  if (prepared.size) return null;
  return { list: list.sort(byMillsThenId), memo };
}

/**
 * The resident statuses after a load of every status: each prepared status
 * by its retained source. An empty map when they cannot all be told apart.
 * @param {Object} o { docs, loaded, documentSources }
 * @returns {Map}
 */
function seed ({ docs, loaded, documentSources }) {
  const memo = new Map(), prepared = new Map();
  if (!Array.isArray(docs) || !documentSources) return memo;
  for (const status of loaded) {
    if (!ordinary(status) || prepared.has(status._id)) return new Map();
    prepared.set(status._id, status);
  }
  for (const doc of docs) {
    const source = documentSources.get(doc);
    if (!source) return new Map();
    const status = prepared.get(String(source._id));
    if (status) memo.set(source, deepFreeze(status));
  }
  return memo;
}

module.exports = { SWITCH, counters, parse, until, own, shareable, handOut, frozenWrite, trip, plan, place, seed, retention: env => cache.retentionPeriods(env).devicestatus };
