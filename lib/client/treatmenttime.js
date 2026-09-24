'use strict';

/*
 * What to write when a treatment's time is changed from the page.
 *
 * The page's treatment objects are not the stored documents. By the time a
 * treatment is drawn it also carries fields Nightscout derived while loading
 * or drawing it, and every time-derived one holds the ORIGINAL time:
 *
 *   mills     lib/data/ddata.js processRawDataForRuntime, from created_at
 *   endmills  the same function (records with a duration) and
 *             lib/profilefunctions.js updateTreatments (temp basals)
 *   date      lib/client/renderer.js getOrAddDate: a Date built from mills
 *   mgdl      lib/data/treatmenttocurve.js: the glucose at the old time, for
 *             the glyph's height
 *   scaled    lib/sandbox.js scaleEntry, from mgdl
 *   cuttedby, cutting
 *             lib/data/ddata.js processDurations (profile switches and temp
 *             basals), which the page runs on its own objects
 *
 * A stored `mills` or `endmills` is kept as-is when the server loads the
 * record (ddata derives them only when absent), so writing one back freezes
 * the record at the old time for IOB, COB and the chart.
 *
 * `date` needs one more step. The page adds it as a Date object. Everything
 * that arrives over the socket is JSON, so a `date` that is NOT a Date object
 * came from storage: API v3 stores its canonical time there as epoch
 * milliseconds. A stored `date` is therefore moved with the record (as a
 * number, the shape API v3 writes) rather than dropped.
 */

var DERIVED_FIELDS = ['mills', 'endmills', 'mgdl', 'scaled', 'cuttedby', 'cutting'];

// Cleared on the stored record when its time changes. A stored copy of any of
// these can only have come from an earlier write of the page's own object (no
// uploader sends them on a treatment), and each one holds the old time or the
// glucose at the old time.
var CLEARED_ON_TIME_CHANGE = { mills: 1, endmills: 1, mgdl: 1, scaled: 1 };

function hasStoredDate (treatment) {
  return Object.prototype.hasOwnProperty.call(treatment, 'date')
    && treatment.date !== null
    && treatment.date !== undefined
    && !(treatment.date instanceof Date);
}

function storedDateDisagrees (treatment, whenMs) {
  if (!hasStoredDate(treatment)) return false;
  var d = treatment.date;
  var ms = typeof d === 'number' ? d : Date.parse(d);
  if (!Number.isFinite(ms) && /^\d+$/.test(String(d))) ms = Number(d);
  return ms !== whenMs;
}

/**
 * The new record for "Move insulin" / "Move carbs": the stored fields of the
 * treatment, without the half that stays behind and without anything the page
 * derived.
 */
function splitRecord (treatment, removeField, newTime) {
  var copy = JSON.parse(JSON.stringify(treatment));
  delete copy._id;
  delete copy.NSCLIENT_ID;
  delete copy[removeField];
  DERIVED_FIELDS.forEach(function drop (field) { delete copy[field]; });
  if (hasStoredDate(treatment)) {
    copy.date = newTime.getTime();
  } else {
    delete copy.date;
  }
  copy.created_at = newTime.toISOString();
  return copy;
}

/**
 * The $set and $unset for moving a stored treatment to `newTime` (plain Move),
 * or, with `newTime` omitted, for keeping it at its own created_at (the half a
 * split leaves behind). A stale stored mills/endmills/mgdl/scaled is cleared
 * and a stored date is set to the same time, so moving an already-damaged
 * record repairs it.
 */
function timeFields (treatment, newTime) {
  var set = {};
  var whenMs;
  if (newTime) {
    set.created_at = newTime.toISOString();
    whenMs = newTime.getTime();
  } else {
    whenMs = Date.parse(treatment.created_at);
  }
  if (hasStoredDate(treatment) && Number.isFinite(whenMs) && (newTime || storedDateDisagrees(treatment, whenMs))) {
    set.date = whenMs;
  }
  return { set: set, unset: Object.assign({}, CLEARED_ON_TIME_CHANGE) };
}

/**
 * For an edit form that sends the whole record back (the report editor's
 * PUT /api/v1/treatments): drop the same fields and move a stored date to the
 * edited time.
 */
function alignEditedRecord (record, eventTime) {
  Object.keys(CLEARED_ON_TIME_CHANGE).forEach(function drop (field) { delete record[field]; });
  var ms = new Date(eventTime).getTime();
  if (hasStoredDate(record) && Number.isFinite(ms)) {
    record.date = ms;
  }
  return record;
}

module.exports = {
  DERIVED_FIELDS: DERIVED_FIELDS
  , hasStoredDate: hasStoredDate
  , splitRecord: splitRecord
  , timeFields: timeFields
  , alignEditedRecord: alignEditedRecord
};
