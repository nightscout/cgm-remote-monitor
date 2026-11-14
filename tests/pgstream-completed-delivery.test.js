'use strict';
const assert = require('node:assert/strict');
const runtime = require('../lib/server/realtime/runtime');
const checkpoints = require('../lib/pgstream/checkpoint');
const completed = require('../lib/pgstream/realtime-output');
const scope = require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
describe('completed-output delivery reuse', function () {
  it('coalesces unchanged output events and performs no watched-roster discovery',async function(){
    let stamp=1,reads=0,timers=0;
    const service=await runtime({tenants:[A,B],readCurrent:async tenant=>({tenant,identity:tenant}),watchedTenants:()=>[A],
      detect:async tenants=>new Map(tenants.map(tenant=>[tenant,{identity:tenant,stamp:tenant===A?stamp:1}])),
      create:current=>({acquire:async()=>{reads++;return {tenant:current.tenant,checkpoint:current.tenant===A?stamp:1,frame:{},rows:[]};}}),fanout:async()=>{},schedule:()=>{timers++;return 1;},cancel(){}});
    try{const baseline=reads;service.wake(A);await service.tick();assert.equal(reads,baseline);await service.fresh(A);assert.equal(reads,baseline+1);
      stamp++;await service.tick();assert.equal(reads,baseline+1,'NO_IMPLICIT_DISCOVERY');service.wake(A);await service.tick();assert.equal(service.last(A).checkpoint,2);assert.equal(service.last(B).checkpoint,1);assert.equal(timers,0,'WARM_WORKER_HAS_NO_TIMER');
    }finally{await service.close();}
  });
  it('durable receipts remove steady discovery and keep failed tenant delivery independent', async function () {
    let stamp=1,detects=0,reads=0,fail=false;
    const service=await runtime({tenants:[A,B],retryMs:1000,
      watchedTenants:()=>[A],readCurrent:async tenant=>({tenant,identity:tenant}),
      detect:async tenants=>{detects++;return new Map(tenants.map(tenant=>[tenant,{identity:tenant,stamp}]));},
      create:current=>({acquire:async()=>{if(fail&&current.tenant===A)throw Error('TENANT_A_OUTPUT_FAILURE');reads++;return {tenant:current.tenant,checkpoint:stamp,frame:{},rows:[]};}}),
      fanout:async()=>{},schedule:()=>1,cancel(){}});
    try{
      for(let i=0;i<10;i++)await service.tick();
      assert.equal(detects,0,'DURABLE_IDLE_MUST_NOT_DISCOVER');assert.equal(reads,2);
      stamp++;service.wake(A);await service.tick();assert.equal(reads,3,'ONE_ACTIVE_REVISION_ACQUISITION');
      fail=true;stamp++;const outcomes=await service.check([A,B]);
      assert.equal(outcomes.get(A),false,'FAILED_OUTPUT_MUST_NOT_ACK');assert.equal(outcomes.get(B),true,'OTHER_TENANT_PROGRESS');
      fail=false;const repaired=await service.check([A]);assert.equal(repaired.get(A),true);
    }finally{await service.close();}
  });

  it('retries only known cold work at its due time, including an epoch-zero test clock',async function(){
    let at=0,attempts=0,id=0;const timers=new Map();
    const service=await runtime({tenants:[A],readiness:'serve',now:()=>at,retryMs:25,failureRetryMs:100,
      readCurrent:async tenant=>({tenant,identity:tenant}),create:()=>({acquire:async()=>{attempts++;if(attempts===1)throw Error('COLD_OUTPUT_UNAVAILABLE');return {tenant:A,checkpoint:1,rows:[],frame:{}};}}),fanout:async()=>{},
      schedule:(fn,delay)=>{const key=++id;timers.set(key,{fn,delay});return key;},cancel:key=>timers.delete(key)});
    try{await settle();assert.equal(attempts,1);assert.equal(timers.get(1).delay,100);at=99;await service.tick();assert.equal(attempts,1,'KNOWN_RETRY_MUST_NOT_RUN_EARLY');
      at=100;const due=timers.get(1);timers.delete(1);await due.fn();assert.equal(attempts,2);assert.equal(service.warm(A),true);assert.equal(timers.size,0,'WARM_WORKER_MUST_DISARM_COLD_TIMER');
      at=100000;await service.tick();assert.equal(attempts,2);assert.equal(timers.size,0);
    }finally{await service.close();}
  });
  it('queues only an unwatched tenant requested after operational epoch change before any peer exists', async function () {
    let worker={available:true,generation:1},reads=new Map([[A,0],[B,0]]);
    const service=await runtime({tenants:[A,B],retryMs:1000,workerState:()=>worker,
      watchedTenants:()=>[],readCurrent:async tenant=>({tenant,identity:tenant}),
      detect:async tenants=>new Map(tenants.map(tenant=>[tenant,{identity:tenant,stamp:1}])),
      create:current=>({acquire:async()=>{reads.set(current.tenant,reads.get(current.tenant)+1);return {tenant:current.tenant,checkpoint:1,frame:{},rows:[]};}}),
      fanout:async()=>{},schedule:()=>1,cancel(){}});
    try {
      worker={available:false,generation:2};assert.equal(service.requestWarm(A),false);
      assert.equal(service.warm(A),false);assert.equal(service.last(A),null);
      worker={available:true,generation:2};await service.tick();
      assert.equal(service.warm(A),false,'UNWATCHED_OLD_EPOCH_REMAINS_UNAVAILABLE');
      assert.equal(service.requestWarm(A),false,'DEMAND_MUST_NOT_ACCEPT_STALE_MODEL');await service.tick();
      assert.equal(service.warm(A),true,'DEMAND_BEFORE_PEER_MUST_REACQUIRE_CURRENT_EPOCH');
      assert.equal(service.requestWarm(A),true);assert.equal(service.warm(B),false);
      assert.equal(reads.get(A),2);assert.equal(reads.get(B),1,'NO_ROSTER_REACQUISITION');
    } finally {await service.close();}
  });
  it('reads typed result-free delivery in one revision snapshot and reuses only validated retained output', async function () {
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    let digest,enabled=true,completedVersion='1',restore='7',identity='current',revision='3',physicalReads=0,metadataReads=0,snapshot,publishDuringRead=false;
    let body={tenant:A,inputCheckpoint:2,checkpoint:2,trigger:'input',result:{properties:{clinicalOnly:'must not transfer'}},rows:[],frame:{lastUpdated:100,sgvs:[{mgdl:100.5,mills:1234,extra:null}]}};
    const copy=value=>JSON.parse(JSON.stringify(value));
    const connection={async transaction(){throw new Error('WRITE_ONLY_CURSOR_MUST_NOT_RUN');},
      async snapshotTransaction(fn){assert.equal(snapshot,undefined,'NO_NESTED_OR_UPGRADED_SNAPSHOT');snapshot={enabled,completedVersion,restore,identity,revision,body:copy(body)};try{return await fn();}finally{snapshot=undefined;}},
      async query(text,values){
        assert.equal(scope.currentTenant(),A);assert.equal(values[0],A);assert(snapshot,'METADATA_AND_PHYSICAL_MUST_SHARE_SNAPSHOT');
        if(text.includes(' AS output_summary')){
          metadataReads++;assert.match(text,/\(projection->0->'output'\)-'rows'-'frame'-'result'/,'COMPACT_SUMMARY_MUST_EXCLUDE_CLINICAL_RESULT');
          const summary=copy(snapshot.body);delete summary.rows;delete summary.frame;delete summary.result;
          if(publishDuringRead){publishDuringRead=false;revision='4';body.frame.lastUpdated=200;body.frame.sgvs[0].mgdl=101.5;}
          return {rows:[{tenant:A,contract_digest:digest,work_version:2,work_observed:[null,null,null,null,'1',null],work_completed:[null,null,null,null,snapshot.completedVersion,null],work_enabled:snapshot.enabled,
            output_identity:snapshot.identity,output_digest:'a'.repeat(64),output_revision:snapshot.revision,output_restore_generation:snapshot.restore,output_summary:summary,frame_at:snapshot.body.frame.lastUpdated}]};
        }
        physicalReads++;assert.match(text,/SELECT \(projection->0->'output'\)-'result' AS output/,'PHYSICAL_TRANSFER_MUST_EXCLUDE_CLINICAL_RESULT');
        const output=copy(snapshot.body);delete output.result;return {rows:[{output}]};
      }};
    const config={consumer:'realtime-test',namespaces:{checkpoint:'rt_checkpoint'},completedOutput:{namespace:'test_completed',consumer:'evaluator-test'},maxBytes:100000,maxRows:1000};
    digest=checkpoints.create({connection,namespace:'test_completed',consumer:'evaluator-test',maxBytes:200000,timeIntervalMs:1000,typed:true}).digest;
    const projection=completed.projection({config,connection,current:{tenant:A,identity:'current'},operationWindow:{currentGeneration:()=>7}});
    try {
      const output=await projection.acquire();assert.equal(output.checkpoint,3);assert.deepEqual(output.frame,body.frame);assert.equal(physicalReads,1);
      assert.equal(await projection.acquire(),output,'UNCHANGED_REVISION_REUSES_ONE_DECODED_RESULT');assert.equal(physicalReads,1);
      output.frame.sgvs[0].mgdl=999;publishDuringRead=true;const repaired=await projection.acquire();assert.equal(repaired.checkpoint,3,'CONCURRENT_PUBLICATION_MUST_NOT_MIX_SNAPSHOT_REVISIONS');assert.equal(repaired.frame.sgvs[0].mgdl,100.5,'MUTATED_HINT_MUST_PHYSICALLY_RECOVER');assert.equal(physicalReads,2);
      const changed=await projection.acquire();assert.equal(changed.checkpoint,4);assert.equal(changed.frame.sgvs[0].mgdl,101.5);assert.equal(physicalReads,3);
      enabled=false;await assert.rejects(projection.acquire(),/OUTPUT_CONTROL_PENDING/);enabled=true;
      completedVersion='0';await assert.rejects(projection.acquire(),/OUTPUT_CONTROL_PENDING/);completedVersion='1';
      identity='other';await assert.rejects(projection.acquire(),/OUTPUT_CONFIG_CHANGED/);identity='current';
      restore='6';await assert.rejects(projection.acquire(),/RESTORE_GENERATION/);
      assert.equal(metadataReads,8,'EVERY_REUSE_RECHECKS_TYPED_CONTROL_AUTHORITY');
    } finally {scope.setTenancyMode(previous);}
  });
  it('invalidates lifecycle-only suspended idle sockets from authoritative typed work eligibility', async function () {
    const invalidated=[];
    const detector=completed.detector({config:{completedOutput:{namespace:'test_completed',consumer:'evaluator-test'}},
      connection:{readOnly:async text=>{assert.match(text,/output_revision::text AS revision,work_enabled/);return {rows:[{tenant:A,revision:'3',work_enabled:false},{tenant:B,revision:'3',work_enabled:true}]};}},
      trusted:{scan:async tenants=>new Map(tenants.map(tenant=>[tenant,{activity:{state:'active',paused:false,suspended:false}}]))},
      readAll:async tenants=>new Map(tenants.map(tenant=>[tenant,{identity:tenant}])),owner:()=>{},onIneligible:tenant=>invalidated.push(tenant)});
    const seen=await detector([A,B]);assert.deepEqual(invalidated,[A],'LIFECYCLE_REFUSAL_MUST_INVALIDATE_WITH_ACTIVITY_FLAG_STILL_FALSE');
    assert.deepEqual(seen.get(A),{identity:null,stamp:null});assert.deepEqual(seen.get(B),{identity:B,stamp:'3'});
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
  for (const operation of ['ready','consume']) it('awaits async admission before '+operation+' body and COMMIT', async function () {
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    const refusal=new Error('ASYNC_OPERATIONAL_ADMISSION_REFUSED');
    let commits=0,rollbacks=0,queries=0,bodies=0;
    const connection={async transaction(fn){try{const value=await fn();commits++;return value;}catch(error){rollbacks++;throw error;}},
      async query(){queries++;throw new Error('PRODUCER_SQL_BEFORE_ADMISSION');}};
    const reject=async()=>{await Promise.resolve();throw refusal;};
    // Observe the returned promise too, so the old unawaited implementation's
    // RED is the transaction assertion rather than an unhandled rejection.
    const assertOperational=()=>{const pending=reject();pending.catch(()=>{});return pending;};
    const store=require('../lib/tenant-notifications/postgres')({connection,namespace:'notification_test',maxRows:10,maxBytes:100000,assertOperational});
    try {
      await scope.withTenant(A,()=>assert.rejects(operation==='ready'?store.ready(A):store.consume({tenant:A,consumer:'test',transform:()=>{bodies++;throw new Error('PRODUCER_BODY_BEFORE_ADMISSION');}}),error=>error===refusal,'ASYNC_GUARD_MUST_REFUSE_BEFORE_TRANSACTION_BODY'));
      assert.equal(queries,0);assert.equal(bodies,0);assert.equal(commits,0);assert.equal(rollbacks,1);
    } finally {scope.setTenancyMode(previous);}
  });

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
