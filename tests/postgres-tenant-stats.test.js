'use strict';

const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const createStats = require('../lib/storage/postgres-tenant-stats');

// Supplied-port protocol checks; actual PostgreSQL/RLS is covered separately.
describe('tenant statistics batched aggregates', function () {
  let previous;
  beforeEach(function () { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(previous); });
  const tables = { entries: 'stats_entries.entries', treatments: 'stats_treatments.treatments', duplicate: 'stats_entries.entries' };
  const read = stats => scope.withTenant('tenant-a', () => stats.read('tenant-a'));

  it('reads every domain, including duplicate tables, in one ordered logical-size statement', async function () {
    let calls = 0;
    const stats = createStats({ tables, connection: { async query (sql) {
      calls++;
      assert.equal(scope.requireTenant('statistics supplied port'), 'tenant-a');
      assert.match(sql, /ORDER BY source_index$/);
      assert.doesNotMatch(sql, /pg_total_relation_size|pg_relation_size/);
      const sources = [...sql.matchAll(/FROM "([a-z_]+)"\."([a-z_]+)"/g)];
      const sizes = { 'stats_entries.entries': 12, 'stats_treatments.treatments': 7 };
      return { rows: sources.map(([, schema, table]) => ({ bytes: sizes[schema + '.' + table] })) };
    } } });
    assert.deepEqual(await read(stats), { dataSize: 31, indexSize: undefined });
    assert.equal(calls, 1, 'all configured domains use one round trip');
  });

  it('preserves zero-sized domains and configured floating-point addition order', async function () {
    const stats = createStats({ tables, connection: { query: async () => ({ rows: [
      { bytes: Number.MAX_VALUE }, { bytes: 0 }, { bytes: 1 }
    ] }) } });
    assert.deepEqual(await read(stats), { dataSize: Number.MAX_VALUE, indexSize: undefined });
  });

  it('refuses missing, extra or malformed aggregate results and total overflow', async function () {
    const cases = [ [], [{ bytes: 1 }], Array(4).fill({ bytes: 1 }),
      [{ bytes: 1 }, { bytes: null }, { bytes: 1 }],
      [{ bytes: 1 }, { bytes: '2' }, { bytes: 1 }],
      [{ bytes: 1 }, { bytes: -1 }, { bytes: 1 }],
      [{ bytes: 1 }, { bytes: NaN }, { bytes: 1 }],
      [{ bytes: 1 }, { bytes: Infinity }, { bytes: 1 }],
      [{ bytes: Number.MAX_VALUE }, { bytes: Number.MAX_VALUE }, { bytes: 0 }] ];
    for (const rows of cases) {
      const stats = createStats({ tables, connection: { query: async () => ({ rows }) } });
      await assert.rejects(read(stats), /Tenant statistics unavailable/);
    }
  });

  it('checks tenant scope before querying and propagates a database refusal', async function () {
    let calls = 0;
    const failure = new Error('statistics denied');
    const stats = createStats({ tables, connection: { async query () { calls++; throw failure; } } });
    await assert.rejects(stats.read('tenant-a'), /no tenant bound/);
    await assert.rejects(scope.withTenant('tenant-b', () => stats.read('tenant-a')), /scope mismatch/);
    assert.equal(calls, 0);
    await assert.rejects(read(stats), error => error === failure);
    assert.equal(calls, 1);
  });
});
