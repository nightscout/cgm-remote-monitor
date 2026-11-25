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

  it('keeps its answer while the tenant clock stamp is unchanged, and reads again on a new stamp, an old answer or a failed stamp', async function () {
    let stamp = '7', time = 1000, aggregates = 0, bytes = 5;
    const stats = createStats({ tables: { entries: 'stats_entries.entries' }, clock: 'stats_clock.tenant_write_clock', now: () => time,
      connection: { async query (sql, values) {
        assert.equal(scope.requireTenant('statistics supplied port'), 'tenant-a');
        if (sql.includes('"stats_clock"."tenant_write_clock"')) { assert.deepEqual(values, ['tenant-a']); return { rows: stamp === null ? [] : [{ stamp }] }; }
        aggregates++; return { rows: [{ bytes }] };
      } } });
    assert.deepEqual(await read(stats), { dataSize: 5, indexSize: undefined });
    bytes = 9; time += 299999 - 1;
    assert.deepEqual(await read(stats), { dataSize: 5, indexSize: undefined });
    assert.equal(aggregates, 1, 'an unchanged stamp reuses the aggregate');
    stamp = '8';
    assert.deepEqual(await read(stats), { dataSize: 9, indexSize: undefined });
    assert.equal(aggregates, 2, 'a new stamp reads the tenant again');
    bytes = 11; time += 300000;
    assert.deepEqual(await read(stats), { dataSize: 11, indexSize: undefined });
    assert.equal(aggregates, 3, 'an answer older than its bound is read again');
    stamp = null; bytes = 13;
    assert.deepEqual(await read(stats), { dataSize: 13, indexSize: undefined });
    stamp = '8'; bytes = 15;
    assert.deepEqual(await read(stats), { dataSize: 15, indexSize: undefined });
    assert.equal(aggregates, 5, 'a missing clock row keeps nothing');
    assert.throws(() => createStats({ tables, clock: 'pg_catalog.tenant_write_clock', connection: { query () {} } }), /schema\.table/);
  });
});
