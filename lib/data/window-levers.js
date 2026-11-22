'use strict';

// Evaluator window levers (multitenant level evaluator only; temporary switch
// NS_EVALUATOR_WINDOW_LEVERS, off by default). Each lever leaves every
// plugin output, alarm and browser frame as it is with the switch off; it
// changes how many bytes a cycle carries and how often it copies them.
//
//   copies    the level evaluator's reads hand their complete documents to
//             the loader by reference to the immutable retained source
//             (projection-memory-read.js), the private cache hands its merged
//             rows out once instead of copying them again
//             (private-acquisition.js), and the view keeps a frozen copy of
//             a working set only from the second time-only cycle on the same
//             input, not after every acquisition (views/index.js).
//   statuses  device statuses older than every plugin's own look-back keep
//             only the fields something still reads at that age (fit below).
//
// The value is "1" (or "all") for every lever, or a comma list of lever
// names; anything else that is not empty, "0" or "off" is refused, so a
// misspelt switch cannot silently measure the base.

const constants = require('../constants');

const NAMES = Object.freeze(['copies', 'statuses']);
const OFF = Object.freeze({ copies: false, statuses: false });
const ALL = Object.freeze({ copies: true, statuses: true });

function parse (value) {
  if (value && typeof value === 'object') return Object.freeze({ copies: value.copies === true, statuses: value.statuses === true });
  if (value === undefined || value === null) return OFF;
  const text = String(value).trim().toLowerCase();
  if (text === '' || text === '0' || text === 'off') return OFF;
  if (text === '1' || text === 'all') return ALL;
  const names = text.split(',').map(name => name.trim()).filter(Boolean);
  if (!names.length || names.some(name => !NAMES.includes(name))) throw new TypeError('NS_EVALUATOR_WINDOW_LEVERS names unknown levers');
  return Object.freeze({ copies: names.includes('copies'), statuses: names.includes('statuses') });
}

// ---- statuses: device statuses fitted to what reads them
//
// The window still holds every device status of the loader's look-back
// (dataloader.js rawQuery: 24 h, or 48 h with devicestatus days=2): none is
// dropped, because the cob plugin's treatment model asks the iob plugin for
// device IOB at each earlier carb entry's decay time, anywhere in the window
// (lib/plugins/cob.js fromTreatments -> iob.js calcTotal -> lastIOBDeviceStatus).
//
// What reads a status, by its age at the evaluation instant (the audit is in
// the lane handoff, HANDOFF-evaluator-window-levers-20261121.md):
//
//   any age   loader and cache: _id, created_at -> mills, uploaderBattery
//             (dataloader.js loadDeviceStatus, cache.js retention)
//             iob.js fromDeviceStatus: openaps.iob, loop.iob, pump.iob,
//             whether connect is present, device, mills, created_at
//             evaluator-due.js: mills, which of uploader/pump/openaps/loop/
//             xdripjs are present, pump.clock
//             ddata.js recentDeviceStatus (the browser frame): device and
//             which type fields are present, to list (device, type) pairs;
//             then the whole status, for the 10 newest of each pair
//   recent    loop.js and openaps.js 6 h; pump.js twice its urgentClock;
//             xdripjs.js 24 h; upbat.js, iob.js and cob.js (device COB) 30 min:
//             the whole status
//
// So a status stays whole when it is inside the longest recent look-back
// (plus a margin), when it is one of the 10 newest older statuses of any of
// its (device, type) pairs (or ties with the tenth), or when it is not an
// ordinary status (below). Every other status keeps the "any age" fields.

const TYPE_KEYS = Object.freeze(['uploader', 'pump', 'openaps', 'loop', 'xdripjs']); // ddata.js DEVICE_TYPE_FIELDS
const PARTS = Object.freeze({ uploader: [], pump: ['clock', 'iob'], openaps: ['iob'], loop: ['iob'], xdripjs: [] });
const TOP = new Set(['_id', 'device', 'created_at', 'uploaderBattery', 'connect', ...TYPE_KEYS]);
// A status carrying any of these takes its time, or its place in the window,
// from something other than created_at (ddata.js normalizeRawData, cache.js
// objectAge): it is left whole.
const UNUSUAL = Object.freeze(['mills', 'sysTime', 'date', 'duration', 'durationInMilliseconds', 'endmills', '__proto__']);
const RECENT_PER_PAIR = 10; // ddata.js recentDeviceStatus slice(-10)
const MARGIN_MS = constants.ONE_HOUR;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The longest look-back from the evaluation instant within which some plugin
 * reads whole device statuses.
 * @param {Object} env the tenant's environment (settings.enable, extendedSettings)
 * @returns {number} milliseconds
 */
function recentLookback (env) {
  let longest = 6 * constants.ONE_HOUR; // loop.js, openaps.js analyzeData recentHours
  // pump.js setProperties: times.mins(prefs.urgentClock * 2), urgentClock || 60
  const pump = (env && env.extendedSettings && env.extendedSettings.pump) || {};
  const pumpMs = (pump.urgentClock || 60) * 2 * 60000;
  if (Number.isFinite(pumpMs) && pumpMs > longest) longest = pumpMs;
  // xdripjs.js analyzeData: 24 h. A plugin list that cannot be read takes it too.
  const enabled = env && env.settings && env.settings.enable;
  if (!Array.isArray(enabled) || enabled.includes('xdripjs')) longest = Math.max(longest, constants.ONE_DAY);
  return longest;
}

// The time the loader gives an ordinary status (ddata.js normalizeRawData:
// mills from created_at), or NaN when the status is not ordinary.
function ordinaryMills (doc) {
  if (!isPlain(doc) || typeof doc.created_at !== 'string') return NaN;
  for (const key of UNUSUAL) if (own(doc, key)) return NaN;
  if (own(doc, 'device') && typeof doc.device !== 'string') return NaN;
  for (const key of TYPE_KEYS) {
    if (!own(doc, key)) continue;
    const value = doc[key];
    if (Array.isArray(value)) return NaN;
    if (isPlain(value) && own(value, '__proto__')) return NaN;
  }
  return new Date(doc.created_at).getTime();
}

function fitted (doc) {
  const out = {};
  for (const key of Object.keys(doc)) {
    if (!TOP.has(key)) continue;
    const value = doc[key];
    if (!PARTS[key] || !isPlain(value)) { out[key] = value; continue; }
    const part = {};
    for (const name of Object.keys(value)) if (PARTS[key].includes(name)) part[name] = value[name];
    out[key] = part;
  }
  return out;
}

/**
 * Device-status rows with the older ones fitted. Rows keep their order,
 * identity and ordinal; a fitted row is a new row holding a new document, a
 * whole one is the row given.
 * @param {Array<{id_kind, doc, ordinal}>} rows encoded device-status rows
 * @param {Object} o { at: the evaluation instant, env, now: the wall clock }
 * @returns {Array} rows
 */
function fitStatuses (rows, { at, env, now = Date.now(), lookback = recentLookback(env) } = {}) {
  if (!Number.isFinite(at) || !Number.isFinite(now) || !Number.isFinite(lookback)) return rows;
  // The frame is cut at the wall clock (ddata.js dataWithRecentStatuses),
  // the plugins at the instant: whole from the earlier of the two.
  const cut = Math.min(at, now) - lookback - MARGIN_MS;
  const older = [];
  rows.forEach((row, index) => {
    const mills = ordinaryMills(row && row.doc);
    if (Number.isFinite(mills) && mills < cut) older.push({ index, mills });
  });
  if (!older.length) return rows;
  older.sort((a, b) => b.mills - a.mills);
  const pairs = new Map();
  const out = rows.slice();
  for (const { index, mills } of older) {
    const doc = rows[index].doc;
    let whole = false;
    for (const key of TYPE_KEYS) {
      // The loader turns uploaderBattery into uploader (dataloader.js eachStatus).
      if (!own(doc, key) && !(key === 'uploader' && own(doc, 'uploaderBattery'))) continue;
      const name = (own(doc, 'device') ? 's' + doc.device : 'u') + '\u0000' + key;
      const pair = pairs.get(name) || { count: 0, last: NaN };
      if (pair.count < RECENT_PER_PAIR || pair.last === mills) { whole = true; pair.count += 1; pair.last = mills; }
      pairs.set(name, pair);
    }
    if (!whole) out[index] = { ...rows[index], doc: fitted(doc) };
  }
  return out;
}

module.exports = { NAMES, parse, recentLookback, fitStatuses, fitted, ordinaryMills, MARGIN_MS, RECENT_PER_PAIR };
