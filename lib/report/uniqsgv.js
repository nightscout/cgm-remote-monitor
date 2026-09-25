'use strict';

const ONE_MIN_IN_MS = 60000;

/**
 * Drop duplicate SGV entries, keeping at most one per minute.
 *
 * The reference point must only ever move onto an entry that was actually
 * kept. Advancing it on rejected entries makes rejections cascade: for
 * timestamps 0s / 58s / 116s the 58s entry is dropped and moves the
 * reference onto itself, so the 116s entry is compared against a dropped
 * entry rather than the last kept one and is dropped as well - although it
 * sits 116s away from the last kept entry.
 *
 * Callers are expected to pass a chronologically sorted array; sorting is
 * left where it already happens so this stays a pure, single-purpose filter.
 *
 * @param {Array<{mills: number}>} entries sorted ascending by `mills`
 * @param {function(Object)} [onDropped] called for each rejected entry
 * @returns {Array<{mills: number}>} filtered entries
 */
function uniqSgv (entries, onDropped) {
  let lastDate = 0;
  return entries.filter(function (d) {
    const ok = (lastDate + ONE_MIN_IN_MS) <= d.mills;
    if (ok) {
      lastDate = d.mills;
    } else if (onDropped) {
      onDropped(d);
    }
    return ok;
  });
}

uniqSgv.ONE_MIN_IN_MS = ONE_MIN_IN_MS;

module.exports = uniqSgv;
