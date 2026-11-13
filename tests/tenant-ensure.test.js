'use strict';
// covers: lib/tenant-registry/ensure-dependencies.js, lib/tenant-registry/ensure-datastore.js, lib/tenant-registry/provision-residue.js, lib/tenant-registry/ensure.js, lib/tenant-registry/ensure-lock.js, lib/tenant-registry/ensure-shape.js, lib/tenant-registry/provision.js, lib/tenant-registry/vault-keys.js
const assert = require('node:assert/strict');
const fixture = require('./fixtures/tenant-ensure-recording');

describe('explicit ensure: actual modules with recording SQL/driver (not native evidence)', function () {
  it('rejects an installed profile before constructor or credential effects', async function () {
    const f = fixture(); f.selected = {};
    await assert.rejects(f.create(),{code:'TENANT_ENSURE_SELECTED_UNSUPPORTED'});
    assert.equal(f.constructors,0); assert.equal(f.vaultCalls.length,0);
  });
  it('records an intact observation, replays operation ID and refuses a changed digest', async function () {
    const f = fixture(), s = await f.create(); const first = await s.ensure(f.input);
    assert.equal(first.outcome,'complete'); const reads = f.vaultCalls.length;
    assert.deepEqual(await s.ensure(f.input),first); assert.equal(f.vaultCalls.length,reads);
    assert.equal((await s.ensure({...f.input,hosts:['changed.example.test']})).code,'TENANT_ENSURE_CONFLICT');
    assert.equal(f.data.events.length,2); assert(f.vaultCalls.every(r => r.method === 'GET')); await s.close();
  });
  it('reconstructs only missing settings from complete contiguous immutable history, preserving its version and all protected content', async function () {
    const f = fixture({missingSettings:true}); f.data.history.push({version:2,values:{SHOW_SECONDS:false}});
    const before = JSON.stringify(f.data.protected), s = await f.create(), result = await s.ensure(f.input);
    assert.equal(result.outcome,'repaired'); assert.deepEqual(result.changed,['settings']);
    assert.deepEqual(f.data.recovered,{version:2,values:{SHOW_SECONDS:false}});
    assert.equal(JSON.stringify(f.data.protected),before); assert.equal(f.data.history.length,2); await s.close();
  });
  for (const options of [{vaultMissing:'data'},{vaultMissing:'signing'},{vaultMissing:'access'},{vaultMissing:'management'},{vaultMissing:'human-data'},{vaultMissing:'human-management'}]) {
    it('never creates a registered missing '+options.vaultMissing+' key, and records refusal', async function () {
      const f = fixture(options), s = await f.create(), result = await s.ensure(f.input);
      assert.equal(result.code,'TENANT_ENSURE_DEPENDENCY_UNKNOWN'); assert.equal(result.outcome,'refused');
      assert(f.vaultCalls.every(r => r.method === 'GET')); assert.equal(f.data.events.at(-1).result.outcome,'refused'); await s.close();
    });
  }
  for (const variant of ['gap','absent','unsupported']) it('refuses '+variant+' history without inventing settings/defaults', async function () {
    const f = fixture({missingSettings:true}); f.data.history = variant === 'gap' ? [{version:2,values:{}}] : variant === 'absent' ? [] : [{version:1,values:{UNSUPPORTED:true}}];
    const s = await f.create(), result = await s.ensure(f.input);
    assert.notEqual(result.code,'TENANT_ENSURE_OK'); assert.equal(f.data.settings,false); await s.close();
  });
  it('requires prior exact immutable observation before restoring registry key metadata', async function () {
    const f = fixture(), s = await f.create(); f.data.keys.pop();
    assert.equal((await s.ensure(f.input)).code,'TENANT_ENSURE_PROVENANCE_REQUIRED');
    f.data.keys.push({purpose:'human-management',kid:'human-management-1',public_key:f.pub});
    const second = {...f.input,operationId:'33333333-3333-4333-8333-333333333333'};
    assert.equal((await s.ensure(second)).outcome,'complete'); f.data.keys.pop();
    const third = {...f.input,operationId:'44444444-4444-4444-8444-444444444444'};
    assert.equal((await s.ensure(third)).outcome,'repaired'); assert.equal(f.data.keys.length,4); await s.close();
  });
  for (const option of ['suspended','deletion','pending','otherMissing','lifecycleHeld']) it('refuses '+option+' without resetting state', async function () {
    const f = fixture({[option]:true}), s = await f.create(), before = JSON.stringify(f.data.protected);
    assert.notEqual((await s.ensure(f.input)).code,'TENANT_ENSURE_OK'); assert.equal(JSON.stringify(f.data.protected),before); await s.close();
  });
  it('returns unknown on lost COMMIT reply and never pretends failed release acknowledges retirement', async function () {
    const opts = {}, f = fixture(opts), s = await f.create(); opts.commitReplyLost = true;
    assert.equal((await s.ensure(f.input)).outcome,'unknown');
    const last = f.clients.at(-1); assert(last.released); assert.equal(f.log.filter(r => r.text?.includes('pg_advisory_unlock')).length,0); await s.close();
  });
  it('ordinary registered provisioning retry remains PG-only and uses one held client', async function () {
    const f = fixture(), s = f.fresh(), result = await s.provision({id:f.A,hosts:f.input.hosts});
    assert.equal(result.outcome,'existing'); assert.equal(f.vaultCalls.length,0);
    assert.equal(f.log.filter(r => r.checkout).length,1); await s.close();
  });
  it('ordinary provisioning lock refusal performs zero Vault calls and fails its held client', async function () {
    const f = fixture(), owner = await new (class {async query(){return{rows:[{held:false}]};}})();
    const broken = f.load('lib/tenant-registry/ensure-lock.js',{}); await assert.rejects(broken.acquire(owner,f.ns.registry,f.A),{code:'TENANT_PROVISION_BUSY'});
    // Actual entry path: hold the same fixed lock from an ensure proof.
    let release; const barrier = new Promise(r => { release = r; }), opts = {vaultBarrier:barrier}, g = fixture(opts), e = await g.create();
    const pending = e.ensure(g.input); while (!g.vaultCalls.length) await new Promise(r => setImmediate(r));
    const p = g.fresh(), result = await p.provision({id:g.A,hosts:g.input.hosts});
    assert.equal(result.code,'TENANT_PROVISION_BUSY'); assert.equal(g.vaultCalls.length,1);
    release(); await pending; await e.close(); await p.close();
  });
  it('fresh ensure delegates to actual provisioning with one client per pool and lock-before-key ordering', async function () {
    const f=fixture({fresh:true}), p=f.fresh(), s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    const result=await s.ensure(f.input);assert.equal(result.outcome,'created',JSON.stringify(result));
    const queryIds=new Set(f.log.filter(r=>r.text?.startsWith('INSERT INTO "ensure_registry"."tenant_registry"')).map(r=>r.id));
    assert.equal(queryIds.size,1);const id=[...queryIds][0];
    assert(f.log.some(r=>r.id===id && r.text?.includes('pg_try_advisory_lock(')));
    assert.equal(f.log.filter(r=>r.checkout).length,3,'ensure readiness + ensure held client + actual provision held client');
    assert.equal(f.data.events.length,2);assert.equal(f.data.events.at(-1).result.outcome,'created');
    await s.close();await p.close();
  });
  for (const anotherId of [false,true]) it('unresolved fresh intent never replays key birth '+anotherId,async function(){
    const f=fixture({fresh:true}),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    // Record a real accepted intent, then stop the first actual provision at
    // the pre-key dependency screen. Simulate an unresolved cross-system cut
    // by retaining only its accepted intent, not an invented success record.
    f.data.history=[{version:1,values:{}}];await s.ensure(f.input);
    f.data.history=[];f.data.events=f.data.events.filter(e=>e.phase==='requested');
    const before=f.vaultCalls.length,r=await s.ensure({...f.input,...(anotherId?{operationId:'55555555-5555-4555-8555-555555555555'}:{})});
    assert.equal(r.outcome,'unknown');assert.equal(r.code,'TENANT_ENSURE_COMMIT_UNKNOWN');assert.equal(f.vaultCalls.length,before);
    await s.close();await p.close();
  });
  it('atomic failure after a metadata repair rolls back the repair and preserves the attempt', async function () {
    const opts={},f=fixture(opts),s=await f.create();assert.equal((await s.ensure(f.input)).outcome,'complete');
    f.data.keys.pop();f.data.settings=false;opts.fail=text=>text.startsWith('INSERT INTO "ensure_settings"."tenant_settings"');
    const r=await s.ensure({...f.input,operationId:'55555555-5555-4555-8555-555555555555'});
    assert.equal(r.outcome,'unknown');assert.equal(f.data.keys.length,3);assert.equal(f.data.settings,false);
    assert(f.clients.at(-1).released);await s.close();
  });
  it('failed SQL releases(error) without queueing ROLLBACK/unlock or a second checkout', async function () {
    const f=fixture({fail:text=>text.includes(' AS a0,')}),p=f.fresh();
    assert.equal((await p.provision({id:f.A,hosts:f.input.hosts})).outcome,'refused');
    assert(f.clients.at(-1).released);assert.equal(f.log.filter(r=>r.checkout).length,1);
    assert.equal(f.log.filter(r=>r.text==='ROLLBACK'||r.text?.includes('pg_advisory_unlock')).length,0);assert.equal(f.vaultCalls.length,0);await p.close();
  });

  it('refuses the original fresh-history discriminator before any key birth',async function(){
    const f=fixture({fresh:true});f.data.history=[{version:1,values:{SHOW_SECONDS:true}}];
    const p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p}),r=await s.ensure(f.input);
    assert.equal(r.outcome,'refused');assert.equal(r.code,'TENANT_ENSURE_PROVENANCE_REQUIRED');assert.equal(f.vaultCalls.length,0);await s.close();await p.close();
  });
  for (const flag of ['badDependencyLedger','unknownStore','missingDependencyIndex','invalidFk','badDependencyPolicy','sharedWriter']) it('fresh full profile refuses '+flag+' before key birth',async function(){
    const f=fixture({fresh:true,[flag]:true}),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    assert.notEqual((await s.ensure(f.input)).code,'TENANT_ENSURE_OK');assert.equal(f.vaultCalls.length,0);await s.close();await p.close();
  });
  it('pre-key shared-writer contention records a replayable refusal; a new operation works after drain',async function(){
    const opts={fresh:true,sharedWriter:true},f=fixture(opts),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    const first=await s.ensure(f.input);assert.equal(first.outcome,'refused');assert.equal(first.code,'TENANT_ENSURE_BUSY');assert.equal(f.vaultCalls.length,0);
    opts.sharedWriter=false;assert.deepEqual(await s.ensure(f.input),first);assert.equal(f.vaultCalls.length,0);
    const second=await s.ensure({...f.input,operationId:'55555555-5555-4555-8555-555555555555'});assert.equal(second.outcome,'created');
    await s.close();await p.close();
  });
  it('post-key datastore mismatch stays unresolved and retries do no more key work',async function(){
    const opts={fresh:true,changeFreshAfterKey:true},f=fixture(opts),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    const r=await s.ensure(f.input);assert.equal(r.outcome,'unknown');assert(f.vaultCalls.some(c=>c.method==='POST'));
    const calls=f.vaultCalls.length;opts.changeFreshAfterKey=false;
    assert.equal((await s.ensure({...f.input,operationId:'55555555-5555-4555-8555-555555555555'})).outcome,'unknown');
    assert.equal(f.vaultCalls.length,calls);assert(!f.data.events.some(e=>e.phase==='result'));await s.close();await p.close();
  });
  it('brands only exact immutable pre-key refusal results of the actual service',async function(){
    const f=fixture({fresh:true,sharedWriter:true}),p=f.fresh(),r=await p.provision({id:f.A,hosts:f.input.hosts});
    assert(f.provision.preKeyEnsureRefusal(p,r));assert(!f.provision.preKeyEnsureRefusal({},r));assert(!f.provision.preKeyEnsureRefusal(p,{...r}));
    assert(Object.isFrozen(r));assert.throws(()=>{r.code='TENANT_PROVISION_DATASTORE_CHANGED';},TypeError);await p.close();
  });
  it('post-key cleanup uncertainty cannot become a conclusive pre-key BUSY refusal',async function(){
    const opts={fresh:true},f=fixture(opts),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    // Only provisioner's lifecycle unlock fails; the ensure session's first
    // pre-delegation unlock remains successful.
    opts.fail=text=>text.includes('pg_advisory_unlock($1::bigint)');
    const r=await s.ensure(f.input);assert.equal(r.outcome,'unknown');assert(f.vaultCalls.some(c=>c.method==='POST'));
    assert(!f.data.events.some(e=>e.phase==='result'));await s.close();await p.close();
  });
  it('missing deployment declaration cannot be replaced by a legacy provisioner or API proof',async function(){
    const f=fixture({fresh:true,dependencies:false}),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    assert.equal((await s.ensure(f.input)).code,'TENANT_ENSURE_FRESH_UNAVAILABLE');assert.equal(f.vaultCalls.length,0);await s.close();await p.close();
  });
  for (const [family,table] of [['entries','entries'],['human_session','human_sessions'],['outbox','tenant_notification_requests'],['suppression','tenant_alarm_suppression'],['checkpoint','tenant_consumer_checkpoint']]) it('covers retained '+family+' instance without reading its values',async function(){
    const namespace='extra_'+family,f=fixture({fresh:true,addFamilies:{[family]:[{namespace,catalogue:'canonical'}]},residues:[namespace+'.'+table]});
    const p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});assert.equal((await s.ensure(f.input)).outcome,'refused');assert.equal(f.vaultCalls.length,0);
    const reads=f.log.filter(r=>r.text?.includes('ensure-dependency-residue')&&r.text.includes(namespace));assert(reads.length>0);assert(reads.every(r=>!r.text.includes('doc')&&!r.text.includes('ciphertext')));
    await s.close();await p.close();
  });

  for (const flag of ['wrongFreshDatabase','wrongFreshCluster']) it('same-URL '+flag+' refuses before key birth from actual observations',async function(){
    const f=fixture({fresh:true,[flag]:true}),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    assert.notEqual((await s.ensure(f.input)).code,'TENANT_ENSURE_OK');assert.equal(f.vaultCalls.length,0);await s.close();await p.close();
  });
  it('PID is a per-client witness, not a shared database identity',async function(){
    const f=fixture({fresh:true}),p=f.fresh(),s=await f.ensure.createEnsure({...f.config,freshProvisioning:p});
    assert.equal((await s.ensure(f.input)).outcome,'created');assert(new Set(f.clients.map(c=>c.processID)).size>1);await s.close();await p.close();
  });
  it('a postmaster change refuses until dedicated-admin restart and never auto-rebinds',async function(){
    const options={},f=fixture(options),s=await f.create();options.changedPostmaster=true;
    assert.equal((await s.ensure(f.input)).code,'TENANT_ENSURE_CONFLICT');assert.equal(f.vaultCalls.length,0);await s.close();
  });
  it('missing actual PID witness refuses preparation before provider reads',async function(){
    const f=fixture({wrongPid:true});await assert.rejects(f.create(),{code:'TENANT_ENSURE_STORE_UNPREPARED'});assert.equal(f.vaultCalls.length,0);
  });

});
