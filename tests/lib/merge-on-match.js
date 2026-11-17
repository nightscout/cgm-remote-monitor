'use strict';

// ID-FIRST-MATCH slice 4 (merge on match, ID-Q8) for the suites that compare a
// module as it was (tests/fixtures/write-intent/) with the write step over a
// recording driver. A re-send that matches a stored record is now merged into
// it: where the module wrote an upserting replace of the document, the step
// writes an upserting update whose $set is the same document (its _id, when it
// has one, in $setOnInsert), or, for one document, updateOne($set) in place of
// replaceOne. unmerge() puts each such merge back into the replace it took the
// place of, checking that it carries the same document, so the rest of the
// comparison stays exact; it answers how many it put back, for the suite to
// require that the merge was written. A merge that removes a field ($unset) is
// not put back, and so fails the comparison.

const assert = require('node:assert/strict');

function withoutId (doc) {
  const copy = Object.assign({ }, doc);
  delete copy._id;
  return copy;
}

// A bulk operation of the step against the module's at the same place.
function unmergeOp (now, was, counted) {
  if (!now || !now.updateOne || !was || !was.replaceOne) return now;
  const update = now.updateOne.update;
  if (!update || update.$unset || !update.$set) return now;
  const replacement = was.replaceOne.replacement;
  assert.deepEqual(update.$set, withoutId(replacement), 'the merge sets the document the replace wrote');
  if (update.$setOnInsert) assert.deepEqual(update.$setOnInsert, { _id: replacement._id }, 'the merge inserts under the same _id');
  counted.n++;
  return { replaceOne: { filter: now.updateOne.filter, replacement: replacement, upsert: now.updateOne.upsert } };
}

/**
 * @param {Array} nowCalls the step's driver calls, as [method, ...args] (shaped or not)
 * @param {Array} wasCalls the module's driver calls
 * @returns {{ calls: Array, merged: number }}
 */
function unmerge (nowCalls, wasCalls) {
  const counted = { n: 0 };
  const calls = [ ];
  let j = 0;
  for (let i = 0; i < nowCalls.length; i++, j++) {
    const call = nowCalls[i];
    const was = wasCalls[j];
    if (was && call[0] === 'bulkWrite' && was[0] === 'bulkWrite') {
      calls.push([call[0], call[1].map(function (op, at) { return unmergeOp(op, was[1][at], counted); })].concat(call.slice(2)));
      continue;
    }
    if (was && call[0] === 'updateOne' && was[0] === 'replaceOne' && call[2] && call[2].$set && !call[2].$unset) {
      assert.deepEqual(call[2].$set, withoutId(was[2]), 'the merge sets the document the replace wrote');
      counted.n++;
      // A merge whose record was gone by then (matchedCount 0) is followed by
      // the replace it falls back to, which db3b9e4e made alone.
      const next = nowCalls[i + 1];
      if (next && next[0] === 'replaceOne' && JSON.stringify(next[1]) === JSON.stringify(call[1])) i++;
      calls.push(was);
      continue;
    }
    calls.push(call);
  }
  return { calls: calls, merged: counted.n };
}

module.exports = { unmerge };
