'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const connect = require('../lib/storage/postgres-connection');
const scope = require('../lib/storage/tenant-scope');
const treatments = require('../lib/server/treatments');
const createPort = require('../lib/server/tenant-app/treatments');
const { optInSuite } = require('./support/opt-in');
const { withTenant } = require('./fixtures/tenant-insertion-grants');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dated = minutes => new Date(Date.now() - minutes * 60000).toISOString();

for (const variant of ['plain', 'ordered']) {
  optInSuite(!!uri, 'NS_TEST_POSTGRES_ADMIN_URI')('indexed v1 treatments page, ' + variant, function () {
    this.timeout(30000);
    const namespace = 'txpage_' + randomBytes(6).toString('hex');
    const table = namespace + '.treatments', role = namespace + '_reader';
    const ordered = variant === 'ordered';
    const catalogue = ordered ? require('../migrations/candidates/postgres-treatments-socket-order-v1.json')
      : require('../migrations/candidates/postgres-treatments-v1.json');
    let mode, admin, reader, current, generic;
    const seen = [];

    function route (source) {
      const bus = new EventEmitter(), env = { treatments_collection: 'treatments' };
      const connection = { transaction: reader.transaction, readOnlyTransaction: reader.readOnlyTransaction,
        query (text, values) { seen.push({ text, values }); return reader.query(text, values); } };
      const port = createPort({ connection, table, catalogue, env, bus, source });
      return treatments(env, { bus, storagePorts: { resolve: () => port } });
    }

    function list (tenant, options = {}, api = current) {
      seen.length = 0;
      return scope.withTenant(tenant, () => api.list({ count: 10, ...options }));
    }

    function insert (tenant, docs) {
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
      await admin.query(`GRANT SELECT ON ${table} TO ${role}`);
      const url = new URL(uri);
      url.username = role;
      url.password = password;
      reader = await connect({ connectionString: url.toString(), max: 1 });
      current = route('v1/internal');
      generic = route('v3');
      const proof = await scope.withTenant(A, () => reader.readOnlyTransaction(() =>
        reader.query('SELECT current_user AS role, row_security_active($1::regclass) AS rls', [table])));
      assert.deepEqual(proof.rows, [{ role, rls: true }]);
    });
    beforeEach(async function () { await admin.query('TRUNCATE ' + table); });
    after(async function () {
      try {
        if (reader) await reader.end();
        if (admin) {
          await admin.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
          await admin.query('DROP ROLE IF EXISTS ' + role);
          await admin.end();
        }
      } finally { scope.setTenancyMode(mode); }
    });

    it('preserves ties inside the page and across its edge, visibility, explicit history and off-page refusals', async function () {
      const docs = Array.from({ length: 13 }, (_, i) => ({ _id: 'tx-' + i, created_at: dated(1 + i) }));
      docs[10].created_at = docs[9].created_at;
      await insert(A, [...docs, { _id: 'old', created_at: dated(10 * 1440) },
        { _id: 'deleted-newer', created_at: dated(0), isValid: false },
        { _id: 'deleted-array', created_at: [dated(10)], isValid: [false] }]);
      await insert(B, [{ _id: 'other-tenant', created_at: [dated(0)] }]);
      const expected = await list(A, {}, generic);
      assert.deepEqual(await list(A), expected);
      assert.match(seen[0].text, /WITH bad AS MATERIALIZED/);
      assert.equal(seen.length, ordered ? 1 : 2);
      if (ordered) assert.deepEqual(expected.map(doc => doc._id), [0, 1, 2, 3, 4, 5, 6, 7, 8, 10].map(n => 'tx-' + n));
      // Now move that edge tie off the page and leave a tie solely inside it.
      await insert(A, [{ _id: 'inside-page', created_at: docs[0].created_at }]);
      const inside = await list(A, {}, generic);
      assert.deepEqual(await list(A), inside);
      assert.equal(seen.length, ordered ? 1 : 2);
      if (ordered) assert.equal(inside[0]._id, 'inside-page');
      for (const opts of [{ count: undefined }, { sort: { created_at: 1 } }, { find: { eventType: 'Note' } }]) {
        const original = await list(A, structuredClone(opts), generic);
        assert.deepEqual(await list(A, opts), original);
        assert.doesNotMatch(seen[0].text, /WITH bad AS MATERIALIZED/);
      }
      await assert.rejects(list(B), /sort over an array/);
      await insert(A, [{ _id: 'off-page-array', created_at: [dated(60)] }]);
      await assert.rejects(list(A), /sort over an array/);
      await assert.rejects(list(A, {}, generic), /sort over an array/);
      await admin.query('TRUNCATE ' + table);
      await insert(A, [{ _id: 'old', created_at: dated(10 * 1440) }]);
      assert.deepEqual(await list(A), []);
      assert.equal((await list(A, { find: { created_at: { $gte: dated(11 * 1440) } } }))[0]._id, 'old');
    });

    it('uses the exception and time indexes for bounded pages under RLS', async function () {
      const docs = Array.from({ length: 575 }, (_, i) => ({ _id: 'recent-' + i, created_at: dated(i * 5) }));
      for (const tenant of [A, B]) await insert(tenant, docs);
      await admin.query('ANALYZE ' + table);
      async function explain ({ text, values }) {
        const { rows } = await scope.withTenant(A, () => reader.readOnlyTransaction(() =>
          reader.query('EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ' + text, values)));
        function walk (node) { return [node, ...(node.Plans || []).flatMap(walk)]; }
        return walk(rows[0]['QUERY PLAN'][0].Plan);
      }
      for (const count of [10, 100]) {
        const expected = await list(A, { count }, generic);
        const original = seen[0];
        assert.equal(expected.length, count);
        assert.deepEqual(await list(A, { count }), expected);
        assert.equal(seen.length, 1);
        const baseline = await explain(original);
        assert(baseline.some(node => node['Node Type'] === 'WindowAgg' && node['Actual Rows'] >= docs.length));
        const plan = await explain(seen[0]);
        assert(plan.some(node => node['Index Name'] === 'treatments_tenant_created_at_array'));
        assert(plan.some(node => node['Index Name'] === 'treatments_tenant_created_at'));
        // PostgreSQL incremental sort may read ahead one group of ordinal ties.
        const scans = plan.filter(node => node['Relation Name'] === 'treatments');
        for (const node of scans) assert(node['Actual Rows'] + (node['Rows Removed by Filter'] || 0) <= count + 32, JSON.stringify(node));
      }
      const options = { count: 100 };
      await insert(A, [{ _id: 'tie-at-100', created_at: docs[99].created_at }]);
      const tied = await list(A, options, generic);
      assert.deepEqual(await list(A, options), tied);
      assert.equal(seen.length, ordered ? 1 : 2);
      if (ordered) assert.equal(tied[99]._id, 'tie-at-100');
      await insert(A, [{ _id: 'off-page-array', created_at: [dated(24 * 60)] }]);
      await assert.rejects(list(A, options), /sort over an array/);

      const historical = Array.from({ length: 120 }, (_, i) => ({ _id: 'historical-' + i,
        created_at: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString() }));
      await insert(A, historical);
      await admin.query('ANALYZE ' + table);
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
          const plan = await explain(seen[0]);
          assert(plan.some(node => node['Index Name']?.includes('tenant_created') &&
            node['Index Cond']?.includes(lo) && node['Index Cond']?.includes(hi)));
        }
      }
      await insert(A, [{ _id: 'straddles-range', created_at: [historical[0].created_at, historical[119].created_at] }]);
      const narrow = { count: 100, find: { created_at: { $gt: lo, $lt: hi } } };
      await assert.rejects(list(A, structuredClone(narrow), generic), /sort over an array/);
      await assert.rejects(list(A, narrow), /sort over an array/);
    });

    it('checks matching legacy array timestamps with a NULL generated key', async function () {
      await admin.query('ALTER TABLE ' + table + ' ALTER COLUMN created_at DROP EXPRESSION');
      await insert(A, [{ _id: 'old-schema-array', created_at: [dated(0)] }]);
      await assert.rejects(list(A), /sort over an array/);
      await assert.rejects(list(A, {}, generic), /sort over an array/);
    });
  });
}
