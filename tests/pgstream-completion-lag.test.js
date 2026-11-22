'use strict';
// Durable M1 bucket and counter math (lib/pgstream/completion-lag.js). The
// PostgreSQL behaviour is in pgstream-typed-checkpoint.integration.test.js.
const assert = require('node:assert/strict');
const lag = require('../lib/pgstream/completion-lag');

describe('durable completion lag: bucket and counter math', function () {
  it('uses the fixed upper bounds with +inf last and matches the migration', function () {
    assert.deepEqual(lag.BOUNDS_MS, [250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, Infinity]);
    const migration = require('../migrations/candidates/postgres-evaluator-work-v2.json').migrations.find(m => m.name === '0010_evaluator_completion_lag');
    assert.ok(migration, 'MIGRATION_0010_MISSING');
    for (const column of lag.COLUMNS) assert.ok(migration.up.some(sql => sql.includes('ADD COLUMN ' + column + ' ')), column);
    assert.ok(migration.up.some(sql => sql.includes("DEFAULT '{" + Array(lag.BOUNDS_MS.length).fill(0).join(',') + "}'") && sql.includes('cardinality(lag_buckets) = ' + lag.BOUNDS_MS.length)));
  });
  it('puts each edge in its own bucket (le, inclusive) and the next millisecond in the next', function () {
    const finite = lag.BOUNDS_MS.slice(0, -1);
    finite.forEach((bound, i) => {
      assert.equal(lag.observation(bound, 0).bucket, i + 1, 'edge ' + bound);
      assert.equal(lag.observation(bound + 1, 0).bucket, i + 2, 'past ' + bound);
    });
    assert.equal(lag.observation(0, 0).bucket, 1);
    assert.equal(lag.observation(Number.MAX_SAFE_INTEGER, 0).bucket, 10, '+inf');
  });
  it('counts over 120 s strictly above the deadline', function () {
    assert.equal(lag.observation(120000, 0).over, 0);
    assert.equal(lag.observation(120001, 0).over, 1);
    assert.equal(lag.observation(120001, 0).bucket, 10);
  });
  it('observes a negative difference as 0 and flags it; nothing covered is no observation', function () {
    assert.deepEqual(lag.observation(1000, 1500), { ms: 0, bucket: 1, over: 0, negative: 1 });
    assert.deepEqual(lag.observation(1500, 1000), { ms: 500, bucket: 2, over: 0, negative: 0 });
    assert.equal(lag.observation(1500, null), null);
    assert.equal(lag.observation(1500, undefined), null);
    assert.throws(() => lag.observation(1.5, 1), /EVALUATOR_COMPLETION_LAG_INSTANT/);
    assert.throws(() => lag.observation(null, 1), /EVALUATOR_COMPLETION_LAG_INSTANT/);
  });
  it('builds the SET assignments from the given parameter index', function () {
    const sql = lag.assignments(14);
    assert.equal(sql, ',lag_count=lag_count+1,lag_sum_ms=lag_sum_ms+$14::bigint,lag_max_ms=GREATEST(lag_max_ms,$14::bigint)' +
      ',lag_buckets[$15::int]=lag_buckets[$15::int]+1,lag_over_120s=lag_over_120s+$16::int,lag_negative=lag_negative+$17::int');
    assert.deepEqual(lag.values(lag.observation(3000, 0)), [3000, 5, 0, 0]);
    assert.throws(() => lag.assignments(0), /EVALUATOR_COMPLETION_LAG_PARAMETER/);
  });
  it('is granted to the evaluator with the work columns, fresh and on a restore-forward bootstrap', function () {
    const work = require('../lib/pgstream/checkpoint').WORK_COLUMNS;
    for (const column of lag.COLUMNS) assert.ok(work.includes(column), column);
    // The deployment's grants (deploy bootstrap applies them after migrate up, on a fresh and on a
    // restored database), over a synthetic layout that names every namespace and role it asks for.
    const names = prefix => new Proxy({}, { get: (_, key) => typeof key === 'string' ? prefix + key : undefined, has: () => true,
      getOwnPropertyDescriptor: (_, key) => ({ value: prefix + String(key), configurable: true, enumerable: true, writable: true }) });
    const l = { prefix: 'nslag', owner: 'nslag_owner', namespaces: names('nslag_'), roles: names('nslag_r_') };
    const sql = require('../lib/server/ordinary-deployment-grants').grants(l);
    const expected = 'GRANT UPDATE(' + lag.COLUMNS.join(',') + ') ON "' + l.namespaces.eval_checkpoint + '"."tenant_consumer_checkpoint" TO "' + l.roles.evaluator + '"';
    assert.ok(sql.includes(expected), 'RESTORE_PATH_GRANT_MISSING');
  });
});
