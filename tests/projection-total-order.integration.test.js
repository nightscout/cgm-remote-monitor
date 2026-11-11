'use strict';

// Decision view-reads-total-order: the evaluator's view reads come back in one
// total order on both paths, the keys, then the per-tenant insertion ordinal
// (nulls last), then the typed identity. This compares the SQL path
// (postgres-projection-read on actual PostgreSQL, ORDER BY <keys>, ordinal,
// id_kind, _id) with the in-process path (projection-memory-read) over random
// projections built to tie: a sort field from a handful of values of every
// JSON type (missing included), typed twins (an ObjectId _id and its
// same-spelling string), ordinals in random order with some null, random
// filters, one- and two-key sorts either way, _id included, LIMIT and OFFSET.
// Equal means the same documents (typed _id, content, key order) in the same
// order, or the same refusal.
const assert = require('node:assert/strict');
const util = require('node:util');
const { ObjectId } = require('mongodb');
const { Pool } = require('pg');
const scope = require('../lib/storage/tenant-scope');
const projectionRead = require('../lib/storage/postgres-projection-read');
const environment = require('../lib/server/tenant-app/environment');
const { fromMongo } = require('../lib/storage/filter');
const { optInSuite } = require('./support/opt-in');

const TENANT = '7e7e7e7e-0000-4000-8000-00000000eca4';
const VALUES = [undefined, null, 0, 1, 1, 2, -1, 1.5, 'a', 'a', 'b', 'B', 'é', '😀', 'z', true, false, '2026-01-01T00:00:00.000Z'];

optInSuite(process.env.NS_TENANT_PROJECTION_EVALUATOR_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_PROJECTION_EVALUATOR_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator view reads: one total order on the SQL and in-process paths', function () {
    this.timeout(180000);
    let pool, previous;
    before(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); pool = new Pool({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, max: 2 }); });
    after(async () => { scope.setTenancyMode(previous); await pool.end(); });

    it('EV_COST_A_TOTAL_ORDER returns the same rows in the same order, ties and typed twins included', async function () {
      let seed = 7;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const pick = list => list[Math.floor(rand() * list.length)];
      const env = environment({ settings: { enable: ['bgnow'] } });
      const connection = { query: (text, values) => pool.query(text, values) };
      const totals = { cases: 0, equal: 0, refusedBoth: 0, withTies: 0 };
      await scope.withTenant(TENANT, async () => {
        for (let c = 0; c < 600; c++) {
          const n = Math.floor(rand() * rand() * 160);
          const docs = [], ordinals = [], seen = new Set();
          for (let i = 0; i < n; i++) {
            const hex = (1000 + Math.floor(rand() * n)).toString(16).padStart(24, '0');
            const doc = { _id: rand() < 0.3 ? new ObjectId(hex) : (rand() < 0.5 ? hex : 'd' + i), i, t: pick(['sgv', 'mbg', 'sgv']) };
            const k = pick(VALUES); if (k !== undefined) doc.k = k;
            const j = pick(VALUES); if (j !== undefined) doc.j = j;
            if (rand() < 0.004) doc.k = [1, 2];
            const key = (typeof doc._id === 'string' ? 's' : 'o') + String(doc._id);
            if (seen.has(key)) continue;
            seen.add(key); docs.push(doc);
            ordinals.push(rand() < 0.15 ? null : 1 + Math.floor(rand() * 1e6));
          }
          // ordinals are unique per tenant where present
          const used = new Set();
          for (let i = 0; i < ordinals.length; i++) { while (ordinals[i] !== null && used.has(ordinals[i])) ordinals[i]++; if (ordinals[i] !== null) used.add(ordinals[i]); }
          const bounds = { maxRows: 10000, maxBytes: 1e8 };
          const prepared = projectionRead.prepare({ documents: docs, ordinals, ...bounds, memory: true });
          const sql = projectionRead({ tenant: TENANT, connection, logical: 'entries', prepared, ...bounds, env, totalOrder: true });
          const memory = projectionRead({ tenant: TENANT, connection, logical: 'entries', prepared, ...bounds, env, memory: true, totalOrder: true });
          const sort = pick([{ k: 1 }, { k: -1 }, { k: 1, j: -1 }, { j: -1, k: 1 }, { k: -1, _id: 1 }, { _id: -1 }, { t: 1 }, { t: -1, k: -1 }]);
          const filter = pick([{}, { t: 'sgv' }, { k: { $gte: 1 } }, { k: { $in: ['a', 1, null] } }, { j: { $ne: true } }, { k: { $exists: true } }]);
          const opts = { v1: true, sort, options: { normalize: false } };
          const limit = pick([undefined, undefined, 1, 2, 3, 12, 40]);
          if (limit) opts.limit = limit;
          if (limit && rand() < 0.2) opts.skip = Math.floor(rand() * 5);
          let a, b, ea, eb;
          try { a = await sql.findFiltered(fromMongo(filter), opts); } catch (e) { ea = e; }
          try { b = await memory.findFiltered(fromMongo(filter), opts); } catch (e) { eb = e; }
          totals.cases++;
          if (ea || eb) {
            assert.equal(eb && eb.message, ea && ea.message, 'case ' + c + ': the same refusal');
            totals.refusedBoth++;
            continue;
          }
          const typed = list => list.map(d => [typeof d._id === 'string' ? 's' : 'o', JSON.stringify(d)]);
          const keys = a.map(d => JSON.stringify(Object.keys(sort).map(f => f === '_id' ? [typeof d._id, String(d._id)] : d[f])));
          if (new Set(keys).size < keys.length) totals.withTies++;
          assert.ok(util.isDeepStrictEqual(typed(a), typed(b)), 'case ' + c + ' ' + JSON.stringify({ sort, filter, limit, skip: opts.skip }) +
            ': sql ' + a.map(d => d.i).join(',') + ' memory ' + b.map(d => d.i).join(','));
          totals.equal++;
        }
      });
      process.stdout.write('      EV_COST_A_TOTAL_ORDER ' + JSON.stringify(totals) + '\n');
      assert.ok(totals.withTies > 100, 'ties were exercised (' + totals.withTies + ')');
    });
  });
