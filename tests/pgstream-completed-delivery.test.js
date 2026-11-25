'use strict';
const assert = require('node:assert/strict');
const runtime = require('../lib/server/realtime/runtime');
const checkpoints = require('../lib/pgstream/checkpoint');
const completed = require('../lib/pgstream/realtime-output');
const scope = require('../lib/storage/tenant-scope');
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
describe('completed-output delivery reuse', function () {

  it('reads typed result-free delivery in one revision snapshot and reuses only validated retained output', async function () {
    const previous=scope.getTenancyMode();scope.setTenancyMode('multi');
    let digest,enabled=true,completedVersion='1',restore='7',identity='current',revision='3',physicalReads=0,metadataReads=0,snapshot,publishDuringRead=false;
    let body={tenant:A,inputCheckpoint:2,checkpoint:2,trigger:'input',result:{properties:{clinicalOnly:'must not transfer'}},rows:[],frame:{lastUpdated:100,sgvs:[{mgdl:100.5,mills:1234,extra:null}]}};
    const copy=value=>JSON.parse(JSON.stringify(value));
    const connection={async transaction(){throw new Error('WRITE_ONLY_CURSOR_MUST_NOT_RUN');},
      async readOnlyTransaction(fn){assert.equal(snapshot,undefined,'NO_NESTED_OR_UPGRADED_SNAPSHOT');snapshot={enabled,completedVersion,restore,identity,revision,body:copy(body)};try{return await fn();}finally{snapshot=undefined;}},
      async query(text,values){
        assert.equal(scope.currentTenant(),A);assert.equal(values[0],A);assert(snapshot,'METADATA_AND_PHYSICAL_MUST_SHARE_SNAPSHOT');
        if(text.includes(' AS output_summary')){
          metadataReads++;assert.match(text,/\(projection->0->'output'\)-'rows'-'frame'-'result'/,'COMPACT_SUMMARY_MUST_EXCLUDE_CLINICAL_RESULT');
          const summary=copy(snapshot.body);delete summary.rows;delete summary.frame;delete summary.result;
          if(publishDuringRead){publishDuringRead=false;revision='4';body.frame.lastUpdated=200;body.frame.sgvs[0].mgdl=101.5;}
          return {rows:[{output_read_isolation:'repeatable read',tenant:A,contract_digest:digest,work_version:2,work_observed:[null,null,null,null,'1',null],work_completed:[null,null,null,null,snapshot.completedVersion,null],work_enabled:snapshot.enabled,
            output_identity:snapshot.identity,output_digest:'a'.repeat(64),output_revision:snapshot.revision,output_restore_generation:snapshot.restore,output_summary:summary,frame_at:snapshot.body.frame.lastUpdated}]};
        }
        physicalReads++;assert.match(text,/SELECT \(projection->0->'output'\)-'result'-'rows' AS output/,'PHYSICAL_TRANSFER_MUST_EXCLUDE_CLINICAL_RESULT');
        const output=copy(snapshot.body);delete output.result;delete output.rows;return {rows:[{output}]};
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
});

describe('explicit post-bootstrap operational verification', function () {
  it('verifies once at startup, stays quiet after boot, and coalesces explicit recovery', async function () {
    let verifies=0, schedules=0, release;
    const reader={verify:async()=>{verifies++;if(release)await release.promise;}};
    const lifecycle=await require('../lib/trusted-worker/lifecycle')(reader,{
      schedule:()=>{schedules++;return 1;},cancel(){}
    });
    try {
      assert.equal(verifies,1,'STARTUP_MUST_VERIFY_ONCE');
      await settle();await settle();
      assert.equal(schedules,0,'POST_BOOT_MUST_NOT_ARM_PERIODIC_REFRESH');
      assert.equal(verifies,1,'INITIAL_MODEL_BOOT_MUST_NOT_REPEAT');
      let done;release={promise:new Promise(resolve=>{done=resolve;})};
      const first=lifecycle.verify(),second=lifecycle.verify();
      assert.equal(first,second,'CONCURRENT_RECOVERY_MUST_COALESCE');
      assert.equal(verifies,2,'ADDRESSED_RECOVERY_MUST_VERIFY');
      done();await first;release=null;
      await lifecycle.verify();assert.equal(verifies,3,'LATER_EXPLICIT_RECOVERY_MUST_VERIFY');
      assert.equal(schedules,0,'RECOVERY_MUST_NOT_ARM_PERIODIC_REFRESH');
    } finally {await lifecycle.close();}
    await assert.rejects(lifecycle.verify(),/lifecycle closed/);
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

});
