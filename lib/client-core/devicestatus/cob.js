'use strict';

/*
 * lib/client-core/devicestatus/cob.js
 *
 * Pure extraction of controller-reported carbs-on-board from a single
 * Nightscout devicestatus document. Covers the OpenAPS family
 * (oref0 / oref1 / AndroidAPS / Trio) and Loop.
 *
 * `moment` must be supplied via `opts.moment` (defaults to the
 * top-level `moment` package). The document is not mutated.
 *
 * A block (`openaps.enacted`, `openaps.suggested`, `loop.cob`) is a
 * candidate only when its COB is a finite number and it has a
 * resolvable time. A block's `timestamp` dates it, falling back to the
 * enclosing record's `mills`, which `ddata.processRawDataForRuntime`
 * stamps from `created_at`. AndroidAPS omits `timestamp` on
 * `openaps.suggested`, so the record is what dates its COB.
 *
 * OpenAPS wins over Loop when both yield a candidate. Within OpenAPS
 * the newer block wins, ties going to `suggested`: Trio carries the
 * previous cycle's `enacted` alongside a fresher `suggested`.
 */

var defaultMoment = require('moment');

function toMills (value, moment) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  var m = moment(value);
  return m && m.isValid() ? m.valueOf() : null;
}

function blockMills (block, entry, moment) {
  var mills = toMills(block.timestamp, moment);
  return mills === null ? toMills(entry.mills, moment) : mills;
}

function toCOB (value) {
  if (value === undefined || value === null || value === '') return null;
  var num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function candidate (block, key, entry, moment) {
  if (!block || typeof block !== 'object') return null;

  var cob = toCOB(block[key]);
  if (cob === null) return null;

  var mills = blockMills(block, entry, moment);
  if (mills === null) return null;

  return { cob: cob, mills: mills };
}

function selectCOB (entry, opts) {
  opts = opts || {};
  var moment = opts.moment || defaultMoment;

  if (!entry || typeof entry !== 'object') return {};

  if (entry.openaps && typeof entry.openaps === 'object') {
    var enacted = candidate(entry.openaps.enacted, 'COB', entry, moment);
    var suggested = candidate(entry.openaps.suggested, 'COB', entry, moment);

    var best = (enacted && suggested)
      ? (enacted.mills > suggested.mills ? enacted : suggested)
      : (enacted || suggested);

    if (best) {
      return {
        cob: best.cob
        , source: 'OpenAPS'
        , device: entry.device
        , mills: best.mills
      };
    }
  }

  if (entry.loop && typeof entry.loop === 'object') {
    var loopCOB = candidate(entry.loop.cob, 'cob', entry, moment);
    if (loopCOB) {
      return {
        cob: loopCOB.cob
        , source: 'Loop'
        , device: entry.device
        , mills: loopCOB.mills
      };
    }
  }

  return {};
}

module.exports = selectCOB;
module.exports.selectCOB = selectCOB;
