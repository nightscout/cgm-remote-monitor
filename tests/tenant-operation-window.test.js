'use strict';
const assert = require('node:assert/strict');
const { create } = require('../lib/tenant-lifecycle/operation-window');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const fixture = require('./fixtures/operation-window-runtime-protocol');

describe('Tenant operation window source protocol (not PostgreSQL evidence)', function () {
  it('binds an active generation before the callback without a durable process marker', async function () {
    const f = fixture();
    try {
      await f.window.run(A, () => {
        assert.equal(f.window.currentGeneration(A), '1');
        assert.deepEqual(f.window.inflight(A), []);
        assert.equal(f.pending.size, 0);
      });
    } finally { await f.window.close(); }
  });
  for (const [label, options, code] of [
    ['held exclusive lock', { held: false }, 'LIFECYCLE_WINDOW_SUSPENDED'],
    ['suspended state', { phase: 'suspended' }, 'LIFECYCLE_WINDOW_SUSPENDED'],
    ['changed lock binding', { key: '23' }, 'LIFECYCLE_WINDOW_BINDING_CHANGED'],
    ['privileged role', { superuser: true }, 'LIFECYCLE_WINDOW_ROLE_UNSAFE']
  ]) it('refuses ' + label + ' before registration or callback', async function () {
    const f = fixture(options); let called = false;
    await assert.rejects(f.window.run(A, () => { called = true; }), { code });
    assert.equal(called, false); assert.equal(f.pending.size, 0);
  });
  it('admits a new body after a failed callback', async function () {
    const f = fixture(); const original = new Error('synthetic body refusal');
    await assert.rejects(f.window.run(A, () => { throw original; }), error => error === original);
    assert.equal(f.pending.size, 0);
    await f.window.run(A, () => {});
    await f.window.close();
    assert.equal(f.pending.size, 0);
  });
  it('invalidates the current scope on control connection loss', async function () {
    const f = fixture(); const original = new Error('synthetic lost lease connection'); let invalidated = 0;
    await assert.rejects(f.window.run(A, async () => {
      f.client.emit('error', original);
      assert.throws(() => f.window.assertCurrent(A), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
    }, { onInvalidated: () => { invalidated++; } }), error => error === original);
    assert.equal(invalidated, 1);
    assert.equal(f.pending.size, 0);
    assert.equal(f.log.some(row => typeof row[0] === 'string' && row[0].startsWith('UPDATE')), false);
  });
  it('reuses same-tenant outer lifetime and refuses cross-tenant nesting', async function () {
    const f = fixture();
    await f.window.run(A, async () => {
      await f.window.run(A, async () => f.window.assertCurrent(A));
      await assert.rejects(f.window.run(B, () => {}), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
    });
    assert.equal(f.pending.size, 0);
  });
  it('refuses unknown tenants and closed windows before pool access', async function () {
    const f = fixture();
    await assert.rejects(f.window.run('33333333-3333-4333-8333-333333333333', () => {}), { code: 'LIFECYCLE_WINDOW_TENANT_UNKNOWN' });
    await f.window.close();
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_CLOSED' });
    assert.deepEqual(f.log, []);
  });
  // Epoch-internal cache/churn expectations are retired: protected DBA drift
  // is screened at physical backend admission, not on every warm transaction.
  const fullAdmissions = f => f.log.filter(row => typeof row[0] === 'string' && row[0].includes('operation-window-role')).length;
  it('admits a physical lifetime backend once and refuses sticky transport termination', async function () {
    const f = fixture(); await f.window.ready(); const base = fullAdmissions(f);
    await f.window.run(A, () => {}); await f.window.run(A, () => {}); await f.window.run(B, () => {});
    assert.equal(fullAdmissions(f), base);
    f.client.emit('end');
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SESSION_LOST' });
    assert.equal(fullAdmissions(f), base, 'an ended marker owner cannot be silently replaced');
    await f.window.close().catch(() => {});
  });
  it('observes the tenant phase in a transaction before entering an application body', async function () {
    const f = fixture();
    await f.window.run(A, () => {
      const order = f.log.map(([sql]) => sql);
      assert(order.findIndex(sql => sql.includes('pg_try_advisory_xact_lock_shared')) < order.findIndex(sql => sql.includes('operation-window-current')));
      assert.equal(order.at(-1), 'COMMIT');
    });
    await f.window.close();
  });
});


describe('Actual consumers use operation-window lifetimes (source protocol)', function () {
  const request = require('supertest');
  function app (window, handler) {
    const express = require('express');
    const router = express.Router(); router.get('/entries', handler);
    const unavailable = async () => { throw new Error('not selected'); };
    return require('../lib/server/tenant-app').createTenantApp({
      operationWindow: window, resolver: { resolve: () => A }, dataRouter: router,
      dataAccess: async () => ({ tenant: A, principal: 'synthetic', consumer: 'synthetic' }),
      verifyCredential: unavailable, authorizeRequest: unavailable,
      tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }
    });
  }
  it('covers actual tenant HTTP response finish and refuses suspension before the data handler', async function () {
    const f = fixture(); let served = 0;
    await request(app(f.window, (req, res) => {
      f.window.assertCurrent(A); assert.equal(f.pending.size, 0);
      served++; res.json({ synthetic: true });
    })).get('/api/v3/entries').expect(200);
    await f.window.close(); assert.equal(served, 1); assert.equal(f.pending.size, 0);
    const suspended = fixture({ phase: 'suspended' });
    await request(app(suspended.window, (req, res) => { served++; res.json({}); })).get('/api/v3/entries').expect(503);
    assert.equal(served, 1); assert.equal(suspended.pending.size, 0);
  });
  it('covers actual evaluator cycles and excludes retained output outside an admitted lifetime', async function () {
    const f = fixture(); let evaluations = 0;
    const jobs = require('../lib/server/serve/evaluator-job-context').create('clinical');
    const runtime = await require('../lib/server/serve/evaluator-runtime')({ tenants: [A],
      operationWindow: f.window, jobContext: jobs, readCurrent: async tenant => ({ tenant, identity: '1'.repeat(64) }),
      create: async () => ({ evaluate: async () => { f.window.assertCurrent(A); evaluations++; return { checkpoint: 0 }; },
        evaluateTime: async () => ({ checkpoint: 0 }), close () {} }),
      recoveryIntervalMs: 10, timeIntervalMs: 20, schedule: () => 1, cancel: () => {} });
    try {
      assert.equal(evaluations, 1); assert.equal(runtime.last(A), null);
      await f.window.run(A, async () => assert.equal(runtime.last(A).eligible, true));
    } finally { await runtime.close(); jobs.close(); await f.window.close(); }
  });
  it('covers realtime acquisition/fanout and recovers after a refused window', async function () {
    const options = {}; const f = fixture(options); let delivered = 0;
    const runtime = await require('../lib/server/realtime/runtime')({ tenants: [A], operationWindow: f.window,
      readCurrent: async tenant => ({ tenant, identity: '1'.repeat(64) }),
      create: () => ({ acquire: async () => ({ frame: {} }) }),
      fanout: async () => { f.window.assertCurrent(A); delivered++; },
      recoveryIntervalMs: 10, schedule: () => 1, cancel: () => {} });
    try {
      assert.equal(delivered, 1); assert.equal(runtime.last(A), null);
      options.phase = 'suspended'; await f.window.drainTenant(A); await assert.rejects(runtime.refresh(A), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      assert.equal(delivered, 1);
      await f.window.invalidateTenant(A); options.phase = 'active'; await runtime.refresh(A); assert.equal(delivered, 2);
    } finally { await runtime.close(); await f.window.close(); }
  });
  it('covers the actual notification producer/retry/adapter handoff and refuses suspended work', async function () {
    const options = {}, f = fixture(options); let sends = 0;
    const mode = require('../lib/storage/tenant-scope'); const prior = mode.getTenancyMode(); mode.setTenancyMode('multi');
    let composed;
    try {
      composed = await require('./fixtures/evaluator-consumers-protocol')((request, callback) => {
        f.window.assertCurrent(request.tenant); sends++; callback(null, { accepted: true, receipt: null, clearedRequestIds: [] });
      }, { operationWindow: f.window });
      await composed.start(); assert.equal(sends, 2);
      options.phase = 'suspended'; await f.window.drainTenant(A); await composed.consumers.retry(A); await composed.consumers.flush(A);
      assert.equal(sends, 2); assert.equal(composed.consumers.health().tenants.find(row => row.tenant === A).state, 'refused');
    } finally {
      if (composed) await composed.close(); await f.window.close(); mode.setTenancyMode(prior);
    }
  });
  it('invalidates A consumer intents and health without changing B or delivering retained A output', async function () {
    const f=fixture(), scope=require('../lib/storage/tenant-scope'), prior=scope.getTenancyMode(); scope.setTenancyMode('multi');
    let composed;
    try {
      composed=await require('./fixtures/evaluator-consumers-protocol')(undefined,{operationWindow:f.window});
      await composed.start();
      const b=composed.consumers.health().tenants.find(row => row.tenant===B), before=composed.effects.length;
      await composed.consumers.invalidateTenant(A); await composed.runtime.invalidateTenant(A);
      assert.equal(composed.consumers.health().tenants.find(row => row.tenant===A).state,'starting');
      assert.deepEqual(composed.consumers.health().tenants.find(row => row.tenant===B),b);
      await composed.consumers.wake(A); await composed.consumers.flush(A);
      assert.equal(composed.effects.length,before);
      assert.deepEqual(composed.consumers.health().tenants.find(row => row.tenant===B),b);
    } finally { if (composed) await composed.close(); await f.window.close(); scope.setTenancyMode(prior); }
  });
  it('covers the actual socket forwarding acknowledgement and refuses without acknowledgement', async function () {
    const options = {}; const f = fixture(options); let replies = 0;
    const forward = require('../lib/server/tenant-socket-forwarding').createForwarder({
      contextForSocket: async () => ({ tenant: A, credential: {} }),
      withOperation: f.window.run,
      transport: async () => { f.window.assertCurrent(A); return { replyArgs: ['synthetic'] }; }
    });
    const input = { namespace: '/', event: 'dbAdd', args: [], acknowledge: () => { f.window.assertCurrent(A); replies++; } };
    assert.equal((await forward.forward(input)).delivered, true); assert.equal(replies, 1);
    options.phase = 'suspended'; await f.window.drainTenant(A); assert.equal((await forward.forward(input)).delivered, false); assert.equal(replies, 1);
    await f.window.close();
  });
});


describe('Selected lower-port window cannot be omitted (source protocol)', function () {
  function lowerModule (f, options = {}) {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const file = path.resolve(__dirname, '../lib/storage/postgres-connection.js');
    const originalRequire = require('node:module').createRequire(file);
    class Pool {
      constructor (options) { assert.equal(Object.hasOwn(options, 'operationWindow'), false); assert.equal(Object.hasOwn(options, 'admitBackend'), false); }
      on () {}
      async query () { return { rows: [{ rolsuper: false, rolbypassrls: false }] }; }
      async connect () { return f.client; }
      async end () { if (options.endFailure) throw new Error('synthetic drain failure'); }
    }
    const output = { exports: {} };
    const body = vm.runInNewContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})', {}, { filename: file });
    body(name => name === 'pg' ? { Pool } : originalRequire(name), output, output.exports);
    return output.exports;
  }
  it('runs constructor-only screening on each physical backend and reuses startup screening',async function () {
    const options={},f=fixture(options),lower=lowerModule(f),scope=require('../lib/storage/tenant-scope');
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    await f.window.ready();const release=lower.installOperationWindow(f.window);let store,calls=0;
    try {
      store=await lower({connectionString:'postgresql://synthetic/disposable_test',admitBackend:async client=>{
        assert.equal(client,f.client);assert(f.window.isAdmittedClient(client));calls++;
      }});
      assert.equal(calls,1);
      await scope.withTenant(A,()=>store.query('SELECT synthetic_screened_body'));
      await scope.withTenant(B,()=>store.query('SELECT synthetic_screened_body'));
      assert.equal(calls,1,'same physical backend reuses startup screening');
      f.client.processID=789;options.sqlPid=789;
      await scope.withTenant(A,()=>store.query('SELECT synthetic_screened_body'));
      assert.equal(calls,2,'different physical backend screened before body');
    } finally {if(store)await store.end();release();await f.window.close();scope.setTenancyMode(previous);}
  });
  it('refuses a constructor callback failure without admitting a lower pool',async function () {
    const f=fixture(),lower=lowerModule(f);await f.window.ready();const release=lower.installOperationWindow(f.window);
    try {
      await assert.rejects(lower({connectionString:'postgresql://synthetic/disposable_test',admitBackend:async()=>{throw new Error('SYNTHETIC_BACKEND_SCREEN_REFUSED');}}),/SYNTHETIC_BACKEND_SCREEN_REFUSED/);
      assert.equal(lower.cohortBackends(f.window).length,0);
    } finally {release();await f.window.close();}
  });
  it('screens trusted lower pools at startup and reobservation instead of each tenant transaction', async function () {
    let unsafe = false;
    const options = { trustedWorker: true, catalogueMutate(kind, rows) { if (unsafe && kind === 'role') rows[0].elevated = true; } };
    const f = fixture(options), lower = lowerModule(f), scope = require('../lib/storage/tenant-scope');
    const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    await f.window.ready(); const release = lower.installOperationWindow(f.window); let store;
    const admissions = () => f.log.filter(row => row[0].includes('operation-window-role')).length;
    try {
      const startup = admissions();
      store = await lower({ connectionString: 'postgresql://synthetic/disposable_test' });
      assert.equal(admissions(), startup + 1, 'full lower admission at pool startup');
      const baseline = admissions();
      for (let i = 0; i < 3; i++) await scope.withTenant(A, () => store.query('SELECT trusted_body'));
      assert.equal(admissions(), baseline);
      assert(!f.log.some(row => row[0].includes('/* operation-window-epoch')));
      unsafe = true;
      await assert.rejects(lower.readopt(f.window), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
      await assert.rejects(scope.withTenant(A, () => store.query('SELECT withdrawn_body')), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
      assert(!f.log.some(row => row[0] === 'SELECT withdrawn_body'));
      unsafe = false; await f.window.verifyOperational(); await lower.readopt(f.window);
      await scope.withTenant(A, () => store.query('SELECT restored_trusted_body'));
    } finally { if (store) await store.end(); release(); await f.window.close(); scope.setTenancyMode(previous); }
  });
  it('rejects a trusted lower pool whose startup catalogue admission fails', async function () {
    let unsafe = false;
    const f = fixture({ trustedWorker: true, catalogueMutate(kind, rows) { if (unsafe && kind === 'role') rows[0].elevated = true; } });
    const lower = lowerModule(f); await f.window.ready(); const release = lower.installOperationWindow(f.window); let created;
    try {
      unsafe = true;
      await assert.rejects(async () => { created = await lower({ connectionString: 'postgresql://synthetic/disposable_test' }); }, { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
      assert.equal(lower.cohortBackends(f.window).length, 0);
    } finally { if (created) await created.end(); release(); await f.window.close(); }
  });
  // The former warm-backend epoch cases required immediate custom rejection
  // after arbitrary DBA policy edits. That behavior is intentionally retired.
  for (const table of ['tenant_lifecycle_restore_resume','tenant_lifecycle_operation_clearance']) {
    it('rejects '+table+' drift at lower physical backend admission and restores',async function () {
      let unsafe=false;
      const f=fixture({catalogueMutate(kind,rows){if(unsafe&&kind===table)rows[0].secured=false;}});
      const lower=lowerModule(f); await f.window.ready();
      const release=lower.installOperationWindow(f.window); let store;
      try {
        unsafe=true;
        await assert.rejects(lower({connectionString:'postgresql://synthetic/disposable_test'}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
        unsafe=false;store=await lower({connectionString:'postgresql://synthetic/disposable_test'});
      } finally {if(store)await store.end();release();await f.window.close();}
    });
  }
  it('rejects a transaction-pooler identity instead of adopting SQL labels', async function () {
    const options={}, f = fixture(options), lower = lowerModule(f);
    await f.window.ready(); options.sqlPid=456; const release = lower.installOperationWindow(f.window);
    try { await assert.rejects(lower({connectionString:'postgresql://synthetic/disposable_test'}), {code:'POSTGRES_COHORT_BACKEND_IDENTITY'}); }
    finally { release(); await f.window.close(); }
  });
  it('requires successful lower pool drain before registry release and retains failed drains', async function () {
    for (const endFailure of [false,true]) {
      const f = fixture(), lower = lowerModule(f,{endFailure}); await f.window.ready();
      const release = lower.installOperationWindow(f.window);
      const store = await lower({connectionString:'postgresql://synthetic/disposable_test'});
      assert.throws(release,/must drain/);
      assert.equal(lower.cohortBackends(f.window).length,1);
      if (endFailure) {
        await assert.rejects(store.end(),/synthetic drain failure/);
        assert.throws(release,/must drain/);
        assert.equal(lower.cohortBackends(f.window).length,1);
      } else { await store.end(); assert.equal(lower.cohortBackends(f.window).length,0); release(); }
      await f.window.close();
    }
  });
  // Decision admission-epoch-everywhere: the census identity of a pooled backend
  // is read once per client and again when the client's backend changes.
  it('reads the backend identity once per pooled client and again on a different backend', async function () {
    const options = {}, f = fixture(options), lower = lowerModule(f), scope = require('../lib/storage/tenant-scope');
    const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    await f.window.ready();
    const release = lower.installOperationWindow(f.window); let store;
    const reads = () => f.log.filter(row => typeof row[0] === 'string' && row[0].startsWith('SELECT pg_backend_pid() AS pid,current_user')).length;
    try {
      store = await lower({ connectionString: 'postgresql://synthetic/disposable_test' });
      for (let i = 0; i < 3; i++) await scope.withTenant(A, () => store.query('SELECT synthetic_body'));
      assert.equal(reads(), 0, 'startup identity reused for three transactions on one backend');
      f.client.processID = 789; options.sqlPid = 789; options.sqlBirth = '1700000000.000002';
      await scope.withTenant(A, () => store.query('SELECT synthetic_body'));
      assert.equal(reads(), 1, 'a different backend is read again');
      assert.ok(lower.cohortBackends(f.window).some(row => row.pid === 789 && row.birth === '1700000000.000002'));
    } finally { if (store) await store.end(); release(); await f.window.close(); scope.setTenancyMode(previous); }
  });
  it('applies the actual selected window when a helper omits it and refuses suspended body SQL', async function () {
    const options = {}, f = fixture(options), lower = lowerModule(f), scope = require('../lib/storage/tenant-scope');
    const previous = scope.getTenancyMode(); scope.setTenancyMode('multi');
    await f.window.ready();
    const release = lower.installOperationWindow(f.window); let store;
    try {
      store = await lower({ connectionString: 'postgresql://synthetic/disposable_test' });
      await scope.withTenant(A, () => store.query('SELECT synthetic_actual_body'));
      assert.ok(f.log.some(row => row[0].includes('pg_try_advisory_xact_lock_shared')));
      options.phase = 'suspended';
      await assert.rejects(scope.withTenant(A, () => store.query('SELECT forbidden_after_suspension')), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      assert.equal(f.log.some(row => row[0] === 'SELECT forbidden_after_suspension'), false);
      await assert.rejects(lower({ connectionString: 'postgresql://synthetic/disposable_test', operationWindow: {} }), /cannot be replaced/);
    } finally { if (store) await store.end(); release(); await f.window.close(); scope.setTenancyMode(previous); }
  });
  it('admits the reserved startup metadata binding only in a DB-confirmed read-only transaction', async function () {
    const options = {}, f = fixture(options), lower = lowerModule(f), scope = require('../lib/storage/tenant-scope');
    await f.window.ready();
    const previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); const zero = '00000000-0000-0000-0000-000000000000';
    const release = lower.installOperationWindow(f.window); let store;
    try {
      store = await lower({ connectionString: 'postgresql://synthetic/disposable_test' });
      await store.withTenant(zero, () => store.query('SELECT synthetic_metadata'));
      assert.ok(f.log.some(row => row[0] === 'BEGIN READ ONLY'));
      assert.equal(f.log.some(row => row[0].includes('pg_try_advisory_xact_lock_shared')), false);
      options.metadataReadOnly = 'off';
      await assert.rejects(scope.withTenant(zero, () => store.snapshotTransaction(() => store.query('SELECT forbidden_metadata_body'))), { code: 'LIFECYCLE_WINDOW_METADATA_READ_ONLY_REQUIRED' });
      assert.ok(f.log.some(row => row[0] === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
      assert.equal(f.log.some(row => row[0] === 'SELECT forbidden_metadata_body'), false);
      await assert.rejects(f.window.run(zero, () => {}), { code: 'LIFECYCLE_WINDOW_TENANT_UNKNOWN' });
      assert.throws(() => create({namespace:'synthetic_window',locks:[{tenant:zero,key:'1'}],pool:{connect(){}}}), /Unique provisioned/);
    } finally { if (store) await store.end(); release(); await f.window.close(); scope.setTenancyMode(previous); }
  });
  it('refuses fabricated/duplicate/closed installation and stale release cannot clear a newer owner', async function () {
    const f = fixture(), other = fixture(), lower = lowerModule(f);
    assert.throws(() => lower.installOperationWindow({ acquireClient () {}, assertClient () {} }), /actual live/);
    const release = lower.installOperationWindow(f.window);
    assert.throws(() => lower.installOperationWindow(other.window), /already selected/);
    release(); const releaseOther = lower.installOperationWindow(other.window); release();
    assert.throws(() => lower.installOperationWindow(f.window), /already selected/);
    releaseOther(); await other.window.close();
    assert.throws(() => lower.installOperationWindow(other.window), /actual live/);
    await f.window.close();
  });
});
