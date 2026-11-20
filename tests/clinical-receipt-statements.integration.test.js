'use strict';
// Statements per stream receipt (decision ack-path-tenant-independent: the ACK
// waits only on this transaction). Disposable PostgreSQL, synthetic tenants.
// One tenant: BEGIN, recovery lock, fence (lock+binding, generation SELECT),
// input rows FOR UPDATE, work rows FOR UPDATE, one write, final fence (2), COMMIT.
// Base bee2589b6 issued 13 and 25 statements for these two receipts.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');
const { optInSuite } = require('./support/opt-in');
const state = require('../lib/storage/clinical-stream-state');
const sql = require('../lib/storage/clinical-stream-sql');
const receiverModule = require('../lib/pgstream/receiver');
const authority = require('../lib/pgstream/receipt-authority');
const rules = require('../lib/tenant-registry/rules');
const native = require('./lib/clinical-stream-native');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const T = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const generation = 'e'.repeat(32), limits = { maxRows: 1000, maxBytes: 1048576 };
const EXPECTED = { one: 10, three: 18 };

optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI')('stream receipt statement count', function () {
  this.timeout(30000);
  let admin, pool, cohort, lifecycle, receive, statements = [], position = 0x100;
  const cache = new Map();
  const cacheApi = { get: t => cache.get(t), delete: t => cache.delete(t), set: (t, input) => { cache.set(t, input); } };
  before(async function () {
    admin = new Client({ connectionString: uri }); await admin.connect();
    const real = new Pool({ connectionString: uri, max: 2 });
    pool = { real, async connect () { const c = await real.connect(); if (!c.counted) { const q = c.query.bind(c); c.query = (text, values) => { statements.push(String(text).slice(0, 48)); return q(text, values); }; c.counted = true; } return c; } };
    cohort = await require('./fixtures/clinical-native-cohort').create({ admin, pool: real, prefix: 'synthetic_stmt_' + randomBytes(4).toString('hex'), tenants: T, ...limits });
    lifecycle = cohort.prefix + '_control';
    await admin.query('CREATE SCHEMA ' + lifecycle + ';CREATE TABLE ' + lifecycle + '.tenant_lifecycle_windows(tenant_id uuid PRIMARY KEY,lock_key bigint UNIQUE,generation bigint,phase text)');
    for (const t of T) await admin.query('INSERT INTO ' + lifecycle + ".tenant_lifecycle_windows VALUES($1,$2,1,'active')", [t, rules.lockKey(t)]);
    for (const t of T) {
      const ready = state.bootstrap(null, { checkpoint: 1, signature: { stamp: 1, deleted: 0 }, stream: { ...native.boundary, generation: generation + ':1' }, rows: [] }, limits);
      await admin.query('UPDATE ' + cohort.table + ' SET checkpoint=1,projection=$3::jsonb WHERE tenant_id=$1 AND consumer=$2', [t, cohort.consumer, JSON.stringify([state.compact(ready), require('../lib/storage/storage-event-journal').empty()])]);
      cache.set(t, ready);
    }
    const options = { ...cohort.sqlOptions(native.source, { assertFence: authority.create({ namespace: lifecycle, generation, available: () => true }), lockKey: t => String(BigInt(rules.lockKey(t)) + 1n) }), pool, cache: cacheApi };
    const routes = cohort.routes.map(r => ({ ...r, kind: 'clinical' }));
    receive = receiverModule.create({ routes, store: {}, onInput: () => {}, onSchema: async () => {},
      clinical: { maxTransactionRows: options.maxTransactionRows, maxTransactionBytes: options.maxTransactionBytes, acceptTransaction: (envelope, o) => sql.acceptTransaction({ ...options, ...o, routes, envelope }) } });
  });
  after(async function () {
    await cohort?.close(); if (lifecycle) await admin.query('DROP SCHEMA IF EXISTS ' + lifecycle + ' CASCADE');
    await pool?.real.end(); await admin?.end();
  });
  async function receipt (tenants, id) {
    const at = '0/' + (position += 16).toString(16).toUpperCase();
    const rows = tenants.map(t => ({ ...native.row(id + t.slice(0, 2), 110, 'I', t), schema: cohort.domains.entries.split('.')[0], lsn: at }));
    statements = [];
    const result = await receive(receiverModule.parse(JSON.stringify(native.envelope(rows, at))));
    return { result, statements: statements.slice() };
  }

  it('acknowledges a one-tenant and a three-tenant receipt with the folded statement counts and their durable effects', async function () {
    const one = await receipt([T[0]], 'a');
    assert.deepEqual(one.result.tenants, [T[0]]);
    assert.equal(one.statements.length, EXPECTED.one, 'ONE_TENANT_RECEIPT_STATEMENTS:\n' + one.statements.join('\n'));
    const three = await receipt(T, 'b');
    assert.equal(three.statements.length, EXPECTED.three, 'THREE_TENANT_RECEIPT_STATEMENTS:\n' + three.statements.join('\n'));
    console.log('      statements per receipt: one-tenant %d, three-tenant %d', one.statements.length, three.statements.length);
    // No storage-event journal (S2): a clinical receipt owes no raw delivery, so
    // the delivery revision moves only for control work, which these rows lack.
    for (const [t, floor, revision] of [[T[0], '3', '0'], [T[1], '2', '0'], [T[2], '2', '0']]) {
      const input = await cohort.read(t), output = await cohort.output(t);
      assert.equal(input.checkpoint, floor); assert.equal(input.projection[0].floor, Number(floor));
      assert.equal(output.work_observed[5], floor, 'WORK_STATE_WRITTEN_WITH_INPUT'); assert.equal(output.delivery_revision, revision, 'RAW_DELIVERY_REVISION');
      assert.notEqual(output.work_pending_at, null); assert.equal(cache.get(t).rows.length, t === T[0] ? 2 : 1);
    }
  });

  it('a duplicate replay still commits only what changed', async function () {
    // Same commit position again: no new input, the work-state observation is unchanged.
    position -= 16; const again = await receipt(T, 'b');
    assert.equal(again.statements.length, EXPECTED.three - 1, 'DUPLICATE_SKIPS_THE_WRITE:\n' + again.statements.join('\n'));
    assert.equal((await cohort.output(T[1])).delivery_revision, '0');
  });
});
