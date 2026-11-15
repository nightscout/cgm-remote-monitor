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
    for (const [sql] of current) {
      assert(!sql.includes('pg_auth_members') && !sql.includes('string_agg') && !sql.includes('sha256'));
      assert(sql.includes('w.tenant_id=$1') && sql.includes('r.rolsuper') && sql.includes('pg_backend_pid()'));
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
    ['role elevation', { superuser: true }, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['role CREATEROLE', {createrole:true}, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['role CREATEDB', {createdb:true}, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['role REPLICATION', {replication:true}, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['control-owner membership', {ownsControl:true}, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['current principal', {roleOid:62}, 'LIFECYCLE_WINDOW_ROLE_UNSAFE'],
    ['datastore replacement', { datastore: { postmaster_birth: 'changed' } }, 'LIFECYCLE_WINDOW_DATASTORE_CHANGED'],
    ['backend replacement', { sqlPid: 124 }, 'LIFECYCLE_WINDOW_DATASTORE_CHANGED']
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
    assert.deepEqual([...f.pending.values()], [false], 'withdrawn request output does not complete process participation');
    drift = false; await f.window.verifyOperational();
    await f.window.close();
    assert.deepEqual([...f.pending.values()], [true]);
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

describe('Process participation and physical lower exclusion (source protocol)', function () {
  const turns = () => new Promise(resolve => setImmediate(resolve));
  const lockCalls = f => f.log.filter(([sql]) => sql.includes('pg_try_advisory_lock_shared')).length;
  async function exercise(createWindow) {
    const f = fixture({trustedWorker:true}, createWindow);
    try {
    await f.window.run(A, async () => {
      for(let i=0;i<3;i++) {
        const lease=await f.window.acquireClient(f.client,A);
        try { assert.equal(await f.window.assertClient(f.client,A,lease),'1'); }
        finally { await lease.close(); }
      }
    });
    assert.equal(lockCalls(f),4,'LOWER_SQL_MUST_OWN_PHYSICAL_EXCLUSION');
    assert.equal(f.log.filter(([sql])=>sql.includes('/* operation-window-current')).length,4,'every lower transaction still checks live authority');
    assert.deepEqual([...f.pending.values()],[false]);
    } finally { await f.window.close(); }
  }
  it('takes a physical lock and checks current authority for every lower transaction', async()=>exercise());
  it('does not borrow a trusted lifetime for default public work or for work without an outer operation', async()=>{
    const publicFixture=fixture();await publicFixture.window.run(A,async()=>{const lease=await publicFixture.window.acquireClient(publicFixture.client,A);await lease.close();});
    assert.equal(lockCalls(publicFixture),2);await publicFixture.window.close();
    const trusted=fixture({trustedWorker:true});await trusted.window.ready();const lease=await trusted.window.acquireClient(trusted.client,A);await lease.close();assert.equal(lockCalls(trusted),1);await trusted.window.close();
  });
  it('drains admitted child SQL before settling the body and refuses escaped children',async()=>{
    const f=fixture({trustedWorker:true});let lower,entered,releaseLate,late;
    const started=new Promise(resolve=>{entered=resolve;}),later=new Promise(resolve=>{releaseLate=resolve;});
    let settled=false;
    const work=f.window.run(A,async()=>{lower=await f.window.acquireClient(f.client,A);late=later.then(()=>f.window.acquireClient(f.client,A));entered();}).then(()=>{settled=true;});
    await started;await turns();assert.equal(settled,false);assert.deepEqual([...f.pending.values()],[false]);
    assert.equal(f.log.filter(([sql])=>sql.includes('pg_advisory_unlock_shared')).length,1,'cold registration releases its lock before request bodies');
    releaseLate();await assert.rejects(late,{code:'LIFECYCLE_WINDOW_SCOPE_INVALID'});
    await lower.close();await work;assert.deepEqual([...f.pending.values()],[false]);await f.window.close();
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
    ['backend',o=>{o.sqlPid=124;},'LIFECYCLE_WINDOW_DATASTORE_CHANGED'],
    ['restore generation',o=>{o.generation='2';},'LIFECYCLE_WINDOW_BINDING_CHANGED'],
    ['role',o=>{o.superuser=true;},'LIFECYCLE_WINDOW_ROLE_UNSAFE']
  ])it('retains current '+name+' checks on each physical lower transaction',async()=>{
    const options={trustedWorker:true},f=fixture(options);
    await f.window.run(A,async()=>{const lease=await f.window.acquireClient(f.client,A);try{change(options);await assert.rejects(f.window.assertClient(f.client,A,lease),{code});}finally{await lease.close();}});await f.window.close();
  });
  it('detects an ablated lower physical lock and restores the control',async()=>{
    const fs=require('node:fs'),vm=require('node:vm'),file=require.resolve('../lib/tenant-lifecycle/operation-window');
    const text=fs.readFileSync(file,'utf8'),needle='const row = metadata ? null :';
    assert(text.includes(needle));const broken=text.replace(needle,'const row = metadata || !lifetime ? {held:true} :');
    const output={exports:{}};vm.runInThisContext('(function(require,module,exports){'+broken+'\n})',{filename:file})(require('node:module').createRequire(file),output,output.exports);
    await assert.rejects(exercise(output.exports.create),/LOWER_SQL_MUST_OWN_PHYSICAL_EXCLUSION/);
    await exercise();
  });
});


// Live owner membership must be checked on every transaction inside one HTTP
// lifetime. The former all-membership/catalogue-epoch cache assertions are retired.
describe('Public live principal boundaries inside one serving operation', function () {
  async function exercise (createWindow) {
    let bodies = 0;
    const options = {};
    const f = fixture(options, createWindow);
    async function transaction () {
      const lease = await f.window.acquireClient(f.client, A);
      try {
        await f.client.query('BEGIN');
        await f.client.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
        await f.window.assertClient(f.client, A, lease);
        bodies++; await f.client.query('COMMIT');
      } catch (error) { await f.client.query('ROLLBACK'); throw error; }
      finally { await lease.close(); }
    }
    try {
      await f.window.run(A, async () => {
        await transaction(); options.ownsControl = true;
        await assert.rejects(transaction(), {code:'LIFECYCLE_WINDOW_ROLE_UNSAFE'});
        assert.equal(bodies,1);
        options.ownsControl = false; await transaction();
      });
      assert.equal(bodies,2);
      assert.equal(epochs(f).length,0);
      assert.deepEqual([...f.pending.values()],[false]);
    } finally {await f.window.close();}
  }
  it('rejects current control-owner membership between transactions in one lifetime', async () => exercise());
  it('detects a broken owner-membership live fence and restores green', async function () {
    const fs=require('node:fs'),vm=require('node:vm');
    const file=require.resolve('../lib/tenant-lifecycle/operation-window');
    const source=fs.readFileSync(file,'utf8'),needle=' || row.owns_control !== false';
    assert(source.includes(needle));
    const output={exports:{}};
    vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'')+'\n})',{filename:file})(require('node:module').createRequire(file),output,output.exports);
    await assert.rejects(exercise(output.exports.create),/Missing expected rejection/);
    await exercise();
  });
});
