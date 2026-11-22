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
  }
  for (const f of number) {
    for (const v of [1000, 1000.5, 2000, 5, 6, 999.5, 999, 0, -1]) out.push(cmp('eq', f, v));
    out.push(cmp('eq', f, 'x'), cmp('eq', f, null), cmp('in', f, [6, 1000.5]), cmp('ne', f, 1000), cmp('nin', f, [2000]));
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
          const statements = (await sent(c => call(lab, c))).filter(s => /^(WITH|SELECT)/.test(s.text));
          assert.ok(statements.length, label + ': a statement was sent');
          for (const statement of statements) bounded(label, await scans(table, statement));
        });
      }
    });
  });
