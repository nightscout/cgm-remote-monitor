'use strict';

// Document dates parsed once (evaluator cost lane, candidate D).
//
// The plugins parse the same document date strings on every evaluation
// (lib/client-core/devicestatus/loop.js: each device status's loop,
// enacted and override timestamps; devicestatus/pump.js: the pump clock;
// lib/plugins/iob.js: device IOB times). For a time-only cycle the strings
// are the same as the last cycle's.
//
// memo(moment) gives a function that behaves as `moment` and is `moment` for
// every property (moment.utc, moment.tz, moment.duration, ...). A call with
// exactly one string argument returns a CLONE of the moment that `moment`
// itself parsed from that string the first time it was seen: clone() is
// moment's own copy of a parsed moment (new Moment(parsed): the same input,
// format, parsing flags, locale, offset and zone fields, a new Date of the
// same instant, the same updateOffset hook), so the value is the parse's
// value by construction, and each caller gets its own object to change
// (own() below gives it its own parsing flags and parsed parts too).
// Every other call goes to `moment` unchanged.
//
// A parse depends on the string, the process time zone, moment's global
// locale and moment-timezone's default zone. The last two are checked on
// every call and the cache is dropped when either changes.
//
// cycle() bounds the cache: entries not used in the last two cycles are
// dropped. The evaluator calls it once per evaluation.

// clone() copies the parsed moment's fields by reference; two of them are
// objects: the parsing flags (_pf) and moment-timezone's parsed date parts
// (_a). Each caller gets its own copies of both, as a fresh parse would.
function own (m) {
  const flags = m._pf;
  if (flags && typeof flags === 'object') {
    const copy = {};
    for (const key of Object.keys(flags)) copy[key] = Array.isArray(flags[key]) ? flags[key].slice() : flags[key];
    m._pf = copy;
  }
  if (Array.isArray(m._a)) m._a = m._a.slice();
  return m;
}

function memo (moment) {
  let current = new Map(), previous = new Map();
  let locale = moment.locale(), zone = moment.defaultZone;
  let hits = 0, parses = 0;
  function parsed (text) {
    let m = current.get(text);
    if (m === undefined) {
      m = previous.get(text);
      if (m === undefined) { m = moment(text); parses++; } else hits++;
      current.set(text, m);
    } else hits++;
    return m;
  }
  const memoised = new Proxy(moment, {
    apply (target, self, args) {
      if (args.length !== 1 || typeof args[0] !== 'string') return Reflect.apply(target, self, args);
      if (target.locale() !== locale || target.defaultZone !== zone) {
        current = new Map(); previous = new Map();
        locale = target.locale(); zone = target.defaultZone;
      }
      return own(parsed(args[0]).clone());
    }
  });
  return Object.freeze({
    moment: memoised,
    cycle () { previous = current; current = new Map(); },
    stats: () => ({ hits, parses, size: new Set([...current.keys(), ...previous.keys()]).size })
  });
}

module.exports = memo;
