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
  const metadata = protocol(require('./fixtures/lifecycle-domain-profile').metadata(options.intakeProfile,options.metadataMutation));
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
    if (text.includes('restore-window-claim')) {
      // Model the compatibility measured by the bounded A1 PostgreSQL FK/claim probe;
      // this protocol fixture is not a replacement for that native evidence.
      if (m.claimBlocker === 'maintenance' || m.claimBlocker === 'registration-fk' && /FOR UPDATE NOWAIT$/.test(text)) {
        throw Object.assign(new Error('could not obtain lock on row in relation tenant_lifecycle_windows'), { code: '55P03' });
      }
      return { rows: [clone(target().window)] };
    }
    if (text.includes('restore-window-current')) return { rows: [clone(target().window)] };
    if (text.startsWith('UPDATE ') && text.includes('tenant_lifecycle_windows')) {
      const w = target().window;
      if (text.includes("SET phase='suspended'")) { w.phase = 'suspended'; w.generation = values[1]; w.claim_id = values[2]; w.artifact_digest = values[3]; }
      else { assert(m.locked && m.durable.audit.state === 'restored', 'activation follows a committed replacement under the exclusive lock'); w.phase = 'active'; w.claim_id = null; w.artifact_digest = null; }
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO ') && text.includes('tenant_lifecycle_restore_audit')) {
      target().audit = { generation: values[2], artifact_digest: values[3], role_oid: packet.role_oid, owner_pid: packet.pid, owner_birth: packet.birth, state: 'suspended' };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('restore-audit-current')) return { rows: [clone(target().audit)] };
    if (text.startsWith('UPDATE ') && text.includes('tenant_lifecycle_restore_audit')) { target().audit.state = text.includes("SET state='restored'") ? 'restored' : 'activated'; return { rows: [], rowCount: 1 }; }
    if (text.includes('pg_try_advisory_xact_lock(')) {
      assert(m.working);
      return { rows: [{ held: !m.generationBusy }] };
    }
    if (text.includes('restore-exclusive-acquire')) { if (!m.busy) m.locked = true; return { rows: [{ held: m.locked }] }; }
    if (text.includes('restore-exclusive-held')) return { rows: [{ held: m.locked }] };
    if (text.includes('pg_advisory_unlock')) { const held = m.locked; m.locked = false; return { rows: [{ released: held }] }; }
    if (text.startsWith('INSERT INTO synthetic_data')) { target().rows.push(values[0]); return { rowCount: 1, rows: [] }; }
    // Durable activity oracle (pause/suspend flags live outside the window row).
    if (m.durable.activity && /tenant_activity\b/.test(text) && text.startsWith('UPDATE ')) {
      target().activity = { ...target().activity, paused: false, suspended: false }; return { rowCount: 1, rows: [] };
    }
    if (text === "SELECT set_config('synchronous_commit','on',true)") return { rows: [] };
    if (m.localAuth && text.includes('"local_auth".')) {
      assert.equal(m.locked, true); assert.equal(target().window.phase, 'suspended');
      if (text.startsWith('SELECT root_reference_id')) return { rows: [{ root_reference_id: 'root' }] };
      if (text.startsWith('SELECT subject_id') || text.startsWith('SELECT kid')) return { rows: [] };
      if (text.startsWith('UPDATE') || text.startsWith('INSERT')) { target().rows.push(text); return { rowCount: 1, rows: [] }; }
    }
    throw new Error('Unexpected simulated query: ' + text);
  };
  client.release = error => { m.released = true; m.releaseError = error; };
  const api = (options.controller || controller).create({ namespace: 'synthetic_window', locks: [{ tenant: A, key: '41' }, { tenant: B, key: '42' }],
    pool: { connect: async () => { m.connected = true; return client; } }, drainTimeoutMs: 1, intakeProfile: options.intakeProfile });
  return { m, api };
}
const code = value => error => error.code === value;

describe('private tenant restore controller (simulated backend protocol)', function () {
  let prior;
  before(function () { prior = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  after(function () { scope.setTenancyMode(prior); });
  it('prepares local authentication inside the real branded controller and returns after activation', async function () {
    const { m, api } = fixture({ localAuth: true }); let root;
    const prepare = require('../lib/secrets/prepare-local-auth').withMaintenance({ controller: api, namespace: 'local_auth',
      readRoot: async reference => { assert.deepEqual(reference, { tenant: A, id: 'root' }); root = Buffer.from('synthetic-root'); return root; } });
    assert.deepEqual(await prepare(A, { artifactDigest: DIGEST }), { prepared: true });
    assert(root.every(byte => byte === 0)); assert.equal(m.durable.window.phase, 'active');
    assert.equal(m.durable.rows.length, 3);
    assert(m.trace.indexOf('committed:DATA') < m.trace.indexOf('committed:ACTIVATION'));
    await api.close();
  });

  it('does not publish auth preparation success on lost DATA commit', async function () {
      const { m, api } = fixture({ localAuth: true, loseCommit: 'DATA' });
      const prepare = require('../lib/secrets/prepare-local-auth').withMaintenance({ controller: api, namespace: 'local_auth',
        readRoot: async () => Buffer.from('synthetic-root') });
      await assert.rejects(prepare(A, { artifactDigest: DIGEST }), { code: 'LIFECYCLE_RESTORE_DATA_OUTCOME_UNCERTAIN' });
      assert.equal(m.durable.window.phase, 'suspended'); await api.close();
  });

  it('refuses a fabricated maintenance claim before auth SQL or root access', async function () {
    let touched = false;
    const prepare = require('../lib/secrets/prepare-local-auth').withMaintenance({ namespace: 'local_auth',
      controller: { withRestore: async (tenant, options, fn) => ({ result: await fn({ connection: { query: async () => { touched = true; } }, maintenanceClaim: {} }) }) },
      readRoot: async () => { touched = true; } });
    await assert.rejects(prepare(A, { artifactDigest: DIGEST }), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
    assert.equal(touched, false);
  });

  it('commits suspension before callback, joins its transaction, activates after replacement and closes stale claims', async function () {
    const { m, api } = fixture(); let saved;
    const result = await api.withRestore(A, { artifactDigest: DIGEST }, async ({ connection, maintenanceClaim }) => {
      saved = { connection, maintenanceClaim };
      assert.equal(m.durable.window.phase, 'suspended');
      await controller.assertHeld(maintenanceClaim, { connection, tenant: A, artifactDigest: DIGEST });
      await connection.transaction(() => connection.query('INSERT INTO synthetic_data(value) VALUES ($1)', ['restored-A']));
      return 'verified';
    });
    assert.equal(result.state, 'activated'); assert.equal(result.generation, '2'); assert.equal(result.result, 'verified');
    assert.deepEqual(m.durable.rows, ['restored-A']); assert.equal(m.durable.audit.state, 'activated'); assert(m.released && !m.locked); assert.equal(m.releaseError, true, 'controller backend is destroyed after success');
    assert.deepEqual(m.foreign, { ordinal: 100, doc: 'B-current' });
    await scope.withTenant(A, () => assert.rejects(controller.assertHeld(saved.maintenanceClaim, { connection: saved.connection, tenant: A, artifactDigest: DIGEST }), code('LIFECYCLE_RESTORE_CLAIM_INVALID')));
    await assert.rejects(saved.connection.transaction(async () => {}), code('LIFECYCLE_RESTORE_CONNECTION_CLOSED'));
    await api.close();
  });
  it('clearing the maintenance hold never re-enables a paused tenant (actual evaluator runtime)', async function () {
    const policy = require('../lib/tenant-activity/policy');
    const { m, api } = fixture();
    m.durable.activity = { paused: true, suspended: false };
    const work = [], timers = [];
    const runtime = await require('../lib/server/serve/evaluator-runtime')({ tenants: [A], recoveryIntervalMs: 10, timeIntervalMs: 10,
      readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64), env: {} }),
      activity: require('../lib/tenant-activity/eligibility').create({ read: async () => ({ ...m.durable.activity, version: 1, state: policy.stateOf(m.durable.activity) }) }),
      schedule: fn => timers.push(fn), cancel: () => {},
      create: async () => { work.push('create'); return { evaluate: async () => { work.push('acquisition'); return { checkpoint: 1 }; }, evaluateTime: async () => ({ checkpoint: 1 }), close () {} }; } });
    await api.withRestore(A, { artifactDigest: DIGEST }, async () => 'restored');
    assert.equal(m.durable.window.phase, 'active', 'maintenance hold cleared');
    assert.deepEqual(m.durable.activity, { paused: true, suspended: false }, 'ACTIVITY_RESTORE_PRESERVES desired pause survives activation');
    // The backstop pass and a time-only trigger (what a due-time timer calls).
    await timers[0](); await runtime.backstop(); await runtime.tick(A); await runtime.acquire(A);
    assert.deepEqual(work, [], 'ACTIVITY_RESTORE_PRESERVES no evaluator work after activation');
    assert.equal(runtime.health().tenants[0].code, 'EVALUATOR_TENANT_PAUSED');
    await runtime.close(); await api.close();
  });
  it('refuses a final effect commit in progress before advancing the generation', async function () {
    const { m, api } = fixture({ generationBusy: true });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, () => assert.fail()), code('LIFECYCLE_RESTORE_LOCK_BUSY'));
    assert.equal(m.durable.window.phase, 'active');
    assert.equal(m.durable.window.generation, '1');
    assert.equal(m.durable.audit, null);
    assert(!m.trace.some(sql => sql.startsWith('UPDATE ') || sql.startsWith('INSERT INTO ')));
    await api.close();
  });
  it('refuses a competing maintenance row lock before suspension without retry or effects', async function () {
    const { m, api } = fixture({ claimBlocker: 'maintenance' });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => assert.fail('restore must not run')), code('55P03'));
    assert.equal(m.durable.window.phase, 'active');
    assert.equal(m.durable.audit, null);
    assert.deepEqual(m.durable.rows, []);
    assert.equal(m.trace.filter(sql => sql.includes('restore-window-claim')).length, 1);
    assert(!m.trace.some(sql => sql.startsWith('UPDATE ') || sql.startsWith('INSERT INTO ')));
    assert(m.released);
    await api.close();
  });
  it('publishes claim-bound effects only after definite outer DATA commit', async function () {
    const {m,api}=fixture();let effects=0;
    await api.withRestore(A,{artifactDigest:DIGEST},async({connection,maintenanceClaim})=>{
      await assert.rejects(async()=>controller.registerAfterCommit({}, {connection,tenant:A,artifactDigest:DIGEST},()=>{}),code('LIFECYCLE_RESTORE_EFFECT_INVALID'));
      assert.throws(()=>controller.registerAfterCommit(maintenanceClaim,{connection,tenant:B,artifactDigest:DIGEST},()=>{}),code('LIFECYCLE_RESTORE_EFFECT_INVALID'));
      connection.afterCommit(async()=>{assert.deepEqual(m.durable.rows,['effect-A']);assert.equal(m.durable.audit.state,'restored');assert.equal(m.durable.window.phase,'suspended');effects++;});
      await connection.query('INSERT INTO synthetic_data(value) VALUES ($1)',['effect-A']);assert.equal(effects,0);
    });
    assert.equal(effects,1);await api.close();
  });
  for (const uncertain of [false,true]) it('never publishes effects after '+(uncertain?'ambiguous DATA commit':'rollback'),async function(){
    const {m,api}=fixture(uncertain?{loseCommit:'DATA'}:{});let effects=0;
    await assert.rejects(api.withRestore(A,{artifactDigest:DIGEST},async({connection})=>{
      connection.afterCommit(()=>{effects++;});await connection.query('INSERT INTO synthetic_data(value) VALUES ($1)',['effect-A']);
      if(!uncertain)throw Object.assign(new Error('interrupt'),{code:'CONTROL_INTERRUPT'});
    }),code(uncertain?'LIFECYCLE_RESTORE_DATA_OUTCOME_UNCERTAIN':'CONTROL_INTERRUPT'));
    assert.equal(effects,0);assert.equal(m.durable.window.phase,'suspended');assert.deepEqual(m.durable.rows,uncertain?['effect-A']:[]);await api.close();
  });
  it('refuses current operator authority without suspending A', async function () {
    const { m, api } = fixture({ authority: false });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => {}), code('LIFECYCLE_RESTORE_AUTHORITY_REFUSED'));
    assert.equal(m.durable.window.phase, 'active'); assert.equal(m.durable.audit, null); await api.close();
  });
  it('finishes restore while a committed response remains held', async function () {
    const { m, api } = fixture({ running: ['held-response'] });
    const result = await api.withRestore(A, { artifactDigest: DIGEST }, async () => {
      assert.deepEqual(m.running, ['held-response']);
      assert.equal(m.durable.window.phase, 'suspended');
      assert.equal(m.locked, true);
    });
    assert.equal(result.state, 'activated');
    assert.deepEqual(m.running, ['held-response']);
    await api.close();
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
  for (const stage of ['SUSPENSION','DATA','ACTIVATION']) it('retains actual durable outcomes after lost ' + stage + ' COMMIT response', async function () {
    const { m, api } = fixture({ loseCommit: stage });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async ({ connection }) => connection.query('INSERT INTO synthetic_data(value) VALUES ($1)', ['committed-A'])), code('LIFECYCLE_RESTORE_' + stage + '_OUTCOME_UNCERTAIN'));
    assert.equal(m.durable.window.phase, stage === 'ACTIVATION' ? 'active' : 'suspended');
    assert.equal(m.durable.audit.state, stage === 'SUSPENSION' ? 'suspended' : stage === 'DATA' ? 'restored' : 'activated');
    assert.deepEqual(m.durable.rows, stage === 'SUSPENSION' ? [] : ['committed-A']);
    await api.close();
  });
  it('refuses reissuing an existing suspended claim rather than treating retry as recovery', async function () {
    const { m, api } = fixture({ closedBefore: true, durable: { window: { lock_key: '41', phase: 'suspended', generation: '2', claim_id: 'existing', artifact_digest: DIGEST }, audit: null, rows: [] } });
    await assert.rejects(api.withRestore(A, { artifactDigest: DIGEST }, async () => assert.fail()), code('LIFECYCLE_RESTORE_ALREADY_SUSPENDED'));
    assert.equal(m.durable.window.claim_id, 'existing'); await api.close();
  });
});

// Selected source protocol only; these are not native constraint/cohort proofs.
describe('selected lifecycle generation controller preflight',function(){
 const selected=require('./fixtures/lifecycle-domain-profile'),maximum=require('../lib/pgstream/intake-profile').DOMAIN.completeMaximum;
 const state=g=>({window:{lock_key:'41',phase:'active',generation:g,claim_id:null,artifact_digest:null},audit:null,rows:[]});
 let prior;before(()=>{prior=scope.getTenancyMode();scope.setTenancyMode('multi');});after(()=>scope.setTenancyMode(prior));
 it('refuses exhausted selected headroom before UPDATE/audit/commit without changing the durable row',async()=>{const initial=state(maximum),{m,api}=fixture({intakeProfile:selected.profile(),durable:clone(initial)});await assert.rejects(api.withRestore(A,{artifactDigest:DIGEST},async()=>assert.fail('NO_BODY')),{code:'LIFECYCLE_GENERATION_DOMAIN_UNSUPPORTED'});assert.deepEqual(m.durable,initial);assert(!m.trace.some(sql=>/^(UPDATE|INSERT|COMMIT)/.test(sql)));await api.close();});
 it('suspends at maximum then activates at the SAME maximum',async()=>{const {m,api}=fixture({intakeProfile:selected.profile(),durable:state((BigInt(maximum)-1n).toString())});await api.withRestore(A,{artifactDigest:DIGEST},async()=>{assert.equal(m.durable.window.generation,maximum);assert.equal(m.durable.window.phase,'suspended');});assert.equal(m.durable.window.generation,maximum);assert.equal(m.durable.window.phase,'active');await api.close();});
 it('ablation: removing only the locked-row range check permits unsupported mutation; restored check refuses',async()=>{const fs=require('fs'),path=require('path'),file=require.resolve('../lib/tenant-lifecycle/maintenance-window'),source=fs.readFileSync(file,'utf8'),needle="if(intakeProfile||nativeSelection)require('./generation-domain').assertGeneration(w[0].generation,{next:true});";assert(source.includes(needle));const loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));loaded._compile(source.replace(needle,''),file);const broken=fixture({intakeProfile:selected.profile(),durable:state(maximum),controller:loaded.exports});await broken.api.withRestore(A,{artifactDigest:DIGEST},async()=>{});assert.equal(broken.m.durable.window.generation,(BigInt(maximum)+1n).toString());assert(broken.m.trace.some(sql=>sql.startsWith('UPDATE ')));await broken.api.close();const restored=fixture({intakeProfile:selected.profile(),durable:state(maximum)});await assert.rejects(restored.api.withRestore(A,{artifactDigest:DIGEST},async()=>{}),{code:'LIFECYCLE_GENERATION_DOMAIN_UNSUPPORTED'});assert(!restored.m.trace.some(sql=>sql.startsWith('UPDATE ')));await restored.api.close();});
});
