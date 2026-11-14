'use strict';
const assert = require('node:assert/strict');
const runtime = require('../lib/server/realtime/runtime');
const checkpoints = require('../lib/pgstream/checkpoint');
const completed = require('../lib/pgstream/realtime-output');
const scope = require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
describe('completed-output delivery reuse', function () {
  it('coalesces unchanged hints, preserves fresh reads and recovers a missed hint with the existing timer', async function () {
    let timer, stamp=1, reads=0, watched=[A];
    const published=[];
    const service=await runtime({tenants:[A,B],eventDriven:true,recoveryIntervalMs:1000,
      watchedTenants:()=>watched,readCurrent:async tenant=>({tenant,identity:tenant}),
      detect:async tenants=>new Map(tenants.map(tenant=>[tenant,{identity:tenant,stamp:tenant===A?stamp:1}])),
      create:current=>({acquire:async()=>{reads++;return {tenant:current.tenant,checkpoint:current.tenant===A?stamp:1,frame:{},rows:[]};}}),
      fanout:async value=>published.push(value),schedule:fn=>{timer=fn;return 1;},cancel(){}});
    try {
      const baseline=reads;
      service.wake(A);await service.tick();
      assert.equal(reads,baseline,'UNCHANGED_OUTPUT_HINT_MUST_NOT_REACQUIRE');
      await service.fresh(A);assert.equal(reads,baseline+1,'EXPLICIT_FRESH_MUST_READ_AFTER_ARRIVAL');
      stamp++;timer();await service.tick();
      assert.equal(service.last(A).checkpoint,2,'WATCHED_RECOVERY_MUST_FIND_MISSED_HINT');
      assert.equal(service.last(B).checkpoint,1,'OTHER_TENANT_UNCHANGED');
      const after=reads;watched=[];stamp++;timer();await service.tick();assert.equal(reads,after);
      service.wake(A);await service.tick();assert.equal(service.last(A).checkpoint,3);
    } finally {await service.close();}
  });
  it('reads a tenant/current/control-checked frame without a write-only realtime cursor or clinical result copy', async function () {
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    let digest, enabled=true, completedVersion='1', restore=7, identity='current';
    const connection={async transaction(){throw new Error('WRITE_ONLY_CURSOR_MUST_NOT_RUN');},async query(text,values){
      assert.equal(scope.currentTenant(),A);assert.equal(values[0],A);
      assert.match(text,/\(projection->0->'output'\)-'result'/,'CLINICAL_RESULT_MUST_NOT_TRANSFER');
      return {rows:[{contract_digest:digest,projection:[{kind:'evaluator-work-v1',enabled,observed:{lifecycle:'1'},completed:{lifecycle:completedVersion},output:{tenant:A,identity,restoreGeneration:restore,outputRevision:3,inputCheckpoint:2,rows:[],frame:{sgvs:[]}}}]}]};
    }};
    const config={consumer:'realtime-test',namespaces:{checkpoint:'rt_checkpoint'},completedOutput:{namespace:'test_completed',consumer:'evaluator-test'},maxBytes:100000,recoveryIntervalMs:1000};
    digest=checkpoints.create({connection,namespace:'test_completed',consumer:'evaluator-test',maxBytes:200000,timeIntervalMs:1000}).digest;
    const projection=completed.projection({config,connection,current:{tenant:A,identity:'current'},operationWindow:{currentGeneration:()=>7}});
    try {
      const output=await projection.acquire();assert.equal(output.checkpoint,3);assert.deepEqual(output.frame,{sgvs:[]});
      enabled=false;await assert.rejects(projection.acquire(),/OUTPUT_CONTROL_PENDING/);enabled=true;
      completedVersion='0';await assert.rejects(projection.acquire(),/OUTPUT_CONTROL_PENDING/);completedVersion='1';
      identity='other';await assert.rejects(projection.acquire(),/OUTPUT_CONFIG_CHANGED/);identity='current';
      restore=6;await assert.rejects(projection.acquire(),/RESTORE_GENERATION/);
    } finally {scope.setTenancyMode(previous);}
  });
});

describe('post-bootstrap operational refresh activation', function () {
  it('does not repeat initial acquisition and retains verification completed during model boot', async function () {
    let timer, at=0, verifies=0, refreshes=0;
    const reader={health:()=>({available:true}),verify:async()=>{verifies++;}};
    const lifecycle=await require('../lib/trusted-worker/lifecycle')(reader,{intervalMs:100,now:()=>at,schedule:fn=>{timer=fn;return 1;},cancel(){}});
    try {
      const boot=lifecycle.version();timer();await settle();assert.equal(verifies,1);
      lifecycle.activateRefresh(async()=>{refreshes++;},10,boot);timer();await settle();
      assert.equal(refreshes,0,'INITIAL_MODEL_BOOT_MUST_NOT_REPEAT');
      at=11;timer();await settle();assert.equal(refreshes,1);
      await lifecycle.verify();timer();await settle();assert.equal(refreshes,2);
    } finally {await lifecycle.close();}
    const second=await require('../lib/trusted-worker/lifecycle')(reader,{schedule:fn=>{timer=fn;return 1;},cancel(){}});
    try {
      const boot=second.version();await second.verify();
      second.activateRefresh(async()=>{refreshes++;},100,boot);timer();await settle();
      assert.equal(refreshes,3,'VERIFICATION_DURING_BOOT_MUST_STILL_ADOPT');
      assert.throws(()=>second.activateRefresh(()=>{},100,boot),/already active/);
    } finally {await second.close();}
  });
});

// Source protocol only: actual window, notification store and readiness; SQL
// ports below simulate catalogues and do not establish native PostgreSQL proof.
describe('trusted consumer operational catalogue admission', function () {
  it('verifies catalogues while tenant operations refuse, and a changed catalogue keeps the whole batch closed', async function () {
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    const f=require('./fixtures/operation-window-runtime-protocol')({trustedWorker:true});
    const n=require('./fixtures/tenant-notifications')();
    const readiness=require('../lib/server/serve/evaluator-consumer-readiness');
    const migration=require('../migrations/candidates/postgres-alarm-suppression-v1.json').migrations[0];
    let operationalReads=0;
    const outbox={namespace:'notification_test',connection:{readOnly:async(text,values)=>{
      operationalReads++;
      await assert.rejects(f.window.run(A,()=>assert.fail('WITHDRAWN_TENANT_BODY')), {code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      return n.connection.transaction(()=>n.connection.query(text,values));
    }}};
    const alarm={namespace:'alarm_test',connection:{readOnly:async text=>{
      operationalReads++;
      if(text.includes('suppression-role'))return {rows:[{uses_schema:true}]};
      if(text.includes('suppression-shape'))return {rows:[{kind:'r',persistence:'p',secured:true,
        columns:[['tenant_id','uuid',true],['alarm_group','text',true],['alarm_level','integer',true],['acked_at','bigint',true],['expires_at','bigint',true]],
        primary_key:['tenant_id','alarm_group','alarm_level'],policies:[{command:'*',roles:[0],permissive:true,
          using:"tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid",check:"tenant_id = NULLIF(current_setting('app.current_tenant_id',true),'')::uuid"}]}]};
      return {rows:[{name:migration.name,checksum:migration.checksum}]};
    }}};
    const store=require('../lib/tenant-notifications/postgres')({connection:n.connection,namespace:'notification_test',maxRows:10,maxBytes:100000,assertOperational:()=>f.window.assertCurrent(A)});
    try {
      await f.window.ready();
      await f.window.verifyOperational(()=>readiness.operational(outbox,alarm));
      assert.ok(operationalReads>3);
      const before=n.calls.length;
      await scope.withTenant(A,()=>f.window.run(A,()=>store.ready(A)));
      assert.equal(n.calls.slice(before).filter(row=>row.sql?.includes('notification-readiness')).length,0,'NO_PER_INTENT_CATALOGUE_SCAN');
      await scope.withTenant(A,()=>assert.rejects(store.ready(A),{code:'LIFECYCLE_WINDOW_SCOPE_INVALID'}));
      n.unsafe({role:{elevated_membership:true}});
      await assert.rejects(f.window.verifyOperational(()=>readiness.operational(outbox,alarm)),/NOTIFICATION_SCHEMA_UNSAFE/);
      await assert.rejects(f.window.run(A,()=>assert.fail('UNSAFE_CATALOGUE_BODY')),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
      n.unsafe();await f.window.verifyOperational(()=>readiness.operational(outbox,alarm));
      await scope.withTenant(A,()=>f.window.run(A,()=>store.ready(A)));
    } finally {await f.window.close();scope.setTenancyMode(previous);}
  });
});
