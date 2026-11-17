'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const epochs = f => f.log.filter(row => row[0].includes('/* operation-window-epoch'));
const full = f => f.log.filter(row => row[0].includes('operation-window-role'));

describe('Explicit trusted worker operation boundary (source protocol)', function () {
  it('omits catalogue digests for trusted work and retains full inspection at the operational boundary', async function () {
    const f = fixture({ trustedWorker: true });
    await f.window.ready(); const baseline = full(f).length;
    await f.window.run(A, () => {}); await f.window.run(B, () => {});
    assert.equal(epochs(f).length, 0);
    assert.equal(full(f).length, baseline, 'no per-tenant full admission');
    const current = f.log.filter(row => row[0].includes('/* operation-window-current'));
    assert.equal(current.length, 2, 'each registration checks current tenant state');
    assert.deepEqual(current.map(([,values]) => values), [[A, '17'], [B, '19']]);
    for (const [sql] of current) {
      assert(!sql.includes('pg_auth_members') && !sql.includes('string_agg') && !sql.includes('sha256'));
      assert(sql.includes('w.tenant_id=b.tenant') && !sql.includes('r.rolsuper') && !sql.includes('pg_backend_pid()'));
    }
    await f.window.verifyClient(f.client);
    await f.window.verifyOperational();
    assert.equal(full(f).length, baseline + 2);
    await f.window.close();
  });
  for (const method of ['verifyOperational', 'verifyClient']) it('withdraws trusted admission after ' + method + ' fails and requires operational revalidation', async function () {
    let drift = false;
    const f = fixture({ trustedWorker: true, catalogueMutate: (kind, rows) => { if (drift && kind === 'role') rows[0].elevated = true; } });
    await f.window.ready(); await f.window.run(A, () => {});
    drift = true;
    await assert.rejects(f.window[method](...(method === 'verifyClient' ? [f.client] : [])), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await assert.rejects(f.window.run(A, () => assert.fail('withdrawn worker body')), error => ['LIFECYCLE_WINDOW_SCHEMA_UNSAFE','LIFECYCLE_WINDOW_SESSION_LOST'].includes(error.code));
    drift = false;
    await f.window.verifyClient(f.client);
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational();
    await f.window.run(A, () => {});
    await f.window.close();
  });
  it('defers catalogue drift detection to the trusted operational boundary and rejects unsafe structure on public startup', async function () {
    let drift = false;
    const options = { trustedWorker: true, catalogueMutate: (kind, rows) => { if (drift && kind === 'role') rows[0].elevated = true; } };
    const f = fixture(options); await f.window.ready(); await f.window.run(A, () => {});
    drift = true; options.epoch = 'f'.repeat(64);
    await f.window.run(A, () => {});
    await assert.rejects(f.window.verifyOperational(), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    const publicFixture = fixture({ ...options, trustedWorker: false });
    await assert.rejects(publicFixture.window.ready(), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    drift = false; await f.window.verifyOperational();
    await f.window.close();
  });
  for (const [label, options, code] of [
    ['suspension', { phase: 'suspended' }, 'LIFECYCLE_WINDOW_SUSPENDED'],
    ['tenant binding', { key: '23' }, 'LIFECYCLE_WINDOW_BINDING_CHANGED'],
  ]) it('checks live ' + label + ' before trusted body SQL', async function () {
    // Apply changes only after successful startup admission.
    const live = { trustedWorker: true }; const changed = fixture(live); await changed.window.ready(); Object.assign(live, options);
    await assert.rejects(changed.window.run(A, () => assert.fail('unsafe trusted body')), { code });
    assert.equal(changed.pending.size, 0);
    assert(changed.log.some(row => row[0] === 'ROLLBACK'));
    await changed.window.close();
  });
  it('withdraws in-flight scope and output when external operational verification fails', async function () {
    let drift = false, releaseBody, entered;
    const f = fixture({ trustedWorker: true, catalogueMutate: (kind, rows) => { if (drift && kind === 'role') rows[0].elevated = true; } });
    const barrier = new Promise(resolve => { releaseBody = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const running = f.window.run(A, async () => {
      entered(); await barrier;
      assert.equal(f.window.current(A), false);
      assert.throws(() => f.window.assertCurrent(A), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
      assert.throws(() => f.window.currentGeneration(A), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
      return 'withdrawn output';
    });
    const settled = running.catch(error => error);
    await started; drift = true;
    await assert.rejects(f.window.verifyOperational(), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    releaseBody(); assert.equal((await settled).code, 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE');
    assert.equal(f.pending.size, 0);
    drift = false; await f.window.verifyOperational();
    await f.window.close();
    assert.equal(f.pending.size, 0);
  });
  it('withdraws trusted admission when acquiring the operational backend fails', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    const connect = f.pool.connect;
    f.pool.connect = async () => { throw new Error('synthetic operational backend unavailable'); };
    await assert.rejects(f.window.verifyOperational(), /synthetic operational backend unavailable/);
    f.pool.connect = connect;
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational(); await f.window.run(A, () => {});
    await f.window.close();
  });
  it('withdraws an open public output scope after a failed readiness screen', async function () {
    const f = fixture({ trustedWorker: false });
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const body = f.window.run(A, async () => {
      entered(); await held;
      assert.equal(f.window.current(A), false);
      assert.throws(() => f.window.assertCurrent(A), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
    });
    try {
      await started;
      await assert.rejects(f.window.verifyOperational(() => { throw Error('synthetic privilege drift'); }), /privilege drift/);
      await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
      release(); await body;
      await f.window.verifyOperational();
      await f.window.run(A, () => f.window.assertCurrent(A));
    } finally { release(); await body.catch(() => {}); await f.window.close(); }
  });
  it('keeps admission withdrawn through the held related callback, then reopens', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const verifying = f.window.verifyOperational(async () => { entered(); await held; });
    await started;
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyClient(f.client);
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    release(); await verifying;
    await f.window.run(A, () => {}); await f.window.close();
  });
  it('leaves admission withdrawn after a related callback fails and supports a full retry', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    const failure = new Error('synthetic related worker verification failure');
    await assert.rejects(f.window.verifyOperational(async () => { await f.window.verifyClient(f.client); throw failure; }), error => error === failure);
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational(async () => { await f.window.verifyClient(f.client); });
    await f.window.run(A, () => {}); await f.window.close();
  });
  it('does not reopen around a concurrent pending or failed verification', async function () {
    const f = fixture({ trustedWorker: true }); await f.window.ready();
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const first = f.window.verifyOperational(async () => { entered(); await held; });
    await started;
    await f.window.verifyOperational();
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await assert.rejects(f.window.verifyOperational(async () => { throw new Error('synthetic concurrent refusal'); }));
    release(); await first;
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_SCHEMA_UNSAFE' });
    await f.window.verifyOperational(); await f.window.run(A, () => {}); await f.window.close();
  });
  it('rejects invalid related-verification callbacks', async function () {
    const f = fixture({ trustedWorker: true });
    for (const value of [null, false, 1, {}, 'callback']) await assert.rejects(f.window.verifyOperational(value), TypeError);
    await f.window.run(A, () => {}); await f.window.close();
  });
  it('still rejects cross-tenant nesting and operational checks inherited from a tenant body', async function () {
    const f = fixture({ trustedWorker: true });
    await f.window.run(A, async () => {
      await assert.rejects(f.window.run(B, () => {}), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
      await assert.rejects(f.window.verifyOperational(), { code: 'LIFECYCLE_WINDOW_AMBIENT_SCOPE' });
    });
    await f.window.close();
  });
});

describe('Generation scope and physical lower exclusion (source protocol)', function () {
  const turns = () => new Promise(resolve => setImmediate(resolve));
  it('takes an independent transaction lock and samples current generation on every lower effect', async () => {
    const f = fixture({ trustedWorker: true });
    try {
      await f.window.run(A, async () => {
        for (let i = 0; i < 3; i++) {
          const lease = await f.window.acquireClient(f.client, A);
          try {
            const start = f.log.length;
            assert.equal(await f.window.assertClient(f.client, A, lease), '1');
            const physical = f.log.slice(start).map(([sql]) => sql);
            const lock = physical.findIndex(sql => sql.includes('pg_try_advisory_xact_lock_shared'));
            const current = physical.findIndex(sql => sql.includes('/* operation-window-current */'));
            assert(lock >= 0 && current > lock, 'writable admission must read the generation in a fresh statement after its lock');
            await f.window.assertCommit(f.client, A, lease);
          } finally { await lease.close(); }
        }
      });
      assert.equal(f.log.filter(([sql]) => sql.startsWith('SELECT pg_try_advisory_xact_lock_shared($1::bigint)')).length, 3);
      assert.equal(f.log.filter(([sql]) => sql.includes('/* operation-window-final */')).length, 3);
      assert.equal(f.pending.size, 0);
    } finally { await f.window.close(); }
  });
  it('drains admitted child SQL before settling the body and refuses escaped children',async()=>{
    const f=fixture({trustedWorker:true});let lower,entered,releaseLate,late;
    const started=new Promise(resolve=>{entered=resolve;}),later=new Promise(resolve=>{releaseLate=resolve;});
    let settled=false;
    const work=f.window.run(A,async()=>{lower=await f.window.acquireClient(f.client,A);late=later.then(()=>f.window.acquireClient(f.client,A));entered();}).then(()=>{settled=true;});
    await started;await turns();assert.equal(settled,false);assert.equal(f.pending.size, 0);
    assert.equal(f.log.filter(([sql])=>sql.includes('pg_advisory_unlock_shared')).length,0,'SQL transaction boundaries release tenant locks');
    releaseLate();await assert.rejects(late,{code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});
    await lower.close();await work;assert.equal(f.pending.size, 0);await f.window.close();
  });
  it('refuses inherited nested bodies and authority after the parent returns while admitted SQL drains',async()=>{
    const f=fixture({trustedWorker:true});let lower,enter,release,late;
    const started=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const running=f.window.run(A,async()=>{lower=await f.window.acquireClient(f.client,A);late=gate.then(async()=>{assert.equal(f.window.current(A),false);assert.throws(()=>f.window.assertCurrent(A),{code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});assert.throws(()=>f.window.currentGeneration(A),{code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});await assert.rejects(f.window.run(A,()=>assert.fail('expired nested effect')),{code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});});enter();});
    await started;await turns();release();await late;await lower.close();await running;await f.window.close();
  });
  it('propagates a drained child failure and rejects child SQL after lifetime loss',async()=>{
    const f=fixture({trustedWorker:true});const failure=Error('synthetic child SQL failed');
    await assert.rejects(f.window.run(A,async()=>{const lease=await f.window.acquireClient(f.client,A);await lease.close(failure);}),error=>error===failure);
    let release,entered,lower;const gate=new Promise(resolve=>{release=resolve;}),start=new Promise(resolve=>{entered=resolve;});
    const work=f.window.run(A,async()=>{lower=await f.window.acquireClient(f.client,A);entered();await gate;});const ended=work.catch(error=>error);
    await start;const lost=Error('synthetic lifetime transport loss');f.client.emit('error',lost);
    // This assertion runs outside the body ALS scope: invalid physical admission is the refusal boundary.
    await assert.rejects(f.window.assertClient(f.client,A,lower),{code:'LIFECYCLE_WINDOW_NOT_READY'});
    await lower.close();release();assert.equal(await ended,lost);await f.window.close().catch(()=>{});
  });
  for(const [name,change,code] of [
    ['suspension',o=>{o.phase='suspended';},'LIFECYCLE_WINDOW_SUSPENDED'],
    ['restore generation',o=>{o.generation='2';},'LIFECYCLE_WINDOW_SUSPENDED']
  ])it('retains current '+name+' checks on each physical lower transaction',async()=>{
    const options={trustedWorker:true},f=fixture(options);
    await f.window.run(A,async()=>{const lease=await f.window.acquireClient(f.client,A);try{change(options);await assert.rejects(f.window.assertClient(f.client,A,lease),{code});}finally{await lease.close();}});await f.window.close();
  });
});
