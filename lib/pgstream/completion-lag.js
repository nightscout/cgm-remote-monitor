'use strict';
// Durable evaluator completion lag (M1) per tenant, kept on the evaluator's
// `-completed` work row (work catalogue migration 0010) and accumulated by the
// completion UPDATE itself, so an observation commits atomically with the mark
// it clears or raises: a rolled-back or unconfirmed COMMIT leaves both alone.
// A harness reads the counters once before load and once after drain and
// differences them per tenant (decision plannable-scale-campaign, 2026-11-21).
//
// The observed value is the completion time (work_completed_at, this
// evaluator's clock) minus the writer's durable pending mark the completion
// cleared or raised (work_pending_at, the writer's clock: the api's
// Date.now() for a clinical write). Two clocks: a negative difference is
// counted in lag_negative and observed as 0, as the Prometheus M1 does.
//
// Buckets are fixed upper bounds in milliseconds (le, inclusive), counted per
// bucket (not cumulative); the last is +inf. lag_over_120s counts observations
// strictly above the 120 s deadline (the Prometheus le="120" complement).
const BOUNDS_MS = Object.freeze([250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, Infinity]);
const DEADLINE_MS = 120000;
const COLUMNS = Object.freeze(['lag_count', 'lag_sum_ms', 'lag_max_ms', 'lag_buckets', 'lag_over_120s', 'lag_negative']);

// One observation: { ms (clamped at 0), bucket (1-based, PostgreSQL array
// index), over (0|1), negative (0|1) }, or null when nothing was covered.
function observation (completedAt, coveredAt) {
  if (coveredAt === null || coveredAt === undefined) return null;
  if (!Number.isSafeInteger(completedAt) || !Number.isSafeInteger(coveredAt)) throw new TypeError('EVALUATOR_COMPLETION_LAG_INSTANT');
  const raw = completedAt - coveredAt, ms = raw < 0 ? 0 : raw;
  return { ms, bucket: BOUNDS_MS.findIndex(bound => ms <= bound) + 1, over: ms > DEADLINE_MS ? 1 : 0, negative: raw < 0 ? 1 : 0 };
}

// SET assignments for the completion UPDATE, given the 1-based parameter
// index of the first of four parameters (ms, bucket, over, negative).
function assignments (first) {
  if (!Number.isSafeInteger(first) || first < 1) throw new TypeError('EVALUATOR_COMPLETION_LAG_PARAMETER');
  const [ms, bucket, over, negative] = [0, 1, 2, 3].map(offset => '$' + (first + offset));
  return ',lag_count=lag_count+1,lag_sum_ms=lag_sum_ms+' + ms + '::bigint,lag_max_ms=GREATEST(lag_max_ms,' + ms + '::bigint)' +
    ',lag_buckets[' + bucket + '::int]=lag_buckets[' + bucket + '::int]+1,lag_over_120s=lag_over_120s+' + over + '::int' +
    ',lag_negative=lag_negative+' + negative + '::int';
}
const values = value => [value.ms, value.bucket, value.over, value.negative];

module.exports = { BOUNDS_MS, DEADLINE_MS, COLUMNS, observation, assignments, values };
