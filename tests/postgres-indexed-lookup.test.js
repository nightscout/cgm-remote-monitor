'use strict';

// Index-bounded equality (postgres-filter INDEXED_COLUMNS) on the shipping
// candidate schemas (migrations/candidates/postgres-<table>-v1.json):
//   1. answers: eq/in/ne/nin on every bounded field, over strings, arrays that
//      do and do not reach the operand, nested arrays, null, missing, numbers
//      and the empty string, are what mongod answers (tenant B holds the same
//      documents, so a leak changes an answer);
//   2. cost: the upload target lookups (entries sysTime + type, identifier,
//      treatments created_at + eventType, devicestatus created_at) read an
//      index range, not every row the tenant holds. On the unbounded compiler
//      each scans the tenant's history and this fails.
// Not bounded (open): an identifier lookup still reads the tenant's rows that
// hold no string identifier (entries), or every row (other tables, whose only
// identifier index is partial), since the array arm has no index.
// Requires both disposable databases; skipped (not passed) otherwise.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Client } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const { and, or, cmp } = require('../lib/storage/filter');
const connect = require('../lib/storage/postgres-connection');
const { encodeDocument } = require('../lib/storage/postgres-identity');
const entriesRead = require('../lib/storage/postgres-entries-read');
const entriesWrite = require('../lib/storage/postgres-entries-write');
const { run } = require('../lib/migrations/postgres');
const grants = require('./fixtures/tenant-insertion-grants');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

const pgURI = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const mongoURI = process.env.CUSTOMCONNSTR_mongo;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TABLES = {
  entries: { text: ['sysTime', 'type', 'dateString', 'identifier'], number: ['date'] },
  // `note` and `carbs` are not indexed: they check array-element equality
  // (containment) on a field with no bound.
  treatments: { text: ['created_at', 'eventType', 'identifier', 'note'], number: ['carbs'] },
  devicestatus: { text: ['created_at', 'identifier'], number: [] },
  activity: { text: ['created_at', 'identifier'], number: [] },
  profile: { text: ['identifier'], number: [] },
  food: { text: ['identifier'], number: [] }
};
const HISTORY = 3000;

// Every value shape a bounded field can hold, for every bounded field at once.
function documents ({ text, number }) {
  const shapes = [['v1', 1000], [['v1', 'zz'], [1000, 2000]], [['a', 'b'], [5, 6]], [undefined, undefined],
    [null, null], [7, 'x'], ['', 0], ['v2', 1000.5], [[['v1']], [[1000]]], [['zz'], [999.5]], ['V1', 1001]];
  return shapes.map(([s, n], index) => {
    const doc = { _id: 'd' + index };
    for (const field of text) if (s !== undefined) doc[field] = s;
    for (const field of number) if (n !== undefined) doc[field] = n;
    return doc;
  });
}

function filters ({ text, number }) {
  const out = [];
  for (const f of text) {
    for (const v of ['v1', 'zz', 'a', '', 'V1', 'v2', 'missing']) out.push(cmp('eq', f, v));
    out.push(cmp('eq', f, null), cmp('eq', f, 7), cmp('in', f, ['v2', 'b']), cmp('in', f, ['zz', null]),
      cmp('in', f, ['v1', 7]), cmp('ne', f, 'v1'), cmp('nin', f, ['v1', 'a']));
    // Ranges: a lower bound on a window column is index-bounded.
    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      for (const v of ['v1', 'zz', 'a', '', 'V1', 'zzz', 7, null]) out.push(cmp(op, f, v));
    }
  }
  for (const f of number) {
    for (const v of [1000, 1000.5, 2000, 5, 6, 999.5, 999, 0, -1]) out.push(cmp('eq', f, v));
    out.push(cmp('eq', f, 'x'), cmp('eq', f, null), cmp('in', f, [6, 1000.5]), cmp('ne', f, 1000), cmp('nin', f, [2000]));
    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      for (const v of [1000, 1000.5, 999.5, 2000, 2000.5, 6, 0, -1, 'x', null]) out.push(cmp(op, f, v));
    }
  }
  if (text.length > 1) {
    out.push(and(cmp('eq', text[0], 'v1'), cmp('eq', text[1], 'v1')),
      or(and(cmp('eq', text[0], 'zz'), cmp('eq', text[1], 'zz')), and(cmp('eq', text[0], 'v2'), cmp('eq', text[1], 'v2'))),
      // $or bounded once (every branch bounds both columns; operands unioned)
      or(and(cmp('in', text[0], ['v1', 'zz']), cmp('eq', text[1], 'a')), and(cmp('eq', text[0], 'V1'), cmp('eq', text[1], 'v1')),
        and(cmp('eq', text[0], 'b'), cmp('in', text[1], ['b', '']))),
      // no column common to every branch: each branch keeps its own bound
      or(cmp('eq', text[0], 'v1'), cmp('eq', text[1], 'zz')),
      // an operand of another type on one column: only the other column is bounded once
      or(and(cmp('eq', text[0], 'v1'), cmp('eq', text[1], null)), and(cmp('eq', text[0], 'zz'), cmp('eq', text[1], 'b'))),
      // nested: an $or inside an AND, and an $or inside a branch
      and(or(cmp('eq', text[0], 'a'), cmp('eq', text[0], 'v2')), cmp('ne', text[1], 'x')),
      or(and(cmp('eq', text[0], 'v1'), or(cmp('eq', text[1], 'v1'), cmp('eq', text[1], 'zz'))), cmp('eq', text[0], 'a')));
  }
  if (number.length) {
    out.push(or(cmp('eq', number[0], 1000), cmp('eq', number[0], 6), cmp('in', number[0], [999.5, 2000])),
      or(cmp('eq', number[0], 1000), cmp('eq', number[0], 'x')));
  }
  return out;
}

optInSuite(pgURI && mongoURI, 'NS_TEST_POSTGRES_ADMIN_URI and CUSTOMCONNSTR_mongo')(
  'PostgreSQL index-bounded equality on the candidate schemas', function () {
    this.timeout(60000);
    const name = 'ns_bound_' + randomUUID().replace(/-/g, '').slice(0, 16);
    const role = name + '_app';
    const labs = {};
    let admin, store, mongo, mode;

    before(async function () {
      mode = scope.getTenancyMode();
      scope.setTenancyMode('multi');
      admin = new Client({ connectionString: pgURI });
      await admin.connect();
      const password = randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      mongo = new MongoClient(mongoURI);
      await mongo.connect();
      for (const table of Object.keys(TABLES)) {
        const namespace = name + '_' + table.slice(0, 4);
        // eslint-disable-next-line security/detect-non-literal-require -- fixed candidate names
        const catalogue = require(`../migrations/candidates/postgres-${table}-v1.json`);
        await run('up', { direct: true, connectionString: pgURI, namespace, catalogue });
        await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${role}"`);
        await grants.grant(admin, { namespace, domain: table, role, catalogue });
        const docs = documents(TABLES[table]);
        for (const tenant of [A, B]) {
          const rows = docs.map(doc => encodeDocument(doc));
          await grants.withTenant(admin, tenant, () => admin.query(`INSERT INTO "${namespace}"."${table}" (tenant_id, id_kind, doc)
            SELECT $1, kind, doc FROM unnest($2::text[], $3::jsonb[]) AS row(kind, doc)`,
          [tenant, rows.map(r => r.id_kind), rows.map(r => JSON.stringify(r.doc))]));
        }
        const collection = mongo.db().collection(name + '_' + table);
        await collection.insertMany(docs.map(doc => ({ ...doc })));
        labs[table] = { namespace, qualified: namespace + '.' + table, collection,
          mongo: new MongoCollection({ store: { collection: n => mongo.db().collection(n), db: mongo.db() }, bus: new EventEmitter() },
            { writeValidation: 'off' }, name + '_' + table, table, []) };
      }
      const url = new URL(pgURI);
      url.username = role;
      url.password = password;
      store = await connect({ connectionString: url.toString(), max: 2 });
    });

    after(async function () {
      try {
        if (store) await store.end();
        if (mongo) {
          for (const lab of Object.values(labs)) await lab.collection.drop().catch(() => {});
          await mongo.close();
        }
        if (admin) {
          for (const lab of Object.values(labs)) await admin.query(`DROP SCHEMA IF EXISTS "${lab.namespace}" CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS "${role}"`);
          await admin.end();
        }
      } finally {
        if (mode !== undefined) scope.setTenancyMode(mode);
      }
    });

    const raw = { sort: { _id: 1 }, options: { normalize: false } };

    for (const table of Object.keys(TABLES)) {
      it(`answers what mongod answers for every bounded field of ${table}`, async function () {
        const lab = labs[table];
        const reader = entriesRead({ connection: store, table: lab.qualified });
        let nonEmpty = 0;
        for (const ast of filters(TABLES[table])) {
          const expected = await scope.withTenant(A, () => lab.mongo.findFiltered(ast, raw));
          const actual = await store.withTenant(A, () => reader.findFiltered(ast, raw));
          assert.deepStrictEqual(actual, expected, `${table} ${JSON.stringify(ast)}`);
          const count = await store.withTenant(A, () => reader.count(ast));
          assert.equal(count, expected.length, `${table} count ${JSON.stringify(ast)}`);
          if (expected.length) nonEmpty++;
        }
        assert.ok(nonEmpty > 10, 'the matrix exercises matches, not only empty answers');
      });
    }

    it('keeps numeric v1 date-page filters, tie membership and exceptional stored dates', async function () {
      const tenant = '55555555-5555-4555-8555-555555555555';
      const table = labs.entries.qualified, statements = [];
      const connection = { ...store, query (sql, values) { statements.push(sql); return store.query(sql, values); } };
      const indexed = entriesRead({ connection, table, latestTimeDomain: 'entries' });
      const generic = entriesRead({ connection, table });
      const { fromMongo } = require('../lib/storage/filter');
      const filter = fromMongo({ date: { $gt: 100, $lte: 200 }, type: 'sgv', isValid: { $ne: false } });
      const options = { sort: { date: -1 }, limit: 2, options: { normalize: false } };
      async function list (reader, ast = filter) {
        statements.length = 0;
        return scope.withTenant(tenant, () => reader.findFiltered(ast, options));
      }
      const insert = docs => grants.withTenant(admin, tenant, () => admin.query(`INSERT INTO ${table}(tenant_id,id_kind,doc)
        SELECT $1, 'string', doc FROM unnest($2::jsonb[]) AS t(doc)`, [tenant, docs.map(doc => JSON.stringify(doc))]));
      await insert([{ _id: 'first', date: 200, type: ['sgv'] }, { _id: 'next', date: 150, type: 'sgv' },
        { _id: 'lower', date: 100, type: 'sgv' }, { _id: 'wrong-type', date: [90, 300], type: 'mbg' },
        { _id: 'invisible', date: [90, 300], type: 'sgv', isValid: [false] }]);
      const expected = await list(generic);
      assert.deepEqual(expected.map(d => d._id), ['first', 'next']);
      assert.deepEqual(await list(indexed), expected);
      assert.equal(statements.length, 1);
      assert.match(statements[0], /WITH bad AS MATERIALIZED/);
      await insert([{ _id: 'nonmatching-new', date: 199, type: 'mbg' },
        { _id: 'removed-new', date: 198, type: 'sgv', isValid: false },
        { _id: 'nonmatching-middle', date: 197, type: 'cal' }]);
      assert.deepEqual(await list(indexed), expected, 'refill after newer nonmatching candidates');
      assert.equal(statements.length, 1);
      const optionalDate = fromMongo({ $or: [{ date: { $gt: 100 } }, { _id: 'lower' }] });
      await assert.rejects(list(indexed, optionalDate), /sort over an array/);
      assert.doesNotMatch(statements[0], /WITH bad AS MATERIALIZED/);

      await insert([{ _id: 'tie', date: 150, type: 'sgv' }]);
      const tied = await list(generic);
      assert.deepEqual(await list(indexed), tied);
      assert.equal(statements.length, 2);
      await insert([{ _id: 'fraction', date: 199.75, type: 'sgv' }]);
      const fractional = await list(generic);
      assert.deepEqual(fractional.map(d => d._id), ['first', 'fraction']);
      assert.deepEqual(await list(indexed), fractional);
      assert.equal(statements.length, 2);
      const strict = fromMongo({ date: { $gt: 199, $lt: 200 }, type: 'sgv', isValid: { $ne: false } });
      assert.deepEqual((await list(indexed, strict)).map(d => d._id), ['fraction']);
      await insert([{ _id: 'array', date: [90, 300], type: 'sgv' }]);
      await assert.rejects(list(indexed), /sort over an array/);
      assert.equal(statements.length, 2);
    });

    describe('private follower entries pages', function () {
      const tenant = '33333333-3333-4333-8333-333333333333';
      const foreign = '44444444-4444-4444-8444-444444444444';
      // Nominal looping-history-v2 tenant zero's first synthetic SGV.
      const nominal = { type: 'sgv', device: 's4_history_fixture_looping_2d_v2', direction: 'Flat',
        sgv: 108, date: 1795374300000, dateString: '2026-11-22T19:05:00.000Z', delta: 0, noise: 1,
        filtered: 108176, unfiltered: 107776, rssi: 100, utcOffset: 0 };
      const end = nominal.date;
      const request = { type: 'sgv', count: 1, from: end - 172800000, to: end };
      const scopeRead = fn => scope.withTenant(tenant, fn);
      let storage, seen;
      async function seed (docs, target = tenant) {
        const rows = docs.map(encodeDocument);
        return grants.withTenant(admin, target, () => admin.query(`INSERT INTO ${labs.entries.qualified} (tenant_id,id_kind,doc)
          SELECT $1, k, d FROM unnest($2::text[], $3::jsonb[]) AS pair(k,d)`,
        [target, rows.map(r => r.id_kind), rows.map(r => JSON.stringify(r.doc))]));
      }
      const page = (changes = {}) => scopeRead(() => storage.readFollowerEntries({ ...request, ...changes }));
      before(function () {
        const entries = require('../lib/server/tenant-app/entries');
        const connection = { ...store, query (text, values) { seen = { text, values }; return store.query(text, values); } };
        storage = entries({ source: 'v1/internal', connection, table: labs.entries.qualified }).storage;
        assert.equal(typeof storage.readFollowerEntries, 'function');
        assert.equal(entries({ source: 'v3', connection, table: labs.entries.qualified }).storage.readFollowerEntries, undefined);
      });
      beforeEach(async function () {
        await admin.query('DELETE FROM ' + labs.entries.qualified + ' WHERE tenant_id = ANY($1::uuid[])', [[tenant, foreign]]);
        seen = null;
      });

      it('uses the sparse exception index and a surviving ordered time index for nominal aligned times under RLS', async function () {
        const deployed = require('../migrations/candidates/postgres-entries-v1.json').migrations.find(m => m.name === '0103_entries_follower_exceptions');
        const { INDEX_NAME, EXCEPTION } = require('../lib/storage/postgres-follower-entries');
        assert.deepEqual(deployed.up, [`CREATE INDEX ${INDEX_NAME} ON entries (tenant_id, date) WHERE (${EXCEPTION})`]);
        const docs = Array.from({ length: 576 }, (_, n) => {
          const date = end - n * 300000, iso = new Date(date).toISOString();
          return { ...nominal, _id: 'history-' + n, date, dateString: iso, sysTime: iso,
            ...(n % 3 === 1 ? { created_at: iso } : n % 3 === 2 ? { mills: date } : {}) };
        });
        await seed(docs);
        await seed([{ _id: 'other-tenant', type: 'sgv', sgv: 99, date: [end] }], foreign);
        await admin.query('ANALYZE ' + labs.entries.qualified);
        assert.deepEqual(await page(), [docs[0]]);
        const { text, values } = seen;
        const { rows } = await scopeRead(() => store.readOnlyTransaction(() => store.query(
          'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ' + text, values)));
        function walk (p) { return [p, ...(p.Plans || []).flatMap(walk)]; }
        const nodes = walk(rows[0]['QUERY PLAN'][0].Plan);
        assert(nodes.some(n => n['Index Name'] === INDEX_NAME));
        assert(nodes.some(n => ['entries_tenant_type_date_datestring', 'entries_tenant_date_identifier_created_at'].includes(n['Index Name'])));
        for (const n of nodes.filter(n => n['Relation Name'] === 'entries')) {
          assert(n['Actual Rows'] + (n['Rows Removed by Filter'] || 0) <= 2, JSON.stringify(n));
        }
        for (const count of [10, 11, 100, Number.MAX_SAFE_INTEGER]) {
          assert.deepEqual(await page({ count }), docs.slice(0, count).reverse());
        }
        seen = null;
        for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          assert.equal(await page({ count }), null);
        }
        assert.equal(seen, null, 'invalid counts must bypass the probe');
      });

      it('recognizes canonical UTC through leap day, midnight and nonzero milliseconds', async function () {
        const dates = [1, Date.parse('2024-02-29T00:00:00.010Z'), Date.parse('2026-11-22T23:59:59.100Z')];
        for (const date of dates) {
          const doc = { _id: 'date-' + date, type: 'sgv', sgv: 100, date, created_at: new Date(date).toISOString() };
          await seed([doc]);
          assert.deepEqual(await page({ from: date, to: date }), [doc]);
        }
      });

      it('returns sparse MBG/cal and both identity kinds in storage order, respecting visibility', async function () {
        const hex = '65a1b2c3d4e5f60718293a4b';
        const old = { _id: new ObjectId(hex), type: 'mbg', mbg: null, date: end - 5 };
        const current = { _id: hex, type: 'mbg', mbg: 0, date: end };
        const cal = { _id: 'cal', type: 'cal', date: end };
        await seed([old, current, cal,
          { _id: 'deleted', type: 'mbg', mbg: 1, date: end, isValid: [false] },
          { _id: 'deleted-array', type: 'other', date: [end], isValid: false }]);
        assert.deepEqual(await page({ type: 'mbg', count: 2 }), [old, current]);
        assert.deepEqual(await page({ type: 'cal' }), [cal]);
        assert.deepEqual(await page(), []);
        await seed([{ _id: 'absent', type: 'mbg', date: end - 1 }]);
        assert.equal(await page({ type: 'mbg', count: 2 }), null);
      });

      it('defers time/membership exceptions, cross-type array ranges and boundary ties to full acquisition', async function () {
        const normal = { _id: 'ordinary', type: 'sgv', sgv: 100, date: end };
        await seed([normal]);
        const cases = [
          { type: 'other', date: [end + 10, request.from - 10] },
          { type: 'sgv', date: end - 2, sgv: 100, created_at: new Date(end + 10).toISOString() },
          { type: 'sgv', date: end - 2, sgv: 100, sysTime: 'invalid' },
          { type: 'sgv', date: end - 2, sgv: 100, mills: end + 3 },
          { type: 'sgv', date: end - 0.5, sgv: 100 },
          { type: 'mbg', date: end - 3, sgv: 100 },
          { type: 'sgv', date: end, sgv: 101 }
        ];
        for (const doc of cases) {
          await seed([{ ...doc, _id: 'exception' }]);
          assert.equal(await page(), null, JSON.stringify(doc));
          await admin.query('DELETE FROM ' + labs.entries.qualified + ' WHERE tenant_id=$1 AND "_id"=$2', [tenant, 'exception']);
        }
        await seed([{ _id: 'too-old', type: 'other', date: [request.from - 100] }]);
        assert.deepEqual(await page(), [normal]);
      });
    });

    describe('upload target lookups read an index range, not the tenant history', function () {
      const STEP = 300000;
      const T0 = Date.UTC(2026, 0, 1);
      const iso = k => new Date(T0 + k * STEP).toISOString();

      before(async function () {
        const history = {
          entries: k => ({ type: 'sgv', sgv: 100 + k % 50, date: T0 + k * STEP, dateString: iso(k), sysTime: iso(k) }),
          treatments: k => ({ eventType: 'Temp Basal', created_at: iso(k), duration: 30, absolute: 1 }),
          devicestatus: k => ({ device: 'synthetic-loop', created_at: iso(k) }),
          activity: k => ({ created_at: iso(k), steps: k }),
          profile: k => ({ defaultProfile: 'Default', startDate: iso(k), created_at: iso(k) }),
          food: k => ({ type: 'food', name: 'synthetic-' + k, carbs: 10 })
        };
        for (const [table, make] of Object.entries(history)) {
          const lab = labs[table];
          // Half the history carries a string identifier (as API v3 writes
          // it), half none (as API v1 writes it). An identifier bound that
          // admitted every row whose identifier column is NULL would read the
          // v1 half; the array arm reads none of it.
          const rows = Array.from({ length: HISTORY }, (_, k) => encodeDocument({ _id: `${table}-h${k}`,
            ...(k % 2 ? { identifier: `${table}-id-${k}` } : {}), ...make(k) }));
          await grants.withTenant(admin, A, () => admin.query(`INSERT INTO "${lab.namespace}"."${table}" (tenant_id, id_kind, doc)
            SELECT $1, kind, doc FROM unnest($2::text[], $3::jsonb[]) AS row(kind, doc)`,
          [A, rows.map(r => r.id_kind), rows.map(r => JSON.stringify(r.doc))]));
          await admin.query(`ANALYZE "${lab.namespace}"."${table}"`);
        }
      });

      // The statements an adapter call sends, through the tenant-bound connection.
      async function sent (fn) {
        const seen = [];
        const spy = { query: (text, values) => { seen.push({ text, values }); return store.query(text, values); } };
        await store.withTenant(A, () => fn(spy));
        return seen;
      }

      // Plan nodes over `table`, from EXPLAIN (ANALYZE) as the application role.
      async function scans (table, statement) {
        await admin.query('BEGIN');
        try {
          await admin.query(`SET LOCAL ROLE "${role}"`);
          await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
          const { rows } = await admin.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + statement.text, statement.values);
          const nodes = [];
          (function walk (node) {
            if (node['Relation Name'] === table) nodes.push(node);
            (node.Plans || []).forEach(walk);
          })(rows[0]['QUERY PLAN'][0].Plan);
          return nodes;
        } finally {
          await admin.query('ROLLBACK');
        }
      }

      function bounded (label, nodes) {
        assert.ok(nodes.length, label + ': the statement reads the table');
        for (const node of nodes) {
          const read = node['Actual Rows'] * node['Actual Loops'] + (node['Rows Removed by Filter'] || 0) +
            (node['Rows Removed by Index Recheck'] || 0);
          assert.notEqual(node['Node Type'], 'Seq Scan', `${label}: SEQ_SCAN over ${HISTORY} tenant rows`);
          assert.ok(read <= 20, `${label}: READS_TENANT_HISTORY ${node['Node Type']} read ${read} rows`);
        }
      }

      it('keeps a large v1 date page with an exact identifier on the selective lookup', async function () {
        const statements = await sent(async c => {
          const reader = entriesRead({ connection: { ...store, ...c }, table: labs.entries.qualified, latestTimeDomain: 'entries' });
          const docs = await reader.findFiltered(and(cmp('gte', 'date', T0), cmp('eq', 'identifier', 'entries-id-7'),
            cmp('ne', 'isValid', false)), { sort: { date: -1 }, limit: 2000, options: { normalize: false } });
          assert.deepEqual(docs.map(d => d._id), ['entries-h7']);
        });
        assert.equal(statements.length, 1);
        bounded('selective date-page lookup', await scans('entries', statements[0]));
        assert.doesNotMatch(statements[0].text, /raw_page/, 'exact identifier should lead without a speculative date page');
      });

      const cases = [
        ['entries v1 sysTime + type target (locked update)', 'entries', (lab, c) => entriesWrite({ connection: c, table: lab.qualified })
          .updateMany(and(cmp('eq', 'sysTime', iso(1234)), cmp('eq', 'type', 'sgv')), { set: { sgv: 1 } })],
        ['entries batch $or of sysTime + type', 'entries', (lab, c) => entriesRead({ connection: c, table: lab.qualified })
          .findFiltered(or(...[10, 20, 30].map(k => and(cmp('eq', 'sysTime', iso(k)), cmp('eq', 'type', 'sgv')))), raw)],
        ['entries identifier $in', 'entries', (lab, c) => entriesRead({ connection: c, table: lab.qualified })
          .findFiltered(cmp('in', 'identifier', ['id-1', 'id-2']), raw)],
        ['entries v3 fallback date + type', 'entries', (lab, c) => entriesRead({ connection: c, table: lab.qualified })
          .findFiltered(and(cmp('eq', 'date', T0 + (HISTORY - 3) * STEP), cmp('eq', 'type', 'sgv')), raw)],
        ['treatments created_at + eventType', 'treatments', (lab, c) => entriesRead({ connection: c, table: lab.qualified })
          .findFiltered(and(cmp('eq', 'created_at', iso(HISTORY - 3)), cmp('eq', 'eventType', 'Temp Basal')), raw)],
        ['devicestatus created_at', 'devicestatus', (lab, c) => entriesRead({ connection: c, table: lab.qualified })
          .findFiltered(cmp('eq', 'created_at', iso(HISTORY - 3)), raw)],
        // The v1 list reads: the newest rows of a created_at (or date)
        // window, valid records only (GET /api/v1/devicestatus?count=1 reads
        // the default window, from four days ago). The upper end keeps the
        // answer matrix's array values, which no sort admits, out of the read.
        ...[['devicestatus', 'created_at', iso], ['treatments', 'created_at', iso],
          ['entries', 'date', k => T0 + k * STEP]].map(([table, field, at]) =>
          [`${table} v1 window read (${field} $gte, newest first)`, table, (lab, c) => entriesRead({ connection: c, table: lab.qualified })
            .findFiltered(and(cmp('gte', field, at(HISTORY - 10)), cmp('lte', field, at(HISTORY)), cmp('ne', 'isValid', false)),
              { sort: { [field]: -1 }, limit: 1, options: { normalize: false } })]),
        // The primary key (tenant_id, id_kind, "_id") is in the database's
        // collation; an equality compared under "C" cannot use it.
        ['treatments _id, both kinds (v1 PUT/DELETE, v3 typed identity)', 'treatments', (lab, c) => entriesRead({ connection: c, table: lab.qualified })
          .findFiltered(cmp('in', '_id', ['treatments-h7', new ObjectId('65a1b2c3d4e5f60718293a4b')]), raw)],
        ['devicestatus locked delete by _id', 'devicestatus', (lab, c) => entriesWrite({ connection: c, table: lab.qualified })
          .deleteMany(cmp('eq', '_id', 'devicestatus-h9'))],
        // API v3 by identifier (create dedup, read, update, delete): the stored
        // identifier or any _id form, over history half without identifiers.
        ...['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'].flatMap(table => [
          [`${table} v3 identifier read and create dedup (findOne)`, table, (lab, c) => entriesRead({ connection: c, table: lab.qualified })
            .findOne(`${table}-id-1235`)],
          [`${table} v3 identifier resolve (every form)`, table, (lab, c) => entriesWrite({ connection: c, table: lab.qualified })
            .resolveEveryForm(`${table}-id-1237`, 10)],
          [`${table} v3 identifier update (locked, every form)`, table, (lab, c) => entriesWrite({ connection: c, table: lab.qualified })
            .updateEveryForm(`${table}-id-1239`, { note: 'synthetic' })],
          [`${table} v3 identifier delete (locked, every form)`, table, (lab, c) => entriesWrite({ connection: c, table: lab.qualified })
            .deleteEveryForm(`${table}-id-1241`)],
          [`${table} identifier $in (v1 upload carrying identifiers)`, table, (lab, c) => entriesRead({ connection: c, table: lab.qualified })
            .findFiltered(cmp('in', 'identifier', [`${table}-id-1243`, `${table}-id-1245`]), raw)]
        ])
      ];
      // A v1 treatments batch's on-deleted and server-date reads: one $or of a
      // fallback key per document (no client identity, so each carries the
      // empty-identity and amount clauses). R3 measured a 288-document read at
      // 577 bitmap index scans and 4,034 correlated SubPlans, 85-125 ms to
      // plan and 35-65 ms to run on an empty tenant. Here: one bound for the
      // $or, no subquery, and only the batch's range read.
      it('treatments v1 batch $or of 64 fallback keys plans one bound and no subquery', async function () {
        const fallbackKey = require('../lib/server/treatment-fallback-key');
        const { fromMongo } = require('../lib/storage/filter');
        const keys = Array.from({ length: 64 }, (_, j) => {
          const doc = { eventType: 'Temp Basal', created_at: iso(HISTORY - 64 + j), absolute: 1 };
          return fallbackKey.fallbackQuery(doc, doc.created_at, { withAmounts: true });
        });
        const ast = fromMongo({ $and: [{ $or: keys }, { isValid: false }] });
        const lab = labs.treatments;
        const statements = (await sent(c => entriesRead({ connection: c, table: lab.qualified }).findFiltered(ast, raw)))
          .filter(s => /^(WITH|SELECT)/.test(s.text));
        assert.equal(statements.length, 1);
        await admin.query('BEGIN');
        let plan;
        try {
          await admin.query(`SET LOCAL ROLE "${role}"`);
          await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
          plan = (await admin.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + statements[0].text, statements[0].values)).rows[0]['QUERY PLAN'][0].Plan;
        } finally {
          await admin.query('ROLLBACK');
        }
        const nodes = [];
        (function walk (node) { nodes.push(node); (node.Plans || []).forEach(walk); })(plan);
        const subplans = nodes.filter(n => n['Parent Relationship'] === 'SubPlan' || n['Subplan Name']);
        const indexed = nodes.filter(n => /Index/.test(n['Node Type']));
        assert.equal(subplans.length, 0, `SUBPLAN_PER_FILTER: ${subplans.length} subqueries`);
        assert.ok(indexed.length >= 1 && indexed.length <= 2, `INDEX_ARM_PER_FILTER: ${indexed.length} index scans`);
        assert.ok(!nodes.some(n => n['Node Type'] === 'Seq Scan'), 'SEQ_SCAN');
        const read = nodes.filter(n => n['Relation Name'] === 'treatments')
          .reduce((a, n) => a + n['Actual Rows'] * n['Actual Loops'] + (n['Rows Removed by Filter'] || 0) + (n['Rows Removed by Index Recheck'] || 0), 0);
        assert.ok(read <= 64 + 20, `READS_TENANT_HISTORY: read ${read} rows for a 64-document batch`);
      });

      for (const [label, table, call] of cases) {
        it(label, async function () {
          const lab = labs[table];
          // The treatments key-index lookup (lib/storage/treatment-key-index.js
          // existing(), cached) reads the system catalogue, not the table.
          const statements = (await sent(c => call(lab, c))).filter(s => /^(WITH|SELECT)/.test(s.text) &&
            !/\bFROM pg_index\b/.test(s.text));
          assert.ok(statements.length, label + ': a statement was sent');
          for (const statement of statements) bounded(label, await scans(table, statement));
        });
      }
    });
  });
