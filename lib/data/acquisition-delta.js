'use strict';

// A temporary switch of the multitenant level evaluator, off by default, for
// what an acquisition repeats over rows that did not change. Every cycle
// result is as with the switch off.
//
//   NS_EVAL_ENCODE_DELTA         (needs the resident window) The evaluator
//       takes the window's rows in their stored form. A row whose resident
//       document is the object an earlier acquisition of this generation
//       already prepared is handed that prepared row: no decode, encode,
//       comparison or ordered copy (postgres-projection-read prepareEncoded,
//       projection-memory-read rowsOf). The proof is identity: a resident
//       document is frozen, so the same object is the same value. Anything
//       else is prepared as before.
const ENCODE = 'NS_EVAL_ENCODE_DELTA';

function parse (name, value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  if (text === '' || text === '0' || text === 'off') return false;
  if (text === '1' || text === 'on') return true;
  throw new TypeError(name + ' is 1 or 0');
}

// What this process did: rows handed their prepared row by identity, and rows prepared.
const counters = { carried: 0, prepared: 0 };

module.exports = { ENCODE, parse, counters };
