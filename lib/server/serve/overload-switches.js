'use strict';

// Lane INC-C (#8898 round, 2026-11-22): the consumer pass and overload
// inputs. Every switch is off unless set; each is deleted at adoption or with
// its change if a measurement refutes it. The instruments are not switched.
//  - NS_CONSUMER_ONE_SELECT=true: one producer selection per consumer pass
//    (lib/tenant-notifications/component.js eligible()).
//  - NS_OUTBOX_POOL=<1..64>: the notification outbox pool size (default: the
//    deployment's maxConnections, 2).
//  - NS_EVAL_PRIORITY=evaluation-first: queued consumer passes wait while the
//    evaluator owes a recompute, with a bounded share admitted every turn
//    (evaluator-consumers.js passGate); 'arrival' or unset keeps today's order.
//  - NS_EVAL_TIME_ONLY_COALESCE=true: a time-only cycle is skipped only when
//    an acquisition for the same tenant is already queued
//    (evaluator-runtime.js enqueue).
const ONE_SELECT = 'NS_CONSUMER_ONE_SELECT', OUTBOX_POOL = 'NS_OUTBOX_POOL', PRIORITY = 'NS_EVAL_PRIORITY', COALESCE = 'NS_EVAL_TIME_ONLY_COALESCE';
const raw = (key, source) => source && Object.hasOwn(source, key) ? String(source[key]).trim().toLowerCase() : '';
function flag (key, source = process.env) {
  const value = raw(key, source);
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new TypeError(key + ' must be true or false');
}
const oneSelect = source => flag(ONE_SELECT, source);
const timeOnlyCoalesce = source => flag(COALESCE, source);
function evaluationFirst (source = process.env) {
  const value = raw(PRIORITY, source);
  if (value === '' || value === 'arrival') return false;
  if (value === 'evaluation-first') return true;
  throw new TypeError(PRIORITY + ' must be evaluation-first or arrival');
}
function outboxPool (fallback, source = process.env) {
  const value = raw(OUTBOX_POOL, source);
  if (value === '') return fallback;
  if (!/^[1-9][0-9]?$/.test(value) || Number(value) > 64) throw new TypeError(OUTBOX_POOL + ' must be a whole number from 1 to 64');
  return Number(value);
}
module.exports = { oneSelect, timeOnlyCoalesce, evaluationFirst, outboxPool, ONE_SELECT, OUTBOX_POOL, PRIORITY, COALESCE };
