'use strict';
// Writer-driven pending mark under the real work-v2 catalogue, its tenant
// isolation policy and the core pending-writer grants (lib/writer-driven).
// Disposable PostgreSQL, synthetic tenants only.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { optInSuite } = require('./support/opt-in');
const writerDriven = require('../lib/writer-driven');
const work = require('../lib/pgstream/work-state');
const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
const [A, B, C] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const CONSUMER = 'evaluator-synthetic-completed', DIGEST = 'a'.repeat(64);

optInSuite(uri, 'NS_TEST_POSTGRES_ADMIN_URI')('writer-driven pending mark', function () {
  this.timeout(30000);
  const suffix = randomBytes(4).toString('hex'), namespace = 'synthetic_work_' + suffix, role = 'synthetic_writer_' + suffix;
  let admin, writer, selected;
  const row = async tenant => (await admin.query('SELECT work_observed,work_pending_at::text AS pending FROM "' + namespace + '".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2', [tenant, CONSUMER])).rows[0];
  async function bound (tenant, fn) {
    await writer.query('BEGIN');
    try {
      if (tenant) await writer.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const value = await fn((text, values) => writer.query(text, values));
      await writer.query('COMMIT'); return value;
    } catch (error) { await writer.query('ROLLBACK'); throw error; }
  }
  before(async function () {
    admin = new Client({ connectionString: uri }); await admin.connect();
    await admin.query('CREATE SCHEMA "' + namespace + '"');
    await require('../lib/migrations/postgres').run('up', { direct: true, connectionString: uri, namespace,
      catalogue: require('../migrations/candidates/postgres-evaluator-work-v2.json') });
    const password = randomBytes(18).toString('hex');
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    for (const sql of writerDriven.grants({ namespace, roles: [role] })) await admin.query(sql);
    selected = writerDriven.binding({ namespace, consumer: CONSUMER });
    const typed = writerDriven.provisionedRow(Date.now());
    for (const tenant of [A, C]) {
      await admin.query('INSERT INTO "' + namespace + '".tenant_consumer_checkpoint (tenant_id,consumer,contract_digest,checkpoint,' + typed.columns +
        ') VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9::jsonb)', [tenant, CONSUMER, DIGEST, ...typed.values]);
    }
    await admin.query('INSERT INTO "' + namespace + '".tenant_consumer_checkpoint (tenant_id,consumer,contract_digest,checkpoint,projection) VALUES ($1,$2,$3,0,NULL)', [B, CONSUMER, DIGEST]);
    const url = new URL(uri); url.username = role; url.password = password;
    writer = new Client({ connectionString: url.toString() }); await writer.connect();
  });
  after(async function () {
    await writer?.end().catch(() => {});
    await admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE').catch(() => {});
    await admin.query('DROP ROLE IF EXISTS ' + role).catch(() => {});
    await admin.end();
  });

  it('provisioning creates a typed, pending row that the work-v2 constraints accept', async function () {
    const current = work.state({ work_version: 2, work_observed: (await row(A)).work_observed, work_completed: [null, null, null, null, null, null], work_observed_at: [null, null, null, null, null, null] });
    assert.deepEqual(current.observed, { bootstrap: '1' });
    assert.notEqual((await row(A)).pending, null, 'PROVISIONED_PENDING');
  });

  it('marks its own tenant in the writer transaction: the clock slot reaches the floor, pending stays at the first mark', async function () {
    const before = await row(A);
    await bound(A, query => writerDriven.mark(query, selected, A, { source: 'clock', floor: 1700000000000 }));
    await bound(A, query => writerDriven.mark(query, selected, A, { source: 'settings' }));
    const after = await row(A);
    assert.equal(String(after.work_observed[0]), '1700000000000');
    assert.equal(String(after.work_observed[1]), '1');
    assert.equal(after.pending, before.pending, 'PENDING_KEEPS_THE_OLDEST_MARK');
  });

  it('refuses a mark for another tenant, an unbound session and an untyped row; it cannot write any other column', async function () {
    await assert.rejects(bound(A, query => writerDriven.mark(query, selected, C)), /EVALUATOR_PENDING_MARK_NOT_PROVISIONED/, 'RLS_OTHER_TENANT');
    await assert.rejects(bound(null, query => writerDriven.mark(query, selected, C)), /EVALUATOR_PENDING_MARK_NOT_PROVISIONED/, 'RLS_UNBOUND');
    await assert.rejects(bound(B, query => writerDriven.mark(query, selected, B)), /EVALUATOR_PENDING_MARK_NOT_PROVISIONED/, 'UNTYPED_ROW');
    await assert.rejects(bound(A, query => query('UPDATE "' + namespace + '".tenant_consumer_checkpoint SET output_revision=output_revision+1 WHERE tenant_id=$1', [A])), error => error.code === '42501');
    await assert.rejects(bound(A, query => query('UPDATE "' + namespace + '".tenant_consumer_checkpoint SET work_completed=work_observed WHERE tenant_id=$1', [A])), error => error.code === '42501');
    assert.equal(String((await row(C)).work_observed[0]), 'null');
  });

  it('RED control: without the pending-writer grants the mark is refused (42501)', async function () {
    await admin.query('REVOKE UPDATE(work_observed,work_observed_at,work_pending_at) ON "' + namespace + '".tenant_consumer_checkpoint FROM ' + role);
    try {
      await assert.rejects(bound(A, query => writerDriven.mark(query, selected, A)), error => error.code === '42501');
    } finally {
      for (const sql of writerDriven.grants({ namespace, roles: [role] })) await admin.query(sql);
    }
    await bound(A, query => writerDriven.mark(query, selected, A));
  });
});
