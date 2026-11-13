'use strict';
// Simulated backend/commit protocol, not native PostgreSQL, row security or role
// admission; tests/tenant-restore-resume.integration.test.js is the native lab.
// covers: lib/tenant-lifecycle/restore-resume.js
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const protocol = require('./fixtures/operation-window-admission-protocol');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const CLAIM = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'a'.repeat(64), clone = value => JSON.parse(JSON.stringify(value));
const FILE = require.resolve('../lib/tenant-lifecycle/restore-resume');
const code = value => error => error.code === value;
const suspended = state => ({ window: { lock_key: '41', phase: 'suspended', generation: '2', claim_id: CLAIM, artifact_digest: DIGEST },
  audit: { generation: '2', artifact_digest: DIGEST, state, owner_pid: 100, owner_birth: 'operator-birth' }, resumes: [], clearance: [] });
const record = (id, gone) => ({ operation_id: id, generation: '1', owner_pid: 7, owner_birth: 'role-birth', gone });

// `mutate` rewrites the module source for a control; the cohort module is the
// protocol model used by tests/tenant-maintenance-window.test.js.
function fixture (options = {}, mutate) {
  const m = { authority: true, ownerPresent: false, auditVisible: true, pending: [], running: [], trace: [], durable: suspended('suspended'), ...options };
  const metadata = protocol();
  const client = new EventEmitter();
  const target = () => m.working || m.durable;
  client.query = async (query, values = []) => {
    const text = typeof query === 'string' ? query : query.text;
    if (typeof query !== 'string') values = query.values || [];
    m.trace.push(text);
    const ready = metadata(text, values); if (ready) return ready;
    if (text === 'BEGIN') { assert.equal(m.working, undefined); m.working = clone(m.durable); return { command: 'BEGIN', rows: [] }; }
    if (text === 'ROLLBACK') { delete m.working; return { command: 'ROLLBACK', rows: [] }; }
    if (text === 'COMMIT') {
      m.durable = clone(m.working); delete m.working; m.trace.push('committed');
      if (m.loseCommit) throw Object.assign(new Error('response lost after commit'), { code: 'ECONNRESET' });
      return { command: 'COMMIT', rows: [] };
    }
    if (text.includes("set_config('app.current_tenant_id'")) { assert.equal(values[0], A); return { rows: [] }; }
    if (text.includes('resume-refresh')) return { rows: [] };
    if (text.includes('resume-current-authority')) return { rows: [{ active: m.authority }] };
    if (text.includes('resume-pending')) return { rows: clone(m.pending.filter(row => !target().clearance.some(done => done.operation_id === row.operation_id))) };
    if (text.includes('resume-window')) {
      if (/FOR NO KEY UPDATE NOWAIT$/.test(text) && m.rowLocked) throw Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
      return { rows: [clone(target().window)] };
    }
    if (text.includes('resume-audit')) {
      return { rows: m.auditVisible && target().audit ? [{ ...clone(target().audit), owner_present: m.ownerPresent, resumed: target().resumes.length > 0 }] : [] };
    }
    if (text.includes('resume-exclusive')) { m.lockAttempts = (m.lockAttempts || 0) + 1; return { rows: [{ held: !m.busy }] }; }
    if (text.startsWith('UPDATE ') && text.includes('tenant_lifecycle_windows')) {
      const w = target().window;
      if (w.phase !== 'suspended' || w.generation !== values[1] || w.claim_id !== values[2] || w.artifact_digest !== values[3]) return { rows: [], rowCount: 0 };
      if (target().audit.state === 'restored') assert.equal(m.invalidated, true, 'RESUME_INVALIDATES_BEFORE_ACTIVATION');
      w.phase = 'active'; w.claim_id = null; w.artifact_digest = null; return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO ') && text.includes('tenant_lifecycle_restore_resume')) {
      // The insert policy of migration 0009: the label must match the audit state.
      const expected = { suspended: 'before-data', restored: 'data-replaced' }[target().audit.state];
      if (values[5] !== expected) throw Object.assign(new Error('new row violates row-level security policy'), { code: '42501' });
      target().resumes.push({ claim_id: values[2], generation: values[3], interrupted: values[5] }); return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO ') && text.includes('tenant_lifecycle_operation_clearance')) {
      target().clearance.push({ operation_id: values[1], generation: values[2], marker_pid: values[3], marker_birth: values[4] }); return { rows: [], rowCount: 1 };
    }
    throw new Error('Unexpected simulated query: ' + text);
  };
  client.release = error => { m.released = true; m.releaseError = error; };
  const cohort = {}, pin = {};
  const original = Module._load;
  let api;
  try {
    Module._load = function (request, ...rest) {
      if (request === '../server/serve/operation-cohort') return {
        async pin (given, tenant, options) { assert.equal(given, cohort); assert.equal(tenant, A); assert.equal(options.client, client); if (m.incomplete) throw Object.assign(new Error('incomplete'), { code: 'COHORT_INCOMPLETE' }); m.pinned = true; m.acknowledged = (m.acknowledged || 0) + 1; return pin; },
        async releasePin (given) { assert.equal(given, pin); assert(m.pinned); m.pinned = false; m.pinReleased = true; },
        assertComplete (given, tenant, options) { assert.equal(options.client, client); assert(m.pinned); if (m.incomplete) throw Object.assign(new Error('incomplete'), { code: 'COHORT_INCOMPLETE' }); m.acknowledged++; },
        async invalidate (given, tenant) { assert.equal(tenant, A); assert(m.pinned); assert.equal(m.durable.window.phase, 'suspended'); await new Promise(resolve => setImmediate(resolve)); if (m.invalidateFails) throw Object.assign(new Error('lost'), { code: 'SOCKET_IPC_UNAVAILABLE' }); m.invalidated = true; },
        async operations (given, tenant) { assert.equal(tenant, A); assert(m.pinned); return { participants: 4, operations: [...m.running] }; }
      };
      return original.call(this, request, ...rest);
    };
    let exported;
    if (mutate) {
      const source = fs.readFileSync(FILE, 'utf8'), changed = mutate(source);
      assert.notEqual(changed, source, 'the control must change the source');
      const loaded = new Module(FILE, module); loaded.filename = FILE; loaded.paths = Module._nodeModulePaths(require('node:path').dirname(FILE));
      loaded._compile(changed, FILE); exported = loaded.exports;
    } else exported = require(FILE);
    api = exported.create({ namespace: 'synthetic_window', locks: [{ tenant: A, key: '41' }, { tenant: B, key: '42' }],
      pool: { connect: async () => { m.connected = true; return client; } }, cohort, lockWaitMs: 0 });
  } finally { Module._load = original; }
  return { m, api };
}
const wrote = m => m.trace.some(sql => sql.startsWith('UPDATE ') || sql.startsWith('INSERT INTO '));

describe('restore resume and operation clearance (simulated backend protocol)', function () {
  it('inspect names the two interrupted cases and writes nothing', async function () {
    for (const [state, interrupted] of [['suspended', 'before-data'], ['restored', 'data-replaced']]) {
      const { m, api } = fixture({ durable: suspended(state), pending: [record('p1', true)] });
      const seen = await api.inspect(A);
      assert.deepEqual(seen, { tenant: A, phase: 'suspended', generation: '2', claimId: CLAIM, artifactDigest: DIGEST, restore: { state, ownerPresent: false }, interrupted,
        operations: { unfinished: 1, ownerGone: 1 }, resumable: state === 'suspended', reasons: state === 'suspended' ? [] : ['LIFECYCLE_RESUME_PENDING_OPERATIONS'] });
      assert(!wrote(m) && !m.trace.includes('COMMIT') && !m.pinned && m.acknowledged === undefined, 'inspect neither writes nor asks the cohort');
      await api.close();
    }
    const open = fixture({ durable: { ...suspended('suspended'), window: { lock_key: '41', phase: 'active', generation: '2', claim_id: null, artifact_digest: null } } });
    assert.deepEqual((await open.api.inspect(A)).reasons, ['LIFECYCLE_RESUME_NOT_SUSPENDED']);
  });

  it('closed before the data was replaced: reopens with fresh acknowledgements and no invalidation, unfinished records allowed', async function () {
    const { m, api } = fixture({ pending: [record('still-running', false)] });
    const result = await api.resume(A, { claimId: CLAIM });
    assert.equal(result.interrupted, 'before-data'); assert.equal(result.state, 'active'); assert.equal(result.generation, '2');
    assert.deepEqual(m.durable.window, { lock_key: '41', phase: 'active', generation: '2', claim_id: null, artifact_digest: null });
    assert.deepEqual(m.durable.resumes, [{ claim_id: CLAIM, generation: '2', interrupted: 'before-data' }]);
    assert.equal(m.durable.audit.state, 'suspended', 'the restore audit row is never rewritten');
    assert(m.acknowledged >= 3, 'RESUME_FRESH_ACKNOWLEDGEMENT pin, census before and census after'); assert(!m.invalidated && !m.lockAttempts);
    assert.match(m.trace.find(sql => sql.includes('resume-window')), /FOR NO KEY UPDATE NOWAIT$/);
    assert(m.released && m.pinReleased); assert.equal(m.releaseError, true, 'operator backend is destroyed after use'); await api.close();
  });

  it('data already replaced: exclusive key, awaited invalidation, then activation in one transaction with its record', async function () {
    const { m, api } = fixture({ durable: suspended('restored') });
    const result = await api.resume(A, { claimId: CLAIM });
    assert.equal(result.interrupted, 'data-replaced'); assert.equal(m.invalidated, true); assert.equal(m.lockAttempts, 1);
    assert.equal(m.durable.window.phase, 'active'); assert.deepEqual(m.durable.resumes, [{ claim_id: CLAIM, generation: '2', interrupted: 'data-replaced' }]);
    const update = m.trace.findIndex(sql => sql.startsWith('UPDATE ')), insert = m.trace.findIndex(sql => sql.startsWith('INSERT INTO ')), commit = m.trace.indexOf('COMMIT');
    assert(update > 0 && update < insert && insert < commit && m.trace.filter(sql => sql === 'COMMIT').length === 1, 'RESUME_ONE_TRANSACTION');
    await api.close();
  });

  for (const [label, options, expected, state = 'suspended'] of [
    ['a restore whose owner backend is still present', { ownerPresent: true }, 'LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT'],
    ['an owner backend whose birth cannot be read', { ownerPresent: null }, 'LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT'],
    ['a participant that does not answer', { incomplete: true }, 'COHORT_INCOMPLETE'],
    ['a revoked operator', { authority: false }, 'LIFECYCLE_RESUME_AUTHORITY_REFUSED'],
    ['a claim made by another database role', { auditVisible: false }, 'LIFECYCLE_RESUME_AUDIT_UNAVAILABLE'],
    ['a competing restore or resume holding the window row', { rowLocked: true }, '55P03'],
    ['replaced data with an unfinished operation record', { pending: [record('p1', true)] }, 'LIFECYCLE_RESUME_PENDING_OPERATIONS', 'restored'],
    ['replaced data while the tenant key is held', { busy: true }, 'LIFECYCLE_RESUME_LOCK_BUSY', 'restored'],
    ['replaced data when a participant loses the invalidation', { invalidateFails: true }, 'SOCKET_IPC_UNAVAILABLE', 'restored']
  ]) it('refuses ' + label + ' and leaves the tenant closed', async function () {
    const { m, api } = fixture({ durable: suspended(state), ...options });
    await assert.rejects(api.resume(A, { claimId: CLAIM }), code(expected));
    assert.equal(m.durable.window.phase, 'suspended'); assert.equal(m.durable.window.claim_id, CLAIM); assert.deepEqual(m.durable.resumes, []);
    assert(!m.trace.includes('COMMIT')); assert(m.released && !m.pinned); await api.close();
  });

  it('refuses a claim the operator did not inspect, a tenant that is open, and a claim already resumed', async function () {
    const mismatch = fixture();
    await assert.rejects(mismatch.api.resume(A, { claimId: OTHER }), code('LIFECYCLE_RESUME_CLAIM_MISMATCH')); assert(!wrote(mismatch.m));
    await assert.rejects(mismatch.api.resume(A, {}), code('LIFECYCLE_RESUME_INPUT_INVALID'));
    await assert.rejects(mismatch.api.resume(OTHER, { claimId: CLAIM }), code('LIFECYCLE_RESUME_INPUT_INVALID'));
    const once = fixture();
    await once.api.resume(A, { claimId: CLAIM });
    await assert.rejects(once.api.resume(A, { claimId: CLAIM }), code('LIFECYCLE_RESUME_NOT_SUSPENDED'));
    assert.equal(once.m.durable.resumes.length, 1, 'RESUME_ONCE_PER_CLAIM');
    const again = fixture({ durable: { ...suspended('suspended'), resumes: [{ claim_id: CLAIM, generation: '2', interrupted: 'before-data' }] } });
    await assert.rejects(again.api.resume(A, { claimId: CLAIM }), code('LIFECYCLE_RESUME_AUDIT_CHANGED'));
  });

  it('reports a lost commit reply as uncertain; inspect then shows the durable state', async function () {
    const { m, api } = fixture({ loseCommit: true });
    await assert.rejects(api.resume(A, { claimId: CLAIM }), error => error.code === 'LIFECYCLE_RESUME_RESUME_OUTCOME_UNCERTAIN' && error.cause.code === 'ECONNRESET');
    m.loseCommit = false;
    assert.equal((await api.inspect(A)).phase, 'active'); await api.close();
  });

  it('clears only a record with no owner backend that no participant is running', async function () {
    const pending = [record('orphan', true), record('owner-present', false), record('still-running', true)];
    const { m, api } = fixture({ durable: { ...suspended('suspended'), window: { lock_key: '41', phase: 'active', generation: '2', claim_id: null, artifact_digest: null } }, pending, running: ['still-running'] });
    assert.deepEqual(await api.clearOperations(A), { tenant: A, cleared: ['orphan'],
      retained: [{ operation: 'owner-present', reason: 'OWNER_BACKEND_PRESENT' }, { operation: 'still-running', reason: 'OWNER_PROCESS_RUNNING' }] });
    assert.deepEqual(m.durable.clearance, [{ operation_id: 'orphan', generation: '1', marker_pid: 7, marker_birth: 'role-birth' }]);
    assert.equal((await api.inspect(A)).operations.unfinished, 2, 'a cleared record is no longer unfinished');
    assert(!m.trace.some(sql => /^(UPDATE|DELETE)\b/.test(sql)), 'CLEARANCE_APPENDS_ONLY the operation record itself is never changed');
    const none = fixture({ pending: [record('owner-present', false)] });
    assert.deepEqual((await none.api.clearOperations(A)).cleared, []); assert(!none.m.trace.includes('COMMIT'));
    const down = fixture({ pending: [record('orphan', true)], incomplete: true });
    await assert.rejects(down.api.clearOperations(A), code('COHORT_INCOMPLETE')); assert.deepEqual(down.m.durable.clearance, []);
  });

  // Controls: each removes one guard from the module source and shows the
  // property above no longer holds.
  it('control: without the owner-present guard a resume reopens a tenant under a running restore', async function () {
    const { m, api } = fixture({ ownerPresent: true }, source => source
      .replace("      if (restore.owner_present !== false) reasons.push('LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT');\n", '')
      .replace('again.restore?.owner_present !== false || ', ''));
    await api.resume(A, { claimId: CLAIM });
    assert.equal(m.durable.window.phase, 'active', 'mutant opens the tenant while its restore backend is alive');
  });
  it('control: without the participant answer a record whose body is still running is cleared', async function () {
    const { m, api } = fixture({ pending: [record('still-running', true)], running: ['still-running'] }, source => source
      .replace("else if (running.has(row.operation_id)) retained.push({ operation: row.operation_id, reason: 'OWNER_PROCESS_RUNNING' });", ''));
    assert.deepEqual((await api.clearOperations(A)).cleared, ['still-running']); assert.equal(m.durable.clearance.length, 1);
  });
  it('control: without the awaited invalidation the model refuses activation of replaced data', async function () {
    const { m, api } = fixture({ durable: suspended('restored') }, source => source.replace('        await cohorts.invalidate(cohort, tenant);\n', ''));
    await assert.rejects(api.resume(A, { claimId: CLAIM }), /RESUME_INVALIDATES_BEFORE_ACTIVATION/); assert.equal(m.durable.window.phase, 'suspended');
  });
});
