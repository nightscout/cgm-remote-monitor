'use strict';

// Lane INC-C (#8898 round, 2026-11-22): the consumer pass and overload
// inputs. Every switch is off unless set; each is deleted at adoption or with
// its change if a measurement refutes it. The instruments are not switched.
//  - NS_CONSUMER_ONE_SELECT=true: one producer selection per consumer pass
//    (lib/tenant-notifications/component.js eligible()).
//  - NS_EVAL_TIME_ONLY_COALESCE=true: a time-only cycle is skipped only when
//    an acquisition for the same tenant is already queued
//    (evaluator-runtime.js enqueue).
const ONE_SELECT = 'NS_CONSUMER_ONE_SELECT', COALESCE = 'NS_EVAL_TIME_ONLY_COALESCE';
const raw = (key, source) => source && Object.hasOwn(source, key) ? String(source[key]).trim().toLowerCase() : '';
function flag (key, source = process.env) {
  const value = raw(key, source);
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new TypeError(key + ' must be true or false');
}
const oneSelect = source => flag(ONE_SELECT, source);
const timeOnlyCoalesce = source => flag(COALESCE, source);
module.exports = { oneSelect, timeOnlyCoalesce, ONE_SELECT, COALESCE };
