'use strict';
// Statements counted by the evaluator fixture workers, by pool and kind, per unit.
function classify (shape) {
  const sql = shape.slice(shape.indexOf(' | ') + 3);
  if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START TRANSACTION|SET TRANSACTION)/i.test(sql)) return 'transaction';
  if (/pg_column_size\(doc\)/.test(sql)) return 'dbstats';
  if (/tenant_lifecycle|pg_postmaster_start_time|lifecycle_window|restore_generation|generation/i.test(sql) && !/tenant_consumer_checkpoint/.test(sql)) return 'fence';
  if (/tenant_consumer_checkpoint/.test(sql)) return 'checkpoint';
  if (/tenant_settings|tenant_operator_policy|tenant_activity|tenant_write_clock/.test(sql)) return 'trusted';
  if (/notification|alarm_suppression/.test(sql)) return 'outbox';
  return 'other';
}
function summarize (counts, units) {
  const byPool = {}, byClass = {};
  for (const [shape, count] of Object.entries(counts)) {
    const pool = shape.slice(0, shape.indexOf(' | '));
    byPool[pool] = (byPool[pool] || 0) + count;
    const key = pool + ':' + classify(shape);
    byClass[key] = (byClass[key] || 0) + count;
  }
  const per = object => Object.fromEntries(Object.entries(object).sort().map(([key, value]) => [key, +(value / units).toFixed(2)]));
  return { writes: units, perWriteByPool: per(byPool), perWriteByClass: per(byClass),
    shapes: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([shape, count]) => [+(count / units).toFixed(2), shape]) };
}
module.exports = { classify, summarize };
