'use strict';
// Simulated backend/commit protocol, not native PostgreSQL or role admission.
// covers: lib/tenant-lifecycle/maintenance-window.js
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const controller = require('../lib/tenant-lifecycle/maintenance-window');
const protocol = require('./fixtures/operation-window-admission-protocol');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64), clone = value => JSON.parse(JSON.stringify(value));
function fixture (options = {}) {
  const m = { authority: true, locked: false, pending: [], trace: [], foreign: { ordinal: 100, doc: 'B-current' },
    durable: { window: { lock_key: '41', phase: 'active', generation: '1', claim_id: null, artifact_digest: null }, audit: null, rows: [] }, ...options };
  const metadata = protocol(options.metadataMutation);
  const client = new EventEmitter();
  const packet = { pid: 100, birth: '2026-11-07 00:00:00.000001+00', role_oid: '71' };
  const target = () => m.working || m.durable;
  client.query = async (query, values = []) => {
    const text = typeof query === 'string' ? query : query.text;
    if (typeof query !== 'string') values = query.values || [];
    m.trace.push(text);
    const ready = metadata(text, values); if (ready) return ready;
    if (text === 'BEGIN') { assert.equal(m.working, undefined); m.working = clone(m.durable); return { command: 'BEGIN', rows: [] }; }
    if (text === 'ROLLBACK') { delete m.working; return { command: 'ROLLBACK', rows: [] }; }
    if (text === 'COMMIT') {
      let stage = 'DRAIN';
      if (!m.durable.audit && m.working.audit) stage = 'SUSPENSION';
      else if (m.working.audit?.state === 'restored' && m.durable.audit?.state === 'suspended') stage = 'DATA';
      else if (m.working.audit?.state === 'activated') stage = 'ACTIVATION';
      m.durable = clone(m.working); delete m.working; m.trace.push('committed:' + stage);
      if (m.loseCommit === stage) throw Object.assign(new Error('response lost after commit'), { code: 'ECONNRESET' });
      return { command: 'COMMIT', rows: [] };
    }
    if (text.includes("set_config('app.current_tenant_id'")) { assert.equal(values[0], A); return { rows: [] }; }
    if (text.includes('restore-current-authority')) return { rows: [{ active: m.authority }] };
    if (text.includes('restore-backend')) return { rows: [{ ...packet, ...(m.backendChanged ? { birth: 'replacement-birth' } : {}) }] };
    if (text.includes('restore-window-claim') || text.includes('restore-window-current')) return { rows: [clone(target().window)] };
    if (text.startsWith('UPDATE ') && text.includes('tenant_lifecycle_windows')) {
      const w = target().window;
      if (text.includes("SET phase='suspended'")) { w.phase = 'suspended'; w.generation = values[1]; w.claim_id = values[2]; w.artifact_digest = values[3]; }
      else { assert.equal(m.invalidated, true, 'activation must await real cohort invalidation'); w.phase = 'active'; w.claim_id = null; w.artifact_digest = null; }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO ') && text.includes('tenant_lifecycle_restore_audit')) {
      target().audit = { generation: values[2], artifact_digest: values[3], role_oid: packet.role_oid, owner_pid: packet.pid, owner_birth: packet.birth, state: 'suspended' };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('restore-audit-current')) return { rows: [clone(target().audit)] };
    if (text.startsWith('UPDATE ') && text.includes('tenant_lifecycle_restore_audit')) { target().audit.state = text.includes("SET state='restored'") ? 'restored' : 'activated'; return { rows: [], rowCount: 1 }; }
    if (text.includes('restore-pending')) { if (m.finishOnPoll) m.pending = []; return { rows: clone(m.pending) }; }
    if (text.includes('restore-exclusive-acquire')) { if (!m.busy) m.locked = true; return { rows: [{ held: m.locked }] }; }
    if (text.includes('restore-exclusive-held')) return { rows: [{ held: m.locked }] };
    if (text.includes('pg_advisory_unlock')) { const held = m.locked; m.locked = false; return { rows: [{ released: held }] }; }
    if (text.startsWith('INSERT INTO synthetic_data')) { target().rows.push(values[0]); return { rowCount: 1, rows: [] }; }
    throw new Error('Unexpected simulated query: ' + text);
  };
  client.release = error => { m.released = true; m.releaseError = error; };
  const cohort = {};
  const original = Module._load;
  let api;
  try {
    Module._load = function (request, ...rest) {
      if (request === '../server/serve/operation-cohort') return {
        assertComplete (given, tenant, options) { assert.equal(options.client, client); if (given !== cohort || tenant !== A || m.incomplete) throw Object.assign(new Error('incomplete'), { code: 'COHORT_INCOMPLETE' }); },
        async invalidate (given, tenant) { assert.equal(given, cohort); assert.equal(tenant, A); assert.equal(m.durable.window.phase, 'suspended'); assert.equal(m.durable.audit.state, 'restored'); await new Promise(resolve=>setImmediate(resolve)); m.invalidated = true; if (m.invalidateFails) throw Object.assign(new Error('invalidate failed'), { code: 'INVALIDATE_FAILED' }); }
      };
      return original.call(this, request, ...rest);
    };
    api = controller.create({ namespace: 'synthetic_window', locks: [{ tenant: A, key: '41' }, { tenant: B, key: '42' }],
      pool: { connect: async () => { m.connected = true; return client; } }, cohort, drainTimeoutMs: 1 });
  } finally { Module._load = original; }
  return { m, api };
}
const code = value => error => error.code === value;

describe('private tenant restore controller (simulated backend protocol)', function () {
  let prior;
  before(function () { prior = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(function () { scope.setTenancyMode(prior); });
  it('commits suspension before callback, joins its transaction, invalidates before activation and closes stale claims', async function () {
    const { m, api } = fixture(); let saved;
    const result = await api.withRestore(A, { artifactDigest: DIGEST }, async ({ connection, maintenanceClaim }) => {
      saved = { connection, maintenanceClaim };
      assert.equal(m.durable.window.phase, 'suspended');
      await controller.assertHeld(maintenanceClaim, { connection, tenant: A, artifactDigest: DIGEST });
      await connection.transaction(() => connection.query('INSERT INTO synthetic_data(value) VALUES ($1)', ['restored-A']));
      return 'verified';
    });
    assert.equal(result.state, 'activated'); assert.equal(result.generation, '2'); assert.equal(result.result, 'verified');
    assert.deepEqual(m.durable.rows, ['restored-A']); assert.equal(m.durable.audit.state, 'activated'); assert(m.invalidated && m.released && !m.locked); assert.equal(m.releaseError, true, 'controller backend is destroyed after success');
    assert.deepEqual(m.foreign, { ordinal: 100, doc: 'B-current' });
    await scope.withTenant(A, () => assert.rejects(controller.assertHeld(saved.maintenanceClaim, { connection: saved.connection, tenant: A, artifactDigest: DIGEST }), code('LIFECYCLE_RESTORE_CLAIM_INVALID')));
    await assert.rejects(saved.connection.transaction(async () => {}), code('LIFECYCLE_RESTORE_CONNECTION_CLOSED'));
    await api.close();
  });
  it('refuses an incomplete cohort before metadata or mutation and releases its client', async function () {
    const { m, api } = fixture({ incomplete: true });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => {}), code('COHORT_INCOMPLETE'));
    assert(m.connected && m.released); assert.deepEqual(m.trace, []); await api.close();
  });
  it('refuses current operator authority without suspending A', async function () {
    const { m, api } = fixture({ authority: false });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => {}), code('LIFECYCLE_RESTORE_AUTHORITY_REFUSED'));
    assert.equal(m.durable.window.phase, 'active'); assert.equal(m.durable.audit, null); await api.close();
  });
  it('never clears orphan/pending operations or reopens after the drain deadline', async function () {
    const pending = [{ operation_id: 'uncertain-callback', owner_pid: 999, owner_birth: 'old' }];
    const { m, api } = fixture({ pending });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => assert.fail('body must not run')), code('LIFECYCLE_RESTORE_DRAIN_TIMEOUT'));
    assert.deepEqual(m.pending, pending); assert.equal(m.durable.window.phase, 'suspended'); assert.equal(m.durable.audit.state, 'suspended'); assert(!m.invalidated); await api.close();
  });
  it('does not queue a global lock or enter restore when A shared holders remain', async function () {
    const { m, api } = fixture({ busy: true });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => assert.fail()), code('LIFECYCLE_RESTORE_DRAIN_TIMEOUT'));
    assert(m.trace.some(sql => sql.includes('pg_try_advisory_lock'))); assert(!m.trace.some(sql => /SELECT pg_advisory_lock\(/.test(sql)));
    assert.equal(m.durable.window.phase, 'suspended'); await api.close();
  });
  for (const [label, mutate, expected] of [
    ['revoked operator', m => { m.authority = false; }, 'LIFECYCLE_RESTORE_AUTHORITY_REFUSED'],
    ['lost exclusive lock', m => { m.locked = false; }, 'LIFECYCLE_RESTORE_LOCK_LOST'],
    ['replaced backend', m => { m.backendChanged = true; }, 'LIFECYCLE_RESTORE_BACKEND_CHANGED']
  ]) it('rolls back data after ' + label + ' and keeps A suspended', async function () {
    const { m, api } = fixture();
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async ({ connection }) => {
      await connection.query('INSERT INTO synthetic_data(value) VALUES ($1)', ['must-rollback']); mutate(m);
    }), error => error.code === expected || error.code === 'LIFECYCLE_RESTORE_RELEASE_FAILED' && error.cause?.code === expected);
    assert.deepEqual(m.durable.rows, []); assert.equal(m.durable.window.phase, 'suspended'); assert.equal(m.durable.audit.state, 'suspended'); await api.close();
  });
  it('refuses forged/foreign claims and independent transaction control', async function () {
    const { m, api } = fixture();
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async ({ connection, maintenanceClaim }) => {
      await assert.rejects(controller.assertHeld({}, { connection, tenant: A, artifactDigest: DIGEST }), code('LIFECYCLE_RESTORE_CLAIM_INVALID'));
      await assert.rejects(controller.assertHeld(maintenanceClaim, { connection, tenant: B, artifactDigest: DIGEST }), code('LIFECYCLE_RESTORE_CLAIM_INVALID'));
      await connection.query('/* no hidden commit */ COMMIT');
    }), code('LIFECYCLE_RESTORE_TRANSACTION_CONTROL_REFUSED'));
    assert.equal(m.durable.window.phase, 'suspended'); assert.deepEqual(m.durable.rows, []); await api.close();
  });
  it('does not reactivate after actual cohort invalidation fails', async function () {
    const { m, api } = fixture({ invalidateFails: true });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async ({ connection }) => connection.query('INSERT INTO synthetic_data(value) VALUES ($1)', ['committed-A'])), code('INVALIDATE_FAILED'));
    assert.deepEqual(m.durable.rows, ['committed-A']); assert.equal(m.durable.audit.state, 'restored'); assert.equal(m.durable.window.phase, 'suspended'); await api.close();
  });
  for (const stage of ['SUSPENSION','DATA','ACTIVATION']) it('retains actual durable outcomes after lost ' + stage + ' COMMIT response', async function () {
    const { m, api } = fixture({ loseCommit: stage });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async ({ connection }) => connection.query('INSERT INTO synthetic_data(value) VALUES ($1)', ['committed-A'])), code('LIFECYCLE_RESTORE_' + stage + '_OUTCOME_UNCERTAIN'));
    assert.equal(m.durable.window.phase, stage === 'ACTIVATION' ? 'active' : 'suspended');
    assert.equal(m.durable.audit.state, stage === 'SUSPENSION' ? 'suspended' : stage === 'DATA' ? 'restored' : 'activated');
    assert.deepEqual(m.durable.rows, stage === 'SUSPENSION' ? [] : ['committed-A']);
    assert.equal(!!m.invalidated, stage === 'ACTIVATION'); await api.close();
  });
  it('refuses reissuing an existing suspended claim rather than treating retry as recovery', async function () {
    const { m, api } = fixture({ durable: { window: { lock_key: '41', phase: 'suspended', generation: '2', claim_id: 'existing', artifact_digest: DIGEST }, audit: null, rows: [] } });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => assert.fail()), code('LIFECYCLE_RESTORE_ALREADY_SUSPENDED'));
    assert.equal(m.durable.window.claim_id, 'existing'); await api.close();
  });
});
