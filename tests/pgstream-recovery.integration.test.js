'use strict';
// Actual evaluator role and canonical maintained producer, two synthetic tenants.
// Does not exercise selected partition topology, cold API, or restore acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { optInSuite } = require('./support/opt-in');
const selectedStartup = process.env.NS_PGSTREAM_SELECTED_STARTUP_TEST === '1';
const enabled = process.env.NS_PGSTREAM_RECOVERY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI;
optInSuite(enabled, 'NS_PGSTREAM_RECOVERY_TEST=1 and owned disposable PostgreSQL plus canonical pgstream fixture inputs')(
  'actual role maintained-stream recovery fault points', function () {
    this.timeout(60000);
    const lab = require('./fixtures/evaluator-preview-registry-lab')();
    const startupConfiguration = () => selectedStartup ? lab.configureSelectedStartup() : lab.configure();
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());
    function identity(pid) {
      const stat = fs.readFileSync('/proc/'+pid+'/stat', 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
      return { pid, parent:Number(fields[1]), group:Number(fields[2]), session:Number(fields[3]), birth:fields[19], executable:fs.readlinkSync('/proc/'+pid+'/exe') };
    }
    async function wait(check, milliseconds, symptom) {
      const end = performance.now()+milliseconds;
      while (performance.now()<end) {
        const result = await check(); if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(symptom);
    }
    // These opening clinical rows were committed before the test slot existed.
    // Request the first snapshot; restarted workers recover their own durable work.
    async function startExisting(config, options, tenants = [lab.A]) {
      const worker = await lab.worker(config, options);
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      for (const tenant of tenants) await worker.call('acquire', tenant);
      return worker;
    }
    async function firstUsefulOutput(worker, expected) {
      if (!selectedStartup) return;
      const started=performance.now();let observation;
      assert.equal((await worker.call('health')).startup.warmOnStart,false,'SELECTED_ROLE_MUST_START_ON_DEMAND');
      try { await wait(async()=>{
        const health=await worker.call('health'),tenants=[];
        for(const wanted of expected){
          const resident=await worker.call('last',wanted.tenant),progress=health.tenants.find(row=>row.tenant===wanted.tenant)?.progress;
          const input=await lab.checkpoint(lab.consumerName,wanted.tenant),accepted=input.projection?.[0];
          const physical=(await lab.physical(wanted.tenant)).tables.entries.some(row=>row.doc._id===wanted.id&&row.doc.sgv===wanted.value);
          const durable=await lab.previewCompleted(wanted.tenant),work=await state(wanted.tenant);
          const predicates={eligible:resident?.eligible===true,currentProcessAcquisition:progress?.completedAcquisitions>0,physicalSeed:physical,
            acceptedPosition:!!accepted?.stream?.accepted_position,
            residentFrame:!!resident?.frame?.sgvs?.some(row=>row._id===wanted.id&&row.mgdl===wanted.value),
            durableFrame:!!durable.projection?.[0]?.output?.frame?.sgvs?.some(row=>row._id===wanted.id&&row.mgdl===wanted.value),
            noPending:work.work_pending_at===null,acceptedFloor:completed(durable,String(accepted?.floor||'0')),
            observedCovered:Array.isArray(work.work_observed)&&Array.isArray(work.work_completed)&&work.work_observed.every((value,i)=>value===null||floor(work.work_completed[i])>=floor(value))};
          tenants.push({wanted,predicates,progress,accepted,work,resident,durable});
        }
        observation={tenants,health};
        return tenants.every(row=>Object.values(row.predicates).every(Boolean));
      },10000,'SELECTED_ROLE_FIRST_USEFUL_OUTPUT'); }
      catch(error){lab.tracePreview('selected-role-first-useful-output-refused',observation||{});throw error;}
      lab.tracePreview('selected-role-first-useful-output',{elapsedMs:performance.now()-started,readiness:'serve',tenants:expected.map(row=>row.tenant),scope:'specified useful clinical obligations completed by this process; independent physical seed and matching resident/durable clinical frame; no whole-roster warm requirement'});
    }
    async function write(value, id='synthetic-recovery', age=1000) {
      const at = Date.now();
      return lab.persistDomains({ entries:[{ _id:id, type:'sgv', sgv:value, date:at-age, dateString:new Date(at-age).toISOString(), direction:'Flat' }] });
    }
    async function state(tenant=lab.A) {
      const table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint';
      const rows=(await lab.admin.query('SELECT work_observed,work_completed,work_pending_at,work_due_at::text AS due_at,work_completed_at::text AS completed_at FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,lab.consumerName+'-completed'])).rows;
      assert.equal(rows.length,1,'ONE_DURABLE_WORK_ROW');
      return {...rows[0],observed:require('../lib/pgstream/work-state').map(rows[0].work_observed),completed:require('../lib/pgstream/work-state').map(rows[0].work_completed)};
    }
    async function inputBookend() {
      const rows=[];for(const tenant of [lab.A,lab.B])rows.push({tenant,clock:await lab.clock(tenant),tables:(await lab.physical(tenant)).tables});
      return rows;
    }
    async function killWorker(worker) {
      assert.equal(worker.child.exitCode,null);assert.equal(worker.child.signalCode,null);
      const current=identity(worker.child.pid);
      assert.equal(current.birth,worker.birth,'OWNED_ROLE_BIRTH_BEFORE_KILL');
      assert.equal(current.group,worker.processGroup,'OWNED_ROLE_GROUP_BEFORE_KILL');
      assert.equal(current.group,worker.child.pid);assert.equal(current.session,worker.child.pid);
      const exited=new Promise(resolve=>worker.child.once('exit',(code,signal)=>resolve({code,signal})));
      process.kill(-worker.processGroup,'SIGKILL');const result=await exited;
      assert.equal(result.signal,'SIGKILL');await lab.stopStream();return result;
    }
    const floor = value => BigInt(value || '0');
    async function acceptedValue(value, id='synthetic-recovery', tenant=lab.A) {
      return wait(async()=>{
        const saved=await lab.checkpoint(lab.consumerName,tenant),input=saved.projection?.[0];
        const event=saved.projection?.[1]?.events.find(row=>row.domain==='entries'&&row.value.doc?.identifier===id&&row.value.doc.sgv===value);
        return input?.stream?.accepted_position&&event?String(input.floor):null;
      },10000,'NATIVE_COHORT_INPUT_NOT_DURABLY_ACCEPTED');
    }
    async function holdNext(worker,value) {
      const nonce=require('node:crypto').randomUUID(),holding=worker.held();
      await worker.call('arm',lab.A,{hold:{nonce,expected:{id:'synthetic-recovery',value}}});
      await write(value);
      let timer;
      const signal=await Promise.race([holding,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('ACTUAL_CLINICAL_CYCLE_MUST_REACH_HOLD')),5000);})]).finally(()=>clearTimeout(timer));
      assert.equal(signal.tenant,lab.A,'HOLD_MUST_NAME_THE_SELECTED_TENANT');assert.equal(signal.nonce,nonce,'HOLD_MUST_NAME_THE_CURRENT_ARM');
      assert.deepEqual(signal.reading,{id:'synthetic-recovery',value},'HOLD_MUST_COVER_THE_REQUESTED_INPUT');
      const accepted=await acceptedValue(value),held=await state();
      assert(floor(signal.checkpoint)>=floor(accepted),'HELD_RESULT_MUST_COVER_ACCEPTED_INPUT');
      assert(floor(held.observed.bootstrap)>=floor(accepted),'RECEIPT_DURABLE_BEFORE_CLINICAL_HOLD');
      assert(floor(held.completed.bootstrap)<floor(accepted),'HELD_CYCLE_MUST_NOT_COMPLETE');
      lab.tracePreview('actual-clinical-hold',{nonce,tenant:signal.tenant,checkpoint:signal.checkpoint,accepted,reading:signal.reading});
      return accepted;
    }
    function completed(row, accepted) {
      return row && floor(require('../lib/pgstream/work-state').map(row.work_completed).bootstrap) >= floor(accepted);
    }
    it('reads warm accepted input without waiting for a concurrent receipt writer; old lock is a real native red',async()=>{
      await write(117);await lab.provisionPreview();
      const originalEnvironment=lab.extraEnvironment;lab.extraEnvironment={...(originalEnvironment||{})};
      const original=lab.extraEnvironment.NS_EVALUATOR_FIXTURE_WARM_LOCK_MUTANT;
      async function criterion(mutant){
        if(mutant)lab.extraEnvironment.NS_EVALUATOR_FIXTURE_WARM_LOCK_MUTANT='1';else delete lab.extraEnvironment.NS_EVALUATOR_FIXTURE_WARM_LOCK_MUTANT;
        const worker=await startExisting(lab.configure());let pending,finished=false,result;
        try{
          assert.equal(worker.startup.bootError,undefined);
          await lab.wait(async()=>!!(await worker.call('last',lab.A)));
          await lab.admin.query('BEGIN');
          await lab.admin.query('UPDATE "'+lab.replayNamespace+'".tenant_consumer_checkpoint SET projection=projection WHERE tenant_id=$1 AND consumer=$2',[lab.A,lab.consumerName]);
          pending=worker.call('acquire',lab.A).then(value=>{result=value;finished=true;});
          // Observe the owned checkpoint relation and lock, independent of selected return columns.
          const prefix='SELECT checkpoint, contract_digest, % FROM "'+lab.replayNamespace+'".';
          const observation=await wait(async()=>{
            if(finished)return {finished:true,blocked:false};
            await lab.admin.query('SELECT pg_stat_clear_snapshot()');
            const blocked=(await lab.admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1) AS blocked",[prefix+'%FOR UPDATE%'])).rows[0].blocked;
            return blocked?{finished,blocked}:false;
          },5000,'WARM_RECEIPT_LOCK_OBSERVATION_WATCHDOG');
          lab.tracePreview('warm-accepted-input-held-receipt-writer',{mutant,...observation});
          assert.equal(finished,true,'WARM_INPUT_READ_BLOCKED_BY_CDC_RECEIPT');
          assert.equal(result.eligible,true);assert.equal(result.frame.sgvs[0].mgdl,117);
        }finally{
          // Commit creates the old RR lock's actual serialization refusal;
          // the restored read already completed before this writer is released.
          await lab.admin.query('COMMIT');await pending;await lab.stopWorker(worker);
          if(original===undefined)delete lab.extraEnvironment.NS_EVALUATOR_FIXTURE_WARM_LOCK_MUTANT;else lab.extraEnvironment.NS_EVALUATOR_FIXTURE_WARM_LOCK_MUTANT=original;
        }
      }
      try{await assert.rejects(criterion(true),/WARM_INPUT_READ_BLOCKED_BY_CDC_RECEIPT/);await criterion(false);}
      finally{lab.extraEnvironment=originalEnvironment;}
    });

    it('control: an actual warm source reacquisition turns the source-access witness red',async()=>{
      await write(117);await lab.provisionPreview();const prior=lab.extraEnvironment;lab.extraEnvironment={...(prior||{})};
      const criterion=async mutant=>{
        if(mutant)lab.extraEnvironment.NS_EVALUATOR_FIXTURE_WARM_SOURCE_MUTANT='1';else delete lab.extraEnvironment.NS_EVALUATOR_FIXTURE_WARM_SOURCE_MUTANT;
        const worker=await startExisting(lab.configure());
        try{assert.equal(worker.startup.bootError,undefined);await lab.wait(async()=>!!(await worker.call('last',lab.A)));
          const before=await worker.call('queries');await worker.call('acquire',lab.A);const after=await worker.call('queries');
          for(const key of ['snapshots','catalogue','exports','imports'])assert.equal(after[key],before[key],'WARM_SOURCE_REACQUISITION_'+key);
        }finally{await lab.stopWorker(worker);}
      };
      try{await assert.rejects(criterion(true),/WARM_SOURCE_REACQUISITION/);await criterion(false);}finally{lab.extraEnvironment=prior;}
    });
    it('materializes actual default clinical cohorts, corrections and deletion without warm clinical snapshot or catalogue rediscovery',async function(){
      await write(110);const config=lab.configure(),worker=await startExisting(config, {detached:true});assert.equal(worker.startup.ready,true,JSON.stringify(worker.startup));
      try{
        const initial=await worker.call('queries');assert(initial.snapshots>0&&initial.exports>0&&initial.imports>0,'EXACT_NATIVE_BOOTSTRAP_REQUIRED');
        const at=Date.now(),late=at-300000;
        await lab.persistDomains({entries:[{_id:'cohort-one',type:'sgv',sgv:141,date:late,dateString:new Date(late).toISOString(),extension:{synthetic:'preserved'}},
          {_id:'cohort-two',type:'sgv',sgv:142,date:at,dateString:new Date(at).toISOString()}]});
        const cohort=await acceptedValue(142,'cohort-two');
        const output=await wait(async()=>{const row=await lab.previewCompleted();return completed(row,cohort)?row:null;},10000,'DEFAULT_ROW_COHORT_NOT_COMPLETED');
        // Raw clinical rows belong to the accepted input; durable output carries
        // the actual engine frame rather than another copy of that projection.
        const accepted=await lab.checkpoint(lab.consumerName),rows=accepted.projection[1].events;
        assert.equal(accepted.projection[0].rows,undefined,'CLINICAL_INPUT_IS_NOT_PERSISTED');
        const frame=output.projection[0].output.frame;
        assert(frame.sgvs.some(row=>row._id==='cohort-one'&&row.mgdl===141),'COHORT_ENGINE_FRAME_MISSING');
        assert(frame.sgvs.some(row=>row._id==='cohort-two'&&row.mgdl===142),'COHORT_PARTIAL_ENGINE_FRAME');
        assert(rows.some(row=>row.value.doc?.identifier==='cohort-one'&&row.value.doc.extension.synthetic==='preserved'),'EXTENSION_ROW_MISSING');
        assert(rows.some(row=>row.value.doc?.identifier==='cohort-two'),'COHORT_PARTIAL_OUTPUT');
        await write(151,'cohort-one',600000);const corrected=await acceptedValue(151,'cohort-one');
        await wait(async()=>completed(await lab.previewCompleted(),corrected),10000,'LATE_CORRECTION_NOT_COMPLETED');
        assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='cohort-one').mgdl,151,'CORRECTED_ENGINE_FRAME');
        const publicClock=await lab.clock();
        await lab.hardDelete('entries',{_id:'cohort-two'});
        assert.deepEqual(await lab.clock(),publicClock,'NATIVE_DELETE_PUBLIC_HISTORY_UNCHANGED');
        const removed=await wait(async()=>{const saved=await lab.checkpoint(lab.consumerName),input=saved.projection?.[0];return input?.stream?.accepted_position&&floor(input.floor)>floor(corrected)&&saved.projection[1].events.some(row=>row.event==='delete'&&row.value.identifier==='cohort-two')?String(input.floor):null;},10000,'DELETE_NOT_DURABLY_ACCEPTED');
        await wait(async()=>completed(await lab.previewCompleted(),removed),10000,'DELETE_COHORT_NOT_COMPLETED');
        assert(!(await lab.previewCompleted()).projection[0].output.frame.sgvs.some(row=>row._id==='cohort-two'),'DELETED_ENGINE_FRAME_RETAINED');
        const after=await worker.call('queries');
        // Authoritative whole-history accounting is independent of the bounded
        // clinical input. A source write may refresh it; warm clinical rows and
        // their catalogue must still come from the accepted stream.
        assert.deepEqual({snapshots:after.snapshots,catalogue:after.catalogue,exports:after.exports,imports:after.imports},{snapshots:initial.snapshots,catalogue:initial.catalogue,exports:initial.exports,imports:initial.imports},'WARM_CLINICAL_SNAPSHOT_REDISCOVERY');
        lab.tracePreview('default-streamed-cohort-correction-delete',{initial,after,cohort,corrected,removed,scope:'actual default evaluator and maintained CDC; bootstrap allowed, warm clinical source snapshot/catalogue reads forbidden; authoritative whole-history accounting may refresh after writes'});
      }finally{await lab.stopWorker(worker);}
    });
    it('accepts and completes unstamped activity after an actual stopped-feed red control without changing public history',async function(){
      await write(110);
      const config=lab.configure(),worker=await startExisting(config, {detached:true});
      assert.equal(worker.startup.ready,true,JSON.stringify(worker.startup));
      const id='native-unstamped-activity',publicClock=await lab.clock();
      const raw=async steps=>{
        const input=await lab.checkpoint(lab.consumerName),state=input.projection?.[0];
        return input.projection?.[1]?.events.some(event=>event.domain==='activity'&&event.value.doc?.identifier===id&&event.value.doc.steps===steps)
          ? {input,state}:null;
      };
      try{
        await lab.writeCanonical({logical:'activity',planned:{op:'create',docs:[{_id:id,steps:1,created_at:new Date().toISOString()}]}});
        const created=await wait(()=>raw(1),10000,'UNSTAMPED_ACTIVITY_CREATE_NOT_ACCEPTED');
        await wait(async()=>completed(await lab.previewCompleted(),created.state.floor),10000,'UNSTAMPED_ACTIVITY_CREATE_NOT_COMPLETED');
        const before=await lab.previewCompleted(),foreign=await lab.previewCompleted(lab.B);
        await lab.stopStream();
        await lab.writeCanonical({logical:'activity',planned:{op:'update',form:'merge',target:{_id:id},fields:{steps:2}}});
        const physical=(await lab.physical()).tables.activity;
        assert.equal(physical.find(row=>row.doc._id===id)?.doc.steps,2,'UNSTAMPED_ACTIVITY_ACTUAL_UPDATE_COMMITTED');
        assert.equal(Object.hasOwn(physical.find(row=>row.doc._id===id).doc,'srvModified'),false,'UNSTAMPED_ACTIVITY_HAS_NO_HISTORY_STAMP');
        // The missing event is measured before a restart, without a sleep or
        // timeout: a stopped producer cannot have accepted this committed row.
        await assert.rejects(async()=>assert(await raw(2),'UNSTAMPED_ACTIVITY_NATIVE_EVENT_REQUIRED'),/UNSTAMPED_ACTIVITY_NATIVE_EVENT_REQUIRED/);
        assert.equal((await lab.checkpoint(lab.consumerName)).checkpoint,created.input.checkpoint,'STOPPED_FEED_NO_FABRICATED_INPUT_COVERAGE');
        assert.deepEqual((await lab.previewCompleted()).work_completed,before.work_completed,'STOPPED_FEED_NO_FALSE_CLINICAL_COMPLETION');
        await lab.startStream();
        const updated=await wait(()=>raw(2),10000,'UNSTAMPED_ACTIVITY_UPDATE_NOT_ACCEPTED');
        assert(floor(updated.state.floor)>floor(created.state.floor),'UNSTAMPED_ACTIVITY_NATIVE_POSITION_ADVANCED');
        await wait(async()=>completed(await lab.previewCompleted(),updated.state.floor),10000,'UNSTAMPED_ACTIVITY_UPDATE_NOT_COMPLETED');
        const after=await lab.previewCompleted();
        assert.deepEqual(await lab.clock(),publicClock,'UNSTAMPED_ACTIVITY_PUBLIC_HISTORY_UNCHANGED');
        assert.equal(after.output_revision,before.output_revision,'UNCHANGED_CLINICAL_CONTENT_KEEPS_REVISION');
        assert.deepEqual(after.projection,before.projection,'UNCHANGED_CLINICAL_CONTENT_KEEPS_PAYLOAD');
        assert.deepEqual(await lab.previewCompleted(lab.B),foreign,'UNSTAMPED_ACTIVITY_FOREIGN_TENANT_UNCHANGED');
        assert.equal(updated.state.rows,undefined,'UNSTAMPED_ACTIVITY_INPUT_NOT_PERSISTED');
        lab.tracePreview('native-unstamped-activity-red-restored',{publicClock,created:created.state,updated:updated.state,completed:after.work_completed,revision:after.output_revision,control:'stopped producer leaves committed activity update unaccepted; explicit restart accepts and completes without public history change'});
      }finally{await lab.stopWorker(worker);}
    });
    it('lets an unrelated tenant complete newly arriving input while the first tenant is held',async function(){
      await write(110);const at=Date.now();
      await lab.persistDomains({entries:[{_id:'neighbor',type:'sgv',sgv:210,date:at,dateString:new Date(at).toISOString()}]},lab.B);
      const config=await startupConfiguration(),worker=await startExisting(config, {detached:true}, [lab.A, lab.B]);assert.equal(worker.startup.ready,true,JSON.stringify(worker.startup));
      await firstUsefulOutput(worker,[{tenant:lab.A,id:'synthetic-recovery',value:110},{tenant:lab.B,id:'neighbor',value:210}]);
      try{
        const held=await holdNext(worker,131);
        const newer=Date.now();await lab.persistDomains({entries:[{_id:'neighbor',type:'sgv',sgv:241,date:newer,dateString:new Date(newer).toISOString()}]},lab.B);
        const stamp=await acceptedValue(241,'neighbor',lab.B);
        const output=await wait(async()=>{const row=await lab.previewCompleted(lab.B);return completed(row,stamp)?row:null;},5000,'IDLE_SLOT_MUST_COMPLETE_NEIGHBOR_BEFORE_HELD_TENANT_RELEASE');
        assert.equal(output.projection[0].output.frame.sgvs.find(row=>row._id==='neighbor').mgdl,241);
        assert(floor((await state()).completed.bootstrap)<floor(held),'HELD_TENANT_MUST_REMAIN_UNFINISHED');
        await worker.call('release');await wait(async()=>floor((await state()).completed.bootstrap)>=floor(held),5000,'HELD_TENANT_MUST_RESUME');
        lab.tracePreview('default-held-tenant-neighbor-progress',{held,neighbor:stamp,scope:'actual default role/CDC with one held clinical completion and an independently completed tenant'});
      }finally{await worker.call('release');await lab.stopWorker(worker);}
    });
    it('keeps the same evaluator alive without synthetic idle-feed expiry and catches up durable output after external restart',async function(){
      await write(110);const config=lab.configure(),worker=await startExisting(config, {detached:true});assert.equal(worker.startup.ready,true,JSON.stringify(worker.startup));
      const evaluator=identity(worker.child.pid),producer=lab.stream(),original=producer.identity(),originalStarts=producer.state().starts,before=await lab.previewCompleted();assert(original,'INDEPENDENT_PRODUCER_RUNNING');assert.notEqual(original.group,evaluator.group,'PRODUCER_NOT_IN_EVALUATOR_GROUP');
      const beforeWork=await state(),began=performance.now();await lab.stopStream();assert.equal(producer.state().running,false);
      await write(149);
      // The application no longer synthesizes feed liveness. Stopping an idle
      // producer does not revoke source admission or the evaluator owner. Real
      // undelivered input remains behind the durable observed/completed floor.
      const stoppedHealth=(await worker.call('health')).pgstream;
      assert.equal(stoppedHealth.healthy,true,'IDLE_FEED_STOP_MUST_NOT_FABRICATE_ADMISSION_FAILURE');
      assert.equal(stoppedHealth.owner,true,'ACTUAL_EVALUATOR_OWNER_REMAINS_HELD');
      for(const field of ['heartbeatAgeMs','monotonicHeartbeatAgeMs','sequence','received','pulses','receipts','probes'])assert.equal(Object.hasOwn(stoppedHealth,field),false,'NO_SYNTHETIC_FEED_LIVENESS_'+field);
      const stoppedWork=await state();
      assert.deepEqual(stoppedWork.observed,beforeWork.observed,'STOPPED_FEED_MUST_NOT_FABRICATE_DURABLE_OBSERVATION');
      assert.deepEqual(stoppedWork.completed,beforeWork.completed,'UNDELIVERED_INPUT_MUST_NOT_BE_MARKED_COMPLETED');
      assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,110,'UNDELIVERED_CORRECTION_MUST_NOT_APPEAR');
      assert.deepEqual(identity(worker.child.pid),evaluator,'SAME_EVALUATOR_SURVIVES_STREAM_OUTAGE');
      assert.equal(producer.state().starts,originalStarts,'NO_FIXTURE_AUTOMATIC_RESTART');
      await lab.startStream();assert.notEqual(producer.identity().pid,original.pid,'EXPLICIT_EXTERNAL_PRODUCER_REPLACEMENT');
      const stamp=await acceptedValue(149);
      const recovered=await wait(async()=>{const health=(await worker.call('health')).pgstream,output=await lab.previewCompleted();return health.healthy&&completed(output,stamp)&&BigInt(output.output_revision)>BigInt(before.output_revision)?{health,output}:null;},config.document.pgstream.bounds.recoveryMs,'EXTERNAL_STREAM_MUST_RECOVER_COMMITTED_OUTPUT');
      assert.equal(recovered.output.projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,149,'EXACT_COMMITTED_FRAME_AFTER_STREAM_RESUME');assert.deepEqual(identity(worker.child.pid),evaluator);
      lab.tracePreview('independent-stream-fixture-stop-and-resume',{elapsedMs:performance.now()-began,evaluator,producerBefore:original,producerAfter:producer.identity(),stoppedHealth,stoppedWork,recoveredHealth:recovered.health,completed:recovered.output.work_completed,scope:'Fixture-controlled external restart and durable catchup; silent idle-feed detection and platform restart-policy qualification are not claimed'});
      await lab.stopWorker(worker);
    });
    it('retains a newer observation across held completion and recovers pending clinical work after actual role process-group death',async function(){
      await write(110);const config=await startupConfiguration(),worker=await startExisting(config, {detached:true});assert.equal(worker.startup.ready,true,JSON.stringify(worker.startup));
      await firstUsefulOutput(worker,[{tenant:lab.A,id:'synthetic-recovery',value:110}]);
      await holdNext(worker,130);await write(149);const newer=await acceptedValue(149);
      await wait(async()=>floor((await state()).observed.bootstrap)>=floor(newer),5000,'NEWER_RECEIPT_MUST_COMMIT_WHILE_OLDER_CYCLE_HELD');
      await worker.call('release');
      await wait(async()=>floor((await state()).completed.bootstrap)>=floor(newer),10000,'NEWER_GENERATION_MUST_REMAIN_PENDING_UNTIL_COMPLETED');
      assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,149);
      const pending=await holdNext(worker,171),held=await state(),clockBefore=(await lab.clock()).stamp,inputBefore=await inputBookend();
      assert(Number(held.work_pending_at)>0,'PENDING_AGE_ORIGIN_MUST_BE_DURABLE');
      const pendingAgeBeforeDeathMs=Date.now()-Number(held.work_pending_at);assert(pendingAgeBeforeDeathMs>=0);
      const death=await killWorker(worker);
      const next=await lab.worker(config,{detached:true});assert.equal(next.startup.ready,true,'RESTARTED_ACTUAL_ROLE_READY');
      await wait(async()=>floor((await state()).completed.bootstrap)>=floor(pending),10000,'PROCESS_LOSS_MUST_RECOVER_DURABLE_PENDING');
      await firstUsefulOutput(next,[{tenant:lab.A,id:'synthetic-recovery',value:171}]);
      const recovered=await lab.previewCompleted();assert.equal(recovered.projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,171);
      assert.equal((await lab.clock()).stamp,clockBefore,'RESTART_RECOVERY_NEEDS_NO_INPUT_WRITE');
      const inputAfter=await inputBookend();assert.deepEqual(inputAfter,inputBefore,'PENDING_RESTART_PHYSICAL_INPUT_AND_CLOCK_BOOKENDS_UNCHANGED');
      const recoveredState=await state();assert.equal(recoveredState.work_pending_at,null);
      const acceptedPendingToCompletedMs=Number(recoveredState.completed_at)-Number(held.work_pending_at);assert(acceptedPendingToCompletedMs>=pendingAgeBeforeDeathMs);
      if(selectedStartup)assert.equal((await next.call('health')).startup.warmOnStart,false,'SELECTED_RESTART_MUST_KEEP_LAZY_TENANT_STARTUP');
      lab.tracePreview('actual-role-held-generation-and-pending-crash-recovery',{selectedStartup,death,held,newer,pending,pendingAgeBeforeDeathMs,acceptedPendingToCompletedMs,inputBefore,inputAfter,recoveredCompleted:recovered.work_completed});
      await lab.stopWorker(next);
    });
    it('preserves completed output across process death and fires recovered future clinical due work without a new input write',async function(){
      await lab.setSettings({enable:['bgnow','delta','direction','simplealarms']});
      await write(50,'synthetic-recovery',600000-15000);
      const config=await startupConfiguration(),worker=await startExisting(config, {detached:true});assert.equal(worker.startup.ready,true,JSON.stringify(worker.startup));
      await firstUsefulOutput(worker,[{tenant:lab.A,id:'synthetic-recovery',value:50}]);
      const before=await state(),outputBefore=await lab.previewCompleted(),clockBefore=(await lab.clock()).stamp,inputBefore=await inputBookend();
      const remainingAtKillMs=Number(before.due_at)-Date.now();
      assert(remainingAtKillMs>2000,'FUTURE_DUE_RESTART_FIXTURE_NEEDS_TWO_SECONDS_BUDGET');
      assert(Number(before.due_at)-Date.now()<20000,'BOUNDED_SYNTHETIC_DUE_REQUIRED');
      const death=await killWorker(worker),next=await lab.worker(config,{detached:true});assert.equal(next.startup.ready,true);
      // A selected lazy role may keep this idle tenant cold until its durable
      // deadline. Preserve output now; require this process's useful clinical
      // completion when that original deadline is reached.
      const resumed=await state(),outputResumed=await lab.previewCompleted();
      const dueAlreadyFired=Number(resumed.completed_at)>=Number(before.due_at)&&Number(outputResumed.projection[0].output.result.now)>=Number(before.due_at);
      if(Number(outputResumed.projection[0].output.result.now)<Number(before.due_at))assert.equal(outputResumed.output_revision,outputBefore.output_revision,'PRE_DUE_COMMITTED_CONTENT_MUST_NOT_DUPLICATE_REVISION_AFTER_DEATH');
      assert(floor(require('../lib/pgstream/work-state').map(outputResumed.work_completed).bootstrap)>=floor(require('../lib/pgstream/work-state').map(outputBefore.work_completed).bootstrap),'REBOOTSTRAP_COMPLETION_MUST_COVER_PRIOR_WORK');
      if(!dueAlreadyFired)await wait(async()=>{const current=await state(),output=await lab.previewCompleted();return Number(current.completed_at)>=Number(before.due_at)&&Number(output.projection[0].output.result.now)>=Number(before.due_at);},25000,'RESTARTED_DUE_MUST_FIRE_WITHOUT_INPUT');
      await firstUsefulOutput(next,[{tenant:lab.A,id:'synthetic-recovery',value:50}]);
      const after=await state(),outputAfter=await lab.previewCompleted();
      assert.equal((await lab.clock()).stamp,clockBefore,'TIME_WORK_MUST_NOT_REQUIRE_OR_CREATE_INPUT_WRITE');
      assert(Number(outputAfter.projection[0].output.result.now)>=Number(before.due_at),'ACTUAL_DUE_CLINICAL_COMPLETION_REQUIRED');
      const {bootstrap:resumedBootstrap,...resumedVersions}=resumed.observed,{bootstrap:afterBootstrap,...afterVersions}=after.observed;
      assert.deepEqual(afterVersions,resumedVersions,'DUE_RECOVERY_DOES_NOT_INVENT_METADATA_INPUT_COVERAGE');
      const acceptedAfter=(await lab.checkpoint(lab.consumerName)).projection[0];
      assert.equal(floor(afterBootstrap),floor(acceptedAfter.floor),'COLD_DUE_COMPLETION_COVERS_ACTUAL_ACCEPTED_BOOTSTRAP');
      assert(floor(afterBootstrap)>=floor(resumedBootstrap),'DUE_RECOVERY_MUST_NOT_REGRESS_ACCEPTED_COVERAGE');
      assert.equal(after.work_pending_at,null);
      const inputAfter=await inputBookend();assert.deepEqual(inputAfter,inputBefore,'DUE_RESTART_PHYSICAL_INPUT_AND_CLOCK_BOOKENDS_UNCHANGED');
      lab.tracePreview('actual-role-completed-output-and-future-due-recovery',{selectedStartup,death,before,resumed,after,clockBefore,remainingAtKillMs,dueAlreadyFired,resumedBootstrap,afterBootstrap,inputBefore,inputAfter,outputRevision:outputAfter.output_revision});
      await lab.stopWorker(next);
    });
    (selectedStartup ? it : it.skip)('selected startup refuses a held completion after actual lifecycle generation advance and keeps a healthy neighbor progressing',async function(){
      await write(110);const now=Date.now();await lab.persistDomains({entries:[{_id:'generation-neighbor',type:'sgv',sgv:210,date:now,dateString:new Date(now).toISOString()}]},lab.B);
      const config=await startupConfiguration(),worker=await startExisting(config, {detached:true}, [lab.A, lab.B]);assert.equal(worker.startup.ready,true);
      const table='"'+lab.registryNamespaces.control+'".tenant_lifecycle_windows';let advanced=false;
      await firstUsefulOutput(worker,[{tenant:lab.A,id:'synthetic-recovery',value:110},{tenant:lab.B,id:'generation-neighbor',value:210}]);
      try {
        const target=await holdNext(worker,181),before=await lab.previewCompleted(),failedBefore=(await worker.call('health')).tenants.find(row=>row.tenant===lab.A).progress.failedCompletions,generation=(await lab.admin.query('SELECT generation::text AS value FROM '+table+' WHERE tenant_id=$1',[lab.A])).rows[0].value;
        await lab.admin.query('UPDATE '+table+" SET phase='suspended',generation=generation+1,claim_id=$2,artifact_digest=$3 WHERE tenant_id=$1",[lab.A,require('node:crypto').randomUUID(),'a'.repeat(64)]);advanced=true;
        const advancedState=(await lab.admin.query('SELECT phase,generation::text AS generation FROM '+table+' WHERE tenant_id=$1',[lab.A])).rows[0];assert.equal(advancedState.phase,'suspended');assert.equal(BigInt(advancedState.generation),BigInt(generation)+1n);
        await worker.call('release');
        await wait(async()=>{const row=(await worker.call('health')).tenants.find(row=>row.tenant===lab.A);return row.progress.failedCompletions>failedBefore;},5000,'STALE_GENERATION_COMPLETION_MUST_BE_REFUSED');
        const refused=await state(),output=await lab.previewCompleted();assert(floor(refused.completed.bootstrap)<floor(target),'OLD_GENERATION_INPUT_MUST_NOT_BE_CERTIFIED');assert.equal(output.output_revision,before.output_revision,'OLD_GENERATION_MUST_NOT_PUBLISH_NEW_OUTPUT');
        const at=Date.now();await lab.persistDomains({entries:[{_id:'generation-neighbor',type:'sgv',sgv:241,date:at,dateString:new Date(at).toISOString()}]},lab.B);const neighbor=await acceptedValue(241,'generation-neighbor',lab.B);
        await wait(async()=>completed(await lab.previewCompleted(lab.B),neighbor),10000,'SUSPENDED_NEIGHBOR_MUST_NOT_BLOCK_HEALTHY_TENANT');
        lab.tracePreview('selected-lazy-generation-refusal-neighbor',{generation,advancedState,failedBefore,target,neighbor,refusedCompleted:refused.work_completed,unchangedOutputRevision:output.output_revision,scope:'actual generation/phase control-row intervention; no artifact data replacement or full restore campaign'});
      } finally {
        await worker.call('release');await lab.stopWorker(worker);
        if(advanced)await lab.admin.query('UPDATE '+table+" SET phase='active',claim_id=NULL,artifact_digest=NULL WHERE tenant_id=$1",[lab.A]);
      }
    });
    it('preserves durable ACK refusal during an injected exact receiver grant failure and recovers without evaluator replacement',async function(){
      await write(110);const config=lab.configure(),worker=await startExisting(config, {detached:true});assert.equal(worker.startup.ready,true,JSON.stringify(worker.startup));const evaluator=identity(worker.child.pid);
      const table='"'+lab.replayNamespace+'".tenant_consumer_checkpoint',role='"'+lab.previewRole+'"';
      const grants=async()=>(await lab.admin.query("SELECT grantor,grantee,is_grantable FROM information_schema.column_privileges WHERE table_schema=$1 AND table_name='tenant_consumer_checkpoint' AND column_name='work_observed' AND grantee=$2 AND privilege_type='UPDATE' ORDER BY grantor",[lab.replayNamespace,lab.previewRole])).rows;
      const canUpdate=async()=>(await lab.admin.query("SELECT has_column_privilege($1,$2,'work_observed','UPDATE') AS allowed",[lab.previewRole,lab.replayNamespace+'.tenant_consumer_checkpoint'])).rows[0].allowed;
      const beforeWork=await state(),prior=await grants();assert.equal(prior.length,1,'EXACT_PRIOR_COLUMN_GRANT_REQUIRED');assert.equal(prior[0].is_grantable,'NO');assert.equal(await canUpdate(),true);let stamp,producerState;
      try{
        await lab.admin.query('REVOKE UPDATE(work_observed) ON '+table+' FROM '+role);assert.equal(await canUpdate(),false);
        await write(149);await new Promise(resolve=>setTimeout(resolve,2000));
        assert.deepEqual((await state()).observed,beforeWork.observed,'FAILED_RECEIPT_MUST_NOT_BE_DURABLY_ACKNOWLEDGED');
        assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,110,'FAILED_COHORT_MUST_NOT_CHANGE_COMPLETED_OUTPUT');producerState=lab.stream().state();
      }finally{
        await lab.admin.query('GRANT UPDATE(work_observed) ON '+table+' TO '+role);assert.deepEqual(await grants(),prior,'EXACT_PRIOR_GRANT_RESTORED');assert.equal(await canUpdate(),true);
      }
      // Explicit test action, independent of the evaluator. The platform-owned
      // restart policy has its own canonical component witness.
      await lab.stopStream();await lab.startStream();stamp=await acceptedValue(149);
      await wait(async()=>{const health=(await worker.call('health')).pgstream;return health.healthy&&floor((await state()).completed.bootstrap)>=floor(stamp);},30000,'GRANT_FAULT_DURABLE_RESUME');
      assert.deepEqual(identity(worker.child.pid),evaluator,'RECEIVER_GRANT_RECOVERY_KEEPS_SAME_ROLE');assert.equal((await lab.previewCompleted()).projection[0].output.frame.sgvs.find(row=>row._id==='synthetic-recovery').mgdl,149);
      lab.tracePreview('independent-stream-injected-receiver-grant-refusal',{priorGrant:prior,producerState,evaluator,stamp,scope:'Injected grant fault; observed producer exit state does not establish permanent wedging or production frequency'});await lab.stopWorker(worker);
    });
  });
