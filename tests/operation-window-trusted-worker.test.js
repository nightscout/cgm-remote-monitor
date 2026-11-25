'use strict';
const assert = require('node:assert/strict');
const fixture = require('./fixtures/operation-window-runtime-protocol');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
describe('Trusted serving admission', function () {
  it('reads tenant generation on each entry and leaves structural verification to admin', async () => {
    const f = fixture({ trustedWorker:true });
    try {
      await f.window.ready();
      for (const tenant of [A, B]) await f.window.run(tenant, () => f.window.assertCurrent(tenant));
      assert.deepEqual(f.log.filter(([sql]) => sql.includes('/* operation-window-current')).map(([,values]) => values), [[A,'17'],[B,'19']]);
      assert.equal(f.log.some(([sql]) => sql.includes('operation-window-role')), false);
      await f.window.run(A, async () => {
        await assert.rejects(f.window.run(B, () => assert.fail('FOREIGN_SCOPE_ADMITTED')), {code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});
        assert.throws(() => require('../lib/tenant-lifecycle/generation-scope').assertNoAmbientScope(), {code:'LIFECYCLE_WINDOW_AMBIENT_SCOPE'});
      });
    } finally { await f.window.close(); }
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
  it('propagates an admitted child SQL failure when the body returns',async()=>{
    const f=fixture({trustedWorker:true}),failure=Error('synthetic child SQL failed');
    try {
      await assert.rejects(f.window.run(A,async()=>{
        const lease=await f.window.acquireClient(f.client,A);
        lease.close(failure);
      }),error=>error===failure);
    } finally { await f.window.close(); }
  });
  for(const [name,change,code] of [
    ['suspension',o=>{o.phase='suspended';},'LIFECYCLE_WINDOW_SUSPENDED'],
    ['restore generation',o=>{o.generation='2';},'LIFECYCLE_WINDOW_SUSPENDED']
  ])it('retains current '+name+' checks on each physical lower transaction',async()=>{
    const options={trustedWorker:true},f=fixture(options);
    await f.window.run(A,async()=>{const lease=await f.window.acquireClient(f.client,A);try{change(options);await assert.rejects(f.window.assertClient(f.client,A,lease),{code});}finally{await lease.close();}});await f.window.close();
  });
});
