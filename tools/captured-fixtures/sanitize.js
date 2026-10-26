'use strict';

/*
 * tools/captured-fixtures/sanitize.js
 *
 * Reads a directory of raw Nightscout-API dumps (entries.json,
 * treatments.json, devicestatus.json, profile.json) and emits
 * a deterministic, PII-stripped, size-bounded slice suitable for
 * committing as test fixtures.
 *
 * Design goals:
 *   - Deterministic: re-running with the same input must yield
 *     byte-identical output (so fixture diffs reflect real change).
 *   - PII-free: device serials, pump IDs, push tokens, bundle
 *     identifiers, and free-text user content are scrubbed.
 *   - Size-bounded: each output file stays small enough to commit
 *     comfortably (target < 100 KB each).
 *   - Time-anchored: timestamps are shifted so the latest entry
 *     lands at TARGET_LATEST_EPOCH, preserving intervals and
 *     time-of-day patterns.
 *
 * Usage:
 *   node tools/captured-fixtures/sanitize.js \
 *     --src /tmp/ns-pr8447-import \
 *     --out tests/fixtures/captured
 *
 * Both --src and --out default to those paths.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

// All sanitized timestamps are shifted so the LATEST entries record
// lands at this exact epoch. Picked to be slightly in the future of
// any plausible test run so reports/today logic exercises real code.
var TARGET_LATEST_EPOCH = Date.parse('2026-05-09T00:00:00.000Z');

// Slice sizes (after time-sorted descending). Per-source overrides
// are merged at sanitize time so a verbose Trio devicestatus capture
// (which carries 4× predBGs arrays) doesn't blow the size envelope.
var SIZE_LIMITS = {
  entries: 288        // ~1 day at 5-min cadence
  , treatments: 100   // representative sample
  , devicestatus: 30  // bounded heavily; each record carries a 60-bin predicted array
  , profile: 10       // typically small; keep all up to 10
};

// Per-label overrides; merged into SIZE_LIMITS based on the --label
// arg. Trio devicestatus is ~3KB/record (4× predBG arrays), so we
// shrink the slice to keep the file under the lint envelope.
var SIZE_LIMITS_BY_LABEL = {
  trio: { devicestatus: 10, treatments: 80, entries: 0, profile: 0 }
  , 'phone-uploader': { devicestatus: 30, treatments: 50, entries: 0, profile: 0 }
  , aaps: { devicestatus: 30, treatments: 80, entries: 0, profile: 0 }
};

// Optional per-label devicestatus prefilter. Used when a single
// patient's NS export carries records from multiple controllers
// (e.g. Trio + Loop on the same account); without this the slice
// step would happily pick the latest 20 — which may all be from
// the wrong controller.
var DS_FILTER_BY_LABEL = {
  trio: function (d) { return d && d.openaps && typeof d.openaps === 'object'; }
  , 'phone-uploader': function (d) { return d && !d.loop && !d.openaps && !d.pump; }
  , aaps: function (d) { return d && (d.device === 'openaps://AndroidAPS' || /^openaps:\/\/.*AndroidAPS/i.test(d.device || '')); }
};

// Per-label devicestatus key extractor for sliceByTimeDiverse. When
// set, the slice is keyed on this function so rare branches (e.g.
// enacted+received vs suggested-only) are guaranteed to appear at
// least once in the captured slice. Without this, a "latest 20"
// pure-time slice can omit branch shapes the consuming module
// needs to exercise.
var DS_KEY_BY_LABEL = {
  trio: function (d) {
    var e = d && d.openaps && d.openaps.enacted;
    var hasReceived = e && e.timestamp && (e.received || e.recieved);
    return hasReceived ? 'enacted+received' : 'suggested-only';
  }
};

// Same idea for treatments — pick by enteredBy / device.
var TX_FILTER_BY_LABEL = {
  trio: function (t) { return (t && (t.enteredBy === 'Trio' || (t.enteredBy || '').indexOf('Trio') === 0)); }
  , 'phone-uploader': function (t) { return t && (t.enteredBy || '').indexOf('xDrip') === 0; }
  , aaps: function (t) { return t && /AndroidAPS|openaps/i.test((t.enteredBy || '') + ' ' + (t.device || '')); }
};

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

function sha1Hex (s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// Stable 24-hex-char placeholder for `_id`, derived from the canonical
// JSON of the surrounding record (minus its existing _id). Keeps the
// shape of a Mongo ObjectId without leaking the original.
function deterministicId (record) {
  var clone = Object.assign({}, record);
  delete clone._id;
  return sha1Hex(canonicalJson(clone)).slice(0, 24);
}

function canonicalJson (value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys (v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce(function (acc, k) {
      acc[k] = sortKeys(v[k]);
      return acc;
    }, {});
  }
  return v;
}

// Produce a deterministic, opaque identifier of the same lexical
// shape as a UUID, derived from a seed string. Used for syncIdentifier
// and similar opaque tokens whose *uniqueness* matters to consumers
// but whose *value* is opaque.
function deterministicUuid (seed) {
  var h = sha1Hex(seed);
  return [
    h.slice(0,  8)
    , h.slice(8, 12)
    , h.slice(12, 16)
    , h.slice(16, 20)
    , h.slice(20, 32)
  ].join('-');
}

// ---------------------------------------------------------------------------
// Time shift
// ---------------------------------------------------------------------------

function pickLatestMillis (entries) {
  return entries.reduce(function (acc, r) {
    var t = r.date || Date.parse(r.dateString || r.sysTime || '');
    return t && t > acc ? t : acc;
  }, 0);
}

function makeShifter (deltaMs) {
  function shiftIso (iso) {
    if (!iso || typeof iso !== 'string') return iso;
    var t = Date.parse(iso);
    if (isNaN(t)) return iso;
    return new Date(t + deltaMs).toISOString();
  }
  function shiftMs (ms) {
    if (typeof ms !== 'number') return ms;
    return ms + deltaMs;
  }
  return { iso: shiftIso, ms: shiftMs };
}

// ---------------------------------------------------------------------------
// Field-level scrubbers
// ---------------------------------------------------------------------------

// Replace a Dexcom-style "Dexcom G6 8XRSC5" with "Dexcom G6 SERIAL".
// Generic enough for G5/G6/G7/Libre device strings.
function scrubDeviceString (s) {
  if (!s || typeof s !== 'string') return s;
  return s.replace(/^(Dexcom\s+G[567])\s+\S+/i, '$1 SERIAL')
    .replace(/^(Libre[^\s]*)\s+\S+/i, '$1 SERIAL')
    // Phone-model device strings (Sony SO-53B, Pixel 7, etc.) leak
    // device identity even without a serial; replace with a generic
    // placeholder. Trio / loop:// / openaps:// are public controller
    // names and are kept as-is.
    .replace(/^Sony\s+\S+/i, 'Android Phone')
    .replace(/^Pixel\s+\S+/i, 'Android Phone')
    .replace(/^SM-[A-Z0-9]+/i, 'Android Phone');
}

// Pseudonymize known uploader/device tokens.
function scrubEnteredBy (s) {
  if (!s || typeof s !== 'string') return s;
  return s.replace(/loop:\/\/[^\s]+/g, 'loop://test-device');
}

// Free-text fields that may contain identifying notes; drop entirely.
var TEXT_FIELDS_TO_DROP = ['notes', 'reason', 'foodType', 'userEnteredAt'];

// ---------------------------------------------------------------------------
// Per-collection sanitizers
// ---------------------------------------------------------------------------

function sanitizeEntry (e, shifter) {
  var out = {};
  Object.keys(e).sort().forEach(function (k) { out[k] = e[k]; });
  delete out._id;
  if (out.device) out.device = scrubDeviceString(out.device);
  if (typeof out.date === 'number') out.date = shifter.ms(out.date);
  if (out.dateString) out.dateString = shifter.iso(out.dateString);
  if (out.sysTime) out.sysTime = shifter.iso(out.sysTime);
  out._id = deterministicId(out);
  return out;
}

function sanitizeTreatment (t, shifter) {
  var out = {};
  Object.keys(t).sort().forEach(function (k) {
    if (TEXT_FIELDS_TO_DROP.indexOf(k) === -1) out[k] = t[k];
  });
  delete out._id;
  if (out.enteredBy) out.enteredBy = scrubEnteredBy(out.enteredBy);
  if (out.created_at) out.created_at = shifter.iso(out.created_at);
  if (out.timestamp) out.timestamp = shifter.iso(out.timestamp);
  if (out.syncIdentifier) {
    out.syncIdentifier = deterministicUuid('sync-' + out.syncIdentifier).replace(/-/g, '');
  }
  out._id = deterministicId(out);
  return out;
}

function sanitizeDevicestatus (d, shifter) {
  var out = JSON.parse(JSON.stringify(d));
  delete out._id;

  if (out.device) out.device = scrubDeviceString(scrubEnteredBy(out.device));
  if (out.created_at) out.created_at = shifter.iso(out.created_at);

  if (out.pump) {
    if (out.pump.pumpID) out.pump.pumpID = 'PUMPID';
    if (out.pump.clock) out.pump.clock = shifter.iso(out.pump.clock);
  }
  if (out.uploader) {
    if (out.uploader.name) out.uploader.name = 'test-uploader';
    if (out.uploader.timestamp) out.uploader.timestamp = shifter.iso(out.uploader.timestamp);
  }
  if (out.override && out.override.timestamp) out.override.timestamp = shifter.iso(out.override.timestamp);
  if (out.openaps) {
    // Shift inner openaps timestamps so the "recent" window logic in
    // selectOpenAPSState (lastEnacted vs status='enacted') stays
    // testable against the time-anchored fixture. Without this, the
    // outer created_at lands at 2026-05-09 while inner enacted.timestamp
    // remains in the original capture window — pushing every record
    // outside `recent` and forcing status code 'warning'.
    ['enacted', 'suggested'].forEach(function (k) {
      var blk = out.openaps[k]; // eslint-disable-line security/detect-object-injection
      if (blk && typeof blk === 'object') {
        if (blk.timestamp) blk.timestamp = shifter.iso(blk.timestamp);
        if (blk.deliverAt) blk.deliverAt = shifter.iso(blk.deliverAt);
      }
    });
    if (out.openaps.iob && out.openaps.iob.time) {
      out.openaps.iob.time = shifter.iso(out.openaps.iob.time);
      if (out.openaps.iob.iobWithZeroTemp && out.openaps.iob.iobWithZeroTemp.time) {
        out.openaps.iob.iobWithZeroTemp.time = shifter.iso(out.openaps.iob.iobWithZeroTemp.time);
      }
    }
    if (out.openaps.mmtune && out.openaps.mmtune.timestamp) {
      out.openaps.mmtune.timestamp = shifter.iso(out.openaps.mmtune.timestamp);
    }
  }
  if (out.loop) {
    if (out.loop.name) out.loop.name = 'TestLoop';
    if (out.loop.timestamp) out.loop.timestamp = shifter.iso(out.loop.timestamp);
    if (out.loop.iob && out.loop.iob.timestamp) out.loop.iob.timestamp = shifter.iso(out.loop.iob.timestamp);
    if (out.loop.cob && out.loop.cob.timestamp) out.loop.cob.timestamp = shifter.iso(out.loop.cob.timestamp);
    if (out.loop.predicted && out.loop.predicted.startDate) {
      out.loop.predicted.startDate = shifter.iso(out.loop.predicted.startDate);
    }
    if (out.loop.automaticDoseRecommendation && out.loop.automaticDoseRecommendation.timestamp) {
      out.loop.automaticDoseRecommendation.timestamp = shifter.iso(out.loop.automaticDoseRecommendation.timestamp);
    }
    // The loop bundle identifier and version are useful signal for
    // testing display logic; bundleIdentifier itself doesn't appear
    // in devicestatus, so nothing to scrub here.
  }

  // Re-sort top-level keys so output is canonical.
  var sorted = {};
  Object.keys(out).sort().forEach(function (k) { sorted[k] = out[k]; });
  sorted._id = deterministicId(sorted);
  return sorted;
}

function sanitizeProfile (p, shifter) {
  var out = JSON.parse(JSON.stringify(p));
  delete out._id;

  if (out.enteredBy) out.enteredBy = 'test-user';
  if (out.created_at) out.created_at = shifter.iso(out.created_at);
  if (out.startDate) out.startDate = shifter.iso(out.startDate);
  if (out.mills) {
    var n = parseInt(out.mills, 10);
    if (!isNaN(n)) out.mills = String(shifter.ms(n));
  }

  if (out.loopSettings) {
    // Strip identifying tokens entirely; tests should not depend on them.
    delete out.loopSettings.deviceToken;
    if (out.loopSettings.bundleIdentifier) {
      out.loopSettings.bundleIdentifier = 'test.bundle.identifier';
    }
    if (Array.isArray(out.loopSettings.overridePresets)) {
      out.loopSettings.overridePresets = out.loopSettings.overridePresets.map(function (preset, i) {
        var copy = Object.assign({}, preset);
        copy.name = 'preset-' + (i + 1);
        // Keep the symbol — it's categorical, not identifying.
        return copy;
      });
    }
  }

  var sorted = {};
  Object.keys(out).sort().forEach(function (k) { sorted[k] = out[k]; });
  sorted._id = deterministicId(sorted);
  return sorted;
}

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

function sliceByTime (records, limit, getMillis) {
  return records
    .slice()
    .sort(function (a, b) { return getMillis(b) - getMillis(a); })
    .slice(0, limit);
}

// Like sliceByTime, but guarantees that every distinct value of
// `getKey(record)` appears at least once in the result (so rare
// event types aren't dropped by a pure latest-N sample). The most
// common keys absorb the remaining slots.
function sliceByTimeDiverse (records, limit, getMillis, getKey) {
  var sorted = records.slice()
    .sort(function (a, b) { return getMillis(b) - getMillis(a); });
  var seen = {};
  var picked = [];
  // First pass: latest record of each distinct key.
  sorted.forEach(function (r) {
    var k = getKey(r) || '__none__';
    if (!Object.prototype.hasOwnProperty.call(seen, k)) {
      seen[k] = true;
      picked.push(r);
    }
  });
  // Second pass: fill remaining slots in time-order, skipping
  // already-picked references.
  var pickedSet = new Set(picked);
  for (var i = 0; i < sorted.length && picked.length < limit; i++) {
    if (!pickedSet.has(sorted[i])) picked.push(sorted[i]);
  }
  return picked.slice(0, limit);
}

function entryMillis (e) {
  return e.date || Date.parse(e.dateString || e.sysTime || '') || 0;
}
function treatmentMillis (t) {
  return Date.parse(t.created_at || t.timestamp || '') || 0;
}
function dsMillis (d) {
  return Date.parse(d.created_at || (d.uploader && d.uploader.timestamp) || '') || 0;
}
function profileMillis (p) {
  return parseInt(p.mills, 10) || Date.parse(p.created_at || p.startDate || '') || 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  var args = {
    src: '/tmp/ns-pr8447-import'
    , out: 'tests/fixtures/captured/loop'
    , label: 'loop'
  };
  for (var i = 2; i < argv.length; i++) {
    var key = argv[i].replace(/^--/, '');
    args[key] = argv[++i];
  }
  return args;
}

function loadJson (file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeFixture (outDir, name, data) {
  if (!data || data.length === 0) return; // skip empty collections
  fs.mkdirSync(outDir, { recursive: true });
  var file = path.join(outDir, name);
  // Pretty-print with 2-space indent for diff-friendliness.
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  var bytes = fs.statSync(file).size;
  console.log('  wrote ' + name + '  (' + data.length + ' records, ' + bytes + ' bytes)');
}

function effectiveLimits (label) {
  var overrides = SIZE_LIMITS_BY_LABEL[label] || {}; // eslint-disable-line security/detect-object-injection
  return Object.assign({}, SIZE_LIMITS, overrides);
}

function main () {
  var args = parseArgs(process.argv);
  console.log('sanitizing captures: src=' + args.src + ' out=' + args.out + ' label=' + args.label);

  var rawEntries = loadJson(path.join(args.src, 'entries.json'));
  var rawTreatments = loadJson(path.join(args.src, 'treatments.json'));
  var rawDevicestatus = loadJson(path.join(args.src, 'devicestatus.json'));
  var rawProfile = loadJson(path.join(args.src, 'profile.json'));

  var limits = effectiveLimits(args.label);

  var dsFilter = DS_FILTER_BY_LABEL[args.label]; // eslint-disable-line security/detect-object-injection
  if (dsFilter) {
    var preDs = rawDevicestatus.length;
    rawDevicestatus = rawDevicestatus.filter(dsFilter);
    console.log('  ds-filter[' + args.label + ']: ' + preDs + ' → ' + rawDevicestatus.length);
  }
  var txFilter = TX_FILTER_BY_LABEL[args.label]; // eslint-disable-line security/detect-object-injection
  if (txFilter) {
    var preTx = rawTreatments.length;
    rawTreatments = rawTreatments.filter(txFilter);
    console.log('  tx-filter[' + args.label + ']: ' + preTx + ' → ' + rawTreatments.length);
  }

  // Anchor time-shift on whichever collection has the most records.
  // For phone-uploader / Trio captures, devicestatus is the densest
  // and tightest source of timestamps.
  var anchor = rawEntries.length > 0 ? rawEntries
    : rawDevicestatus.length > 0 ? rawDevicestatus
    : rawTreatments;
  var anchorMillis = anchor === rawEntries ? entryMillis
    : anchor === rawDevicestatus ? dsMillis
    : treatmentMillis;
  var latest = anchor.reduce(function (acc, r) { return Math.max(acc, anchorMillis(r) || 0); }, 0);
  var deltaMs = TARGET_LATEST_EPOCH - latest;
  var shifter = makeShifter(deltaMs);
  console.log('  source-latest=' + new Date(latest).toISOString()
              + ' shift-delta=' + (deltaMs / 1000) + 's');

  var entries = sliceByTime(rawEntries, limits.entries, entryMillis)
    .map(function (e) { return sanitizeEntry(e, shifter); });
  var treatments = sliceByTimeDiverse(rawTreatments, limits.treatments, treatmentMillis,
    function (t) { return t.eventType; })
    .map(function (t) { return sanitizeTreatment(t, shifter); });
  var devicestatus = (DS_KEY_BY_LABEL[args.label] // eslint-disable-line security/detect-object-injection
    ? sliceByTimeDiverse(rawDevicestatus, limits.devicestatus, dsMillis, DS_KEY_BY_LABEL[args.label]) // eslint-disable-line security/detect-object-injection
    : sliceByTime(rawDevicestatus, limits.devicestatus, dsMillis))
    .map(function (d) { return sanitizeDevicestatus(d, shifter); });
  var profile = sliceByTime(rawProfile, limits.profile, profileMillis)
    .map(function (p) { return sanitizeProfile(p, shifter); });

  writeFixture(args.out, 'entries.json', entries);
  writeFixture(args.out, 'treatments.json', treatments);
  writeFixture(args.out, 'devicestatus.json', devicestatus);
  writeFixture(args.out, 'profile.json', profile);

  console.log('done.');
}

if (require.main === module) main();

module.exports = {
  TARGET_LATEST_EPOCH: TARGET_LATEST_EPOCH
  , sanitizeEntry: sanitizeEntry
  , sanitizeTreatment: sanitizeTreatment
  , sanitizeDevicestatus: sanitizeDevicestatus
  , sanitizeProfile: sanitizeProfile
  , makeShifter: makeShifter
  , deterministicId: deterministicId
  , scrubDeviceString: scrubDeviceString
  , scrubEnteredBy: scrubEnteredBy
};
