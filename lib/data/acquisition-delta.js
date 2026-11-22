'use strict';

// Two temporary switches of the multitenant level evaluator, each off by
// default, for what an acquisition repeats over rows that did not change.
// Every cycle result is as with the switch off.
//
//   NS_EVAL_ENCODE_DELTA         (needs the resident window) The evaluator
//       takes the window's rows in their stored form. A row whose resident
//       document is the object an earlier acquisition of this generation
//       already prepared is handed that prepared row: no decode, encode,
//       comparison or ordered copy (postgres-projection-read prepareEncoded,
//       projection-memory-read rowsOf). The proof is identity: a resident
//       document is frozen, so the same object is the same value. Anything
//       else is prepared as before.
//   NS_EVAL_VIEW_READS_RESIDENT  The views' sorted reads filter a resident
//       order of the domain's prepared rows (one per sort the loader uses),
//       carried from one acquisition's rows to the next by dropping the rows
//       that left and placing the new ones, instead of sorting the matching
//       rows on every read (projection-memory-read carryOrders, selectRows).
const ENCODE = 'NS_EVAL_ENCODE_DELTA';
const READS = 'NS_EVAL_VIEW_READS_RESIDENT';

function parse (name, value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  if (text === '' || text === '0' || text === 'off') return false;
  if (text === '1' || text === 'on') return true;
  throw new TypeError(name + ' is 1 or 0');
}

// What this process did: rows handed their prepared row by identity and rows
// prepared; sorted reads answered from a resident order, orders built by a
// sort, and orders carried to the next acquisition's rows.
const counters = { carried: 0, prepared: 0, orderedReads: 0, ordersSorted: 0, ordersCarried: 0 };

module.exports = { ENCODE, READS, parse, counters };
