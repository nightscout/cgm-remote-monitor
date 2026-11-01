'use strict';

/*
 * Quick-pick selection rules, in one place.
 *
 * A food document's `hidden` and `hideafteruse` have no settled type. The
 * built-in editor posts with `$.ajax({data: foodrec})` and no `contentType`,
 * so jQuery form-encodes and every leaf arrives as a STRING: `hidden: false`
 * is stored as `'false'`. A client that sends `application/json` stores a real
 * boolean. Both spellings are already on disk wherever a non-jQuery client has
 * ever written, so every reader has to accept both rather than pick a side.
 *
 * `position` has the same problem and one more consequence: it is compared,
 * not just tested, so a lexicographic order puts '10' between '1' and '2'.
 */

// True only for the two spellings of true. Anything else - false, 'false',
// absent, null - means the flag is not set. Absence matters: a document
// written before the field existed has no `hidden`, and it is not hidden.
function isTrue (value) {
  return value === true || value === 'true';
}

function isHidden (record) {
  return !!record && isTrue(record.hidden);
}

function hidesAfterUse (record) {
  return !!record && isTrue(record.hideafteruse);
}

// Sort comparator over `position`, numeric whichever way the value was
// stored. A record with no usable position sorts last rather than first,
// because the editor's own template uses a large sentinel (99999) for
// "no position", and NaN would otherwise win every comparison.
function positionOf (record) {
  var n = parseInt(record && record.position, 10);
  return isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
}

function byPosition (a, b) {
  return positionOf(a) - positionOf(b);
}

// The quick picks a chooser should offer, in the order it should offer them.
function selectable (records) {
  return (records || [])
    .filter(function (r) { return r && r.type === 'quickpick' && !isHidden(r); })
    .sort(byPosition);
}

module.exports = {
  isTrue: isTrue
  , isHidden: isHidden
  , hidesAfterUse: hidesAfterUse
  , positionOf: positionOf
  , byPosition: byPosition
  , selectable: selectable
};
