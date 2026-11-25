'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const deviceStatus = require('../lib/server/devicestatus');
const createPort = require('../lib/server/tenant-app/devicestatus');
const { optInSuite } = require('./support/opt-in');
const { withTenant } = require('./fixtures/tenant-insertion-grants');
const catalogue = require('../migrations/candidates/postgres-devicestatus-socket-order-v1.json');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const EMPTY = '33333333-3333-4333-8333-333333333333';
const dated = offset => new Date(Date.now() + offset).toISOString();

optInSuite(!!uri, 'NS_TEST_POSTGRES_ADMIN_URI')('indexed v1 latest device status', function () {
  this.timeout(30000);
  const namespace = 'latest_' + randomBytes(6).toString('hex');
  const table = namespace + '.devicestatus';
  const role = namespace + '_reader';
  const seen = [];
  let mode, admin, reader, current, generic, transactions;

  function route (source) {
    const bus = new EventEmitter(), env = { devicestatus_collection: 'devicestatus' };
    const connection = {
      transaction: reader.transaction,
      readOnlyTransaction: fn => { transactions++; return reader.readOnlyTransaction(fn); },
      query (text, values) { seen.push({ text, values }); return reader.query(text, values); }
    };
    const port = createPort({ connection, table, catalogue, env, bus, source });
    return deviceStatus(env, { bus, storagePorts: { resolve: () => port } });
  }

  async function list (tenant, options = {}, api = current) {
    seen.length = 0;
    transactions = 0;
    return scope.withTenant(tenant, () => api.list({ count: 1, ...options }));
  }

  async function insert (tenant, ...docs) {
    return withTenant(admin, tenant, () => admin.query(`INSERT INTO ${table} (tenant_id, id_kind, doc)
      SELECT $1, 'string', doc FROM unnest($2::jsonb[]) AS t(doc)`, [tenant, docs.map(doc => JSON.stringify(doc))]));
  }

  before(async function () {
    mode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    admin = new Client({ connectionString: uri });
    await admin.connect();
    await run('up', { connectionString: uri, direct: true, namespace, catalogue });
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${namespace} TO ${role}`);
    await require('./fixtures/tenant-insertion-grants').grant(admin, { namespace, domain: 'devicestatus', role, catalogue, mode: 'reader' });
    const url = new URL(uri);
    url.username = role;
    url.password = password;
    reader = await connect({ connectionString: url.toString(), max: 1 });
    current = route('v1/internal');
    // The same wrapper and catalogue with the original generic reader.
    generic = route('v3');
    const proof = await scope.withTenant(A, () => reader.readOnlyTransaction(() =>
      reader.query('SELECT current_user AS role, row_security_active($1::regclass) AS rls', [table + '_rows'])));
    assert.deepEqual(proof.rows, [{ role, rls: true }]);
  });

  beforeEach(async function () { await admin.query('TRUNCATE ' + table + '_rows, ' + namespace + '.devicestatus_day'); });

  after(async function () {
    try {
      if (reader) await reader.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
        await admin.end();
      }
    } finally { scope.setTenancyMode(mode); }
  });

  it('seeks the newest visible scalar, preserving soft deletes, empty results and tenant isolation', async function () {
    const visible = { _id: 'current', created_at: dated(-100000) };
    await insert(A, visible, { _id: 'older', created_at: dated(-200000) },
      { _id: 'deleted', created_at: dated(-50000), isValid: false },
      { _id: 'deleted-array', created_at: [dated(-50000)], isValid: [false] },
      { _id: 'object', created_at: {} }, { _id: 'null', created_at: null },
      { _id: 'array-without-strings', created_at: [null, 12] });
    await insert(B, { _id: 'foreign-array', created_at: [dated(-10000)] });
    assert.deepEqual(await list(A), [visible]);
    assert.equal(seen.length, 1);
    assert.match(seen[0].text, /WITH bad AS MATERIALIZED/);
    const largest = { count: Number.MAX_SAFE_INTEGER };
    const expected = await list(A, largest, generic);
    assert.deepEqual(await list(A, largest), expected);
    assert.match(seen[0].text, /WITH bad AS MATERIALIZED/);
    assert.equal(seen[0].values.at(-1), largest.count);
    assert.deepEqual(await list(A, { count: 0 }), []);
    assert.equal(seen.length, 0);
    assert.deepEqual(await list(EMPTY), []);
    await assert.rejects(list(B), /sort over an array/);
  });

  it('refuses matching arrays outside the first page and reads earlier explicit history', async function () {
    const old = { _id: 'old', created_at: dated(-30 * 86400000) };
    await insert(A, old, { _id: 'new', created_at: dated(-1000) },
      { _id: 'off-page-array', created_at: [null, dated(-86400000)] });
    await assert.rejects(list(A), /sort over an array/);
    await assert.rejects(list(A, {}, generic), /sort over an array/);
    await insert(B, old);
    assert.deepEqual(await list(B), []);
    assert.deepEqual(await list(B, { find: { created_at: { $gte: dated(-31 * 86400000) } } }), [old]);
  });

  it('uses the original page on a top tie in one read transaction, and the generic reader on other shapes', async function () {
    const created_at = dated(-1000);
    await insert(A, { _id: 'first', created_at }, { _id: 'second', created_at });
    const expected = await list(A, {}, generic);
    assert.deepEqual(await list(A), expected);
    assert.equal(transactions, 1);
    assert.equal(seen.length, 2);
    assert.match(seen[1].text, /bool_or\(/);
    for (const opts of [{ count: undefined }, { sort: { created_at: 1 } }, { find: { isValid: 'true' } }]) {
      const original = await list(A, structuredClone(opts), generic);
      assert.deepEqual(await list(A, opts), original);
      assert.equal(seen.length, 1);
      assert.doesNotMatch(seen[0].text, /WITH bad AS MATERIALIZED/);
    }
  });

  it('bounds the ordinary history scan under active RLS', async function () {
    for (const tenant of [A, B]) {
      await withTenant(admin, tenant, () => admin.query(`INSERT INTO ${table} (tenant_id, id_kind, doc)
        SELECT $1, 'string', jsonb_build_object('_id', 'history-' || n,
          'created_at', to_char((now() AT TIME ZONE 'UTC') - n * interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        FROM generate_series(1, 576) AS n`, [tenant]));
    }
    await admin.query('ANALYZE ' + table + '_rows');
    const explain = statement => scope.withTenant(A, () => reader.readOnlyTransaction(async () => {
      const { rows } = await reader.query('EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ' + statement.text, statement.values);
      return rows[0]['QUERY PLAN'][0];
    }));
    function walk (node) { return [node, ...(node.Plans || []).flatMap(walk)]; }
    for (const count of [1, 100]) {
      const expected = await list(A, { count }, generic);
      const original = seen[0];
      assert.equal(expected.length, count);
      assert.deepEqual(await list(A, { count }), expected);
      assert.equal(seen.length, 1);
      const old = await explain(original);
      const indexed = await explain(seen[0]);
      assert(walk(old.Plan).some(n => n['Node Type'] === 'WindowAgg' && n['Actual Rows'] >= 576));
      assert(walk(indexed.Plan).some(n => n['Index Name'] === 'devicestatus_tenant_created_at_array'));
      const scans = walk(indexed.Plan).filter(n => n['Relation Name'] === 'devicestatus_rows');
      assert(scans.length >= 2);
      for (const node of scans) {
        assert(node['Actual Rows'] + (node['Rows Removed by Filter'] || 0) <= count + 1, JSON.stringify(node));
      }
    }
    const options = { count: 100 };
    const boundary = (await list(A, options, generic))[99];
    await insert(A, { _id: 'tie-at-100', created_at: boundary.created_at });
    const tied = await list(A, options, generic);
    assert.deepEqual(await list(A, options), tied);
    assert.equal(transactions, 1);
    assert.equal(seen.length, 2);
    assert.match(seen[1].text, /bool_or\(/);
    await insert(A, { _id: 'off-page-array', created_at: [dated(-86400000)] });
    await assert.rejects(list(A, options), /sort over an array/);

    const historical = Array.from({ length: 120 }, (_, i) => ({ _id: 'historical-' + i,
      created_at: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString() }));
    await insert(A, ...historical);
    await admin.query('ANALYZE ' + table + '_rows');
    const lo = historical[10].created_at, hi = historical[90].created_at;
    // Use the actual wrapper. Upper-only and reversed operator order keep their v1 edge semantics.
    for (const [range, matches] of [[{ $lte: hi, $gt: lo }, historical.slice(11, 91)],
      [{ $gte: lo, $lt: hi }, historical.slice(10, 90)], [{ $lt: lo }, historical.slice(0, 10)]]) {
      const query = { count: 100, find: { created_at: range } };
      const oracle = await list(A, structuredClone(query), generic);
      assert.deepEqual(oracle, matches.reverse());
      assert.deepEqual(await list(A, query), oracle);
      assert.equal(seen.length, 1);
      assert.match(seen[0].text, /WITH bad AS MATERIALIZED/);
      if (range.$gt) {
        const plan = walk((await explain(seen[0])).Plan);
        assert(plan.some(node => node['Index Name']?.includes('tenant_created') &&
          node['Index Cond']?.includes(lo) && node['Index Cond']?.includes(hi)));
      }
    }
    await insert(A, { _id: 'straddles-range', created_at: [historical[0].created_at, historical[119].created_at] });
    const narrow = { count: 100, find: { created_at: { $gt: lo, $lt: hi } } };
    await assert.rejects(list(A, structuredClone(narrow), generic), /sort over an array/);
    await assert.rejects(list(A, narrow), /sort over an array/);
  });

  it('checks arrays whose stored time key is NULL on a scalar-only predecessor schema', async function () {
    await admin.query('ALTER TABLE ' + table + '_rows ALTER COLUMN created_at DROP EXPRESSION');
    const timestamp = dated(-1000);
    await insert(A, { _id: 'legacy', created_at: [timestamp] });
    assert.equal((await admin.query('SELECT created_at FROM ' + table)).rows[0].created_at, null);
    await assert.rejects(list(A), /sort over an array/);
    await assert.rejects(list(A, {}, generic), /sort over an array/);
  });
});
